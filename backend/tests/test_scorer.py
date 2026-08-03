"""
tests/test_scorer.py
────────────────────
Unit tests for ZScoreScorer and HalfSpaceTreesScorer.

Uses deterministic synthetic price series so tests are reproducible
without any network or database dependencies.

Test strategy:
  - Test the scorer contract (correct return types, score range).
  - Test anomaly detection logic (spike flagged, normal price not flagged).
  - Test warm-up guard (no anomalies during warm-up period for z-score).
  - Test threshold update (threshold change takes effect on next tick).
"""

import pytest

from app.scoring.halftrees import HalfSpaceTreesScorer
from app.scoring.zscore import ZScoreScorer

def mk_features(val: float) -> dict[str, float]:
    return {"ret": val, "vol": 1.0, "z_ret": val, "vol_delta": 0.0}


# ── ZScoreScorer tests ───────────────────────────────────────────────────────

class TestZScoreScorer:
    """Unit tests for the rolling z-score anomaly scorer."""

    def test_score_returns_tuple_of_float_and_bool(self) -> None:
        """score() must return (float, bool) for any input."""
        scorer = ZScoreScorer(window_size=10, threshold=3.0)
        score, is_anomaly = scorer.score(mk_features(100.0))
        assert isinstance(score, float)
        assert isinstance(is_anomaly, bool)

    def test_no_anomaly_during_warmup(self) -> None:
        """Ticks during warm-up period must never be flagged as anomalies."""
        scorer = ZScoreScorer(window_size=20, threshold=1.0)
        # Feed 15 ticks — still in warm-up (window_size=20)
        for _ in range(15):
            _, is_anomaly = scorer.score(mk_features(100.0))
            assert is_anomaly is False, "Warm-up ticks should never be anomalies"

    def test_anomaly_detected_on_extreme_spike(self) -> None:
        """A price spike 10× the rolling mean must be flagged as anomalous."""
        scorer = ZScoreScorer(window_size=20, threshold=3.0)
        # Warm up with stable price
        for _ in range(25):
            scorer.score(mk_features(1000.0))
        # Submit an extreme spike
        _, is_anomaly = scorer.score(mk_features(100_000.0))
        assert is_anomaly is True

    def test_normal_price_not_flagged(self) -> None:
        """A price close to mean must NOT be flagged as anomaly."""
        import random
        random.seed(42)
        scorer = ZScoreScorer(window_size=20, threshold=3.0)
        # Warm up with prices that have realistic noise (~1% variation)
        # so the rolling std is non-zero and a small delta is truly "normal"
        base = 1000.0
        for i in range(30):
            price = base + random.uniform(-5.0, 5.0)  # ±0.5% noise
            scorer.score(mk_features(price))
        # Score a value within the noise range — should NOT be an anomaly
        _, is_anomaly = scorer.score(mk_features(base + 3.0))
        assert is_anomaly is False

    def test_threshold_update_takes_effect(self) -> None:
        """After lowering the threshold to 0.1, normal variation should trigger anomaly."""
        scorer = ZScoreScorer(window_size=20, threshold=3.0)
        for _ in range(25):
            scorer.score(mk_features(1000.0))
        # Normal price — not an anomaly at threshold=3.0
        _, before = scorer.score(mk_features(1010.0))
        # Lower threshold to near-zero — almost any deviation is anomalous
        scorer.update_threshold(0.001)
        _, after = scorer.score(mk_features(1010.0))
        assert after is True

    def test_is_warmed_up_flag(self) -> None:
        """is_warmed_up must be False before window_size ticks and True after."""
        scorer = ZScoreScorer(window_size=10, threshold=3.0)
        for i in range(10):
            assert scorer.is_warmed_up is False
            scorer.score(mk_features(100.0))
        assert scorer.is_warmed_up is True


# ── HalfSpaceTreesScorer tests ───────────────────────────────────────────────

class TestHalfSpaceTreesScorer:
    """Unit tests for the HalfSpaceTrees anomaly scorer."""

    def test_score_returns_tuple_of_float_and_bool(self) -> None:
        """score() must return (float, bool) for any input."""
        scorer = HalfSpaceTreesScorer(threshold=0.75)
        score, is_anomaly = scorer.score(mk_features(1000.0))
        assert isinstance(score, float)
        assert isinstance(is_anomaly, bool)

    def test_anomaly_score_in_unit_interval(self) -> None:
        """HalfSpaceTrees anomaly_score must always be in [0, 1]."""
        scorer = HalfSpaceTreesScorer(threshold=0.75)
        for price in [100.0, 200.0, 50000.0, 0.001]:
            score, _ = scorer.score(mk_features(price))
            assert 0.0 <= score <= 1.0, f"Score {score} out of [0, 1] for price {price}"

    def test_threshold_update_does_not_reset_model(self) -> None:
        """update_threshold() must change the threshold without resetting model state."""
        scorer = HalfSpaceTreesScorer(threshold=0.75)
        initial_n_seen = scorer._n_seen
        for _ in range(10):
            scorer.score(mk_features(1000.0))
        n_before = scorer._n_seen
        scorer.update_threshold(0.5)
        # _n_seen must be unchanged — model was not reset
        assert scorer._n_seen == n_before
        assert scorer.threshold == 0.5

    def test_warm_up_tracking(self) -> None:
        """is_warmed_up must be False before WINDOW_SIZE ticks."""
        scorer = HalfSpaceTreesScorer(threshold=0.75)
        assert scorer.is_warmed_up is False
