"""
api/stats.py
────────────
REST endpoint for dashboard statistics.

Provides a GET /api/stats endpoint polled by the frontend every 5 seconds
to update the stats panel (anomaly count, throughput, model uptime, etc.).

Responsibilities:
  - Aggregate statistics from SQLite and app.state.
  - Format and return stats as a typed Pydantic response.

NOT responsible for:
  - Real-time tick streaming (see api/websocket.py).
  - Model scoring logic (see scoring/scorer.py).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.db import queries
from app.db.database import DatabaseConnectionAdapter, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["stats"])

# Module-level limiter — state is shared via app.state.limiter (see main.py).
limiter = Limiter(key_func=get_remote_address)


class StatsResponse(BaseModel):
    """Response model for the dashboard stats panel."""

    total_ticks_today: int
    anomalies_today: int
    anomaly_rate_pct: float
    throughput_per_minute: float
    model_uptime_seconds: float
    ws_client_count: int
    tracked_coins: list[str]
    current_model: str
    current_threshold: float
    anomalies_by_coin: dict[str, int]


@router.get("/stats", response_model=StatsResponse, summary="Get dashboard statistics")
@limiter.limit("30/minute")
async def get_stats(
    request: Request,
    db: DatabaseConnectionAdapter = Depends(get_db),
) -> StatsResponse:

    """
    Return aggregated statistics for the dashboard stats panel.

    Combines database query results with in-memory application state
    (scorer registry, WebSocket connection count, worker uptime).

    Args:
        request: FastAPI Request — used to access app.state for in-memory stats.
        db:      Injected database connection for SQLite queries.

    Returns:
        StatsResponse: All statistics needed by the frontend stats panel.
    """
    # Start of today in UTC — used to scope "today's" stats
    now_utc = datetime.now(timezone.utc)
    start_of_day = now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
    start_of_day_str = start_of_day.isoformat()

    # Run all four DB-derived stat queries concurrently.
    # Each query is an independent SELECT — there is no ordering dependency
    # between them. asyncio.gather() fires all four coroutines in the same
    # event-loop tick and awaits them together, cutting round-trip latency
    # from ~4× one query to ~1× the slowest query.
    total_today, anomalies_today, throughput, anomalies_by_coin = await asyncio.gather(
        queries.get_total_count_today(db, start_of_day_str),
        queries.get_anomaly_count_today(db, start_of_day_str),
        queries.get_throughput_per_minute(db, last_n_minutes=5),
        queries.get_anomaly_counts_by_coin(db, start_of_day_str),
    )

    # Pull in-memory state from app.state (set during lifespan startup)
    scoring_worker = request.app.state.scoring_worker
    scorer_registry = request.app.state.scorer_registry
    ws_manager = request.app.state.ws_manager
    settings = request.app.state.settings

    anomaly_rate = (anomalies_today / total_today * 100) if total_today > 0 else 0.0

    return StatsResponse(
        total_ticks_today=total_today,
        anomalies_today=anomalies_today,
        anomaly_rate_pct=round(anomaly_rate, 2),
        throughput_per_minute=round(throughput, 2),
        model_uptime_seconds=round(scoring_worker.uptime_seconds, 1),
        ws_client_count=ws_manager.client_count,
        tracked_coins=settings.coins_to_track,
        current_model=scorer_registry.model_type,
        current_threshold=scorer_registry.threshold,
        anomalies_by_coin=anomalies_by_coin,
    )
