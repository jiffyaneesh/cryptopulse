# PLAN.md — CryptoPulse: Real-Time Streaming Anomaly Detection

> **Resume project.** Full pipeline: async ingestion → online ML scoring → WebSocket broadcast → live dashboard.
> Documents real production ML problems: concept drift, unsupervised anomaly detection, latency vs. accuracy.

---

## 1. One-Line Pitch

Upgrade CryptoPulse from a static REST-polling app into a real-time streaming system
that scores live crypto price ticks for anomalies using an online (incremental) ML model
and pushes results to an interactive live dashboard over WebSockets.

---

## 2. Why This Project (Interview Answer)

- **Streaming/online ML** — not batch `.fit()`. Genuinely underrepresented skill.
- Forces engagement with **concept drift**, **unsupervised anomaly detection**, and **latency vs. accuracy tradeoffs** — real production ML problems.
- Mirrors real systems used by exchanges and trading desks for market surveillance.
- Full pipeline: ingestion → streaming → stateful model → real-time serving → interactive UI.
  Most tutorials only touch the model-in-a-notebook slice.

---

## 3. Scope (v1 — "Done" Criteria)

### In Scope
- Track **8–10 coins** from CoinGecko Free Tier, polled every 10s (rate-limit aware).
- Each price tick **scored in near real time** (< 2s end-to-end) as normal / anomalous.
- Live dashboard:
  - Price chart per coin with **anomaly markers** (red dots) via `lightweight-charts`.
  - **Sensitivity slider** to re-tune threshold live without restart.
  - **Stats panel**: anomalies today, throughput (ticks/min), model uptime, last tick time.
  - Coin selector to switch between tracked coins.
- Tick + anomaly history persisted in SQLite (powers stats panel + historical view).
- Documented README: architecture diagram, measured latency, tradeoff writeup.

### Out of Scope (v1)
- Actual trading / alerting integrations.
- Guaranteed detection of real pump-and-dump events (no ground truth).
- Horizontal scaling / multi-node deployment.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     CoinGecko API                       │
│          (Free tier: ~30 req/min, poll every 10s)       │
└─────────────────────┬───────────────────────────────────┘
                      │ httpx AsyncClient + tenacity retry
                      ▼
┌─────────────────────────────────────────────────────────┐
│              Ingestion Worker (Python)                  │
│  - asyncio tasks per coin (concurrent polling)          │
│  - Respects 429 + Retry-After header via tenacity       │
│  - Emits PriceTick dataclass objects                    │
└─────────────────────┬───────────────────────────────────┘
                      │ asyncio.Queue (v0) / Redis Streams (v1)
                      ▼
┌─────────────────────────────────────────────────────────┐
│              Streaming Scorer (river 0.25.0)            │
│  v0: RollingMean + RollingVar → rolling z-score         │
│  v1: MinMaxScaler → HalfSpaceTrees (online isolation    │
│      forest, O(1) per tick, adapts to regime shifts)    │
│  - Per-coin model instances (dict keyed by coin_id)     │
│  - ThresholdFilter with protect_anomaly_detector=True   │
│  - Emits ScoredTick with score ∈ [0,1] + is_anomaly     │
└─────────────────────┬───────────────────────────────────┘
                      │ in-process scored tick stream
                      ▼
┌─────────────────────────────────────────────────────────┐
│              FastAPI 0.115.x Backend                    │
│  - /ws/ticks         → WebSocket broadcast              │
│  - GET /api/history  → paginated tick history (SQLite)  │
│  - GET /api/stats    → anomaly counts, uptime, model    │
│  - POST /api/config  → update sensitivity threshold     │
│  - aiosqlite + WAL mode for concurrent read/write       │
│  - ConnectionManager: broadcast to all WS clients,      │
│    prune dead sockets on WebSocketDisconnect            │
└─────────────────────┬───────────────────────────────────┘
                      │ WebSocket JSON frames (< 2s latency)
                      ▼
┌─────────────────────────────────────────────────────────┐
│           React 18 + Vite 5 Frontend Dashboard          │
│  - lightweight-charts v4.2 (Canvas, 60fps streaming)    │
│  - Zustand v5 store (selective slice subscriptions,      │
│    no cascade re-renders from WS tick flood)            │
│  - useWebSocket hook (connect/reconnect/heartbeat)       │
│  - SensitivitySlider → debounced POST /api/config        │
│  - StatsPanel → polling GET /api/stats every 5s         │
│  - framer-motion micro-animations for anomaly alerts    │
│  - Vanilla CSS + CSS variables (dark mode, glassmorphism)│
└─────────────────────────────────────────────────────────┘
```

---

## 5. Tech Stack (Opinionated, Researched, Justified)

### Backend — Python

| Layer | Choice | Version | Why |
|---|---|---|---|
| Runtime | Python | 3.12 | async support, typing improvements, river compatibility |
| Web framework | **FastAPI** | 0.115.x | async-native, WebSocket built-in, auto OpenAPI docs for resume |
| ASGI server | **Uvicorn** | 0.30.x | fastest Python ASGI server, WebSocket support, production-ready |
| Async HTTP | **httpx** | 0.28.x | cleaner API than aiohttp, HTTP/2, integrates with `tenacity` for 429 retry |
| Retry logic | **tenacity** | 9.x | `@retry(wait=wait_random_exponential())` for CoinGecko rate limits |
| ML / Anomaly | **river** | 0.25.0 | only Python lib purpose-built for online (one-pass) ML; O(1) per tick |
| Queue (v0) | `asyncio.Queue` | stdlib | zero infra, sufficient for single-process < 20 coins; documented upgrade path |
| Queue (v1) | **Redis Streams** | 7.x | multi-process, persistent, consumer groups, ~0.5–2ms latency vs µs for asyncio |
| Storage | **SQLite + WAL** | stdlib | WAL mode: readers never block writers; ~50k writes/sec with batch transactions |
| Async SQLite | **aiosqlite** | 0.20.x | async wrapper for SQLite, plays well with FastAPI lifespan |
| Config | **pydantic-settings** | 2.x | type-safe `.env` config, native FastAPI ecosystem |
| Linting | **ruff** | latest | fastest Python linter, covers flake8 + isort + pyupgrade |

> **asyncio.Queue vs Redis Streams tradeoff**: Queue is lost on restart, single-process only, µs latency. Redis is persistent, multi-process, ~1ms latency. Pull the trigger on Redis when ingestion and scorer are separate OS processes or you need message replay. Document this in README.

> **SQLite vs Postgres**: CoinGecko free tier → max 6 writes/min at 10 coins. SQLite WAL handles this trivially. `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;`. Upgrade threshold: > 10k concurrent writes/min or multi-process writers → Postgres + asyncpg (same SQL, swap the driver).

### Frontend — React

| Layer | Choice | Version | Why |
|---|---|---|---|
| Framework | **React + Vite** | 18.x / 5.x | already in project, fast HMR, ESM-native |
| Charting | **lightweight-charts** | 4.2.x | Canvas engine designed for financial data; 60fps at 100k+ points; imperative `series.update()` bypasses React VDOM entirely |
| State | **Zustand** | 5.0.x | selective slice subscriptions — WS ticks at 1/sec don't cascade re-renders; `subscribe()` API for direct canvas updates outside render |
| WebSocket | Native `WebSocket` API | browser | no abstraction needed; wrapped in a custom hook with reconnect logic |
| HTTP | **axios** | 1.x | REST calls to `/api/*` endpoints, interceptors for error handling |
| Animations | **framer-motion** | 11.x | micro-animations for anomaly alerts, stat counter updates |
| Styling | **Vanilla CSS + CSS vars** | — | design tokens, dark mode, glassmorphism, zero runtime overhead |

> **lightweight-charts vs Recharts**: Recharts is SVG-based — full VDOM diff on every tick. At 1 tick/sec × 10 coins, frame drops are visible. lightweight-charts uses Canvas partial redraw; handles > 60fps with 100k+ points. Mandatory for live financial streaming.

> **Zustand vs React Context**: Context re-renders all consumers on value change. A WS emitting 1 tick/sec across 10 coins → constant cascade. Zustand components subscribe to exact slices; unrelated state changes produce zero re-renders.

### Infrastructure / DevOps

| Tool | Use |
|---|---|
| **Docker Compose** | Orchestrate backend + Redis + Nginx-served frontend |
| **Nginx** | Serve Vite build; proxy `/ws/` and `/api/` to FastAPI; must include `Upgrade` headers for WS |
| **Render / Fly.io** | Free-tier deploy for live demo link on resume |

**Docker services:**
1. `redis` — `redis:7-alpine`, `--appendonly yes`, health check via `redis-cli ping`
2. `fastapi` — Python 3.12, `uvicorn app.main:app --host 0.0.0.0`, `depends_on: redis: condition: service_healthy`
3. `frontend` — multi-stage build (Node 20 → `npm run build` → Nginx alpine serves static + proxies API/WS)

---

## 6. Folder Structure

```
cryptopulse/
├── backend/                         # Python FastAPI service
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                  # FastAPI app, lifespan, startup tasks
│   │   ├── config.py                # pydantic-settings Config (env vars)
│   │   ├── ingestion/
│   │   │   ├── __init__.py
│   │   │   ├── poller.py            # Async polling worker, httpx + tenacity
│   │   │   └── models.py            # PriceTick dataclass
│   │   ├── scoring/
│   │   │   ├── __init__.py
│   │   │   ├── scorer.py            # Scorer class: dispatch to z-score or HST
│   │   │   ├── zscore.py            # Rolling z-score (river.stats)
│   │   │   └── halftrees.py         # HalfSpaceTrees wrapper (river.anomaly)
│   │   ├── api/
│   │   │   ├── __init__.py
│   │   │   ├── websocket.py         # /ws/ticks, ConnectionManager, broadcast
│   │   │   ├── history.py           # GET /api/history router
│   │   │   ├── stats.py             # GET /api/stats router
│   │   │   └── config_api.py        # POST /api/config (threshold update)
│   │   └── db/
│   │       ├── __init__.py
│   │       ├── database.py          # aiosqlite pool, WAL PRAGMA setup
│   │       └── queries.py           # insert_tick(), get_history(), get_stats()
│   ├── tests/
│   │   ├── test_scorer.py           # Z-score math + HST score in [0,1]
│   │   ├── test_poller.py           # Mock httpx, rate limit handling
│   │   └── test_api.py              # FastAPI TestClient WS + REST
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
│
├── src/                             # React frontend (existing Vite project)
│   ├── components/
│   │   ├── dashboard/
│   │   │   ├── LiveChart.jsx        # lightweight-charts canvas wrapper
│   │   │   ├── AnomalyMarker.jsx    # Marker series overlay on chart
│   │   │   ├── StatsPanel.jsx       # Anomaly count, throughput, uptime
│   │   │   └── SensitivitySlider.jsx# Debounced POST to /api/config
│   │   ├── layout/
│   │   │   ├── Navbar.jsx
│   │   │   ├── CoinSelector.jsx     # Switch active coin
│   │   │   └── ConnectionStatus.jsx # WS connected/reconnecting badge
│   │   └── ui/
│   │       ├── GlassCard.jsx        # Reusable glassmorphism card
│   │       ├── Badge.jsx            # Anomaly / Normal status badge
│   │       └── Spinner.jsx
│   ├── hooks/
│   │   ├── useWebSocket.js          # WS connect/reconnect/heartbeat hook
│   │   └── useStats.js              # Polling GET /api/stats every 5s
│   ├── store/
│   │   └── tickStore.js             # Zustand store: ticks, anomalies, config
│   ├── pages/
│   │   └── Dashboard.jsx            # Main live dashboard page
│   ├── styles/
│   │   ├── index.css                # CSS vars (colors, spacing), global reset
│   │   └── components.css           # Component-level styles
│   └── utils/
│       └── formatters.js            # Price formatting, relative time display
│
├── docker-compose.yml
├── nginx.conf                       # WS proxy: Upgrade + Connection headers
├── PLAN.md
└── README.md                        # Architecture + metrics + tradeoffs
```

---

## 7. ML Model Plan

### Stage 1 — Rolling Z-Score (v0, ship first)

```python
from river import stats

# Per coin — maintain rolling stats, update every tick
class ZScoreScorer:
    def __init__(self, window: int = 50, threshold: float = 3.0):
        self.mean = stats.RollingMean(window)
        self.var  = stats.RollingVar(window)
        self.threshold = threshold

    def score(self, price: float) -> tuple[float, bool]:
        """Score a price tick. Returns (z_score, is_anomaly)."""
        z = abs(price - self.mean.get()) / (self.var.get() ** 0.5 + 1e-9)
        self.mean.update(price)
        self.var.update(price)
        return z, z > self.threshold
```
- Explainable. Fast to ship. Gets full pipeline working end-to-end.
- Threshold default: `3.0σ`. Sensitivity slider maps to `1σ–5σ` range.

### Stage 2 — HalfSpaceTrees (v1, adaptive)

```python
from river import anomaly, preprocessing, compose

# ThresholdFilter wraps scorer; protect_anomaly_detector=True prevents
# anomalous ticks from poisoning the model's internal stats (concept drift guard)
model = compose.Pipeline(
    preprocessing.MinMaxScaler(),   # HST requires features in [0, 1]
    anomaly.ThresholdFilter(
        anomaly.HalfSpaceTrees(n_trees=25, height=15, window_size=100),
        threshold=0.75,
        protect_anomaly_detector=True,
    )
)
# score_one({"price": x}) → anomaly score ∈ [0, 1]
# learn_one({"price": x}) → update internal mass estimations (O(1))
```
- Handles **volatility clustering** (crypto regime shifts) without retraining.
- Comparison metric: agreement rate with z-score baseline on same 24h tick stream.
- river 0.25.0: `HalfSpaceTrees` lazy-initializes trees on first `learn_one()`.

### Stage 3 — Cross-Coin Correlation Break (Stretch)
- Rolling Pearson r between BTC/ETH prices.
- Flag sharp divergence (r drops from ~0.9 to < 0.3 within 5-min window).
- Genuine signal: exchange-specific pumps, arbitrage gaps.

### Ground Truth Caveat
- No labels exist. Thresholds chosen by percentile inspection on first 24h live data.
- Document false positive rate explicitly in README. Do NOT overclaim accuracy.

---

## 8. WebSocket Protocol

### Backend → Frontend (per tick)
```json
{
  "coin_id": "bitcoin",
  "symbol": "BTC",
  "price_usd": 67423.12,
  "timestamp": "2026-07-26T10:05:00Z",
  "anomaly_score": 0.87,
  "is_anomaly": true,
  "model": "halftrees",
  "threshold": 0.75
}
```

### Frontend → Backend (config update, via REST)
```
POST /api/config
Content-Type: application/json
{"threshold": 0.65, "coins": ["bitcoin", "ethereum", "solana"]}
```

### ConnectionManager Pattern
```python
class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def broadcast(self, data: dict):
        """Broadcast to all active clients; prune dead sockets."""
        for ws in self.active.copy():
            try:
                await ws.send_json(data)
            except (WebSocketDisconnect, RuntimeError):
                self.active.remove(ws)
```

---

## 9. Milestones

| Phase | Deliverable | Est. Time |
|---|---|---|
| **0** | Repo restructure: `/backend` folder, `requirements.txt`, virtual env | 0.5 days |
| **1** | Async ingestion worker (`poller.py`): httpx + tenacity + asyncio.Queue | 1–2 days |
| **2** | Z-score scorer wired to queue; scored ticks logged to console | 1 day |
| **3** | FastAPI + WebSocket broadcast (`/ws/ticks`) + ConnectionManager | 1–2 days |
| **4** | SQLite + WAL persistence; REST endpoints `/api/history`, `/api/stats`, `/api/config` | 1 day |
| **5** | Frontend: Zustand store + `useWebSocket` hook + `LiveChart` with anomaly markers | 2–3 days |
| **6** | `SensitivitySlider` + `StatsPanel` + `CoinSelector` + `ConnectionStatus` | 1–2 days |
| **7** | Swap in HalfSpaceTrees; A/B agreement comparison with z-score | 1–2 days |
| **8** | UI polish: glassmorphism, framer-motion animations, responsive layout | 1–2 days |
| **9** | Load testing, latency measurement (p50/p95), README + Mermaid architecture diagram | 1–2 days |
| **10 (stretch)** | Docker Compose + Nginx + Fly.io deploy, live demo link | open |

---

## 10. Metrics to Measure & Report

| Metric | How to Measure |
|---|---|
| **End-to-end latency p50/p95** | Embed `polled_at` timestamp in tick; log `rendered_at` in WS handler; diff the two |
| **Throughput ceiling** | Simulate 50 coins; find where WS fanout or model scoring becomes bottleneck |
| **Z-score vs HalfSpaceTrees agreement** | Log both scores on same stream; compute % agreement over 24h |
| **WS reconnect time** | Simulate dropped connection; measure time-to-resume in ms |
| **SQLite write throughput** | Benchmark batch inserts under load with WAL mode enabled |
| **Memory per coin model** | `sys.getsizeof(model)` for HalfSpaceTrees after 1000 ticks |

---

## 11. Engineering Tradeoffs to Document

1. **Per-tick vs micro-batch scoring** — per-tick = lowest latency, noisier signal. Micro-batch (5-tick window) = slight delay, smoother. We choose per-tick for demo impact; document the tradeoff.

2. **asyncio.Queue vs Redis Streams** — Queue: zero infra, lost on restart, single-process only. Redis: persistent, multi-process (~1ms vs µs latency), consumer groups. Trigger: separate ingestion/scorer processes or persistence across restarts.

3. **Online learning vs periodic full retrains** — HalfSpaceTrees: O(1) per tick, adapts to regime shifts. Periodic retrain: latency spikes, misses intra-batch changes, requires data storage. Crypto volatility clustering makes online learning genuinely superior.

4. **SQLite vs Postgres** — At 6 writes/min SQLite wins on simplicity. Threshold: > 10k concurrent writes/min or multi-process writers → Postgres + asyncpg (same SQL schema, swap driver only).

5. **lightweight-charts vs Recharts** — SVG VDOM diff on every tick (Recharts) vs Canvas partial redraw (lightweight-charts). At 1 tick/sec × 10 coins the FPS difference is visible to the naked eye. Recharts fine for static stat panels.

6. **Zustand vs React Context** — Context cascades re-renders to all consumers. Zustand: components subscribe to exact slices, zero re-renders from unrelated state. Critical for WS tick flood at 1–10 Hz.

---

## 12. Documentation & Code Quality Standards

- **Every file**: module-level docstring explaining its role in the pipeline.
- **Every function**: docstring with purpose, args, returns, side-effects.
- **Complex logic** (scorer state machine, WS broadcast loop, queue consumer): inline comments on *why*, not *what*.
- **README.md** must include:
  - Animated GIF or screenshot of live dashboard.
  - Mermaid architecture diagram.
  - One-command install + run via Docker Compose.
  - Measured latency (p50/p95) + throughput numbers from load test.
  - Tradeoff writeup (honest, structured for interview reference).
  - Tech choices with brief justifications.
- **Git**: conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`).
- **Tests**: unit tests for scorer math (z-score correctness; HST score ∈ [0,1]; ThresholdFilter fires correctly).

---

## 13. Stretch Goals

- **Alerting hook**: webhook / email on anomaly burst (> 3 anomalies within 60s for same coin).
- **Multi-exchange**: Binance price feed alongside CoinGecko — flag arbitrage-gap anomalies.
- **Cross-coin correlation**: rolling Pearson r BTC/ETH; flag regime divergence.
- **Redis Streams upgrade**: replace asyncio.Queue, add Prometheus `/metrics` endpoint.
- **Public deploy**: Fly.io free tier, live demo link for portfolio site.
