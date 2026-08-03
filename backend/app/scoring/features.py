"""
scoring/features.py
───────────────────
Stationary feature extraction for streaming anomaly detection.

Raw price levels are non-stationary (they wander, trend, and hit new ATHs).
A model trained on raw prices will inevitably drift. This module converts
raw price/volume ticks into a strictly stationary feature representation
(log returns, rolling volatility, normalized returns, volume surprise).

These features are invariant to the absolute price level, allowing the
scorers to robustly identify anomalies regardless of macro market trends.

Responsibilities:
  - Extract strictly stationary features from raw price and volume ticks.
  - Maintain per-tick state (rolling windows, prev_price) required for computation.

NOT responsible for:
  - Scoring anomalies (see zscore.py, halftrees.py).
  - Managing per-coin model state (see scorer.py).
"""

from __future__ import annotations

import math
import logging
from collections import deque

logger = logging.getLogger(__name__)

# Constants
DEFAULT_WINDOW_SIZE: int = 30
VARIANCE_EPSILON: float = 1e-9


class FeatureExtractor:
    """
    Stateful stationary feature extractor for a single coin.

    Computes:
    - ret: log return
    - vol: rolling standard deviation of log returns
    - z_ret: vol-normalized return
    - vol_delta: log volume relative to rolling mean volume

    Attributes:
        window_size: Number of past ticks to include in rolling stats.
        _prev_price: Previous price tick value (used for log return).
        _returns_window: deque of recent log returns.
        _volume_window: deque of recent volumes.
    """

    def __init__(self, window_size: int = DEFAULT_WINDOW_SIZE) -> None:
        """
        Initialize the feature extractor.

        Args:
            window_size: The rolling window size for computing vol and vol_delta.
        """
        self.window_size = window_size
        self._prev_price: float | None = None
        self._returns_window: deque[float] = deque(maxlen=window_size)
        self._volume_window: deque[float] = deque(maxlen=window_size)

    def extract(self, price: float, volume: float) -> dict[str, float] | None:
        """
        Extract stationary features from a raw price and volume observation.

        Updates internal state and returns a dict of features. Returns None
        if the extractor is still warming up (needs at least window_size
        observations to compute valid rolling statistics).

        Args:
            price: Current price in USD.
            volume: Current 24h volume.

        Returns:
            Dict of features if warmed up, else None.
        """
        # 1. Log return (requires prev_price)
        if self._prev_price is None or self._prev_price <= 0 or price <= 0:
            self._prev_price = price
            self._volume_window.append(volume)
            return None
        
        ret = math.log(price / self._prev_price)
        self._prev_price = price
        
        # We add the return to window and volume to window
        self._returns_window.append(ret)
        self._volume_window.append(volume)

        # Check warmup
        if not self.is_warmed_up:
            return None

        # 2. Volatility (rolling std of returns)
        # Calculate sample std dev
        n_ret = len(self._returns_window)
        mean_ret = sum(self._returns_window) / n_ret
        variance_ret = sum((r - mean_ret) ** 2 for r in self._returns_window) / (n_ret - 1)
        vol = math.sqrt(variance_ret + VARIANCE_EPSILON)

        # 3. Z-return (vol-normalized return)
        z_ret = ret / vol

        # 4. Volume delta (log ratio of volume to rolling mean volume)
        mean_vol = sum(self._volume_window) / len(self._volume_window)
        # Protect against log(0)
        vol_delta = 0.0
        if volume > 0 and mean_vol > 0:
            vol_delta = math.log(volume / mean_vol)

        return {
            "ret": ret,
            "vol": vol,
            "z_ret": z_ret,
            "vol_delta": vol_delta
        }

    @property
    def is_warmed_up(self) -> bool:
        """Return True if enough ticks have been seen to compute rolling features."""
        return len(self._returns_window) == self.window_size and len(self._volume_window) == self.window_size
