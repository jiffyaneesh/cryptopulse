"""
ingestion/models.py
───────────────────
Data transfer objects (DTOs) for the ingestion and scoring pipeline.

Defines two dataclasses:
  - PriceTick: a raw price observation from the CoinGecko API.
  - ScoredTick: a PriceTick enriched with an anomaly score from the scorer.

These are plain dataclasses (not Pydantic models) for minimal overhead in the
hot path. The to_dict() methods produce JSON-serializable dicts for WebSocket
broadcasting and SQLite persistence.

Responsibilities:
  - Model the data that flows through the pipeline.
  - Provide validated construction via __post_init__.
  - Provide serialisation to dict for WS broadcast and DB insert.

NOT responsible for:
  - Fetching data (see ingestion/poller.py).
  - Scoring (see scoring/scorer.py).
  - Database persistence (see db/queries.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class PriceTick:
    """
    A single raw price observation emitted by the ingestion poller.

    Attributes:
        coin_id:          CoinGecko identifier (e.g. "bitcoin").
        symbol:           Ticker symbol (e.g. "BTC"). Uppercased on init.
        name:             Human-readable name (e.g. "Bitcoin").
        price_usd:        Current price in USD (last traded price).
        volume_24h:       24-hour quote volume in USD.
        price_change_24h: 24-hour price change percentage.
        high_price:       24-hour high price in USD (Binance highPrice).
        low_price:        24-hour low price in USD (Binance lowPrice).
        bid_price:        Best bid price in USD (Binance bidPrice).
        ask_price:        Best ask price in USD (Binance askPrice).
        polled_at:        UTC datetime when this tick was fetched.

    Note: market_cap is deliberately absent. The Binance ticker endpoint does
    not expose it, and carrying a permanently-zero field through the pipeline
    is worse than not having it. Add it back only alongside a source that
    actually provides it.
    """

    coin_id: str
    symbol: str
    name: str
    price_usd: float
    volume_24h: float
    price_change_24h: float
    high_price: float = 0.0
    low_price: float = 0.0
    bid_price: float = 0.0
    ask_price: float = 0.0
    polled_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        """Validate and normalise fields after construction."""
        # Normalise symbol to uppercase so consumers never see mixed case.
        self.symbol = self.symbol.upper()

        if self.price_usd < 0:
            raise ValueError(f"price_usd must be non-negative, got {self.price_usd}")

    def to_dict(self) -> dict:
        """
        Serialise to a JSON-compatible dict.

        Returns:
            dict: All fields with polled_at converted to ISO 8601 UTC string.
        """
        return {
            "coin_id": self.coin_id,
            "symbol": self.symbol,
            "name": self.name,
            "price_usd": self.price_usd,
            "volume_24h": self.volume_24h,
            "price_change_24h": self.price_change_24h,
            "high_price": self.high_price,
            "low_price": self.low_price,
            "bid_price": self.bid_price,
            "ask_price": self.ask_price,
            "polled_at": self.polled_at.isoformat(),
        }


@dataclass
class ScoredTick:
    """
    A PriceTick enriched with an anomaly score from the streaming scorer.

    This is the primary data object broadcast over WebSockets and stored
    in the database. Both the raw price fields and the scoring results are
    carried together to avoid re-joins downstream.

    Attributes:
        tick:           The original raw PriceTick that was scored.
        anomaly_score:  Normalised score ∈ [0, 1] (HST) or raw |z| (z-score).
        is_anomaly:     True when score exceeds the configured threshold.
        model_type:     Which scorer produced this result ("zscore" / "halftrees").
        threshold:      The threshold value that was active when scoring occurred.
        scored_at:      UTC datetime when scoring completed.
    """

    tick: PriceTick
    anomaly_score: float
    is_anomaly: bool
    model_type: str
    threshold: float
    scored_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        """Validate score range for HalfSpaceTrees model."""
        if self.model_type == "halftrees" and not (0.0 <= self.anomaly_score <= 1.0):
            raise ValueError(
                f"HalfSpaceTrees anomaly_score must be in [0, 1], got {self.anomaly_score}"
            )

    def to_dict(self) -> dict:
        """
        Serialise to a flat JSON-compatible dict for WebSocket broadcast.

        Merges tick fields with scoring metadata into a single flat object
        so the frontend doesn't need to unwrap nested structures.

        Returns:
            dict: Flat representation of the scored tick.
        """
        return {
            # Raw tick fields
            "coin_id": self.tick.coin_id,
            "symbol": self.tick.symbol,
            "name": self.tick.name,
            "price_usd": self.tick.price_usd,
            "volume_24h": self.tick.volume_24h,
            "price_change_24h": self.tick.price_change_24h,
            "high_price": self.tick.high_price,
            "low_price": self.tick.low_price,
            "bid_price": self.tick.bid_price,
            "ask_price": self.tick.ask_price,
            "polled_at": self.tick.polled_at.isoformat(),
            # Scoring metadata
            "anomaly_score": round(self.anomaly_score, 6),
            "is_anomaly": self.is_anomaly,
            "model_type": self.model_type,
            "threshold": self.threshold,
            "scored_at": self.scored_at.isoformat(),
        }
