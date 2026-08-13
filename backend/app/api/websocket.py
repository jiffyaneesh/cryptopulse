"""
api/websocket.py
────────────────
WebSocket endpoint and connection manager for real-time tick broadcasting.

The ConnectionManager maintains a list of all active WebSocket connections.
When the scoring worker produces a ScoredTick, it is broadcast to every
connected client in JSON format.

Key safety detail — copy before iterating:
  When a client disconnects mid-broadcast, the WebSocket raises WebSocketDisconnect.
  If we iterate over the original active_connections list while removing from it,
  Python skips every other element in the list. We iterate over a COPY of the list
  and remove from the original — this is the correct pattern.

Responsibilities:
  - Accept incoming WebSocket connections on /ws/ticks.
  - Maintain the list of active connections.
  - Broadcast scored ticks to all connected clients.
  - Prune dead connections cleanly on disconnect.
  - Persist each scored tick to the database.

NOT responsible for:
  - Scoring logic (see scoring/scorer.py).
  - REST endpoint logic (see api/history.py, api/stats.py).
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db import queries
from app.ingestion.models import ScoredTick
from app.scoring.scorer import SHUTDOWN_SENTINEL

logger = logging.getLogger(__name__)

router = APIRouter()


class ConnectionManager:
    """
    Manages active WebSocket connections and broadcasts scored ticks.

    Thread-safety note: FastAPI runs on a single-threaded async event loop,
    so no locking is needed around the active_connections list, provided
    all access is from async context (which it always is here).

    Attributes:
        active_connections: List of currently connected WebSocket clients.
    """

    def __init__(self) -> None:
        """Initialise with an empty connection pool."""
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        """
        Accept a new WebSocket connection and register it.

        Args:
            websocket: The incoming WebSocket connection to accept.
        """
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(
            "WebSocket client connected",
            extra={"total_clients": len(self.active_connections)},
        )

    def disconnect(self, websocket: WebSocket) -> None:
        """
        Remove a WebSocket from the active connection pool.

        Called when a client explicitly disconnects or when a send fails.

        Args:
            websocket: The WebSocket to remove.
        """
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(
            "WebSocket client disconnected",
            extra={"total_clients": len(self.active_connections)},
        )

    async def broadcast(self, data: dict) -> None:
        """
        Send a JSON payload to all connected WebSocket clients.

        Iterates over a COPY of active_connections to safely remove dead
        sockets during iteration without skipping live clients.

        Args:
            data: JSON-serialisable dict to broadcast.
        """
        # Iterate over a snapshot copy: removing from the live list while iterating
        # would skip every other element due to index shifting.
        dead_sockets: list[WebSocket] = []

        for websocket in self.active_connections.copy():
            try:
                await websocket.send_json(data)
            except (WebSocketDisconnect, RuntimeError) as exc:
                # RuntimeError covers "Cannot send after connection is closed".
                # Mark as dead and remove after iteration completes.
                logger.debug(
                    "Dead socket detected during broadcast",
                    extra={"error": str(exc)},
                )
                dead_sockets.append(websocket)

        for dead in dead_sockets:
            self.disconnect(dead)

    @property
    def client_count(self) -> int:
        """Return the number of currently connected WebSocket clients."""
        return len(self.active_connections)


# Module-level singleton: one manager shared across all requests.
# FastAPI's async event loop is single-threaded, so this is safe.
manager = ConnectionManager()


async def broadcast_loop(scored_queue: asyncio.Queue, db_conn) -> None:
    """
    Continuously consume ScoredTicks from the queue, persist them to the DB
    in batches, and broadcast each one to connected WebSocket clients.

    This coroutine runs as a background task started at application startup.

    Batching strategy
    ─────────────────
    SQLite's WAL mode amortises fsync cost across transactions, but each
    individual commit still acquires the write lock and flushes WAL pages.
    At 8 coins × 6 polls/min = ~48 inserts/min we previously committed 48
    times/min. With batching we commit at most every COMMIT_INTERVAL_SECONDS
    seconds OR when COMMIT_BATCH_SIZE inserts accumulate — whichever comes
    first. This collapses the 48 commits/min to roughly 1 commit/5s.

    Broadcasting is NOT batched — each tick is sent to clients immediately
    so the dashboard stays real-time. Only the DB write is deferred.

    Args:
        scored_queue: asyncio.Queue containing ScoredTick objects.
        db_conn:      Active database connection adapter for persistence.
    """
    logger.info("Broadcast loop started")

    # ── Batch-commit configuration ────────────────────────────────────────────
    # Commit when either condition is met first: N inserts buffered, or T seconds elapsed.
    COMMIT_BATCH_SIZE: int = 20
    COMMIT_INTERVAL_SECONDS: float = 5.0

    pending_count: int = 0
    last_commit_time: float = asyncio.get_event_loop().time()

    while True:
        # Use wait_for with a timeout so we commit on time even when the queue
        # is quiet (e.g., all coins polled, but <COMMIT_BATCH_SIZE inserts so far).
        try:
            item = await asyncio.wait_for(
                scored_queue.get(),
                timeout=COMMIT_INTERVAL_SECONDS,
            )
        except asyncio.TimeoutError:
            # No new ticks for a full interval — flush any pending writes.
            if pending_count > 0:
                try:
                    await db_conn.commit()
                    logger.debug(
                        "Batch commit (timeout flush)",
                        extra={"pending_rows": pending_count},
                    )
                except Exception as exc:
                    logger.error("Batch commit failed (timeout)", extra={"error": str(exc)})
                finally:
                    pending_count = 0
                    last_commit_time = asyncio.get_event_loop().time()
            continue

        if item is SHUTDOWN_SENTINEL:
            scored_queue.task_done()
            # Flush any remaining inserts before exiting
            if pending_count > 0:
                try:
                    await db_conn.commit()
                    logger.info(
                        "Final batch commit on shutdown",
                        extra={"pending_rows": pending_count},
                    )
                except Exception as exc:
                    logger.error("Final batch commit failed", extra={"error": str(exc)})
            logger.info("Broadcast loop received shutdown sentinel")
            break

        scored_tick: ScoredTick = item

        try:
            # Insert WITHOUT committing — the commit is deferred to the batch flush below.
            await queries.insert_tick_no_commit(db_conn, scored_tick)
            pending_count += 1

            # Flush condition: either the batch is full or the time window has elapsed.
            now = asyncio.get_event_loop().time()
            time_since_commit = now - last_commit_time
            if pending_count >= COMMIT_BATCH_SIZE or time_since_commit >= COMMIT_INTERVAL_SECONDS:
                await db_conn.commit()
                logger.debug(
                    "Batch commit",
                    extra={
                        "pending_rows": pending_count,
                        "elapsed_s": round(time_since_commit, 2),
                    },
                )
                pending_count = 0
                last_commit_time = now

            # Broadcast immediately regardless of commit state — clients need
            # real-time data even if the DB write is still pending.
            if manager.client_count > 0:
                await manager.broadcast(scored_tick.to_dict())
                logger.debug(
                    "Tick broadcast",
                    extra={
                        "coin_id": scored_tick.tick.coin_id,
                        "is_anomaly": scored_tick.is_anomaly,
                        "clients": manager.client_count,
                    },
                )
        except Exception as exc:
            logger.error("Broadcast/persist error", extra={"error": str(exc)})
        finally:
            scored_queue.task_done()


@router.websocket("/ws/ticks")
async def websocket_ticks(websocket: WebSocket) -> None:
    """
    WebSocket endpoint that streams scored price ticks to connected clients.

    Clients connect here to receive real-time ScoredTick JSON frames.
    The actual data comes from the broadcast_loop background task — this
    endpoint only handles the connection lifecycle (connect → keep alive → disconnect).

    Args:
        websocket: The incoming WebSocket connection.
    """
    await manager.connect(websocket)
    try:
        # Keep the connection alive by waiting for client messages.
        # Clients don't send data in this protocol, but we need to await
        # something to detect disconnects. receive_text() blocks until
        # the client sends a message or disconnects.
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
