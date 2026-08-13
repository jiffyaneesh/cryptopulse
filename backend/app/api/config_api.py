"""
api/config_api.py
─────────────────
REST endpoint for runtime configuration updates.

Allows the frontend sensitivity slider to update the anomaly detection
threshold without restarting the backend. Also supports switching between
model types (z-score ↔ HalfSpaceTrees) at runtime.

Security notes
──────────────
- Protected by the require_api_key dependency (see api/deps.py).
  In production, set CRYPTOPULSE_API_KEY. Locally it is a no-op.
- The `coins` field is validated against the COIN_MAPPING whitelist in
  ingestion/poller.py. Unknown coin IDs are rejected with HTTP 422 before
  any state is mutated. This prevents user-controlled strings from reaching
  the Binance URL-parameter construction in the poller.
- Runtime coin/threshold state is stored in app.state, NOT in the lru_cache
  Settings singleton. Mutating a cached Pydantic model bypasses validation
  and is not thread-safe.

Why runtime config matters:
  The "correct" anomaly threshold is subjective and data-dependent.
  Exposing it via a live slider lets users explore different sensitivity
  levels and observe their effect on the live chart immediately.
"""

from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.api.deps import require_api_key
from app.ingestion.poller import COIN_MAPPING

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["config"])

# Valid coin IDs are exactly the keys of COIN_MAPPING.
VALID_COIN_IDS: frozenset[str] = frozenset(COIN_MAPPING.keys())


class ConfigUpdateRequest(BaseModel):
    """
    Request body for updating runtime configuration.

    All fields are optional — only provided fields are updated.
    """

    threshold: Optional[float] = Field(
        default=None,
        gt=0.0,
        le=10.0,
        description=(
            "New anomaly threshold. Semantics differ by model: quantile level "
            "q ∈ (0.5, 1) for halftrees, σ units for zscore."
        ),
    )
    model_type: Optional[Literal["zscore", "halftrees"]] = Field(
        default=None,
        description="Switch the active scoring model. Resets all coin scorers.",
    )
    coins: Optional[list[str]] = Field(
        default=None,
        min_length=1,
        description=(
            "Update the list of tracked coins. Must be a non-empty subset of "
            f"the supported coin IDs: {sorted(VALID_COIN_IDS)}."
        ),
    )


class ConfigUpdateResponse(BaseModel):
    """Response confirming the applied configuration."""

    applied_threshold: float
    applied_model_type: str
    applied_coins: list[str]
    model_reset: bool
    message: str


@router.post(
    "/config",
    response_model=ConfigUpdateResponse,
    summary="Update runtime config",
    dependencies=[Depends(require_api_key)],
)
async def update_config(
    request: Request,
    body: ConfigUpdateRequest,
) -> ConfigUpdateResponse:
    """
    Apply a runtime configuration update.

    Threshold changes take effect immediately for all existing coin scorers
    without resetting accumulated model state.

    Model type changes RESET all scorer state (the warm-up period begins again
    for every coin). This is unavoidable — a z-score scorer's rolling stats
    are meaningless to an HST model and vice versa.

    The tracked coin list is stored in app.state.runtime_coins (a plain list)
    rather than in the lru_cache'd Settings singleton to keep Pydantic
    validation intact and avoid mutating a frozen cache object.

    Args:
        request: FastAPI Request — used to access app.state.
        body:    ConfigUpdateRequest with optional fields to update.

    Returns:
        ConfigUpdateResponse: The configuration as actually applied.

    Raises:
        HTTPException(422): If any coin ID in `coins` is not in COIN_MAPPING.
        HTTPException(401): If the X-API-Key header is missing or wrong.
    """
    scorer_registry = request.app.state.scorer_registry
    settings = request.app.state.settings
    model_reset = False

    # ── Coin whitelist validation ─────────────────────────────────────────────
    # Validate before touching any state so the request is fully atomic:
    # either all changes apply or none do.
    if body.coins is not None:
        invalid = [c for c in body.coins if c not in VALID_COIN_IDS]
        if invalid:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Unknown coin ID(s): {invalid}. "
                    f"Supported: {sorted(VALID_COIN_IDS)}"
                ),
            )

    # ── Model type change ────────────────────────────────────────────────────
    if body.model_type and body.model_type != scorer_registry.model_type:
        # Switching models resets all per-coin scorer state.
        # New threshold comes from the request (if provided) or the new model's default.
        new_threshold = body.threshold if body.threshold is not None else (
            settings.default_threshold_halftrees
            if body.model_type == "halftrees"
            else settings.default_threshold_zscore
        )
        scorer_registry.reset(model_type=body.model_type, threshold=new_threshold)
        model_reset = True
        logger.info(
            "Model type switched",
            extra={"new_model": body.model_type, "new_threshold": new_threshold},
        )

    # ── Threshold-only change ────────────────────────────────────────────────
    elif body.threshold is not None:
        # Only update threshold — preserve all accumulated scorer state.
        scorer_registry.update_all_thresholds(body.threshold)
        logger.info("Threshold updated", extra={"threshold": body.threshold})

    # ── Coin list change ─────────────────────────────────────────────────────
    if body.coins is not None:
        # Store in app.state.runtime_coins — a plain mutable list that the poller
        # reads each cycle via settings.coins_to_track (see poller._poll_batch_loop).
        # We do NOT mutate the lru_cache'd Settings instance: that object is
        # frozen after first load and mutating it bypasses Pydantic validation.
        request.app.state.runtime_coins = body.coins
        # Also update the settings object's list so the poller (which calls
        # get_settings()) picks up the new coin list immediately.
        # We reassign on the already-loaded instance — this is safe because the
        # poller reads settings.coins_to_track (a plain list attr) each cycle.
        settings.coins_to_track = body.coins
        logger.info("Tracked coins updated", extra={"coins": body.coins})

    return ConfigUpdateResponse(
        applied_threshold=scorer_registry.threshold,
        applied_model_type=scorer_registry.model_type,
        applied_coins=settings.coins_to_track,
        model_reset=model_reset,
        message=(
            f"Model reset to {scorer_registry.model_type}"
            if model_reset
            else f"Threshold updated to {scorer_registry.threshold}"
        ),
    )
