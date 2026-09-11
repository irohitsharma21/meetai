"""
Transcription Service – real-time speech-to-text.

Pipeline:
  1. Receive WebM/Opus (or raw PCM) audio chunks over the meeting WebSocket
  2. Buffer per speaker until a phrase-sized segment has accumulated
  3. Send it to the configured provider (Deepgram by default, Groq Whisper
     as an alternative)
  4. Return a TranscriptEntry with a speaker label
  5. Append it to the meeting transcript

Deepgram is the default because it decodes the WebM/Opus container that the
browser's MediaRecorder emits, so nothing has to be transcoded on the way.
"""

import asyncio
import io
import time
import wave

import httpx
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Optional

from groq import AsyncGroq

from core.config import settings
from services.deepgram_live import DeepgramLiveStream
from models.meeting_model import TranscriptEntry


class TranscriptionBuffer:
    """Manages audio buffering per speaker/participant."""

    # How long a buffer may sit before it is sent. Short enough to feel live,
    # long enough that a request carries a whole phrase rather than a fragment -
    # speech recognition is markedly better with a little context.
    FLUSH_INTERVAL_S = 1.5

    def __init__(self, speaker_id: str, sample_rate: int = 16000, is_webm: bool = True):
        self.speaker_id = speaker_id
        self.sample_rate = sample_rate
        self.is_webm = is_webm
        self.chunks: List[bytes] = []
        self.total_bytes = 0
        self.last_flush = time.time()
        self.last_chunk_at = time.time()
        self.header: Optional[bytes] = None

        # A byte threshold only means something once you know the bitrate.
        # 16 kHz 16-bit PCM is 32 kB per second; WebM/Opus from MediaRecorder is
        # roughly 4 kB per second. Using the PCM figure for Opus meant holding
        # about eight seconds of speech before sending any of it, so each format
        # gets its own ceiling. Time is the primary trigger either way - this is
        # only a guard against unbounded growth.
        bytes_per_second = 4_000 if is_webm else sample_rate * 2
        self.flush_threshold_bytes = int(bytes_per_second * 4)

    def add_chunk(self, data: bytes) -> None:
        # Detect WebM header (EBML)
        if not self.header and data.startswith(b'\x1a\x45\xdf\xa3'):
            # The header is everything before the first Cluster (\x1f\x43\xb6\x75)
            cluster_idx = data.find(b'\x1f\x43\xb6\x75')
            if cluster_idx > 0:
                self.header = data[:cluster_idx]
                print(f"Captured WebM header: {len(self.header)} bytes")
            else:
                # If no cluster found yet, just take a reasonable chunk of the start
                self.header = data[:1024]
                print(f"Captured partial WebM header: {len(self.header)} bytes")
        self.chunks.append(data)
        self.total_bytes += len(data)
        self.last_chunk_at = time.time()

    def should_flush(self) -> bool:
        """Flush once enough audio has accumulated, or enough time has passed."""
        if not self.chunks:
            return False
        return (
            self.total_bytes >= self.flush_threshold_bytes
            or (time.time() - self.last_flush) >= self.FLUSH_INTERVAL_S
        )

    def is_stale(self, idle_for: float = 1.5) -> bool:
        """
        True when audio is waiting and no new chunk has arrived recently.

        Flushing used to happen only when the *next* chunk arrived, so whatever
        someone said just before they stopped talking sat in the buffer until
        the meeting ended. A speaker's final sentence is often the one that
        matters - "so you'll send that by Friday" - which made it exactly the
        wrong thing to drop.
        """
        return bool(self.chunks) and (time.time() - self.last_chunk_at) >= idle_for

    def flush(self, is_webm: bool = True) -> Optional[bytes]:
        """Return buffered audio and reset."""
        if not self.chunks:
            return None
        
        data = b"".join(self.chunks)

        # If it's a follow-up WebM chunk, prepend the header
        if is_webm and self.header and not data.startswith(b'\x1a\x45\xdf\xa3'):
            data = self.header + data

        self.chunks = []
        self.total_bytes = 0
        self.last_flush = time.time()
        return data

    def build_wav(self, raw_pcm: bytes) -> bytes:
        """Wrap raw 16-bit mono PCM in a WAV container for Groq."""
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(self.sample_rate)
            wf.writeframes(raw_pcm)
        return buf.getvalue()


class TranscriptionService:
    """
    Real-time transcription pipeline using Groq Whisper.
    Supports per-participant audio buffering and speaker diarization labels.
    """

    def __init__(self):
        # The provider is chosen once, here, so everything downstream -
        # buffering, speaker labels, timing - is identical either way.
        self._provider = (settings.STT_PROVIDER or "deepgram").strip().lower()
        if self._provider not in ("deepgram", "groq"):
            print(f"Unknown STT_PROVIDER {self._provider!r}; using deepgram.")
            self._provider = "deepgram"

        # Without a key the meeting still runs - video, rooms, participants -
        # and transcription simply stays off rather than taking the WebSocket
        # down with it.
        if self._provider == "groq":
            self._client: Optional[AsyncGroq] = (
                AsyncGroq(api_key=settings.GROQ_API_KEY)
                if settings.groq_configured
                else None
            )
            self._model = settings.GROQ_TRANSCRIPTION_MODEL
        else:
            self._client = None  # Deepgram is called over plain HTTP
            self._model = settings.DEEPGRAM_MODEL
        # meeting_id → {speaker_id → TranscriptionBuffer}
        self._buffers: Dict[str, Dict[str, TranscriptionBuffer]] = defaultdict(dict)
        self._meeting_start_times: Dict[str, float] = {}

        # Why transcription is unavailable, or None when it is fine. A silent
        # empty transcript panel is indistinguishable from "nobody has spoken
        # yet", so the reason is carried all the way to the UI.
        key_name = "GROQ_API_KEY" if self._provider == "groq" else "DEEPGRAM_API_KEY"
        self._disabled_reason: Optional[str] = (
            None
            if self._configured
            else f"{key_name} is not set, so speech-to-text is off. "
                 "Add a key to backend/.env and restart the API."
        )
        self._consecutive_failures = 0

    @property
    def _configured(self) -> bool:
        if self._provider == "groq":
            return settings.groq_configured
        return settings.deepgram_configured

    @property
    def status(self) -> Dict[str, object]:
        """Machine-readable state for the health endpoint and the WebSocket."""
        return {
            "available": self._disabled_reason is None,
            "reason": self._disabled_reason,
            "model": self._model,
            "provider": self._provider,
        }

    async def verify_credentials(self) -> None:
        """
        Probe the provider once at startup.

        Without this the service reports "available" until the first person
        speaks, which is the worst moment to discover the key is dead. Listing
        models is cheap and needs no audio, so the health endpoint can be
        truthful from boot. A network failure here is not treated as fatal - the
        key may well be fine and the first real request will settle it.
        """
        if not self._configured:
            return
        try:
            if self._provider == "groq":
                await self._client.models.list()
            else:
                async with httpx.AsyncClient(timeout=20) as client:
                    r = await client.get(
                        "https://api.deepgram.com/v1/projects",
                        headers={"Authorization": f"Token {settings.DEEPGRAM_API_KEY}"},
                    )
                    if r.status_code in (401, 403):
                        raise PermissionError(
                            f"Deepgram rejected the key ({r.status_code})"
                        )
                    r.raise_for_status()
            self._disabled_reason = None
            print(f"Transcription ready: {self._provider}/{self._model}")
        except Exception as e:
            name = type(e).__name__
            status_code = getattr(e, "status_code", None) or getattr(
                getattr(e, "response", None), "status_code", None
            )
            if name in ("AuthenticationError", "PermissionError") or status_code in (401, 403):
                self._note_failure(e)
                print(f"Transcription disabled: {self._disabled_reason}")
            else:
                print(f"Could not verify {self._provider} credentials ({name}); continuing.")

    # ── Session management ────────────────────────────────────────────────────
    def start_session(self, meeting_id: str) -> None:
        self._meeting_start_times[meeting_id] = time.time()
        self._buffers[meeting_id] = {}

    def end_session(self, meeting_id: str) -> None:
        self._buffers.pop(meeting_id, None)
        self._meeting_start_times.pop(meeting_id, None)

    def _get_or_create_buffer(
        self, meeting_id: str, speaker_id: str, is_webm: bool = True
    ) -> TranscriptionBuffer:
        if meeting_id not in self._buffers:
            self.start_session(meeting_id)
        if speaker_id not in self._buffers[meeting_id]:
            self._buffers[meeting_id][speaker_id] = TranscriptionBuffer(
                speaker_id, is_webm=is_webm
            )
        return self._buffers[meeting_id][speaker_id]

    def _elapsed_time(self, meeting_id: str) -> str:
        """Return HH:MM:SS elapsed time from meeting start."""
        start = self._meeting_start_times.get(meeting_id, time.time())
        elapsed = int(time.time() - start)
        h, m, s = elapsed // 3600, (elapsed % 3600) // 60, elapsed % 60
        return f"{h:02d}:{m:02d}:{s:02d}"

    # ── Core transcription ────────────────────────────────────────────────────
    async def process_audio_chunk(
        self,
        meeting_id: str,
        speaker_id: str,
        audio_data: bytes,
        is_webm: bool = True,
    ) -> Optional[TranscriptEntry]:
        """
        Add audio chunk to speaker buffer.
        Returns a TranscriptEntry when buffer is flushed and transcribed.
        """
        # Once the provider has told us the credentials are bad, stop buffering
        # and stop calling it: retrying on every 1.5s chunk just burns CPU and
        # fills the log with identical 401s.
        if self._disabled_reason is not None:
            return None

        buf = self._get_or_create_buffer(meeting_id, speaker_id, is_webm=is_webm)
        buf.add_chunk(audio_data)

        if buf.should_flush():
            raw = buf.flush(is_webm=is_webm)
            if raw and len(raw) > 10:  # skip near-silent chunks
                return await self._transcribe(
                    meeting_id, speaker_id, raw, is_webm=is_webm
                )
        return None

    async def _transcribe(
        self,
        meeting_id: str,
        speaker_id: str,
        audio_bytes: bytes,
        is_webm: bool = True,
    ) -> Optional[TranscriptEntry]:
        """Send the buffered audio to the configured provider."""
        if not self._configured:
            return None  # transcription disabled; the meeting itself is fine
        try:
            if self._provider == "deepgram":
                text, confidence = await self._transcribe_deepgram(
                    meeting_id, speaker_id, audio_bytes, is_webm
                )
            else:
                text, confidence = await self._transcribe_groq(
                    meeting_id, speaker_id, audio_bytes, is_webm
                )

            self._consecutive_failures = 0
            text = (text or "").strip()

            # Whisper hallucinates stock phrases over silence and dead air.
            # Deepgram returns an empty string instead, so this mainly bites on
            # the Groq path - but the filter is cheap and harmless either way.
            if not text or text in ["[BLANK_AUDIO]", "Thank you.", "Thanks for watching!"]:
                return None

            print(f"Transcribed for {speaker_id}: [{text}]")
            return TranscriptEntry(
                speaker=speaker_id,
                text=text,
                time=self._elapsed_time(meeting_id),
                confidence=confidence,
                timestamp_ms=int(
                    (time.time() - self._meeting_start_times.get(meeting_id, time.time())) * 1000
                ),
            )

        except Exception as e:
            self._note_failure(e)
            print(f"Transcription error for {speaker_id}: {type(e).__name__}: {e}")
            return None

    async def _transcribe_deepgram(
        self,
        meeting_id: str,
        speaker_id: str,
        audio_bytes: bytes,
        is_webm: bool,
    ) -> tuple[str, float]:
        """
        Deepgram pre-recorded transcription.

        WebM/Opus goes straight to the API - Deepgram decodes the container
        itself, which is the reason it is the default here: MediaRecorder in the
        browser produces exactly that, so there is no transcode step and no
        ffmpeg in the request path.

        `smart_format` supplies punctuation and casing. That matters twice over:
        the transcript is read by people, and it is fed to an LLM whose action
        detection is measurably better on punctuated text.
        """
        if is_webm:
            payload, content_type = audio_bytes, "audio/webm"
        else:
            buf = self._get_or_create_buffer(meeting_id, speaker_id, is_webm=False)
            payload, content_type = buf.build_wav(audio_bytes), "audio/wav"

        return await self._deepgram_request(payload, content_type)

    async def _deepgram_request(
        self, payload: bytes, content_type: str
    ) -> tuple[str, float]:
        """POST one complete audio container to Deepgram; return (text, confidence)."""
        params = {
            "model": self._model,
            "language": settings.DEEPGRAM_LANGUAGE,
            "smart_format": "true",
            "punctuate": "true",
        }

        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(
                "https://api.deepgram.com/v1/listen",
                params=params,
                content=payload,
                headers={
                    "Authorization": f"Token {settings.DEEPGRAM_API_KEY}",
                    "Content-Type": content_type,
                },
            )

        if response.status_code in (401, 403):
            raise PermissionError(f"Deepgram rejected the key ({response.status_code})")
        response.raise_for_status()

        data = response.json()
        # results.channels[0].alternatives[0] is the shape for single-channel
        # audio; anything else means the request was not what we think it was.
        alternatives = (
            data.get("results", {}).get("channels", [{}])[0].get("alternatives", [{}])
        )
        best = alternatives[0] if alternatives else {}
        return best.get("transcript", ""), float(best.get("confidence", 0.0))

    async def _transcribe_groq(
        self,
        meeting_id: str,
        speaker_id: str,
        audio_bytes: bytes,
        is_webm: bool,
    ) -> tuple[str, float]:
        """Groq Whisper transcription, retained as an alternative backend."""
        if is_webm:
            file_data = ("audio.webm", io.BytesIO(audio_bytes), "audio/webm")
        else:
            buf = self._get_or_create_buffer(meeting_id, speaker_id, is_webm=False)
            file_data = (
                "audio.wav",
                io.BytesIO(buf.build_wav(audio_bytes)),
                "audio/wav",
            )

        response = await self._client.audio.transcriptions.create(
            file=file_data,
            model=self._model,
            language="en",
            response_format="verbose_json",
            temperature=0.0,
        )
        return response.text, float(getattr(response, "avg_log_prob", 0.9))

    @property
    def supports_streaming(self) -> bool:
        """Deepgram has a streaming endpoint; the Groq path is request/response."""
        return self._provider == "deepgram" and self._disabled_reason is None

    async def open_live_session(self, meeting_id: str, speaker_id: str, on_final):
        """
        Open a streaming transcription socket for one speaker.

        `on_final` is awaited with a finished TranscriptEntry each time Deepgram
        closes out an utterance. Returns None when streaming is unavailable, in
        which case the caller should fall back to buffered chunks.
        """
        if not self.supports_streaming:
            return None

        if meeting_id not in self._meeting_start_times:
            self.start_session(meeting_id)

        async def handle(text: str, confidence: float) -> None:
            entry = TranscriptEntry(
                speaker=speaker_id,
                text=text,
                time=self._elapsed_time(meeting_id),
                confidence=confidence,
                timestamp_ms=int(
                    (time.time() - self._meeting_start_times.get(meeting_id, time.time()))
                    * 1000
                ),
            )
            await on_final(entry)

        # A resilient stream rather than a single socket: it survives
        # unmuting, silences past Deepgram's 10 s timeout, and dropped sockets.
        session = DeepgramLiveStream(speaker_id, handle)
        try:
            await session.start()
        except Exception as exc:
            # Fall back rather than fail: the buffered path still works for the
            # first chunk, and the meeting itself is unaffected either way.
            print(f"Deepgram live session failed to open: {type(exc).__name__}: {exc}")
            self._note_failure(exc)
            return None
        return session

    async def flush_stale(
        self, meeting_id: str, idle_for: float = 1.5
    ) -> List[TranscriptEntry]:
        """
        Transcribe buffers that have gone quiet.

        Called on a timer by the meeting WebSocket so a speaker's last sentence
        is transcribed when they stop talking, rather than waiting for a next
        chunk that - if they have finished speaking - never arrives.
        """
        if self._disabled_reason is not None:
            return []

        entries: List[TranscriptEntry] = []
        for speaker_id, buf in list(self._buffers.get(meeting_id, {}).items()):
            if not buf.is_stale(idle_for):
                continue
            raw = buf.flush(is_webm=buf.is_webm)
            if not raw or len(raw) <= 10:
                continue
            entry = await self._transcribe(
                meeting_id, speaker_id, raw, is_webm=buf.is_webm
            )
            if entry:
                entries.append(entry)
        return entries

    async def transcribe_once(self, audio: bytes, mime_type: str = "audio/webm") -> str:
        """
        Transcribe a single, self-contained clip.

        Used by the voice assistant, where the browser hands over one complete
        recording rather than a stream of chunks, so none of the buffering above
        applies. The bytes are a finished container and are sent untouched: the
        streaming path's is_webm=False branch means "raw PCM that still needs a
        WAV header", and applying it here would wrap a WAV file in a second one.
        """
        if self._disabled_reason:
            raise RuntimeError(self._disabled_reason)

        if self._provider == "deepgram":
            text, _ = await self._deepgram_request(audio, mime_type)
            return (text or "").strip()

        suffix = "webm" if "webm" in mime_type else "wav"
        response = await self._client.audio.transcriptions.create(
            file=(f"clip.{suffix}", io.BytesIO(audio), mime_type),
            model=self._model,
            language="en",
            temperature=0.0,
        )
        return (response.text or "").strip()

    def _note_failure(self, exc: Exception) -> None:
        """
        Decide whether a failure is fatal or transient.

        A bad key never fixes itself, so it disables the service outright and
        reports why. Network blips are transient and only disable transcription
        after they stop looking like blips.
        """
        name = type(exc).__name__
        provider = self._provider.capitalize()
        key_name = "DEEPGRAM_API_KEY" if self._provider == "deepgram" else "GROQ_API_KEY"

        # The two clients report HTTP status differently: the Groq SDK puts
        # `status_code` on the exception, httpx carries it on `.response`.
        status_code = getattr(exc, "status_code", None)
        if status_code is None:
            status_code = getattr(getattr(exc, "response", None), "status_code", None)

        if name in ("AuthenticationError", "PermissionError") or status_code in (401, 403):
            self._disabled_reason = (
                f"{provider} rejected the API key ({status_code or 401}). "
                f"Speech-to-text is off until a valid {key_name} is set in "
                "backend/.env and the API restarts."
            )
            return
        if status_code == 429:
            self._disabled_reason = (
                f"{provider} rate limit reached (429). Transcription will stay off "
                "until the API is restarted or the quota resets."
            )
            return

        self._consecutive_failures += 1
        if self._consecutive_failures >= 5:
            self._disabled_reason = (
                f"Speech-to-text failed {self._consecutive_failures} times in a row "
                f"({name}). Check the backend log and the network connection."
            )

    async def flush_all_buffers(self, meeting_id: str) -> List[TranscriptEntry]:
        """Force-flush all remaining buffers at meeting end."""
        entries = []
        for speaker_id, buf in self._buffers.get(meeting_id, {}).items():
            raw = buf.flush(is_webm=buf.is_webm)
            if raw and len(raw) > 1000:
                entry = await self._transcribe(
                    meeting_id, speaker_id, raw, is_webm=buf.is_webm
                )
                if entry:
                    entries.append(entry)
        return entries


# Singleton
transcription_service = TranscriptionService()
