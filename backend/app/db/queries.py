"""
db/queries.py
─────────────
SQL query functions for the CryptoPulse tick database.

All functions accept an aiosqlite.Connection and return Python-native types
(dicts, lists). They are pure I/O functions with no business logic — the
single responsibility is translating between Python objects and SQL rows.

Parameterised queries (using ? placeholders) are used throughout to prevent
SQL injection.

Responsibilities:
  - Insert ScoredTick objects into the ticks table.
  - Query tick history with pagination.
  - Compute stats (anomaly counts, throughput) for the stats endpoint.

NOT responsible for:
  - Database connection management (see db/database.py).
  - Business logic or formatting (see api/stats.py).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import aiosqlite

from app.ingestion.models import ScoredTick

logger = logging.getLogger(__name__)


async def insert_tick(conn: aiosqlite.Connection, scored_tick: ScoredTick) -> None:
    """
    Persist a ScoredTick to the ticks table.

    Uses a single-row INSERT. For the write rate of this application
    (≤ 1 tick/10s per coin × 8 coins = ≤ 0.8 inserts/second), single-row
    inserts are entirely sufficient. Batch inserts would only be needed
    at > 1000 inserts/second.

    Args:
        conn:        Active aiosqlite database connection.
        scored_tick: The scored tick to persist.
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
        (
            tick.coin_id,
            tick.symbol,
            tick.name,
            tick.price_usd,
            tick.market_cap,
            tick.volume_24h,
            tick.price_change_24h,
            scored_tick.anomaly_score,
            1 if scored_tick.is_anomaly else 0,  # SQLite has no BOOLEAN
            scored_tick.model_type,
            scored_tick.threshold,
            tick.polled_at.isoformat(),
            scored_tick.scored_at.isoformat(),
        ),
    )
    await conn.commit()


async def get_history(
    conn: aiosqlite.Connection,
    coin_id: str,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    """
    Retrieve paginated tick history for a specific coin.

    Results are ordered newest-first (DESC polled_at) so the frontend
    receives the most recent ticks immediately.

    Args:
        conn:    Active aiosqlite database connection.
        coin_id: CoinGecko coin identifier to filter by.
        limit:   Maximum number of rows to return (default 200).
        offset:  Number of rows to skip for pagination (default 0).

    Returns:
        List of dicts, each representing one tick row.
        is_anomaly is converted from INTEGER (0/1) to bool.
    """
    async with conn.execute(
        """
        SELECT coin_id, symbol, name, price_usd, market_cap, volume_24h,
               price_change_24h, anomaly_score, is_anomaly, model_type,
               threshold, polled_at, scored_at
        FROM ticks
        WHERE coin_id = ?
        ORDER BY polled_at DESC
        LIMIT ? OFFSET ?
        """,
        (coin_id, limit, offset),
    ) as cursor:
        rows = await cursor.fetchall()

    return [
        {
            **dict(row),
            "is_anomaly": bool(row["is_anomaly"]),  # Convert INTEGER back to bool
        }
        for row in rows
    ]


async def get_anomaly_count_today(
    conn: aiosqlite.Connection,
    start_of_day: str,
) -> int:
    """
    Count anomalous ticks recorded since the start of today (UTC).

    Args:
        conn:         Active aiosqlite database connection.
        start_of_day: ISO 8601 string for the start of today in UTC.
                      Example: "2026-07-26T00:00:00+00:00"

    Returns:
        int: Number of ticks flagged as anomalous today.
    """
    async with conn.execute(
        "SELECT COUNT(*) FROM ticks WHERE is_anomaly = 1 AND polled_at >= ?",
        (start_of_day,),
    ) as cursor:
        row = await cursor.fetchone()
    return row[0] if row else 0


async def get_total_count_today(
    conn: aiosqlite.Connection,
    start_of_day: str,
) -> int:
    """
    Count all ticks recorded since the start of today (UTC).

    Args:
        conn:         Active aiosqlite database connection.
        start_of_day: ISO 8601 UTC string for the start of today.

    Returns:
        int: Total number of ticks received today.
    """
    async with conn.execute(
        "SELECT COUNT(*) FROM ticks WHERE polled_at >= ?",
        (start_of_day,),
    ) as cursor:
        row = await cursor.fetchone()
    return row[0] if row else 0


async def get_throughput_per_minute(
    conn: aiosqlite.Connection,
    last_n_minutes: int = 5,
) -> float:
    """
    Compute the average throughput (ticks/minute) over the last N minutes.

    Used by the stats endpoint to display the real-time throughput.

    Args:
        conn:           Active aiosqlite database connection.
        last_n_minutes: Lookback window in minutes (default 5).

    Returns:
        float: Average ticks per minute over the lookback window.
               Returns 0.0 if no ticks exist in the window.
    """
    # SQLite datetime arithmetic: subtract N minutes from current UTC time.
    # strftime('%Y-%m-%dT%H:%M:%S', 'now', '-N minutes') produces an ISO string.
    window_minutes = str(last_n_minutes)
    async with conn.execute(
        f"""
        SELECT COUNT(*) FROM ticks
        WHERE polled_at >= strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now', '-{window_minutes} minutes')
        """,
    ) as cursor:
        row = await cursor.fetchone()

    tick_count = row[0] if row else 0
    return tick_count / last_n_minutes if last_n_minutes > 0 else 0.0


async def get_anomaly_counts_by_coin(
    conn: aiosqlite.Connection,
    start_of_day: str,
) -> dict[str, int]:
    """
    Return anomaly counts grouped by coin for today.

    Used by the frontend coin selector to display per-coin anomaly badges.

    Args:
        conn:         Active aiosqlite database connection.
        start_of_day: ISO 8601 UTC string for the start of today.

    Returns:
        Dict mapping coin_id → anomaly count today.
    """
    async with conn.execute(
        """
        SELECT coin_id, COUNT(*) as count
        FROM ticks
        WHERE is_anomaly = 1 AND polled_at >= ?
        GROUP BY coin_id
        """,
        (start_of_day,),
    ) as cursor:
        rows = await cursor.fetchall()

    return {row["coin_id"]: row["count"] for row in rows}
