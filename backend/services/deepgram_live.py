"""
Deepgram streaming transcription.

Why this exists rather than posting buffered chunks to the pre-recorded API:

MediaRecorder in the browser emits a WebM stream in pieces. Only the *first*
piece carries the EBML header; every piece after it is a bare cluster. A
pre-recorded endpoint expects a complete, self-describing container, so those
later pieces come back as 400 Bad Request. Stitching a saved header onto each
fragment is the obvious workaround and it is not reliable - the result is a
container claiming a duration and cue structure it does not have.

Deepgram's streaming endpoint is built for precisely this shape of input: open a
socket, push bytes as they arrive, and it tracks decoder state across the whole
stream. That removes the header problem completely, and as a side effect gives
utterance-level segmentation - Deepgram decides where a sentence ends, which is
a much better transcript boundary than "every 1.5 seconds".

One socket is opened per speaker, because Deepgram transcribes a single audio
stream and mixing two people's audio into one socket would attribute both to
whoever spoke first.
"""

from __future__ import annotations

import asyncio
import json
from typing import Awaitable, Callable, Optional
from urllib.parse import urlencode

import websockets

from core.config import settings

# Called with (text, confidence) for each finalised utterance.
OnFinal = Callable[[str, float], Awaitable[None]]


class DeepgramLiveSession:
    """A single live transcription socket for one speaker."""

    def __init__(self, speaker_id: str, on_final: OnFinal) -> None:
        self.speaker_id = speaker_id
        self._on_final = on_final
        self._ws: Optional[websockets.ClientConnection] = None
        self._reader: Optional[asyncio.Task] = None
        self._closed = False
        self.error: Optional[str] = None

    # ── lifecycle ─────────────────────────────────────────────────────────
    async def start(self) -> None:
        query = {
            "model": settings.DEEPGRAM_MODEL,
            "language": settings.DEEPGRAM_LANGUAGE,
            "smart_format": "true",
            "punctuate": "true",
            # Interim results would let the UI show partial words, but they also
            # arrive several times per second and would need to replace rather
            # than append. The transcript here is a record, not a caption track,
            # so only finalised utterances are kept.
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

    async def feed(self, chunk: bytes) -> None:
        """Forward one audio chunk, exactly as the browser produced it."""
        if self._closed or self._ws is None:
            return
        try:
            await self._ws.send(chunk)
        except Exception as exc:
            # A dead socket must not take the meeting's WebSocket down with it;
            # video and chat carry on regardless of transcription.
            self.error = f"{type(exc).__name__}: {exc}"
            await self.close()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True

        if self._ws is not None:
            try:
                # Ask Deepgram to flush whatever is still buffered before the
                # socket goes away, so the final utterance is not lost.
                await self._ws.send(json.dumps({"type": "CloseStream"}))
                # Deepgram needs a moment to finalise the tail after CloseStream;
                # a short wait here silently drops the last thing anyone said.
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

    # ── receiving ─────────────────────────────────────────────────────────
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

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if not self._closed:
                self.error = f"{type(exc).__name__}: {exc}"
