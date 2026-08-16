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

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from starlette.types import ASGIApp

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

# ── Rate limiter ─────────────────────────────────────────────────────────────
# Uses the client IP address as the rate-limit key. SlowAPI is a thin wrapper
# around limits that integrates with FastAPI's dependency injection system.
# Limits are applied per-route via the @limiter.limit decorator.
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Middleware that injects OWASP-recommended security response headers on
    every HTTP response.

    Headers added
    ─────────────
    X-Content-Type-Options: nosniff
        Prevents browsers from MIME-sniffing a response away from the declared
        Content-Type, blocking drive-by MIME-type confusion attacks.

    X-Frame-Options: DENY
        Blocks this API from being embedded in an <iframe>, preventing
        clickjacking. Superseded by CSP frame-ancestors in modern browsers but
        kept for older UA compatibility.

    Content-Security-Policy
        Restricts which resources the browser may load. Because this is a
        pure JSON/WebSocket API (no HTML), the policy is maximally restrictive:
        default-src 'none' blocks everything except what is explicitly allowed.

    Referrer-Policy: no-referrer
        Prevents the full URL from leaking in the Referer header when the
        frontend links to external resources.

    Permissions-Policy
        Opts out of powerful browser APIs (camera, microphone, geolocation)
        that this service never uses.

    Strict-Transport-Security (HSTS)
        Tells browsers to only connect via HTTPS for the next year. Only
        effective when the service is served over TLS — harmless over HTTP.

    WebSocket responses (101 Upgrade) are passed through unchanged:
    security headers on upgrade responses are ignored by browsers and could
    confuse some proxy implementations.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        response: Response = await call_next(request)

        # Skip header injection for WebSocket upgrade responses
        if response.status_code == 101:
            return response

        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = (
            "camera=(), microphone=(), geolocation=()"
        )
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
        # If response is HTML or static asset, allow loading styles, fonts, and scripts
        if request.url.path.startswith("/api/") or request.url.path == "/health":
            response.headers["Content-Security-Policy"] = (
                "default-src 'none'; connect-src 'self'"
            )
        else:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                "font-src 'self' https://fonts.gstatic.com data:; "
                "connect-src 'self' ws: wss: http: https:;"
            )
        return response

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

    # ── Rate limiting middleware ──────────────────────────────────────────────
    # Attaches the limiter instance to app.state so SlowAPIMiddleware can find
    # it. The 429 handler returns a JSON body instead of the default plain text.
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.add_middleware(SlowAPIMiddleware)

    # ── Security response headers ─────────────────────────────────────────────
    # Injects OWASP-recommended headers (CSP, X-Frame-Options, HSTS, etc.)
    # on every response. WebSocket 101 upgrades are skipped.
    app.add_middleware(SecurityHeadersMiddleware)

    # ── CORS middleware ───────────────────────────────────────────────────────
    # Explicitly enumerate allowed methods and headers instead of using "*".
    # Wildcards bypass browser preflight protection for credentialed requests.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        # Only the HTTP methods actually used by the frontend
        allow_methods=["GET", "POST"],
        # Only the headers the frontend actually sends
        allow_headers=["Content-Type", "X-API-Key"],
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

    # ── Mount Frontend Static Build (SPA fallback) ───────────────────────────
    # Allows serving the React SPA directly from FastAPI if dist/ exists
    dist_path = Path(__file__).resolve().parent.parent.parent / "dist"
    if not dist_path.is_dir():
        dist_path = Path("/app/dist")

    if dist_path.is_dir():
        assets_path = dist_path / "assets"
        if assets_path.is_dir():
            app.mount("/assets", StaticFiles(directory=str(assets_path)), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def serve_spa(full_path: str):
            # Do not intercept API, WebSocket, or health endpoints
            if full_path.startswith("api/") or full_path.startswith("ws/") or full_path == "health":
                return JSONResponse(status_code=404, content={"detail": "Not Found"})
            file_path = dist_path / full_path
            if file_path.is_file():
                return FileResponse(file_path)
            index_file = dist_path / "index.html"
            if index_file.is_file():
                return FileResponse(index_file)
            return JSONResponse(status_code=404, content={"detail": "Not Found"})

    return app


# Application instance — uvicorn loads this via `uvicorn app.main:app`
app = create_app()
