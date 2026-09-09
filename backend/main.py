"""
AI Meeting Platform – FastAPI Application Entry Point

Features:
  - JWT-secured REST API
  - WebSocket real-time transcription
  - LiveKit meeting management
  - Groq AI analysis
  - Google Calendar integration
  - MongoDB (Motor async) persistence
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from core.config import settings
from db.mongodb import lifespan
from services.llm_client import llm_client
from services.transcription_service import transcription_service
from fastapi.exceptions import RequestValidationError
from routers import (
    auth_routes, calendar_routes, insight_routes,
    meeting_routes, transcript_routes,
)

# Provider summary at boot. Key material is never printed - even a partial key
# in a log is a partial key in every log aggregator downstream.
print(f"[stt] provider={settings.STT_PROVIDER} configured={settings.stt_configured}")
print(f"[llm] openrouter={settings.openrouter_configured} groq={settings.groq_configured}")

# ── App factory ───────────────────────────────────────────────────────────────
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="""
## AI-Enhanced Meeting Platform (Proof of Record System)

A production-ready AI meeting system with:
- HD video/audio via LiveKit
- Real-time speech-to-text (Groq Whisper)
- AI commitment & scheduling detection
- Post-meeting summaries, MoM, and sentiment analysis
- Google Calendar integration
- JWT authentication & role-based access
    """,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    """
    Return a 422 that is always JSON-serialisable.

    Two traps here. `exc.body` is the raw request body, which is a starlette
    FormData object for form endpoints (json.dumps raises TypeError on it, so
    the handler itself 500s) and, for /auth/register, contains the submitted
    password - which has no business being echoed back or printed. So the body
    is dropped entirely. `exc.errors()` can also carry non-serialisable values
    under `ctx`, hence jsonable_encoder rather than the raw list.
    """
    print(f"Validation error on {request.method} {request.url.path}: {exc.errors()}")
    try:
        detail = jsonable_encoder(exc.errors())
    except Exception:
        detail = [{"msg": str(exc), "loc": [], "type": "validation_error"}]
    return JSONResponse(status_code=422, content={"detail": detail})

# ── Middleware ─────────────────────────────────────────────────────────────────
# CORS – allow frontend origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Force HTTPS in production
if settings.ENVIRONMENT == "production":
    app.add_middleware(HTTPSRedirectMiddleware)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth_routes.router)
app.include_router(meeting_routes.router)
app.include_router(transcript_routes.router)
app.include_router(calendar_routes.router)
app.include_router(insight_routes.router)

# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/health", tags=["system"])
async def health_check():
    return JSONResponse(
        content={
            "status": "healthy",
            "app": settings.APP_NAME,
            "version": settings.APP_VERSION,
            "environment": settings.ENVIRONMENT,
            # Surfaced so a dead transcription provider is visible without
            # having to join a meeting and wait for a transcript that never
            # arrives.
            "transcription": transcription_service.status,
            "llm": llm_client.status,
        }
    )


@app.get("/", tags=["system"])
async def root():
    return {
        "message": f"Welcome to {settings.APP_NAME}",
        "docs": "/docs",
        "health": "/health",
    }