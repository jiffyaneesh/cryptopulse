"""
config.py
─────────
Application-level configuration for CryptoPulse backend.

All settings are loaded from environment variables or a .env file via
pydantic-settings. This centralises every tuneable value in one place,
making the service fully configurable without code changes (12-factor app).

Responsibilities:
  - Define typed, validated settings fields.
  - Provide sensible defaults for local development.
  - Expose a cached singleton `get_settings()` for use across the app.

NOT responsible for:
  - Reading runtime config updates (threshold changes at runtime go through
    app.state, not this module — see api/config_api.py).
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Application settings loaded from environment variables or .env file.

    All fields have sane defaults for local development. In production,
    set values via environment variables (Docker Compose env_file or
    platform secrets).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # ── CoinGecko API ────────────────────────────────────────────────────────
    # Free tier allows ~30 requests/minute. We poll N coins every
    # POLL_INTERVAL_SECONDS seconds; ensure total rate stays below limit.
    coingecko_api_key: str = Field(
        default="",
        description="Optional CoinGecko Pro API key. Leave empty for free tier.",
    )
    coingecko_base_url: str = Field(
        default="https://api.coingecko.com/api/v3",
        description="CoinGecko API base URL.",
    )

    # ── Tracking Configuration ───────────────────────────────────────────────
    # Default coins to track. CoinGecko IDs (not symbols).
    # 8 coins × 1 request/10s = 4.8 req/min — well within free-tier limits.
    coins_to_track: list[str] = Field(
        default=[
            "bitcoin",
            "ethereum",
            "binancecoin",
            "solana",
            "cardano",
            "ripple",
            "polkadot",
            "dogecoin",
        ],
        description="List of CoinGecko coin IDs to track.",
    )

    # Polling interval in seconds. 10s chosen to respect free-tier rate limits.
    poll_interval_seconds: int = Field(
        default=10,
        ge=5,
        le=300,
        description="Seconds between price polls per coin.",
    )

    # ── Anomaly Detection Model ──────────────────────────────────────────────
    model_type: Literal["zscore", "halftrees"] = Field(
        default="halftrees",
        description="Active anomaly scoring model. 'zscore' for rolling z-score; 'halftrees' for HalfSpaceTrees online learning.",
    )

    # Quantile level for HalfSpaceTrees: flag scores above the running
    # q-quantile, so the effective anomaly rate is roughly (1 - q).
    # HST's absolute score scale is feature-space dependent and clusters near
    # 1.0 in our stationary feature space, which makes a fixed cutoff useless
    # (0.75 flagged ~89% of ticks). See scoring/halftrees.py.
    default_threshold_halftrees: float = Field(
        default=0.99,
        gt=0.5,
        lt=1.0,
        description="Quantile level q for HalfSpaceTrees. Score > running q-quantile → anomaly.",
    )

    # Default threshold for rolling z-score (units: standard deviations).
    # 3.0σ is the classical threshold for outlier detection in normally-distributed data.
    default_threshold_zscore: float = Field(
        default=3.0,
        ge=0.1,
        le=10.0,
        description="Z-score threshold. |z| > threshold → anomaly.",
    )

    # ── Database ─────────────────────────────────────────────────────────────
    database_url: str = Field(
        default="./cryptopulse.db",
        description="Path to the SQLite database file.",
    )

    # ── Server ───────────────────────────────────────────────────────────────
    log_level: str = Field(
        default="INFO",
        description="Logging level: DEBUG, INFO, WARNING, ERROR.",
    )

    # CORS origins allowed to connect. In production, set to the actual frontend URL.
    cors_origins: list[str] = Field(
        default=["http://localhost:5173", "http://localhost:3000", "http://localhost:80"],
        description="Allowed CORS origins for the frontend.",
    )

    @property
    def default_threshold(self) -> float:
        """Return the default threshold for the currently configured model type."""
        if self.model_type == "halftrees":
            return self.default_threshold_halftrees
        return self.default_threshold_zscore


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """
    Return the cached application settings singleton.

    Uses lru_cache so the .env file is read exactly once per process.
    In tests, call get_settings.cache_clear() to reset between test cases.

    Returns:
        Settings: The validated, populated settings object.
    """
    return Settings()
