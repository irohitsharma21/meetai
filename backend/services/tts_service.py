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
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

import httpx

from core.config import settings


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

    @property
    def provider(self) -> str:
        return (settings.TTS_PROVIDER or "browser").lower()

    @property
    def available(self) -> bool:
        return settings.tts_configured

    def describe(self) -> dict:
        return {
            "provider": self.provider,
            "configured": self.available,
            "server_side": self.provider != "browser",
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
        async with httpx.AsyncClient(timeout=self.TIMEOUT) as client:
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

        async with httpx.AsyncClient(timeout=self.TIMEOUT) as client:
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

        async with httpx.AsyncClient(timeout=self.TIMEOUT) as client:
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


tts_service = TTSService()
