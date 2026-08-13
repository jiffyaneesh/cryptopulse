"""
ingestion/poller.py
───────────────────
Async polling worker that fetches live price ticks from the Binance API
and pushes them onto an asyncio.Queue for downstream scoring.

This optimized version batch-queries all coins in a single HTTP request to
reduce outbound network connection overhead, latency, and CPU usage.
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
    Batch polling worker using the Binance API.
    Name kept as CoinGeckoPoller to maintain integration points with the application lifecycle.
    """

    def __init__(self, queue: asyncio.Queue) -> None:
        self._queue = queue
        self._client: httpx.AsyncClient | None = None
        self._running: bool = False
        self._batch_task: asyncio.Task | None = None

    async def start(self) -> None:
        """Start the batch polling task."""
        settings = get_settings()
        self._running = True

        self._client = httpx.AsyncClient(
            base_url="https://api.binance.com",
            timeout=httpx.Timeout(10.0),
            headers={"accept": "application/json"},
        )

        # Launch one single batch task instead of 8 separate concurrent loops
        self._batch_task = asyncio.create_task(
            self._poll_batch_loop(),
            name="poller-batch",
        )
        logger.info("Started batch polling task (Binance)")

    async def stop(self) -> None:
        """Stop the batch polling task and close the HTTP client."""
        self._running = False

        if self._batch_task:
            self._batch_task.cancel()
            try:
                await self._batch_task
            except asyncio.CancelledError:
                pass
            self._batch_task = None
            logger.info("Stopped batch polling task")

        if self._client:
            await self._client.aclose()

    @staticmethod
    def _build_pair_map(coins: list[str]) -> dict[str, str]:
        """
        Map each tracked coin ID to its Binance symbol pair.

        Args:
            coins: List of coin IDs to track.

        Returns:
            dict: Binance pair (e.g. "BTCUSDT") → coin_id (e.g. "bitcoin").
        """
        pairs_to_coin_id: dict[str, str] = {}
        for coin_id in coins:
            info = COIN_MAPPING.get(coin_id)
            pair = info["pair"] if info else f"{coin_id[:4].upper()}USDT"
            pairs_to_coin_id[pair] = coin_id
        return pairs_to_coin_id

    async def _poll_batch_loop(self) -> None:
        """Infinite loop that polls all configured symbols in a single request."""
        settings = get_settings()

        while self._running:
            # Rebuild the pair map every cycle: POST /api/config can mutate
            # settings.coins_to_track at runtime, and the poller must pick up
            # the new list. Building this once before the loop would silently
            # pin the poller to the startup coin list forever.
            pairs_to_coin_id = self._build_pair_map(settings.coins_to_track)
            if not pairs_to_coin_id:
                logger.warning("No coins configured to track, skipping poll cycle")
                await asyncio.sleep(settings.poll_interval_seconds)
                continue

            # Format symbols parameter as a URL-safe JSON list (e.g. ["BTCUSDT","ETHUSDT"])
            symbols_param = "[" + ",".join(f'"{p}"' for p in pairs_to_coin_id) + "]"

            try:
                ticks = await self._fetch_prices_batch(symbols_param, pairs_to_coin_id)
                for tick in ticks:
                    await self._queue.put(tick)
                    logger.debug(
                        "Tick fetched (Binance Batch)",
                        extra={"coin_id": tick.coin_id, "price": tick.price_usd},
                    )
            except Exception as exc:
                logger.error(
                    "Failed to fetch batch ticks from Binance, skipping this cycle",
                    extra={"error": str(exc)},
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
    async def _fetch_prices_batch(
        self, symbols_param: str, pairs_to_coin_id: dict[str, str]
    ) -> list[PriceTick]:
        """Query Binance batch ticker endpoint to fetch stats for all symbols at once."""
        assert self._client is not None, "Client not initialised — call start() first"

        url = f"/api/v3/ticker/24hr?symbols={symbols_param}"
        response = await self._client.get(url)
        response.raise_for_status()
        data = response.json()

        ticks = []
        for coin_data in data:
            pair = coin_data.get("symbol")
            coin_id = pairs_to_coin_id.get(pair)
            if not coin_id:
                continue

            info = COIN_MAPPING.get(coin_id)
            if info:
                symbol = info["symbol"]
                name = info["name"]
            else:
                symbol = pair.replace("USDT", "")
                name = coin_id.replace("-", " ").title()

            ticks.append(
                PriceTick(
                    coin_id=coin_id,
                    symbol=symbol,
                    name=name,
                    price_usd=float(coin_data.get("lastPrice", 0.0)),
                    volume_24h=float(coin_data.get("quoteVolume", 0.0)),
                    price_change_24h=float(coin_data.get("priceChangePercent", 0.0)),
                    # 24-hour high/low and best bid/ask are included in the
                    # Binance /api/v3/ticker/24hr response at no extra cost.
                    # Default to 0.0 when absent (e.g., newly-listed symbols
                    # may not yet have a full 24h window).
                    high_price=float(coin_data.get("highPrice", 0.0)),
                    low_price=float(coin_data.get("lowPrice", 0.0)),
                    bid_price=float(coin_data.get("bidPrice", 0.0)),
                    ask_price=float(coin_data.get("askPrice", 0.0)),
                    polled_at=datetime.now(timezone.utc),
                )
            )
        return ticks
