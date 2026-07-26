# CODE_STYLE.md — CryptoPulse Project Standards

> Enforced for all contributors and AI agents working in this repository.
> Goal: consistent, readable, production-quality code that tells the full story at an interview.

---

## 0. Guiding Principles

This project follows **SOLID** design principles throughout:

| Principle | What it means here |
|---|---|
| **S** — Single Responsibility | Every module, class, function does exactly one thing. `poller.py` only polls; `scorer.py` only scores. |
| **O** — Open/Closed | New scorers (e.g., correlation anomaly) extend `BaseScorer`, never modify existing scorer classes. |
| **L** — Liskov Substitution | `ZScoreScorer` and `HalfSpaceTreesScorer` are interchangeable wherever `BaseScorer` is expected. |
| **I** — Interface Segregation | FastAPI routers are split by domain (`history.py`, `stats.py`, `config_api.py`) — no mega-router. |
| **D** — Dependency Inversion | FastAPI endpoints depend on abstract scorer/db interfaces injected via `Depends()`, not concrete classes. |

---

## 1. Repository Structure Rules

```
cryptopulse/
├── backend/           # Python service — self-contained, own venv
│   ├── app/           # Application source — NO business logic in main.py
│   ├── tests/         # Mirror app/ structure; one test file per module
│   ├── Dockerfile
│   └── requirements.txt
├── src/               # React frontend — Vite project
│   ├── components/    # Dumb UI components — no direct API calls
│   ├── hooks/         # Side-effect logic isolated from render
│   ├── store/         # Zustand stores — one file per domain
│   ├── pages/         # Page-level layout components only
│   ├── styles/        # CSS only — no inline styles in components
│   └── utils/         # Pure functions — no side effects
├── .agents/rules/     # AI agent rules and style guides
├── PLAN.md            # Architecture and roadmap (living document)
├── CHANGELOG.md       # Every change, dated, categorized
└── README.md          # Public-facing: setup, architecture, metrics
```

**Rules:**
- Never add business logic to `main.py` — it wires components only.
- Never import from `api/` inside `scoring/` or `ingestion/` — dependency flows one way.
- Never put API calls in React components — all fetch/WS logic lives in `hooks/` or `store/`.

---

## 2. Python Style (Backend)

### 2.1 Formatting & Linting

```
Tool     : ruff (covers flake8 + isort + pyupgrade rules)
Line len : 100 chars max
Quotes   : double quotes everywhere
Types    : strict — all public functions must have full type annotations
```

Run before every commit:
```bash
ruff check backend/ --fix
ruff format backend/
mypy backend/app --strict
```

### 2.2 File Header Docstring

Every `.py` file **must** begin with a module docstring:

```python
"""
ingestion/poller.py
───────────────────
Async polling worker that fetches live price ticks from the CoinGecko API
and pushes them onto the internal asyncio.Queue for downstream scoring.

Responsibilities:
  - Manage one asyncio.Task per tracked coin.
  - Respect CoinGecko free-tier rate limits via exponential backoff (tenacity).
  - Emit PriceTick dataclass objects with normalized fields.

NOT responsible for:
  - Scoring or anomaly detection (see scoring/scorer.py).
  - Persisting ticks to the database (see db/queries.py).
"""
```

### 2.3 Function Docstrings

All public functions and methods must use Google-style docstrings:

```python
async def fetch_price(coin_id: str, currency: str = "usd") -> PriceTick:
    """Fetch the current price for a single coin from CoinGecko.

    Makes a single HTTP GET request to /simple/price. Uses the shared
    httpx.AsyncClient from the application lifespan context.

    Args:
        coin_id: CoinGecko coin identifier (e.g., "bitcoin", "ethereum").
        currency: Target fiat currency code. Defaults to "usd".

    Returns:
        A PriceTick dataclass with price, timestamp, and coin metadata.

    Raises:
        httpx.HTTPStatusError: On non-2xx response (handled by tenacity retry).
        CoinGeckoRateLimitError: On HTTP 429 after all retries exhausted.
    """
```

### 2.4 Class Design

```python
from abc import ABC, abstractmethod

class BaseScorer(ABC):
    """Abstract base class for all streaming anomaly scorers.

    New scorer implementations MUST extend this class (Open/Closed Principle).
    All concrete scorers are interchangeable wherever BaseScorer is typed.
    """

    @abstractmethod
    def score(self, price: float) -> tuple[float, bool]:
        """Score a single price observation.

        Args:
            price: Raw price value from the ingestion tick.

        Returns:
            Tuple of (anomaly_score: float, is_anomaly: bool).
            Score is normalized to [0, 1] where possible; for z-score,
            it is the raw z value.
        """
        ...

    @abstractmethod
    def update_threshold(self, threshold: float) -> None:
        """Update the anomaly detection threshold at runtime.

        Args:
            threshold: New threshold value. Semantics depend on scorer type.
        """
        ...
```

### 2.5 Inline Comments

Use inline comments to explain **why**, never what:

```python
# ✅ Correct — explains the non-obvious reason
# Copy the list before iterating: removing dead sockets during iteration
# on the original list causes skipped entries.
for ws in self.active_connections.copy():
    ...

# ❌ Wrong — restates what the code obviously does
# iterate over connections
for ws in self.active_connections:
    ...
```

### 2.6 Constants & Configuration

- All config lives in `app/config.py` via `pydantic-settings`.
- No magic numbers in business logic — define named constants at module level:

```python
# The free CoinGecko tier allows ~30 requests/minute.
# We poll 10 coins every 10s = 6 req/min — well within limits.
COINGECKO_POLL_INTERVAL_SECONDS: int = 10
COINGECKO_MAX_COINS: int = 10

# Default z-score threshold: flag prices more than 3 standard
# deviations from the rolling mean. Chosen by visual inspection
# of first 24h of live data — see README metrics section.
DEFAULT_ZSCORE_THRESHOLD: float = 3.0
```

### 2.7 Error Handling

```python
# ✅ Specific exception types + logged context
try:
    tick = await fetch_price(coin_id)
except httpx.HTTPStatusError as exc:
    logger.error(
        "CoinGecko request failed",
        coin_id=coin_id,
        status_code=exc.response.status_code,
    )
    return  # Skip this tick; poller continues on next interval

# ❌ Bare except — never do this
try:
    tick = await fetch_price(coin_id)
except Exception:
    pass
```

### 2.8 Async Patterns

```python
# ✅ Use asyncio.gather for concurrent coin polling
tasks = [poll_coin(coin_id) for coin_id in tracked_coins]
await asyncio.gather(*tasks, return_exceptions=True)

# ✅ Never block the event loop — no time.sleep() in async code
await asyncio.sleep(COINGECKO_POLL_INTERVAL_SECONDS)

# ✅ Structured concurrency: cancel tasks on shutdown
async with asyncio.TaskGroup() as tg:
    for coin_id in tracked_coins:
        tg.create_task(poll_coin(coin_id))
```

---

## 3. React / JavaScript Style (Frontend)

### 3.1 Formatting & Linting

```
Tool      : ESLint (existing config) + Prettier
Line len  : 100 chars max
Quotes    : double quotes in JSX attributes; single quotes in JS
Semicolons: yes
```

### 3.2 Component File Header

Every `.jsx` / `.js` file must begin with a comment block:

```jsx
/**
 * LiveChart.jsx
 * ─────────────
 * Renders a real-time candlestick/line chart using TradingView's
 * lightweight-charts library (Canvas-based, 60fps).
 *
 * Responsibilities:
 *   - Initialize the chart instance once on mount via useRef.
 *   - Subscribe to Zustand tickStore for the active coin's tick stream.
 *   - Call series.update() directly on the canvas — BYPASSES React VDOM
 *     for performance (no state updates on each tick).
 *
 * NOT responsible for:
 *   - WebSocket connection management (see hooks/useWebSocket.js).
 *   - Anomaly scoring logic (backend only).
 *
 * @module components/dashboard/LiveChart
 */
```

### 3.3 Component Rules

- **One component per file.** No multi-export component files.
- **Dumb components** (in `components/`) receive props only — no hooks that touch the store or network.
- **Smart pages** (in `pages/`) compose dumb components and connect to store/hooks.
- **JSDoc props documentation:**

```jsx
/**
 * GlassCard — A reusable glassmorphism container card.
 *
 * @param {object}  props
 * @param {string}  [props.className]    - Additional CSS classes.
 * @param {string}  [props.title]        - Optional card header title.
 * @param {React.ReactNode} props.children - Card body content.
 */
const GlassCard = ({ className = "", title, children }) => { ... };
```

### 3.4 Hook Rules

Hooks in `hooks/` must:
- Have a file-level comment explaining purpose + what they return.
- Return a stable object reference (use `useMemo` or `useCallback` where needed).
- Clean up all subscriptions and WebSocket connections in `useEffect` cleanup.

```js
/**
 * useWebSocket.js
 * ───────────────
 * Manages the WebSocket connection lifecycle to the FastAPI backend.
 *
 * Handles:
 *   - Initial connection on mount.
 *   - Automatic reconnection with exponential backoff on disconnect.
 *   - Heartbeat (ping) to detect zombie connections.
 *   - Dispatching incoming tick frames to Zustand tickStore.
 *
 * @returns {{ isConnected: boolean, reconnectCount: number }}
 */
```

### 3.5 Zustand Store Rules

```js
// ✅ One store file per domain
// store/tickStore.js — owns ALL tick and anomaly state
// store/configStore.js — owns sensitivity threshold, coin selection

// ✅ Document every slice
const useTickStore = create((set, get) => ({
  /** @type {Map<string, ScoredTick[]>} Tick history keyed by coin_id. Max 500 per coin. */
  tickHistory: new Map(),

  /** @type {ScoredTick|null} Most recent tick received from WS, any coin. */
  latestTick: null,

  /**
   * Append a new scored tick to history for its coin.
   * Trims to MAX_HISTORY_PER_COIN to prevent unbounded memory growth.
   *
   * @param {ScoredTick} tick - Scored tick frame from the WebSocket.
   */
  addTick: (tick) => { ... },
}));
```

### 3.6 CSS Rules

- All colors, spacing, and radii defined as **CSS custom properties** in `styles/index.css`.
- No inline `style={{}}` in JSX — use CSS classes only.
- No Tailwind utility classes mixed with custom CSS — pick one per component.
- Component-specific styles in `styles/components.css`.

```css
/* ✅ Correct — named semantic tokens */
:root {
  --color-anomaly: hsl(0, 85%, 60%);
  --color-normal: hsl(142, 71%, 45%);
  --glass-bg: hsla(220, 20%, 12%, 0.7);
  --glass-border: hsla(220, 30%, 60%, 0.15);
  --radius-card: 16px;
}

/* ❌ Wrong — magic values scattered across files */
.card { background: rgba(20, 22, 30, 0.7); border-radius: 16px; }
```

---

## 4. Git Conventions

### 4.1 Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body — explain WHY, not what]

[optional footer — refs, breaking changes]
```

**Types:**

| Type | Use for |
|---|---|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `docs` | Documentation only changes |
| `refactor` | Code restructure, no behavior change |
| `test` | Adding or fixing tests |
| `chore` | Build scripts, deps, tooling |
| `perf` | Performance improvements |
| `style` | Formatting, linting (no logic change) |

**Examples:**
```
feat(scoring): add HalfSpaceTrees online anomaly scorer

Replaces rolling z-score as the default model. Per-coin river Pipeline:
MinMaxScaler → HalfSpaceTrees → ThresholdFilter.
protect_anomaly_detector=True prevents concept drift from anomalous ticks.

fix(websocket): prune dead sockets by iterating over a copy of active list

Iterating over the live list while removing elements caused skipped entries
during broadcast, leaving zombie sockets until the next disconnect event.

docs(readme): add measured latency numbers and architecture diagram
```

### 4.2 Branch Naming

```
feature/<short-description>    e.g. feature/halftrees-scorer
fix/<short-description>        e.g. fix/websocket-broadcast-prune
docs/<short-description>       e.g. docs/architecture-diagram
refactor/<short-description>
```

### 4.3 PR / Commit Checklist

Before merging any branch:
- [ ] `ruff check` passes with zero warnings.
- [ ] `mypy --strict` passes.
- [ ] All new functions have docstrings.
- [ ] All new files have module-level docstring.
- [ ] `CHANGELOG.md` entry added under `[Unreleased]` or the correct version.
- [ ] Tests pass: `pytest backend/tests/ -v`.

---

## 5. Testing Standards

### 5.1 Python Tests

```
Framework : pytest + pytest-asyncio
Coverage  : aim for > 80% on scoring/ and ingestion/
Location  : backend/tests/ mirroring backend/app/ structure
```

```python
# test_scorer.py
# ──────────────
# Unit tests for the ZScoreScorer and HalfSpaceTreesScorer.
# Tests use deterministic synthetic price series to verify
# scorer outputs without relying on network or database.

import pytest
from app.scoring.zscore import ZScoreScorer

class TestZScoreScorer:
    """Tests for the rolling z-score anomaly scorer."""

    def test_score_returns_tuple(self):
        """score() must return a (float, bool) tuple for any input."""
        scorer = ZScoreScorer(window=10, threshold=3.0)
        score, is_anomaly = scorer.score(100.0)
        assert isinstance(score, float)
        assert isinstance(is_anomaly, bool)

    def test_anomaly_detected_on_spike(self):
        """A price 5x the rolling mean should be flagged as anomalous."""
        scorer = ZScoreScorer(window=20, threshold=3.0)
        for price in [100.0] * 20:   # warm up the rolling window
            scorer.score(price)
        _, is_anomaly = scorer.score(10_000.0)   # extreme spike
        assert is_anomaly is True
```

### 5.2 Frontend Tests

```
Framework : Vitest + @testing-library/react
Location  : src/__tests__/ or co-located *.test.jsx
```

---

## 6. Documentation Standards

| Document | Owner | Update trigger |
|---|---|---|
| `PLAN.md` | Architecture | Before each phase starts |
| `CHANGELOG.md` | All contributors | Every commit that changes behavior |
| `README.md` | Project lead | After each milestone ships |
| Module docstrings | File author | When file is created or significantly changed |
| `CODE_STYLE.md` | Tech lead | When new patterns are introduced |

---

## 7. Dependency Management

### Python
```bash
# Pin exact versions in requirements.txt for reproducibility
fastapi==0.115.6
uvicorn[standard]==0.30.6
httpx==0.28.1
river==0.25.0
aiosqlite==0.20.0
pydantic-settings==2.7.0
tenacity==9.0.0
ruff==0.9.0
```

### JavaScript
```bash
# Pin exact versions in package.json for reproducibility
# Use npm ci (not npm install) in Docker builds
```

---

*This document is enforced by automated linting in CI and reviewed manually on every PR.*
*Last updated: 2026-07-26*
