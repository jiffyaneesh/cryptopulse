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
    Continuously consume ScoredTicks from the queue and broadcast them.

    This coroutine runs as a background task started at application startup.
    For each ScoredTick:
      1. Persist it to SQLite (for history/stats endpoints).
      2. Broadcast to all connected WebSocket clients.

    Args:
        scored_queue: asyncio.Queue containing ScoredTick objects from the scorer.
        db_conn:      Active aiosqlite database connection for persistence.
    """
    logger.info("Broadcast loop started")

    while True:
        try:
            scored_tick: ScoredTick = await asyncio.wait_for(
                scored_queue.get(), timeout=1.0
            )
        except asyncio.TimeoutError:
            continue

        try:
            # Persist before broadcasting so the history endpoint is always
            # consistent with what the dashboard has displayed.
            await queries.insert_tick(db_conn, scored_tick)

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
