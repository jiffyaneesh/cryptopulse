"""
ingestion/poller.py
───────────────────
Async polling worker that fetches live price ticks from the CoinGecko API
and pushes them onto an asyncio.Queue for downstream scoring.

Architecture:
  - CoinGeckoPoller manages one asyncio.Task per tracked coin.
  - Each task runs an infinite poll loop: fetch → emit PriceTick → sleep.
  - Rate-limit resilience is handled by tenacity: exponential backoff on
    HTTP 429 or transient 5xx errors, up to MAX_RETRY_ATTEMPTS retries.
  - A shared httpx.AsyncClient is reused across all tasks for connection pooling.

Responsibilities:
  - Manage the lifecycle of per-coin polling tasks.
  - Fetch price data from CoinGecko /simple/price endpoint.
  - Emit PriceTick dataclass objects to the provided asyncio.Queue.
  - Respect CoinGecko free-tier rate limits.

NOT responsible for:
  - Anomaly scoring (see scoring/scorer.py).
  - Database persistence (see db/queries.py).
  - WebSocket broadcasting (see api/websocket.py).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
    before_sleep_log,
)

from app.config import get_settings
from app.ingestion.models import PriceTick

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

# Maximum retry attempts before giving up on a single poll cycle.
# After MAX_RETRY_ATTEMPTS failures, the tick is skipped and the next
# poll interval begins normally — we never halt the entire poller.
MAX_RETRY_ATTEMPTS: int = 5

# Tenacity backoff bounds (seconds). On HTTP 429, we wait at least
# MIN_BACKOFF_SECONDS before retrying, growing exponentially to MAX_BACKOFF_SECONDS.
MIN_BACKOFF_SECONDS: float = 1.0
MAX_BACKOFF_SECONDS: float = 60.0

# CoinGecko /simple/price query parameters we always include.
# including market_cap, 24h vol, and 24h change avoids extra API calls.
COINGECKO_PRICE_FIELDS: str = (
    "include_market_cap=true"
    "&include_24hr_vol=true"
    "&include_24hr_change=true"
    "&precision=6"
)


class CoinGeckoPoller:
    """
    Manages concurrent async polling tasks for multiple coins.

    Each coin gets its own asyncio.Task so failures on one coin
    (e.g., a bad coin ID) do not block others.

    Attributes:
        _queue:   asyncio.Queue where PriceTick objects are pushed.
        _tasks:   Dict mapping coin_id → its running asyncio.Task.
        _client:  Shared httpx.AsyncClient (connection-pooled).
        _running: Set to False when stop() is called to exit poll loops.
    """

    def __init__(self, queue: asyncio.Queue) -> None:
        """
        Initialise the poller with the shared output queue.

        Args:
            queue: asyncio.Queue where PriceTick objects will be pushed.
        """
        self._queue = queue
        self._tasks: dict[str, asyncio.Task] = {}
        self._client: httpx.AsyncClient | None = None
        self._running: bool = False

    async def start(self) -> None:
        """
        Start polling for all coins in the current settings.

        Creates a shared httpx.AsyncClient and spawns one asyncio.Task per
        configured coin. Logs startup for each coin.
        """
        settings = get_settings()
        self._running = True

        # Reuse a single AsyncClient across all coin tasks for HTTP connection pooling.
        # This avoids the overhead of creating a new TCP connection per request.
        self._client = httpx.AsyncClient(
            base_url=settings.coingecko_base_url,
            timeout=httpx.Timeout(10.0),
            headers={"accept": "application/json"},
        )

        for coin_id in settings.coins_to_track:
            task = asyncio.create_task(
                self._poll_coin_loop(coin_id),
                name=f"poller-{coin_id}",
            )
            self._tasks[coin_id] = task
            logger.info("Started polling task", extra={"coin_id": coin_id})

    async def stop(self) -> None:
        """
        Gracefully stop all polling tasks and close the HTTP client.

        Sets _running=False so poll loops exit cleanly, then cancels any
        still-running tasks and closes the shared HTTP client.
        """
        self._running = False

        for coin_id, task in self._tasks.items():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            logger.info("Stopped polling task", extra={"coin_id": coin_id})

        if self._client:
            await self._client.aclose()

        self._tasks.clear()

    async def _poll_coin_loop(self, coin_id: str) -> None:
        """
        Infinite poll loop for a single coin.

        Runs until self._running is set to False. Each iteration:
          1. Fetches the current price from CoinGecko.
          2. Pushes the PriceTick to the queue.
          3. Sleeps for POLL_INTERVAL_SECONDS.

        Args:
            coin_id: CoinGecko coin identifier to poll.
        """
        settings = get_settings()

        while self._running:
            try:
                tick = await self._fetch_price(coin_id)
                await self._queue.put(tick)
                logger.debug(
                    "Tick fetched",
                    extra={"coin_id": coin_id, "price": tick.price_usd},
                )
            except Exception as exc:
                # Log and continue — a single failed tick should never stop the loop.
                # tenacity already retried MAX_RETRY_ATTEMPTS times before raising here.
                logger.error(
                    "Failed to fetch tick after retries, skipping",
                    extra={"coin_id": coin_id, "error": str(exc)},
                )

            # Sleep between polls. asyncio.sleep yields control back to the event loop,
            # allowing other coin tasks and WS handlers to run concurrently.
            await asyncio.sleep(settings.poll_interval_seconds)

    @retry(
        retry=retry_if_exception_type((httpx.HTTPStatusError, httpx.TransportError)),
        wait=wait_exponential(
            multiplier=1, min=MIN_BACKOFF_SECONDS, max=MAX_BACKOFF_SECONDS
        ),
        stop=stop_after_attempt(MAX_RETRY_ATTEMPTS),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )
    async def _fetch_price(self, coin_id: str) -> PriceTick:
        """
        Fetch the current price for a single coin with automatic retry.

        Uses the CoinGecko /simple/price endpoint which is efficient:
        one request returns price + market cap + 24h volume + 24h change.

        The @retry decorator handles HTTP 429 and transient errors with
        exponential backoff. If all retries fail, the exception propagates
        to _poll_coin_loop which logs and skips the tick.

        Args:
            coin_id: CoinGecko coin identifier (e.g. "bitcoin").

        Returns:
            PriceTick: Populated tick with current price data.

        Raises:
            httpx.HTTPStatusError: On persistent non-2xx response.
            httpx.TransportError: On network-level failure.
            KeyError: If coin_id is not found in the API response.
        """
        assert self._client is not None, "Client not initialised — call start() first"

        settings = get_settings()
        url = (
            f"/simple/price?ids={coin_id}&vs_currencies=usd&{COINGECKO_PRICE_FIELDS}"
        )

        # Add API key header if configured (Pro tier unlocks higher rate limits)
        headers = {}
        if settings.coingecko_api_key:
            headers["x-cg-pro-api-key"] = settings.coingecko_api_key

        response = await self._client.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()

        if coin_id not in data:
            raise KeyError(f"CoinGecko response missing coin_id='{coin_id}'")

        coin_data = data[coin_id]

        # Fetch the display name from a separate coins/list call would be expensive;
        # instead we use the coin_id capitalised as a readable fallback name.
        return PriceTick(
            coin_id=coin_id,
            symbol=coin_id[:4].upper(),  # Approximate; overridden if we have metadata
            name=coin_id.replace("-", " ").title(),
            price_usd=float(coin_data.get("usd", 0.0)),
            market_cap=float(coin_data.get("usd_market_cap", 0.0)),
            volume_24h=float(coin_data.get("usd_24h_vol", 0.0)),
            price_change_24h=float(coin_data.get("usd_24h_change", 0.0)),
            polled_at=datetime.now(timezone.utc),
        )
