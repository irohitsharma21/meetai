# ─────────────────────────────────────────────────────────────────────
# AI Meeting Platform – Backend Dockerfile
# Multi-stage build for production-grade image (~180MB)
# ─────────────────────────────────────────────────────────────────────

FROM python:3.11-slim AS base

# Security: run as non-root
RUN groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ── Builder stage ─────────────────────────────────────────────────────
FROM base AS builder

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Production stage ──────────────────────────────────────────────────
FROM base AS production

COPY --from=builder /install /usr/local
COPY . .

# Copy environment template (actual .env is bind-mounted at runtime)
COPY .env.example .env.example

# Non-root ownership
RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 8010

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8010}/health || exit 1

# Shell form so ${PORT} is expanded at runtime; Render and Cloud Run inject it
# and will not route to a hard-coded port.
#
# One worker by default, not four. Each worker is a whole Python process with
# its own embedding model and Qdrant client - about 280 MB measured - so four
# of them do not fit a 512 MB instance and the container is killed on the first
# request. Raise WEB_CONCURRENCY when the box is bigger.
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8010} \
    --workers ${WEB_CONCURRENCY:-1} --loop uvloop --http httptools \
    --proxy-headers --forwarded-allow-ips "*"
