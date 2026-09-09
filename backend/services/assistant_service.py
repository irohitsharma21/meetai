"""
In-meeting voice assistant.

Ask a question out loud during a meeting and get a spoken answer grounded in
what has actually been said:

    mic audio ──► Groq Whisper ──► question text
                                       │
                    live transcript ───┼──► Groq LLM ──► answer text
                    past meetings  ────┘                    │
                                                       TTS ─┴─► spoken reply

Two things make this more than a chatbot bolted onto a meeting:

**It is grounded twice.** The recent turns of the current meeting supply
immediate context ("what did she just commit to?"), while semantic search over
past meetings supplies history ("what did we decide about this last month?").
The prompt keeps the two clearly separated so the model cannot present last
month's decision as something said just now.

**It refuses rather than guesses.** Meeting recall is exactly where a
confident wrong answer does damage, so the prompt requires the assistant to
say it does not know when the context does not contain the answer.

The assistant is addressed explicitly rather than always-on: a system that
interjects on its own during a meeting is a worse product, and permanently
streaming audio to a third-party STT is a worse privacy posture.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Sequence

from core.config import settings
from models.meeting_model import TranscriptEntry
from services.ai_analysis_service import AIAnalysisService, AIUnavailable
from services.search_service import search_service
from services.tts_service import tts_service

WAKE_WORDS = ("hey meet", "hey meetai", "meetai", "hey assistant", "ask meetai")

ASSISTANT_PROMPT = """You are the MeetAI assistant, answering a question asked \
aloud during a live meeting.

QUESTION: {question}

WHAT HAS BEEN SAID IN THIS MEETING (most recent last):
{live_context}

{history_block}
Rules:
- Answer only from the context above. Never invent a fact, a name or a date.
- If the context does not answer it, say so in one sentence.
- Keep it under 45 words. This will be read aloud, so write it to be spoken:
  no bullet points, no markdown, no citation brackets.
- Attribute clearly when it matters: "Arjun said he'd have it by Friday."
- Distinguish this meeting from earlier ones if you use both."""


@dataclass
class AssistantReply:
    question: str
    answer: str
    speech: dict
    used_history: bool
    sources: list[dict]

    def to_dict(self) -> dict:
        return {
            "question": self.question,
            "answer": self.answer,
            "speech": self.speech,
            "used_history": self.used_history,
            "sources": self.sources,
        }


class AssistantService:
    """Speech-in, speech-out question answering over meeting context."""

    def __init__(self) -> None:
        self._ai = AIAnalysisService()

    @property
    def available(self) -> bool:
        return settings.groq_configured

    def describe(self) -> dict:
        return {
            "available": self.available,
            "wake_words": list(WAKE_WORDS),
            "tts": tts_service.describe(),
            "semantic_history": settings.SEMANTIC_SEARCH_ENABLED,
        }

    # ── speech in ─────────────────────────────────────────────────────
    async def transcribe(self, audio: bytes, mime_type: str = "audio/webm") -> str:
        """Transcribe a spoken question with Groq Whisper."""
        if not self.available:
            raise AIUnavailable(
                "GROQ_API_KEY is not set. The voice assistant needs it for "
                "speech-to-text. Get a free key at https://console.groq.com/keys"
            )

        suffix = "webm" if "webm" in mime_type else "wav"
        try:
            response = await self._ai._client.audio.transcriptions.create(
                file=(f"question.{suffix}", io.BytesIO(audio), mime_type),
                model=settings.GROQ_TRANSCRIPTION_MODEL,
                language="en",
                temperature=0.0,
            )
        except Exception as exc:
            raise AIUnavailable(
                f"Speech-to-text failed ({exc.__class__.__name__}). "
                "Check GROQ_API_KEY in backend/.env."
            ) from exc
        return (response.text or "").strip()

    @staticmethod
    def strip_wake_word(text: str) -> tuple[str, bool]:
        """Remove a leading wake word. Returns (question, was_addressed)."""
        lowered = text.lower().lstrip(" ,.")
        for wake in WAKE_WORDS:
            if lowered.startswith(wake):
                return text[len(wake):].lstrip(" ,.?!"), True
        return text, False

    # ── answering ─────────────────────────────────────────────────────
    async def ask(
        self,
        question: str,
        live_entries: Sequence[TranscriptEntry],
        meeting_id: str,
        searchable_meeting_ids: Sequence[str] | None = None,
        speak: bool = True,
    ) -> AssistantReply:
        """Answer a question, optionally synthesising speech for the reply."""
        if not self.available:
            raise AIUnavailable(
                "GROQ_API_KEY is not set. Add a free key from "
                "https://console.groq.com/keys to enable the assistant."
            )

        # Recent turns only: the whole transcript would bury the question and
        # burn context on the parts nobody is asking about.
        recent = list(live_entries)[-40:]
        live_context = "\n".join(
            f"{e.speaker} [{e.time}]: {e.text}" for e in recent
        ) or "(nothing has been said yet)"

        history_block = ""
        sources: list[dict] = []
        used_history = False

        if settings.SEMANTIC_SEARCH_ENABLED and searchable_meeting_ids:
            try:
                others = [m for m in searchable_meeting_ids if m != meeting_id]
                if others:
                    passages = await search_service.search(question, limit=3, meeting_ids=others)
                    # Only bring in history that is actually relevant; weak
                    # matches add noise and invite the model to conflate
                    # meetings.
                    strong = [p for p in passages if p.score >= 0.55]
                    if strong:
                        used_history = True
                        sources = [p.to_dict() for p in strong]
                        history_block = (
                            "FROM EARLIER MEETINGS:\n"
                            + "\n\n".join(
                                f"[{p.meeting_title}] {p.text}" for p in strong
                            )
                            + "\n\n"
                        )
            except Exception as exc:
                print(f"[assistant] history lookup skipped: {exc}")

        prompt = ASSISTANT_PROMPT.format(
            question=question,
            live_context=live_context,
            history_block=history_block,
        )

        try:
            answer = await self._ai._chat(prompt, temperature=0.2, fast=True)
        except AIUnavailable:
            raise
        except Exception as exc:
            raise AIUnavailable(
                f"The language model rejected the request "
                f"({exc.__class__.__name__}). Check GROQ_API_KEY in backend/.env."
            ) from exc
        speech = (await tts_service.synthesise(answer)).to_dict() if speak else {}

        return AssistantReply(
            question=question,
            answer=answer,
            speech=speech,
            used_history=used_history,
            sources=sources,
        )


assistant_service = AssistantService()
