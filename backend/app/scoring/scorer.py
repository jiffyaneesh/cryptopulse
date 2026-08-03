"""
scoring/scorer.py
─────────────────
Abstract base class and registry for streaming anomaly scorers.

Defines the contract (BaseScorer ABC) that all scorer implementations must
satisfy, enabling them to be used interchangeably (Liskov Substitution Principle).

The ScorerRegistry maintains one scorer instance per tracked coin. This is
necessary because each coin has independent price dynamics — a scorer trained
on BTC data should not be used to score ETH ticks.

The ScoringWorker consumes PriceTicks from one asyncio.Queue, scores them via
the registry, and pushes ScoredTick objects onto an output queue for broadcast.

Responsibilities:
  - Define BaseScorer ABC (contract for all scorers).
  - Manage per-coin scorer instances via ScorerRegistry.
  - Run the scoring consumer loop via ScoringWorker.

NOT responsible for:
  - Implementing specific scoring algorithms (see zscore.py, halftrees.py).
  - Fetching price data (see ingestion/poller.py).
  - Broadcasting scored ticks (see api/websocket.py).
"""

from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from datetime import datetime, timezone

from app.ingestion.models import PriceTick, ScoredTick

logger = logging.getLogger(__name__)

# Sentinel pushed onto a queue to signal "no more items, exit cleanly".
# Used instead of polling with asyncio.wait_for(queue.get(), timeout=...):
# a timed-out get() is cancelled, and if an item arrived in the same tick of
# the event loop it is consumed by the cancelled future and lost.
SHUTDOWN_SENTINEL = object()


class BaseScorer(ABC):
    """
    Abstract base class for all streaming anomaly scorers.

    Defines the interface that ZScoreScorer and HalfSpaceTreesScorer
    both implement, making them interchangeable (Liskov Substitution Principle).

    New scorer implementations MUST extend this class. Existing callers
    (ScorerRegistry, ScoringWorker) require no modification (Open/Closed Principle).
    """

    @abstractmethod
    def score(self, features: dict[str, float]) -> tuple[float, bool]:
        """
        Score a single price observation.

        Implementations must update internal model state AFTER computing
        the score to avoid look-ahead bias.

        Args:
            features: Dictionary of stationary features (ret, vol, z_ret, vol_delta).

        Returns:
            Tuple of (anomaly_score: float, is_anomaly: bool).
            anomaly_score semantics differ by implementation:
              - ZScoreScorer: raw absolute z-score (unbounded, ≥ 0)
              - HalfSpaceTreesScorer: normalised score ∈ [0, 1]
        """
        ...

    @abstractmethod
    def update_threshold(self, threshold: float) -> None:
        """
        Update the anomaly detection threshold at runtime.

        Called when the user adjusts the sensitivity slider via the config API.
        Must not reset or invalidate accumulated model state.

        Args:
            threshold: New threshold value. Semantics differ by scorer type.
        """
        ...


class ScorerRegistry:
    """
    Registry that manages one scorer instance per tracked coin.

    Maintains a dict[coin_id → BaseScorer] and creates new scorer instances
    on demand (lazy initialisation). All coin scorers share the same model_type
    and threshold, but maintain completely independent model state.

    Attributes:
        _scorers:    Dict mapping coin_id to its BaseScorer instance.
        _model_type: Currently active model type ("zscore" or "halftrees").
        _threshold:  Currently active threshold for all coin scorers.
    """

    def __init__(self, model_type: str, threshold: float) -> None:
        """
        Initialise the registry.

        Args:
            model_type: Initial model type ("zscore" or "halftrees").
            threshold:  Initial anomaly threshold.
        """
        self._scorers: dict[str, BaseScorer] = {}
        self._model_type = model_type
        self._threshold = threshold

    def get_or_create(self, coin_id: str) -> BaseScorer:
        """
        Return the scorer for coin_id, creating it if it doesn't exist yet.

        Lazy initialisation: a coin's scorer is created on its first tick,
        not at startup. This allows the tracked coin list to change at runtime.

        Args:
            coin_id: CoinGecko coin identifier.

        Returns:
            BaseScorer: The scorer instance for this coin.
        """
        if coin_id not in self._scorers:
            self._scorers[coin_id] = self._create_scorer()
            logger.info(
                "Created new scorer", extra={"coin_id": coin_id, "model": self._model_type}
            )
        return self._scorers[coin_id]

    def update_all_thresholds(self, threshold: float) -> None:
        """
        Update the threshold on all existing coin scorers.

        Called by the config API when the user adjusts the sensitivity slider.
        Existing accumulated model state (rolling stats, HST trees) is preserved.

        Args:
            threshold: New threshold value for all scorers.
        """
        self._threshold = threshold
        for coin_id, scorer in self._scorers.items():
            scorer.update_threshold(threshold)
            logger.debug("Threshold updated", extra={"coin_id": coin_id, "threshold": threshold})

    def reset(self, model_type: str, threshold: float) -> None:
        """
        Discard all existing scorers and reinitialise with a new model type.

        Called when the user switches between "zscore" and "halftrees" via
        the config API. Resetting clears all accumulated model state — the
        warm-up period begins again.

        Args:
            model_type: New model type ("zscore" or "halftrees").
            threshold:  New threshold value.
        """
        self._model_type = model_type
        self._threshold = threshold
        self._scorers.clear()
        logger.info("Scorer registry reset", extra={"model": model_type, "threshold": threshold})

    def _create_scorer(self) -> BaseScorer:
        """
        Instantiate a new scorer of the configured type.

        Returns:
            BaseScorer: A fresh scorer instance with the current threshold.
        """
        # Import here to avoid circular imports between scorer.py and its implementations.
        if self._model_type == "halftrees":
            from app.scoring.halftrees import HalfSpaceTreesScorer
            return HalfSpaceTreesScorer(threshold=self._threshold)
        else:
            from app.scoring.zscore import ZScoreScorer
            return ZScoreScorer(threshold=self._threshold)

    @property
    def model_type(self) -> str:
        """Return the currently active model type."""
        return self._model_type

    @property
    def threshold(self) -> float:
        """Return the currently active threshold."""
        return self._threshold

    @property
    def coin_count(self) -> int:
        """Return the number of coin scorers currently initialised."""
        return len(self._scorers)


class ScoringWorker:
    """
    Async consumer that scores PriceTicks from an input queue.

    Runs as a background asyncio.Task. Pulls PriceTick objects from
    in_queue, scores each via the ScorerRegistry, and pushes ScoredTick
    objects onto out_queue for WebSocket broadcasting and DB persistence.

    Attributes:
        _in_queue:  Source queue of raw PriceTick objects (from poller).
        _out_queue: Destination queue of ScoredTick objects (to broadcaster/DB).
        _registry:  ScorerRegistry providing per-coin scorers.
        _running:   Set to False to stop the consumer loop.
    """

    def __init__(
        self,
        in_queue: asyncio.Queue,
        out_queue: asyncio.Queue,
        registry: ScorerRegistry,
    ) -> None:
        """
        Initialise the scoring worker.

        Args:
            in_queue:  Queue to consume PriceTick objects from.
            out_queue: Queue to push ScoredTick objects onto.
            registry:  ScorerRegistry for per-coin scorer dispatch.
        """
        self._in_queue = in_queue
        self._out_queue = out_queue
        self._registry = registry
        self._running = False
        self._ticks_processed: int = 0
        self._started_at: datetime = datetime.now(timezone.utc)
        self._extractors: dict[str, FeatureExtractor] = {}

    async def start(self) -> None:
        """
        Run the scoring consumer loop until the shutdown sentinel is received.

        Pulls PriceTicks from in_queue, scores them via the registry,
        and pushes ScoredTick objects to out_queue. Errors on individual
        ticks are logged and skipped — the loop never halts.
        """
        self._running = True
        self._started_at = datetime.now(timezone.utc)
        logger.info("ScoringWorker started")

        while True:
            # Plain get() — blocks indefinitely until an item is available.
            # stop() enqueues SHUTDOWN_SENTINEL to break out, so no polling
            # timeout is needed and no tick can be lost to a cancelled get().
            item = await self._in_queue.get()

            if item is SHUTDOWN_SENTINEL:
                self._in_queue.task_done()
                # Propagate shutdown downstream so broadcast_loop drains and
                # exits too, rather than being hard-cancelled mid-write.
                await self._out_queue.put(SHUTDOWN_SENTINEL)
                logger.info("ScoringWorker received shutdown sentinel")
                break

            tick: PriceTick = item

            try:
                scored = self._score_tick(tick)
                await self._out_queue.put(scored)
                self._ticks_processed += 1
            except Exception as exc:
                logger.error(
                    "Failed to score tick",
                    extra={"coin_id": tick.coin_id, "error": str(exc)},
                )
            finally:
                self._in_queue.task_done()

    async def stop(self) -> None:
        """
        Signal the scoring loop to drain and exit.

        Enqueues SHUTDOWN_SENTINEL rather than flipping a flag, so any ticks
        already queued ahead of it are scored before the loop exits.
        """
        self._running = False
        await self._in_queue.put(SHUTDOWN_SENTINEL)
        logger.info("ScoringWorker stop requested")

    def _score_tick(self, tick: PriceTick) -> ScoredTick:
        """
        Score a single PriceTick using the coin's scorer.

        Retrieves (or lazily creates) the scorer for this coin and calls
        score() with the tick's extracted features. Wraps the result in a ScoredTick.

        Args:
            tick: Raw price tick from the ingestion worker.

        Returns:
            ScoredTick: Tick enriched with anomaly score and classification. During warmup, returns score 0.
        """
        from app.scoring.features import FeatureExtractor
        if tick.coin_id not in self._extractors:
            self._extractors[tick.coin_id] = FeatureExtractor()
        
        extractor = self._extractors[tick.coin_id]
        features = extractor.extract(tick.price_usd, tick.volume_24h)
        
        if features is None:
            logger.debug("Skipping scoring during feature warmup", extra={"coin_id": tick.coin_id})
            anomaly_score, is_anomaly = 0.0, False
        else:
            scorer = self._registry.get_or_create(tick.coin_id)
            anomaly_score, is_anomaly = scorer.score(features)

        return ScoredTick(
            tick=tick,
            anomaly_score=anomaly_score,
            is_anomaly=is_anomaly,
            model_type=self._registry.model_type,
            threshold=self._registry.threshold,
        )

    @property
    def uptime_seconds(self) -> float:
        """Return the number of seconds the worker has been running."""
        return (datetime.now(timezone.utc) - self._started_at).total_seconds()

    @property
    def ticks_processed(self) -> int:
        """Return the total number of ticks scored since startup."""
        return self._ticks_processed
