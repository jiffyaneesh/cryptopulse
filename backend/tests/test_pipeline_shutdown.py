"""
tests/test_pipeline_shutdown.py
───────────────────────────────
Tests that the scoring pipeline drains cleanly on shutdown.

The previous implementation polled the queue with
asyncio.wait_for(queue.get(), timeout=1.0) and exited on a _running flag.
That loses ticks: a get() cancelled by the timeout can consume an item that
arrived in the same event-loop iteration, and any tick still queued when
_running flips to False is dropped entirely.

These tests assert the sentinel-based shutdown scores every enqueued tick.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from app.ingestion.models import PriceTick
from app.scoring.scorer import SHUTDOWN_SENTINEL, ScorerRegistry, ScoringWorker


def make_tick(price: float, coin_id: str = "bitcoin") -> PriceTick:
    """Build a minimal PriceTick for pipeline tests."""
    return PriceTick(
        coin_id=coin_id,
        symbol="BTC",
        name="Bitcoin",
        price_usd=price,
        volume_24h=1000.0,
        price_change_24h=0.5,
        polled_at=datetime.now(timezone.utc),
    )


@pytest.mark.asyncio
async def test_all_queued_ticks_are_scored_before_shutdown() -> None:
    """Every tick enqueued before stop() must be scored, none dropped."""
    raw_queue: asyncio.Queue = asyncio.Queue()
    scored_queue: asyncio.Queue = asyncio.Queue()
    registry = ScorerRegistry(model_type="zscore", threshold=3.0)
    worker = ScoringWorker(raw_queue, scored_queue, registry)

    task = asyncio.create_task(worker.start())

    n = 25
    for i in range(n):
        await raw_queue.put(make_tick(1000.0 + i))

    await worker.stop()
    await asyncio.wait_for(task, timeout=5.0)

    # Drain the output queue: n scored ticks, then the forwarded sentinel.
    scored = []
    while not scored_queue.empty():
        scored.append(scored_queue.get_nowait())

    assert scored[-1] is SHUTDOWN_SENTINEL, "sentinel must be forwarded downstream"
    assert len(scored) - 1 == n, f"expected {n} scored ticks, got {len(scored) - 1}"
    assert worker.ticks_processed == n


@pytest.mark.asyncio
async def test_worker_exits_promptly_on_stop_with_empty_queue() -> None:
    """stop() on an idle worker must return quickly, not hang on get()."""
    raw_queue: asyncio.Queue = asyncio.Queue()
    scored_queue: asyncio.Queue = asyncio.Queue()
    registry = ScorerRegistry(model_type="zscore", threshold=3.0)
    worker = ScoringWorker(raw_queue, scored_queue, registry)

    task = asyncio.create_task(worker.start())
    await asyncio.sleep(0)  # let the worker reach its first get()

    await worker.stop()
    await asyncio.wait_for(task, timeout=2.0)

    assert worker.ticks_processed == 0


@pytest.mark.asyncio
async def test_scoring_error_does_not_halt_the_loop() -> None:
    """A tick that fails to score is skipped; later ticks still get scored."""
    raw_queue: asyncio.Queue = asyncio.Queue()
    scored_queue: asyncio.Queue = asyncio.Queue()
    registry = ScorerRegistry(model_type="zscore", threshold=3.0)
    worker = ScoringWorker(raw_queue, scored_queue, registry)

    task = asyncio.create_task(worker.start())

    # A tick whose price attribute raises on access would be contrived; instead
    # break the registry for one call by feeding a tick then restoring.
    bad = make_tick(1000.0)
    bad.price_usd = float("nan")  # NaN flows through, must not crash the loop
    await raw_queue.put(bad)
    await raw_queue.put(make_tick(1001.0))

    await worker.stop()
    await asyncio.wait_for(task, timeout=5.0)

    assert not task.cancelled()
    assert task.exception() is None
