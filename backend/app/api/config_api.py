"""
api/config_api.py
─────────────────
REST endpoint for runtime configuration updates.

Allows the frontend sensitivity slider to update the anomaly detection
threshold without restarting the backend. Also supports switching between
model types (z-score ↔ HalfSpaceTrees) at runtime.

Why runtime config matters:
  The "correct" anomaly threshold is subjective and data-dependent.
  Exposing it via a live slider lets users explore different sensitivity levels
  and observe their effect on the live chart immediately — a key demo feature.

Responsibilities:
  - Accept and validate configuration update requests.
  - Update in-memory state (scorer registry, settings) atomically.
  - Return the applied configuration in the response.

NOT responsible for:
  - Persisting config changes across restarts (settings are runtime-only;
    restart uses .env defaults). This is intentional for simplicity.
  - Retraining or resetting model state when threshold changes (only reset
    on model_type change).
"""

from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["config"])


class ConfigUpdateRequest(BaseModel):
    """
    Request body for updating runtime configuration.

    All fields are optional — only provided fields are updated.
    """

    threshold: Optional[float] = Field(
        default=None,
        ge=0.01,
        le=10.0,
        description="New anomaly threshold. Semantics: ∈[0,1] for HST, σ units for z-score.",
    )
    model_type: Optional[Literal["zscore", "halftrees"]] = Field(
        default=None,
        description="Switch the active scoring model. Resets all coin scorers.",
    )
    coins: Optional[list[str]] = Field(
        default=None,
        description="Update the list of tracked coins. New coins get fresh scorers.",
    )


class ConfigUpdateResponse(BaseModel):
    """Response confirming the applied configuration."""

    applied_threshold: float
    applied_model_type: str
    applied_coins: list[str]
    model_reset: bool
    message: str


@router.post("/config", response_model=ConfigUpdateResponse, summary="Update runtime config")
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

    Args:
        request: FastAPI Request — used to access app.state.
        body:    ConfigUpdateRequest with optional fields to update.

    Returns:
        ConfigUpdateResponse: The configuration as actually applied.
    """
    scorer_registry = request.app.state.scorer_registry
    settings = request.app.state.settings
    model_reset = False

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
        # Update the tracked coin list in settings. New coins will get fresh
        # scorers on their first tick (lazy initialisation in ScorerRegistry).
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
