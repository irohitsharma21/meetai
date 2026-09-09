"""
AI Analysis Service – Groq LLM integration.

Provides:
  1. Real-time "Next Action" detection (commitments, deadlines, scheduling)
  2. Post-meeting report generation:
     - Executive summary
     - Minutes of Meeting (Markdown)
     - Sentiment analysis
"""

import json
import re
from typing import List, Optional


from core.config import settings
from services.llm_client import LLMUnavailable, extract_json, llm_client
from models.meeting_model import (
    AIAnalysis,
    ActionDetectionResult,
    NextAction,
    ActionStatus,
    SentimentLabel,
    SentimentResult,
    TranscriptEntry,
)


# ══════════════════════════════════════════════════════════════════════════════
# Prompt templates
# ══════════════════════════════════════════════════════════════════════════════

ACTION_DETECTION_PROMPT = """You are an AI assistant analyzing a meeting transcript for action items.

Analyze the latest transcript addition and determine if it contains:
- Scheduling commitments ("let's meet on...", "I'll send this by...")
- Task assignments ("can you handle...", "you're responsible for...")
- Deadlines ("due by Friday", "need it before...")
- Scheduling intent ("book a slot for...", "set up a call...")

LATEST TRANSCRIPT:
{transcript_chunk}

FULL CONTEXT (last 10 entries):
{context}

Respond ONLY with valid JSON in this exact format:
{{
  "trigger": true/false,
  "type": "schedule|commitment|deadline|task|null",
  "confidence": 0.0-1.0,
  "suggested_action": "human-readable action string or null",
  "task": "brief task description or null",
  "assignee": "name or null",
  "date": "date/time mentioned or null",
  "deadline": "deadline if different from date or null"
}}

If no actionable item detected, set trigger=false and confidence<0.5."""

SUMMARY_PROMPT = """You are a professional meeting summarizer. Create a concise executive summary.

MEETING TITLE: {title}
PARTICIPANTS: {participants}
DURATION: {duration}

FULL TRANSCRIPT:
{transcript}

Instructions:
- Maximum 200 words
- Highlight key decisions made
- Mention who said what only when critical
- Use professional business language
- Structure: [Context] [Key Discussion Points] [Decisions Made]

Return ONLY the summary text, no headers or labels."""

MOM_PROMPT = """You are a professional meeting secretary. Generate formal Minutes of Meeting (MoM).

MEETING TITLE: {title}
DATE: {date}
PARTICIPANTS: {participants}
DURATION: {duration}

FULL TRANSCRIPT:
{transcript}

Generate MoM in Markdown format with these exact sections:
## Meeting Details
- Date, Time, Duration, Participants

## Agenda Items Discussed
- Bullet points of topics covered

## Key Discussion Points
- Detailed points per topic

## Decisions Made
- Numbered list of decisions

## Action Items
| Task | Assignee | Deadline | Status |
|------|----------|----------|--------|

## Next Meeting
- Agreed next steps or next meeting (if any)

Be precise and professional. Use exact quotes for important statements."""

ACTION_EXTRACTION_PROMPT = """You are reviewing a completed meeting transcript to
extract every commitment that was actually made.

A commitment is a task someone agreed to do, a decision with a follow-up, or a
date that was fixed. Only include things that were genuinely agreed - do not
invent follow-ups that sound plausible, and do not turn a question into a task.
If nobody committed to anything, return an empty list; that is a valid answer.

Transcript:
{transcript}

Return ONLY valid JSON in exactly this shape:
{{
  "actions": [
    {{
      "task": "what will be done, in the imperative",
      "assignee": "the speaker who agreed to it, or null",
      "deadline": "the deadline as it was said, e.g. 'Friday', or null",
      "date": "an ISO date if one was stated explicitly, else null",
      "confidence": 0.0
    }}
  ]
}}
"""


SENTIMENT_PROMPT = """You are an expert in communication sentiment analysis.

Analyze the emotional tone and sentiment of this meeting transcript.

TRANSCRIPT:
{transcript}

Return ONLY valid JSON:
{{
  "overall": "positive|neutral|negative",
  "confidence": 0.0-1.0,
  "emotional_tone": "brief description of overall emotional atmosphere",
  "key_shifts": [
    "list of notable emotional shifts or tension points",
    "e.g., 'Disagreement on budget at 10:15'",
    "e.g., 'Positive resolution after compromise at 10:22'"
  ],
  "speaker_sentiments": {{
    "speaker_name": "positive|neutral|negative"
  }}
}}"""


# ══════════════════════════════════════════════════════════════════════════════
# Service
# ══════════════════════════════════════════════════════════════════════════════

class AIUnavailable(RuntimeError):
    """
    Raised when an AI feature is used without a configured Groq key.

    Carries an actionable message so the API can return "here is what to do"
    rather than a 500 with a stack trace.
    """


class AIAnalysisService:
    """LLM-powered analysis for action detection and report generation.

    Model selection, provider choice and retry behaviour all live in
    `llm_client`; this class owns only the prompts and the shape of the result.
    """

    def __init__(self):
        self._llm = llm_client

    @property
    def available(self) -> bool:
        return self._llm.available

    # ── Helper: parse JSON from LLM response ──────────────────────────────────
    @staticmethod
    def _extract_json(text: str) -> dict:
        """Extract the JSON object from a model response. See llm_client."""
        return extract_json(text)

    async def _chat(self, prompt: str, temperature: float = 0.3, fast: bool = False) -> str:
        """Send a chat completion request through the configured provider."""
        try:
            return await self._llm.chat(prompt, temperature=temperature, fast=fast)
        except LLMUnavailable as exc:
            # Callers already degrade gracefully on AIUnavailable, so keep that
            # contract rather than leaking a second exception type outwards.
            raise AIUnavailable(str(exc)) from exc

    # ── 1. Real-time action detection ─────────────────────────────────────────
    async def detect_next_action(
        self,
        new_entry: TranscriptEntry,
        context: List[TranscriptEntry],
    ) -> ActionDetectionResult:
        """
        Detect commitments / scheduling intent in the latest transcript entry.
        Uses the fast model for low-latency response (<500ms target).
        """
        transcript_chunk = f"{new_entry.speaker}: {new_entry.text}"
        context_text = "\n".join(
            f"{e.speaker} [{e.time}]: {e.text}" for e in context[-10:]
        )

        prompt = ACTION_DETECTION_PROMPT.format(
            transcript_chunk=transcript_chunk,
            context=context_text,
        )

        try:
            raw = await self._chat(prompt, temperature=0.1, fast=True)
            data = self._extract_json(raw)

            if not data.get("trigger", False) or data.get("confidence", 0) < 0.6:
                return ActionDetectionResult(trigger=False, confidence=data.get("confidence", 0))

            next_action = None
            if data.get("task"):
                next_action = NextAction(
                    task=data["task"],
                    assignee=data.get("assignee"),
                    date=data.get("date"),
                    deadline=data.get("deadline"),
                    confidence=data.get("confidence", 0.9),
                )

            return ActionDetectionResult(
                trigger=True,
                type=data.get("type"),
                confidence=data.get("confidence", 0.9),
                suggested_action=data.get("suggested_action"),
                raw_text=new_entry.text,
                next_action=next_action,
            )

        except Exception as e:
            print(f"Action detection error: {e}")
            return ActionDetectionResult(trigger=False, confidence=0.0)

    # ── 2. Post-meeting summary ────────────────────────────────────────────────
    async def generate_summary(
        self,
        title: str,
        participants: List[str],
        transcript: List[TranscriptEntry],
        duration_seconds: Optional[int] = None,
    ) -> str:
        """Generate a concise executive summary (≤200 words)."""
        transcript_text = self._format_transcript(transcript)
        duration = self._format_duration(duration_seconds)

        prompt = SUMMARY_PROMPT.format(
            title=title,
            participants=", ".join(participants),
            duration=duration,
            transcript=transcript_text,
        )
        return await self._chat(prompt, temperature=0.4)

    # ── 3. Minutes of Meeting ─────────────────────────────────────────────────
    async def generate_mom(
        self,
        title: str,
        date: str,
        participants: List[str],
        transcript: List[TranscriptEntry],
        duration_seconds: Optional[int] = None,
    ) -> str:
        """Generate formal Minutes of Meeting in Markdown."""
        transcript_text = self._format_transcript(transcript)
        duration = self._format_duration(duration_seconds)

        prompt = MOM_PROMPT.format(
            title=title,
            date=date,
            participants=", ".join(participants),
            duration=duration,
            transcript=transcript_text,
        )
        return await self._chat(prompt, temperature=0.3)

    # ── 4. Sentiment analysis ─────────────────────────────────────────────────
    async def analyze_sentiment(
        self, transcript: List[TranscriptEntry]
    ) -> SentimentResult:
        """Analyse overall tone, emotional shifts, and per-speaker sentiment."""
        transcript_text = self._format_transcript(transcript)
        prompt = SENTIMENT_PROMPT.format(transcript=transcript_text)

        try:
            raw = await self._chat(prompt, temperature=0.2)
            data = self._extract_json(raw)

            return SentimentResult(
                overall=SentimentLabel(data.get("overall", "neutral")),
                confidence=float(data.get("confidence", 0.7)),
                key_shifts=data.get("key_shifts", []),
                emotional_tone=data.get("emotional_tone"),
            )
        except Exception as e:
            print(f"Sentiment analysis error: {e}")
            return SentimentResult(overall=SentimentLabel.NEUTRAL, confidence=0.5)

    # ── 5. Full report orchestration ──────────────────────────────────────────
    async def extract_actions(
        self, transcript: List[TranscriptEntry]
    ) -> List[NextAction]:
        """
        Pull every commitment out of a finished transcript in one pass.

        Live detection runs per utterance while a meeting is happening, but it
        only ever sees meetings that were transcribed through the WebSocket. A
        transcript that arrived any other way - imported, seeded, or from a
        session where detection was unavailable - would otherwise produce a
        wrap-up with an empty actions list and no explanation, which reads as
        the feature being broken rather than as nothing having been promised.
        """
        if not transcript:
            return []

        prompt = ACTION_EXTRACTION_PROMPT.format(
            transcript=self._format_transcript(transcript)
        )
        raw = await self._chat(prompt, temperature=0.1)
        data = self._extract_json(raw)

        actions: List[NextAction] = []
        for item in data.get("actions", []) or []:
            task = (item.get("task") or "").strip()
            if not task:
                continue
            actions.append(
                NextAction(
                    task=task,
                    assignee=item.get("assignee") or None,
                    date=item.get("date") or None,
                    deadline=item.get("deadline") or None,
                    confidence=float(item.get("confidence") or 0.8),
                )
            )
        return actions

    async def generate_full_report(
        self,
        title: str,
        date: str,
        participants: List[str],
        transcript: List[TranscriptEntry],
        report_types: List[str],
        duration_seconds: Optional[int] = None,
        existing_analysis: Optional[AIAnalysis] = None,
    ) -> AIAnalysis:
        """Generate the requested report sections concurrently."""
        import asyncio

        analysis = existing_analysis or AIAnalysis()

        tasks = {}
        if "summary" in report_types:
            tasks["summary"] = self.generate_summary(title, participants, transcript, duration_seconds)
        if "mom" in report_types:
            tasks["mom"] = self.generate_mom(title, date, participants, transcript, duration_seconds)
        if "sentiment" in report_types:
            tasks["sentiment"] = self.analyze_sentiment(transcript)
        if "actions" in report_types:
            tasks["actions"] = self.extract_actions(transcript)

        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        result_map = dict(zip(tasks.keys(), results))

        if "summary" in result_map and not isinstance(result_map["summary"], Exception):
            analysis.summary = result_map["summary"]
        if "mom" in result_map and not isinstance(result_map["mom"], Exception):
            analysis.mom = result_map["mom"]
        if "sentiment" in result_map and not isinstance(result_map["sentiment"], Exception):
            analysis.sentiment = result_map["sentiment"]

        if "actions" in result_map and not isinstance(result_map["actions"], Exception):
            extracted = result_map["actions"] or []
            # Live detection may already have stored some of these. Merge on the
            # task text rather than replacing, so a commitment confirmed during
            # the meeting keeps whatever state it was given.
            seen = {a.task.strip().lower() for a in analysis.next_actions}
            for action in extracted:
                if action.task.strip().lower() not in seen:
                    analysis.next_actions.append(action)
                    seen.add(action.task.strip().lower())

        from datetime import datetime, timezone
        analysis.generated_at = datetime.now(timezone.utc)
        return analysis

    # ── Utilities ─────────────────────────────────────────────────────────────
    @staticmethod
    def _format_transcript(entries: List[TranscriptEntry]) -> str:
        return "\n".join(f"[{e.time}] {e.speaker}: {e.text}" for e in entries)

    @staticmethod
    def _format_duration(seconds: Optional[int]) -> str:
        if not seconds:
            return "Unknown"
        h, m, s = seconds // 3600, (seconds % 3600) // 60, seconds % 60
        parts = []
        if h:
            parts.append(f"{h}h")
        if m:
            parts.append(f"{m}m")
        if s:
            parts.append(f"{s}s")
        return " ".join(parts) or "0s"


# Singleton
ai_analysis_service = AIAnalysisService()
