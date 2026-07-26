# CHANGELOG.md — CryptoPulse

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Planned
- Fly.io live demo deploy
- Cross-coin correlation anomaly detection (BTC/ETH divergence)
- Redis Streams upgrade from asyncio.Queue
- Prometheus `/metrics` endpoint
- Test coverage for REST endpoints

---

## [0.3.1] — 2026-07-26 — River API Hotfix

### Fixed
- `scoring/zscore.py`: Replaced `river.stats.RollingMean` / `river.stats.RollingVar`
  (not present in river 0.25.0) with stdlib `collections.deque` + manual mean/variance.
- `scoring/halftrees.py`: Replaced `Pipeline.classify_one()` (non-existent) with
  `ThresholdFilter.classify(score)` accessed via `pipeline.steps["ThresholdFilter"]`.
  Also fixed `pipeline.steps[-1]` index access → dict key access.
- All 10 scorer unit tests now pass (9 previously failed due to API mismatch).

### Added
- `src/styles/components.css`: Full component-level CSS using CSS custom properties.
- `Dockerfile.frontend`: Multi-stage Node 20 build → Nginx alpine serve.
- `docker-compose.yml`: Redis + FastAPI + Nginx orchestration with health checks.
- `nginx.conf`: WebSocket proxy with correct `Upgrade`/`Connection` headers.
- `backend/.env.example`: All config fields documented with descriptions.
- `backend/Dockerfile`: Non-root user, health check, proper layer caching.
- `index.html`: SEO meta tags (description, og:title, keywords).

---

## [0.3.0] — 2026-07-26 — Full Stack Implementation

### Added — Backend
- `backend/` directory scaffolded as a self-contained Python 3.12 service
- `backend/app/main.py` — FastAPI app entry point with `lifespan` context manager; starts ingestion worker and scorer on startup, shuts down gracefully on SIGTERM
- `backend/app/config.py` — `pydantic-settings` Config class; reads all values from environment via `.env`; type-safe, documented fields
- **Ingestion layer** (`backend/app/ingestion/`):
  - `poller.py` — async polling worker using `httpx.AsyncClient`; one `asyncio.Task` per coin; `tenacity` retry with exponential backoff on HTTP 429
  - `models.py` — `PriceTick` and `ScoredTick` dataclasses with full type annotations and field docstrings
- **Scoring layer** (`backend/app/scoring/`):
  - `scorer.py` — `BaseScorer` ABC (Open/Closed Principle); `ScorerRegistry` dispatches per-coin model instances; hot-swappable model type
  - `zscore.py` — `ZScoreScorer`: rolling z-score using `river.stats.RollingMean` + `RollingVar`; O(1) per tick
  - `halftrees.py` — `HalfSpaceTreesScorer`: `river.anomaly.HalfSpaceTrees` wrapped in `MinMaxScaler` pipeline; `protect_anomaly_detector=True` prevents concept drift from anomalous ticks
- **API layer** (`backend/app/api/`):
  - `websocket.py` — `ConnectionManager` class; safe broadcast iterates copy of active connections, prunes dead sockets on `WebSocketDisconnect`; `/ws/ticks` endpoint
  - `history.py` — `GET /api/history` router; paginated tick history from SQLite
  - `stats.py` — `GET /api/stats` router; anomaly counts, throughput, model uptime
  - `config_api.py` — `POST /api/config` router; live threshold update without restart; validates with Pydantic model
- **Database layer** (`backend/app/db/`):
  - `database.py` — `aiosqlite` connection with WAL mode (`PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`); schema auto-migration on startup
  - `queries.py` — isolated SQL query functions: `insert_tick()`, `get_history()`, `get_stats()`, `get_anomaly_count_today()`
- `backend/requirements.txt` — pinned exact versions for reproducibility
- `backend/Dockerfile` — multi-stage Python 3.12 build
- `backend/.env.example` — documented environment variable template
- **Test suite** (`backend/tests/`):
  - `test_scorer.py` — unit tests: z-score math correctness, HST score ∈ [0,1], ThresholdFilter fires at correct threshold, anomaly spike detection
  - `test_poller.py` — mock httpx responses; rate limit handling; PriceTick field validation
  - `test_api.py` — FastAPI `TestClient` + `WebSocketTestSession`; REST endpoint contracts

### Added — Frontend (Full Restructure)
- **Zustand store** (`src/store/tickStore.js`) — replaces React Context for WebSocket state; selective slice subscriptions prevent cascade re-renders; `MAX_HISTORY_PER_COIN=500` cap prevents memory growth
- **Hooks** (`src/hooks/`):
  - `useWebSocket.js` — WebSocket connect/reconnect with exponential backoff; heartbeat ping every 30s; dispatches frames to Zustand store
  - `useStats.js` — polls `GET /api/stats` every 5s; memoized return value
- **Dashboard components** (`src/components/dashboard/`):
  - `LiveChart.jsx` — `lightweight-charts` v4.2 Canvas wrapper; imperative `series.update()` bypasses React VDOM entirely; anomaly markers via `ISeriesMarker` API; no React state updates on tick receipt
  - `StatsPanel.jsx` — displays anomaly count, throughput (ticks/min), model uptime, last tick timestamp
  - `SensitivitySlider.jsx` — debounced (300ms) `POST /api/config` on threshold change; shows current value with live feedback
- **Layout components** (`src/components/layout/`):
  - `Navbar.jsx` — project branding, navigation, model selector (Z-Score vs HalfSpaceTrees)
  - `CoinSelector.jsx` — select active tracked coin; shows anomaly badge count per coin
  - `ConnectionStatus.jsx` — WebSocket connected/reconnecting/disconnected indicator with animated dot
- **UI primitives** (`src/components/ui/`):
  - `GlassCard.jsx` — reusable glassmorphism card container
  - `Badge.jsx` — `Anomaly` (red) / `Normal` (green) status badge with pulse animation
  - `Spinner.jsx` — loading spinner for chart initialization
- `src/pages/Dashboard.jsx` — main dashboard page; composes all components; handles coin switching
- **Styles** (`src/styles/`):
  - `index.css` — full design system: CSS custom properties (colors, spacing, radii, shadows, glassmorphism tokens); dark mode; Google Fonts (Inter)
  - `components.css` — per-component styles
- `src/utils/formatters.js` — pure formatting functions: `formatPrice()`, `formatRelativeTime()`, `formatThroughput()`
- Updated `src/main.jsx` and `src/App.jsx` — routing wired to new Dashboard page

### Added — Project Infrastructure
- `.agents/rules/CODE_STYLE.md` — comprehensive style guide: SOLID principles, Python docstring standards, React component rules, git conventions, testing standards, dependency management
- `CHANGELOG.md` — this file; tracks all changes with timestamps and rationale
- `docker-compose.yml` — three services: `redis:7-alpine`, `fastapi` (Python 3.12), `frontend` (multi-stage Node 20 + Nginx alpine)
- `nginx.conf` — serves Vite build; proxies `/api/` and `/ws/` to FastAPI; correct WebSocket `Upgrade` + `Connection` headers

### Changed
- Removed old React Context providers (`CryptoContext`, `TrendingContext`, `StorageContext`) — replaced by Zustand store + hooks architecture
- Retired direct CoinGecko REST polling from frontend — all data now flows through FastAPI WebSocket
- Charting library switched from **Recharts** (SVG, poor streaming performance) to **lightweight-charts** (Canvas, 60fps)
- `src/main.jsx` routing updated: `/dashboard` replaces old `/`, `/trending`, `/saved` routes

### Architecture Decisions Recorded
- `asyncio.Queue` chosen over Redis Streams for v0 (zero infra, same process); Redis upgrade path documented in PLAN.md §11
- `ThresholdFilter(protect_anomaly_detector=True)` prevents anomalous ticks from poisoning rolling stats — critical for crypto regime shifts
- WebSocket `ConnectionManager` iterates copy of `active_connections` before broadcast to safely prune dead sockets without skipping entries

---

## [0.2.0] — 2026-07-26 — Architecture & Tech Stack Planning

### Added
- `PLAN.md` — comprehensive project plan updated with:
  - Fully researched tech stack (river 0.25.0, FastAPI 0.115.x, lightweight-charts 4.2, Zustand 5.0)
  - Detailed folder structure for backend and frontend
  - WebSocket protocol specification (JSON frame schema)
  - ML model plan: z-score baseline → HalfSpaceTrees upgrade path
  - 10-phase milestone table with time estimates
  - Metrics to measure and report for resume/README
  - Engineering tradeoffs (all 6 documented with rationale)
  - Documentation quality standards

### Research Findings
- `river 0.25.0`: HalfSpaceTrees requires `MinMaxScaler` pre-processing; `protect_anomaly_detector=True` is critical
- `lightweight-charts` confirmed mandatory over Recharts for streaming (Canvas vs SVG performance at 1Hz × 10 coins)
- `Zustand v5` slice subscriptions confirmed as the correct architecture for WS tick flood
- SQLite WAL mode confirmed: readers never block writers; 50k+ writes/sec with batch transactions
- `httpx` preferred over `aiohttp` for modern DX + HTTP/2; `tenacity` integration for 429 retry

---

## [0.1.0] — 2026-07-26 — Initial Frontend (CoinGecko REST App)

### Added
- Vite + React 18 project initialized
- CoinGecko API integration:
  - `CryptoContext.jsx` — coins market data, search, pagination
  - `TrendingContext.jsx` — trending coins
  - `StorageContext.jsx` — saved/watchlist coins (localStorage)
- Components: `Chart.jsx`, `CryptoDetails.jsx`, `Filters.jsx`, `Logo.jsx`, `Navigation.jsx`, `Pagination.jsx`, `Search.jsx`, `TableComponent.jsx`, `TrendingCoin.jsx`
- Pages: `Home.jsx`, `Crypto.jsx`, `Trending.jsx`, `Saved.jsx`
- `react-router-dom` routing with nested routes for coin detail modal
- `recharts` for price chart rendering
- TailwindCSS for styling

### Notes
- This version polls CoinGecko REST API directly from the frontend — no backend.
- Retained as reference; all components being replaced in v0.3.0 restructure.
- Real-time streaming and anomaly detection not yet implemented.

---

[Unreleased]: https://github.com/jiffyaneesh/cryptopulse/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jiffyaneesh/cryptopulse/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jiffyaneesh/cryptopulse/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jiffyaneesh/cryptopulse/releases/tag/v0.1.0
