"""
Transcription Service – real-time speech-to-text via Groq Whisper.

Pipeline:
  1. Receive raw PCM/WebM audio chunks over WebSocket
  2. Buffer into ~3-second segments
  3. Send to Groq Whisper API
  4. Return TranscriptEntry with speaker label
  5. Append to meeting transcript in MongoDB
"""

import asyncio
import io
import time
import wave
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Optional

from groq import AsyncGroq

from core.config import settings
from models.meeting_model import TranscriptEntry


class TranscriptionBuffer:
    """Manages audio buffering per speaker/participant."""

    def __init__(self, speaker_id: str, sample_rate: int = 16000):
        self.speaker_id = speaker_id
        self.sample_rate = sample_rate
        self.chunks: List[bytes] = []
        self.total_bytes = 0
        self.last_flush = time.time()
        # Buffer ~1.5s of audio at 16kHz 16-bit mono = 48000 bytes
        self.flush_threshold_bytes = sample_rate * 2 * 1  # 1 second of audio
        self.header: Optional[bytes] = None

    def add_chunk(self, data: bytes) -> None:
        # Detect WebM header (EBML)
        if not self.header and data.startswith(b'\x1a\x45\xdf\xa3'):
            # The header is everything before the first Cluster (\x1f\x43\xb6\x75)
            cluster_idx = data.find(b'\x1f\x43\xb6\x75')
            if cluster_idx > 0:
                self.header = data[:cluster_idx]
                print(f"📡 Captured WebM header: {len(self.header)} bytes")
            else:
                # If no cluster found yet, just take a reasonable chunk of the start
                self.header = data[:1024]
                print(f"📡 Captured partial WebM header: {len(self.header)} bytes")
        self.chunks.append(data)
        self.total_bytes += len(data)

    def should_flush(self) -> bool:
        """Flush if we have enough data OR time threshold exceeded."""
        return (
            self.total_bytes >= self.flush_threshold_bytes
            or (time.time() - self.last_flush) > 1.5
        )

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
        # Created lazily: without a Groq key the meeting still runs (video,
        # rooms, participants), transcription simply stays off rather than
        # taking the whole WebSocket down.
        self._client: Optional[AsyncGroq] = (
            AsyncGroq(api_key=settings.GROQ_API_KEY)
            if settings.groq_configured
            else None
        )
        self._model = settings.GROQ_TRANSCRIPTION_MODEL
        # meeting_id → {speaker_id → TranscriptionBuffer}
        self._buffers: Dict[str, Dict[str, TranscriptionBuffer]] = defaultdict(dict)
        self._meeting_start_times: Dict[str, float] = {}

    # ── Session management ────────────────────────────────────────────────────
    def start_session(self, meeting_id: str) -> None:
        self._meeting_start_times[meeting_id] = time.time()
        self._buffers[meeting_id] = {}

    def end_session(self, meeting_id: str) -> None:
        self._buffers.pop(meeting_id, None)
        self._meeting_start_times.pop(meeting_id, None)

    def _get_or_create_buffer(self, meeting_id: str, speaker_id: str) -> TranscriptionBuffer:
        if meeting_id not in self._buffers:
            self.start_session(meeting_id)
        if speaker_id not in self._buffers[meeting_id]:
            self._buffers[meeting_id][speaker_id] = TranscriptionBuffer(speaker_id)
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
        buf = self._get_or_create_buffer(meeting_id, speaker_id)
        buf.add_chunk(audio_data)

        if buf.should_flush():
            raw = buf.flush(is_webm=is_webm)
            if raw and len(raw) > 10:  # skip near-silent chunks
                print(f"🎙️ Flushing {len(raw)} bytes for {speaker_id}")
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
        """Send audio buffer to Groq Whisper and return a TranscriptEntry."""
        if self._client is None:
            return None  # transcription disabled; the meeting itself is fine
        try:
            print(f"☁️ Sending to Groq ({'WebM' if is_webm else 'WAV'})...")
            if is_webm:
                # Send WebM/Opus directly (Groq accepts it)
                file_data = ("audio.webm", io.BytesIO(audio_bytes), "audio/webm")
            else:
                # Build WAV from raw PCM
                buf = self._get_or_create_buffer(meeting_id, speaker_id)
                wav_bytes = buf.build_wav(audio_bytes)
                file_data = ("audio.wav", io.BytesIO(wav_bytes), "audio/wav")

            response = await self._client.audio.transcriptions.create(
                file=file_data,
                model=self._model,
                language="en",
                response_format="verbose_json",
                temperature=0.0,
            )

            text = response.text.strip()
            print(f"📝 Transcribed for {speaker_id}: [{text}]")
            if not text or text in ["[BLANK_AUDIO]", "Thank you.", "Thanks for watching!"]:
                print(f"ℹ️ Skipping empty/hallucinated text for {speaker_id}")
                return None

            entry = TranscriptEntry(
                speaker=speaker_id,
                text=text,
                time=self._elapsed_time(meeting_id),
                confidence=getattr(response, "avg_log_prob", 0.9),
                timestamp_ms=int(
                    (time.time() - self._meeting_start_times.get(meeting_id, time.time())) * 1000
                ),
            )
            return entry

        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"⚠️ Transcription error for {speaker_id}: {e}")
            return None

    async def flush_all_buffers(self, meeting_id: str) -> List[TranscriptEntry]:
        """Force-flush all remaining buffers at meeting end."""
        entries = []
        for speaker_id, buf in self._buffers.get(meeting_id, {}).items():
            raw = buf.flush(is_webm=True) # Assuming webm for force-flush
            if raw and len(raw) > 1000:
                entry = await self._transcribe(meeting_id, speaker_id, raw)
                if entry:
                    entries.append(entry)
        return entries


# Singleton
transcription_service = TranscriptionService()
