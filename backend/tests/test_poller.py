"""
tests/test_poller.py
────────────────────
Tests for the Binance batch poller.

The key regression guarded here: the poller used to build its Binance pair map
once, before entering the polling loop. POST /api/config mutates
settings.coins_to_track at runtime, but the poller never re-read it — so
changing the tracked coin list silently did nothing until a process restart.

No network access: _fetch_prices_batch is stubbed with a fake Binance payload.
"""

from __future__ import annotations

import asyncio

import pytest

from app.ingestion.models import PriceTick
from app.ingestion.poller import COIN_MAPPING, CoinGeckoPoller


class TestBuildPairMap:
    """Unit tests for the coin_id → Binance pair mapping."""

    def test_maps_known_coins_to_binance_pairs(self) -> None:
        """Known coins use their COIN_MAPPING pair."""
        result = CoinGeckoPoller._build_pair_map(["bitcoin", "ethereum"])
        assert result == {"BTCUSDT": "bitcoin", "ETHUSDT": "ethereum"}

    def test_unknown_coin_falls_back_to_derived_pair(self) -> None:
        """Unknown coins get a best-effort <FIRST4>USDT pair."""
        result = CoinGeckoPoller._build_pair_map(["litecoin"])
        assert result == {"LITEUSDT": "litecoin"}

    def test_empty_coin_list_yields_empty_map(self) -> None:
        """An empty tracked list must not produce a bogus pair."""
        assert CoinGeckoPoller._build_pair_map([]) == {}

    def test_every_default_mapping_is_a_usdt_pair(self) -> None:
        """Guard against a malformed COIN_MAPPING entry."""
        for coin_id, info in COIN_MAPPING.items():
            assert info["pair"].endswith("USDT"), coin_id
            assert info["symbol"], coin_id


@pytest.mark.asyncio
async def test_poll_loop_picks_up_runtime_coin_list_changes(monkeypatch) -> None:
    """
    Changing settings.coins_to_track mid-run must change what the poller fetches.

    This fails against the old implementation, which captured the pair map
    before the loop started.
    """
    from app.config import get_settings

    settings = get_settings()
    original_coins = list(settings.coins_to_track)
    original_interval = settings.poll_interval_seconds

    # Record the pair map used on each poll cycle.
    observed: list[dict[str, str]] = []

    async def fake_fetch(self, symbols_param, pairs_to_coin_id):
        observed.append(dict(pairs_to_coin_id))
        return [
            PriceTick(
                coin_id=coin_id,
                symbol=coin_id[:3].upper(),
                name=coin_id,
                price_usd=100.0,
                volume_24h=1.0,
                price_change_24h=0.0,
            )
            for coin_id in pairs_to_coin_id.values()
        ]

    monkeypatch.setattr(CoinGeckoPoller, "_fetch_prices_batch", fake_fetch)

    try:
        settings.coins_to_track = ["bitcoin"]
        settings.poll_interval_seconds = 5  # ge=5 is the validated minimum

        queue: asyncio.Queue = asyncio.Queue()
        poller = CoinGeckoPoller(queue=queue)
        poller._running = True

        # Run the loop manually, swapping the coin list between cycles instead
        # of waiting out the real poll interval.
        sleep_calls = 0

        async def fake_sleep(_seconds):
            nonlocal sleep_calls
            sleep_calls += 1
            if sleep_calls == 1:
                # Simulate POST /api/config {"coins": ["ethereum", "solana"]}
                settings.coins_to_track = ["ethereum", "solana"]
            else:
                poller._running = False

        monkeypatch.setattr(asyncio, "sleep", fake_sleep)
        await poller._poll_batch_loop()

        assert len(observed) == 2, f"expected 2 poll cycles, got {len(observed)}"
        assert observed[0] == {"BTCUSDT": "bitcoin"}
        assert observed[1] == {"ETHUSDT": "ethereum", "SOLUSDT": "solana"}

        # Ticks for the new coins actually reached the queue.
        queued = []
        while not queue.empty():
            queued.append(queue.get_nowait().coin_id)
        assert set(queued) == {"bitcoin", "ethereum", "solana"}
    finally:
        settings.coins_to_track = original_coins
        settings.poll_interval_seconds = original_interval


@pytest.mark.asyncio
async def test_poll_loop_skips_cycle_when_no_coins_configured(monkeypatch) -> None:
    """An empty coin list must skip the fetch, not request an empty symbol list."""
    from app.config import get_settings

    settings = get_settings()
    original_coins = list(settings.coins_to_track)

    fetch_calls = 0

    async def fake_fetch(self, symbols_param, pairs_to_coin_id):
        nonlocal fetch_calls
        fetch_calls += 1
        return []

    monkeypatch.setattr(CoinGeckoPoller, "_fetch_prices_batch", fake_fetch)

    try:
        settings.coins_to_track = []
        poller = CoinGeckoPoller(queue=asyncio.Queue())
        poller._running = True

        async def fake_sleep(_seconds):
            poller._running = False

        monkeypatch.setattr(asyncio, "sleep", fake_sleep)
        await poller._poll_batch_loop()

        assert fetch_calls == 0, "must not call Binance with an empty symbol list"
    finally:
        settings.coins_to_track = original_coins
