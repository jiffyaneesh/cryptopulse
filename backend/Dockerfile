# backend/Dockerfile
# ──────────────────
# Multi-stage build for the CryptoPulse FastAPI backend.
# Final image: python:3.12-slim (~200MB) with no dev dependencies.

FROM python:3.12-slim AS base

# Set working directory and environment
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Install system dependencies needed by some Python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# ── Dependencies layer ────────────────────────────────────────────────────
# Copy requirements first so Docker caches this layer unless requirements change.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Application layer ─────────────────────────────────────────────────────
COPY app/ ./app/

# Create a non-root user for security
RUN adduser --disabled-password --gecos "" appuser && chown -R appuser /app
USER appuser

# Expose the application port
EXPOSE 8000

# Health check for Docker Compose depends_on condition
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

# Start with uvicorn. --workers 1 is intentional: the asyncio.Queue is
# in-process and would not be shared across multiple worker processes.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]

