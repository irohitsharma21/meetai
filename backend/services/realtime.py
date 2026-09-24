"""
Per-meeting WebSocket fan-out.

Lives in services rather than in the meeting router so that services which
push to the room on their own schedule (document cues, the delegate agent)
can reach connected clients without importing a router.

Two delivery modes matter:

* `broadcast` - everyone in the meeting (transcript lines, lobby changes).
* `send_to_user` - only the sockets of one username. Document cues and agent
  proposals are private to their owner: a prompt card that says "latency is
  350 ms" is useless if the person asking the question sees it too, and an
  agent's pending action names data only its owner has chosen to share.
"""

from __future__ import annotations

from fastapi import WebSocket


class ConnectionManager:
    """Track active WebSocket connections per meeting room."""

    def __init__(self) -> None:
        # meeting_id → list of (websocket, username)
        self.active: dict[str, list] = {}

    def connect(self, meeting_id: str, ws: WebSocket, username: str) -> None:
        self.active.setdefault(meeting_id, []).append((ws, username))

    def disconnect(self, meeting_id: str, ws: WebSocket) -> None:
        self.active[meeting_id] = [
            conn for conn in self.active.get(meeting_id, []) if conn[0] != ws
        ]

    def usernames(self, meeting_id: str) -> set[str]:
        """Who currently has a socket open in this meeting."""
        return {name for _, name in self.active.get(meeting_id, [])}

    async def broadcast(self, meeting_id: str, message: dict, exclude: WebSocket = None) -> None:
        for ws, _ in list(self.active.get(meeting_id, [])):
            if ws != exclude:
                try:
                    await ws.send_json(message)
                except Exception:
                    pass

    async def send_to_user(self, meeting_id: str, username: str, message: dict) -> int:
        """Deliver to every socket `username` has open in the meeting. Returns how many."""
        sent = 0
        for ws, name in list(self.active.get(meeting_id, [])):
            if name != username:
                continue
            try:
                await ws.send_json(message)
                sent += 1
            except Exception:
                pass
        return sent


manager = ConnectionManager()
