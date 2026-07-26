"""
db/database.py
──────────────
SQLite database manager with WAL mode for the CryptoPulse backend.

Uses aiosqlite to provide a non-blocking async interface to SQLite, compatible
with FastAPI's async event loop. WAL (Write-Ahead Logging) mode is essential
here: it allows concurrent reads while a write is in progress — critical because
the scoring worker continuously inserts ticks while REST endpoints query history.

WAL mode trade-offs:
  - Readers never block writers; writers never block readers.
  - WAL file grows until checkpointed; we set a periodic PRAGMA checkpoint.
  - Single-writer lock still applies: only one write can happen at a time.
    At our write rate (≤ 6 inserts/min), this is never a bottleneck.

Responsibilities:
  - Open and configure the SQLite connection with WAL + busy_timeout.
  - Create the schema (ticks table + index) on first run.
  - Provide the database connection to FastAPI via dependency injection.
  - Close the connection cleanly on application shutdown.

NOT responsible for:
  - Specific SQL queries (see db/queries.py).
  - Application business logic.
"""

from __future__ import annotations

import logging
from pathlib import Path

import aiosqlite
from fastapi import Request

from app.config import get_settings

logger = logging.getLogger(__name__)

# DDL for the ticks table.
# Stores every scored tick permanently for the stats panel and history endpoint.
# is_anomaly stored as INTEGER (0/1) because SQLite has no native BOOLEAN type.
CREATE_TICKS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS ticks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_id       TEXT    NOT NULL,
    symbol        TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    price_usd     REAL    NOT NULL,
    market_cap    REAL    NOT NULL DEFAULT 0,
    volume_24h    REAL    NOT NULL DEFAULT 0,
    price_change_24h REAL NOT NULL DEFAULT 0,
    anomaly_score REAL    NOT NULL,
    is_anomaly    INTEGER NOT NULL DEFAULT 0,
    model_type    TEXT    NOT NULL,
    threshold     REAL    NOT NULL,
    polled_at     TEXT    NOT NULL,
    scored_at     TEXT    NOT NULL
);
"""

# Composite index on (coin_id, polled_at) supports the two most common query patterns:
#   1. History for a specific coin ordered by time: WHERE coin_id = ? ORDER BY polled_at DESC
#   2. Stats queries filtering by date range: WHERE polled_at >= ?
CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_ticks_coin_polled
ON ticks (coin_id, polled_at DESC);
"""


class DatabaseManager:
    """
    Manages the SQLite database connection lifecycle.

    Intended to be instantiated once at application startup (stored in
    app.state.db) and shared across all request handlers via FastAPI's
    dependency injection system.

    Attributes:
        _db_path: Absolute path to the SQLite database file.
        _conn:    The active aiosqlite connection, or None before connect().
    """

    def __init__(self) -> None:
        """Initialise with database path from settings."""
        settings = get_settings()
        self._db_path = Path(settings.database_url).resolve()
        self._conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        """
        Open the database connection and configure WAL mode.

        Creates the database file and parent directories if they don't exist.
        Applies WAL mode and performance PRAGMAs, then creates the schema
        if running for the first time.
        """
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        logger.info("Opening database", extra={"path": str(self._db_path)})

        self._conn = await aiosqlite.connect(self._db_path)
        self._conn.row_factory = aiosqlite.Row  # Return rows as dict-like objects

        # Enable WAL mode: readers never block writers.
        # This is the single most important PRAGMA for a continuously-writing app.
        await self._conn.execute("PRAGMA journal_mode=WAL;")

        # NORMAL sync mode: SQLite syncs WAL to disk at safe checkpoints, not on
        # every transaction. Slightly less durable than FULL, but acceptable for
        # our use case (we can replay missed ticks from CoinGecko on restart).
        await self._conn.execute("PRAGMA synchronous=NORMAL;")

        # Set busy timeout: if another writer holds the lock, wait up to 5s
        # before raising OperationalError. Prevents immediate lock errors under
        # brief concurrent write contention.
        await self._conn.execute("PRAGMA busy_timeout=5000;")

        await self._conn.commit()
        await self._create_schema()
        logger.info("Database ready")

    async def disconnect(self) -> None:
        """
        Close the database connection cleanly.

        Called during FastAPI lifespan shutdown. Runs a final WAL checkpoint
        to merge the WAL file back into the main database before closing.
        """
        if self._conn:
            # Passive checkpoint: flush completed WAL frames without blocking readers.
            await self._conn.execute("PRAGMA wal_checkpoint(PASSIVE);")
            await self._conn.commit()
            await self._conn.close()
            self._conn = None
            logger.info("Database connection closed")

    async def _create_schema(self) -> None:
        """Create database tables and indexes if they don't exist."""
        await self._conn.execute(CREATE_TICKS_TABLE_SQL)
        await self._conn.execute(CREATE_INDEX_SQL)
        await self._conn.commit()
        logger.debug("Schema verified/created")

    @property
    def conn(self) -> aiosqlite.Connection:
        """
        Return the active database connection.

        Raises:
            RuntimeError: If called before connect() or after disconnect().
        """
        if self._conn is None:
            raise RuntimeError("DatabaseManager.connect() must be called before accessing .conn")
        return self._conn


async def get_db(request: Request) -> aiosqlite.Connection:
    """
    FastAPI dependency that yields the active database connection.

    Usage in a router:
        @router.get("/history")
        async def get_history(db = Depends(get_db)):
            ...

    Args:
        request: FastAPI Request object (used to access app.state).

    Returns:
        aiosqlite.Connection: The active database connection.
    """
    return request.app.state.db.conn
