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

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "4", "--loop", "uvloop", "--http", "httptools", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
