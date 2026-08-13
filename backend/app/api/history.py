"""
api/history.py
──────────────
REST endpoint for retrieving paginated tick history from SQLite.

Provides a GET /api/history endpoint that the frontend uses to populate
the chart with historical data when the dashboard first loads or when
the user switches to a different coin.

Responsibilities:
  - Define the /api/history router and response model.
  - Delegate all SQL to db/queries.py.
  - Validate and apply pagination parameters.

NOT responsible for:
  - Real-time tick streaming (see api/websocket.py).
  - Stats computation (see api/stats.py).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.db import queries
from app.db.database import DatabaseConnectionAdapter, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["history"])

# Module-level limiter used for the @limiter.limit decorator below.
# The actual state (counters) lives in app.state.limiter set up in main.py.
limiter = Limiter(key_func=get_remote_address)

# Maximum rows the client can request per call to prevent
# accidentally downloading the entire database.
MAX_LIMIT: int = 1000


class TickRecord(BaseModel):
    """
    Response model for a single tick history record.

    Maps 1:1 with the ticks table columns. Using a Pydantic model
    ensures FastAPI automatically validates and documents the response schema.
    """

    coin_id: str
    symbol: str
    name: str
    price_usd: float
    volume_24h: float
    price_change_24h: float
    anomaly_score: float
    is_anomaly: bool
    model_type: str
    threshold: float
    polled_at: str
    scored_at: str


class TickHistoryResponse(BaseModel):
    """Paginated response wrapper for tick history."""

    coin_id: str
    total_returned: int
    limit: int
    offset: int
    ticks: list[TickRecord]


@router.get("/history", response_model=TickHistoryResponse, summary="Get tick history")
@limiter.limit("30/minute")
async def get_history(
    request: Request,
    coin_id: str = Query(..., description="CoinGecko coin ID to retrieve history for."),
    limit: int = Query(default=200, ge=1, le=MAX_LIMIT, description="Max rows to return."),
    offset: int = Query(default=0, ge=0, description="Rows to skip for pagination."),
    db: DatabaseConnectionAdapter = Depends(get_db),
) -> TickHistoryResponse:

    """
    Return paginated tick history for a specific coin.

    Results are ordered newest-first. Use `offset` for pagination.
    The frontend calls this on initial load to pre-populate the chart
    before the WebSocket delivers live updates.

    Args:
        coin_id: CoinGecko identifier for the coin (e.g., "bitcoin").
        limit:   Maximum number of ticks to return (1–1000).
        offset:  Number of rows to skip (for pagination).
        db:      Injected database connection.

    Returns:
        TickHistoryResponse: Paginated tick records with metadata.
    """
    rows = await queries.get_history(conn=db, coin_id=coin_id, limit=limit, offset=offset)
    logger.debug(
        "History query executed",
        extra={"coin_id": coin_id, "rows_returned": len(rows)},
    )

    return TickHistoryResponse(
        coin_id=coin_id,
        total_returned=len(rows),
        limit=limit,
        offset=offset,
        ticks=[TickRecord(**row) for row in rows],
    )
