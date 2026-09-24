"""
Routes for briefing documents and the cues they drive.

Everything here is private to the caller: a participant sees, deletes and
asks only their *own* documents for a meeting, even though every participant
can reach the meeting itself. The meeting access check still runs first, so a
stranger cannot probe meeting ids by uploading to them.

Nothing here needs a key to work. Without the embedding model retrieval is
lexical; without an LLM the cues are extractive. `available` in the list
response tells the client which of those it is getting.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from core.security import get_current_user
from db.mongodb import get_meetings_collection
from services.briefing_service import briefing_service
from services.document_service import MAX_BYTES, DocumentError, document_service

router = APIRouter(prefix="/briefing", tags=["briefing"])


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


@router.post("/{meeting_id}/docs")
async def upload_doc(
    meeting_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Upload a PDF, PPTX, DOCX, TXT or MD file as a private briefing document."""
    await _load_meeting(meeting_id, user)

    # Read one byte past the limit: enough to know it is too large without
    # buffering an arbitrarily large upload into memory.
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"Documents are limited to {MAX_BYTES // (1024 * 1024)} MB.")

    try:
        return await document_service.add_doc(
            meeting_id, user["username"], file.filename or "document", data, file.content_type
        )
    except DocumentError as exc:
        raise HTTPException(exc.status_code, str(exc))


@router.get("/{meeting_id}/docs")
async def list_docs(meeting_id: str, user: dict = Depends(get_current_user)):
    await _load_meeting(meeting_id, user)
    return {
        "docs": await document_service.list_docs(meeting_id, user["username"]),
        "settings": await briefing_service.get_settings(meeting_id, user["username"]),
        "available": briefing_service.describe(),
    }


@router.delete("/{meeting_id}/docs/{doc_id}")
async def delete_doc(meeting_id: str, doc_id: str, user: dict = Depends(get_current_user)):
    await _load_meeting(meeting_id, user)
    if not await document_service.delete_doc(meeting_id, doc_id, user["username"]):
        raise HTTPException(404, "document not found")
    return {"status": "deleted"}


class SettingsBody(BaseModel):
    enabled: bool = True
    sensitivity: Literal["low", "medium", "high"] = "medium"


@router.put("/{meeting_id}/settings")
async def put_settings(
    meeting_id: str, body: SettingsBody, user: dict = Depends(get_current_user)
):
    await _load_meeting(meeting_id, user)
    return await briefing_service.put_settings(
        meeting_id, user["username"], body.enabled, body.sensitivity
    )


class AskBody(BaseModel):
    question: str = Field(..., min_length=2, max_length=500)


@router.post("/{meeting_id}/ask")
async def ask_docs(meeting_id: str, body: AskBody, user: dict = Depends(get_current_user)):
    """Ask your own documents directly. Returns a cue; pushes nothing over WS."""
    await _load_meeting(meeting_id, user)
    return await briefing_service.ask(meeting_id, user["username"], body.question)
