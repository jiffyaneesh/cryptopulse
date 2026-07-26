"""
db/queries.py
─────────────
SQL query functions for the CryptoPulse tick database.

All functions accept a DatabaseConnectionAdapter and return Python-native types
(dicts, lists). They are pure I/O functions with no business logic.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from app.ingestion.models import ScoredTick

if TYPE_CHECKING:
    from app.db.database import DatabaseConnectionAdapter

logger = logging.getLogger(__name__)


async def insert_tick(conn: DatabaseConnectionAdapter, scored_tick: ScoredTick) -> None:
    """
    Persist a ScoredTick to the ticks table.
    """
    tick = scored_tick.tick
    await conn.execute(
        """
        INSERT INTO ticks (
            coin_id, symbol, name, price_usd, market_cap, volume_24h,
            price_change_24h, anomaly_score, is_anomaly, model_type,
            threshold, polled_at, scored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        tick.coin_id,
        tick.symbol,
        tick.name,
        tick.price_usd,
        tick.market_cap,
        tick.volume_24h,
        tick.price_change_24h,
        scored_tick.anomaly_score,
        1 if scored_tick.is_anomaly else 0,
        scored_tick.model_type,
        scored_tick.threshold,
        tick.polled_at.isoformat(),
        scored_tick.scored_at.isoformat(),
    )
    await conn.commit()


async def get_history(
    conn: DatabaseConnectionAdapter,
    coin_id: str,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    """
    Retrieve paginated tick history for a specific coin.
    """
    rows = await conn.fetchall(
        """
        SELECT coin_id, symbol, name, price_usd, market_cap, volume_24h,
               price_change_24h, anomaly_score, is_anomaly, model_type,
               threshold, polled_at, scored_at
        FROM ticks
        WHERE coin_id = ?
        ORDER BY polled_at DESC
        LIMIT ? OFFSET ?
        """,
        coin_id,
        limit,
        offset,
    )

    return [
        {
            **row,
            "is_anomaly": bool(row["is_anomaly"]),
        }
        for row in rows
    ]


async def get_anomaly_count_today(
    conn: DatabaseConnectionAdapter,
    start_of_day: str,
) -> int:
    """
    Count anomalous ticks recorded since the start of today (UTC).
    """
    row = await conn.fetchone(
        "SELECT COUNT(*) as count FROM ticks WHERE is_anomaly = 1 AND polled_at >= ?",
        start_of_day,
    )
    return row["count"] if row else 0


async def get_total_count_today(
    conn: DatabaseConnectionAdapter,
    start_of_day: str,
) -> int:
    """
    Count all ticks recorded since the start of today (UTC).
    """
    row = await conn.fetchone(
        "SELECT COUNT(*) as count FROM ticks WHERE polled_at >= ?",
        start_of_day,
    )
    return row["count"] if row else 0


async def get_throughput_per_minute(
    conn: DatabaseConnectionAdapter,
    last_n_minutes: int = 5,
) -> float:
    """
    Compute the average throughput (ticks/minute) over the last N minutes.
    """
    # Compute lookback window in Python to ensure database compatibility (independent of strftime vs intervals)
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=last_n_minutes)).isoformat()

    row = await conn.fetchone(
        "SELECT COUNT(*) as count FROM ticks WHERE polled_at >= ?",
        cutoff,
    )

    tick_count = row["count"] if row else 0
    return tick_count / last_n_minutes if last_n_minutes > 0 else 0.0


async def get_anomaly_counts_by_coin(
    conn: DatabaseConnectionAdapter,
    start_of_day: str,
) -> dict[str, int]:
    """
    Return anomaly counts grouped by coin for today.
    """
    rows = await conn.fetchall(
        """
        SELECT coin_id, COUNT(*) as count
        FROM ticks
        WHERE is_anomaly = 1 AND polled_at >= ?
        GROUP BY coin_id
        """,
        start_of_day,
    )

    return {row["coin_id"]: row["count"] for row in rows}
