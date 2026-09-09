"""
Calendar routes:
  GET  /calendar/connect           – get Google OAuth2 authorization URL
  GET  /calendar/oauth2callback    – handle OAuth2 callback
  POST /calendar/events            – create calendar event manually
  POST /calendar/confirm-action    – confirm a next action → create calendar event
  GET  /calendar/status            – check if user has connected Google Calendar
"""

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from core.config import settings
from core.security import get_current_user
from db.mongodb import get_meetings_collection
from models.meeting_model import ActionStatus
from services.calendar_service import calendar_service

router = APIRouter(prefix="/calendar", tags=["calendar"])


class CreateEventRequest(BaseModel):
    title: str
    description: str = ""
    start_datetime: datetime
    end_datetime: Optional[datetime] = None
    attendees: Optional[list] = None
    timezone: str = "UTC"


class ConfirmActionRequest(BaseModel):
    meeting_id: str
    action_id: str
    start_datetime: datetime
    end_datetime: Optional[datetime] = None
    attendees: Optional[list] = None
    timezone: str = "UTC"


@router.get("/connect")
async def get_auth_url(current_user: dict = Depends(get_current_user)):
    """Return Google OAuth2 authorization URL for the current user."""
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail="Google Calendar not configured")
    url = calendar_service.get_authorization_url(current_user["username"])
    return {"auth_url": url}


@router.get("/oauth2callback")
async def oauth2_callback(
    code: str = Query(...),
    state: str = Query(...),  # username encoded in state
):
    """Handle OAuth2 redirect callback and persist tokens."""
    try:
        await calendar_service.handle_oauth_callback(code, state)
        # Redirect to frontend calendar success page
        return RedirectResponse(url="http://localhost:5173/calendar/success")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"OAuth2 callback failed: {e}")


@router.get("/status")
async def get_calendar_status(current_user: dict = Depends(get_current_user)):
    """Check if the current user has connected Google Calendar."""
    connected = await calendar_service.is_connected(current_user["username"])
    return {"connected": connected, "username": current_user["username"]}


@router.post("/events")
async def create_event(
    payload: CreateEventRequest,
    current_user: dict = Depends(get_current_user),
):
    """Create a Google Calendar event directly."""
    try:
        event = await calendar_service.create_event(
            username=current_user["username"],
            title=payload.title,
            description=payload.description,
            start_datetime=payload.start_datetime,
            end_datetime=payload.end_datetime,
            attendees=payload.attendees,
            timezone=payload.timezone,
        )
        return {
            "event_id": event.get("id"),
            "html_link": event.get("htmlLink"),
            "status": "created",
        }
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Calendar event creation failed: {e}")


@router.post("/confirm-action")
async def confirm_action_and_create_event(
    payload: ConfirmActionRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Confirm a next action:
      1. Create Google Calendar event
      2. Update next_action status → confirmed in MongoDB
      3. Store calendar_event_id
    """
    col = get_meetings_collection()
    doc = await col.find_one({"meeting_id": payload.meeting_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Meeting not found")

    # Find the action
    action = next(
        (a for a in doc.get("ai_analysis", {}).get("next_actions", []) if a["id"] == payload.action_id),
        None,
    )
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")

    # Create Google Calendar event
    try:
        event = await calendar_service.create_event(
            username=current_user["username"],
            title=action["task"],
            description=f"Confirmed from AI Meeting Platform meeting: {doc['title']}",
            start_datetime=payload.start_datetime,
            end_datetime=payload.end_datetime,
            attendees=payload.attendees,
            timezone=payload.timezone,
        )
        event_id = event.get("id")
        html_link = event.get("htmlLink")
    except ValueError:
        raise HTTPException(
            status_code=401,
            detail="Google Calendar not connected. Visit /calendar/connect first.",
        )

    # Update MongoDB
    await col.update_one(
        {
            "meeting_id": payload.meeting_id,
            "ai_analysis.next_actions.id": payload.action_id,
        },
        {
            "$set": {
                "ai_analysis.next_actions.$.status": ActionStatus.CONFIRMED.value,
                "ai_analysis.next_actions.$.calendar_event_id": event_id,
                "ai_analysis.next_actions.$.confirmed_at": datetime.now(timezone.utc),
            }
        },
    )

    return {
        "status": "confirmed",
        "action_id": payload.action_id,
        "calendar_event_id": event_id,
        "calendar_link": html_link,
    }
