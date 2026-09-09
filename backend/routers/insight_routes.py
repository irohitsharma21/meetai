"""
Routes for analytics, semantic search, the voice assistant and email digests.

Kept out of `meeting_routes` because these are cross-meeting concerns —
search and the assistant read across the whole workspace, not one meeting.

Every endpoint here degrades rather than fails: a missing key produces a 503
naming the variable to set, not a 500 with a traceback.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from core.config import settings
from core.security import get_current_user
from db.mongodb import get_meetings_collection, get_users_collection
from models.meeting_model import AIAnalysis, TranscriptEntry
from services.ai_analysis_service import AIUnavailable
from services.analytics_service import analyse
from services.assistant_service import assistant_service
from services.email_service import EmailUnavailable, Recipient, email_service
from services.search_service import SearchUnavailable, search_service

router = APIRouter(prefix="/insights", tags=["insights"])


# ── helpers ───────────────────────────────────────────────────────────
async def _load_meeting(meeting_id: str, user: dict) -> dict:
    """Fetch a meeting the caller is allowed to see."""
    doc = await get_meetings_collection().find_one({"meeting_id": meeting_id})
    if not doc:
        raise HTTPException(404, "meeting not found")

    if user["role"] != "admin":
        participants = {p.get("username") for p in doc.get("participants", [])}
        if user["username"] != doc.get("created_by") and user["username"] not in participants:
            # 404 rather than 403: confirming a meeting exists is itself a leak.
            raise HTTPException(404, "meeting not found")
    return doc


async def _visible_meeting_ids(user: dict) -> list[str]:
    """Every meeting id this user may search over."""
    query: dict = {}
    if user["role"] != "admin":
        query["$or"] = [
            {"created_by": user["username"]},
            {"participants.username": user["username"]},
        ]

    ids: list[str] = []
    async for doc in get_meetings_collection().find(query):
        ids.append(doc["meeting_id"])
    return ids


def _entries(doc: dict) -> list[TranscriptEntry]:
    out: list[TranscriptEntry] = []
    for raw in doc.get("transcript", []):
        try:
            out.append(TranscriptEntry(**raw))
        except Exception:
            continue
    return out


# ── analytics ─────────────────────────────────────────────────────────
@router.get("/{meeting_id}/analytics")
async def meeting_analytics(meeting_id: str, user: dict = Depends(get_current_user)):
    """
    Participation statistics for one meeting.

    Computed from the stored transcript, so it needs no API key and works
    whether or not AI reports were generated.
    """
    doc = await _load_meeting(meeting_id, user)
    entries = _entries(doc)

    if not entries:
        raise HTTPException(404, "this meeting has no transcript to analyse")

    result = analyse(entries).to_dict()
    result["meeting_id"] = meeting_id
    result["title"] = doc.get("title")
    return result


# ── semantic search ───────────────────────────────────────────────────
class AskRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=500)
    limit: int = Field(6, ge=1, le=20)


@router.post("/search")
async def semantic_search(body: AskRequest, user: dict = Depends(get_current_user)):
    """Retrieve transcript passages relevant to a question."""
    try:
        passages = await search_service.search(
            body.query, limit=body.limit, meeting_ids=await _visible_meeting_ids(user)
        )
    except SearchUnavailable as exc:
        raise HTTPException(503, str(exc))

    return {"query": body.query, "passages": [p.to_dict() for p in passages]}


@router.post("/ask")
async def ask_meetings(body: AskRequest, user: dict = Depends(get_current_user)):
    """Retrieve passages and compose an answer grounded in them."""
    try:
        return await search_service.answer(
            body.query, limit=body.limit, meeting_ids=await _visible_meeting_ids(user)
        )
    except SearchUnavailable as exc:
        raise HTTPException(503, str(exc))
    except AIUnavailable as exc:
        raise HTTPException(503, str(exc))


@router.post("/{meeting_id}/index")
async def index_meeting(meeting_id: str, user: dict = Depends(get_current_user)):
    """(Re)index a meeting for semantic search."""
    doc = await _load_meeting(meeting_id, user)
    entries = _entries(doc)
    if not entries:
        raise HTTPException(400, "nothing to index — this meeting has no transcript")

    try:
        count = await search_service.index_meeting(
            meeting_id, doc.get("title", ""), entries
        )
    except SearchUnavailable as exc:
        raise HTTPException(503, str(exc))

    return {"meeting_id": meeting_id, "chunks_indexed": count}


@router.post("/reindex-all")
async def reindex_all(user: dict = Depends(get_current_user)):
    """Rebuild the whole index. Useful after changing the embedding model."""
    if user["role"] != "admin":
        raise HTTPException(403, "admin only")

    total = 0
    meetings = 0
    async for doc in get_meetings_collection().find({}):
        entries = _entries(doc)
        if not entries:
            continue
        total += await search_service.index_meeting(
            doc["meeting_id"], doc.get("title", ""), entries
        )
        meetings += 1

    return {"meetings_indexed": meetings, "chunks_indexed": total}


@router.get("/search/status")
async def search_status(user: dict = Depends(get_current_user)):
    try:
        return await search_service.stats()
    except Exception as exc:
        return {"enabled": settings.SEMANTIC_SEARCH_ENABLED, "ready": False, "error": str(exc)}


# ── voice assistant ───────────────────────────────────────────────────
class AssistantAsk(BaseModel):
    question: str = Field(..., min_length=2, max_length=500)
    speak: bool = True


@router.get("/assistant/status")
async def assistant_status(user: dict = Depends(get_current_user)):
    return assistant_service.describe()


@router.post("/{meeting_id}/assistant/ask")
async def assistant_ask(
    meeting_id: str,
    body: AssistantAsk,
    user: dict = Depends(get_current_user),
):
    """Ask the assistant a typed question about the meeting in progress."""
    doc = await _load_meeting(meeting_id, user)
    try:
        reply = await assistant_service.ask(
            body.question,
            _entries(doc),
            meeting_id,
            searchable_meeting_ids=await _visible_meeting_ids(user),
            speak=body.speak,
        )
    except AIUnavailable as exc:
        raise HTTPException(503, str(exc))
    return reply.to_dict()


@router.post("/{meeting_id}/assistant/listen")
async def assistant_listen(
    meeting_id: str,
    audio: UploadFile = File(...),
    speak: bool = Form(True),
    require_wake_word: bool = Form(False),
    user: dict = Depends(get_current_user),
):
    """
    Transcribe a spoken question and answer it aloud.

    The client records a short clip while the user holds the assistant button,
    which is why no wake word is required by default — the button *is* the
    addressing gesture, and it keeps the meeting's audio off the STT endpoint
    unless someone deliberately asks for it.
    """
    doc = await _load_meeting(meeting_id, user)
    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "empty audio upload")

    try:
        heard = await assistant_service.transcribe(
            raw, audio.content_type or "audio/webm"
        )
    except AIUnavailable as exc:
        raise HTTPException(503, str(exc))

    if not heard:
        return {"heard": "", "answer": None, "note": "no speech detected"}

    question, addressed = assistant_service.strip_wake_word(heard)
    if require_wake_word and not addressed:
        return {"heard": heard, "answer": None, "note": "no wake word detected"}

    try:
        reply = await assistant_service.ask(
            question or heard,
            _entries(doc),
            meeting_id,
            searchable_meeting_ids=await _visible_meeting_ids(user),
            speak=speak,
        )
    except AIUnavailable as exc:
        raise HTTPException(503, str(exc))

    return {"heard": heard, **reply.to_dict()}


# ── email digest ──────────────────────────────────────────────────────
class DigestRequest(BaseModel):
    include_analytics: bool = True
    to: Optional[list[str]] = None  # override recipients; defaults to participants


@router.get("/email/status")
async def email_status(user: dict = Depends(get_current_user)):
    return {
        "configured": email_service.available,
        "from": settings.SMTP_FROM or None,
        "host": settings.SMTP_HOST or None,
    }


@router.post("/{meeting_id}/digest")
async def send_digest(
    meeting_id: str,
    body: DigestRequest,
    user: dict = Depends(get_current_user),
):
    """Email the summary, action items and participation stats to participants."""
    doc = await _load_meeting(meeting_id, user)

    if not email_service.available:
        raise HTTPException(
            503,
            "Email is not configured. Set SMTP_HOST, SMTP_PORT and SMTP_FROM "
            "in backend/.env to enable meeting digests.",
        )

    # Resolve participant usernames to addresses.
    usernames = {p.get("username") for p in doc.get("participants", [])}
    usernames.add(doc.get("created_by"))
    usernames.discard(None)

    recipients: list[Recipient] = []
    if body.to:
        recipients = [Recipient(username=a.split("@")[0], email=a) for a in body.to]
    else:
        users = get_users_collection()
        for name in usernames:
            record = await users.find_one({"username": name})
            if record and record.get("email"):
                recipients.append(Recipient(username=name, email=record["email"]))

    if not recipients:
        raise HTTPException(400, "no participants have an email address on file")

    entries = _entries(doc)
    analytics = analyse(entries).to_dict() if (body.include_analytics and entries) else None

    analysis = None
    if doc.get("ai_analysis"):
        try:
            analysis = AIAnalysis(**doc["ai_analysis"])
        except Exception:
            analysis = None

    duration = doc.get("duration_seconds")
    duration_text = f"{round(duration / 60)} min" if duration else "not recorded"

    try:
        result = await email_service.send_digest(
            meeting_title=doc.get("title", "Meeting"),
            meeting_id=meeting_id,
            date=str(doc.get("timestamp", ""))[:10],
            duration=duration_text,
            recipients=recipients,
            analysis=analysis,
            analytics=analytics,
            app_url=settings.APP_PUBLIC_URL,
        )
    except EmailUnavailable as exc:
        raise HTTPException(503, str(exc))

    return {"meeting_id": meeting_id, **result}
