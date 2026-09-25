"""
Live translation - hear everyone in your own language.

Rohit speaks only Tamil, Priya only Hindi. Rohit says a line; it is
transcribed in Tamil (each speaker is decoded in their declared language, see
core/languages.py), translated to Hindi, spoken in a Hindi voice, and played
to Priya only. Priya's replies make the same trip the other way. Nobody else
hears either translation.

How it stays out of the way:

**Per listener, shared per language.** Preferences (translate on/off, target
language, voice, how far to duck the original speaker) belong to one person
in one meeting. But the work is per *target language*: five Hindi listeners
cost one translation and one synthesis per line, not five.

**Opt-in, offered once.** Translation is off until the listener turns it on.
The first time they hear a language that is not theirs, they get one offer
("Rohit is speaking Tamil - translate to Hindi?"). Declining is remembered
per language and the offer is made at most once per language per process, so
a meeting never nags.

**Text first, voice second, in order.** The translated text is pushed the
moment the LLM answers; speech follows when synthesis finishes. Synthesis
times vary (4-11 s on the free tier), so audio passes through a small per
(meeting, target language) sequencer: lines are played in the order they
were spoken, even when a later line synthesises first. A line whose audio is
not ready within its budget is dropped rather than holding up everything
after it - a translation heard 30 s late is worse than one only read.

**Fast path, then the shared chain.** Translation races Gemini flash-lite
on its native endpoint (about 1 s for a line) against a second model and,
last, the shared LLM chain - see `_race`. Measured on the free tier, the
chain alone took 6-25 s per line, which is too late to be heard.

**Degrade, don't fail.** Without an LLM there is nothing to translate with
and the hook returns after making offers. Without server TTS the text event still
goes out and the client speaks it with a browser voice for the language's
locale. `on_transcript` never raises: it runs detached from the transcript
pipeline, and a translation bug must not cost the meeting its transcript.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from core.config import settings
from core.languages import DEFAULT_LANGUAGE, name_of, normalise
from db.mongodb import get_db, get_users_collection
from services.llm_client import extract_json, llm_client
from services.realtime import manager
from services.tts_service import gemini_http, tts_service

DEFAULT_PREFS: dict = {
    "spoken_language": None,     # None -> the account's native language
    "enabled": False,
    "target_language": None,     # None -> the account's native language
    "voice": True,
    "original_volume": 0.15,
    "declined": [],
}
PREF_KEYS = tuple(DEFAULT_PREFS)

# Account native languages change rarely (PUT /auth/me/language) and that
# route lives elsewhere, so the cache expires instead of being invalidated.
NATIVE_TTL_S = 30.0
# Translations kept for reuse, keyed (entry id, target language).
TEXT_CACHE_SIZE = 512
# Grace on top of a stage's own timeout before the audio sequencer gives up
# on the line at its head and moves on.
SEQ_GRACE_S = 1.0

# Lines not worth a translation call: no letters at all, or a lone
# acknowledgement a listener understands in any language. Kept deliberately
# small - "ஆம்" (yes) or "नहीं" (no) is short but carries meaning, so
# anything outside this list is translated, however brief.
_FILLER = re.compile(
    r"^(?:ok|okay|hmm+|mm+|uh+|um+|ah+|oh+|huh|hm)$", re.IGNORECASE
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def worth_translating(text: str) -> bool:
    text = (text or "").strip()
    if not re.search(r"[^\W\d_]", text):
        return False                      # punctuation / numbers only
    words = text.split()
    if len(words) == 1 and _FILLER.match(words[0].strip(".,!?…-")):
        return False
    return True


PROMPT = """You are a live interpreter in a meeting. Translate the LATEST LINE \
from {source} into {target}.

EARLIER LINES (context only - do NOT translate them):
{context}

LATEST LINE ({speaker}, {source}):
{text}

Rules:
- Translate only the latest line, faithfully and completely. Use the earlier \
lines only to resolve pronouns and elliptical references.
- Natural spoken {target}, as a fluent speaker would say it aloud in a \
meeting, written in {target}'s native script.
- Keep names, numbers and units exact. Keep product and technical terms \
(TTS, API, latency, dashboard...) the way {target} speakers commonly say them \
in conversation - often the English word, written in {target} script or as is.
- No explanations, notes, transliteration or quotation marks.

Respond with JSON only: {{"translation": "..."}}"""


# ── audio sequencer ───────────────────────────────────────────────────────
@dataclass
class _Slot:
    entry_id: str
    target: str
    listeners: list[str]
    future: asyncio.Future
    # Pushed forward by the producer as it moves from translation to
    # synthesis, so the sequencer only gives up on a line that is stuck.
    deadline: float


@dataclass
class _Group:
    """Listeners sharing one target language for one line."""
    target: str
    listeners: list[str] = field(default_factory=list)
    voice: list[str] = field(default_factory=list)


class TranslationService:
    def __init__(self) -> None:
        self._prefs: dict[tuple[str, str], dict] = {}
        self._native: dict[str, tuple[str, float]] = {}
        self._display: dict[str, str] = {}
        self._offered: set[tuple[str, str, str]] = set()
        self._texts: "OrderedDict[tuple[str, str], asyncio.Task]" = OrderedDict()
        self._queues: dict[tuple[str, str], deque[_Slot]] = {}
        self._pumps: dict[tuple[str, str], asyncio.Task] = {}
        self._plan_locks: dict[str, asyncio.Lock] = {}
        self._llm_sem: Optional[asyncio.Semaphore] = None
        self._tts_sem: Optional[asyncio.Semaphore] = None
        self._warmed_at = float("-inf")

    # Semaphores are created lazily so they bind to the running loop, not to
    # whichever loop (if any) existed at import time.
    @property
    def _llm_slots(self) -> asyncio.Semaphore:
        if self._llm_sem is None:
            self._llm_sem = asyncio.Semaphore(max(1, settings.TRANSLATION_MAX_CONCURRENT))
        return self._llm_sem

    @property
    def _tts_slots(self) -> asyncio.Semaphore:
        if self._tts_sem is None:
            self._tts_sem = asyncio.Semaphore(max(1, settings.TRANSLATION_TTS_MAX_CONCURRENT))
        return self._tts_sem

    # ── capabilities ──────────────────────────────────────────────────
    @property
    def can_translate(self) -> bool:
        return bool(settings.GEMINI_API_KEY) or llm_client.available

    def describe(self) -> dict:
        return {
            "server": tts_service.multilingual_available,
            "provider": tts_service.multilingual_provider,
        }

    def warm(self) -> None:
        """
        Open the Gemini connection ahead of the first translated line.

        Called when someone is offered translation or turns it on. The first
        request on a cold connection pays several seconds of TLS setup; paying
        it while the listener reads the offer means their first line is not
        the slow one. Fire-and-forget, at most once a minute.
        """
        if not settings.GEMINI_API_KEY or time.monotonic() - self._warmed_at < 60:
            return
        self._warmed_at = time.monotonic()

        async def ping() -> None:
            try:
                await gemini_http().get(
                    "https://generativelanguage.googleapis.com/v1beta/models",
                    params={"pageSize": 1}, timeout=15.0,
                    headers={"x-goog-api-key": settings.GEMINI_API_KEY},
                )
            except Exception:
                pass

        try:
            asyncio.get_running_loop().create_task(ping())
        except RuntimeError:
            pass

    # ── people ────────────────────────────────────────────────────────
    async def native_language(self, username: str) -> str:
        cached = self._native.get(username)
        if cached and time.monotonic() - cached[1] < NATIVE_TTL_S:
            return cached[0]
        try:
            user = await get_users_collection().find_one({"username": username})
        except Exception:
            user = None
        if user and user.get("display_name"):
            self._display[username] = user["display_name"]
        code = normalise((user or {}).get("native_language")) or DEFAULT_LANGUAGE
        self._native[username] = (code, time.monotonic())
        return code

    async def display_name(self, username: str) -> str:
        if username not in self._display:
            await self.native_language(username)      # loads the user doc
            self._display.setdefault(username, username)
        return self._display[username]

    def forget_user(self, username: str) -> None:
        """Drop cached account facts, e.g. after a native language change."""
        self._native.pop(username, None)
        self._display.pop(username, None)

    # ── preferences ───────────────────────────────────────────────────
    @property
    def _col(self):
        return get_db()["translation_prefs"]

    async def _stored_prefs(self, meeting_id: str, username: str) -> dict:
        key = (meeting_id, username)
        if key in self._prefs:
            return self._prefs[key]
        prefs = {k: (list(v) if isinstance(v, list) else v) for k, v in DEFAULT_PREFS.items()}
        try:
            doc = await self._col.find_one({"meeting_id": meeting_id, "username": username})
        except Exception as exc:
            print(f"[translation] prefs read failed: {type(exc).__name__}: {exc}")
            doc = None
        if doc:
            prefs["spoken_language"] = normalise(doc.get("spoken_language"), default=None)
            prefs["enabled"] = bool(doc.get("enabled", False))
            prefs["target_language"] = normalise(doc.get("target_language"), default=None)
            prefs["voice"] = bool(doc.get("voice", True))
            try:
                prefs["original_volume"] = min(1.0, max(0.0, float(doc.get("original_volume", 0.15))))
            except (TypeError, ValueError):
                pass
            prefs["declined"] = [
                c for c in (normalise(x, default=None) for x in doc.get("declined") or []) if c
            ]
        self._prefs[key] = prefs
        return prefs

    async def get_prefs(self, meeting_id: str, username: str) -> dict:
        """Prefs with defaults resolved, in the shape the REST API returns."""
        stored = await self._stored_prefs(meeting_id, username)
        native = await self.native_language(username)
        return {
            "spoken_language": stored["spoken_language"],
            "enabled": stored["enabled"],
            "target_language": stored["target_language"] or native,
            "voice": stored["voice"],
            "original_volume": stored["original_volume"],
            "declined": list(stored["declined"]),
            "native_language": native,
            "effective_spoken_language": stored["spoken_language"] or native,
        }

    async def update_prefs(self, meeting_id: str, username: str, changes: dict) -> dict:
        """
        Apply already-validated partial prefs. Returns the new resolved prefs.

        A target equal to the native language is stored as None, so it keeps
        following the account if the native language later changes.
        """
        changes = {k: v for k, v in changes.items() if k in PREF_KEYS}
        if changes:
            native = await self.native_language(username)
            if changes.get("target_language") == native:
                changes["target_language"] = None
            if changes.get("spoken_language") == native:
                changes["spoken_language"] = None
            await self._col.update_one(
                {"meeting_id": meeting_id, "username": username},
                {"$set": {**changes, "meeting_id": meeting_id, "username": username,
                          "updated_at": _now_iso()}},
                upsert=True,
            )
            self._prefs.pop((meeting_id, username), None)
        return await self.get_prefs(meeting_id, username)

    # ── speaker language (called by the STT pipeline) ─────────────────
    async def spoken_language(self, meeting_id: str, username: str) -> str:
        """What `username` speaks in this meeting: override, else native, else English."""
        try:
            stored = await self._stored_prefs(meeting_id, username)
            if stored["spoken_language"]:
                return stored["spoken_language"]
            return await self.native_language(username)
        except Exception as exc:
            print(f"[translation] spoken_language failed: {type(exc).__name__}: {exc}")
            return DEFAULT_LANGUAGE

    async def set_spoken_language(self, meeting_id: str, username: str, code: str) -> None:
        normalised = normalise(code, default=None)
        if normalised is None:
            raise ValueError(f"unknown language {code!r}")
        await self.update_prefs(meeting_id, username, {"spoken_language": normalised})

    # ── live hook ─────────────────────────────────────────────────────
    async def on_transcript(self, meeting_id: str, entry: Any, context: Any) -> None:
        """
        Called (via create_task) for every finalized transcript line. Never raises.

        The common case - everyone speaks the same language, or nobody has
        translation on and everyone has already been offered it - costs a few
        dict lookups: prefs and native languages are cached per process.
        """
        try:
            text = (getattr(entry, "text", "") or "").strip()
            speaker = (getattr(entry, "speaker", "") or "").strip()
            if not text or not speaker:
                return
            listeners = manager.usernames(meeting_id) - {speaker}
            if not listeners:
                return

            # Planning is serialised per meeting so audio slots are reserved
            # in the order lines were spoken; it is cache lookups only, so the
            # lock is held for microseconds once warm.
            lock = self._plan_locks.setdefault(meeting_id, asyncio.Lock())
            async with lock:
                plan = await self._plan(meeting_id, entry, text, speaker, listeners)
            if plan is None:
                return
            source, groups, slots = plan
            await asyncio.gather(*(
                self._deliver(meeting_id, entry, text, speaker, source, g, slots.get(g.target), context)
                for g in groups
            ))
        except Exception as exc:
            print(f"[translation] on_transcript failed: {type(exc).__name__}: {exc}")

    async def _plan(self, meeting_id: str, entry: Any, text: str, speaker: str, listeners: set[str]):
        source = normalise(getattr(entry, "language", None), default=None) \
            or await self.spoken_language(meeting_id, speaker)
        # The live pipeline labels lines with the username; manually added or
        # imported lines may carry a display name. Only in that second case is
        # a listener matched by display name, so two people who share a name
        # still hear each other.
        by_name = speaker.lower() if speaker not in manager.usernames(meeting_id) else None
        groups: dict[str, _Group] = {}

        for listener in sorted(listeners):
            if by_name and (await self.display_name(listener)).strip().lower() == by_name:
                continue
            stored = await self._stored_prefs(meeting_id, listener)
            target = stored["target_language"] or await self.native_language(listener)
            if target == source:
                continue
            self.warm()
            if stored["enabled"]:
                group = groups.setdefault(target, _Group(target))
                group.listeners.append(listener)
                if stored["voice"]:
                    group.voice.append(listener)
            elif source not in stored["declined"]:
                await self._maybe_offer(meeting_id, listener, speaker, source, target)

        if not groups or not self.can_translate or not worth_translating(text):
            return None

        slots: dict[str, _Slot] = {}
        if tts_service.multilingual_available:
            now = time.monotonic()
            for g in groups.values():
                if g.voice:
                    slots[g.target] = self._reserve(meeting_id, entry, g, now)
        return source, list(groups.values()), slots

    async def _maybe_offer(
        self, meeting_id: str, listener: str, speaker: str, source: str, target: str
    ) -> None:
        key = (meeting_id, listener, source)
        if key in self._offered:
            return
        self._offered.add(key)
        self.warm()
        await manager.send_to_user(meeting_id, listener, {
            "type": "translation_offer",
            "offer": {
                "speaker": speaker,
                "speaker_name": await self.display_name(speaker),
                "language": source,
                "language_name": name_of(source),
                "target_language": target,
                "target_language_name": name_of(target),
            },
        })

    # ── one line, one target language ─────────────────────────────────
    async def _deliver(
        self, meeting_id: str, entry: Any, text: str, speaker: str,
        source: str, group: _Group, slot: Optional[_Slot], context: Any,
    ) -> None:
        audio = None
        try:
            translated = await self._translation(entry, text, speaker, source, group.target, context)
            if not translated:
                return
            item = {
                "id": entry.id,
                "speaker": speaker,
                "speaker_name": await self.display_name(speaker),
                "source_language": source,
                "target_language": group.target,
                "original": text,
                "text": translated,
                "created_at": _now_iso(),
            }
            for listener in group.listeners:
                await manager.send_to_user(meeting_id, listener, {"type": "translation", "item": item})

            if slot is not None:
                slot.deadline = time.monotonic() + settings.TRANSLATION_TTS_TIMEOUT_S + SEQ_GRACE_S
                audio = await self._speech(translated, group.target)
        except Exception as exc:
            print(f"[translation] {source}->{group.target} failed: {type(exc).__name__}: {exc}")
        finally:
            if slot is not None and not slot.future.done():
                slot.future.set_result(audio)

    async def _translation(
        self, entry: Any, text: str, speaker: str, source: str, target: str, context: Any
    ) -> Optional[str]:
        """One LLM call per (line, target), shared by every caller asking for it."""
        key = (entry.id, target)
        task = self._texts.get(key)
        if task is None:
            task = asyncio.create_task(self._translate(text, speaker, source, target, context, entry.id))
            self._texts[key] = task
            while len(self._texts) > TEXT_CACHE_SIZE:
                self._texts.popitem(last=False)
        try:
            return await asyncio.shield(task)
        except Exception as exc:
            self._texts.pop(key, None)      # let a later retry try again
            print(f"[translation] {source}->{target} unavailable: {type(exc).__name__}: {exc}")
            return None

    async def _translate(
        self, text: str, speaker: str, source: str, target: str, context: Any, entry_id: str
    ) -> Optional[str]:
        earlier = []
        for e in list(context or [])[::-1]:
            if getattr(e, "id", None) == entry_id or not (getattr(e, "text", "") or "").strip():
                continue
            earlier.append(f"{getattr(e, 'speaker', '?')}: {e.text.strip()}")
            if len(earlier) == 2:
                break
        prompt = PROMPT.format(
            source=name_of(source), target=name_of(target), speaker=speaker, text=text,
            context="\n".join(reversed(earlier)) or "(none)",
        )
        budget = settings.TRANSLATION_TIMEOUT_S
        started = time.monotonic()
        async with self._llm_slots:
            translated, via = await asyncio.wait_for(self._race(prompt, budget), timeout=budget + 0.5)
        print(f"[translation] {source}->{target} in {time.monotonic() - started:.1f}s via {via}")
        return translated

    async def _race(self, prompt: str, budget: float) -> tuple[str, str]:
        """
        First usable translation from a staggered race.

        Contenders start TRANSLATION_HEDGE_S apart - each Gemini model on the
        native endpoint, then the shared LLM chain - or immediately when every
        running contender has failed. The first non-empty answer wins and the
        rest are cancelled, so a stalled request costs a hedge interval
        instead of the whole line.
        """
        contenders: list[tuple[str, Any]] = []
        if settings.GEMINI_API_KEY:
            for model in settings.TRANSLATION_GEMINI_MODELS:
                contenders.append((f"gemini/{model}", lambda m=model: self._gemini(m, prompt, budget)))
        if llm_client.available:
            contenders.append(("llm-chain", lambda: llm_client.chat_json(
                prompt, temperature=0.1, fast=True, max_tokens=800, timeout=budget
            )))
        if not contenders:
            raise RuntimeError("no LLM configured")

        running: dict[asyncio.Task, str] = {}
        errors: list[str] = []

        def launch() -> None:
            label, factory = contenders.pop(0)
            running[asyncio.create_task(factory())] = label

        launch()
        try:
            while running:
                wait = settings.TRANSLATION_HEDGE_S if contenders else None
                done, _ = await asyncio.wait(running, timeout=wait, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    label = running.pop(task)
                    try:
                        result = task.result()
                        text = str((result or {}).get("translation") or "").strip().strip('"“”')
                        if text:
                            return text, label
                        errors.append(f"{label}: empty")
                    except Exception as exc:
                        errors.append(f"{label}: {type(exc).__name__} {str(exc)[:120]}")
                if contenders and (not done or not running):
                    launch()
        finally:
            for task in running:
                task.cancel()
                # Retrieve the outcome so a loser that failed as it was being
                # cancelled is not reported as "exception never retrieved".
                task.add_done_callback(lambda t: t.cancelled() or t.exception())
        raise RuntimeError("; ".join(errors) or "no translation")

    @staticmethod
    async def _gemini(model: str, prompt: str, timeout: float) -> dict:
        r = await gemini_http().post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            timeout=timeout,
            headers={"x-goog-api-key": settings.GEMINI_API_KEY},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "temperature": 0.1,
                    "maxOutputTokens": 800,
                },
            },
        )
        r.raise_for_status()
        parts = r.json()["candidates"][0]["content"]["parts"]
        return extract_json("".join(p.get("text", "") for p in parts if not p.get("thought")))

    async def _speech(self, text: str, target: str) -> Optional[dict]:
        budget = settings.TRANSLATION_TTS_TIMEOUT_S

        async def call():
            async with self._tts_slots:
                return await tts_service.synthesise_in(text, target, timeout=budget)

        try:
            speech = await asyncio.wait_for(call(), timeout=budget + 0.5)
        except asyncio.TimeoutError:
            print(f"[translation] tts ({target}) timed out after {budget:.0f}s")
            return None
        if speech.client_should_speak or not speech.audio_b64:
            return None                 # the client falls back to browser speech
        return {"audio": speech.audio_b64, "mime_type": speech.mime_type}

    # ── ordered audio delivery ────────────────────────────────────────
    def _reserve(self, meeting_id: str, entry: Any, group: _Group, now: float) -> _Slot:
        key = (meeting_id, group.target)
        slot = _Slot(
            entry_id=entry.id, target=group.target, listeners=list(group.voice),
            future=asyncio.get_running_loop().create_future(),
            deadline=now + settings.TRANSLATION_TIMEOUT_S + SEQ_GRACE_S,
        )
        self._queues.setdefault(key, deque()).append(slot)
        if key not in self._pumps:
            self._pumps[key] = asyncio.create_task(self._pump(meeting_id, key))
        return slot

    async def _pump(self, meeting_id: str, key: tuple[str, str]) -> None:
        """Send audio for one (meeting, target) in reservation order."""
        queue = self._queues[key]
        try:
            while queue:
                slot = queue[0]
                while not slot.future.done():
                    remaining = slot.deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    try:
                        await asyncio.wait_for(asyncio.shield(slot.future), timeout=remaining)
                    except asyncio.TimeoutError:
                        pass            # the deadline may have moved; re-check
                queue.popleft()
                if not slot.future.done():
                    print(f"[translation] dropped audio for {slot.entry_id} ({slot.target}): not ready in time")
                    continue
                audio = slot.future.result()
                if not audio:
                    continue
                message = {"type": "translation_audio", "audio": {
                    "id": slot.entry_id, "target_language": slot.target, **audio,
                }}
                for listener in slot.listeners:
                    await manager.send_to_user(meeting_id, listener, message)
        except Exception as exc:
            print(f"[translation] audio sequencer failed: {type(exc).__name__}: {exc}")
        finally:
            # No await between the loop ending and this pop, so a slot
            # reserved meanwhile always finds either this pump or none.
            self._pumps.pop(key, None)
            if not queue:
                self._queues.pop(key, None)

    def forget_meeting(self, meeting_id: str) -> None:
        """Drop in-memory state for a finished meeting."""
        for key in [k for k in self._prefs if k[0] == meeting_id]:
            self._prefs.pop(key, None)
        self._offered = {k for k in self._offered if k[0] != meeting_id}
        lock = self._plan_locks.get(meeting_id)
        if lock is not None and not lock.locked():
            self._plan_locks.pop(meeting_id, None)


translation_service = TranslationService()
