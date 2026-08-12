# CryptoPulse — Complete Project Guide

A comprehensive, start-to-end technical walkthrough of the CryptoPulse codebase:
architecture, working logic, ML theory, structure, schema, data flow, and deployment.

> **One-line pitch:** CryptoPulse is a real-time streaming crypto market-surveillance
> system. It polls live prices from the Binance API every 10 seconds, scores each
> tick for **anomalies using online (incremental) ML models**, and pushes the results
> to a live "trading terminal" dashboard over WebSockets — powered by a FastAPI
> backend, SQLite/Postgres persistence, and a React frontend.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Project History & Evolution](#2-project-history--evolution)
3. [System Architecture](#3-system-architecture)
4. [Directory Structure](#4-directory-structure)
5. [End-to-End Data Flow (The Life of a Tick)](#5-end-to-end-data-flow-the-life-of-a-tick)
6. [Backend Deep Dive](#6-backend-deep-dive)
7. [ML Theory](#7-ml-theory)
8. [Database Schema](#8-database-schema)
9. [API Reference](#9-api-reference)
10. [Frontend Deep Dive](#10-frontend-deep-dive)
11. [Configuration Reference](#11-configuration-reference)
12. [Testing Strategy](#12-testing-strategy)
13. [Deployment](#13-deployment)
14. [Performance & Metrics](#14-performance--metrics)
15. [Engineering Tradeoffs](#15-engineering-tradeoffs)
16. [Roadmap & Future Work](#16-roadmap--future-work)

---

## 1. Executive Summary

| Aspect | Detail |
|---|---|
| **Purpose** | Real-time anomaly detection on live crypto price streams |
| **Backend** | Python 3.12, FastAPI 0.115, Uvicorn, httpx, river (online ML), aiosqlite/asyncpg, tenacity |
| **Frontend** | React 18 + Vite 5, Zustand 5, lightweight-charts 5, axios, framer-motion |
| **Data source** | Binance Spot REST API (`/api/v3/ticker/24hr`) — batch polled every 10s |
| **ML models** | Rolling Z-Score (baseline) and HalfSpaceTrees + QuantileFilter (online isolation forest) |
| **Transport** | WebSocket `/ws/ticks` for live ticks; REST for history, stats, config |
| **Persistence** | SQLite (local, WAL mode) or PostgreSQL (production) |
| **Tests** | 24 backend (pytest) + 4 frontend (vitest) — all passing |
| **Deployment** | Docker Compose, Nginx reverse proxy, GCP Cloud Run CI |

### What it does (user story)

1. A background poller fetches live prices + 24h volume for 8 coins every 10 seconds.
2. Each tick is converted into **stationary features** (log return, realized volatility,
   vol-normalized return, volume surprise).
3. An **online ML scorer** (per-coin instance) computes an anomaly score and flags
   normal vs. anomalous ticks, updating its model incrementally — no `.fit()`, no retraining.
4. Scored ticks are persisted to the database and **broadcast over WebSocket**.
5. The browser dashboard renders a live 60fps price chart with red anomaly markers,
   per-coin confidence bars, a sensitivity slider that **re-tunes the threshold live**,
   and a diagnostics panel (latency, throughput, WS state).

The flagship demo feature is the **sensitivity slider**: moving it sends `POST /api/config`,
which mutates the running model's threshold with zero restarts and instant visual feedback
on the chart.

---

## 2. Project History & Evolution

The git history (35 commits) tells the story of how this project matured:

```
v0.1.0  (2026-07-26)  Initial React app — CoinGecko REST screener
v0.2.0  (2026-07-26)  Architecture & tech-stack planning (PLAN.md)
v0.3.0  (2026-07-26)  Full-stack: FastAPI + river + WS + SQLite + dashboard
v0.3.1  (2026-07-26)  River API hotfix (RollingMean → deque, Pipeline.steps fix)
        (2026-07-27)  Switch to Binance API (rate-limit fixes), batch polling,
                      HST height reduction (memory), docker/nginx/GCP CI
        (2026-08-03)  Bug-fix pass: sentinel shutdown, poller coin-list, zustand
                      middleware, dead code cleanup
        (2026-08-04)  P0: stationary feature engineering + offline backtest script
                      HST QuantileFilter fix, z-score double-normalization fix
        (2026-08-04/05)  Cyberpunk trading-terminal UI overhaul (tooltips,
                      diagnostics, ticker, trade log)
```

Key turning points:

- **CoinGecko → Binance:** CoinGecko free-tier rate limits (30 req/min) forced a move to
  Binance's Spot API, which allows a **single batch request** for all tracked symbols —
  an ~8× reduction in connection overhead (commit `deb6d97`).
- **Raw price → stationary features:** A review flagged that both scorers operated on
  *non-stationary* raw prices (a trend becomes a permanent "anomaly"; MinMaxScaler bounds
  shift on every ATH). This produced `scoring/features.py` (commit `49ef166`) — the single
  biggest ML correctness improvement.
- **Absolute threshold → QuantileFilter:** HST scores cluster near 1.0 in the new feature
  space; a fixed 0.75 cutoff flagged ~89% of ticks. Switching to a **running-quantile**
  filter made sensitivity scale-free (`halftrees.py`).

---

## 3. System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Binance Spot API                          │
│                  /api/v3/ticker/24hr (batch, 8 symbols)          │
└───────────────────────────┬──────────────────────────────────────┘
                            │  httpx.AsyncClient + tenacity retry (429)
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                    INGESTION  (app/ingestion/poller.py)          │
│   Polls every 10s → PriceTick dataclass → raw_queue (asyncio)    │
└───────────────────────────┬──────────────────────────────────────┘
                            │  asyncio.Queue(maxsize=100)  ← backpressure
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                    SCORING  (app/scoring/)                       │
│   FeatureExtractor: ret, vol, z_ret, vol_delta (stationary)      │
│   ScorerRegistry → per-coin ZScoreScorer | HalfSpaceTreesScorer  │
│   ScoringWorker loop → ScoredTick → scored_queue (asyncio)       │
└───────────────────────────┬──────────────────────────────────────┘
                            │  asyncio.Queue(maxsize=100)
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                BROADCAST  (app/api/websocket.py)                 │
│   broadcast_loop: 1) INSERT into SQLite/Postgres                 │
│                   2) ConnectionManager.broadcast() → all WS      │
└─────────────┬────────────────────────────────────┬───────────────┘
              │                                    │
              ▼ REST                              ▼ WebSocket (JSON)
┌────────────────────────────┐   ┌───────────────────────────────┐
│  /api/history /api/stats   │   │   REACT DASHBOARD (src/)      │
│  /api/config /health       │   │   useWebSocket → tickStore     │
│  (FastAPI routers)         │   │   (Zustand) → LiveChart canvas │
└────────────────────────────┘   │   StatsPanel, Slider, Ticker   │
                                 └───────────────────────────────┘
```

**Three-stage async pipeline** (two bounded queues decouple the stages):

```
Poller ──raw_queue──▶ ScoringWorker ──scored_queue──▶ broadcast_loop
        (PriceTick)                  (ScoredTick)    (persist + WS fanout)
```

Each stage runs as an independent `asyncio.Task`. Bounded queues provide **natural
backpressure**: if scoring can't keep up, the poller's `put()` blocks instead of
growing memory unboundedly.

---

## 4. Directory Structure

```
cryptopulse/
├── backend/                        # Python FastAPI service (self-contained)
│   ├── app/
│   │   ├── main.py                 # App factory, lifespan, task wiring, shutdown drain
│   │   ├── config.py               # pydantic-settings Config (env / .env)
│   │   ├── ingestion/
│   │   │   ├── poller.py           # Binance batch poller (httpx + tenacity)
│   │   │   └── models.py           # PriceTick, ScoredTick DTOs
│   │   ├── scoring/
│   │   │   ├── scorer.py           # BaseScorer ABC, ScorerRegistry, ScoringWorker
│   │   │   ├── features.py         # Stationary feature extraction (ret/vol/z_ret/vol_delta)
│   │   │   ├── zscore.py           # Rolling z-score scorer (stdlib deque)
│   │   │   └── halftrees.py        # HalfSpaceTrees + QuantileFilter (river)
│   │   ├── api/
│   │   │   ├── websocket.py        # ConnectionManager, broadcast_loop, /ws/ticks
│   │   │   ├── history.py          # GET /api/history
│   │   │   ├── stats.py            # GET /api/stats
│   │   │   └── config_api.py       # POST /api/config
│   │   └── db/
│   │       ├── database.py         # SQLite/Postgres adapter + schema DDL + WAL
│   │       └── queries.py          # SQL functions (insert/get history/stats)
│   ├── tests/                      # pytest suite (scorer, features, poller, shutdown)
│   ├── scripts/backtest.py         # Offline kline replay + model comparison CLI
│   ├── data/                       # kline CSV cache + backtest result JSON
│   ├── requirements.txt            # pinned deps
│   ├── Dockerfile
│   └── .env.example
│
├── src/                            # React frontend (Vite)
│   ├── main.jsx / App.jsx          # entry + single-route router
│   ├── pages/Dashboard.jsx         # terminal layout composition
│   ├── store/tickStore.js          # Zustand store (+ test)
│   ├── hooks/
│   │   ├── useWebSocket.js         # WS lifecycle + reconnect w/ backoff
│   │   └── useStats.js             # 5s polling of /api/stats
│   ├── components/
│   │   ├── dashboard/              # LiveChart, SensitivitySlider
│   │   ├── layout/                 # Navbar, PanelFrame, ConnectionStatus, CoinSelector
│   │   ├── terminal/               # TickerBar, MarketStructure, ConfidenceHeat,
│   │   │                           # TradeLog, OpenPositions
│   │   └── ui/                     # Tooltip, Spinner, Badge, GlassCard
│   ├── styles/                     # index.css (design tokens), components.css,
│   │                               # terminal_components.css
│   └── utils/formatters.js         # pure formatting helpers
│
├── docker-compose.yml              # redis + fastapi + frontend(nginx)
├── nginx.conf                      # SPA serve + /api and /ws proxy w/ Upgrade headers
├── Dockerfile.frontend             # multi-stage Node20 build → nginx:alpine
├── PLAN.md                         # original architecture plan (v0)
├── ROADMAP.md                      # future ML/DL roadmap (12 phases)
├── CHANGELOG.md                    # keep-a-changelog history
├── GCP_DEPLOYMENT.md               # Cloud Run + Postgres guide
└── PROJECT_GUIDE.md                # this document
```

---

## 5. End-to-End Data Flow (The Life of a Tick)

Trace one price observation through the whole system:

**1. Poll** — `CoinGeckoPoller._poll_batch_loop()` runs forever. Each cycle it rebuilds the
symbol→coin map from the *current* `settings.coins_to_track` (so runtime config changes
take effect), then calls Binance once with all symbols:
`GET /api/v3/ticker/24hr?symbols=["BTCUSDT",...]`. Retries on `429`/transport errors with
exponential backoff (1s→60s, 5 attempts) via tenacity.

**2. Model** — Each coin's JSON becomes a `PriceTick` (dataclass: `coin_id`, `symbol`,
`name`, `price_usd`, `volume_24h`, `price_change_24h`, `polled_at`). Validation in
`__post_init__` (price ≥ 0, symbol uppercased). Pushed to `raw_queue`.

**3. Extract** — `ScoringWorker._score_tick()` gets a per-coin `FeatureExtractor`
(lazily created). `extract(price, volume)` computes:
- `ret = ln(price / prev_price)` — log return
- `vol` = rolling std of recent returns — realized volatility
- `z_ret = ret / vol` — vol-normalized return
- `vol_delta = ln(volume / rolling_mean(volume))` — volume surprise

Returns `None` during warm-up (needs `window_size`=30 observations), and the tick is
emitted as a non-anomaly (score 0).

**4. Score** — `ScorerRegistry.get_or_create(coin_id)` returns that coin's `BaseScorer`
(either `ZScoreScorer` or `HalfSpaceTreesScorer`). `score(features)` returns
`(anomaly_score, is_anomaly)`. **Crucially, the scorer updates its internal state AFTER
computing the score** (no look-ahead bias). Result is wrapped in `ScoredTick` and pushed
to `scored_queue`.

**5. Persist + Broadcast** — `broadcast_loop` consumes `ScoredTick`. It **writes to the DB
first** (so `/api/history` is always consistent with what the dashboard shows), then
`ConnectionManager.broadcast()` sends the flat JSON dict to every connected WebSocket
client, pruning dead sockets safely.

**6. Render** — The browser's `useWebSocket` hook parses the frame and calls
`tickStore.addTick()`. Zustand updates `tickHistory`, `latestByCoins`, `anomalyCounts`.
`LiveChart`'s imperative subscription (`useTickStore.subscribe(selector, cb)`) pushes the
new point + any anomaly marker straight onto the canvas via `series.update()` — **zero
React re-renders on the hot path**.

**7. Observe** — The stats panel polls `GET /api/stats` every 5s for aggregates
(anomalies today, throughput, uptime). Moving the sensitivity slider `POST /api/config`
which mutates thresholds on all scorers in place.

**Timestamps:** `polled_at` (fetched) and `scored_at` (scored) are both persisted, making
end-to-end latency measurable at any time.

---

## 6. Backend Deep Dive

### 6.1 `main.py` — App factory & lifecycle

- `create_app()` builds the FastAPI instance, adds CORS, includes the four routers, and
  exposes `/health`.
- The **`lifespan` async context manager** is the heart of the wiring:
  - **Startup:** connect DB → create two bounded queues → build `ScorerRegistry` →
    start `ScoringWorker` task → start `broadcast_loop` task → start `CoinGeckoPoller`.
  - **Shutdown (graceful):** stop the poller first (no new ticks), then
    `await scoring_worker.stop()` which **enqueues a `SHUTDOWN_SENTINEL`** into `raw_queue`.
    The sentinel flows through the pipeline: ScoringWorker forwards it to `scored_queue`,
    then broadcast_loop sees it and exits. This guarantees **every in-flight tick is scored
    and persisted before exit** — no tick loss. A 5s `asyncio.wait_for` guard cancels tasks
    if a DB write hangs (Cloud Run SIGKILLs 10s after SIGTERM).
  - Shared objects are stashed on `app.state` for dependency injection
    (`app.state.db`, `.settings`, `.scorer_registry`, `.scoring_worker`, `.ws_manager`).

**Why sentinel-based shutdown (not a flag + timeout poll)?** The old code polled with
`asyncio.wait_for(queue.get(), timeout=1.0)`. A timed-out `get()` is *cancelled* — but if an
item arrived in the same event-loop tick, it's consumed by the cancelled future and lost.
A sentinel put on the queue is race-free and drains deterministically. This is regression
tested in `tests/test_pipeline_shutdown.py`.

### 6.2 `config.py` — Settings

`pydantic-settings` `Settings` class, read from env / `.env`, cached with `lru_cache`.
Key fields: `coingecko_api_key`, `coins_to_track` (8 defaults), `poll_interval_seconds`
(10s, validated 5–300), `model_type` (`zscore`|`halftrees`, default `halftrees`),
`default_threshold_halftrees` (0.99 quantile), `default_threshold_zscore` (3.0σ),
`database_url`, `log_level`, `cors_origins`. A `default_threshold` property picks the
right default for the active model.

> Note: runtime threshold/coin changes are NOT persisted back to config — restart returns
> to `.env` defaults. Documented as intentional simplicity in `config_api.py`.

### 6.3 `ingestion/poller.py` — Batch poller

- One persistent `httpx.AsyncClient` with base URL `https://api.binance.com`.
- **Single request for all coins** via the `symbols` URL param (not 8 concurrent requests):
  8× less connection overhead.
- `COIN_MAPPING` maps CoinGecko IDs → Binance pairs (`bitcoin`→`BTCUSDT`…). Unknown coins
  fall back to a best-effort `<FIRST4>USDT` pair.
- `_build_pair_map()` is re-run **every loop iteration** so `POST /api/config {coins}`
  takes effect live (regression-tested in `test_poller.py`).
- Empty coin list → log warning and sleep (never call Binance with `symbols=[]`).

### 6.4 `ingestion/models.py` — DTOs

`PriceTick` (raw observation) and `ScoredTick` (raw + `anomaly_score`, `is_anomaly`,
`model_type`, `threshold`, `scored_at`). Both are plain dataclasses for hot-path speed
(no Pydantic overhead) with `to_dict()` producing flat JSON. `ScoredTick.__post_init__`
validates HST scores ∈ [0,1]. `market_cap` was deliberately removed — Binance's ticker
doesn't expose it, and a permanently-zero field was deemed worse than no field.

### 6.5 `scoring/scorer.py` — ABC, Registry, Worker

Three cooperating pieces:

1. **`BaseScorer` ABC** — contract: `score(features) -> (float, bool)` and
   `update_threshold(float)`. Both scorers are interchangeable (Liskov Substitution);
   adding a new model means extending this class, never touching callers
   (Open/Closed).
2. **`ScorerRegistry`** — `dict[coin_id → BaseScorer]`, lazy creation on first tick
   (so runtime-added coins get fresh models), `update_all_thresholds()` mutates every
   scorer in place (preserving accumulated state), `reset()` wipes everything when the
   model *type* changes.
3. **`ScoringWorker`** — the async consumer loop. Pulls `PriceTick`s off `raw_queue`,
   extracts features, scores, pushes `ScoredTick` onto `scored_queue`. Per-tick errors
   are logged and skipped — the loop never halts. Tracks `uptime_seconds` and
   `ticks_processed` for the stats API.

### 6.6 `api/websocket.py` — ConnectionManager + broadcast_loop

- `ConnectionManager` holds `active_connections: list[WebSocket]`.
- `broadcast()` **iterates over a copy** of the list and removes dead sockets *after*
  iteration. Why: removing from the live list while iterating shifts indices and skips
  every other client. Handles `WebSocketDisconnect` and `RuntimeError`
  ("cannot send after closed").
- `broadcast_loop` is the terminal consumer: `insert_tick` → `manager.broadcast`.
- The `/ws/ticks` endpoint is intentionally thin: it accepts the socket then blocks on
  `receive_text()` forever (this is how disconnects are detected). Data comes from the
  background loop, not this coroutine.

### 6.7 `api/history.py`, `api/stats.py`, `api/config_api.py`

- **`GET /api/history`** — paginated history for a coin (`limit` ≤ 1000, `offset`),
  newest-first, typed Pydantic response models (`TickRecord`, `TickHistoryResponse`).
- **`GET /api/stats`** — merges DB aggregates (ticks today, anomalies today,
  anomaly-rate %, throughput over last 5 min, per-coin anomaly counts) with in-memory
  state (uptime, WS client count, tracked coins, active model + threshold).
- **`POST /api/config`** — optional `{threshold?, model_type?, coins?}`:
  - **Model type change** → `registry.reset()` (new model, default threshold) — model
    *type* swap cannot preserve state, so the warm-up restarts (unavoidable).
  - **Threshold-only change** → `update_all_thresholds()` preserves all model state.
  - **Coin list change** → mutates `settings.coins_to_track`; poller picks it up next
    cycle, new coins get fresh scorers on first tick.

---

## 7. ML Theory

### 7.1 Why anomaly detection (unsupervised, online)

Crypto market surveillance mirrors what exchanges do: continuously flag "unusual"
behavior — pump-and-dump spikes, flash crashes, volume bursts, stale feeds — **with no
labeled ground truth**. This rules out supervised learning entirely. The task is
**unsupervised anomaly detection in a streaming setting**, which forces three real
production-ML problems to be solved:

1. **Non-stationarity** — prices wander/trend, so models must adapt.
2. **Concept drift** — volatility regimes shift (calm ↔ turbulent); a model trained on
   one regime must not break in the next.
3. **Latency vs. accuracy** — each tick must be scored in O(1), online, without a
   batch `.fit()`.

### 7.2 Stationary feature engineering (`features.py`) — the crucial first step

**Problem:** raw price levels are non-stationary. A model on raw prices sees a trending
market as "abnormal forever"; a MinMaxScaler's bounds shift on every new all-time-high,
invalidating everything learned before.

**Solution:** convert each tick into a *strictly stationary* 4-D feature vector:

| Feature | Formula | Meaning | Stationary? |
|---|---|---|---|
| `ret` | `ln(pₜ / pₜ₋₁)` | log return | Yes — removes level |
| `vol` | rolling std of last 30 returns | realized volatility | Yes |
| `z_ret` | `ret / vol` | vol-normalized return ("how many σ is this move") | Yes |
| `vol_delta` | `ln(vₜ / mean(v_window))` | volume surprise (multiples of normal) | Yes |

Why this matters: a 1% move is nothing in a high-vol regime and a huge signal in a calm
regime. `z_ret` normalizes for that. `vol_delta` catches wash-trading / volume bursts even
when price barely moves. These four features are **invariant to absolute price level**, so
a model trained in one market cap regime generalizes to another.

### 7.3 Model 1 — Rolling Z-Score (`zscore.py`)

**Theory:** Under the assumption that the recent price-return distribution is roughly
Gaussian with rolling mean μ and std σ, a new observation's *z-score*
`z = |x - μ| / σ` measures its extremeness. Classical outlier rule: flag if `|z| > 3σ`
(~0.3% of a normal distribution lies beyond 3σ).

**Implementation:**
- `collections.deque(maxlen=50)` — O(1) append/evict; mean and *sample* variance (N−1
  denominator) recomputed from the window each call (a 50-element sum is cheap).
- Score is computed **before** appending the current value (no look-ahead bias).
- **Warm-up suppression:** no flags until `window_size` ticks seen.
- **`min_std` floor:** std is at least 0.1% of the mean. Prevents z-score explosion when a
  coin trades at an identical price for a whole window (zero variance) — common with
  CoinGecko/Binance rounding on illiquid coins.
- `update_threshold(σ)` mutates only the threshold; the window is preserved.

**Tradeoff:** explainable and instant to ship, but lags regime shifts (rolling mean/std
lag behind a new volatility regime) and assumes near-Gaussian returns (crypto has heavy
tails → higher false-positive rate than theory suggests).

### 7.4 Model 2 — HalfSpaceTrees + QuantileFilter (`halftrees.py`)

**Theory — HalfSpaceTrees (HST):** HST is the **streaming variant of Isolation Forest**,
purpose-built for online anomaly detection (river's implementation). Instead of modeling
normal data, it *isolates* anomalies:

- `n_trees=25` random **half-space trees** are maintained. Each tree partitions the
  feature space by randomly splitting dimensions at random midpoints.
- Each internal node keeps a **sliding-window mass estimate** (how many recent points fell
  in that half-space), decaying over `window_size=150` observations.
- A point that lands in **sparse half-spaces (low mass) across many trees** is anomalous —
  it's "far" from where the data concentrates.
- Runtime is O(1) per tick; the sliding-window mass naturally **adapts to regime shifts**
  (stale structure decays out) — the property a fixed-window z-score lacks.
- `seed=42` for deterministic, reproducible trees. `height=10` (2¹⁰ partitions) was tuned
  down from the default 15 for a ~30× memory reduction — more than sufficient for a
  4-feature univariate-ish space.

**The pipeline wrapper:**
```
compose.Pipeline(
    preprocessing.MinMaxScaler(),        # HST needs features in [0,1] (random split points)
    anomaly.QuantileFilter(               # replaces absolute threshold
        anomaly.HalfSpaceTrees(...),
        q=threshold,                      # 0.99 → flag top 1%
        protect_anomaly_detector=True,    # ← concept-drift guard
    ),
)
```

Two critical, non-obvious design decisions (both hard-won from real measurements):

1. **`QuantileFilter`, not `ThresholdFilter`.** HST's absolute score scale depends on the
   feature space. In this stationary 4-feature space, scores concentrate near 1.0
   (measured p50≈0.91, p99≈0.996 over 1 day of 1m klines). A fixed cutoff of 0.75 flagged
   **~89% of all ticks as anomalous** (verified by `scripts/backtest.py` on BTC/ETH/SOL/
   DOGE). `QuantileFilter` instead tracks the running quantile of observed scores and flags
   the top `(1 − q)` fraction — making sensitivity **scale-free** ("flag the most extreme
   1%") regardless of HST's absolute range. Measured anomaly rate after the switch:
   1.8–2.4% at q=0.99.
   *(See `backend/data/backtest_results/backtest_BTCUSDT_*.json` — this exact pathology
   recorded: zscore 1.77% vs halftrees@0.75 89.36%.)*
2. **`protect_anomaly_detector=True`.** Without this flag, anomalous ticks (extreme
   outliers) would be fed back into the model's `learn_one()` step, gradually shifting the
   internal density estimate **toward** the anomaly — a form of **concept-drift poisoning**
   that makes the model "get used to" anomalies. With the flag, ticks classified as
   anomalous are skipped in the learning step.

**Scoring order (same no-lookahead discipline as z-score):**
1. `score_one(features)` → raw HST score (through MinMaxScaler).
2. `QuantileFilter.classify(score)` → binary decision against running quantile.
   - Warm-up guard: no flags until 100 scores seen (early quantile estimates are too noisy
     and produced a false-positive burst in the first ~100 ticks).
3. `learn_one(features)` → update MinMaxScaler bounds + tree masses (unless the tick was
   anomalous).

`update_threshold(q)` mutates `quantile_filter.quantile.q` directly — tree weights, scaler
bounds, and observed-score quantile are all preserved.

### 7.5 Why online learning beats periodic retraining here

Crypto exhibits **volatility clustering** — calm periods punctuated by sudden regime
shifts. A periodic retrain (even daily) has two problems: a retrain latency spike, and it
misses intra-batch changes. HST's sliding-window masses adapt continuously in O(1)/tick —
genuinely superior for this data. This is one of the project's central, defensible ML
positions (documented in `PLAN.md` §11).

### 7.6 Ground truth caveat — evaluation without labels

There are **no labels** for "real anomaly". The project is honest about this:
- Thresholds were chosen by percentile inspection of the score distributions on
  live/backtested data, **not** claimed as optimal.
- `scripts/backtest.py` provides the offline evaluation harness: download Binance 1m
  klines → replay through any `BaseScorer` → compute score/feature distributions, anomaly
  rate, **detection lag** (mean ticks between a real 5σ return spike and the first flag),
  and a Jaccard **model-agreement** comparison.
- `ROADMAP.md` Phase 1 lays out the principled path forward: synthetic anomaly injection
  (pump spike, flash crash, volume burst, flatline, momentum ignition) to compute
  precision/recall/PR-AUC per anomaly type, plus *proxy* labels (|return|>5σ, news
  timestamps) — always labeled as proxies, never as ground truth.

---

## 8. Database Schema

Single table, `ticks`. Auto-created with `CREATE TABLE IF NOT EXISTS` on startup; a
composite index supports the common query patterns.

| Column | Type (SQLite / Postgres) | Notes |
|---|---|---|
| `id` | INTEGER AUTOINCREMENT / SERIAL | PK |
| `coin_id` | TEXT NOT NULL | e.g. `bitcoin` |
| `symbol` | TEXT NOT NULL | e.g. `BTC` |
| `name` | TEXT NOT NULL | e.g. `Bitcoin` |
| `price_usd` | REAL / DOUBLE PRECISION NOT NULL | |
| `volume_24h` | REAL / DOUBLE PRECISION NOT NULL DEFAULT 0 | Binance quote volume |
| `price_change_24h` | REAL / DOUBLE PRECISION NOT NULL DEFAULT 0 | % |
| `anomaly_score` | REAL / DOUBLE PRECISION NOT NULL | HST: [0,1]; z-score: raw \|z\| |
| `is_anomaly` | INTEGER NOT NULL DEFAULT 0 | boolean as 0/1 |
| `model_type` | TEXT NOT NULL | `zscore` or `halftrees` |
| `threshold` | REAL NOT NULL | threshold active when scored |
| `polled_at` | TEXT NOT NULL | ISO 8601 UTC |
| `scored_at` | TEXT NOT NULL | ISO 8601 UTC |

```
CREATE INDEX idx_ticks_coin_polled ON ticks (coin_id, polled_at DESC);
```

**SQLite vs Postgres duality:** `DatabaseConnectionAdapter` wraps either `aiosqlite` or an
`asyncpg` pool behind one interface, translating `?` placeholders to `$1, $2, …` for
Postgres. Detection is by URL prefix (`postgresql://` / `postgres://`).

**SQLite performance:** WAL mode (`journal_mode=WAL`, `synchronous=NORMAL`,
`busy_timeout=5000`) — readers never block writers. At 8 coins × 1 tick/10s ≈ 0.8 writes/s,
this is trivial headroom. `wal_checkpoint(PASSIVE)` on shutdown.

---

## 9. API Reference

### WebSocket

```
WS /ws/ticks
```

**Server → client frame (one per scored tick):**
```json
{
  "coin_id": "bitcoin", "symbol": "BTC", "name": "Bitcoin",
  "price_usd": 67423.12, "volume_24h": 1.2e10, "price_change_24h": 1.45,
  "polled_at": "2026-08-05T10:05:00+00:00",
  "anomaly_score": 0.987, "is_anomaly": true,
  "model_type": "halftrees", "threshold": 0.99,
  "scored_at": "2026-08-05T10:05:00.12+00:00"
}
```
The client sends nothing in this protocol (messages are used only to detect disconnects).

### REST

| Method | Path | Purpose | Key params / body |
|---|---|---|---|
| GET | `/health` | Liveness probe | — |
| GET | `/api/history` | Paginated tick history | `coin_id` (req), `limit` ≤1000, `offset` |
| GET | `/api/stats` | Dashboard aggregates | — |
| POST | `/api/config` | Runtime re-tuning | `{threshold?, model_type?, coins?}` all optional |

**`/api/stats` response:**
```json
{
  "total_ticks_today": 6780, "anomalies_today": 124, "anomaly_rate_pct": 1.83,
  "throughput_per_minute": 48.2, "model_uptime_seconds": 3600.0,
  "ws_client_count": 2, "tracked_coins": ["bitcoin", "ethereum", ...],
  "current_model": "halftrees", "current_threshold": 0.99,
  "anomalies_by_coin": {"bitcoin": 42, "ethereum": 31}
}
```

**`/api/config` semantics:**
- `threshold` only → mutates all existing scorers (state preserved).
- `model_type` different from active → **resets** all scorers (state lost; new warm-up).
- `coins` → replaces tracked list (poller picks it up next cycle; new coins get fresh
  scorers lazily).

---

## 10. Frontend Deep Dive

### 10.1 State management — Zustand (`store/tickStore.js`)

Single store owning: `tickHistory` (per coin, capped at **500** ticks ≈ 83 min),
`latestByCoins`, `anomalyCounts` (session counts, for badges), `wsStatus`, `reconnectCount`.

Actions: `addTick` (append + trim + increment counts), `loadHistory` (bulk, newest-first
from API → reversed for the chart), `setWsStatus`, `resetAnomalyCount`.

Two performance-critical decisions:
1. **Zustand over React Context** — Context re-renders *all* consumers on any value
   change. At ~1 tick/s × 8 coins that's a constant cascade. Zustand components subscribe
   to exact slices and re-render only when those change.
2. **`subscribeWithSelector` middleware is mandatory.** `LiveChart` uses the two-argument
   `subscribe(selector, callback)` form to drive the canvas *outside* React. Zustand v5's
   plain `subscribe` ignores selectors, so without this middleware the chart silently
   never updates. Guarded by `src/store/tickStore.test.js` (the test fails loudly if the
   middleware is removed).

### 10.2 Hooks

- **`useWebSocket`** — one persistent WS connection on mount. Handlers dispatch parsed
  frames to `addTick`. On close (code ≠ 1000) it schedules a reconnect with **exponential
  backoff** (1s → 2s → … → 30s cap) and surfaces `wsStatus`/`reconnectCount`. Cleanup on
  unmount closes the socket and cancels timers (no zombie connections).
- **`useStats`** — polls `/api/stats` every 5s (aggregate data doesn't need a second WS
  channel); on transient errors keeps showing last-known values.

### 10.3 Chart — `LiveChart.jsx` (lightweight-charts)

- Canvas-based, built for financial streaming: **imperative `series.update()` bypasses the
  React VDOM entirely** — no state updates on tick receipt, so 60fps is achievable even at
  100k+ points (this is why Recharts/SVG was rejected).
- `createSeriesMarkers` draws red `arrowDown` anomaly markers labeled with the score.
- Time values must be **Unix seconds** (`isoToUnixSec`), not ms.
- On coin switch: clears the series, loads history from the store (pre-populated via
  `/api/history`), and re-subscribes the store subscription to that coin.
- `ResizeObserver` keeps the canvas sized to its container.

### 10.4 Components

| Component | Role |
|---|---|
| `Navbar` | Brand, **model switcher** (zscore ↔ halftrees via `/api/config`), refresh, shortcut panel, `ConnectionStatus` |
| `TickerBar` | Live scrolling marquee of all coins; pause/play; click to select coin |
| `MarketStructure` | Price hero + LAST SCORE / STATUS / ANOMALIES / VOLUME / MODEL / TICKS / UPTIME with tooltips; reset-anomaly-count button |
| `ConfidenceHeat` | Confidence bars: HST CONVERGENCE (live from score), VOLATILITY SPIKE (derived from 24h change), MOMENTUM IGNITION + ORDERBOOK IMBALANCE (honest placeholders awaiting extra feeds) |
| `LiveChart` | 60fps canvas chart + anomaly markers |
| `SensitivitySlider` | Presets (AGGR/BAL/CONS per model) + range slider, **debounced 300ms** `POST /api/config` |
| `TradeLog` | Last 50 ticks, anomalies-only filter, clear (resets counts), CSV export |
| `OpenPositions` | Mock positions table (UI reference for the roadmap's trading phase) |
| `DiagnosticsPanel` | WS state, feed latency (derived from tick cadence), tick buffer, anomaly rate, throughput |
| `PanelFrame` / `Tooltip` / `Badge` / `Spinner` / `GlassCard` | Reusable UI primitives |

**Visual design:** cyberpunk trading terminal — dark `#050505` background, crimson
`#ff1a1a` accents, JetBrains Mono font, glassmorphism panels, scanline overlay, CSS custom
properties for all tokens (`styles/index.css`), separated component styles.

---

## 11. Configuration Reference

Environment variables (see `backend/.env.example`):

| Variable | Default | Description |
|---|---|---|
| `COINGECKO_API_KEY` | `` | Empty = free tier (name retained for compatibility) |
| `COINS_TO_TRACK` | 8 defaults | JSON array of coin IDs |
| `POLL_INTERVAL_SECONDS` | `10` | validated 5–300 |
| `MODEL_TYPE` | `halftrees` | `zscore` \| `halftrees` |
| `DEFAULT_THRESHOLD_HALFTREES` | `0.99` | quantile level q |
| `DEFAULT_THRESHOLD_ZSCORE` | `3.0` | σ units |
| `DATABASE_URL` | `./cryptopulse.db` | or `postgresql://…` |
| `LOG_LEVEL` | `INFO` | |
| `CORS_ORIGINS` | localhost 5173/3000/80 | JSON array |

Frontend (Vite, via `import.meta.env`): `VITE_WS_URL` (default `ws://localhost:8000/ws/ticks`),
`VITE_API_URL` (default `http://localhost:8000`). In Docker the build injects the
Nginx-proxied URLs.

---

## 12. Testing Strategy

**Backend (`backend/tests/`, 24 tests, pytest + pytest-asyncio, `asyncio_mode = auto`):**

| File | Coverage |
|---|---|
| `test_scorer.py` | Z-score math (warm-up suppression, spike detection, threshold update, `is_warmed_up`); HST (score ∈ [0,1], threshold change preserves state, warm-up) |
| `test_features.py` | Feature extractor warm-up gate, log-return math, vol_delta, z_ret = ret/vol |
| `test_poller.py` | Pair-map building, unknown-coin fallback, **runtime coin-list change regression** (poller re-reads settings each cycle), empty-list guard |
| `test_pipeline_shutdown.py` | Sentinel-based shutdown drains **all** queued ticks (none dropped), prompt exit on empty queue, per-tick scoring errors don't halt the loop |

**Frontend (`src/store/tickStore.test.js`, 4 tests, vitest + jsdom):**
- Selector subscriptions fire on new ticks (guards `subscribeWithSelector`).
- A coin's subscription is *not* fired by another coin's tick.
- Only anomalous ticks increment counts.
- History caps at 500/coin, keeping the newest.

The tests are designed as **regression guards for invisible failure modes** (e.g. a chart
that silently never updates, ticks silently dropped on shutdown) — each was validated by
reverting the fix and confirming the test fails.

Run:
```bash
cd backend && .venv/bin/python -m pytest -q
npm test
npm run lint
```

---

## 13. Deployment

### 13.1 Docker Compose (local full stack)

Three services (`docker-compose.yml`):
1. **`redis`** (`redis:7-alpine`) — staged for the v1 Redis-Streams upgrade path, health
   gated.
2. **`fastapi`** — `uvicorn app.main:app --workers 1` (**intentional**: the in-process
   `asyncio.Queue` and in-memory scorers are not shareable across processes). Non-root
   user, health check, SQLite on a persistent volume.
3. **`frontend`** — multi-stage `Node 20 → nginx:alpine`; Nginx serves the SPA and proxies
   `/api/` and `/ws/` to FastAPI.

```bash
docker compose up --build
# frontend on :80, backend on :8000
```

### 13.2 Nginx (`nginx.conf`)

- Serves the Vite build with SPA fallback to `index.html`.
- `/api/` → `proxy_pass http://fastapi` (30s read timeout).
- `/ws/` → **must forward `Upgrade` and `Connection: Upgrade` headers** or the WS
  handshake fails with HTTP 400; 1h read/send timeouts so the persistent socket isn't
  dropped every 60s.

### 13.3 GCP Cloud Run (CI)

`deploy-backend.yml` GitHub Action fires on backend changes to `main`: auth via
`GCP_SA_KEY`, then `gcloud run deploy` with `--max-instances 1`. **Single instance is
required** to keep the in-memory poller/scorer state and WebSocket clients consistent.
`GCP_DEPLOYMENT.md` documents the caveat: scale-to-zero loses all model warm-up state on
cold start, so a **managed Postgres** (`DATABASE_URL=postgresql://…`, e.g. Supabase/Neon)
is the recommended production pairing since Cloud Run's filesystem is ephemeral.

---

## 14. Performance & Metrics

Measured via the offline backtest (`scripts/backtest.py`) and the live `/api/stats`:

- **Anomaly rate** — z-score@3σ: ~1.8% on BTCUSDT 1m klines; HST@q=0.99: 1.8–2.4% (the
  excess over 1% is warm-up tail). The recorded pathology of HST@0.75 → 89.4% is the
  documented motivation for QuantileFilter.
- **Detection lag** — backtest reports mean ticks from a real 5σ return spike to first
  flag (0 in the sample run — per-tick scoring reacts immediately).
- **Score distributions** — p50/p90/p95/p99 reported for both models and all four features
  per run (e.g. BTC `z_ret` p99 ≈ 2.77).
- **End-to-end latency** — measurable at any time by differencing `scored_at − polled_at`
  (both persisted); `PLAN.md` §10 prescribes p50/p95 reporting.
- **Throughput** — `/api/stats` reports ticks/min over the last 5 min (~48/min at 8 coins
  × 10s).
- **Model footprint** — HST `height=10` (vs. default 15) cut memory ~30×; `window_size=150`
  × 25 trees is the runtime cost budget.

**Deliberately unmeasured/not overclaimed:** "real" anomaly precision — no ground truth
exists; the project documents proxy labels and confidence intervals instead (see §7.6).

---

## 15. Engineering Tradeoffs

1. **Per-tick vs. micro-batch scoring** — per-tick chosen: lowest latency, noisier
   signal; documented in `PLAN.md` §11.
2. **`asyncio.Queue` vs. Redis Streams** — Queue: zero infra, in-process only, µs latency,
   lost on restart. Redis Streams: persistent, multi-process, ~1ms. Trigger for upgrade:
   separate ingestion/scorer processes or replay needs (> 100 coins). Redis is already in
   docker-compose but unused — staged.
3. **Online learning vs. periodic retrains** — HST O(1)/tick, adapts to regime shifts;
   batch retrain has latency spikes and misses intra-batch changes. Online wins for crypto
   volatility clustering.
4. **SQLite vs. Postgres** — ~0.8 writes/s today: SQLite+WAL wins on simplicity. Threshold:
   >10k concurrent writes/min or multi-process writers → Postgres + asyncpg (same SQL,
   swap driver). Both are supported by one adapter.
5. **lightweight-charts vs. Recharts** — Canvas partial redraw vs. SVG full VDOM diff per
   tick. Mandatory choice for live financial streaming; Recharts remains fine for static
   panels.
6. **Zustand vs. React Context** — selective slice subscriptions vs. cascade
   re-renders. Critical at 1–10 Hz WS tick floods.
7. **`--workers 1` uvicorn** — correctness over scale: in-process state (queues, scorers,
   WS manager) can't span workers.

---

## 16. Roadmap & Future Work

`ROADMAP.md` lays out a 12-phase path to a full ML/DL trading bot:

1. **Evaluation without labels** — synthetic anomaly injection (pump/flash-crash/volume/
   flatline/ignition) → precision/recall/PR-AUC; proxy labels; model comparison dashboard.
2. **Model ladder** — EWMA z-score → Matrix Profile (stumpy) → **GRU/LSTM autoencoder**
   (reconstruction-error percentile) served behind the same `BaseScorer` ABC.
3. **Pattern recognition** — candlestick detectors, CNN chart patterns, S/R levels, HMM
   regime detection.
4. **Predictive models** — direction classifier, GARCH volatility, Temporal Fusion
   Transformer.
5–7. **Signals & risk** — signal aggregation, Kelly sizing, event-driven backtester,
   risk limits, ATR stop-losses.
8. **Paper → live trading** — paper engine, Binance executor, WS upgrade from REST.
9. **Champion/challenger** — run all scorers concurrently per coin (extend
   `ScorerRegistry` to `(coin, model)`), disagreement rate as a free signal.
10. **MLOps** — `train.py` CLI, model registry (`.pt` + `metrics.json`), PSI drift
    monitoring, Prometheus `/metrics`.
11. **Cross-coin** — rolling PCA reconstruction error (market-wide vs. idiosyncratic
    anomalies).
12. **Alternative data** — sentiment (FinBERT), on-chain, funding/OI.

The existing codebase was deliberately engineered to make this cheap: every new model
extends `BaseScorer`; the offline backtest already replays klines through any scorer; and
the dashboard's trading-terminal UI (open positions, trade log) is already stubbed with
honest "placeholder — requires additional data feed" markers.

---

*Generated 2026-08-05. Backend tests: 24 passing. Frontend tests: 4 passing.*
