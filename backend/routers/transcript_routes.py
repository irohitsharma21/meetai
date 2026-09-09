"""
Transcript routes:
  GET  /transcripts/{meeting_id}       – get full transcript
  POST /transcripts/{meeting_id}/entry  – manually add transcript entry
  GET  /transcripts/{meeting_id}/export – export as TXT/JSON
"""

from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse

from core.security import get_current_user
from db.mongodb import get_meetings_collection
from models.meeting_model import TranscriptEntry

router = APIRouter(prefix="/transcripts", tags=["transcripts"])


@router.get("/{meeting_id}")
async def get_transcript(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Return the full transcript for a meeting."""
    col = get_meetings_collection()
    doc = await col.find_one(
        {"meeting_id": meeting_id}, {"transcript": 1, "title": 1, "_id": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"meeting_id": meeting_id, "title": doc.get("title"), "transcript": doc.get("transcript", [])}


@router.post("/{meeting_id}/entry", status_code=201)
async def add_transcript_entry(
    meeting_id: str,
    entry: TranscriptEntry,
    current_user: dict = Depends(get_current_user),
):
    """Manually append a transcript entry (useful for corrections)."""
    col = get_meetings_collection()
    result = await col.update_one(
        {"meeting_id": meeting_id},
        {"$push": {"transcript": entry.dict()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"status": "added", "entry_id": entry.id}


@router.get("/{meeting_id}/export")
async def export_transcript(
    meeting_id: str,
    fmt: str = Query("txt", pattern="^(txt|json)$"),
    current_user: dict = Depends(get_current_user),
):
    """Export transcript as plain text or JSON."""
    col = get_meetings_collection()
    doc = await col.find_one(
        {"meeting_id": meeting_id},
        {"transcript": 1, "title": 1, "timestamp": 1, "_id": 0},
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Meeting not found")

    transcript = doc.get("transcript", [])

    if fmt == "json":
        return {"meeting_id": meeting_id, "transcript": transcript}

    # Plain text export
    lines = [f"Meeting: {doc.get('title', 'Untitled')}", f"Date: {doc.get('timestamp', '')}", "=" * 60, ""]
    for entry in transcript:
        lines.append(f"[{entry.get('time', '')}] {entry.get('speaker', 'Unknown')}: {entry.get('text', '')}")

    return PlainTextResponse("\n".join(lines), media_type="text/plain")
