"""
Meeting routes:
  POST   /meetings/              – create meeting
  GET    /meetings/              – list meetings (search)
  GET    /meetings/{id}          – get meeting details
  POST   /meetings/{id}/join     – join meeting (get LiveKit token)
  POST   /meetings/{id}/start    – host starts meeting
  POST   /meetings/{id}/end      – host ends meeting
  POST   /meetings/{id}/generate-report – trigger AI report
  DELETE /meetings/{id}          – delete meeting (host/admin)
  WS     /meetings/{id}/ws       – WebSocket for transcription + action detection

Waiting room (lobby):
  GET    /meetings/{id}/lobby                    – host: waiting/admitted lists + settings
  GET    /meetings/{id}/lobby/me                 – caller's own lobby status (polled)
  POST   /meetings/{id}/lobby/admit-all          – host: admit everyone waiting
  POST   /meetings/{id}/lobby/{username}/admit   – host: admit one person
  POST   /meetings/{id}/lobby/{username}/deny    – host: decline one person
  PATCH  /meetings/{id}/settings                 – host: waiting_room / locked / allow_*

Host controls (LiveKit RoomService):
  GET    /meetings/{id}/participants/live               – who is connected, with tracks
  POST   /meetings/{id}/participants/{identity}/mute    – host: server-mute audio|video
  POST   /meetings/{id}/participants/{identity}/remove  – host: kick + ban
  POST   /meetings/{id}/mute-all                        – host: mute every non-host mic

The meeting WebSocket also fans out `lobby_update`, `settings_update`,
`participant_removed` and `meeting_ended` so open clients react without polling.
"""

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
    status,
)

from core.security import get_current_user, require_host
from core.timeutils import as_datetime, elapsed_seconds
from db.mongodb import get_meetings_collection, get_users_collection
from fastapi.responses import JSONResponse

from models.meeting_model import (
    ActionStatus,
    CreateMeetingRequest,
    GenerateReportRequest,
    JoinByCodeRequest,
    JoinMeetingResponse,
    LobbyEntry,
    LobbyStatus,
    Meeting,
    MeetingSettings,
    MeetingStatus,
    MuteParticipantRequest,
    Participant,
    ParticipantRole,
    SearchQuery,
    UpdateSettingsRequest,
    generate_join_code,
)
from services.ai_analysis_service import ai_analysis_service
from services.livekit_service import (
    LiveKitNotFound,
    LiveKitUnavailable,
    livekit_service,
)
from services.transcription_service import transcription_service
from services.realtime import manager
from services.briefing_service import briefing_service
from services.agent_service import agent_service
from core.languages import DEFAULT_LANGUAGE, normalise

router = APIRouter(prefix="/meetings", tags=["meetings"])


# ── Live translation hook ─────────────────────────────────────────────────────
# Imported lazily and at most once. Translation is an add-on to transcription:
# if its module is missing, broken, or its provider is down, people must still
# get a transcript, so nothing here is allowed to raise into the socket loop.
_translation_cache: dict = {}


def _translation():
    """The translation service, or None when it cannot be imported (logged once)."""
    if "svc" not in _translation_cache:
        try:
            from services.translation_service import translation_service
            _translation_cache["svc"] = translation_service
        except Exception as exc:
            print(f"[translation] unavailable, transcripts will not be translated: "
                  f"{type(exc).__name__}: {exc}")
            _translation_cache["svc"] = None
    return _translation_cache["svc"]


async def _guarded(coro, what: str) -> None:
    """Run a detached hook so its failure is logged, not left unretrieved."""
    try:
        await coro
    except Exception as exc:
        print(f"[translation] {what} failed: {type(exc).__name__}: {exc}")


async def _resolve_spoken_language(meeting_id: str, username: str) -> Optional[str]:
    """
    What `username` is speaking in this meeting, as an app code.

    The translation service owns the per-meeting answer ("I'm speaking: X");
    failing that, the account's native language. None means nobody ever set
    one, and the stream then opens in DEEPGRAM_LANGUAGE exactly as it did
    before languages existed.
    """
    svc = _translation()
    if svc is not None:
        try:
            code = normalise(await svc.spoken_language(meeting_id, username), default=None)
            if code:
                return code
        except Exception as exc:
            print(f"[translation] spoken_language({username}) failed: "
                  f"{type(exc).__name__}: {exc}")
    try:
        user = await get_users_collection().find_one({"username": username})
        return normalise((user or {}).get("native_language"), default=None)
    except Exception:
        return None


def _speaker_language_message(meeting_id: str, username: str) -> dict:
    """
    `speaker_language` - who is speaking what. Broadcast on the meeting socket
    when a speaker connects and whenever they switch; anyone else announcing
    a switch (the translation REST route) should send the same shape through
    services.realtime.manager.broadcast:

        {"type": "speaker_language", "username": "priya", "language": "ta"}
    """
    code = transcription_service.speaker_language(meeting_id, username) or DEFAULT_LANGUAGE
    return {"type": "speaker_language", "username": username, "language": code}


# ── Helpers ───────────────────────────────────────────────────────────────────
def _serialize(doc: dict) -> dict:
    """Convert MongoDB document to JSON-serializable dict."""
    doc["_id"] = str(doc["_id"])
    return doc


async def _get_meeting_or_404(meeting_id: str) -> dict:
    col = get_meetings_collection()
    doc = await col.find_one({"meeting_id": meeting_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return doc


def _is_meeting_host(doc: dict, current_user: dict) -> bool:
    """Host = the account that created the meeting, or a platform admin."""
    return doc.get("created_by") == current_user["username"] or current_user.get("role") == "admin"


def _require_meeting_host(doc: dict, current_user: dict) -> None:
    if not _is_meeting_host(doc, current_user):
        raise HTTPException(status_code=403, detail="Only the host can do that")


def _settings_of(doc: dict) -> dict:
    """
    Effective settings, defaults filled in.

    Meetings created before the waiting room existed have no `settings` key
    at all, and a partially-written one may lack a flag; both read as the
    documented defaults rather than KeyError.
    """
    return MeetingSettings(**(doc.get("settings") or {})).model_dump()


def _lobby_of(doc: dict) -> list[dict]:
    return list(doc.get("lobby") or [])


def _banned_of(doc: dict) -> list[str]:
    return list(doc.get("banned") or [])


def _lobby_entry(lobby: list[dict], username: str) -> Optional[dict]:
    return next((e for e in lobby if e.get("username") == username), None)


def _iso(value) -> Optional[str]:
    """Timestamps come back as datetimes on Mongo and ISO strings on SQLite."""
    dt = as_datetime(value)
    return dt.isoformat() if dt else (value if isinstance(value, str) else None)


def _public_entry(entry: dict) -> dict:
    return {
        "username": entry.get("username"),
        "display_name": entry.get("display_name") or entry.get("username"),
        "requested_at": _iso(entry.get("requested_at")),
    }


async def _display_name_of(username: str) -> str:
    users = get_users_collection()
    user = await users.find_one({"username": username})
    return (user or {}).get("display_name") or username


async def _write_lobby(meeting_id: str, lobby: list[dict]) -> None:
    """
    Persist the whole lobby array and tell the room its size changed.

    The store has no $pull / $addToSet / positional update, so the array is
    replaced wholesale; with a handful of entries per meeting that is fine.
    """
    col = get_meetings_collection()
    await col.update_one({"meeting_id": meeting_id}, {"$set": {"lobby": lobby}})
    waiting = sum(1 for e in lobby if e.get("status") == LobbyStatus.WAITING.value)
    await manager.broadcast(meeting_id, {"type": "lobby_update", "waiting_count": waiting})


def _upsert_lobby(lobby: list[dict], username: str, display_name: str, status_: str) -> tuple[list[dict], bool]:
    """
    Return (new_lobby, changed). Idempotent: re-requesting while already
    "waiting" neither duplicates the entry nor bumps requested_at, so the
    host's queue keeps its original order.
    """
    existing = _lobby_entry(lobby, username)
    if existing:
        if existing.get("status") == status_:
            return lobby, False
        updated = dict(existing, status=status_)
        return [updated if e is existing else e for e in lobby], True
    entry = LobbyEntry(username=username, display_name=display_name, status=status_).model_dump(mode="json")
    return lobby + [entry], True


def _livekit_502(exc: LiveKitUnavailable) -> HTTPException:
    return HTTPException(status_code=502, detail=f"LiveKit is unavailable: {exc}")


# ── Create meeting ────────────────────────────────────────────────────────────
@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_meeting(
    payload: CreateMeetingRequest,
    current_user: dict = Depends(require_host),
):
    host = current_user["username"]

    # Invitations are by username, so an unknown name would otherwise be stored
    # as a participant who can never sign in - a roster entry for nobody. Say
    # which names were not recognised instead of failing silently.
    invited = [p.strip() for p in payload.participants if p and p.strip()]
    invited = [p for p in dict.fromkeys(invited) if p != host]
    if invited:
        users = get_users_collection()
        known = set()
        async for u in users.find({"username": {"$in": invited}}):
            known.add(u["username"])
        unknown = [p for p in invited if p not in known]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"No account for: {', '.join(unknown)}. "
                    "Invite registered usernames, or share the meeting code instead."
                ),
            )

    # The host is on the roster from the start; they created the meeting, and a
    # participant list that omits its own organiser reads as a bug.
    meeting = Meeting(
        title=payload.title,
        description=payload.description,
        created_by=host,
        participants=[Participant(username=host, role=ParticipantRole.HOST)]
        + [
            Participant(username=p, role=ParticipantRole.PARTICIPANT)
            for p in invited
        ],
        status=MeetingStatus.SCHEDULED,
    )

    col = get_meetings_collection()
    result = await col.insert_one(meeting.model_dump())

    # Create LiveKit room preemptively
    try:
        await livekit_service.create_room(meeting.room_name)
    except Exception as e:
        print(f"LiveKit room pre-creation failed: {e}")

    return {
        "meeting_id": meeting.meeting_id,
        "room_name": meeting.room_name,
        "join_code": meeting.join_code,
    }


# ── List / search meetings ────────────────────────────────────────────────────
@router.get("/")
async def list_meetings(
    q: Optional[str] = Query(None, description="Full-text search"),
    participant: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
):
    col = get_meetings_collection()
    query: dict = {}

    if q:
        query["$text"] = {"$search": q}
    if participant:
        query["participants.username"] = participant
    if status_filter:
        query["status"] = status_filter

    # Non-admin users see only their meetings
    if current_user["role"] not in ("admin",):
        query["$or"] = [
            {"created_by": current_user["username"]},
            {"participants.username": current_user["username"]},
        ]

    cursor = col.find(query).sort("timestamp", -1).skip(skip).limit(limit)
    meetings = []
    async for doc in cursor:
        doc["_id"] = str(doc["_id"])
        meetings.append(
            {
                "meeting_id": doc["meeting_id"],
                "join_code": doc.get("join_code"),
                "title": doc["title"],
                "created_by": doc["created_by"],
                "participants": [p["username"] for p in doc.get("participants", [])],
                "status": doc["status"],
                "timestamp": doc["timestamp"],
                "started_at": doc.get("started_at"),
                "ended_at": doc.get("ended_at"),
                "duration_seconds": doc.get("duration_seconds"),
                "has_report": bool(
                    doc.get("ai_analysis", {}).get("summary")
                    or doc.get("ai_analysis", {}).get("mom")
                ),
            }
        )
    return {"meetings": meetings, "skip": skip, "limit": limit}


# ── Get single meeting ────────────────────────────────────────────────────────
@router.get("/{meeting_id}")
async def get_meeting(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    doc = await _get_meeting_or_404(meeting_id)
    return _serialize(doc)


# ── Resolve a shareable code ──────────────────────────────────────────────────
# Kept above the "/{meeting_id}/..." routes: FastAPI matches in registration
# order, so a literal path must never sit behind a path parameter of the same
# shape. No POST "/{meeting_id}" exists today, but adding one later would
# otherwise silently capture this route.
@router.post("/join-by-code")
async def join_by_code(
    payload: JoinByCodeRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Turn a shared code into a meeting id.

    Anyone signed in who holds the code may enter - that is the point of a
    code - so this deliberately does not check the invite list. A meeting that
    has already ended is refused, because joining it would do nothing useful.
    """
    col = get_meetings_collection()
    doc = await col.find_one({"join_code": payload.code})
    if not doc:
        raise HTTPException(
            status_code=404,
            detail=f"No meeting found with code {payload.code}. Check it and try again.",
        )
    if doc.get("status") == MeetingStatus.ENDED.value:
        raise HTTPException(
            status_code=410,
            detail=f"'{doc['title']}' has already ended. Its report is on the meeting page.",
        )
    return {
        "meeting_id": doc["meeting_id"],
        "title": doc["title"],
        "join_code": doc.get("join_code"),
        "status": doc.get("status"),
        "created_by": doc.get("created_by"),
    }


# ── Join meeting (get LiveKit token) ──────────────────────────────────────────
@router.post(
    "/{meeting_id}/join",
    response_model=JoinMeetingResponse,
    responses={
        202: {"description": "Waiting for the host to admit you (no token)"},
        403: {"description": "Removed by the host, or request declined"},
        410: {"description": "Meeting has ended"},
        423: {"description": "Meeting is locked"},
    },
)
async def join_meeting(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Hand out a LiveKit token, or hold the caller in the waiting room.

    Order of checks matters: the host always gets in; a banned person is
    refused before anything else; an ended meeting is 410 regardless of the
    door policy; a locked door beats an "admitted" status; then the lobby
    decides. The 202 is deliberately not an error: the client keeps polling
    `lobby/me` and calls this again once admitted.
    """
    doc = await _get_meeting_or_404(meeting_id)
    username = current_user["username"]
    is_host = _is_meeting_host(doc, current_user)
    role = "host" if is_host else "participant"
    room_settings = _settings_of(doc)

    if not is_host:
        if username in _banned_of(doc):
            raise HTTPException(
                status_code=403, detail="You were removed from this meeting by the host."
            )
        if doc.get("status") in (MeetingStatus.ENDED.value, MeetingStatus.PROCESSED.value):
            raise HTTPException(status_code=410, detail="This meeting has ended.")

        lobby = _lobby_of(doc)
        entry = _lobby_entry(lobby, username)
        lobby_status = (entry or {}).get("status")
        admitted = lobby_status == LobbyStatus.ADMITTED.value

        if room_settings["locked"] and not admitted:
            raise HTTPException(status_code=423, detail="This meeting is locked by the host.")
        if lobby_status == LobbyStatus.DENIED.value:
            raise HTTPException(
                status_code=403, detail="The host declined your request to join."
            )
        if room_settings["waiting_room"] and not admitted:
            display_name = await _display_name_of(username)
            lobby, changed = _upsert_lobby(lobby, username, display_name, LobbyStatus.WAITING.value)
            if changed:
                await _write_lobby(meeting_id, lobby)
            return JSONResponse(
                status_code=202,
                content={
                    "status": "waiting",
                    "meeting_id": meeting_id,
                    "title": doc["title"],
                    "host": doc["created_by"],
                    "join_code": doc.get("join_code"),
                },
            )

        # Getting in with the waiting room off counts as admission, so if the
        # host switches it on mid-meeting a page refresh does not send someone
        # who was already in the call back to the lobby.
        if not admitted:
            display_name = await _display_name_of(username)
            lobby, changed = _upsert_lobby(lobby, username, display_name, LobbyStatus.ADMITTED.value)
            if changed:
                await _write_lobby(meeting_id, lobby)

    from core.config import settings as _s
    if not _s.livekit_configured:
        raise HTTPException(
            status_code=503,
            detail=(
                "LiveKit is not configured. Add LIVEKIT_API_KEY, "
                "LIVEKIT_API_SECRET, and LIVEKIT_URL to backend/.env. "
                "Get free credentials at https://cloud.livekit.io"
            ),
        )

    token = livekit_service.create_participant_token(
        room_name=doc["room_name"],
        participant_identity=username,
        is_host=is_host,
    )

    # Add to participants if not already present
    col = get_meetings_collection()
    await col.update_one(
        {"meeting_id": meeting_id, "participants.username": {"$ne": username}},
        {
            "$push": {
                "participants": {
                    "username": username,
                    "role": role,
                    "joined_at": datetime.now(timezone.utc),
                }
            }
        },
    )

    return JoinMeetingResponse(
        livekit_token=token,
        livekit_url=_s.LIVEKIT_URL,
        meeting_id=meeting_id,
        room_name=doc["room_name"],
        role=role,
        join_code=doc.get("join_code"),
    )


# ── Start meeting ─────────────────────────────────────────────────────────────
@router.post("/{meeting_id}/start")
async def start_meeting(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    doc = await _get_meeting_or_404(meeting_id)
    if doc["created_by"] != current_user["username"] and current_user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only host can start the meeting")

    col = get_meetings_collection()
    await col.update_one(
        {"meeting_id": meeting_id},
        {
            "$set": {
                "status": MeetingStatus.ACTIVE.value,
                "started_at": datetime.now(timezone.utc),
            }
        },
    )

    transcription_service.start_session(meeting_id)
    return {"status": "started", "meeting_id": meeting_id}


# ── End meeting ───────────────────────────────────────────────────────────────
@router.post("/{meeting_id}/end")
async def end_meeting(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    doc = await _get_meeting_or_404(meeting_id)
    if doc["created_by"] != current_user["username"] and current_user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only host can end the meeting")

    # Flush remaining audio buffers
    remaining = await transcription_service.flush_all_buffers(meeting_id)
    transcription_service.end_session(meeting_id)

    # Duration. started_at comes back from the database as an ISO string on the
    # SQLite backend and as a datetime on Mongo; subtracting the former raises.
    ended = datetime.now(timezone.utc)
    duration = elapsed_seconds(doc.get("started_at"), ended)

    col = get_meetings_collection()
    update: dict = {
        "$set": {
            "status": MeetingStatus.ENDED.value,
            "ended_at": ended,
            "duration_seconds": duration,
        }
    }
    if remaining:
        update["$push"] = {
            "transcript": {"$each": [e.dict() for e in remaining]}
        }

    await col.update_one({"meeting_id": meeting_id}, update)

    # Destroy LiveKit room
    try:
        await livekit_service.delete_room(doc["room_name"])
    except Exception:
        pass

    # Everyone else's client leaves to the dashboard on this; the LiveKit
    # disconnect alone is indistinguishable from a network blip.
    await manager.broadcast(meeting_id, {"type": "meeting_ended"})

    # Per-meeting in-memory state (offer history, audio sequencers, cue
    # cooldowns) has no further use once the meeting is over.
    for module, name in (
        ("services.translation_service", "translation_service"),
        ("services.briefing_service", "briefing_service"),
    ):
        try:
            getattr(__import__(module, fromlist=[name]), name).forget_meeting(meeting_id)
        except Exception as exc:
            print(f"[{name}] forget_meeting({meeting_id}) skipped: {exc}")

    return {"status": "ended", "meeting_id": meeting_id, "duration_seconds": duration}


# ── Generate AI report ────────────────────────────────────────────────────────
@router.post("/{meeting_id}/generate-report")
async def generate_report(
    meeting_id: str,
    payload: GenerateReportRequest,
    current_user: dict = Depends(get_current_user),
):
    doc = await _get_meeting_or_404(meeting_id)

    from models.meeting_model import TranscriptEntry, AIAnalysis
    transcript = [TranscriptEntry(**e) for e in doc.get("transcript", [])]

    if not transcript:
        raise HTTPException(status_code=422, detail="No transcript data available")

    participants = [p["username"] for p in doc.get("participants", [])]
    # Same coercion as above: calling .isoformat() straight off a stored value
    # raises AttributeError once that value is a string.
    date_str = (as_datetime(doc.get("timestamp")) or datetime.now(timezone.utc)).isoformat()

    existing = AIAnalysis(**doc.get("ai_analysis", {}))

    analysis = await ai_analysis_service.generate_full_report(
        title=doc["title"],
        date=date_str,
        participants=participants,
        transcript=transcript,
        report_types=payload.report_types,
        duration_seconds=doc.get("duration_seconds"),
        existing_analysis=existing,
    )

    col = get_meetings_collection()
    await col.update_one(
        {"meeting_id": meeting_id},
        {
            "$set": {
                "ai_analysis": analysis.dict(),
                "status": MeetingStatus.PROCESSED.value,
            }
        },
    )

    return {"status": "generated", "meeting_id": meeting_id, "analysis": analysis.dict()}


# ── Confirm next action ───────────────────────────────────────────────────────
@router.post("/{meeting_id}/actions/{action_id}/confirm")
async def confirm_action(
    meeting_id: str,
    action_id: str,
    current_user: dict = Depends(get_current_user),
):
    col = get_meetings_collection()
    result = await col.update_one(
        {
            "meeting_id": meeting_id,
            "ai_analysis.next_actions.id": action_id,
        },
        {
            "$set": {
                "ai_analysis.next_actions.$.status": ActionStatus.CONFIRMED.value,
                "ai_analysis.next_actions.$.confirmed_at": datetime.now(timezone.utc),
            }
        },
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Action not found")
    return {"status": "confirmed", "action_id": action_id}


# ── Reject next action ────────────────────────────────────────────────────────
@router.post("/{meeting_id}/actions/{action_id}/reject")
async def reject_action(
    meeting_id: str,
    action_id: str,
    current_user: dict = Depends(get_current_user),
):
    col = get_meetings_collection()
    await col.update_one(
        {
            "meeting_id": meeting_id,
            "ai_analysis.next_actions.id": action_id,
        },
        {"$set": {"ai_analysis.next_actions.$.status": ActionStatus.REJECTED.value}},
    )
    return {"status": "rejected", "action_id": action_id}


# ── Delete meeting ────────────────────────────────────────────────────────────
@router.delete("/{meeting_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_meeting(
    meeting_id: str,
    current_user: dict = Depends(require_host),
):
    doc = await _get_meeting_or_404(meeting_id)
    if doc["created_by"] != current_user["username"] and current_user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")

    col = get_meetings_collection()
    await col.delete_one({"meeting_id": meeting_id})

    # Briefing documents are private uploads tied to this meeting; they (their
    # vectors and files on disk) go with it rather than lingering unreachable.
    try:
        from services.document_service import document_service
        await document_service.delete_meeting_docs(meeting_id)
    except Exception as exc:
        print(f"[briefing] cleanup for deleted meeting {meeting_id} skipped: {exc}")


# ══════════════════════════════════════════════════════════════════════════════
# Waiting room (lobby)
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/{meeting_id}/lobby")
async def get_lobby(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Host view of the door: who is waiting, who has been let in, and the policy."""
    doc = await _get_meeting_or_404(meeting_id)
    _require_meeting_host(doc, current_user)
    lobby = _lobby_of(doc)
    return {
        "waiting": [_public_entry(e) for e in lobby if e.get("status") == LobbyStatus.WAITING.value],
        "admitted": [_public_entry(e) for e in lobby if e.get("status") == LobbyStatus.ADMITTED.value],
        "settings": _settings_of(doc),
    }


# Literal "/lobby/me" and "/lobby/admit-all" sit above "/lobby/{username}/..."
# for the same reason join-by-code sits above "/{meeting_id}": registration
# order is match order.
@router.get("/{meeting_id}/lobby/me")
async def my_lobby_status(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    The waiting client polls this every couple of seconds.

    The host is always "admitted". Someone the host removed reads as "denied"
    so their client stops polling and shows the refusal, rather than "none",
    which would make it request again and bounce off the 403.
    """
    doc = await _get_meeting_or_404(meeting_id)
    username = current_user["username"]
    room_settings = _settings_of(doc)

    if _is_meeting_host(doc, current_user):
        status_ = LobbyStatus.ADMITTED.value
    elif username in _banned_of(doc):
        status_ = LobbyStatus.DENIED.value
    else:
        entry = _lobby_entry(_lobby_of(doc), username)
        status_ = entry.get("status") if entry else "none"

    return {
        "status": status_,
        "title": doc["title"],
        "host": doc["created_by"],
        "locked": room_settings["locked"],
        "meeting_status": doc.get("status"),
    }


@router.post("/{meeting_id}/lobby/admit-all")
async def admit_all(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    doc = await _get_meeting_or_404(meeting_id)
    _require_meeting_host(doc, current_user)
    lobby = _lobby_of(doc)
    admitted = [e["username"] for e in lobby if e.get("status") == LobbyStatus.WAITING.value]
    if admitted:
        lobby = [
            dict(e, status=LobbyStatus.ADMITTED.value)
            if e.get("status") == LobbyStatus.WAITING.value else e
            for e in lobby
        ]
        await _write_lobby(meeting_id, lobby)
    return {"admitted": admitted}


@router.post("/{meeting_id}/lobby/{username}/admit")
async def admit_participant(
    meeting_id: str,
    username: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Let one person in. Works for a name that has not asked yet, too: the
    host pre-approving someone means their first join goes straight through.
    """
    doc = await _get_meeting_or_404(meeting_id)
    _require_meeting_host(doc, current_user)
    display_name = await _display_name_of(username)
    lobby, changed = _upsert_lobby(_lobby_of(doc), username, display_name, LobbyStatus.ADMITTED.value)
    if changed:
        await _write_lobby(meeting_id, lobby)
    return {"status": "admitted"}


@router.post("/{meeting_id}/lobby/{username}/deny")
async def deny_participant(
    meeting_id: str,
    username: str,
    current_user: dict = Depends(get_current_user),
):
    doc = await _get_meeting_or_404(meeting_id)
    _require_meeting_host(doc, current_user)
    display_name = await _display_name_of(username)
    lobby, changed = _upsert_lobby(_lobby_of(doc), username, display_name, LobbyStatus.DENIED.value)
    if changed:
        await _write_lobby(meeting_id, lobby)
    return {"status": "denied"}


@router.patch("/{meeting_id}/settings")
async def update_settings(
    meeting_id: str,
    payload: UpdateSettingsRequest,
    current_user: dict = Depends(get_current_user),
):
    """Partial update; unspecified flags keep their current value."""
    doc = await _get_meeting_or_404(meeting_id)
    _require_meeting_host(doc, current_user)
    merged = {**_settings_of(doc), **payload.model_dump(exclude_unset=True, exclude_none=True)}
    merged = MeetingSettings(**merged).model_dump()

    col = get_meetings_collection()
    await col.update_one({"meeting_id": meeting_id}, {"$set": {"settings": merged}})
    await manager.broadcast(meeting_id, {"type": "settings_update", "settings": merged})
    return merged


# ══════════════════════════════════════════════════════════════════════════════
# Host controls (LiveKit RoomService)
# ══════════════════════════════════════════════════════════════════════════════

def _require_member(doc: dict, current_user: dict) -> None:
    """Anyone on the roster (or the host/admin); not someone still in the lobby."""
    if _is_meeting_host(doc, current_user):
        return
    username = current_user["username"]
    if any(p.get("username") == username for p in doc.get("participants", [])):
        return
    raise HTTPException(status_code=403, detail="You are not a participant of this meeting")


@router.get("/{meeting_id}/participants/live")
async def live_participants(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Who is actually connected to the LiveKit room right now, with their tracks."""
    doc = await _get_meeting_or_404(meeting_id)
    _require_member(doc, current_user)
    try:
        live = await livekit_service.list_live_participants(doc["room_name"])
    except LiveKitUnavailable as exc:
        raise _livekit_502(exc)
    host = doc.get("created_by")
    for p in live:
        p["is_host"] = p["identity"] == host
    return {"participants": live}


@router.post("/{meeting_id}/participants/{identity}/mute")
async def mute_participant(
    meeting_id: str,
    identity: str,
    payload: Optional[MuteParticipantRequest] = None,
    current_user: dict = Depends(get_current_user),
):
    """Server-side mute of one person's mic or camera. They can unmute themselves."""
    doc = await _get_meeting_or_404(meeting_id)
    _require_meeting_host(doc, current_user)
    try:
        kind = payload.kind if payload else "audio"
        await livekit_service.mute_participant(doc["room_name"], identity, kind)
    except LiveKitNotFound:
        raise HTTPException(status_code=404, detail=f"{identity} is not in the room")
    except LiveKitUnavailable as exc:
        raise _livekit_502(exc)
    return {"status": "muted"}


@router.post("/{meeting_id}/participants/{identity}/remove")
async def remove_participant(
    meeting_id: str,
    identity: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Kick someone out and keep them out.

    The LiveKit disconnect is the visible part; the ban is what stops them
    walking straight back in with a still-valid token or a fresh join call.
    Their lobby entry goes too, so the host's admitted list stays honest.
    """
    doc = await _get_meeting_or_404(meeting_id)
    _require_meeting_host(doc, current_user)
    if identity == doc.get("created_by"):
        raise HTTPException(status_code=400, detail="The host cannot remove themselves")

    try:
        await livekit_service.remove_participant(doc["room_name"], identity)
    except LiveKitUnavailable as exc:
        raise _livekit_502(exc)

    now = datetime.now(timezone.utc)
    banned = _banned_of(doc)
    if identity not in banned:
        banned.append(identity)
    participants = [
        dict(p, left_at=now) if p.get("username") == identity else p
        for p in doc.get("participants", [])
    ]
    lobby = [e for e in _lobby_of(doc) if e.get("username") != identity]

    col = get_meetings_collection()
    await col.update_one(
        {"meeting_id": meeting_id},
        {"$set": {"banned": banned, "participants": participants, "lobby": lobby}},
    )
    await manager.broadcast(meeting_id, {"type": "participant_removed", "username": identity})
    waiting = sum(1 for e in lobby if e.get("status") == LobbyStatus.WAITING.value)
    await manager.broadcast(meeting_id, {"type": "lobby_update", "waiting_count": waiting})
    return {"status": "removed"}


@router.post("/{meeting_id}/mute-all")
async def mute_all(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Mute every microphone except the host's (and the caller's, if an admin)."""
    doc = await _get_meeting_or_404(meeting_id)
    _require_meeting_host(doc, current_user)
    exclude = {doc.get("created_by"), current_user["username"]}
    try:
        muted = await livekit_service.mute_all_audio(doc["room_name"], exclude)
    except LiveKitUnavailable as exc:
        raise _livekit_502(exc)
    return {"muted": muted}


# ══════════════════════════════════════════════════════════════════════════════
# WebSocket endpoint – real-time audio transcription + action detection
# ══════════════════════════════════════════════════════════════════════════════

# Shared with services that push to the room on their own (document cues,
# the delegate agent), so it lives in services.realtime.


@router.websocket("/{meeting_id}/ws")
async def meeting_websocket(
    websocket: WebSocket,
    meeting_id: str,
):
    """
    WebSocket protocol:
      Client → Server:  binary (audio chunk) OR JSON text message
      Server → Client:  JSON messages:
        {type: "transcript", entry: {...}}
        {type: "action_detected", result: {...}}
        {type: "lobby_update", waiting_count: n}
        {type: "settings_update", settings: {...}}
        {type: "participant_removed", username: "..."}
        {type: "speaker_language", username: "...", language: "ta"}
        {type: "meeting_ended"}
        {type: "error", message: "..."}

    Text JSON commands from client:
      {cmd: "identify", username: "...", token: "..."}
      {cmd: "audio_config", format: "webm|pcm", sample_rate: 16000}
      {cmd: "set_language", language: "ta"}   – "I'm speaking: Tamil"
    """
    await websocket.accept()
    print(f"WebSocket connection initiated for {meeting_id}")

    username = "anonymous"
    is_webm = True
    
    try:
        # Check if meeting exists
        try:
            doc = await _get_meeting_or_404(meeting_id)
        except Exception:
            await websocket.send_json({"type": "error", "message": "Meeting not found"})
            await websocket.close(code=4004)
            return

        col = get_meetings_collection()

        # Expect identify command first
        identify_raw = await websocket.receive_text()
        identify = json.loads(identify_raw)

        if identify.get("cmd") == "identify":
            username = identify.get("username", "anonymous")
            token = identify.get("token", "")
            # Validate JWT
            try:
                from core.security import decode_token
                payload = decode_token(token)
                username = payload["sub"]
            except Exception:
                await websocket.send_json({"type": "error", "message": "Invalid token"})
                await websocket.close(code=4001)
                return

        # Registered only after identify, so the roster carries the real
        # username rather than the "anonymous" placeholder.
        manager.connect(meeting_id, websocket, username)
        print(f"WebSocket connected: {username} in meeting {meeting_id}")
        await websocket.send_json({"type": "connected", "username": username})

        # Tell the client up front whether speech-to-text can actually run.
        # Without this the transcript panel is empty for two indistinguishable
        # reasons: nobody has spoken, or the provider is unreachable.
        await websocket.send_json({
            "type": "transcription_status",
            **transcription_service.status,
        })

        async def publish_entry(entry) -> None:
            """Persist one transcript entry, fan it out, and look for actions."""
            await col.update_one(
                {"meeting_id": meeting_id},
                {"$push": {"transcript": entry.dict()}},
            )
            await manager.broadcast(
                meeting_id, {"type": "transcript", "entry": entry.dict()}
            )

            async def run_detection(e, ctx):
                try:
                    action = await ai_analysis_service.detect_next_action(e, ctx)
                    if action.trigger:
                        if action.next_action:
                            await col.update_one(
                                {"meeting_id": meeting_id},
                                {"$push": {"ai_analysis.next_actions": action.next_action.dict()}},
                            )
                        await manager.broadcast(
                            meeting_id,
                            {"type": "action_detected", "result": action.dict()},
                        )
                except Exception as exc:
                    print(f"Action detection error: {exc}")

            # Detection runs detached so a slow model never stalls transcription.
            updated = await col.find_one(
                {"meeting_id": meeting_id}, {"transcript": {"$slice": -15}}
            )
            context = [from_dict(it) for it in (updated or {}).get("transcript", [])]
            asyncio.create_task(run_detection(entry, context))

            # Private, per-owner listeners: document cues for anyone who
            # uploaded a briefing doc, and the delegate agent for owners who
            # address it. Both swallow their own errors.
            asyncio.create_task(briefing_service.on_transcript(meeting_id, entry, context))
            asyncio.create_task(agent_service.on_transcript(meeting_id, entry, context))

            # Live translation for listeners who speak another language.
            translation = _translation()
            if translation is not None:
                asyncio.create_task(_guarded(
                    translation.on_transcript(meeting_id, entry, context),
                    "on_transcript",
                ))

        async def sweep_idle_buffers() -> None:
            """
            Flush buffers that have gone quiet.

            Audio was previously only ever sent when the *next* chunk arrived,
            so the last thing a person said before falling silent stayed in the
            buffer until the meeting ended. This timer closes that gap.
            """
            try:
                while True:
                    await asyncio.sleep(0.75)
                    for entry in await transcription_service.flush_stale(meeting_id):
                        await publish_entry(entry)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"Idle-flush sweep stopped: {type(exc).__name__}: {exc}")

        # Prefer streaming. Deepgram keeps decoder state across the whole
        # stream, so the browser's headerless WebM fragments are handled
        # natively instead of being reassembled here.
        # Decode this speaker in the language they declared. Auto-detection
        # mislabels Tamil as English, so it is never left to Deepgram to guess.
        spoken = await _resolve_spoken_language(meeting_id, username)
        live = await transcription_service.open_live_session(
            meeting_id, username, publish_entry, language=spoken
        )

        # Everyone learns what the newcomer speaks, and the newcomer learns
        # what everyone already here speaks - listeners need both to decide
        # what to translate.
        await manager.broadcast(meeting_id, _speaker_language_message(meeting_id, username))
        for other in manager.usernames(meeting_id) - {username}:
            await websocket.send_json(_speaker_language_message(meeting_id, other))

        async def set_language(raw) -> None:
            code = normalise(raw if isinstance(raw, str) else None, default=None)
            if code is None:
                await websocket.send_json({
                    "type": "error", "message": f"Unknown language {raw!r}",
                })
                return
            await transcription_service.set_speaker_language(meeting_id, username, code)
            translation = _translation()
            if translation is not None and hasattr(translation, "set_spoken_language"):
                try:
                    result = translation.set_spoken_language(meeting_id, username, code)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception as exc:
                    print(f"[translation] set_spoken_language failed: "
                          f"{type(exc).__name__}: {exc}")
            await manager.broadcast(meeting_id, _speaker_language_message(meeting_id, username))

        # The idle sweeper only has work to do on the buffered path; streaming
        # does its own utterance segmentation.
        sweeper = None if live else asyncio.create_task(sweep_idle_buffers())

        while True:
            message = await websocket.receive()

            if message["type"] == "websocket.disconnect":
                print(f"WebSocket Disconnected: {username}")
                break

            # Handle text commands
            if "text" in message:
                data = json.loads(message["text"])
                if data.get("cmd") == "audio_config":
                    print(f"Audio Config received: {data}")
                    is_webm = data.get("format", "webm") == "webm"
                elif data.get("cmd") == "set_language":
                    await set_language(data.get("language"))

            # Handle binary audio data
            elif "bytes" in message and message["bytes"]:
                if live is not None:
                    await live.feed(message["bytes"])
                else:
                    entry = await transcription_service.process_audio_chunk(
                        meeting_id=meeting_id,
                        speaker_id=username,
                        audio_data=message["bytes"],
                        is_webm=is_webm,
                    )
                    if entry:
                        await publish_entry(entry)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        # locals() because an early return (bad token, missing meeting) can
        # reach this block before the sweeper is ever created.
        # locals() because an early return (bad token, missing meeting) can
        # reach this block before either of these exists.
        sweeper = locals().get("sweeper")
        if sweeper is not None:
            sweeper.cancel()

        live = locals().get("live")
        if live is not None:
            # Closing flushes whatever Deepgram is still holding, so the last
            # thing said before someone leaves still reaches the transcript.
            await live.close()

        manager.disconnect(meeting_id, websocket)


def from_dict(d: dict):
    from models.meeting_model import TranscriptEntry
    return TranscriptEntry(**d)
