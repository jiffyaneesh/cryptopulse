"""
scoring/halftrees.py
────────────────────
HalfSpaceTrees online anomaly scorer using the river ML library.

HalfSpaceTrees (HST) is a streaming variant of the Isolation Forest algorithm.
It learns a multivariate density model over the stationary feature vector
(see scoring/features.py) and adapts to shifting volatility without any
retraining or batch data access.

Why HST for crypto:
  Crypto markets exhibit volatility clustering (calm periods punctuated by
  sudden regime shifts). A fixed-window z-score struggles at transitions
  because its rolling mean/std lag behind the new regime. HST's sliding-window
  mass estimations naturally decay stale structure, making it adaptive.

Key implementation detail — QuantileFilter, not ThresholdFilter:
  HST's raw score scale depends entirely on the feature space it runs in. In
  this 4-feature stationary space its scores concentrate near 1.0 (measured
  p50 ≈ 0.91, p99 ≈ 0.996 over 1 day of 1m klines), so a fixed absolute
  threshold of 0.75 classified ~89% of all ticks as anomalous — verified on
  BTC/ETH/SOL/DOGE via scripts/backtest.py.

  QuantileFilter instead tracks the running quantile of the scores it has
  actually seen and flags the top (1 - q) fraction. That makes the sensitivity
  control scale-free: q=0.99 means "flag the most extreme 1%" no matter what
  absolute range HST happens to output. Measured anomaly rate after the switch:
  1.8–2.4% at q=0.99.

Key implementation detail — protect_anomaly_detector=True:
  Without this flag, anomalous ticks (extreme outliers) would be fed back
  into the model's learning step, gradually shifting its internal density
  estimate toward the anomaly. This is a form of concept drift poisoning.
  With protect_anomaly_detector=True, the filter skips learn_one()
  calls for ticks it classifies as anomalous.

Responsibilities:
  - Implement BaseScorer for the HalfSpaceTrees algorithm.
  - Maintain a river Pipeline (MinMaxScaler → QuantileFilter → HST).
  - Provide score in [0, 1] and binary is_anomaly flag.

NOT responsible for:
  - Dispatching per-coin instances (see scoring/scorer.py).
"""

from __future__ import annotations

import logging

from river import anomaly, compose, preprocessing

from app.scoring.scorer import BaseScorer

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

# Number of half-space trees. More trees → more stable scores, higher memory.
# 25 is the river default and empirically good for univariate price data.
N_TREES: int = 25

# Tree depth. Controls the granularity of the density approximation.
# Height 10 gives 2^10 = 1024 potential partitions — more than sufficient for univariate price data.
HEIGHT: int = 10


# Sliding window size for the mass estimator. HST tracks mass in the last
# WINDOW_SIZE observations to adapt to non-stationarity.
# 150 ticks × 10s = 25 minutes of history — balances responsiveness vs. stability.
WINDOW_SIZE: int = 150

# Default quantile level for anomaly classification: flag scores above the
# running q-quantile, i.e. the most extreme (1 - q) fraction of observations.
# 0.99 → ~1% of ticks flagged. Measured 1.8–2.4% on 1 day of 1m klines across
# BTC/ETH/SOL/DOGE (the excess over 1% is the warm-up tail, where the running
# quantile estimate has seen too few scores to be tight).
DEFAULT_THRESHOLD: float = 0.99

# Minimum scores the QuantileFilter must observe before its quantile estimate
# is trustworthy enough to classify against.
MIN_SCORES_BEFORE_CLASSIFY: int = 100


class HalfSpaceTreesScorer(BaseScorer):
    """
    Online anomaly scorer using HalfSpaceTrees (streaming Isolation Forest).

    Internally uses a river Pipeline:
      MinMaxScaler → QuantileFilter(HalfSpaceTrees(...), protect_anomaly_detector=True)

    The MinMaxScaler is required because HST partitions the feature space using
    uniform random splits — it assumes features are bounded in [0, 1]. Without
    scaling, the split points would be meaningless for features with
    unbounded ranges. It now scales the 4 stationary features.

    Attributes:
        threshold:  Quantile level q ∈ (0, 1). Scores above the running
                    q-quantile are flagged, so the effective anomaly rate is
                    roughly (1 - q).
        _model:     The river Pipeline instance.
        _n_seen:    Count of ticks processed (for warm-up tracking).
    """

    def __init__(self, threshold: float = DEFAULT_THRESHOLD) -> None:
        """
        Initialise the HalfSpaceTrees scorer.

        Args:
            threshold: Quantile level q ∈ (0, 1). Higher = less sensitive
                       (fewer anomalies flagged). 0.99 → ~1% flagged.
        """
        self.threshold = threshold
        self._n_seen: int = 0

        # Build the river Pipeline:
        # 1. MinMaxScaler: normalises each feature to [0, 1] using running
        #    min/max. HST requires bounded input — this is non-negotiable.
        # 2. QuantileFilter wraps HST to provide is_anomaly classification
        #    relative to the running score distribution rather than an absolute
        #    cutoff — see the module docstring for why the absolute threshold
        #    had to go.
        #    protect_anomaly_detector=True: if is_anomaly, skip learn_one() to
        #    prevent outliers from poisoning the density model (concept drift guard).
        self._model = compose.Pipeline(
            preprocessing.MinMaxScaler(),
            anomaly.QuantileFilter(
                anomaly.HalfSpaceTrees(
                    n_trees=N_TREES,
                    height=HEIGHT,
                    window_size=WINDOW_SIZE,
                    seed=42,  # Deterministic tree initialisation for reproducibility
                ),
                q=threshold,
                protect_anomaly_detector=True,
            ),
        )

    def score(self, features: dict[str, float]) -> tuple[float, bool]:
        """
        Score a feature observation and update the internal model.

        Calls score_one() before learn_one() so the current observation
        does not influence its own score (same look-ahead bias prevention
        as z-score, though HST's mass-based scoring is less sensitive to this).

        Args:
            features: Dictionary of stationary features.

        Returns:
            Tuple of (anomaly_score: float, is_anomaly: bool).
            anomaly_score is normalised to [0, 1].
        """
        # score_one() computes the anomaly score from the inner HST model.
        # The Pipeline delegates to QuantileFilter.score_one(), which delegates
        # to HalfSpaceTrees.score_one() after passing through MinMaxScaler.
        anomaly_score: float = float(self._model.score_one(features))

        # QuantileFilter.classify(score) compares against its running quantile.
        # We access the filter step directly from the pipeline's steps dict
        # because Pipeline does NOT expose classify_one() — only score_one().
        quantile_filter = self._model.steps["QuantileFilter"]

        # Suppress flags until the running quantile has seen enough scores.
        # Early on, the quantile estimate sits near whatever few scores arrived
        # first, so almost anything clears it — that produced a burst of false
        # anomalies in the first ~100 ticks.
        if self._n_seen < MIN_SCORES_BEFORE_CLASSIFY:
            is_anomaly = False
            quantile_filter.classify(anomaly_score)  # keep the quantile updating
        else:
            is_anomaly = bool(quantile_filter.classify(anomaly_score))

        # learn_one() updates MinMaxScaler bounds and HST mass estimations.
        # QuantileFilter with protect_anomaly_detector=True skips learn_one()
        # for anomalous ticks internally — preventing concept drift poisoning.
        self._model.learn_one(features)
        self._n_seen += 1

        if is_anomaly:
            logger.debug(
                "HST anomaly detected",
                extra={"score": round(anomaly_score, 4), "threshold": self.threshold},
            )

        return anomaly_score, is_anomaly

    def update_threshold(self, threshold: float) -> None:
        """
        Update the quantile level at runtime.

        Modifies the QuantileFilter's q without rebuilding the pipeline — the
        HST model weights and the accumulated score quantile are preserved.

        Args:
            threshold: New quantile level q ∈ (0, 1). Lower = more sensitive.
        """
        old = self.threshold
        self.threshold = threshold
        # Access the QuantileFilter by name from the pipeline steps dict.
        # Setting .quantile.q directly preserves all accumulated state (tree mass
        # estimations, MinMaxScaler bounds, observed score quantile).
        quantile_filter = self._model.steps["QuantileFilter"]
        quantile_filter.quantile.q = threshold
        logger.info(
            "HST quantile updated", extra={"old": old, "new": threshold}
        )

    @property
    def is_warmed_up(self) -> bool:
        """
        Return True once the model has seen enough ticks to be reliable.

        HST lazy-initialises its trees on the first learn_one() call.
        It is effectively warmed up after WINDOW_SIZE ticks because the
        MinMaxScaler needs sufficient range to produce meaningful scaling.
        """
        return self._n_seen >= WINDOW_SIZE
