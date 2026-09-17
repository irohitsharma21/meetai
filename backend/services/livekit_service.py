"""
LiveKit Service – room & token management.

Handles:
  - Room creation via LiveKit Server SDK
  - Participant token generation (scoped by role)
  - Room listing & participant management
  - Host controls: server-side mute, remove, mute-all (RoomService)

Every RoomService call is funnelled through `_call`, which turns a LiveKit
outage (DNS failure, timeout, 5xx) into `LiveKitUnavailable`. The routes map
that to a 502 with a readable message; without it an unreachable SFU surfaced
as a 500 traceback that looked like a bug in this code.
"""

import time
from datetime import timedelta
from typing import Any, Awaitable, Callable, Optional

from livekit.api import AccessToken, VideoGrants, LiveKitAPI
from livekit.api import ListRoomsRequest, DeleteRoomRequest
from livekit.api import (
    ListParticipantsRequest,
    MuteRoomTrackRequest,
    RoomParticipantIdentity,
    TrackSource,
    TrackType,
)
from livekit.api.twirp_client import TwirpError

from core.config import settings


class LiveKitUnavailable(Exception):
    """LiveKit could not be reached, or refused the request. Wraps the cause."""


class LiveKitNotFound(Exception):
    """The room, participant or track no longer exists on the LiveKit side."""


def _track_kind(track) -> Optional[str]:
    """
    Collapse LiveKit's (type, source) pair into the three kinds the UI knows.

    Screen share is a VIDEO track with source SCREEN_SHARE (and its optional
    audio companion SCREEN_SHARE_AUDIO), so source is checked first; a plain
    type check would report a shared screen as a camera.
    """
    if track.source in (TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO):
        return "screen"
    if track.type == TrackType.AUDIO:
        return "audio"
    if track.type == TrackType.VIDEO:
        return "video"
    return None  # DATA tracks are not something a host mutes


class LiveKitService:
    """Wrapper around the LiveKit Server SDK for room & token management."""

    def __init__(self):
        self._api_key = settings.LIVEKIT_API_KEY
        self._api_secret = settings.LIVEKIT_API_SECRET
        self._livekit_url = settings.LIVEKIT_URL

    def _client(self) -> LiveKitAPI:
        return LiveKitAPI(
            url=self._livekit_url,
            api_key=self._api_key,
            api_secret=self._api_secret,
        )

    async def _call(self, fn: Callable[[LiveKitAPI], Awaitable[Any]]) -> Any:
        """Run one RoomService operation with outage -> LiveKitUnavailable."""
        if not settings.livekit_configured:
            raise LiveKitUnavailable("LiveKit is not configured on the server.")
        try:
            async with self._client() as api:
                return await fn(api)
        except TwirpError as exc:
            if exc.status == 404 or exc.code == "not_found":
                raise LiveKitNotFound(exc.message) from exc
            raise LiveKitUnavailable(
                f"LiveKit refused the request ({exc.code}: {exc.message})."
            ) from exc
        except (LiveKitUnavailable, LiveKitNotFound):
            raise
        except Exception as exc:  # aiohttp connection errors, timeouts, DNS
            raise LiveKitUnavailable(
                f"LiveKit is unreachable ({type(exc).__name__}: {exc})."
            ) from exc

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
            # Participants publish their own attributes (hand raise) so the
            # rest of the room can read them without a server round-trip.
            can_update_own_metadata=True,
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


    # ── Host controls (RoomService) ──────────────────────────────────────────
    async def list_live_participants(self, room_name: str) -> list[dict]:
        """
        Everyone currently connected, with their published tracks.

        Returns the contract shape used by GET /participants/live:
        {identity, name, joined_at, tracks:[{sid, kind, muted}]}. `is_host` is
        stamped on by the route, which knows who created the meeting.
        """
        async def op(api: LiveKitAPI):
            return await api.room.list_participants(
                ListParticipantsRequest(room=room_name)
            )

        try:
            resp = await self._call(op)
        except LiveKitNotFound:
            # A room that has not been created yet (nobody joined) simply has
            # nobody in it; that is not an error worth surfacing.
            return []

        out = []
        for p in resp.participants:
            tracks = []
            for t in p.tracks:
                kind = _track_kind(t)
                if kind is None:
                    continue
                tracks.append({"sid": t.sid, "kind": kind, "muted": bool(t.muted)})
            out.append(
                {
                    "identity": p.identity,
                    "name": p.name or p.identity,
                    "joined_at": int(p.joined_at) if p.joined_at else None,
                    "tracks": tracks,
                }
            )
        return out

    async def mute_participant(self, room_name: str, identity: str, kind: str) -> list[str]:
        """
        Server-mute every published track of `kind` ("audio" | "video") for
        one participant. Returns the muted track sids; empty when they have
        nothing of that kind published. Raises LiveKitNotFound if they are
        not in the room.
        """
        async def get(api: LiveKitAPI):
            return await api.room.get_participant(
                RoomParticipantIdentity(room=room_name, identity=identity)
            )

        info = await self._call(get)
        sids = [t.sid for t in info.tracks if _track_kind(t) == kind]

        for sid in sids:
            async def mute(api: LiveKitAPI, sid=sid):
                return await api.room.mute_published_track(
                    MuteRoomTrackRequest(
                        room=room_name, identity=identity, track_sid=sid, muted=True
                    )
                )
            await self._call(mute)
        return sids

    async def mute_all_audio(self, room_name: str, exclude: set[str]) -> list[str]:
        """Mute the microphone of everyone not in `exclude`. Returns identities muted."""
        muted: list[str] = []
        for p in await self.list_live_participants(room_name):
            if p["identity"] in exclude:
                continue
            audio = [t["sid"] for t in p["tracks"] if t["kind"] == "audio" and not t["muted"]]
            if not audio:
                continue
            for sid in audio:
                async def mute(api: LiveKitAPI, sid=sid, identity=p["identity"]):
                    return await api.room.mute_published_track(
                        MuteRoomTrackRequest(
                            room=room_name, identity=identity, track_sid=sid, muted=True
                        )
                    )
                try:
                    await self._call(mute)
                except LiveKitNotFound:
                    continue  # they left between the list and the mute
            muted.append(p["identity"])
        return muted

    async def remove_participant(self, room_name: str, identity: str) -> bool:
        """
        Disconnect one participant. Returns False when they were not in the
        room (already gone), which the caller treats as success: the point is
        that they are out, and the ban that follows keeps them out.
        """
        async def op(api: LiveKitAPI):
            return await api.room.remove_participant(
                RoomParticipantIdentity(room=room_name, identity=identity)
            )

        try:
            await self._call(op)
            return True
        except LiveKitNotFound:
            return False


# Singleton
livekit_service = LiveKitService()
