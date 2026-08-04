# ROADMAP.md — CryptoPulse: ML/DL Trading Bot

> **Vision:** Evolve CryptoPulse from a streaming anomaly detector into a full ML/DL
> trading bot that identifies market patterns, generates signals, and executes trades
> autonomously — with rigorous backtesting, risk management, and model evaluation.

---

## Current State (v1.0)

Binance REST poll (10s) → `FeatureExtractor` (log returns, vol, z_ret, vol_delta)
→ per-coin online scorer (z-score | HalfSpaceTrees + QuantileFilter)
→ Postgres/SQLite + WS fanout → React dashboard (lightweight-charts + Zustand).

**What's working:**
- Stationary feature extraction (`scoring/features.py`)
- Online anomaly scoring with two models (z-score baseline + HST)
- QuantileFilter for scale-free anomaly classification
- Sentinel-based shutdown (no tick loss)
- Offline backtest script (`scripts/backtest.py`)
- Live dashboard with sensitivity slider

---

## Phase 1 — Evaluation Without Labels

> **Goal:** Can't improve what you can't measure. Build a defensible evaluation framework.

### 1.1 Synthetic Anomaly Injection

Inject known anomaly types into real Binance kline data and measure detection:

```python
# scripts/inject_anomalies.py
class AnomalyInjector:
    """Inject synthetic anomalies into clean kline data."""

    def pump_spike(self, klines, idx, magnitude=0.15):
        """Sudden +15% price spike over 3 candles, then reversion."""

    def flash_crash(self, klines, idx, magnitude=0.20):
        """Sharp -20% drop over 1-2 candles."""

    def volume_burst(self, klines, idx, multiplier=10.0):
        """Volume spikes 10x with minimal price movement (wash trading signal)."""

    def flatline(self, klines, idx, duration=30):
        """Price goes perfectly flat — stale feed / exchange halt."""

    def momentum_ignition(self, klines, idx):
        """Rapid up-down-up pattern designed to trigger stop-losses."""
```

**Metrics per anomaly type per model:**
- Precision / Recall / F1
- PR-AUC (handles class imbalance correctly — ROC-AUC does not)
- Detection lag (candles between injection and first flag)

### 1.2 Proxy Labels

Since no ground truth exists, define principled proxies:

| Proxy | Definition | Use |
|---|---|---|
| Extreme return | \|return\| > 5σ of 30-day rolling distribution | Tail events |
| Volume anomaly | Volume > 10× rolling 1h mean | Unusual activity |
| News events | Timestamped from CoinGecko/CryptoCompare news API | Validation anchor |
| Exchange outage | Known halt timestamps | Flatline detection |

> **Rule:** Always label these as *proxy*, never as ground truth. Document the gap.

### 1.3 Model Comparison Dashboard

Extend `scripts/backtest.py` to produce a comparison report:

```
┌────────────────┬───────────┬────────┬────────┬─────────┬──────────┐
│ Model          │ Anomaly % │ Prec.  │ Recall │ PR-AUC  │ Lag (s)  │
├────────────────┼───────────┼────────┼────────┼─────────┼──────────┤
│ z-score (3σ)   │ 2.1%      │ 0.34   │ 0.89   │ 0.41    │ 0        │
│ HST (q=0.99)   │ 1.8%      │ 0.52   │ 0.71   │ 0.58    │ 10s      │
│ LSTM-AE        │ 1.4%      │ 0.68   │ 0.82   │ 0.73    │ 60s      │
│ Ensemble       │ 0.9%      │ 0.81   │ 0.76   │ 0.79    │ 30s      │
└────────────────┴───────────┴────────┴────────┴─────────┴──────────┘
```

**Deliverables:**
- `scripts/inject_anomalies.py` — anomaly injection framework
- `scripts/evaluate.py` — evaluation harness with metrics
- `data/evaluation/` — cached results per model per symbol

---

## Phase 2 — Model Ladder (Where DL Enters)

> **Goal:** Progress from statistical baselines through proper deep learning models.

### 2.1 EWMA Z-Score (Cheap Upgrade)

Replace the fixed-window rolling z-score with EWMA (Exponentially Weighted Moving Average):

```python
class EWMAScorer(BaseScorer):
    """EWMA z-score: recent ticks weighted more heavily than distant ones."""

    def __init__(self, span=30, threshold=3.0):
        self.ewma_mean = stats.EWMean(fading_factor=2/(span+1))
        self.ewma_var  = stats.EWVar(fading_factor=2/(span+1))
```

- Responds faster to regime shifts than fixed-window
- Drop-in replacement behind `BaseScorer` interface

### 2.2 Matrix Profile (Explainable Pattern Detection)

```python
# scoring/matrixprofile.py
import stumpy

class MatrixProfileScorer(BaseScorer):
    """
    Time-series discord detection using Matrix Profile.

    Finds subsequences that are maximally different from all other
    subsequences — i.e., patterns that have never occurred before.
    Highly explainable: "this 10-minute window looks unlike anything
    in the last 24 hours."
    """
```

- `stumpy.stumped()` for incremental updates
- Window: 60 ticks (10 minutes) compared against 8640 ticks (24 hours)
- Catches structural breaks that per-tick models miss

### 2.3 GRU/LSTM Autoencoder (The DL Model)

This is what makes the project a genuine DL project.

```
Architecture:
  Input: 60-step window × 4 features (ret, vol, z_ret, vol_delta)

  Encoder:
    GRU(input=4, hidden=32) → GRU(hidden=32, hidden=16) → z ∈ ℝ¹⁶

  Decoder:
    GRU(input=16, hidden=32) → GRU(hidden=32, hidden=4) → reconstruct

  Loss: MSE reconstruction error
  Anomaly: reconstruction_error > percentile(q=0.99) of training set
```

**Training pipeline:**
```
scripts/train_autoencoder.py
  → Download 90 days of 1m klines (Binance, free)
  → FeatureExtractor → sliding windows
  → Train/val split (80/20 temporal, NOT random)
  → PyTorch training loop (AdamW, OneCycleLR, early stopping)
  → Export: model.pt + threshold.json + metrics.json
```

**Serving:**
```python
# scoring/autoencoder.py
class AutoencoderScorer(BaseScorer):
    """LSTM autoencoder anomaly scorer served behind BaseScorer interface."""

    def __init__(self, model_path: str, threshold_path: str):
        self.model = torch.jit.load(model_path)
        self.window = deque(maxlen=60)

    def score(self, features: dict) -> tuple[float, bool]:
        self.window.append([features["ret"], features["vol"],
                           features["z_ret"], features["vol_delta"]])
        if len(self.window) < 60:
            return 0.0, False
        x = torch.tensor([list(self.window)], dtype=torch.float32)
        with torch.no_grad():
            recon = self.model(x)
        error = F.mse_loss(recon, x).item()
        return error, error > self.threshold
```

- One forward pass per tick on a rolling `deque` — streaming unchanged
- No architecture rewrite: `BaseScorer.score()` is all we need
- Export to TorchScript for production; ONNX for cross-platform

**Deliverables:**
- `scoring/ewma.py` — EWMA z-score scorer
- `scoring/matrixprofile.py` — Matrix Profile scorer
- `scoring/autoencoder.py` — LSTM/GRU autoencoder scorer
- `scripts/train_autoencoder.py` — offline training pipeline
- `models/` — versioned model artifacts (`.pt` + `metrics.json`)

---

## Phase 3 — Pattern Recognition

> **Goal:** Move beyond anomaly detection to recognising actionable market patterns.

### 3.1 Candlestick Pattern Detection

```python
# patterns/candlestick.py
class CandlestickDetector:
    """Detect classical candlestick patterns from OHLCV data."""

    PATTERNS = {
        "hammer":       lambda o,h,l,c: ...,  # bullish reversal
        "shooting_star": lambda o,h,l,c: ..., # bearish reversal
        "doji":         lambda o,h,l,c: ...,  # indecision
        "engulfing":    lambda prev, curr: ..., # reversal
        "morning_star": lambda p1, p2, p3: ..., # bullish reversal
        "three_soldiers": lambda p1, p2, p3: ..., # continuation
    }
```

- TA-Lib or pure Python implementation
- Confidence score per pattern (body ratios, wick lengths, volume confirmation)

### 3.2 Chart Pattern Detection (CNN)

```
Architecture:
  Input: 240-candle OHLCV → rasterize to 64×64 grayscale image
  Model: ResNet-18 pretrained → fine-tune on labelled chart patterns
  Classes: head_and_shoulders, double_top, double_bottom, triangle,
           wedge, flag, channel, no_pattern

  Training data: Synthetic generation from geometric templates + noise
                 + real kline snippets annotated via clustering
```

- Alternative: 1D-CNN directly on OHLCV sequences (no rasterization)
- Output: pattern class + confidence + expected direction

### 3.3 Support/Resistance Level Detection

```python
# patterns/levels.py
class LevelDetector:
    """Identify dynamic support and resistance levels."""

    def find_levels(self, klines, method="fractal"):
        """
        Methods:
          - fractal: Williams fractals (local min/max over 5 bars)
          - volume_profile: price levels with highest traded volume
          - pivot: classic pivot points (H+L+C)/3
        """
```

### 3.4 Regime Detection (Hidden Markov Model)

```python
# patterns/regime.py
from hmmlearn import hmm

class RegimeDetector:
    """
    Detect market regimes: trending_up, trending_down, mean_reverting, volatile.

    Uses a Gaussian HMM on (return, volatility, volume_delta) features.
    Regime transitions are the most actionable signals for strategy switching.
    """
```

**Deliverables:**
- `app/patterns/` — new module for pattern recognition
- `app/patterns/candlestick.py` — candlestick pattern detector
- `app/patterns/chart_cnn.py` — CNN-based chart pattern classifier
- `app/patterns/levels.py` — support/resistance level finder
- `app/patterns/regime.py` — HMM regime detector
- `scripts/train_chart_cnn.py` — chart pattern training pipeline

---

## Phase 4 — Predictive Models

> **Goal:** Predict price direction and volatility — the core of a trading bot.

### 4.1 Price Direction Classifier

Predict: will the price be higher or lower in N candles?

```
Model options (in order of complexity):
  1. Logistic regression on engineered features (baseline)
  2. XGBoost/LightGBM on 50+ features (strong baseline)
  3. Temporal Fusion Transformer (TFT) — state of the art for time series
  4. Transformer with learned positional encoding

Features:
  - Technical: RSI, MACD, Bollinger width, ATR, OBV, ADX, Stochastic
  - Statistical: ret, vol, z_ret, vol_delta (from features.py)
  - Pattern: candlestick signals, S/R distance, regime state
  - Cross-coin: BTC correlation, sector momentum
  - Microstructure: bid-ask imbalance (from L2 book if available)

Target: sign(close[t+N] - close[t]) → {-1, 0, +1}
        With neutral zone: |return| < 0.1% → 0 (no trade)
```

### 4.2 Volatility Forecasting (GARCH + DL)

```python
# models/volatility.py
class VolatilityForecaster:
    """
    Forecast next-period volatility for position sizing.

    Ensemble:
      - GARCH(1,1) on log returns (classical, fast, interpretable)
      - GRU on (ret, vol, volume) sequence (captures nonlinear dynamics)
      - Exponential averaging of both predictions
    """
```

- Critical for risk management: high vol → smaller positions
- GARCH via `arch` library; DL via PyTorch

### 4.3 Temporal Fusion Transformer

```
Architecture (based on Google's TFT paper):
  Static covariates:  coin_id embedding, exchange_id
  Known future:       time-of-day, day-of-week, is_weekend
  Observed past:      OHLCV, features, technical indicators
  Decoder:            Multi-horizon (predict 5m, 15m, 1h, 4h ahead)

  Key innovation: Variable Selection Networks automatically learn
  which features matter for each prediction horizon.
```

- Uses `pytorch-forecasting` or custom implementation
- Multi-horizon: different strategies use different lookaheads
- Interpretable: attention weights show which features/timesteps drove the prediction

**Deliverables:**
- `app/models/` — new module for predictive models
- `app/models/direction.py` — price direction classifier
- `app/models/volatility.py` — volatility forecaster
- `app/models/tft.py` — Temporal Fusion Transformer
- `scripts/train_direction.py` — direction model training
- `scripts/train_tft.py` — TFT training pipeline
- Feature store: `app/features/technical.py` (RSI, MACD, Bollinger, etc.)

---

## Phase 5 — Signal Engine & Strategy Framework

> **Goal:** Combine model outputs into actionable trade signals.

### 5.1 Signal Aggregator

```python
# strategy/signals.py
@dataclass
class Signal:
    coin_id: str
    timestamp: datetime
    direction: Literal["long", "short", "flat"]
    confidence: float        # ∈ [0, 1]
    source: str              # which model generated it
    features: dict           # input features for audit trail

class SignalAggregator:
    """
    Combine signals from multiple models into a consensus.

    Strategies:
      - majority_vote: 3/5 models agree → trade
      - weighted_vote: weight by historical accuracy
      - meta_learner: XGBoost on individual model signals (stacking)
    """
```

### 5.2 Strategy Framework

```python
# strategy/base.py
class BaseStrategy(ABC):
    @abstractmethod
    def on_tick(self, tick, signals) -> list[Order]: ...

    @abstractmethod
    def on_fill(self, fill) -> None: ...

class MomentumStrategy(BaseStrategy):
    """Buy on strong upward momentum, sell on reversal signals."""

class MeanReversionStrategy(BaseStrategy):
    """Trade mean reversion when z_ret exceeds ±2σ near S/R levels."""

class BreakoutStrategy(BaseStrategy):
    """Enter on volume-confirmed breakout from consolidation range."""

class AnomalyStrategy(BaseStrategy):
    """Counter-trade anomalies when confidence is high and regime is mean-reverting."""
```

### 5.3 Position Sizing (Kelly + Vol-Adjusted)

```python
# strategy/sizing.py
class PositionSizer:
    """
    Kelly criterion with volatility adjustment.

    kelly_fraction = (win_rate × avg_win - (1 - win_rate) × avg_loss) / avg_win
    vol_adjusted_size = kelly_fraction × (target_vol / forecast_vol)
    capped_size = min(vol_adjusted_size, max_position_pct)
    """
```

**Deliverables:**
- `app/strategy/` — strategy framework
- `app/strategy/signals.py` — signal aggregation
- `app/strategy/base.py` — strategy ABC
- `app/strategy/momentum.py`, `mean_reversion.py`, `breakout.py`
- `app/strategy/sizing.py` — position sizing

---

## Phase 6 — Backtesting Framework

> **Goal:** Rigorous backtesting with realistic assumptions.

### 6.1 Event-Driven Backtester

```python
# backtest/engine.py
class BacktestEngine:
    """
    Event-driven backtester with realistic market simulation.

    Anti-pitfalls:
      - Temporal train/test split (NEVER random)
      - Transaction costs: 0.1% maker, 0.1% taker (Binance fee tier)
      - Slippage model: linear impact proportional to order size / ADV
      - No lookahead bias: signals use only data available at decision time
      - Walk-forward validation: retrain every N days, test on next M days
    """

    def run(self, strategy, klines, config) -> BacktestResult:
        portfolio = Portfolio(initial_capital=10000)
        for candle in klines:
            signals = strategy.on_tick(candle)
            orders = portfolio.execute(signals, candle, slippage_model)
        return BacktestResult(portfolio)
```

### 6.2 Performance Metrics

```python
@dataclass
class BacktestResult:
    # Returns
    total_return: float          # cumulative return %
    annualized_return: float     # CAGR
    benchmark_return: float      # buy-and-hold comparison

    # Risk
    sharpe_ratio: float          # (return - risk_free) / volatility
    sortino_ratio: float         # downside deviation only
    max_drawdown: float          # worst peak-to-trough
    max_drawdown_duration: int   # days underwater
    calmar_ratio: float          # return / max_drawdown
    var_95: float                # Value at Risk (95%)
    cvar_95: float               # Conditional VaR (Expected Shortfall)

    # Execution
    total_trades: int
    win_rate: float
    profit_factor: float         # gross profit / gross loss
    avg_trade_duration: timedelta
    avg_winner: float
    avg_loser: float

    # Stability
    monthly_returns: list[float]  # for distribution analysis
    rolling_sharpe: list[float]   # stability over time
```

### 6.3 Walk-Forward Optimization

```
┌──────────┬──────┬──────────┬──────┬──────────┬──────┐
│  Train   │ Test │  Train   │ Test │  Train   │ Test │
│  90 days │ 30d  │  90 days │ 30d  │  90 days │ 30d  │
└──────────┴──────┴──────────┴──────┴──────────┴──────┘
                  ← Walk forward →

Each window: retrain model → test on out-of-sample → record metrics.
Aggregate: mean ± std of Sharpe, drawdown, win rate across all windows.
This is the ONLY honest way to evaluate a trading strategy.
```

**Deliverables:**
- `backtest/` — backtesting framework
- `backtest/engine.py` — event-driven backtester
- `backtest/portfolio.py` — portfolio tracker
- `backtest/metrics.py` — performance analytics
- `backtest/slippage.py` — realistic slippage model
- `scripts/run_backtest.py` — CLI for backtesting strategies
- `notebooks/backtest_analysis.ipynb` — visual analysis of results

---

## Phase 7 — Risk Management

> **Goal:** Don't blow up. This is non-negotiable before live trading.

### 7.1 Risk Limits

```python
# risk/limits.py
@dataclass
class RiskLimits:
    max_position_pct: float = 0.10       # max 10% of capital per position
    max_total_exposure: float = 0.50     # max 50% total invested
    max_daily_loss: float = 0.02         # stop trading after -2% day
    max_drawdown: float = 0.10           # halt at -10% from peak
    max_correlation: float = 0.80        # limit correlated positions
    max_trades_per_hour: int = 10        # prevent overtrading
    min_trade_interval: int = 60         # seconds between trades
```

### 7.2 Pre-Trade Risk Check

Every order passes through:
1. Position size within limits
2. Portfolio exposure check
3. Daily P&L gate
4. Drawdown circuit breaker
5. Correlation check (don't go long BTC + ETH + SOL simultaneously at full size)

### 7.3 Stop-Loss & Take-Profit

```python
class StopManager:
    """
    Dynamic stop-loss using ATR (Average True Range).

    Initial stop: entry_price - 2 × ATR(14)
    Trailing stop: max(price_seen) - 1.5 × ATR(14)
    Take profit: entry_price + 3 × ATR(14)  (1.5:1 reward/risk)
    """
```

**Deliverables:**
- `app/risk/` — risk management module
- `app/risk/limits.py` — risk limit definitions
- `app/risk/checks.py` — pre-trade validation
- `app/risk/stops.py` — stop-loss/take-profit management

---

## Phase 8 — Paper Trading → Live Trading

> **Goal:** Validate in simulation, then go live with real capital.

### 8.1 Paper Trading Engine

```python
# trading/paper.py
class PaperTradingEngine:
    """
    Simulated trading on live market data.

    - Receives real-time prices from the existing Binance poller
    - Executes trades against a virtual portfolio
    - Applies realistic slippage and fees
    - Logs every decision for post-session analysis
    - Runs for minimum 30 days before live trading is considered
    """
```

### 8.2 Live Execution (Binance API)

```python
# trading/executor.py
class BinanceExecutor:
    """
    Live order execution via Binance API.

    Safety features:
      - All risk checks pass before any order submission
      - Market orders only (no limit order management in v1)
      - Maximum order size hard-coded
      - Kill switch: POST /api/halt → cancel all open orders, close positions
      - Rate limiting: respect Binance API limits (1200 req/min)
    """
```

### 8.3 Binance WebSocket Upgrade

Replace REST polling with Binance WebSocket streams:

```python
# ingestion/ws_stream.py
class BinanceWSStream:
    """
    Real-time data via Binance WebSocket.

    Streams: <symbol>@kline_1m, <symbol>@trade, !ticker@arr
    Latency: sub-100ms (vs 10s polling)
    Bonus: no rate limits, less code than batch poller
    """
```

**Deliverables:**
- `app/trading/` — trading execution module
- `app/trading/paper.py` — paper trading engine
- `app/trading/executor.py` — live Binance execution
- `app/trading/orders.py` — order types and lifecycle
- `app/ingestion/ws_stream.py` — Binance WebSocket stream
- Dashboard: P&L panel, position table, trade history

---

## Phase 9 — Champion/Challenger & Ensemble

> **Goal:** Run multiple models concurrently, compare, and ensemble.

### 9.1 Multi-Model Scoring

`ScorerRegistry` already keys by `coin_id`. Extend to `(coin_id, model_name)`:

```python
# Score every tick with ALL models concurrently
for model_name, scorer in registry.get_all_scorers(coin_id):
    score, is_anomaly = scorer.score(features)
    log_score(coin_id, model_name, score, is_anomaly)
```

- Disagreement rate = free anomaly signal (when models disagree, something interesting is happening)
- No latency penalty: models run in parallel via `asyncio.gather()`

### 9.2 Ensemble Strategies

```python
class EnsembleScorer:
    """
    Combine multiple scorers into a single consensus.

    Methods:
      - simple_average: mean(scores) > threshold
      - weighted_vote: weight by inverse backtest error
      - stacking: train XGBoost on (z_score, hst_score, ae_score) → final prediction
    """
```

### 9.3 Online A/B Testing

- Route 50% of coins to model A, 50% to model B
- Compare: anomaly rate, precision on proxy labels, signal profitability
- Automatic promotion: winner becomes champion after N ticks

**Deliverables:**
- Extend `scorer.py` for multi-model concurrent scoring
- `scoring/ensemble.py` — ensemble scorer
- Dashboard: model comparison panel with live metrics

---

## Phase 10 — MLOps & Monitoring

> **Goal:** Production-grade ML lifecycle management.

### 10.1 Training Pipeline

```bash
# Fully reproducible training run
python scripts/train.py \
    --model autoencoder \
    --data data/klines/btcusdt_1m_90d.parquet \
    --seed 42 \
    --output models/autoencoder_v4/

# Output:
#   models/autoencoder_v4/model.pt         # TorchScript
#   models/autoencoder_v4/metrics.json     # eval metrics
#   models/autoencoder_v4/config.yaml      # hyperparameters
#   models/autoencoder_v4/data_hash.sha256 # reproducibility
```

### 10.2 Model Registry

Keep it simple — no MLflow unless needed for portfolio material:

```
models/
├── autoencoder_v4/
│   ├── model.pt
│   ├── metrics.json        # {"pr_auc": 0.73, "sharpe_backtest": 1.8}
│   ├── config.yaml
│   └── data_hash.sha256
├── direction_xgb_v2/
│   ├── model.json
│   └── metrics.json
└── registry.json           # {"production": {"anomaly": "autoencoder_v4", ...}}
```

### 10.3 Drift Monitoring

```python
# monitoring/drift.py
class DriftMonitor:
    """
    Detect distribution shift between training and live data.

    Metrics:
      - PSI (Population Stability Index) on each feature
      - KL divergence on score distributions
      - Rolling accuracy on proxy labels

    Alert: PSI > 0.2 on any feature → retrain recommended
    """
```

### 10.4 Prometheus Metrics

```python
# Expose /metrics endpoint
SCORING_LATENCY = Histogram("scoring_latency_seconds", "Time to score one tick")
ANOMALY_RATE = Gauge("anomaly_rate", "Rolling anomaly rate", ["model", "coin"])
PIPELINE_LAG = Histogram("pipeline_lag_seconds", "polled_at to scored_at")
TRADE_PNL = Gauge("trade_pnl_usd", "Cumulative P&L", ["strategy"])
MODEL_DRIFT_PSI = Gauge("model_drift_psi", "PSI per feature", ["model", "feature"])
```

**Deliverables:**
- `scripts/train.py` — unified training CLI
- `models/` — versioned model directory
- `app/monitoring/drift.py` — drift detector
- Prometheus `/metrics` endpoint
- Grafana dashboard template

---

## Phase 11 — Cross-Coin & Portfolio Intelligence

> **Goal:** Exploit inter-coin relationships that per-coin models structurally miss.

### 11.1 Correlation Analysis

```python
# models/cross_coin.py
class CorrelationMonitor:
    """
    Rolling correlation matrix across all tracked coins.

    Signals:
      - Correlation break: BTC/ETH usually r=0.85, drops to r=0.3
        → exchange-specific event, arbitrage opportunity
      - Correlation spike: all coins suddenly r>0.95
        → systematic risk event, reduce exposure
    """
```

### 11.2 Rolling PCA Anomaly Detection

```python
class PCAAnomaly:
    """
    8 coins → 8-dimensional return vector per tick.
    Fit rolling PCA, keep top 3 components.
    Reconstruction error = anomaly score.

    Catches: market-wide vs idiosyncratic anomalies.
    "BTC moved normally but DOGE didn't follow" vs "everything moved together."
    """
```

### 11.3 Portfolio Optimization

```python
class PortfolioOptimizer:
    """
    Mean-variance optimization with regime-dependent parameters.

    In trending regime:  maximize momentum exposure
    In mean-reverting:   maximize mean-reversion alpha
    In volatile:         minimize exposure, increase cash

    Constraints:
      - Max position size per coin
      - Sector exposure limits
      - Turnover penalty (avoid excessive rebalancing)
    """
```

**Deliverables:**
- `app/models/cross_coin.py` — correlation & PCA anomaly
- `app/strategy/portfolio.py` — portfolio optimization
- Dashboard: correlation heatmap, portfolio allocation chart

---

## Phase 12 — Alternative Data

> **Goal:** Alpha from non-price data sources.

### 12.1 Sentiment Analysis

```python
# data/sentiment.py
class SentimentAnalyzer:
    """
    Sources:
      - CryptoCompare news API (free tier)
      - Reddit r/CryptoCurrency via PRAW
      - Twitter/X via search API (if available)

    Model: FinBERT fine-tuned on crypto text
    Output: sentiment_score ∈ [-1, 1] per coin per hour
    """
```

### 12.2 On-Chain Metrics

```python
# data/onchain.py
class OnChainFeatures:
    """
    Free on-chain data from blockchain.com / Glassnode (limited free tier):
      - Active addresses (network activity)
      - Exchange inflows/outflows (selling/buying pressure)
      - Hash rate changes (miner behavior, BTC-specific)
      - Large transaction count (whale activity)
    """
```

### 12.3 Funding Rate & Open Interest

```python
# data/derivatives.py
class DerivativesData:
    """
    Binance Futures API (free):
      - Funding rate: positive = longs pay shorts (crowded long)
      - Open interest: total outstanding contracts
      - Long/short ratio: retail positioning

    High funding + high OI + extreme long ratio → reversal signal
    """
```

**Deliverables:**
- `app/data/sentiment.py` — sentiment pipeline
- `app/data/onchain.py` — on-chain feature extraction
- `app/data/derivatives.py` — derivatives data integration

---

## Technology Additions

| Phase | New Dependencies | Why |
|---|---|---|
| 2 | `torch`, `stumpy` | LSTM autoencoder, Matrix Profile |
| 3 | `ta-lib` or `pandas-ta`, `hmmlearn` | Technical indicators, regime detection |
| 4 | `pytorch-forecasting`, `xgboost` | TFT, gradient boosting |
| 6 | `vectorbt` or custom | Backtesting framework |
| 10 | `prometheus-client` | Metrics export |
| 12 | `transformers` (FinBERT), `praw` | Sentiment analysis |

---

## What NOT to Build

> **Principle:** Don't build infra for scale you don't have.

| Don't | Why | Revisit When |
|---|---|---|
| Redis Streams | `asyncio.Queue` correct at 8 coins × 0.1 Hz | > 100 coins or multi-process |
| Kubernetes | Single Cloud Run instance is fine | Multi-service architecture |
| Feature store (Feast) | Overkill at < 50 features | > 200 features across teams |
| MLflow | `model.pt + metrics.json` suffices | Team > 3 people |
| Model serving (Seldon/BentoML) | BaseScorer interface handles it | Separate model microservice |
| HFT infrastructure | 10s polling, not microsecond | Never (different domain) |

---

## Milestone Timeline

| Phase | What | Effort | Depends On |
|---|---|---|---|
| **1** | Evaluation framework | 3–5 days | — |
| **2** | Model ladder (EWMA + Matrix Profile + LSTM-AE) | 7–10 days | Phase 1 |
| **3** | Pattern recognition | 5–7 days | Phase 2 |
| **4** | Predictive models (direction + volatility) | 7–10 days | Phase 2, 3 |
| **5** | Signal engine & strategies | 5–7 days | Phase 4 |
| **6** | Backtesting framework | 5–7 days | Phase 5 |
| **7** | Risk management | 3–5 days | Phase 6 |
| **8** | Paper trading → live trading | 7–10 days | Phase 6, 7 |
| **9** | Champion/challenger & ensemble | 3–5 days | Phase 2 |
| **10** | MLOps & monitoring | 5–7 days | Phase 8 |
| **11** | Cross-coin intelligence | 5–7 days | Phase 4 |
| **12** | Alternative data | 5–7 days | Phase 4 |

> Phases 9–12 can be done in any order after their dependencies are met.
> Total estimated effort: ~70–90 days of focused work.

---

## Ground Rules

1. **No overclaiming.** Document proxy labels as proxy labels. Report confidence intervals.
2. **No lookahead bias.** Every evaluation uses temporal splits. Every backtest applies realistic fees and slippage.
3. **Risk first.** Phase 7 must be complete before Phase 8 goes live.
4. **Paper before live.** Minimum 30 days profitable paper trading before real capital.
5. **Measure everything.** If you can't measure it, don't ship it.
