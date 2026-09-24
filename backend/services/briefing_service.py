"""
Briefing cues - the live half of "bring your documents to the meeting".

Rahul uploaded his pitch deck. Twenty minutes in, Rohit asks "ohh, how much is
its latency?". Before Rahul has finished saying "uh, let me check", a private
card appears on *his* screen only: **TTS latency is 350 ms** - Slide 4.

That is the whole feature, and most of this module exists to keep it from
being annoying:

**Silence is the default.** A cue that fires on topic overlap alone ("we should
talk about latency at some point") trains people to ignore the card. Every line
passes three gates, cheapest first: a word-count/filler gate, a retrieval score
threshold (tuned per sensitivity), and a fast LLM call instructed to say
"not relevant" whenever it is unsure. Any gate can end the evaluation.

**Grounded or nothing.** The card is something the owner will say out loud to
a room. So the LLM may only answer from the retrieved excerpts, its quote must
actually occur in the chunk it names (fuzzy-matched, then replaced with the
chunk's own words), and every number in the headline must appear in that
chunk. A cue that fails any of these is dropped, not repaired.

**Owners never cue themselves.** Rahul reading his own slide aloud must not
trigger a card telling him what is on his slide.

**Backpressure, not queues.** Speech arrives faster than an LLM answers. Each
owner has at most one evaluation in flight; lines that arrive meanwhile
overwrite a single pending slot, so the newest line wins and stale ones are
never evaluated. On top of that: at most one cue per owner per 8 s, and the
same chunk is not cued twice within 90 s.

**Degrade, don't fail.** Without an LLM key the engine still works
extractively - when the retrieval score is high it surfaces the best matching
sentence from the best chunk. Without the embedding model it falls back to
lexical retrieval. `on_transcript` never raises: it runs as a fire-and-forget
task off the transcript pipeline, and a briefing bug must not cost the meeting
its transcript.
"""

from __future__ import annotations

import asyncio
import difflib
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Sequence

from db.mongodb import get_db, get_users_collection
from models.meeting_model import TranscriptEntry
from services.document_service import Hit, document_service, tokens
from services.llm_client import llm_client
from services.realtime import manager

SENSITIVITIES = ("low", "medium", "high")
DEFAULT_SETTINGS = {"enabled": True, "sensitivity": "medium"}

CUE_COOLDOWN_S = float(os.getenv("BRIEFING_CUE_COOLDOWN_S", "8"))
CHUNK_REPEAT_S = float(os.getenv("BRIEFING_CHUNK_REPEAT_S", "90"))
# A pending line older than this is no longer "what was just said".
STALE_AFTER_S = 10.0
LIVE_LLM_TIMEOUT_S = float(os.getenv("BRIEFING_LLM_TIMEOUT_S", "6"))
ASK_LLM_TIMEOUT_S = 20.0
MIN_WORDS = 4
TOP_K = 3


def _llm_available() -> bool:
    return llm_client.available


async def _chat_json(prompt: str) -> dict:
    """
    The live relevance decision.

    `fast=True` puts the shared client on each provider's small model and on
    the short hedge, so a stalled provider is raced by the next one after
    LLM_HEDGE_FAST_S instead of costing the whole cue. The caller bounds the
    total with asyncio.wait_for.
    """
    return await llm_client.chat_json(prompt, temperature=0.0, fast=True, max_tokens=600)


@dataclass(frozen=True)
class Thresholds:
    """
    Per-sensitivity gates.

    Semantic scores are the hybrid from document_service (bge-small cosine +
    0.10 x lexical coverage). Calibrated on a pitch deck / PDF / notes fixture
    against 8 answerable questions and 11 non-answerable lines:

    * answerable:        0.57 0.66 0.67 0.73 0.73 0.84 0.86 0.90
    * small talk:        0.48 - 0.56 (weather, lunch, "next agenda item")
    * same topic, not a question the docs answer ("latency matters in our
      industry too", "what price did you pay for your house"): 0.61 - 0.71

    So a 0.60 gate keeps small talk away from the LLM entirely, and the LLM is
    what rejects the topic-adjacent lines. Without an LLM nothing rejects
    them, hence solo thresholds above the 0.71 ceiling.

    Lexical coverage (no embedding model): answerable 0.28 - 1.0, non-
    answerable 0 - 0.28. Coarser, so the solo bar is high.

    * `semantic` / `lexical`: minimum score before the LLM is even asked.
      The LLM is the precision filter, so these are recall-oriented.
    * `*_solo`: minimum score to cue *without* an LLM (extractive mode).
      Much higher, because nothing else stands between the score and the
      owner's screen.
    """
    semantic: float
    semantic_solo: float
    lexical: float
    lexical_solo: float


THRESHOLDS = {
    "low":    Thresholds(semantic=0.66, semantic_solo=0.82, lexical=0.50, lexical_solo=0.99),
    "medium": Thresholds(semantic=0.60, semantic_solo=0.75, lexical=0.35, lexical_solo=0.75),
    "high":   Thresholds(semantic=0.56, semantic_solo=0.72, lexical=0.25, lexical_solo=0.55),
}

_FILLER = re.compile(
    r"^(?:\W|yeah|yes|yep|no|nope|ok|okay|sure|right|cool|great|nice|thanks|"
    r"thank you|uh+|um+|hmm+|oh+|ah+|alright|got it|makes sense|i see|"
    r"sounds good|go ahead|exactly|totally|absolutely|mm+|huh)+$",
    re.IGNORECASE,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def worth_checking(text: str) -> bool:
    """The free gate: enough words, not pure filler, some content word."""
    text = (text or "").strip()
    if len(text.split()) < MIN_WORDS:
        return False
    if _FILLER.match(text):
        return False
    return bool(tokens(text))


def _words_cap(text: str, n: int) -> str:
    words = (text or "").split()
    if len(words) <= n:
        return " ".join(words)
    return " ".join(words[:n]).rstrip(",;:-") + "…"


# ── grounding checks ──────────────────────────────────────────────────────
def _norm_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", (text or "").lower())


def ground_quote(quote: str, chunk: str) -> Optional[str]:
    """
    Return the chunk's own wording for `quote`, or None if it is not there.

    Models paraphrase even when told to copy, and they normalise whitespace,
    quotes and bullets. So the match is fuzzy - but what is *returned* is the
    matching span of the original chunk, which makes the quote verbatim by
    construction instead of by trust.
    """
    quote = (quote or "").strip().strip('"“”\'').replace("…", " ").replace("...", " ")
    q = _norm_words(quote)
    if not q:
        return None
    original = chunk.split()
    normed = [" ".join(_norm_words(w)) for w in original]
    target = " ".join(q)

    # The exact-length window is tried first and only a strictly better ratio
    # replaces it, so a verbatim quote never grows a neighbouring word.
    n = len(quote.split())          # windows are measured in the chunk's own words
    best, best_span = 0.0, None
    for size in (n, n - 1, n + 1, n - 2, n + 2):
        if size < 1:
            continue
        for start in range(0, max(1, len(original) - size + 1)):
            window = " ".join(w for w in normed[start : start + size] if w)
            if not window:
                continue
            ratio = difflib.SequenceMatcher(None, target, window, autojunk=False).ratio()
            if ratio > best + 1e-9:
                best, best_span = ratio, (start, start + size)
    if best < 0.85 or best_span is None:
        return None
    span = " ".join(original[best_span[0] : best_span[1]])
    return span[:200].rstrip()


_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


def numbers_grounded(claim: str, chunk: str) -> bool:
    """Every number in the claim must appear in the chunk. No arithmetic, no recall."""
    have = {n.replace(",", "") for n in _NUMBER.findall(chunk)}
    return all(n.replace(",", "") in have for n in _NUMBER.findall(claim or ""))


def _sentences(text: str) -> list[str]:
    parts: list[str] = []
    for line in text.split("\n"):
        line = re.sub(r"^\s*(?:Speaker notes:\s*)", "", line).strip(" •-*\t")
        parts.extend(s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", line))
    return [p for p in parts if len(p.split()) >= 2]


def extractive_answer(query: str, chunk: str) -> Optional[str]:
    """The sentence of `chunk` that best answers `query` - the no-LLM headline."""
    q = set(tokens(query))
    best, best_score = None, 0.0
    for sentence in _sentences(chunk):
        s = set(tokens(sentence))
        score = len(q & s) + (0.25 if _NUMBER.search(sentence) else 0.0)
        if score > best_score:
            best, best_score = sentence, score
    # 0.25 alone means "has a number but shares no word with the question" -
    # not an answer, just a sentence.
    return best if best_score >= 1 else None


# ── prompt ────────────────────────────────────────────────────────────────
LIVE_PROMPT = """You are a silent meeting assistant for {owner}. {owner} uploaded \
the documents excerpted below. Someone ELSE in the meeting just spoke. Decide \
whether an excerpt gives {owner} a specific fact that answers or directly \
informs what was just said, so {owner} can respond.

CONVERSATION (latest line last):
{conversation}

EXCERPTS FROM {owner}'S DOCUMENTS:
{excerpts}

Respond with JSON only:
{{"relevant": true or false, "chunk_index": <excerpt number>, "headline": "...", "detail": "...", "quote": "..."}}

Rules:
- relevant=true ONLY if the latest line asks about, questions, or makes a claim \
about something an excerpt specifically answers. Sharing a topic word, or a \
general remark about the topic, is not enough. Small talk, logistics, jokes, and questions the excerpts do not answer \
are relevant=false. If unsure, relevant=false.
- Use ONLY the excerpts. Never invent, estimate, convert or compute numbers, \
names or dates - copy them exactly as written.
- headline: at most 14 words, the answer phrased so {owner} can say it aloud \
(example: "TTS latency is 350 ms").
- detail: at most 35 words of supporting facts from the same excerpt, or "". \
No commentary about the question.
- quote: copy a short span (under 200 characters) word for word from the \
chosen excerpt that proves the headline.
- If relevant=false, the other fields may be empty."""

ASK_PROMPT = """{owner} is asking their own documents a question during a meeting.

QUESTION: {question}

EXCERPTS FROM {owner}'S DOCUMENTS:
{excerpts}

Respond with JSON only:
{{"relevant": true or false, "chunk_index": <excerpt number>, "headline": "...", "detail": "...", "quote": "..."}}

Rules:
- relevant=true only if an excerpt actually answers the question. If unsure, relevant=false.
- Use ONLY the excerpts. Never invent, estimate, convert or compute numbers, \
names or dates - copy them exactly as written.
- headline: at most 14 words, the answer phrased so it can be said aloud.
- detail: at most 35 words of supporting facts from the same excerpt, or "". \
No commentary about the question.
- quote: copy a short span (under 200 characters) word for word from the \
chosen excerpt that proves the headline."""


# ── per-owner live state ──────────────────────────────────────────────────
@dataclass
class _Job:
    entry: TranscriptEntry
    previous: Optional[TranscriptEntry]
    sensitivity: str
    queued_at: float


@dataclass
class _OwnerState:
    running: bool = False
    pending: Optional[_Job] = None
    last_cue_at: float = 0.0
    recent_chunks: dict = field(default_factory=dict)   # (doc_id, i) -> monotonic ts


class BriefingService:
    """Decides when an owner's documents answer what someone else just said."""

    def __init__(self) -> None:
        self._settings: dict[tuple[str, str], dict] = {}
        self._display_names: dict[str, str] = {}
        self._state: dict[tuple[str, str], _OwnerState] = {}

    # ── settings ──────────────────────────────────────────────────────
    @property
    def _col(self):
        return get_db()["briefing_settings"]

    async def get_settings(self, meeting_id: str, owner: str) -> dict:
        key = (meeting_id, owner)
        if key in self._settings:
            return dict(self._settings[key])
        doc = await self._col.find_one({"meeting_id": meeting_id, "owner": owner})
        settings = dict(DEFAULT_SETTINGS)
        if doc:
            settings["enabled"] = bool(doc.get("enabled", True))
            if doc.get("sensitivity") in SENSITIVITIES:
                settings["sensitivity"] = doc["sensitivity"]
        self._settings[key] = settings
        return dict(settings)

    async def put_settings(
        self, meeting_id: str, owner: str, enabled: bool, sensitivity: str
    ) -> dict:
        if sensitivity not in SENSITIVITIES:
            raise ValueError(f"sensitivity must be one of {', '.join(SENSITIVITIES)}")
        settings = {"enabled": bool(enabled), "sensitivity": sensitivity}
        await self._col.update_one(
            {"meeting_id": meeting_id, "owner": owner},
            {"$set": {**settings, "updated_at": _now_iso()}},
            upsert=True,
        )
        self._settings[(meeting_id, owner)] = settings
        return dict(settings)

    def describe(self) -> dict:
        return {"semantic": document_service.semantic_enabled, "llm": _llm_available()}

    # ── speaker identity ──────────────────────────────────────────────
    async def _is_owner_speaking(self, owner: str, speaker: str) -> bool:
        """
        The live pipeline labels lines with the username, but manually appended
        or imported lines may carry a display name. Treat either as the owner.
        """
        speaker = (speaker or "").strip().lower()
        if not speaker:
            return False
        if speaker == owner.lower():
            return True
        if owner not in self._display_names:
            try:
                user = await get_users_collection().find_one({"username": owner})
            except Exception:
                user = None
            self._display_names[owner] = ((user or {}).get("display_name") or "").strip().lower()
        return bool(self._display_names[owner]) and speaker == self._display_names[owner]

    # ── live hook ─────────────────────────────────────────────────────
    async def on_transcript(
        self,
        meeting_id: str,
        entry: TranscriptEntry,
        context: list[TranscriptEntry],
    ) -> None:
        """
        Called (via create_task) for every finalized transcript line. Never raises.

        The common case - nobody in the meeting has uploaded anything - costs a
        dict lookup: the owner set is cached and only rebuilt after an upload
        or delete.
        """
        try:
            text = (entry.text or "").strip()
            if not text:
                return
            owners = await document_service.owners(meeting_id)
            if not owners:
                return
            candidates = owners & manager.usernames(meeting_id)
            if not candidates or not worth_checking(text):
                return

            previous = None
            for e in reversed(context or []):
                if e.id != entry.id and (e.text or "").strip():
                    previous = e
                    break

            for owner in candidates:
                if await self._is_owner_speaking(owner, entry.speaker):
                    continue
                settings = await self.get_settings(meeting_id, owner)
                if not settings["enabled"]:
                    continue
                self._enqueue(meeting_id, owner, _Job(
                    entry, previous, settings["sensitivity"], time.monotonic()
                ))
        except Exception as exc:
            print(f"[briefing] on_transcript failed: {type(exc).__name__}: {exc}")

    def _enqueue(self, meeting_id: str, owner: str, job: _Job) -> None:
        state = self._state.setdefault((meeting_id, owner), _OwnerState())
        if state.running:
            state.pending = job            # newest wins; older pending is dropped
            return
        state.running = True
        asyncio.create_task(self._drain(meeting_id, owner, job))

    async def _drain(self, meeting_id: str, owner: str, job: Optional[_Job]) -> None:
        state = self._state[(meeting_id, owner)]
        try:
            while job is not None:
                if time.monotonic() - job.queued_at <= STALE_AFTER_S:
                    try:
                        await self._evaluate_live(meeting_id, owner, job, state)
                    except Exception as exc:
                        print(f"[briefing] evaluation failed for {owner}: {type(exc).__name__}: {exc}")
                job, state.pending = state.pending, None
        finally:
            state.running = False

    async def _evaluate_live(
        self, meeting_id: str, owner: str, job: _Job, state: _OwnerState
    ) -> None:
        now = time.monotonic()
        if now - state.last_cue_at < CUE_COOLDOWN_S:
            return
        state.recent_chunks = {
            k: t for k, t in state.recent_chunks.items() if now - t < CHUNK_REPEAT_S
        }

        entry, prev = job.entry, job.previous
        cue, reason = await self.evaluate(
            meeting_id, owner,
            text=entry.text,
            previous=(prev.speaker, prev.text) if prev else None,
            speaker=entry.speaker,
            sensitivity=job.sensitivity,
            exclude=set(state.recent_chunks),
            manual=False,
        )
        if cue is None:
            return
        if owner not in manager.usernames(meeting_id):
            return                          # left while we were thinking
        state.last_cue_at = time.monotonic()
        state.recent_chunks[(cue["source"]["doc_id"], cue.pop("_chunk"))] = state.last_cue_at
        await manager.send_to_user(meeting_id, owner, {"type": "cue", "cue": cue})

    # ── manual ask ────────────────────────────────────────────────────
    async def ask(self, meeting_id: str, owner: str, question: str) -> dict:
        """'Ask my docs' - same engine, no anti-spam, nothing pushed over WS."""
        question = (question or "").strip()
        if not question:
            return {"cue": None, "reason": "Ask a question first."}
        settings = await self.get_settings(meeting_id, owner)
        cue, reason = await self.evaluate(
            meeting_id, owner, text=question, previous=None, speaker=None,
            sensitivity=settings["sensitivity"], exclude=set(), manual=True,
        )
        if cue is not None:
            cue.pop("_chunk", None)
        return {"cue": cue, "reason": None if cue else reason}

    # ── the engine ────────────────────────────────────────────────────
    async def evaluate(
        self,
        meeting_id: str,
        owner: str,
        *,
        text: str,
        previous: Optional[tuple[str, str]],
        speaker: Optional[str],
        sensitivity: str,
        exclude: set,
        manual: bool,
    ) -> tuple[Optional[dict], str]:
        """
        Retrieve, gate on score, confirm with the LLM (or extract), ground.
        Returns (cue, reason) - reason explains a None cue for the ask endpoint.
        """
        th = THRESHOLDS.get(sensitivity, THRESHOLDS["medium"])

        hits = await self._retrieve(meeting_id, owner, text, previous)
        if not hits:
            if owner not in await document_service.owners(meeting_id):
                return None, "You have not uploaded any documents to this meeting."
            return None, "Nothing in your documents matches that."
        hits = [h for h in hits if (h.doc_id, h.chunk_index) not in exclude]
        if not hits:
            return None, "Already shown recently."

        def gate(h: Hit) -> float:
            return th.semantic if h.method == "semantic" else th.lexical

        def solo(h: Hit) -> float:
            return th.semantic_solo if h.method == "semantic" else th.lexical_solo

        # A manual question is deliberate, so it gets the next-more-permissive gate.
        slack = 0.04 if manual else 0.0
        passing = [h for h in hits if h.score >= gate(h) - slack]
        if not passing:
            return None, "Nothing in your documents matched closely enough."

        trigger = {"speaker": speaker, "text": text} if speaker is not None else None

        if _llm_available():
            try:
                cue = await asyncio.wait_for(
                    self._llm_decide(owner, text, previous, speaker, passing, manual),
                    timeout=ASK_LLM_TIMEOUT_S if manual else LIVE_LLM_TIMEOUT_S,
                )
                if cue is None:
                    return None, "Your documents don't answer that directly."
                hit, headline, detail, quote = cue
                return self._cue(meeting_id, trigger, hit, headline, detail, quote), ""
            except Exception as exc:
                # A slow or failing model degrades to the extractive path below,
                # which only fires on a strong match.
                print(f"[briefing] LLM decision unavailable ({type(exc).__name__}); extractive fallback")

        best = passing[0]
        if best.score < solo(best) - slack:
            if _llm_available():
                return None, "Found a possible match, but the AI model could not confirm it just now."
            return None, (
                "Found a possible match, but it isn't strong enough to show without "
                "an AI model. Set OPENROUTER_API_KEY for smarter cues."
            )
        query = f"{previous[1]} {text}" if previous else text
        sentence = extractive_answer(text, best.text) or extractive_answer(query, best.text)
        if not sentence:
            return None, "Nothing in your documents answers that directly."
        return self._cue(
            meeting_id, trigger, best, _words_cap(sentence, 14), "", sentence[:200]
        ), ""

    async def _retrieve(
        self, meeting_id: str, owner: str, text: str, previous: Optional[tuple[str, str]]
    ) -> list[Hit]:
        """
        Query with the line alone *and* with the previous line prepended, keep
        each chunk's best score. "How much is its latency?" needs the previous
        line to know what "it" is; "what does the Pro tier cost?" is diluted
        by an unrelated previous line. Taking the max serves both.
        """
        queries = [text]
        if previous and previous[1].strip():
            queries.append(f"{previous[1].strip()} {text}")
        merged: dict[tuple[str, int], Hit] = {}
        for q in queries:
            for h in await document_service.retrieve(meeting_id, owner, q, k=TOP_K):
                key = (h.doc_id, h.chunk_index)
                if key not in merged or h.score > merged[key].score:
                    merged[key] = h
        return sorted(merged.values(), key=lambda h: h.score, reverse=True)[:TOP_K]

    async def _llm_decide(
        self,
        owner: str,
        text: str,
        previous: Optional[tuple[str, str]],
        speaker: Optional[str],
        hits: Sequence[Hit],
        manual: bool,
    ):
        excerpts = "\n\n".join(
            f"[{i}] ({h.doc_name}, {h.locator})\n{h.text}" for i, h in enumerate(hits)
        )
        if manual:
            prompt = ASK_PROMPT.format(owner=owner, question=text, excerpts=excerpts)
        else:
            lines = []
            if previous:
                lines.append(f"{previous[0]}: {previous[1]}")
            lines.append(f"{speaker}: {text}")
            prompt = LIVE_PROMPT.format(
                owner=owner, conversation="\n".join(lines), excerpts=excerpts
            )

        result = await _chat_json(prompt)
        relevant = result.get("relevant") if isinstance(result, dict) else None
        if relevant is not True and str(relevant).strip().lower() != "true":
            return None
        headline = str(result.get("headline") or "").strip()
        detail = str(result.get("detail") or "").strip()
        if not headline:
            return None
        if _norm_words(detail) == _norm_words(headline) or \
                " ".join(_norm_words(detail)) in " ".join(_norm_words(headline)):
            detail = ""                     # a detail that repeats the headline adds nothing

        # Small models sometimes number the excerpt wrongly (counting lines,
        # or 1-based). The named excerpt is tried first; the others only as a
        # fallback, and the quote must still be found in whichever is used -
        # so this recovers a mis-indexed answer without loosening grounding.
        try:
            named = int(result.get("chunk_index", 0))
        except (TypeError, ValueError):
            named = -1
        order = ([named] if 0 <= named < len(hits) else []) + \
                [i for i in range(len(hits)) if i != named]

        raw_quote = str(result.get("quote") or "")
        for index in order:
            hit = hits[index]
            quote = ground_quote(raw_quote, hit.text)
            if quote is None:
                continue
            if not numbers_grounded(f"{headline} {detail}", hit.text):
                print(f"[briefing] dropped cue: ungrounded number in '{headline}'")
                return None
            return hit, _words_cap(headline, 14), _words_cap(detail, 35), quote

        print(f"[briefing] dropped cue: quote not found in any excerpt ('{raw_quote[:60]}')")
        return None

    @staticmethod
    def _cue(meeting_id: str, trigger, hit: Hit, headline: str, detail: str, quote: str) -> dict:
        return {
            "id": uuid.uuid4().hex,
            "meeting_id": meeting_id,
            "trigger": trigger,
            "headline": headline,
            "detail": detail,
            "quote": quote[:200],
            "source": {"doc_id": hit.doc_id, "doc_name": hit.doc_name, "locator": hit.locator},
            "score": round(float(hit.score), 3),
            "created_at": _now_iso(),
            # internal: popped before the cue leaves the process
            "_chunk": hit.chunk_index,
        }

    def forget_meeting(self, meeting_id: str) -> None:
        """Drop in-memory state for a finished meeting."""
        for key in [k for k in self._state if k[0] == meeting_id]:
            if not self._state[key].running:
                self._state.pop(key, None)
        for key in [k for k in self._settings if k[0] == meeting_id]:
            self._settings.pop(key, None)


briefing_service = BriefingService()
