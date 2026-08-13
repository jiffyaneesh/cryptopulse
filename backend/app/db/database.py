"""
db/database.py
──────────────
Database manager supporting both SQLite (local development) and PostgreSQL (production).

Uses aiosqlite for SQLite and asyncpg for PostgreSQL, providing a unified async interface
to the backend.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import aiosqlite
import asyncpg
from fastapi import Request

from app.config import get_settings

logger = logging.getLogger(__name__)

# DDL for SQLite (is_anomaly stored as INTEGER 0/1)
CREATE_TICKS_TABLE_SQL_SQLITE = """
CREATE TABLE IF NOT EXISTS ticks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_id       TEXT    NOT NULL,
    symbol        TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    price_usd     REAL    NOT NULL,
    volume_24h    REAL    NOT NULL DEFAULT 0,
    price_change_24h REAL NOT NULL DEFAULT 0,
    high_price    REAL    NOT NULL DEFAULT 0,
    low_price     REAL    NOT NULL DEFAULT 0,
    bid_price     REAL    NOT NULL DEFAULT 0,
    ask_price     REAL    NOT NULL DEFAULT 0,
    anomaly_score REAL    NOT NULL,
    is_anomaly    INTEGER NOT NULL DEFAULT 0,
    model_type    TEXT    NOT NULL,
    threshold     REAL    NOT NULL,
    polled_at     TEXT    NOT NULL,
    scored_at     TEXT    NOT NULL
);
"""

# DDL for PostgreSQL (using serial and double precision)
CREATE_TICKS_TABLE_SQL_POSTGRES = """
CREATE TABLE IF NOT EXISTS ticks (
    id            SERIAL PRIMARY KEY,
    coin_id       TEXT    NOT NULL,
    symbol        TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    price_usd     DOUBLE PRECISION NOT NULL,
    volume_24h    DOUBLE PRECISION NOT NULL DEFAULT 0,
    price_change_24h DOUBLE PRECISION NOT NULL DEFAULT 0,
    high_price    DOUBLE PRECISION NOT NULL DEFAULT 0,
    low_price     DOUBLE PRECISION NOT NULL DEFAULT 0,
    bid_price     DOUBLE PRECISION NOT NULL DEFAULT 0,
    ask_price     DOUBLE PRECISION NOT NULL DEFAULT 0,
    anomaly_score DOUBLE PRECISION NOT NULL,
    is_anomaly    INTEGER NOT NULL DEFAULT 0,
    model_type    TEXT    NOT NULL,
    threshold     DOUBLE PRECISION NOT NULL,
    polled_at     TEXT    NOT NULL,
    scored_at     TEXT    NOT NULL
);
"""

# Composite index on (coin_id, polled_at) supports the most common query pattern:
# get_history WHERE coin_id = ? ORDER BY polled_at ASC/DESC LIMIT ?
CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_ticks_coin_polled
ON ticks (coin_id, polled_at DESC);
"""

# Partial-style composite index to accelerate anomaly-count queries.
# get_anomaly_count_today and get_anomaly_counts_by_coin both filter on
# is_anomaly = 1 AND polled_at >= ?. Without this index, SQLite scans the
# full coin_id/polled_at index and then applies the is_anomaly filter.
# With (is_anomaly, polled_at) the anomaly-only rows are clustered together
# so the count queries touch far fewer pages.
CREATE_ANOMALY_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_ticks_anomaly_polled
ON ticks (is_anomaly, polled_at DESC);
"""

# ── Live migration: add new columns to existing databases ────────────────────
# SQLite's ALTER TABLE ADD COLUMN is safe to run on an already-migrated DB
# (it's idempotent when the column already exists only in SQLite ≥ 3.37.0
# which supports IF NOT EXISTS on ALTER TABLE). For older SQLite we catch
# the OperationalError that fires when the column already exists.
MIGRATE_ADD_PRICE_COLUMNS_SQLITE: list[str] = [
    "ALTER TABLE ticks ADD COLUMN high_price REAL NOT NULL DEFAULT 0",
    "ALTER TABLE ticks ADD COLUMN low_price  REAL NOT NULL DEFAULT 0",
    "ALTER TABLE ticks ADD COLUMN bid_price  REAL NOT NULL DEFAULT 0",
    "ALTER TABLE ticks ADD COLUMN ask_price  REAL NOT NULL DEFAULT 0",
]

MIGRATE_ADD_PRICE_COLUMNS_POSTGRES: list[str] = [
    "ALTER TABLE ticks ADD COLUMN IF NOT EXISTS high_price DOUBLE PRECISION NOT NULL DEFAULT 0",
    "ALTER TABLE ticks ADD COLUMN IF NOT EXISTS low_price  DOUBLE PRECISION NOT NULL DEFAULT 0",
    "ALTER TABLE ticks ADD COLUMN IF NOT EXISTS bid_price  DOUBLE PRECISION NOT NULL DEFAULT 0",
    "ALTER TABLE ticks ADD COLUMN IF NOT EXISTS ask_price  DOUBLE PRECISION NOT NULL DEFAULT 0",
]


class DatabaseConnectionAdapter:
    """
    Unified database connection adapter for SQLite and PostgreSQL.
    Translates standard positional parameters (using ?) to PostgreSQL ($1, $2, ...)
    and executes statements/queries on the appropriate driver.
    """

    def __init__(self, is_postgres: bool, connection_or_pool: Any) -> None:
        self.is_postgres = is_postgres
        self.raw_conn = connection_or_pool

    async def execute(self, query: str, *args: Any) -> None:
        """Execute a statement (like INSERT or CREATE TABLE)."""
        if self.is_postgres:
            query = self._convert_query(query)
            # raw_conn can be a pool; pool.execute executes on an acquired connection
            await self.raw_conn.execute(query, *args)
        else:
            await self.raw_conn.execute(query, args)

    async def fetchall(self, query: str, *args: Any) -> list[dict]:
        """Fetch all rows for a query, returned as a list of dicts."""
        if self.is_postgres:
            query = self._convert_query(query)
            rows = await self.raw_conn.fetch(query, *args)
            return [dict(row) for row in rows]
        else:
            async with self.raw_conn.execute(query, args) as cursor:
                rows = await cursor.fetchall()
                return [dict(row) for row in rows]

    async def fetchone(self, query: str, *args: Any) -> dict | None:
        """Fetch a single row for a query, returned as a dict or None."""
        if self.is_postgres:
            query = self._convert_query(query)
            row = await self.raw_conn.fetchrow(query, *args)
            return dict(row) if row else None
        else:
            async with self.raw_conn.execute(query, args) as cursor:
                row = await cursor.fetchone()
                return dict(row) if row else None

    async def commit(self) -> None:
        """Commit transactions. No-op for PostgreSQL since asyncpg handles auto-commit."""
        if not self.is_postgres:
            await self.raw_conn.commit()

    def _convert_query(self, query: str) -> str:
        """Convert '?' style placeholders to '$1, $2, ...' style placeholders for PostgreSQL."""
        parts = query.split("?")
        if len(parts) == 1:
            return query
        new_query = []
        for i, part in enumerate(parts[:-1]):
            new_query.append(part)
            new_query.append(f"${i+1}")
        new_query.append(parts[-1])
        return "".join(new_query)


class DatabaseManager:
    """
    Manages the database connection lifecycle, supporting SQLite and PostgreSQL.
    """

    def __init__(self) -> None:
        """Initialise database connection info from settings."""
        settings = get_settings()
        self._db_url = settings.database_url
        self._is_postgres = self._db_url.startswith("postgresql://") or self._db_url.startswith("postgres://")
        self._conn: aiosqlite.Connection | None = None
        self._pool: asyncpg.Pool | None = None
        self._adapter: DatabaseConnectionAdapter | None = None

        if not self._is_postgres:
            self._db_path = Path(self._db_url).resolve()

    async def connect(self) -> None:
        """Open the database connection or pool and create schemas."""
        if self._is_postgres:
            logger.info("Opening PostgreSQL connection pool")
            self._pool = await asyncpg.create_pool(self._db_url)
            self._adapter = DatabaseConnectionAdapter(is_postgres=True, connection_or_pool=self._pool)
        else:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
            logger.info("Opening SQLite database", extra={"path": str(self._db_path)})
            self._conn = await aiosqlite.connect(self._db_path)
            self._conn.row_factory = aiosqlite.Row

            # Enable WAL mode for SQLite performance
            await self._conn.execute("PRAGMA journal_mode=WAL;")
            await self._conn.execute("PRAGMA synchronous=NORMAL;")
            await self._conn.execute("PRAGMA busy_timeout=5000;")
            await self._conn.commit()

            self._adapter = DatabaseConnectionAdapter(is_postgres=False, connection_or_pool=self._conn)

        await self._create_schema()
        logger.info("Database ready")

    async def disconnect(self) -> None:
        """Close connections cleanly on shutdown."""
        if self._is_postgres:
            if self._pool:
                await self._pool.close()
                self._pool = None
                logger.info("PostgreSQL connection pool closed")
        else:
            if self._conn:
                await self._conn.execute("PRAGMA wal_checkpoint(PASSIVE);")
                await self._conn.commit()
                await self._conn.close()
                self._conn = None
                logger.info("SQLite database connection closed")
        self._adapter = None

    async def _create_schema(self) -> None:
        """Verify and create schemas, then apply any pending migrations."""
        if self._adapter is None:
            raise RuntimeError("Database not connected")

        table_sql = CREATE_TICKS_TABLE_SQL_POSTGRES if self._is_postgres else CREATE_TICKS_TABLE_SQL_SQLITE
        await self._adapter.execute(table_sql)
        await self._adapter.execute(CREATE_INDEX_SQL)
        await self._adapter.execute(CREATE_ANOMALY_INDEX_SQL)

        # ── Live migration: add high/low/bid/ask columns ──────────────────────
        # For databases that existed before these columns were added.
        # PostgreSQL uses IF NOT EXISTS natively; SQLite doesn't, so we catch
        # OperationalError("duplicate column name") and ignore it — that means
        # the column is already there from a previous run.
        migrate_stmts = (
            MIGRATE_ADD_PRICE_COLUMNS_POSTGRES
            if self._is_postgres
            else MIGRATE_ADD_PRICE_COLUMNS_SQLITE
        )
        for stmt in migrate_stmts:
            try:
                await self._adapter.execute(stmt)
            except Exception as exc:
                # "duplicate column name" is the expected error on SQLite when the
                # column already exists. Log at DEBUG so it doesn't alarm operators
                # on every restart.
                if "duplicate column" in str(exc).lower():
                    logger.debug("Migration column already exists (skipping): %s", stmt.strip())
                else:
                    raise

        await self._adapter.commit()
        logger.debug("Schema verified/created")

    @property
    def conn(self) -> DatabaseConnectionAdapter:
        """Return the database adapter."""
        if self._adapter is None:
            raise RuntimeError("DatabaseManager.connect() must be called before accessing .conn")
        return self._adapter


async def get_db(request: Request) -> DatabaseConnectionAdapter:
    """FastAPI dependency yielding the active database adapter."""
    return request.app.state.db.conn
