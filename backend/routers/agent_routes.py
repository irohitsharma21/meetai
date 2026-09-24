"""
Routes for the delegate agent: the owner's settings and their action queue.

    GET  /agent/profile                                   settings + capabilities
    PUT  /agent/profile                                   save settings
    POST /agent/{meeting_id}/command                      typed command → Action
    GET  /agent/{meeting_id}/actions                      owner's actions, newest first
    POST /agent/{meeting_id}/actions/{action_id}/approve  run a pending action
    POST /agent/{meeting_id}/actions/{action_id}/reject   discard it

Every action endpoint is scoped twice: the caller must be able to see the
meeting, and may only ever see or decide their *own* agent's actions. Another
participant's pending proposal names data its owner has not yet agreed to
share, so it is invisible rather than forbidden (404, not 403).

Missing integrations degrade rather than fail. No LLM falls back to rule-based
parsing; no SMTP produces an Action whose message names the variables to set,
so a voice command and a typed one fail the same, visible way.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.security import get_current_user
from db.mongodb import get_meetings_collection
from services.agent_service import AgentError, ProfileIn, agent_service, capabilities
from services.email_service import email_service
from services.llm_client import llm_client

router = APIRouter(prefix="/agent", tags=["agent"])


async def _load_meeting(meeting_id: str, user: dict) -> dict:
    """Fetch a meeting the caller is allowed to see (same rule as /insights)."""
    doc = await get_meetings_collection().find_one({"meeting_id": meeting_id})
    if not doc:
        raise HTTPException(404, "meeting not found")
    if user["role"] != "admin":
        participants = {p.get("username") for p in doc.get("participants", [])}
        if user["username"] != doc.get("created_by") and user["username"] not in participants:
            raise HTTPException(404, "meeting not found")
    return doc


# ── profile ───────────────────────────────────────────────────────────
@router.get("/profile")
async def get_profile(user: dict = Depends(get_current_user)):
    return {
        "profile": await agent_service.get_profile(user["username"]),
        "capabilities": capabilities(),
        "email_available": email_service.available,
        "llm_available": llm_client.available,
    }


@router.put("/profile")
async def put_profile(body: ProfileIn, user: dict = Depends(get_current_user)):
    return {"profile": await agent_service.save_profile(user["username"], body)}


# ── commands and actions ──────────────────────────────────────────────
class CommandBody(BaseModel):
    text: str = Field(..., min_length=2, max_length=1000)


class ApproveBody(BaseModel):
    recipient_username: Optional[str] = Field(None, max_length=100)
    recipient_email: Optional[str] = Field(None, max_length=254)
    subject: Optional[str] = Field(None, max_length=300)
    body: Optional[str] = Field(None, max_length=10000)


@router.post("/{meeting_id}/command")
async def command(meeting_id: str, body: CommandBody, user: dict = Depends(get_current_user)):
    """A typed instruction to the caller's own agent. Returns the resulting Action."""
    meeting = await _load_meeting(meeting_id, user)
    return await agent_service.create_action(meeting, user["username"], body.text, source="typed")


@router.get("/{meeting_id}/actions")
async def list_actions(meeting_id: str, user: dict = Depends(get_current_user)):
    await _load_meeting(meeting_id, user)
    return {"actions": await agent_service.list_actions(meeting_id, user["username"])}


@router.post("/{meeting_id}/actions/{action_id}/approve")
async def approve(
    meeting_id: str,
    action_id: str,
    body: Optional[ApproveBody] = None,
    user: dict = Depends(get_current_user),
):
    """
    Approve a pending action, optionally overriding who gets it or what it says.

    The overrides are how `needs_input` is resolved: pick one of the
    candidates, type an address, or edit a drafted email before it goes.
    """
    meeting = await _load_meeting(meeting_id, user)
    body = body or ApproveBody()
    try:
        return await agent_service.approve(
            meeting, action_id, user["username"],
            recipient_username=body.recipient_username,
            recipient_email=body.recipient_email,
            subject=body.subject,
            body=body.body,
        )
    except AgentError as exc:
        raise HTTPException(exc.status_code, str(exc))


@router.post("/{meeting_id}/actions/{action_id}/reject")
async def reject(meeting_id: str, action_id: str, user: dict = Depends(get_current_user)):
    await _load_meeting(meeting_id, user)
    try:
        return await agent_service.reject(meeting_id, action_id, user["username"])
    except AgentError as exc:
        raise HTTPException(exc.status_code, str(exc))
