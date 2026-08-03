"""
main.py
───────
FastAPI application entry point for the CryptoPulse backend.

Wires together all application components via the FastAPI lifespan context
manager. Business logic is intentionally absent here — main.py only:
  1. Creates and configures the FastAPI app.
  2. Registers startup/shutdown lifecycle hooks.
  3. Includes API routers.
  4. Stores shared state in app.state for dependency injection.

Components started on startup:
  - DatabaseManager: opens SQLite connection, applies WAL pragma, creates schema.
  - CoinGeckoPoller: starts async per-coin polling tasks.
  - ScorerRegistry: lazy per-coin scorer factory.
  - ScoringWorker: consumes raw ticks → produces scored ticks.
  - broadcast_loop task: consumes scored ticks → persists + broadcasts to WS.

Architecture note — two asyncio.Queues:
  raw_queue:    Poller → ScoringWorker  (PriceTick objects)
  scored_queue: ScoringWorker → broadcast_loop  (ScoredTick objects)

This decouples ingestion latency from scoring latency and scoring from I/O.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import config_api, history, stats
from app.api.websocket import broadcast_loop, manager, router as ws_router
from app.config import get_settings
from app.db.database import DatabaseManager
from app.ingestion.poller import CoinGeckoPoller
from app.scoring.scorer import ScorerRegistry, ScoringWorker

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Bounded queues prevent unbounded memory growth if the scorer or broadcaster
# can't keep up with the poller. If the queue fills (unlikely at our poll rate),
# new puts will block — a natural backpressure mechanism.
RAW_QUEUE_MAXSIZE: int = 100
SCORED_QUEUE_MAXSIZE: int = 100

# Max seconds to wait for the pipeline to drain on shutdown before cancelling.
# Cloud Run sends SIGKILL 10s after SIGTERM, so stay well under that.
SHUTDOWN_DRAIN_TIMEOUT_SECONDS: float = 5.0


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    FastAPI lifespan context manager: startup → yield → shutdown.

    Everything before yield runs on startup; everything after yield runs
    on shutdown (including graceful task cancellation).

    Args:
        app: The FastAPI application instance.

    Yields:
        None (control passed back to FastAPI for request handling).
    """
    settings = get_settings()
    logger.info("CryptoPulse backend starting up")

    # ── Initialise database ──────────────────────────────────────────────────
    db_manager = DatabaseManager()
    await db_manager.connect()

    # ── Set up async pipeline queues ─────────────────────────────────────────
    raw_queue: asyncio.Queue = asyncio.Queue(maxsize=RAW_QUEUE_MAXSIZE)
    scored_queue: asyncio.Queue = asyncio.Queue(maxsize=SCORED_QUEUE_MAXSIZE)

    # ── Initialise scorer registry ───────────────────────────────────────────
    scorer_registry = ScorerRegistry(
        model_type=settings.model_type,
        threshold=settings.default_threshold,
    )

    # ── Initialise and start scoring worker ──────────────────────────────────
    scoring_worker = ScoringWorker(
        in_queue=raw_queue,
        out_queue=scored_queue,
        registry=scorer_registry,
    )
    scoring_task = asyncio.create_task(
        scoring_worker.start(), name="scoring-worker"
    )

    # ── Start broadcast loop ─────────────────────────────────────────────────
    broadcast_task = asyncio.create_task(
        broadcast_loop(scored_queue, db_manager.conn),
        name="broadcast-loop",
    )

    # ── Start ingestion poller ───────────────────────────────────────────────
    poller = CoinGeckoPoller(queue=raw_queue)
    await poller.start()

    # ── Store shared state for dependency injection via app.state ────────────
    app.state.db = db_manager
    app.state.settings = settings
    app.state.scorer_registry = scorer_registry
    app.state.scoring_worker = scoring_worker
    app.state.ws_manager = manager

    logger.info(
        "Startup complete",
        extra={
            "model": settings.model_type,
            "coins": len(settings.coins_to_track),
            "threshold": settings.default_threshold,
        },
    )

    # ── Yield: FastAPI handles requests ──────────────────────────────────────
    yield

    # ── Shutdown (runs on SIGTERM or Ctrl+C) ─────────────────────────────────
    logger.info("CryptoPulse backend shutting down")

    # Stop ingestion first so no new ticks enter the pipeline.
    await poller.stop()

    # Then send the shutdown sentinel through the pipeline. The sentinel travels
    # raw_queue → ScoringWorker → scored_queue → broadcast_loop, so every tick
    # already in flight is scored and persisted before the tasks exit.
    await scoring_worker.stop()

    try:
        await asyncio.wait_for(
            asyncio.gather(scoring_task, broadcast_task),
            timeout=SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        # A stuck DB write or slow client must not block shutdown forever.
        logger.warning("Pipeline drain timed out, cancelling tasks")
        for task in [scoring_task, broadcast_task]:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    await db_manager.disconnect()
    logger.info("Shutdown complete")


def create_app() -> FastAPI:
    """
    Create and configure the FastAPI application.

    Returns:
        FastAPI: Configured application instance with middleware and routers.
    """
    settings = get_settings()

    app = FastAPI(
        title="CryptoPulse API",
        description=(
            "Real-time crypto price streaming and anomaly detection API. "
            "Connects to CoinGecko, scores ticks with online ML (river), "
            "and broadcasts results over WebSockets."
        ),
        version="0.3.0",
        lifespan=lifespan,
    )

    # CORS middleware: allow the Vite frontend (and any configured origins) to connect.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Include routers — each router owns its own URL prefix and tag
    app.include_router(ws_router)
    app.include_router(history.router)
    app.include_router(stats.router)
    app.include_router(config_api.router)

    @app.get("/health", tags=["health"])
    async def health_check() -> dict:
        """Simple health check endpoint for Docker Compose and load balancer probes."""
        return {"status": "ok", "version": "0.3.0"}

    return app


# Application instance — uvicorn loads this via `uvicorn app.main:app`
app = create_app()
