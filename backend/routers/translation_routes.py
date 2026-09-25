"""
Routes for live translation preferences.

Preferences are per person per meeting: the same account can want Hindi in
one meeting and English in the next, or speak Tamil to one team and English
to another. Everything here is about the *caller's* own settings; the only
thing visible about other people is which language they are speaking, which
everyone in the room already hears.

Nothing here needs a key. Without an LLM the translation hook stays idle,
and without server TTS the client speaks translations with browser voices -
`tts` in the languages response tells the client which it is getting.
"""

from __future__ import annotations

import inspect
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.languages import LANGUAGES, normalise
from core.security import get_current_user
from db.mongodb import get_meetings_collection
from services.realtime import manager
from services.translation_service import translation_service

router = APIRouter(prefix="/translation", tags=["translation"])


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


def _code(value: str, field: str) -> str:
    code = normalise(value, default=None)
    if code is None:
        raise HTTPException(
            422, f"{field}: unknown language {value!r}. Use one of: {', '.join(sorted(LANGUAGES))}."
        )
    return code


@router.get("/languages")
async def languages():
    """Public: the register page needs the list before an account exists."""
    return {
        "languages": [lang.to_dict() for lang in LANGUAGES.values()],
        "tts": translation_service.describe(),
    }


@router.get("/{meeting_id}/prefs")
async def get_prefs(meeting_id: str, user: dict = Depends(get_current_user)):
    await _load_meeting(meeting_id, user)
    return await translation_service.get_prefs(meeting_id, user["username"])


class PrefsBody(BaseModel):
    """Partial update: only fields present in the body change. An explicit
    null for spoken_language / target_language resets it to the native one."""
    spoken_language: Optional[str] = None
    enabled: Optional[bool] = None
    target_language: Optional[str] = None
    voice: Optional[bool] = None
    original_volume: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    declined: Optional[List[str]] = Field(default=None, max_length=len(LANGUAGES))


@router.put("/{meeting_id}/prefs")
async def put_prefs(meeting_id: str, body: PrefsBody, user: dict = Depends(get_current_user)):
    await _load_meeting(meeting_id, user)
    username = user["username"]
    sent = body.model_fields_set

    changes: dict = {}
    for name in ("spoken_language", "target_language"):
        if name in sent:
            value = getattr(body, name)
            changes[name] = _code(value, name) if value else None
    for name in ("enabled", "voice", "original_volume"):
        if name in sent and getattr(body, name) is not None:
            changes[name] = getattr(body, name)
    if "declined" in sent:
        changes["declined"] = sorted({_code(c, "declined") for c in body.declined or []})

    before = (await translation_service.get_prefs(meeting_id, username))["effective_spoken_language"]
    prefs = await translation_service.update_prefs(meeting_id, username, changes)
    if prefs["enabled"]:
        translation_service.warm()
    after = prefs["effective_spoken_language"]

    if after != before:
        # The speech-to-text side reopens this person's stream in the new
        # language. Imported lazily and tolerated missing: a failed switch
        # still leaves the preference saved for their next stream.
        try:
            from services.transcription_service import transcription_service
            result = transcription_service.set_speaker_language(meeting_id, username, after)
            if inspect.isawaitable(result):
                await result
        except Exception as exc:
            print(f"[translation] speaker language switch failed: {type(exc).__name__}: {exc}")
        await manager.broadcast(
            meeting_id, {"type": "speaker_language", "username": username, "language": after}
        )
    return prefs


@router.get("/{meeting_id}/speakers")
async def speakers(meeting_id: str, user: dict = Depends(get_current_user)):
    """Who is connected right now and what each is speaking."""
    await _load_meeting(meeting_id, user)
    out = []
    for username in sorted(manager.usernames(meeting_id)):
        out.append({
            "username": username,
            "display_name": await translation_service.display_name(username),
            "language": await translation_service.spoken_language(meeting_id, username),
        })
    return {"speakers": out}
