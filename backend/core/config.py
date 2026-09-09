"""
Core configuration management using Pydantic Settings.
Loads all environment variables with validation and type safety.
"""

from pydantic_settings import BaseSettings
from pydantic import Field, AnyHttpUrl
from functools import lru_cache
from typing import List, Optional


class Settings(BaseSettings):
    # ── Application ──────────────────────────────────────────────────────────
    APP_NAME: str = "AI Meeting Platform"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False
    ENVIRONMENT: str = "development"  # development | staging | production

    # ── Security / JWT ────────────────────────────────────────────────────────
    SECRET_KEY: str = Field(..., description="JWT signing secret – min 32 chars")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # ── CORS ─────────────────────────────────────────────────────────────────
    # Both spellings of loopback are listed: a browser treats localhost and
    # 127.0.0.1 as distinct origins, and Vite's preview server binds the latter.
    ALLOWED_ORIGINS: List[str] = [
        "http://localhost:5173",
        "http://localhost:4173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:4173",
    ]

    # ── Persistence ───────────────────────────────────────────────────────────
    # "auto"    – use MongoDB when reachable, else SQLite (default)
    # "sqlite"  – always SQLite; zero setup, data persists to a local file
    # "mongodb" – always MongoDB; fail loudly if it is not reachable
    DATABASE_BACKEND: str = "auto"

    # Optional. When empty, "auto" goes straight to SQLite without probing.
    MONGODB_URL: str = Field(default="", description="MongoDB connection string")
    MONGODB_DB_NAME: str = "ai_meeting_platform"
    MONGODB_TIMEOUT_MS: int = 2000

    SQLITE_PATH: str = "./data/meetai.db"

    # ── LiveKit ───────────────────────────────────────────────────────────────
    LIVEKIT_API_KEY: str = Field(default="", description="LiveKit API key")
    LIVEKIT_API_SECRET: str = Field(default="", description="LiveKit API secret")
    LIVEKIT_URL: str = Field(default="", description="wss://your-livekit-server.livekit.cloud")

    @property
    def livekit_configured(self) -> bool:
        return bool(self.LIVEKIT_API_KEY and self.LIVEKIT_API_SECRET and self.LIVEKIT_URL)

    # ── Speech-to-text ────────────────────────────────────────────────────────
    # deepgram | groq.  Deepgram is the default: it decodes WebM/Opus natively,
    # which is what MediaRecorder produces in the browser.
    STT_PROVIDER: str = "deepgram"

    DEEPGRAM_API_KEY: str = Field(default="", description="Deepgram API key")
    # nova-3 is Deepgram's current general model; smart_format adds punctuation
    # and casing, which matters because the transcript is read by people and
    # fed to an LLM.
    DEEPGRAM_MODEL: str = "nova-3"
    DEEPGRAM_LANGUAGE: str = "en"

    @property
    def deepgram_configured(self) -> bool:
        return bool(self.DEEPGRAM_API_KEY)

    # ── LLM (OpenRouter) ──────────────────────────────────────────────────────
    # OpenRouter speaks the OpenAI chat-completions dialect and fronts many
    # providers behind one key, so the model can change without touching code.
    OPENROUTER_API_KEY: str = Field(default="", description="OpenRouter API key")
    OPENROUTER_BASE_URL: str = "https://openrouter.ai/api/v1"

    # Free-tier models. Both were checked against this app's actual workload -
    # returning strict JSON for reports and action detection - rather than
    # picked off a leaderboard.
    OPENROUTER_MODEL: str = "nex-agi/nex-n2.5-pro:free"
    OPENROUTER_FAST_MODEL: str = "nex-agi/nex-n2.5-mini:free"

    # Free models are rate limited per-model, and a 429 is routine rather than
    # exceptional. Each request walks this list until one answers, so a busy
    # model degrades into a slower answer instead of a failed feature.
    OPENROUTER_FALLBACK_MODELS: List[str] = [
        "nvidia/nemotron-3-super-120b-a12b:free",
        "google/gemma-4-31b-it:free",
        "openrouter/free",
    ]

    # Sent by OpenRouter's convention so usage is attributable; neither is
    # required for the API to work.
    OPENROUTER_SITE_URL: str = "http://localhost:5173"
    OPENROUTER_APP_NAME: str = "MeetAI"

    @property
    def openrouter_configured(self) -> bool:
        return bool(self.OPENROUTER_API_KEY)

    @property
    def llm_configured(self) -> bool:
        return self.openrouter_configured or bool(self.GROQ_API_KEY)

    # ── Groq (optional fallback) ──────────────────────────────────────────────
    # Retained as an alternative STT and LLM backend. llama3-70b-8192 and
    # llama-3.1-70b-versatile were both decommissioned by Groq; requests
    # against them return 404.
    GROQ_API_KEY: str = Field(default="", description="Groq API key (optional)")
    GROQ_TRANSCRIPTION_MODEL: str = "whisper-large-v3"
    GROQ_LLM_MODEL: str = "llama-3.3-70b-versatile"
    GROQ_LLM_FAST_MODEL: str = "llama-3.1-8b-instant"

    @property
    def groq_configured(self) -> bool:
        return bool(self.GROQ_API_KEY)

    @property
    def stt_configured(self) -> bool:
        """Whether speech-to-text can run with whichever provider is selected."""
        if self.STT_PROVIDER == "groq":
            return self.groq_configured
        return self.deepgram_configured

    # ── Google Calendar OAuth2 ────────────────────────────────────────────────
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/calendar/oauth2callback"
    GOOGLE_SCOPES: List[str] = [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/userinfo.email",
    ]

    # ── Email digests (optional) ──────────────────────────────────────────────
    # Any SMTP provider works: Gmail app password, SendGrid, Mailgun, Postmark,
    # or a local MailHog during development.
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = ""
    SMTP_USE_TLS: bool = True   # STARTTLS on 587/25
    SMTP_USE_SSL: bool = False  # implicit TLS, typically port 465
    APP_PUBLIC_URL: str = "http://localhost:5173"

    @property
    def email_configured(self) -> bool:
        return bool(self.SMTP_HOST and self.SMTP_FROM)

    # ── Semantic search (optional) ────────────────────────────────────────────
    # Embeddings run locally through fastembed (ONNX, no API key, ~50 MB) and
    # are stored in an embedded Qdrant collection, so search needs no external
    # service. Disable to skip the model download entirely.
    SEMANTIC_SEARCH_ENABLED: bool = True
    EMBEDDING_MODEL: str = "BAAI/bge-small-en-v1.5"
    QDRANT_PATH: str = "./data/qdrant"
    QDRANT_URL: str = ""  # set to use a Qdrant server instead of embedded mode
    QDRANT_COLLECTION: str = "meeting_transcripts"

    # ── Voice agent (optional) ────────────────────────────────────────────────
    # elevenlabs | murf | sarvam | browser
    # "browser" needs no key: the client speaks the reply with the Web Speech
    # API, so the agent is demonstrable with zero credentials.
    TTS_PROVIDER: str = "browser"
    ELEVENLABS_API_KEY: str = ""
    ELEVENLABS_VOICE_ID: str = "21m00Tcm4TlvDq8ikWAM"
    MURF_API_KEY: str = ""
    MURF_VOICE_ID: str = "en-US-natalie"
    SARVAM_API_KEY: str = ""
    SARVAM_SPEAKER: str = "meera"

    @property
    def tts_configured(self) -> bool:
        return self.TTS_PROVIDER == "browser" or bool(
            {
                "elevenlabs": self.ELEVENLABS_API_KEY,
                "murf": self.MURF_API_KEY,
                "sarvam": self.SARVAM_API_KEY,
            }.get(self.TTS_PROVIDER)
        )

    # ── Storage / Encryption ──────────────────────────────────────────────────
    ENCRYPTION_KEY: str = Field(
        "", description="32-byte AES-256 key (base64-encoded) for at-rest encryption"
    )

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": True,
        "extra": "ignore"
    }


@lru_cache()
def get_settings() -> Settings:
    """
    Return the cached Settings singleton.

    Pydantic Settings already reads `.env` via `model_config`; the previous
    implementation re-parsed the file by hand to force GROQ_* values to win
    over the shell environment. That inverted the normal precedence (env
    should override a committed file, not the reverse) and silently ignored
    quoting rules, so it has been removed.
    """
    return Settings()


settings = get_settings()
