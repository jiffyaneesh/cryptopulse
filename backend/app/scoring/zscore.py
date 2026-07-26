"""
scoring/zscore.py
─────────────────
Rolling Z-Score anomaly scorer using a fixed-size deque window.

The rolling z-score is the v0 (baseline) anomaly model. It flags a price tick
as anomalous when its price is more than `threshold` standard deviations from
the rolling mean of the last `window_size` ticks.

Why a manual deque instead of river.stats:
  river 0.25.0 does not expose a RollingMean/RollingVar API on river.stats.
  We use a collections.deque with maxlen for O(1) append/evict, and compute
  mean and sample variance directly — same algorithmic result, pure stdlib.

Responsibilities:
  - Implement BaseScorer for the rolling z-score algorithm.
  - Maintain per-coin rolling statistics (one instance per coin).
  - Update statistics AFTER scoring to avoid look-ahead bias.

NOT responsible for:
  - Dispatching to the correct coin's scorer (see scoring/scorer.py).
  - Persisting scores (see db/queries.py).
"""

from __future__ import annotations

import math
import logging
from collections import deque

from app.scoring.scorer import BaseScorer

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

# Rolling window size in ticks. 50 ticks × 10s/tick ≈ 8-minute rolling window.
DEFAULT_WINDOW_SIZE: int = 50

# Default z-score threshold (standard deviations).
# 3σ is the classical threshold; actual FPR higher due to crypto heavy tails.
DEFAULT_THRESHOLD: float = 3.0

# Epsilon added to denominator to avoid division-by-zero during warm-up
# when all values in the window are identical (zero variance).
VARIANCE_EPSILON: float = 1e-9


class ZScoreScorer(BaseScorer):
    """
    Online rolling z-score anomaly scorer.

    Maintains a sliding window of the last `window_size` price observations
    using a collections.deque (maxlen evicts oldest on overflow — O(1) both ways).
    Mean and sample variance are computed from the window contents on each call.

    Attributes:
        window_size:  Number of ticks in the rolling window.
        threshold:    Z-score value above which a tick is flagged anomalous.
        _window:      deque of recent price values (maxlen=window_size).
        _n_seen:      Count of ticks scored so far (for warm-up detection).
    """

    def __init__(
        self,
        window_size: int = DEFAULT_WINDOW_SIZE,
        threshold: float = DEFAULT_THRESHOLD,
    ) -> None:
        """
        Initialise the z-score scorer.

        Args:
            window_size: Number of past ticks to include in rolling stats.
            threshold:   Z-score cutoff for anomaly classification.
        """
        self.window_size = window_size
        self.threshold = threshold
        # deque with maxlen automatically evicts the oldest value on overflow.
        self._window: deque[float] = deque(maxlen=window_size)
        self._n_seen: int = 0

    def _rolling_mean(self) -> float:
        """Compute mean of the current window. Returns 0.0 if window is empty."""
        return sum(self._window) / len(self._window) if self._window else 0.0

    def _rolling_std(self) -> float:
        """
        Compute sample standard deviation of the current window.

        Uses sample variance (N-1 denominator) to avoid underestimating
        dispersion on small windows.

        Floor: std is always at least 0.1% of the rolling mean (or 1.0 if mean
        is zero). This prevents z-score explosion when a coin trades at a
        perfectly constant price for a full window (common in test fixtures and
        during low-liquidity periods where CoinGecko rounds to identical cents).
        """
        n = len(self._window)
        if n < 2:
            return 1.0  # Neutral: z-score will be near 0 during very early warm-up
        mean = self._rolling_mean()
        variance = sum((x - mean) ** 2 for x in self._window) / (n - 1)
        std = math.sqrt(variance + VARIANCE_EPSILON)
        # Apply a minimum std of 0.1% of mean to avoid division-by-near-zero
        # when all values in the window are effectively identical.
        min_std = abs(mean) * 0.001 if mean != 0.0 else 1.0
        return max(std, min_std)

    def score(self, price: float) -> tuple[float, bool]:
        """
        Score a single price tick and update rolling statistics.

        Statistics are updated AFTER computing the score to prevent the current
        observation from influencing its own anomaly decision (look-ahead bias).

        During warm-up (fewer ticks than window_size), anomaly flags are
        suppressed regardless of z-score — stats are not yet representative.

        Args:
            price: Current price in USD.

        Returns:
            Tuple of (z_score: float, is_anomaly: bool).
        """
        # Compute score BEFORE updating window (avoids look-ahead bias)
        current_mean = self._rolling_mean()
        current_std = self._rolling_std()
        z_score = abs(price - current_mean) / current_std

        # Update window with current price
        self._window.append(price)
        self._n_seen += 1

        # Suppress anomaly flags during warm-up: insufficient data for reliable stats
        in_warmup = self._n_seen < self.window_size
        is_anomaly = (not in_warmup) and (z_score > self.threshold)

        if is_anomaly:
            logger.debug(
                "Z-score anomaly detected",
                extra={"z_score": round(z_score, 4), "threshold": self.threshold},
            )

        return z_score, is_anomaly

    def update_threshold(self, threshold: float) -> None:
        """
        Update the anomaly detection threshold at runtime.

        Args:
            threshold: New z-score threshold. Typical range: 1.0–5.0.
        """
        logger.info(
            "Z-score threshold updated",
            extra={"old": self.threshold, "new": threshold},
        )
        self.threshold = threshold

    @property
    def is_warmed_up(self) -> bool:
        """Return True once enough ticks have been seen to produce reliable scores."""
        return self._n_seen >= self.window_size
