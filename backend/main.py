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
from fastapi.responses import JSONResponse

from core.config import settings
from db.mongodb import lifespan
from fastapi.exceptions import RequestValidationError
from routers import auth_routes, meeting_routes, transcript_routes, calendar_routes

# Groq config check
print(f"✅ Groq Configured: {settings.groq_configured}")
if settings.groq_configured:
    masked_key = settings.GROQ_API_KEY[:6] + "..." + settings.GROQ_API_KEY[-4:]
    print(f"🔑 Using Groq Key: {masked_key}")
    print(f"🎙️ Transcription Model: {settings.GROQ_TRANSCRIPTION_MODEL}")

# ── App factory ───────────────────────────────────────────────────────────────
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="""
## AI-Enhanced Meeting Platform (Proof of Record System)

A production-ready AI meeting system with:
- 🎥 HD video/audio via LiveKit
- 🗣️ Real-time speech-to-text (Groq Whisper)
- 🤖 AI commitment & scheduling detection
- 📊 Post-meeting summaries, MoM, and sentiment analysis
- 📅 Google Calendar integration
- 🔐 JWT authentication & role-based access
    """,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    print(f"❌ Validation Error: {exc.errors()}")
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors(), "body": exc.body},
    )

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

# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/health", tags=["system"])
async def health_check():
    return JSONResponse(
        content={
            "status": "healthy",
            "app": settings.APP_NAME,
            "version": settings.APP_VERSION,
            "environment": settings.ENVIRONMENT,
        }
    )


@app.get("/", tags=["system"])
async def root():
    return {
        "message": f"Welcome to {settings.APP_NAME}",
        "docs": "/docs",
        "health": "/health",
    }