"""
ingestion/poller.py
───────────────────
Async polling worker that fetches live price ticks from the Binance API
and pushes them onto an asyncio.Queue for downstream scoring.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import httpx
from tenacity import (
    before_sleep_log,
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.config import get_settings
from app.ingestion.models import PriceTick

logger = logging.getLogger(__name__)

# Maximum retry attempts before giving up on a single poll cycle.
MAX_RETRY_ATTEMPTS: int = 5
MIN_BACKOFF_SECONDS: float = 1.0
MAX_BACKOFF_SECONDS: float = 60.0

# Map CoinGecko IDs to Binance Symbol Pairs and Metadata
COIN_MAPPING = {
    "bitcoin": {"symbol": "BTC", "pair": "BTCUSDT", "name": "Bitcoin"},
    "ethereum": {"symbol": "ETH", "pair": "ETHUSDT", "name": "Ethereum"},
    "binancecoin": {"symbol": "BNB", "pair": "BNBUSDT", "name": "Binance Coin"},
    "solana": {"symbol": "SOL", "pair": "SOLUSDT", "name": "Solana"},
    "cardano": {"symbol": "ADA", "pair": "ADAUSDT", "name": "Cardano"},
    "ripple": {"symbol": "XRP", "pair": "XRPUSDT", "name": "Ripple"},
    "polkadot": {"symbol": "DOT", "pair": "DOTUSDT", "name": "Polkadot"},
    "dogecoin": {"symbol": "DOGE", "pair": "DOGEUSDT", "name": "Dogecoin"},
}


class CoinGeckoPoller:
    """
    Manages concurrent async polling tasks for multiple coins, using Binance API.
    Name kept as CoinGeckoPoller to maintain integration points with the application lifecycle.
    """

    def __init__(self, queue: asyncio.Queue) -> None:
        self._queue = queue
        self._tasks: dict[str, asyncio.Task] = {}
        self._client: httpx.AsyncClient | None = None
        self._running: bool = False

    async def start(self) -> None:
        """Start polling for all configured coins."""
        settings = get_settings()
        self._running = True

        # Using Binance API Base URL instead of CoinGecko to bypass rate limits
        self._client = httpx.AsyncClient(
            base_url="https://api.binance.com",
            timeout=httpx.Timeout(10.0),
            headers={"accept": "application/json"},
        )

        for coin_id in settings.coins_to_track:
            task = asyncio.create_task(
                self._poll_coin_loop(coin_id),
                name=f"poller-{coin_id}",
            )
            self._tasks[coin_id] = task
            logger.info("Started polling task (Binance)", extra={"coin_id": coin_id})

    async def stop(self) -> None:
        """Stop all polling tasks and close the HTTP client."""
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
        """Infinite poll loop for a single coin."""
        settings = get_settings()

        while self._running:
            try:
                tick = await self._fetch_price(coin_id)
                await self._queue.put(tick)
                logger.debug(
                    "Tick fetched (Binance)",
                    extra={"coin_id": coin_id, "price": tick.price_usd},
                )
            except Exception as exc:
                logger.error(
                    "Failed to fetch tick from Binance after retries, skipping",
                    extra={"coin_id": coin_id, "error": str(exc)},
                )

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
        """Fetch current ticker price and 24h stats from Binance API."""
        assert self._client is not None, "Client not initialised — call start() first"

        info = COIN_MAPPING.get(coin_id)
        if not info:
            # Fallback if a coin is not in the default mapping
            pair = f"{coin_id[:4].upper()}USDT"
            symbol = coin_id[:4].upper()
            name = coin_id.replace("-", " ").title()
        else:
            pair = info["pair"]
            symbol = info["symbol"]
            name = info["name"]

        url = f"/api/v3/ticker/24hr?symbol={pair}"
        response = await self._client.get(url)
        response.raise_for_status()
        coin_data = response.json()

        return PriceTick(
            coin_id=coin_id,
            symbol=symbol,
            name=name,
            price_usd=float(coin_data.get("lastPrice", 0.0)),
            market_cap=0.0,  # Binance ticker doesn't provide circulating supply/market cap
            volume_24h=float(coin_data.get("quoteVolume", 0.0)),  # volume in USD (quote asset)
            price_change_24h=float(coin_data.get("priceChangePercent", 0.0)),
            polled_at=datetime.now(timezone.utc),
        )
