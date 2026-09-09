"""
Pydantic models for the meetings domain.
All models use strict typing and validation.
"""

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field, field_validator
import secrets
import uuid


# ── Join codes ────────────────────────────────────────────────────────────────
# Ambiguous glyphs are excluded so a code read aloud or copied from a screen
# survives the trip: no 0/O, no 1/I/L.
_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def generate_join_code() -> str:
    """A short, human-shareable meeting code, formatted `abc-defg-hij`."""
    picks = [secrets.choice(_CODE_ALPHABET) for _ in range(10)]
    body = "".join(picks)
    return f"{body[:3]}-{body[3:7]}-{body[7:]}"


def normalise_join_code(raw: str) -> str:
    """
    Accept what people actually paste.

    Codes arrive with stray spaces, in upper case, without the hyphens, or as a
    whole invite URL. All of those should resolve to the same meeting rather
    than producing a 'not found' the user cannot explain.
    """
    text = (raw or "").strip()
    if "/" in text:                       # a pasted invite link
        text = text.rstrip("/").split("/")[-1]
    text = text.split("?")[0]
    cleaned = "".join(c for c in text.lower() if c in _CODE_ALPHABET)
    if len(cleaned) != 10:
        return ""
    return f"{cleaned[:3]}-{cleaned[3:7]}-{cleaned[7:]}"


# ── Enumerations ──────────────────────────────────────────────────────────────
class MeetingStatus(str, Enum):
    SCHEDULED = "scheduled"
    ACTIVE = "active"
    ENDED = "ended"
    PROCESSED = "processed"


class ActionStatus(str, Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    CANCELLED = "cancelled"


class SentimentLabel(str, Enum):
    POSITIVE = "positive"
    NEUTRAL = "neutral"
    NEGATIVE = "negative"


class ParticipantRole(str, Enum):
    HOST = "host"
    PARTICIPANT = "participant"


# ── Sub-models ────────────────────────────────────────────────────────────────
class TranscriptEntry(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    speaker: str
    text: str
    # HH:MM:SS from meeting start. Optional on input: the server derives it
    # from the meeting's start time so callers appending a correction do not
    # have to compute an offset by hand.
    time: str = "00:00:00"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    timestamp_ms: Optional[int] = None  # milliseconds from meeting start


class NextAction(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    task: str
    description: Optional[str] = None
    assignee: Optional[str] = None
    date: Optional[str] = None  # natural language or ISO-8601
    deadline: Optional[str] = None
    status: ActionStatus = ActionStatus.PENDING
    confidence: float = Field(default=0.9, ge=0.0, le=1.0)
    calendar_event_id: Optional[str] = None  # set after Google Calendar push
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    confirmed_at: Optional[datetime] = None


class SentimentResult(BaseModel):
    overall: SentimentLabel = SentimentLabel.NEUTRAL
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    key_shifts: List[str] = []
    emotional_tone: Optional[str] = None


class AIAnalysis(BaseModel):
    summary: Optional[str] = None
    mom: Optional[str] = None  # Minutes of Meeting (Markdown)
    sentiment: Optional[SentimentResult] = None
    next_actions: List[NextAction] = []
    keywords: List[str] = []
    topics: List[str] = []
    generated_at: Optional[datetime] = None


class Participant(BaseModel):
    username: str
    display_name: Optional[str] = None
    role: ParticipantRole = ParticipantRole.PARTICIPANT
    joined_at: Optional[datetime] = None
    left_at: Optional[datetime] = None


# ── Main Meeting model ────────────────────────────────────────────────────────
class Meeting(BaseModel):
    meeting_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str
    description: Optional[str] = None
    room_name: str = Field(default_factory=lambda: f"room-{uuid.uuid4().hex[:8]}")
    # Shareable code so people can join without being invited by username.
    join_code: str = Field(default_factory=generate_join_code)
    created_by: str  # username of host
    participants: List[Participant] = []
    status: MeetingStatus = MeetingStatus.SCHEDULED
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))  # scheduled/created at
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    transcript: List[TranscriptEntry] = []
    ai_analysis: AIAnalysis = Field(default_factory=AIAnalysis)
    recording_url: Optional[str] = None
    duration_seconds: Optional[int] = None

    model_config = {
        "use_enum_values": True,
        "populate_by_name": True,
    }


# ── Request / Response schemas ────────────────────────────────────────────────
class CreateMeetingRequest(BaseModel):
    title: str = Field(..., min_length=3, max_length=200)
    description: Optional[str] = None
    participants: List[str] = []  # list of usernames


class JoinMeetingResponse(BaseModel):
    livekit_token: str
    livekit_url: str
    meeting_id: str
    room_name: str
    role: str
    join_code: Optional[str] = None


class JoinByCodeRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=120)

    @field_validator("code")
    @classmethod
    def _clean(cls, v: str) -> str:
        code = normalise_join_code(v)
        if not code:
            raise ValueError(
                "That does not look like a meeting code. Expected 10 characters, "
                "for example abc-defg-hij."
            )
        return code


class TranscriptChunk(BaseModel):
    meeting_id: str
    entry: TranscriptEntry


class ActionDetectionResult(BaseModel):
    trigger: bool
    type: Optional[str] = None  # "schedule" | "commitment" | "deadline" | "task"
    confidence: float = 0.0
    suggested_action: Optional[str] = None
    raw_text: Optional[str] = None
    next_action: Optional[NextAction] = None


class GenerateReportRequest(BaseModel):
    report_types: List[str] = Field(
        default=["summary", "mom", "sentiment"],
        description="Which report sections to generate",
    )


class MeetingListItem(BaseModel):
    meeting_id: str
    join_code: Optional[str] = None
    title: str
    created_by: str
    participants: List[str]
    status: str
    timestamp: datetime
    started_at: Optional[datetime]
    ended_at: Optional[datetime]
    duration_seconds: Optional[int]
    has_report: bool


class SearchQuery(BaseModel):
    q: Optional[str] = None  # full-text search
    participant: Optional[str] = None
    status: Optional[str] = None
    from_date: Optional[datetime] = None
    to_date: Optional[datetime] = None
    skip: int = Field(default=0, ge=0)
    limit: int = Field(default=20, ge=1, le=100)


# ── User models ───────────────────────────────────────────────────────────────
class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_-]+$")
    email: str
    password: str = Field(..., min_length=8)
    display_name: Optional[str] = None
    role: str = "participant"  # host | participant


class UserLogin(BaseModel):
    username: str
    password: str


class UserResponse(BaseModel):
    username: str
    email: str
    display_name: Optional[str]
    role: str
    created_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int  # seconds
