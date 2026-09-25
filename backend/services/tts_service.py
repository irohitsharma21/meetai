"""
Text-to-speech, provider-agnostic.

The voice assistant needs to speak. Which vendor does that is a deployment
detail, so the pipeline talks to one interface and the provider is chosen by
`TTS_PROVIDER`:

    browser      no key. The server returns text and the client speaks it with
                 the Web Speech API. Lower fidelity, but the feature is fully
                 demonstrable with zero credentials — which matters for a
                 project people will clone and run.
    elevenlabs   highest quality
    murf         good quality, generous free tier
    sarvam       Indic languages and accents

Every provider returns the same shape, so the caller never branches on vendor.
Synthesis failures degrade to browser speech rather than breaking the reply:
a spoken answer that arrives as text is a worse answer, but no answer at all
is a broken feature.

Live translation needs something the providers above do not reliably give:
one voice that speaks Tamil *and* Hindi *and* the rest of the language table.
`synthesise_in` uses Gemini's TTS models for that, independent of
TTS_PROVIDER, because the key is usually already present for the LLM chain.
It degrades the same way - `client_should_speak=True` - and the client then
speaks the translation with a browser voice for the language's locale.
"""

from __future__ import annotations

import asyncio
import base64
import io
import re
import time
import wave
from dataclasses import dataclass

import httpx

from core.config import settings
from core.http import async_client
from core.languages import name_of, normalise

GEMINI_TTS_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


_gemini_http: tuple[object, httpx.AsyncClient] | None = None


def gemini_http() -> httpx.AsyncClient:
    """
    One long-lived client for Gemini's native endpoint, per event loop.

    Live translation makes two or three Gemini calls per spoken line. A fresh
    AsyncClient builds an SSL context and does a new TLS handshake every time,
    which measured 4-11 s on a Windows dev box against ~0.8 s on a reused
    connection - the difference between hearing a translation and not. The
    client is tied to the loop that created it (tests run several loops), so a
    different running loop gets its own.
    """
    global _gemini_http
    loop = asyncio.get_running_loop()
    if _gemini_http is None or _gemini_http[0] is not loop or _gemini_http[1].is_closed:
        _gemini_http = (loop, async_client(
            timeout=30.0,
            limits=httpx.Limits(max_connections=16, max_keepalive_connections=8, keepalive_expiry=120),
        ))
    return _gemini_http[1]
# A model that answered 429 (quota) or 404 (retired) is skipped for this long,
# so every translated line does not pay for the same refusal first.
GEMINI_TTS_BENCH_S = 60.0


@dataclass
class Speech:
    """One synthesis result."""

    provider: str
    # base64 audio for server-side providers; None when the client must speak.
    audio_b64: str | None
    mime_type: str | None
    text: str
    client_should_speak: bool
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "audio": self.audio_b64,
            "mime_type": self.mime_type,
            "text": self.text,
            "client_should_speak": self.client_should_speak,
            "error": self.error,
        }


class TTSService:
    """Synthesises speech through the configured provider."""

    TIMEOUT = 30.0

    def __init__(self) -> None:
        # Gemini TTS model -> monotonic time it may be tried again.
        self._benched: dict[str, float] = {}

    @property
    def provider(self) -> str:
        return (settings.TTS_PROVIDER or "browser").lower()

    @property
    def available(self) -> bool:
        return settings.tts_configured

    @property
    def multilingual_available(self) -> bool:
        """Whether `synthesise_in` can produce audio on the server."""
        return settings.multilingual_tts_configured

    @property
    def multilingual_provider(self) -> str:
        return "gemini" if self.multilingual_available else "browser"

    def describe(self) -> dict:
        return {
            "provider": self.provider,
            "configured": self.available,
            "server_side": self.provider != "browser",
            "multilingual": {
                "server": self.multilingual_available,
                "provider": self.multilingual_provider,
            },
        }

    async def synthesise(self, text: str) -> Speech:
        """Speak `text`. Never raises — failures fall back to the client."""
        text = (text or "").strip()
        if not text:
            return Speech("browser", None, None, "", True, "empty text")

        provider = self.provider
        if provider == "browser":
            return Speech("browser", None, None, text, True)

        try:
            if provider == "elevenlabs":
                return await self._elevenlabs(text)
            if provider == "murf":
                return await self._murf(text)
            if provider == "sarvam":
                return await self._sarvam(text)
            return self._fallback(text, f"unknown TTS provider '{provider}'")
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:200] if exc.response is not None else ""
            return self._fallback(
                text, f"{provider} returned {exc.response.status_code}: {detail}"
            )
        except Exception as exc:
            return self._fallback(text, f"{provider} failed: {exc}")

    # ── multilingual ──────────────────────────────────────────────────
    async def synthesise_in(self, text: str, language: str, timeout: float | None = None) -> Speech:
        """
        Speak `text` in `language` (a code from core.languages). Never raises.

        Gemini's TTS models detect the language from the script, so the text
        is sent as-is: prefixing an instruction ("say in Hindi:") risks the
        instruction being read aloud. Models are tried in order within one
        overall budget; a refusal (quota, overload, retired model) moves to
        the next, and running out of models or time falls back to the client.
        """
        text = (text or "").strip()
        code = normalise(language) or "en"
        if not text:
            return Speech("browser", None, None, "", True, "empty text")
        if not self.multilingual_available:
            return Speech("browser", None, None, text, True, "GEMINI_API_KEY is not set")

        budget = timeout if timeout is not None else settings.TRANSLATION_TTS_TIMEOUT_S
        deadline = time.monotonic() + budget
        errors: list[str] = []
        now = time.monotonic()
        models = [m for m in settings.GEMINI_TTS_MODELS if self._benched.get(m, 0) <= now]
        if not models:
            # Everything benched: try anyway rather than go silent for a minute.
            models = list(settings.GEMINI_TTS_MODELS)
        for model in models:
            remaining = deadline - time.monotonic()
            if remaining <= 0.5:
                errors.append("out of time")
                break
            try:
                audio, mime = await self._gemini_tts(model, text, remaining)
                return Speech("gemini", base64.b64encode(audio).decode(), mime, text, False)
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code if exc.response is not None else 0
                if status in (404, 429):
                    self._benched[model] = time.monotonic() + GEMINI_TTS_BENCH_S
                detail = exc.response.text[:160] if exc.response is not None else ""
                errors.append(f"{model} {status}: {detail}")
            except Exception as exc:
                errors.append(f"{model}: {type(exc).__name__}: {exc}"[:200])
        return self._fallback(text, f"gemini tts ({name_of(code)}) failed - " + "; ".join(errors))

    async def _gemini_tts(self, model: str, text: str, timeout: float) -> tuple[bytes, str]:
        r = await gemini_http().post(
            GEMINI_TTS_URL.format(model=model),
            timeout=timeout,
            headers={"x-goog-api-key": settings.GEMINI_API_KEY},
            json={
                "contents": [{"parts": [{"text": text}]}],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {
                            "prebuiltVoiceConfig": {"voiceName": settings.GEMINI_TTS_VOICE}
                        }
                    },
                },
            },
        )
        r.raise_for_status()
        payload = r.json()
        try:
            inline = payload["candidates"][0]["content"]["parts"][0]["inlineData"]
            audio = base64.b64decode(inline["data"])
        except (KeyError, IndexError, TypeError, ValueError):
            reason = None
            if isinstance(payload, dict):
                reason = ((payload.get("candidates") or [{}])[0] or {}).get("finishReason")
            raise RuntimeError(f"no audio in response (finishReason={reason})")
        if not audio:
            raise RuntimeError("empty audio")
        return as_playable(audio, inline.get("mimeType") or "")

    @staticmethod
    def _fallback(text: str, error: str) -> Speech:
        print(f"[tts] {error} — falling back to browser speech")
        return Speech("browser", None, None, text, True, error)

    # ── providers ─────────────────────────────────────────────────────
    async def _elevenlabs(self, text: str) -> Speech:
        if not settings.ELEVENLABS_API_KEY:
            return self._fallback(text, "ELEVENLABS_API_KEY is not set")

        url = (
            "https://api.elevenlabs.io/v1/text-to-speech/"
            f"{settings.ELEVENLABS_VOICE_ID}"
        )
        async with async_client(timeout=self.TIMEOUT) as client:
            r = await client.post(
                url,
                headers={
                    "xi-api-key": settings.ELEVENLABS_API_KEY,
                    "accept": "audio/mpeg",
                },
                json={
                    "text": text,
                    "model_id": "eleven_turbo_v2_5",  # lowest latency tier
                    "voice_settings": {"stability": 0.4, "similarity_boost": 0.7},
                },
            )
            r.raise_for_status()
            return Speech(
                "elevenlabs",
                base64.b64encode(r.content).decode(),
                "audio/mpeg",
                text,
                False,
            )

    async def _murf(self, text: str) -> Speech:
        if not settings.MURF_API_KEY:
            return self._fallback(text, "MURF_API_KEY is not set")

        async with async_client(timeout=self.TIMEOUT) as client:
            r = await client.post(
                "https://api.murf.ai/v1/speech/generate",
                headers={
                    "api-key": settings.MURF_API_KEY,
                    "Content-Type": "application/json",
                },
                json={
                    "text": text,
                    "voiceId": settings.MURF_VOICE_ID,
                    "format": "MP3",
                },
            )
            r.raise_for_status()
            payload = r.json()

            # Murf answers with a URL rather than inline audio; fetch it so the
            # client receives one uniform response shape.
            audio_url = payload.get("audioFile") or payload.get("audio_file")
            if not audio_url:
                return self._fallback(text, f"murf returned no audio url: {payload}")

            audio = await client.get(audio_url)
            audio.raise_for_status()
            return Speech(
                "murf",
                base64.b64encode(audio.content).decode(),
                "audio/mpeg",
                text,
                False,
            )

    async def _sarvam(self, text: str) -> Speech:
        if not settings.SARVAM_API_KEY:
            return self._fallback(text, "SARVAM_API_KEY is not set")

        async with async_client(timeout=self.TIMEOUT) as client:
            r = await client.post(
                "https://api.sarvam.ai/text-to-speech",
                headers={"api-subscription-key": settings.SARVAM_API_KEY},
                json={
                    # Sarvam caps input length; keep well inside it.
                    "inputs": [text[:480]],
                    "target_language_code": "en-IN",
                    "speaker": settings.SARVAM_SPEAKER,
                    "model": "bulbul:v2",
                },
            )
            r.raise_for_status()
            audios = r.json().get("audios") or []
            if not audios:
                return self._fallback(text, "sarvam returned no audio")
            return Speech("sarvam", audios[0], "audio/wav", text, False)


def as_playable(audio: bytes, mime_type: str) -> tuple[bytes, str]:
    """
    Return audio a browser <audio> element can play, and its type.

    Gemini has answered with a complete WAV (RIFF header, audio/wav) in
    testing, but its documented format is raw 16-bit PCM
    ("audio/L16;codec=pcm;rate=24000"), which no browser plays. Raw PCM is
    wrapped in a WAV header; anything already containerised passes through.
    """
    mime = (mime_type or "").lower()
    if audio[:4] == b"RIFF":
        return audio, "audio/wav"
    if "l16" in mime or "pcm" in mime or not mime:
        match = re.search(r"rate=(\d+)", mime)
        rate = int(match.group(1)) if match else 24000
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(audio)
        return buf.getvalue(), "audio/wav"
    return audio, mime.split(";")[0]


tts_service = TTSService()
