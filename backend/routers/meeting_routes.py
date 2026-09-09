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
from db.mongodb import get_meetings_collection, get_users_collection
from models.meeting_model import (
    ActionStatus,
    CreateMeetingRequest,
    GenerateReportRequest,
    JoinByCodeRequest,
    JoinMeetingResponse,
    Meeting,
    MeetingStatus,
    Participant,
    ParticipantRole,
    SearchQuery,
    generate_join_code,
)
from services.ai_analysis_service import ai_analysis_service
from services.livekit_service import livekit_service
from services.transcription_service import transcription_service

router = APIRouter(prefix="/meetings", tags=["meetings"])


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
@router.post("/{meeting_id}/join", response_model=JoinMeetingResponse)
async def join_meeting(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
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

    doc = await _get_meeting_or_404(meeting_id)
    username = current_user["username"]
    is_host = doc["created_by"] == username or current_user["role"] == "admin"
    role = "host" if is_host else "participant"

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

    # Calculate duration
    started = doc.get("started_at")
    ended = datetime.now(timezone.utc)
    duration = int((ended - started).total_seconds()) if started else None

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
    date_str = doc.get("timestamp", datetime.now(timezone.utc)).isoformat()
    if hasattr(date_str, "isoformat"):
        date_str = date_str.isoformat()

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


# ══════════════════════════════════════════════════════════════════════════════
# WebSocket endpoint – real-time audio transcription + action detection
# ══════════════════════════════════════════════════════════════════════════════

class ConnectionManager:
    """Track active WebSocket connections per meeting room."""

    def __init__(self):
        # meeting_id → list of (websocket, username)
        self.active: dict[str, list] = {}

    def connect(self, meeting_id: str, ws: WebSocket, username: str):
        self.active.setdefault(meeting_id, []).append((ws, username))

    def disconnect(self, meeting_id: str, ws: WebSocket):
        self.active[meeting_id] = [
            conn for conn in self.active.get(meeting_id, []) if conn[0] != ws
        ]

    async def broadcast(self, meeting_id: str, message: dict, exclude: WebSocket = None):
        for ws, _ in self.active.get(meeting_id, []):
            if ws != exclude:
                try:
                    await ws.send_json(message)
                except Exception:
                    pass


manager = ConnectionManager()


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
        {type: "error", message: "..."}

    Text JSON commands from client:
      {cmd: "identify", username: "...", token: "..."}
      {cmd: "audio_config", format: "webm|pcm", sample_rate: 16000}
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
        live = await transcription_service.open_live_session(
            meeting_id, username, publish_entry
        )

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
