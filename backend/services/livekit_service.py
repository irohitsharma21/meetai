"""
LiveKit Service – room & token management.

Handles:
  - Room creation via LiveKit Server SDK
  - Participant token generation (scoped by role)
  - Room listing & participant management
"""

import time
from datetime import timedelta
from typing import Optional

from livekit.api import AccessToken, VideoGrants, LiveKitAPI
from livekit.api import ListRoomsRequest, DeleteRoomRequest

from core.config import settings


class LiveKitService:
    """Wrapper around the LiveKit Server SDK for room & token management."""

    def __init__(self):
        self._api_key = settings.LIVEKIT_API_KEY
        self._api_secret = settings.LIVEKIT_API_SECRET
        self._livekit_url = settings.LIVEKIT_URL

    # ── Token generation ──────────────────────────────────────────────────────
    def create_participant_token(
        self,
        room_name: str,
        participant_identity: str,
        participant_name: Optional[str] = None,
        is_host: bool = False,
        ttl_seconds: int = 7200,  # 2 hours
    ) -> str:
        """
        Generate a signed participant token granting access to a LiveKit room.
        Hosts get admin grants; participants get standard grants.
        """
        grants = VideoGrants(
            room_join=True,
            room=room_name,
            can_publish=True,
            can_subscribe=True,
            can_publish_data=True,
            room_admin=is_host,
            room_record=is_host,
        )

        token = (
            AccessToken(api_key=self._api_key, api_secret=self._api_secret)
            .with_identity(participant_identity)
            .with_name(participant_name or participant_identity)
            .with_grants(grants)
            .with_ttl(timedelta(seconds=ttl_seconds))
            .to_jwt()
        )
        return token

    async def create_room(self, room_name: str, max_participants: int = 50) -> dict:
        """Create a LiveKit room via the server API (idempotent)."""
        async with LiveKitAPI(
            url=self._livekit_url,
            api_key=self._api_key,
            api_secret=self._api_secret,
        ) as api:
            from livekit.api import CreateRoomRequest
            room = await api.room.create_room(
                CreateRoomRequest(
                    name=room_name,
                    max_participants=max_participants,
                    empty_timeout=300,  # destroy after 5 min empty
                )
            )
            return {
                "name": room.name,
                "sid": room.sid,
                "num_participants": room.num_participants,
            }

    async def delete_room(self, room_name: str) -> None:
        """Remove a LiveKit room after the meeting ends."""
        async with LiveKitAPI(
            url=self._livekit_url,
            api_key=self._api_key,
            api_secret=self._api_secret,
        ) as api:
            await api.room.delete_room(DeleteRoomRequest(room=room_name))

    async def list_rooms(self) -> list:
        """List all active LiveKit rooms."""
        async with LiveKitAPI(
            url=self._livekit_url,
            api_key=self._api_key,
            api_secret=self._api_secret,
        ) as api:
            resp = await api.room.list_rooms(ListRoomsRequest())
            return [{"name": r.name, "sid": r.sid, "participants": r.num_participants} for r in resp.rooms]

    async def get_room_participants(self, room_name: str) -> list:
        """List participants currently in a room."""
        async with LiveKitAPI(
            url=self._livekit_url,
            api_key=self._api_key,
            api_secret=self._api_secret,
        ) as api:
            from livekit.api import ListParticipantsRequest
            resp = await api.room.list_participants(
                ListParticipantsRequest(room=room_name)
            )
            return [
                {"identity": p.identity, "name": p.name, "state": str(p.state)}
                for p in resp.participants
            ]


# Singleton
livekit_service = LiveKitService()
