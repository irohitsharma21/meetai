"""
Google Calendar Integration Service.

Capabilities:
  - OAuth2 authorization flow (authorization URL + callback)
  - Token storage in MongoDB (encrypted)
  - Automatic token refresh via google-auth library
  - Create calendar events from confirmed NextAction items
  - Update event status
"""

import json
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from zoneinfo import ZoneInfo

import httpx
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from core.config import settings
from core.security import encryptor
from db.mongodb import get_calendar_tokens_collection


class CalendarService:
    """Google Calendar OAuth2 + event creation service."""

    SCOPES = settings.GOOGLE_SCOPES

    def __init__(self):
        self._client_config = {
            "web": {
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "redirect_uris": [settings.GOOGLE_REDIRECT_URI],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        }

    # ── OAuth2 Flow ───────────────────────────────────────────────────────────
    def get_authorization_url(self, username: str) -> str:
        """Generate OAuth2 authorization URL. State encodes the username."""
        flow = Flow.from_client_config(
            self._client_config,
            scopes=self.SCOPES,
            redirect_uri=settings.GOOGLE_REDIRECT_URI,
        )
        auth_url, _ = flow.authorization_url(
            access_type="offline",
            include_granted_scopes="true",
            state=username,
            prompt="consent",  # force refresh token
        )
        return auth_url

    async def handle_oauth_callback(
        self, code: str, username: str
    ) -> Credentials:
        """Exchange authorization code for credentials and persist to MongoDB."""
        flow = Flow.from_client_config(
            self._client_config,
            scopes=self.SCOPES,
            redirect_uri=settings.GOOGLE_REDIRECT_URI,
        )
        flow.fetch_token(code=code)
        credentials = flow.credentials
        await self._save_credentials(username, credentials)
        return credentials

    # ── Token persistence ─────────────────────────────────────────────────────
    async def _save_credentials(self, username: str, creds: Credentials) -> None:
        """Persist encrypted OAuth2 tokens to MongoDB."""
        token_data = json.dumps(
            {
                "token": creds.token,
                "refresh_token": creds.refresh_token,
                "token_uri": creds.token_uri,
                "client_id": creds.client_id,
                "client_secret": creds.client_secret,
                "scopes": list(creds.scopes or self.SCOPES),
                "expiry": creds.expiry.isoformat() if creds.expiry else None,
            }
        )
        # Encrypt before storage
        encrypted = encryptor.encrypt(token_data) if encryptor.enabled else token_data

        col = get_calendar_tokens_collection()
        await col.update_one(
            {"username": username},
            {
                "$set": {
                    "username": username,
                    "token_data": encrypted,
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

    async def _load_credentials(self, username: str) -> Optional[Credentials]:
        """Load and decrypt OAuth2 credentials from MongoDB."""
        col = get_calendar_tokens_collection()
        doc = await col.find_one({"username": username})
        if not doc:
            return None

        raw = doc["token_data"]
        decrypted = encryptor.decrypt(raw) if encryptor.enabled else raw
        data = json.loads(decrypted)

        expiry = datetime.fromisoformat(data["expiry"]) if data.get("expiry") else None
        creds = Credentials(
            token=data["token"],
            refresh_token=data["refresh_token"],
            token_uri=data["token_uri"],
            client_id=data["client_id"],
            client_secret=data["client_secret"],
            scopes=data["scopes"],
        )
        creds.expiry = expiry  # type: ignore
        return creds

    async def _get_valid_credentials(self, username: str) -> Credentials:
        """Return valid (auto-refreshed) credentials."""
        creds = await self._load_credentials(username)
        if not creds:
            raise ValueError(f"No Google Calendar credentials for user '{username}'")

        if creds.expired and creds.refresh_token:
            # Refresh synchronously via google-auth
            creds.refresh(Request())
            await self._save_credentials(username, creds)

        return creds

    # ── Calendar operations ───────────────────────────────────────────────────
    async def create_event(
        self,
        username: str,
        title: str,
        description: str,
        start_datetime: datetime,
        end_datetime: Optional[datetime] = None,
        attendees: Optional[list] = None,
        timezone: str = "UTC",
    ) -> dict:
        """
        Create a Google Calendar event.
        Returns the created event dict including htmlLink.
        """
        creds = await self._get_valid_credentials(username)

        if end_datetime is None:
            end_datetime = start_datetime + timedelta(hours=1)

        event_body = {
            "summary": title,
            "description": description,
            "start": {
                "dateTime": start_datetime.isoformat(),
                "timeZone": timezone,
            },
            "end": {
                "dateTime": end_datetime.isoformat(),
                "timeZone": timezone,
            },
            "reminders": {
                "useDefault": False,
                "overrides": [
                    {"method": "email", "minutes": 24 * 60},
                    {"method": "popup", "minutes": 10},
                ],
            },
        }

        if attendees:
            event_body["attendees"] = [{"email": a} for a in attendees]

        # Use httpx-compatible sync wrapper in async context
        import asyncio
        loop = asyncio.get_event_loop()

        def _create() -> dict:
            service = build("calendar", "v3", credentials=creds, cache_discovery=False)
            return service.events().insert(calendarId="primary", body=event_body).execute()

        event = await loop.run_in_executor(None, _create)
        return event

    async def is_connected(self, username: str) -> bool:
        """Check if user has valid Google Calendar credentials."""
        try:
            creds = await self._load_credentials(username)
            return creds is not None
        except Exception:
            return False


# Singleton
calendar_service = CalendarService()
