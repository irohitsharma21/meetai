"""
Deepgram streaming transcription.

Why streaming rather than posting buffered chunks to the pre-recorded API:

MediaRecorder in the browser emits a WebM stream in pieces. Only the *first*
piece carries the EBML header; every piece after it is a bare cluster. A
pre-recorded endpoint expects a complete, self-describing container, so those
later pieces come back as 400 Bad Request. Deepgram's streaming endpoint is
built for exactly this input: open a socket, push bytes as they arrive, and it
tracks decoder state across the stream.

Why a single socket is not enough - DeepgramLiveStream below:

A real meeting does not produce one continuous recording. Every time a
participant unmutes, the browser starts a new MediaRecorder, and a new
MediaRecorder writes a complete new WebM container, header and all. Deepgram
cannot splice a second container onto a stream it is already decoding.
Measured against the meeting WebSocket: two utterances transcribed, then a
second recording, and nothing ever again - even with only a two-second gap.

Separately, Deepgram closes any socket that receives neither audio nor a
KeepAlive for 10 seconds (NET-0001). Muting stops the recorder, so a muted
participant's socket always died, and nothing replaced it. Every chunk after
that point was dropped without a line in any log.

One socket is still opened per speaker, because Deepgram transcribes a single
audio stream and mixing two people into one socket would attribute both to
whoever spoke first.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Awaitable, Callable, Optional
from urllib.parse import urlencode

import websockets

from core.config import settings

# Called with (text, confidence) for each finalised utterance.
OnFinal = Callable[[str, float], Awaitable[None]]

# Every WebM file begins with this EBML magic number. MediaRecorder starts a
# brand-new container each time it starts, so a chunk beginning with it means
# a new recording has begun - after unmuting, typically.
EBML_MAGIC = b"\x1a\x45\xdf\xa3"

# Element ID of a WebM Cluster. Everything before the first one - EBML header,
# Segment, Info, Tracks - is the initialisation segment a decoder needs before
# it can make sense of any media cluster that follows.
CLUSTER_ID = b"\x1f\x43\xb6\x75"

# Deepgram closes a socket after 10 s without audio or KeepAlive. Closing our
# own idle sockets well before that avoids the error, and the CloseStream that
# closing sends also flushes the speaker's last utterance straight away rather
# than leaving it buffered until they next speak.
IDLE_CLOSE_S = 6.0


class DeepgramLiveSession:
    """One Deepgram socket, carrying exactly one WebM container."""

    def __init__(self, speaker_id: str, on_final: OnFinal) -> None:
        self.speaker_id = speaker_id
        self._on_final = on_final
        self._ws: Optional[websockets.ClientConnection] = None
        self._reader: Optional[asyncio.Task] = None
        self._closed = False
        self.bytes_sent = 0
        self.error: Optional[str] = None

    @property
    def alive(self) -> bool:
        return (
            not self._closed
            and self._ws is not None
            and self._reader is not None
            and not self._reader.done()
        )

    # -- lifecycle ---------------------------------------------------------
    async def start(self) -> None:
        query = {
            "model": settings.DEEPGRAM_MODEL,
            "language": settings.DEEPGRAM_LANGUAGE,
            "smart_format": "true",
            "punctuate": "true",
            # Interim results would let the UI show partial words, but they
            # arrive several times per second and would need to replace rather
            # than append. The transcript is a record, not a caption track.
            "interim_results": "false",
        }
        # Deliberately no `endpointing` override. Forcing a short endpoint
        # window was measured to hold the final utterance back: Deepgram
        # finalised the first sentence and then sat on the last one even after
        # CloseStream. The default segmentation returns everything.
        url = f"wss://api.deepgram.com/v1/listen?{urlencode(query)}"

        self._ws = await websockets.connect(
            url,
            additional_headers={"Authorization": f"Token {settings.DEEPGRAM_API_KEY}"},
            # Audio arrives faster than transcripts come back; a small queue is
            # enough and keeps memory bounded if the network stalls.
            max_queue=32,
        )
        self._reader = asyncio.create_task(self._read_loop())

    async def feed(self, chunk: bytes) -> bool:
        """Send one chunk. Returns False when this socket could not take it."""
        if not self.alive:
            return False
        try:
            await self._ws.send(chunk)
            self.bytes_sent += len(chunk)
            return True
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
            await self.close()
            return False

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True

        if self._ws is not None:
            try:
                # Ask Deepgram to flush whatever it is still holding before the
                # socket goes away, so the final utterance is not lost.
                await self._ws.send(json.dumps({"type": "CloseStream"}))
                # Deepgram needs a moment to finalise the tail after
                # CloseStream; a short wait here drops the last thing said.
                await asyncio.wait_for(self._drain(), timeout=10)
            except Exception:
                pass
            try:
                await self._ws.close()
            except Exception:
                pass

        if self._reader is not None:
            self._reader.cancel()

    async def _drain(self) -> None:
        """Wait for the reader to finish after CloseStream."""
        if self._reader is not None:
            try:
                await self._reader
            except asyncio.CancelledError:
                pass

    # -- receiving ---------------------------------------------------------
    async def _read_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    continue
                message = json.loads(raw)

                if message.get("type") == "Results":
                    alternatives = message.get("channel", {}).get("alternatives", [])
                    if not alternatives:
                        continue
                    best = alternatives[0]
                    text = (best.get("transcript") or "").strip()
                    # Deepgram emits empty finals for silence; there is nothing
                    # to record for those.
                    if text and message.get("is_final"):
                        await self._on_final(text, float(best.get("confidence", 0.0)))

                elif message.get("type") == "Error":
                    self.error = str(message)

            # The loop ends when Deepgram closes the socket. Record why, so a
            # dead stream shows up in the log instead of silently eating audio.
            if not self._closed and self.error is None:
                code = getattr(self._ws, "close_code", None)
                reason = getattr(self._ws, "close_reason", "") or ""
                self.error = f"closed by Deepgram (code {code}) {reason}".strip()

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if not self._closed:
                self.error = f"{type(exc).__name__}: {exc}"
        finally:
            if self.error and not self._closed:
                print(f"[stt] Deepgram stream for {self.speaker_id} ended: {self.error}")


class DeepgramLiveStream:
    """
    One speaker's transcription feed, kept alive across a whole meeting.

    Owns a sequence of DeepgramLiveSessions rather than a single one:

      * a chunk that begins a new WebM container gets a new socket - the old
        socket is closed in the background, so its final utterance still lands;
      * a socket idle for IDLE_CLOSE_S is closed before Deepgram's own timeout,
        which flushes the speaker's last sentence at the same moment;
      * a socket that dies mid-recording is replaced and primed with that
        recording's initialisation segment, so the new decoder can read the
        media clusters that follow.

    Exposes the same feed()/close() surface as a single session, so the
    meeting route does not need to know any of this happens.
    """

    def __init__(self, speaker_id: str, on_final: OnFinal) -> None:
        self.speaker_id = speaker_id
        self._on_final = on_final
        self._session: Optional[DeepgramLiveSession] = None
        self._init_segment: Optional[bytes] = None
        self._last_audio = 0.0
        self._watchdog: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._closed = False
        self.sessions_opened = 0

    async def start(self) -> None:
        # Open eagerly so a bad key or unreachable Deepgram is discovered here,
        # while the caller can still fall back to the buffered path.
        await self._open()
        self._watchdog = asyncio.create_task(self._idle_watchdog())

    async def _open(self) -> None:
        session = DeepgramLiveSession(self.speaker_id, self._on_final)
        await session.start()
        self._session = session
        self.sessions_opened += 1

    @staticmethod
    def _retire(session: DeepgramLiveSession) -> None:
        # In the background: CloseStream can take seconds to hand back the
        # final results, and the next recording must not queue behind that.
        asyncio.create_task(session.close())

    async def feed(self, chunk: bytes) -> None:
        if self._closed or not chunk:
            return

        async with self._lock:
            new_container = chunk.startswith(EBML_MAGIC)
            if new_container:
                cut = chunk.find(CLUSTER_ID)
                # With no cluster yet the whole chunk is initialisation data.
                self._init_segment = chunk[:cut] if cut > 0 else chunk
                if self._session is not None and self._session.bytes_sent > 0:
                    self._retire(self._session)
                    self._session = None

            if self._session is None or not self._session.alive:
                if self._session is not None:
                    print(
                        f"[stt] reopening Deepgram stream for {self.speaker_id}: "
                        f"{self._session.error or 'socket closed'}"
                    )
                try:
                    await self._open()
                except Exception as exc:
                    print(
                        f"[stt] could not reopen Deepgram stream for "
                        f"{self.speaker_id}: {type(exc).__name__}: {exc}"
                    )
                    self._session = None
                    return
                # Mid-recording replacement: the new decoder has never seen this
                # container's header, so hand it over before any cluster.
                if not new_container and self._init_segment:
                    await self._session.feed(self._init_segment)

            if await self._session.feed(chunk):
                self._last_audio = time.monotonic()

    async def _idle_watchdog(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(1.0)
                async with self._lock:
                    session = self._session
                    if (
                        session is not None
                        and session.bytes_sent > 0
                        and time.monotonic() - self._last_audio >= IDLE_CLOSE_S
                    ):
                        self._retire(session)
                        self._session = None
        except asyncio.CancelledError:
            pass

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._watchdog is not None:
            self._watchdog.cancel()
        if self._session is not None:
            # Awaited, not retired: this is the room closing, and the final
            # flush has to land before the meeting's socket is gone.
            await self._session.close()
            self._session = None
