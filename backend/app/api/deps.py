"""
api/deps.py
───────────
Shared FastAPI dependency functions for authentication and request validation.

Centralising dependencies here keeps route handlers thin and makes the
security layer easy to test in isolation.

Exported dependencies
─────────────────────
require_api_key   — Validates the X-API-Key header on mutating endpoints.
                    Used on POST /api/config to prevent unauthenticated
                    runtime configuration changes.

Design decisions
────────────────
- Header-based API key (X-API-Key) rather than query-param: query params
  appear in server logs and browser history; headers do not.
- The key is stored in Settings (loaded from the CRYPTOPULSE_API_KEY env
  var). When the env var is absent the key defaults to an empty string and
  the check is *disabled* — this preserves the local development experience
  without any extra setup steps.
- Constant-time comparison (secrets.compare_digest) prevents timing attacks
  that could leak the key character-by-character.
"""

from __future__ import annotations

import secrets

from fastapi import HTTPException, Security, status
from fastapi.security import APIKeyHeader

from app.config import get_settings

# FastAPI security scheme — declares the header so OpenAPI docs show a lock icon
# and the "Authorize" button on /docs.
_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def require_api_key(api_key: str | None = Security(_api_key_header)) -> None:
    """
    FastAPI dependency that enforces API key authentication.

    Inject this into any route that should require authentication:

        @router.post("/config")
        async def update_config(
            _: None = Depends(require_api_key),
            ...
        )

    Behaviour
    ---------
    - If CRYPTOPULSE_API_KEY is not set (empty string default), the check is
      skipped entirely — convenient for local development.
    - If the key is configured but the request header is missing or wrong,
      returns HTTP 401 Unauthorized.
    - Uses secrets.compare_digest to avoid timing side-channels.

    Raises
    ------
    HTTPException(401)   — Missing or invalid API key.
    """
    settings = get_settings()
    expected_key = settings.api_key

    # Key not configured → auth disabled (local dev mode)
    if not expected_key:
        return

    # Header absent or wrong → reject
    if api_key is None or not secrets.compare_digest(api_key, expected_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-API-Key header.",
            headers={"WWW-Authenticate": "ApiKey"},
        )
