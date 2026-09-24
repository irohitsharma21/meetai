"""
Database connection management and backend selection.

MeetAI supports two interchangeable persistence backends behind one API:

  sqlite   zero-configuration, on by default. Clone the repo and run — no
           daemon, no account, no container. Data persists to a local file.
  mongodb  used when MONGODB_URL points at a reachable server. This is what
           the deployed instance runs on (MongoDB Atlas).

`DATABASE_BACKEND` chooses explicitly; the default "auto" probes MongoDB and
falls back to SQLite when it is not reachable, so a developer without a
database still gets a working, *persistent* app rather than an in-memory mock
that silently loses everything on restart.

Both backends expose the same collection API, so nothing above this module
knows or cares which one is live.
"""

from contextlib import asynccontextmanager
from pathlib import Path
import asyncio
from typing import AsyncGenerator

from pymongo import ASCENDING, TEXT, IndexModel

from core.config import settings
from db import sqlite_store


class Database:
    """Holds the active connection and identifies which backend won."""

    client = None
    db = None
    backend: str = "unset"
    location: str = ""

    @property
    def is_sqlite(self) -> bool:
        return self.backend == "sqlite"

    @property
    def is_mongo(self) -> bool:
        return self.backend == "mongodb"


database = Database()
mongodb = database  # backwards-compatible alias


async def _try_mongo() -> bool:
    """Attempt a real MongoDB connection. Returns True on success."""
    if not settings.MONGODB_URL:
        return False

    try:
        import motor.motor_asyncio

        client = motor.motor_asyncio.AsyncIOMotorClient(
            settings.MONGODB_URL,
            serverSelectionTimeoutMS=settings.MONGODB_TIMEOUT_MS,
            maxPoolSize=50,
            minPoolSize=5,
        )
        await client.admin.command("ping")

        database.client = client
        database.db = client[settings.MONGODB_DB_NAME]
        database.backend = "mongodb"
        # Never log the connection string: it carries credentials.
        database.location = settings.MONGODB_DB_NAME
        print(f"[db] MongoDB connected — database '{settings.MONGODB_DB_NAME}'")
        return True

    except Exception as exc:
        print(f"[db] MongoDB unavailable ({exc.__class__.__name__})")
        return False


async def _use_sqlite() -> None:
    path = Path(settings.SQLITE_PATH).expanduser().resolve()
    conn, db = await sqlite_store.connect(path)

    database.client = conn
    database.db = db
    database.backend = "sqlite"
    database.location = str(path)
    print(f"[db] SQLite ready — {path}")


async def connect_db() -> None:
    """Select and open a backend according to DATABASE_BACKEND."""
    choice = settings.DATABASE_BACKEND.lower()

    if choice == "mongodb":
        if not await _try_mongo():
            raise RuntimeError(
                "DATABASE_BACKEND=mongodb but MongoDB is not reachable. "
                "Check MONGODB_URL, or use DATABASE_BACKEND=sqlite."
            )
    elif choice == "sqlite":
        await _use_sqlite()
    else:  # auto
        if not await _try_mongo():
            print("[db] falling back to SQLite (set DATABASE_BACKEND to override)")
            await _use_sqlite()

    await _ensure_indexes()


async def close_db() -> None:
    """Close whichever backend is open."""
    if database.client is None:
        return
    if database.is_sqlite:
        await database.client.close()
        print("[db] SQLite closed")
    else:
        database.client.close()
        print("[db] MongoDB connection closed")


async def _ensure_indexes() -> None:
    """
    Declare indexes once, for whichever backend is active.

    The SQLite store translates these into expression indexes over
    json_extract, so unique constraints are enforced by the database itself
    rather than by application-level checks.
    """
    try:
        await database.db["meetings"].create_indexes([
            IndexModel([("meeting_id", ASCENDING)], unique=True, name="idx_meeting_id"),
            IndexModel([("timestamp", ASCENDING)], name="idx_timestamp"),
            IndexModel([("status", ASCENDING)], name="idx_status"),
            IndexModel([("created_by", ASCENDING)], name="idx_created_by"),
            IndexModel([("join_code", ASCENDING)], unique=True, name="idx_join_code"),
        ])

        # Mongo text index; skipped by the SQLite store, which serves $text
        # through its own matcher.
        if database.is_mongo:
            try:
                await database.db["meetings"].create_indexes([
                    IndexModel(
                        [("transcript.text", TEXT), ("transcript.speaker", TEXT)],
                        name="idx_transcript_text",
                        default_language="english",
                    ),
                ])
            except Exception:
                pass

        await database.db["users"].create_indexes([
            IndexModel([("username", ASCENDING)], unique=True, name="idx_username"),
            IndexModel([("email", ASCENDING)], unique=True, name="idx_email"),
        ])

        await database.db["calendar_tokens"].create_indexes([
            IndexModel([("username", ASCENDING)], unique=True, name="idx_cal_username"),
        ])

        await database.db["agent_profiles"].create_indexes([
            IndexModel([("username", ASCENDING)], unique=True, name="idx_agent_profile_user"),
        ])
        await database.db["agent_actions"].create_indexes([
            IndexModel([("id", ASCENDING)], unique=True, name="idx_agent_action_id"),
            IndexModel([("meeting_id", ASCENDING), ("owner", ASCENDING)], name="idx_agent_action_owner"),
        ])

        print(f"[db] indexes ensured ({database.backend})")
    except Exception as exc:
        print(f"[db] index creation warning: {exc}")


async def _backfill_join_codes() -> None:
    """
    Give meetings created before join codes existed a code of their own.

    Without this they can never be shared, and the unique index would also
    reject a second document whose join_code is missing. Runs once per start
    and is a no-op after that.
    """
    from models.meeting_model import generate_join_code

    try:
        col = database.db["meetings"]
        cursor = col.find({"$or": [{"join_code": None}, {"join_code": ""}]})
        patched = 0
        async for doc in cursor:
            # Retry on the vanishingly unlikely collision rather than failing
            # the whole startup.
            for _ in range(5):
                code = generate_join_code()
                if await col.find_one({"join_code": code}):
                    continue
                await col.update_one(
                    {"meeting_id": doc["meeting_id"]}, {"$set": {"join_code": code}}
                )
                patched += 1
                break
        if patched:
            print(f"[db] assigned join codes to {patched} existing meeting(s)")
    except Exception as exc:
        print(f"[db] join-code backfill warning: {exc}")


# ── accessors ─────────────────────────────────────────────────────────
def get_db():
    return database.db


def get_meetings_collection():
    return database.db["meetings"]


def get_users_collection():
    return database.db["users"]


def get_calendar_tokens_collection():
    return database.db["calendar_tokens"]


def backend_info() -> dict:
    """Reported by /health so it is obvious which backend is serving."""
    return {"backend": database.backend, "location": database.location}


@asynccontextmanager
async def lifespan(app) -> AsyncGenerator:
    await connect_db()

    # Imported here rather than at module scope: db and services would
    # otherwise import each other in a cycle.
    from services.llm_client import llm_client
    from services.transcription_service import transcription_service

    await _backfill_join_codes()

    # Provider probes run detached. They exist so /health is honest early, but
    # an unreachable or slow provider must never stop the app from starting -
    # everything except that one feature works without it.
    asyncio.create_task(transcription_service.verify_credentials())
    asyncio.create_task(llm_client.verify())

    yield
    await close_db()
