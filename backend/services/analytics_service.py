"""
Meeting analytics.

Derives participation statistics from the transcript that is already stored,
so this costs no API calls and works with or without a Groq key.

What it measures, and why each one is defensible:

  talk time      Estimated from word count at a fixed speaking rate rather
                 than from timestamps. Transcript entries carry a start time
                 but no duration, and inferring duration from the gap to the
                 next entry counts silence as speech.

  turns          A turn is a contiguous run by one speaker. Counting entries
                 instead would reward whoever's audio chunked more often,
                 which is an artefact of buffering, not of behaviour.

  interruptions  A speaker change less than INTERRUPTION_GAP_MS after the
                 previous entry began. Genuinely approximate: without
                 word-level timings this cannot distinguish an interruption
                 from a fast, courteous handover, so it is reported as a
                 signal, not a verdict.

  balance        Normalised Shannon entropy over talk-time share. 1.0 is a
                 perfectly even split, 0.0 is one person talking. This is
                 preferred to "max share" because it accounts for the whole
                 distribution.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable

from models.meeting_model import TranscriptEntry

# Conversational English averages ~150 wpm; 2.5 words/second.
WORDS_PER_SECOND = 2.5
INTERRUPTION_GAP_MS = 1200

FILLERS = {
    "um", "uh", "erm", "ah", "like", "basically", "actually",
    "literally", "sort", "kinda", "kind", "you know", "i mean", "right",
}

QUESTION_STARTS = {
    "what", "why", "how", "when", "where", "who", "which",
    "can", "could", "should", "would", "will", "do", "does", "did", "is",
    "are", "was", "were", "shall", "have", "has",
}


@dataclass
class SpeakerStats:
    speaker: str
    words: int = 0
    entries: int = 0
    turns: int = 0
    questions: int = 0
    fillers: int = 0
    interruptions_made: int = 0
    talk_seconds: float = 0.0
    share: float = 0.0
    longest_turn_words: int = 0

    @property
    def words_per_turn(self) -> float:
        return self.words / self.turns if self.turns else 0.0


@dataclass
class MeetingAnalytics:
    timing_reliable: bool = True
    total_words: int = 0
    total_entries: int = 0
    estimated_speech_seconds: float = 0.0
    speakers: list[SpeakerStats] = field(default_factory=list)
    balance_index: float = 0.0
    dominant_speaker: str | None = None
    quietest_speaker: str | None = None
    question_count: int = 0
    interruption_count: int = 0
    timeline: list[dict] = field(default_factory=list)
    keywords: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "timing_reliable": self.timing_reliable,
            "total_words": self.total_words,
            "total_entries": self.total_entries,
            "estimated_speech_seconds": round(self.estimated_speech_seconds, 1),
            "balance_index": round(self.balance_index, 3),
            "dominant_speaker": self.dominant_speaker,
            "quietest_speaker": self.quietest_speaker,
            "question_count": self.question_count,
            "interruption_count": self.interruption_count,
            "speakers": [
                {
                    "speaker": s.speaker,
                    "words": s.words,
                    "entries": s.entries,
                    "turns": s.turns,
                    "questions": s.questions,
                    "fillers": s.fillers,
                    "interruptions_made": s.interruptions_made,
                    "talk_seconds": round(s.talk_seconds, 1),
                    "share": round(s.share, 4),
                    "words_per_turn": round(s.words_per_turn, 1),
                    "longest_turn_words": s.longest_turn_words,
                }
                for s in self.speakers
            ],
            "timeline": self.timeline,
            "keywords": self.keywords,
        }


def _ms(entry: TranscriptEntry) -> int | None:
    """Milliseconds from meeting start, from the field or the HH:MM:SS string."""
    if entry.timestamp_ms is not None:
        return entry.timestamp_ms
    parts = (entry.time or "").split(":")
    try:
        if len(parts) == 3:
            h, m, s = (int(p) for p in parts)
            return ((h * 60 + m) * 60 + s) * 1000
        if len(parts) == 2:
            m, s = (int(p) for p in parts)
            return (m * 60 + s) * 1000
    except ValueError:
        pass
    return None


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def analyse(entries: Iterable[TranscriptEntry]) -> MeetingAnalytics:
    entries = [e for e in entries if (e.text or "").strip()]
    result = MeetingAnalytics()
    if not entries:
        return result

    # Interruption detection needs timestamps that actually vary. Entries
    # written in a tight loop (a seeded transcript, or a burst flush after a
    # reconnect) all carry near-identical offsets, and every speaker change
    # then looks like an interruption. Detect that up front and suppress the
    # metric rather than reporting a number that means nothing.
    stamps = [t for t in (_ms(e) for e in entries) if t is not None]
    distinct = len(set(stamps))
    result.timing_reliable = len(stamps) >= 4 and distinct >= max(len(stamps) * 0.5, 3)

    stats: dict[str, SpeakerStats] = {}
    previous_speaker: str | None = None
    previous_ms: int | None = None
    current_turn_words = 0
    doc_freq: dict[str, int] = defaultdict(int)

    for entry in entries:
        speaker = entry.speaker or "unknown"
        s = stats.setdefault(speaker, SpeakerStats(speaker=speaker))

        words = _words(entry.text)
        s.words += len(words)
        s.entries += 1
        result.total_words += len(words)
        result.total_entries += 1

        # Turn boundaries
        if speaker != previous_speaker:
            s.turns += 1
            current_turn_words = len(words)

            now = _ms(entry)
            if (
                result.timing_reliable
                and previous_speaker is not None
                and now is not None
                and previous_ms is not None
                # Strictly greater than zero: a zero gap means the two entries
                # share a timestamp, which is missing information, not overlap.
                and 0 < now - previous_ms < INTERRUPTION_GAP_MS
            ):
                s.interruptions_made += 1
                result.interruption_count += 1
        else:
            current_turn_words += len(words)

        s.longest_turn_words = max(s.longest_turn_words, current_turn_words)

        text = entry.text.strip()
        first = words[0] if words else ""
        if text.endswith("?") or first in QUESTION_STARTS:
            s.questions += 1
            result.question_count += 1

        s.fillers += sum(1 for w in words if w in FILLERS)

        for w in set(words):
            doc_freq[w] += 1

        previous_speaker = speaker
        previous_ms = _ms(entry) or previous_ms

    # Talk time and share
    for s in stats.values():
        s.talk_seconds = s.words / WORDS_PER_SECOND
    result.estimated_speech_seconds = sum(s.talk_seconds for s in stats.values())

    total = result.total_words or 1
    for s in stats.values():
        s.share = s.words / total

    result.speakers = sorted(stats.values(), key=lambda s: s.words, reverse=True)
    if result.speakers:
        result.dominant_speaker = result.speakers[0].speaker
        result.quietest_speaker = result.speakers[-1].speaker

    # Normalised Shannon entropy: 1.0 == perfectly even participation.
    shares = [s.share for s in result.speakers if s.share > 0]
    if len(shares) > 1:
        entropy = -sum(p * math.log(p) for p in shares)
        result.balance_index = entropy / math.log(len(shares))
    elif shares:
        result.balance_index = 0.0

    result.timeline = _build_timeline(entries)
    result.keywords = _keywords(doc_freq, len(entries))
    return result


def _build_timeline(entries: list[TranscriptEntry], buckets: int = 24) -> list[dict]:
    """Words per speaker over time, for a stacked activity chart."""
    stamps = [_ms(e) for e in entries]
    known = [t for t in stamps if t is not None]
    if not known:
        return []

    start, end = min(known), max(known)
    span = max(end - start, 1)
    width = span / buckets

    grid: list[dict] = [
        {"t": round((start + i * width) / 1000, 1), "speakers": {}, "words": 0}
        for i in range(buckets)
    ]

    for entry, ts in zip(entries, stamps):
        if ts is None:
            continue
        idx = min(int((ts - start) / width), buckets - 1)
        n = len(_words(entry.text))
        speaker = entry.speaker or "unknown"
        cell = grid[idx]
        cell["speakers"][speaker] = cell["speakers"].get(speaker, 0) + n
        cell["words"] += n

    return grid


def _keywords(doc_freq: dict[str, int], n_docs: int, top: int = 12) -> list[dict]:
    """
    Salient terms by a light TF-IDF-ish score.

    A term appearing in nearly every utterance is structural ("the", "we"),
    and one appearing once is noise; the peak sits in between.
    """
    STOP = {
        "the", "a", "an", "and", "or", "but", "if", "then", "so", "to", "of",
        "in", "on", "for", "with", "at", "by", "from", "is", "are", "was",
        "were", "be", "been", "am", "i", "you", "he", "she", "it", "we",
        "they", "this", "that", "these", "those", "my", "your", "our",
        "their", "its", "as", "not", "no", "yes", "do", "does", "did",
        "have", "has", "had", "will", "would", "can", "could", "should",
        "just", "okay", "ok", "right", "well", "s", "t", "re", "ve", "ll",
        "m", "d", "ll", "about", "up", "out", "get", "got", "go", "going",
        "there", "here", "what", "when", "how", "why", "who", "all", "any",
    } | FILLERS

    scored: list[tuple[float, str, int]] = []
    for term, df in doc_freq.items():
        if term in STOP or len(term) < 3 or term.isdigit():
            continue
        if df < 2 or df > max(n_docs * 0.6, 2):
            continue
        scored.append((df * math.log(n_docs / df + 1), term, df))

    scored.sort(reverse=True)
    return [{"term": t, "count": c} for _, t, c in scored[:top]]
