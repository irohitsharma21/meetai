"""
Delegate agent: a personal assistant that acts on its owner's behalf in a meeting.

The voice assistant (assistant_service) answers *questions*. This service
performs *actions*, and only the ones its owner has switched on:

    "hey meetai, send my contact details to Rohit"
          │
          ├─ wake word + owner's own mic ──► it is the owner talking
          ├─ intent parse (LLM, regex fallback) ──► share_contact(recipient="Rohit")
          ├─ permission gate ──► enabled? confirm first or auto?
          ├─ recipient resolution ──► Rohit Sharma, a participant of this meeting
          └─ execute ──► email with only the fields marked shareable + a vCard

Design choices that are not incidental:

**Default deny.** Every outbound capability ships disabled. The only tool on
by default is `add_note`, which never leaves the owner's own account. An agent
that could email on your behalf the moment you sign up is a liability, not a
feature.

**Only the owner can command their agent.** A transcript line is attributed
by the WebSocket it arrived on, and that socket was opened with the speaker's
own token, so `entry.speaker` is authenticated identity, not a diarisation
guess. Someone else in the room saying "hey meetai, send me Rahul's number"
triggers *their* agent, which has no access to Rahul's profile.

**The room is the address book.** Recipients are resolved against the
meeting's participants. The agent never sends to someone outside the meeting
unless the owner typed an explicit address; a spoken address to an outsider
is always held for confirmation, because speech-to-text is exactly where
"rohit@" turns into "robert@".

**Every proposal is audited.** Each command becomes a row in
`agent_actions`, whatever happens to it - blocked, rejected or sent - so the
owner can always see what their agent did and why.
"""

from __future__ import annotations

import asyncio
import difflib
import re
import time
import uuid
from datetime import datetime, timezone
from html import escape
from typing import Any, Iterable, Literal, Optional, Sequence

from pydantic import BaseModel, Field, field_validator

from core.config import settings
from db.mongodb import get_db, get_meetings_collection, get_users_collection
from models.meeting_model import TranscriptEntry
from services.assistant_service import WAKE_WORDS
from services.email_service import EmailDeliveryError, EmailUnavailable, email_service
from services.llm_client import llm_client
from services.realtime import manager

# ── capabilities ──────────────────────────────────────────────────────
TOOLS: dict[str, dict] = {
    "share_contact": {
        "label": "Share contact",
        "description": "Email your contact card (only the fields you mark shareable) "
                       "to someone in the meeting.",
        "sends_email": True,
    },
    "share_snippet": {
        "label": "Share snippet",
        "description": "Email one of your saved snippets, such as a scheduling link "
                       "or a product blurb.",
        "sends_email": True,
    },
    "send_document": {
        "label": "Send document",
        "description": "Email one of your briefing documents for this meeting as an "
                       "attachment.",
        "sends_email": True,
    },
    "send_email": {
        "label": "Draft email",
        "description": "Draft a short email from you, grounded in the conversation. "
                       "Always shown for approval before it is sent.",
        "sends_email": True,
    },
    "add_note": {
        "label": "Private notes",
        "description": "Save a private note or reminder that only you can see.",
        "sends_email": False,
    },
}
EMAIL_TOOLS = {name for name, spec in TOOLS.items() if spec["sends_email"]}

CONTACT_FIELDS = ("full_name", "email", "phone", "company", "title", "linkedin", "website")
CONTACT_LABELS = {
    "full_name": "Name", "email": "Email", "phone": "Phone", "company": "Company",
    "title": "Title", "linkedin": "LinkedIn", "website": "Website",
}

AGENT_WAKE_WORDS = tuple(WAKE_WORDS) + ("hey agent",)

MAX_EMAILS_PER_MEETING = 15
MAX_SNIPPETS = 20
DEBOUNCE_SECONDS = 20.0
ARMED_SECONDS = 10.0          # "hey meetai" … pause … "send my card to Rohit"
PROFILE_CACHE_SECONDS = 60.0

Status = Literal["pending", "needs_input", "blocked", "running", "done", "failed", "rejected"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _profiles():
    return get_db()["agent_profiles"]


def _actions():
    return get_db()["agent_actions"]


class AgentError(RuntimeError):
    """A request the caller can fix (bad state, bad override). Maps to 4xx."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


# ── profile schema ────────────────────────────────────────────────────
_EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[A-Za-z]{2,}$")
_EMAIL_IN_TEXT = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"^[0-9+()\-.\s/x]{3,32}$")


def _clean_url(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if len(value) > 300:
        raise ValueError("URL is too long (300 characters max)")
    if not re.match(r"^https?://", value, re.I):
        value = "https://" + value
    host = re.match(r"^https?://([^/\s?#]+)", value, re.I)
    if not host or "." not in host.group(1) or re.search(r"\s", value):
        raise ValueError("not a valid web address")
    return value


class ContactInfo(BaseModel):
    full_name: str = Field("", max_length=120)
    email: str = Field("", max_length=254)
    phone: str = Field("", max_length=32)
    company: str = Field("", max_length=120)
    title: str = Field("", max_length=120)
    linkedin: str = ""
    website: str = ""

    @field_validator("full_name", "company", "title", mode="before")
    @classmethod
    def _strip(cls, v: Any) -> str:
        return " ".join(str(v or "").split())

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = (v or "").strip()
        if v and not _EMAIL_RE.match(v):
            raise ValueError("not a valid email address")
        return v

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        v = (v or "").strip()
        if v and not _PHONE_RE.match(v):
            raise ValueError("phone may contain digits, spaces and + ( ) - . only")
        return v

    @field_validator("linkedin", "website")
    @classmethod
    def _url(cls, v: str) -> str:
        return _clean_url(v)


class Snippet(BaseModel):
    id: str = ""
    label: str = Field(..., min_length=1, max_length=60)
    text: str = Field(..., min_length=1, max_length=2000)

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        v = (v or "").strip()
        return v if re.fullmatch(r"[A-Za-z0-9_-]{1,40}", v) else uuid.uuid4().hex[:12]

    @field_validator("label", "text", mode="before")
    @classmethod
    def _trim(cls, v: Any) -> str:
        return str(v or "").strip()


class Permission(BaseModel):
    enabled: bool = False
    mode: Literal["confirm", "auto"] = "confirm"


def _default_permissions() -> dict[str, dict]:
    perms = {tool: {"enabled": False, "mode": "confirm"} for tool in TOOLS}
    perms["add_note"] = {"enabled": True, "mode": "auto"}
    return perms


class ProfileIn(BaseModel):
    """PUT /agent/profile body. `updated_at` is accepted and ignored."""

    contact: ContactInfo = Field(default_factory=ContactInfo)
    share_fields: list[str] = Field(default_factory=lambda: ["full_name", "email"])
    snippets: list[Snippet] = Field(default_factory=list, max_length=MAX_SNIPPETS)
    permissions: dict[str, Permission] = Field(default_factory=dict)
    updated_at: Optional[str] = None

    @field_validator("share_fields")
    @classmethod
    def _share(cls, v: list[str]) -> list[str]:
        # Unknown names are dropped rather than rejected: a stale client that
        # still sends a removed field should not lose the whole save.
        return [f for f in dict.fromkeys(v) if f in CONTACT_FIELDS]

    def to_profile(self) -> dict:
        perms = _default_permissions()
        for tool, perm in self.permissions.items():
            if tool in TOOLS:
                perms[tool] = perm.model_dump()
        return {
            "contact": self.contact.model_dump(),
            "share_fields": list(self.share_fields),
            "snippets": [s.model_dump() for s in self.snippets],
            "permissions": perms,
        }


def capabilities() -> list[dict]:
    return [{"tool": name, **spec} for name, spec in TOOLS.items()]


# ── pure helpers (unit-testable without a database) ───────────────────
def mask_email(email: str | None) -> str:
    """r***@gmail.com - enough to tell two Rohits apart, not enough to harvest."""
    if not email or "@" not in email:
        return ""
    local, domain = email.split("@", 1)
    return f"{local[:1]}***@{domain}"


_WAKE_PATTERNS = [
    re.compile(
        r"^[\s,.!?\"']*"
        + r"[\s,.!?-]*".join(
            # "meetai" arrives from STT as "meet ai", "meet-AI" or "MeetAI".
            re.escape(word).replace("meetai", r"meet[\s-]*a\.?\s*i")
            for word in wake.split()
        )
        + r"\b[\s,.:;!?-]*",
        re.I,
    )
    # Longest first, so "hey meetai" is not consumed as "hey meet" + "ai".
    for wake in sorted(AGENT_WAKE_WORDS, key=len, reverse=True)
]


def strip_agent_wake_word(text: str) -> tuple[str, bool]:
    """
    Remove a leading wake word. Returns (command, was_addressed).

    Separate from assistant_service.strip_wake_word, which checks its list in
    declaration order and so reads "hey meetai, send…" as "hey meet" followed
    by "ai, send…". It also tolerates the punctuation and spacing live STT
    inserts ("Hey, Meet AI. Send…").
    """
    for rx in _WAKE_PATTERNS:
        m = rx.match(text or "")
        if m:
            return text[m.end():].strip(), True
    return text, False


_ACTION_VERBS = re.compile(
    r"\b(send|share|email|e-mail|mail|forward|give|pass|text|drop|shoot|note|jot|"
    r"remind|remember|write\s+down|save|log|draft|follow\s+up)\b",
    re.I,
)
_QUESTION_START = re.compile(
    r"^(what|who|whom|whose|when|where|why|how|which|did|does|do|is|are|was|were|"
    r"has|have|should|would|could|summari[sz]e|recap|explain|tell\s+me)\b",
    re.I,
)


def looks_like_action(command: str) -> bool:
    """
    Cheap pre-filter before spending an LLM call.

    Questions belong to the voice assistant. A command with no action verb is
    never a delegate task, and one that opens like a question ("what did she
    say about…") is one unless it also asks for something to be sent.
    """
    if not command or not _ACTION_VERBS.search(command):
        return False
    if _QUESTION_START.match(command) and not re.match(
        r"^(can|could|would|will)\s+you\b", command, re.I
    ):
        # "did Rohit send the deck?" is a question; "can you send…" is not.
        return bool(re.search(r"\b(send|share|email|forward)\b.*\b(to|with)\b", command, re.I)
                    and not command.rstrip().endswith("?"))
    return True


_FILLER_TAIL = re.compile(
    r"[\s,]*(please|pls|thanks|thank\s+you|now|right\s+now|as\s+well|too|also|"
    r"after\s+the\s+(meeting|call)|when\s+you\s+can)\s*[.!?]*$",
    re.I,
)
_POLITE_HEAD = re.compile(r"^(please|can\s+you|could\s+you|would\s+you|will\s+you|go\s+ahead\s+and|kindly)\s+", re.I)


def _tidy(fragment: str | None) -> str | None:
    if fragment is None:
        return None
    out = fragment.strip(" \t\"'.,!?;:")
    for _ in range(3):
        out = _FILLER_TAIL.sub("", out).strip(" \t\"'.,!?;:")
    return out or None


_CONTACT_WORDS = re.compile(
    r"\b(contact|details|detail|info|information|card|v-?card|business\s+card|"
    r"number|phone|email\s+address|linkedin)\b",
    re.I,
)
_DOC_WORDS = re.compile(
    r"\b(doc|docs|document|documents|deck|slides?|file|pdf|presentation|brief|"
    r"briefing|one-?pager|attachment|proposal|report|sheet|spreadsheet)\b",
    re.I,
)


class Intent(BaseModel):
    tool: str = "none"
    recipient: Optional[str] = None
    argument: Optional[str] = None
    parser: Literal["llm", "rules"] = "rules"


def parse_intent_rules(command: str, snippet_labels: Sequence[str] = ()) -> Intent:
    """
    Deterministic fallback parser, used when no LLM is configured or it fails.

    Covers the phrasings people actually use for the core tools; anything it
    cannot place is "none", which is the safe answer for an agent.
    """
    text = _POLITE_HEAD.sub("", (command or "").strip()).strip()
    text = _POLITE_HEAD.sub("", text)
    if not text:
        return Intent()

    # Notes and reminders.
    m = re.match(
        r"^(?:(?:take|make|add|save)\s+(?:a\s+)?(?:private\s+)?note(?:\s+(?:that|to))?|"
        r"note(?:\s+down)?(?:\s+that)?|jot\s+down|write\s+down|remember(?:\s+that)?|"
        r"(?P<remind>remind\s+me(?:\s+to)?))[\s,:-]+(?P<body>.+)$",
        text, re.I | re.S,
    )
    if m:
        body = _tidy(m.group("body")) or ""
        if m.group("remind"):
            body = f"Reminder: {body}"
        return Intent(tool="add_note", argument=body[:1000] or None)

    verbs = r"(?:send|share|email|e-mail|mail|forward|give|pass|shoot|drop)"

    # "email Rohit about the pricing follow-up"
    m = re.match(rf"^(?:email|e-mail|mail|write(?:\s+to)?|draft\s+(?:an?\s+)?email\s+to)\s+(?P<r>.+?)\s+(?:about|regarding|re|on|to\s+say|saying|that)\s+(?P<p>.+)$", text, re.I | re.S)
    if m and not _CONTACT_WORDS.search(m.group("r")):
        return Intent(tool="send_email", recipient=_tidy(m.group("r")), argument=_tidy(m.group("p")))

    # "send <what> to/with <whom>"
    m = re.match(rf"^{verbs}\s+(?P<what>.+?)\s+(?:over\s+)?(?:to|with)\s+(?P<r>.+)$", text, re.I | re.S)
    what = recipient = None
    if m:
        what, recipient = m.group("what"), m.group("r")
    else:
        # "send Rohit my contact card"
        m = re.match(rf"^{verbs}\s+(?P<r>.+?)\s+(?P<what>(?:my|the|our|a|an|that|this)\s+.+)$", text, re.I | re.S)
        if m:
            what, recipient = m.group("what"), m.group("r")

    if what is not None:
        what_t = _tidy(what) or ""
        recipient_t = _tidy(recipient)
        label = _match_label(what_t, snippet_labels)
        if label:
            return Intent(tool="share_snippet", recipient=recipient_t, argument=label)
        if re.search(r"\bmy\b", what_t, re.I) and _CONTACT_WORDS.search(what_t):
            return Intent(tool="share_contact", recipient=recipient_t)
        if _DOC_WORDS.search(what_t):
            name = re.sub(r"^(?:my|the|our|a|an|that|this)\s+", "", what_t, flags=re.I)
            return Intent(tool="send_document", recipient=recipient_t, argument=name)
        if _CONTACT_WORDS.search(what_t):
            return Intent(tool="share_contact", recipient=recipient_t)
        if re.match(r"^(?:my\s+)?snippet\b", what_t, re.I):
            return Intent(tool="share_snippet", recipient=recipient_t,
                          argument=re.sub(r"^(?:my\s+)?snippet\s*", "", what_t, flags=re.I) or None)
        return Intent(tool="send_email", recipient=recipient_t, argument=what_t)

    return Intent()


def _norm(s: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9@.+ ]", " ", (s or "").lower()).split())


def _match_label(query: str | None, labels: Sequence[str]) -> str | None:
    """Fuzzy-match a spoken name against saved labels / document names."""
    if not query or not labels:
        return None
    q = _norm(re.sub(r"\b(my|the|our|snippet|document|doc|file)\b", " ", query, flags=re.I))
    if not q:
        return None
    best, best_score = None, 0.0
    for label in labels:
        l = _norm(label)
        if not l:
            continue
        if q == l:
            return label
        stem = l.rsplit(".", 1)[0] if "." in l else l
        score = max(
            difflib.SequenceMatcher(None, q, l).ratio(),
            difflib.SequenceMatcher(None, q, stem).ratio(),
            0.9 if (q in l or l in q) and min(len(q), len(l)) >= 3 else 0.0,
        )
        q_tokens, l_tokens = set(q.split()), set(stem.replace(".", " ").split())
        if q_tokens and l_tokens:
            overlap = len(q_tokens & l_tokens) / len(q_tokens)
            score = max(score, 0.5 + 0.4 * overlap if overlap >= 0.5 else 0.0)
        if score > best_score:
            best, best_score = label, score
    return best if best_score >= 0.7 else None


# ── recipient resolution ──────────────────────────────────────────────
_EVERYONE = re.compile(
    r"^(everyone|everybody|all|all\s+of\s+them|all\s+participants|the\s+(?:whole\s+)?"
    r"(?:team|room|group|call)|everyone\s+(?:here|else|in\s+the\s+(?:meeting|call|room)))$",
    re.I,
)
_SELF = re.compile(r"^(me|myself|my\s+(?:inbox|email))$", re.I)


class Resolution(BaseModel):
    recipients: list[dict] = Field(default_factory=list)  # {username, name, email}
    candidates: list[dict] = Field(default_factory=list)  # {username, name, email_hint}
    external: bool = False       # an address outside the meeting is involved
    message: Optional[str] = None  # blocking: the owner must pick or type
    note: Optional[str] = None     # informational: shown, but does not block

    @property
    def resolved(self) -> bool:
        return bool(self.recipients) and not self.message


def _person_names(p: dict) -> list[str]:
    names = [p.get("username") or "", p.get("name") or "", p.get("full_name") or ""]
    return [n for n in names if n]


def _score(spoken: str, person: dict) -> int:
    """3 exact, 2 first-name / token, 1 fuzzy, 0 no match."""
    s = _norm(spoken)
    if not s:
        return 0
    best = 0
    for name in _person_names(person):
        n = _norm(name.replace("_", " ").replace("-", " "))
        if not n:
            continue
        if s == n or s == _norm(name):
            return 3
        tokens = n.split()
        if s in tokens or (tokens and s == tokens[0]):
            best = max(best, 2)
        elif s.split() and all(t in tokens for t in s.split()):
            best = max(best, 2)
        elif (difflib.SequenceMatcher(None, s, n).ratio() >= 0.82
              or any(difflib.SequenceMatcher(None, s, t).ratio() >= 0.84 for t in tokens)):
            # STT spellings: "Rohith" / "Rohit", "Priya" / "Pria".
            best = max(best, 1)
    return best


def resolve_recipients(
    spoken: str | None,
    command: str,
    participants: Sequence[dict],
    owner: str,
    owner_email: str | None = None,
) -> Resolution:
    """
    Turn "Rohit", "everyone" or an address into concrete recipients.

    `participants` are {username, name, email} for everyone in the meeting.
    Ambiguity is never resolved by guessing: two Rohits produce candidates for
    the owner to pick from, and no match asks for an address rather than
    reaching outside the room.
    """
    people = [p for p in participants if p.get("username")]
    by_email = {(p.get("email") or "").lower(): p for p in people if p.get("email")}

    # Explicit addresses win - in the recipient phrase or anywhere in the command.
    addresses = _EMAIL_IN_TEXT.findall(spoken or "") or _EMAIL_IN_TEXT.findall(command or "")
    if addresses:
        out, external = [], False
        for addr in dict.fromkeys(a.lower() for a in addresses):
            known = by_email.get(addr)
            if known:
                out.append({"username": known["username"], "name": known.get("name") or known["username"], "email": known["email"]})
            else:
                external = True
                out.append({"username": None, "name": addr, "email": addr})
        return Resolution(recipients=out, external=external)

    phrase = _tidy(spoken) or ""
    phrase = re.sub(r"^(?:to|with)\s+", "", phrase, flags=re.I)
    if not phrase:
        return Resolution(message="Who should receive this? Pick a participant or type an email address.")

    if _SELF.match(phrase):
        me = next((p for p in people if p["username"] == owner), None)
        email = owner_email or (me or {}).get("email")
        if not email:
            return Resolution(message="You have no email address on file. Add one in Assistant settings.")
        return Resolution(recipients=[{"username": owner, "name": (me or {}).get("name") or owner, "email": email}])

    if _EVERYONE.match(phrase):
        others = [p for p in people if p["username"] != owner]
        if not others:
            return Resolution(message="There is nobody else in this meeting yet.")
        reachable = [p for p in others if p.get("email")]
        missing = [p.get("name") or p["username"] for p in others if not p.get("email")]
        if not reachable:
            return Resolution(message="None of the other participants has an email address on file.")
        return Resolution(
            recipients=[{"username": p["username"], "name": p.get("name") or p["username"],
                         "email": p["email"]} for p in reachable],
            # Not a blocker: the rest of the room still gets it, and the
            # owner is told who was left out.
            note=f"No email on file for {', '.join(missing)}." if missing else None,
        )

    # "Rohit and Priya", "Rohit, Priya and Sam"
    parts = [p for p in re.split(r"\s*(?:,|\band\b|&)\s*", phrase) if p.strip()]
    recipients: list[dict] = []
    for part in parts:
        scored = [(p, _score(part, p)) for p in people if p["username"] != owner]
        top = max((s for _, s in scored), default=0)
        if top == 0:
            return Resolution(message=f"I couldn't find \"{part}\" in this meeting. Type their email address to send it anyway.")
        matches = [p for p, s in scored if s == top]
        if len(matches) > 1:
            return Resolution(
                recipients=recipients,
                candidates=[{"username": p["username"], "name": p.get("name") or p["username"],
                             "email_hint": mask_email(p.get("email"))} for p in matches],
                message=f"More than one person matches \"{part}\". Which one did you mean?",
            )
        person = matches[0]
        if not person.get("email"):
            return Resolution(
                recipients=recipients,
                message=f"{person.get('name') or person['username']} has no email address on file. Type one to send it.",
            )
        recipients.append({"username": person["username"], "name": person.get("name") or person["username"], "email": person["email"]})

    # dedupe by email, keep order
    seen, unique = set(), []
    for r in recipients:
        if r["email"].lower() not in seen:
            seen.add(r["email"].lower())
            unique.append(r)
    return Resolution(recipients=unique)


# ── contact card rendering ────────────────────────────────────────────
def shared_contact(profile: dict) -> dict[str, str]:
    """Only the fields the owner marked shareable, and only non-empty ones."""
    contact = profile.get("contact") or {}
    return {f: contact[f] for f in CONTACT_FIELDS
            if f in (profile.get("share_fields") or []) and contact.get(f)}


def _vcard_escape(value: str) -> str:
    return (value.replace("\\", "\\\\").replace("\n", "\\n")
            .replace(",", "\\,").replace(";", "\\;"))


def build_vcard(fields: dict[str, str], fallback_name: str) -> str:
    """
    vCard 3.0, which every mainstream contacts app imports.

    FN is mandatory in the format. When the owner has not shared their full
    name, the display name they already use in the meeting stands in: it is
    visible to every recipient in the room anyway.
    """
    name = fields.get("full_name") or fallback_name or "Contact"
    parts = name.split()
    family = parts[-1] if len(parts) > 1 else ""
    given = " ".join(parts[:-1]) if len(parts) > 1 else name
    lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        f"N:{_vcard_escape(family)};{_vcard_escape(given)};;;",
        f"FN:{_vcard_escape(name)}",
    ]
    if fields.get("company"):
        lines.append(f"ORG:{_vcard_escape(fields['company'])}")
    if fields.get("title"):
        lines.append(f"TITLE:{_vcard_escape(fields['title'])}")
    if fields.get("email"):
        lines.append(f"EMAIL;TYPE=INTERNET:{fields['email']}")
    if fields.get("phone"):
        lines.append(f"TEL;TYPE=CELL:{_vcard_escape(fields['phone'])}")
    if fields.get("website"):
        lines.append(f"URL:{fields['website']}")
    if fields.get("linkedin"):
        lines.append(f"X-SOCIALPROFILE;TYPE=linkedin:{fields['linkedin']}")
    lines.append("END:VCARD")
    return "\r\n".join(lines) + "\r\n"


def contact_card_text(fields: dict[str, str], owner_name: str) -> str:
    lines = [f"Contact details for {owner_name}", ""]
    lines += [f"{CONTACT_LABELS[f]}: {v}" for f, v in fields.items()]
    return "\n".join(lines)


def _email_shell(title: str, inner_html: str, owner_name: str) -> str:
    # Inline styles only: email clients strip <style> blocks.
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f6f8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#fff;border-radius:12px;border:1px solid #e6e8eb;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
        <tr><td style="padding:22px 26px 6px;">
          <div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;">
            {escape(settings.APP_NAME)} &middot; sent on behalf of {escape(owner_name)}
          </div>
          <h1 style="margin:6px 0 0;font-size:19px;color:#111;letter-spacing:-.02em;">{escape(title)}</h1>
        </td></tr>
        <tr><td style="padding:12px 26px 24px;">{inner_html}</td></tr>
        <tr><td style="padding:12px 26px;background:#fafbfc;border-top:1px solid #e6e8eb;font-size:11px;color:#9ca3af;">
          {escape(owner_name)} asked their {escape(settings.APP_NAME)} assistant to send this during a meeting you were both in.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


def contact_card_html(fields: dict[str, str], owner_name: str) -> str:
    rows = ""
    for f, v in fields.items():
        value = escape(v)
        if f == "email":
            value = f'<a href="mailto:{escape(v)}" style="color:#4f46e5;">{value}</a>'
        elif f in ("website", "linkedin"):
            value = f'<a href="{escape(v)}" style="color:#4f46e5;">{value}</a>'
        elif f == "phone":
            value = f'<a href="tel:{escape(re.sub(r"[^0-9+]", "", v))}" style="color:#4f46e5;">{value}</a>'
        rows += (
            f'<tr><td style="padding:6px 12px 6px 0;font-size:12px;color:#6b7280;width:90px;">'
            f'{CONTACT_LABELS[f]}</td><td style="padding:6px 0;font-size:14px;color:#111;">{value}</td></tr>'
        )
    inner = (f'<table role="presentation" cellpadding="0" cellspacing="0">{rows}</table>'
             '<p style="margin:14px 0 0;font-size:12px;color:#6b7280;">'
             'A contact card (.vcf) is attached - open it to save these details.</p>')
    return _email_shell(f"{owner_name}'s contact details", inner, owner_name)


def text_to_html(title: str, body: str, owner_name: str) -> str:
    paragraphs = "".join(
        f'<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151;">'
        f'{escape(p).replace(chr(10), "<br>")}</p>'
        for p in re.split(r"\n\s*\n", body.strip()) if p.strip()
    )
    return _email_shell(title, paragraphs, owner_name)


# ── LLM prompts ───────────────────────────────────────────────────────
INTENT_PROMPT = """You route commands for a meeting participant's personal \
assistant. The owner said this to their assistant during a meeting:

COMMAND: "{command}"

Available tools:
- share_contact: email the owner's contact details/card to someone.
- share_snippet: email one of the owner's saved snippets. Saved snippet labels: {snippets}
- send_document: email a document/file/deck/brief of the owner's to someone.
- send_email: write and send a short email to someone about a topic.
- add_note: save a private note or reminder for the owner (no recipient).
- none: anything else, including questions about the meeting.

Return ONLY a JSON object:
{{"tool": "share_contact"|"share_snippet"|"send_document"|"send_email"|"add_note"|"none",
  "recipient": the person/people/email exactly as referred to in the command \
(e.g. "Rohit", "everyone", "priya@acme.com"), or null,
  "argument": for share_snippet the snippet label; for send_document the \
document name as said; for send_email what the email is about; for add_note \
the note text; otherwise null}}

A question ("what did Rohit say?") is always "none". Do not invent recipients."""

DRAFT_PROMPT = """Write a short email from {owner} to {recipients}, sent during \
or right after a meeting they are both in.

What {owner} asked for: "{command}"
Purpose: {purpose}

RECENT CONVERSATION (most recent last):
{context}

Rules:
- Body at most 120 words, plain text, friendly and professional.
- Ground it in the conversation. Never invent facts, figures, dates or promises.
- Open with a greeting using the recipient's first name (or "Hi all" for several).
- Sign off with "{owner_first}".
Return ONLY JSON: {{"subject": "...", "body": "..."}}"""


# ── the service ───────────────────────────────────────────────────────
class AgentService:
    """Per-user delegate agent: profiles, proposals, execution and audit."""

    def __init__(self) -> None:
        self._enabled_cache: dict[str, tuple[float, frozenset[str]]] = {}
        self._recent: dict[tuple[str, str], list[tuple[str, float]]] = {}
        self._armed: dict[tuple[str, str], float] = {}
        # Serialises execution per owner+meeting so the email cap cannot be
        # overrun by two approvals landing at once.
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    # ── profiles ──────────────────────────────────────────────────────
    async def _user(self, username: str) -> dict:
        return await get_users_collection().find_one({"username": username}) or {}

    async def default_profile(self, username: str) -> dict:
        user = await self._user(username)
        contact = ContactInfo.model_construct(**{f: "" for f in CONTACT_FIELDS}).model_dump()
        contact["full_name"] = (user.get("full_name") or user.get("display_name") or "")[:120]
        email = (user.get("email") or "").strip()
        contact["email"] = email if _EMAIL_RE.match(email) else ""
        return {
            "contact": contact,
            "share_fields": ["full_name", "email"],
            "snippets": [],
            "permissions": _default_permissions(),
            "updated_at": None,
        }

    async def get_profile(self, username: str) -> dict:
        doc = await _profiles().find_one({"username": username})
        if not doc:
            return await self.default_profile(username)
        base = await self.default_profile(username)
        perms = _default_permissions()
        for tool, perm in (doc.get("permissions") or {}).items():
            if tool in TOOLS and isinstance(perm, dict):
                perms[tool] = {"enabled": bool(perm.get("enabled")),
                               "mode": "auto" if perm.get("mode") == "auto" else "confirm"}
        return {
            "contact": {**base["contact"], **{k: v for k, v in (doc.get("contact") or {}).items() if k in CONTACT_FIELDS}},
            "share_fields": [f for f in doc.get("share_fields", base["share_fields"]) if f in CONTACT_FIELDS],
            "snippets": list(doc.get("snippets") or [])[:MAX_SNIPPETS],
            "permissions": perms,
            "updated_at": doc.get("updated_at"),
        }

    async def save_profile(self, username: str, body: ProfileIn) -> dict:
        profile = body.to_profile()
        profile["updated_at"] = _now()
        await _profiles().update_one(
            {"username": username},
            {"$set": {"username": username, **profile}},
            upsert=True,
        )
        self._enabled_cache.pop(username, None)
        return profile

    async def _enabled_tools(self, username: str) -> frozenset[str]:
        """Cached: consulted for every wake-word line in every meeting."""
        hit = self._enabled_cache.get(username)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        profile = await self.get_profile(username)
        enabled = frozenset(t for t, p in profile["permissions"].items() if p.get("enabled"))
        self._enabled_cache[username] = (time.monotonic() + PROFILE_CACHE_SECONDS, enabled)
        return enabled

    # ── meeting context ───────────────────────────────────────────────
    async def _participants(self, meeting: dict) -> list[dict]:
        """Everyone in the meeting as {username, name, full_name, email}."""
        usernames: dict[str, str | None] = {}
        for p in meeting.get("participants", []) or []:
            if p.get("username"):
                usernames[p["username"]] = p.get("display_name")
        if meeting.get("created_by"):
            usernames.setdefault(meeting["created_by"], None)
        for name in manager.usernames(meeting.get("meeting_id", "")):
            usernames.setdefault(name, None)

        users = get_users_collection()
        out = []
        for username, display in usernames.items():
            record = await users.find_one({"username": username}) or {}
            out.append({
                "username": username,
                "name": display or record.get("display_name") or record.get("full_name") or username,
                "full_name": record.get("full_name") or "",
                "email": (record.get("email") or "").strip() or None,
            })
        return out

    @staticmethod
    def _owner_name(profile: dict, owner: str, participants: Sequence[dict]) -> str:
        me = next((p for p in participants if p["username"] == owner), None)
        return (profile.get("contact") or {}).get("full_name") or (me or {}).get("name") or owner

    async def _documents(self, meeting_id: str, owner: str) -> list[dict] | None:
        """The owner's briefing docs for this meeting, or None when unsupported."""
        try:
            from services.document_service import document_service  # noqa: WPS433
        except ImportError:
            return None
        try:
            return list(await document_service.list_docs(meeting_id, owner) or [])
        except Exception as exc:
            print(f"[agent] document listing failed: {type(exc).__name__}: {exc}")
            return None

    # ── intent ────────────────────────────────────────────────────────
    async def parse_intent(self, command: str, profile: dict) -> Intent:
        labels = [s.get("label", "") for s in profile.get("snippets", [])]
        if llm_client.available:
            try:
                data = await llm_client.chat_json(
                    INTENT_PROMPT.format(
                        command=command.replace('"', "'")[:500],
                        snippets=", ".join(f'"{l}"' for l in labels) or "(none)",
                    ),
                    temperature=0.0, fast=True, max_tokens=300,
                )
                tool = str(data.get("tool") or "none").strip()
                if tool in TOOLS or tool == "none":
                    def s(v):
                        return str(v).strip()[:500] if v not in (None, "", "null") else None
                    intent = Intent(tool=tool, recipient=s(data.get("recipient")),
                                    argument=s(data.get("argument")), parser="llm")
                    if tool == "none":
                        # The model is conservative by instruction; if the
                        # rules recognise a plain command, trust them.
                        rules = parse_intent_rules(command, labels)
                        return rules if rules.tool != "none" else intent
                    return intent
            except Exception as exc:
                print(f"[agent] intent LLM failed, using rules: {type(exc).__name__}: {exc}")
        return parse_intent_rules(command, labels)

    async def _draft_email(
        self, owner_name: str, recipients: Sequence[dict], command: str,
        purpose: str | None, context: Sequence[TranscriptEntry],
    ) -> dict:
        names = [r.get("name") or r.get("email") for r in recipients]
        first = owner_name.split()[0] if owner_name else "Me"
        greet = ("Hi," if not names else
                 f"Hi {names[0].split()[0]}," if len(names) == 1 and "@" not in names[0] else
                 "Hi," if len(names) == 1 else "Hi all,")
        fallback = {
            "subject": (purpose or "Following up from our meeting")[:120].capitalize(),
            "body": f"{greet}\n\nFollowing up from our meeting"
                    f"{' about ' + purpose if purpose else ''}.\n\nBest,\n{first}",
        }
        if not llm_client.available:
            return fallback
        convo = "\n".join(f"{e.speaker}: {e.text}" for e in list(context)[-25:]) or "(nothing yet)"
        try:
            data = await llm_client.chat_json(
                DRAFT_PROMPT.format(
                    owner=owner_name, owner_first=first, recipients=", ".join(names) or "the recipient",
                    command=command[:500], purpose=purpose or "(infer from the command)",
                    context=convo[-6000:],
                ),
                temperature=0.4, fast=True, max_tokens=600,
            )
            subject = " ".join(str(data.get("subject") or "").split())[:150]
            body = str(data.get("body") or "").strip()
            words = body.split()
            if len(words) > 140:  # the prompt asks for 120; enforce a hard ceiling
                body = " ".join(words[:140]) + "…"
            if subject and body:
                return {"subject": subject, "body": body[:4000]}
        except Exception as exc:
            print(f"[agent] draft failed, using template: {type(exc).__name__}: {exc}")
        return fallback

    # ── persistence + push ────────────────────────────────────────────
    @staticmethod
    def public(doc: dict) -> dict:
        """The Action shape of the API contract - internal fields stay server-side."""
        return {
            "id": doc["id"],
            "meeting_id": doc["meeting_id"],
            "owner": doc["owner"],
            "tool": doc["tool"],
            "source": doc.get("source", "typed"),
            "command": doc.get("command", ""),
            "summary": doc.get("summary", ""),
            "recipients": [
                {"username": r.get("username"), "name": r.get("name"), "email": r.get("email")}
                for r in doc.get("recipients", [])
            ],
            "candidates": doc.get("candidates", []),
            "preview": doc.get("preview"),
            "status": doc["status"],
            "message": doc.get("message"),
            "created_at": doc["created_at"],
            "updated_at": doc["updated_at"],
        }

    async def _save(self, doc: dict, *, new: bool = False) -> dict:
        doc["updated_at"] = _now()
        if new:
            await _actions().insert_one(dict(doc))
        else:
            fields = {k: v for k, v in doc.items() if k != "_id"}
            await _actions().update_one({"id": doc["id"]}, {"$set": fields})
        public = self.public(doc)
        try:
            await manager.send_to_user(doc["meeting_id"], doc["owner"],
                                       {"type": "agent_action", "action": public})
        except Exception:
            pass
        return public

    async def _emails_sent(self, meeting_id: str, owner: str) -> int:
        total = 0
        async for doc in _actions().find({"meeting_id": meeting_id, "owner": owner}):
            total += int(doc.get("sent_count") or 0)
        return total

    # ── summaries ─────────────────────────────────────────────────────
    @staticmethod
    def _summary(doc: dict) -> str:
        tool = doc["tool"]
        names = [r.get("name") or r.get("email") for r in doc.get("recipients", [])]
        who = ", ".join(names[:-1]) + f" and {names[-1]}" if len(names) > 1 else (
            names[0] if names else f"\"{doc['spoken_recipient']}\"" if doc.get("spoken_recipient") else "someone"
        )
        payload = doc.get("payload") or {}
        if tool == "share_contact":
            return f"Email your contact card to {who}"
        if tool == "share_snippet":
            label = payload.get("snippet_label") or doc.get("argument") or "a snippet"
            return f"Email your snippet \"{label}\" to {who}"
        if tool == "send_document":
            name = payload.get("doc_name") or doc.get("argument") or "a document"
            return f"Email \"{name}\" to {who}"
        if tool == "send_email":
            subject = (doc.get("preview") or {}).get("subject")
            return f"Email {who}" + (f": {subject}" if subject else "")
        if tool == "add_note":
            text = (doc.get("preview") or {}).get("body") or doc.get("argument") or ""
            return f"Save a note: {text[:80]}" + ("…" if len(text) > 80 else "")
        return "No action recognised"

    # ── commands ──────────────────────────────────────────────────────
    async def create_action(
        self,
        meeting: dict,
        owner: str,
        text: str,
        source: Literal["voice", "typed"] = "typed",
        context: Sequence[TranscriptEntry] | None = None,
        intent: Intent | None = None,
    ) -> dict:
        """
        Turn one command into an audited Action and, when allowed, run it.

        The order of checks is deliberate: permission before any work (a
        disabled tool never drafts, resolves or reads a document), then
        resolution, then the auto/confirm decision.
        """
        meeting_id = meeting["meeting_id"]
        command, _ = strip_agent_wake_word(text.strip())
        command = command[:1000] or text.strip()[:1000]
        profile = await self.get_profile(owner)
        intent = intent or await self.parse_intent(command, profile)

        now = _now()
        doc: dict = {
            "id": uuid.uuid4().hex,
            "meeting_id": meeting_id,
            "owner": owner,
            "tool": intent.tool,
            "source": source,
            "command": command,
            "summary": "",
            "recipients": [],
            "candidates": [],
            "preview": None,
            "status": "pending",
            "message": None,
            "created_at": now,
            "updated_at": now,
            # internal
            "argument": intent.argument,
            "spoken_recipient": intent.recipient,
            "parser": intent.parser,
            "payload": {},
            "external": False,
            "sent_count": 0,
        }

        def finish(status: str, message: str | None = None) -> None:
            doc["status"] = status
            doc["message"] = message
            doc["summary"] = self._summary(doc)

        if intent.tool == "none":
            finish("failed", "I didn't recognise an action there. Try \"send my contact "
                             "details to Rohit\" or \"note that pricing is due Friday\".")
            return await self._save(doc, new=True)

        perm = profile["permissions"].get(intent.tool) or {}
        if not perm.get("enabled"):
            finish("blocked", f"Turn on '{TOOLS[intent.tool]['label']}' in Assistant settings.")
            return await self._save(doc, new=True)

        participants = await self._participants(meeting)
        owner_name = self._owner_name(profile, owner, participants)

        # ── private note: nothing leaves the account ──────────────────
        if intent.tool == "add_note":
            note = (intent.argument or command).strip()[:2000]
            doc["preview"] = {"subject": "Note", "body": note}
            doc["payload"] = {"note": note}
            if perm.get("mode") == "auto":
                finish("done", "Saved to your private notes.")
            else:
                finish("pending")
            return await self._save(doc, new=True)

        # ── email tools ───────────────────────────────────────────────
        failure = await self._prepare_payload(doc, profile, meeting_id, owner, owner_name)
        if failure:
            finish("failed", failure)
            return await self._save(doc, new=True)

        me = next((p for p in participants if p["username"] == owner), {})
        resolution = resolve_recipients(
            intent.recipient, command, participants, owner,
            owner_email=(profile["contact"].get("email") or me.get("email")),
        )
        doc["recipients"] = resolution.recipients
        doc["candidates"] = resolution.candidates
        doc["external"] = resolution.external
        doc["note"] = resolution.note

        if intent.tool == "send_email":
            if context is None:
                context = await self._recent_context(meeting_id)
            doc["preview"] = await self._draft_email(
                owner_name, resolution.recipients, command, intent.argument, context
            )
        else:
            doc["preview"] = self._fixed_preview(doc, profile, owner_name)

        if not resolution.resolved:
            finish("needs_input", resolution.message or "Who should receive this?")
            return await self._save(doc, new=True)

        if not email_service.available:
            finish("failed", "Email is not configured. Set SMTP_HOST, SMTP_PORT and SMTP_FROM "
                             "in backend/.env so your assistant can send email.")
            return await self._save(doc, new=True)

        # send_email always waits: the owner has not seen the words that
        # will go out under their name, and a generated draft is exactly the
        # thing that should never be sent unread. An address from outside the
        # meeting also waits when it was heard rather than typed.
        needs_confirm = (
            perm.get("mode") != "auto"
            or intent.tool == "send_email"
            or (resolution.external and source == "voice")
        )
        if needs_confirm:
            message = resolution.note
            if resolution.external and source == "voice":
                message = "That address isn't anyone in this meeting - check it before sending."
            finish("pending", message)
            return await self._save(doc, new=True)

        finish("running")
        await self._save(doc, new=True)
        return await self._execute(doc, profile, owner_name)

    async def _recent_context(self, meeting_id: str) -> list[TranscriptEntry]:
        doc = await get_meetings_collection().find_one(
            {"meeting_id": meeting_id}, {"transcript": {"$slice": -25}}
        )
        out = []
        for raw in (doc or {}).get("transcript", []) or []:
            try:
                out.append(TranscriptEntry(**raw))
            except Exception:
                continue
        return out

    async def _prepare_payload(
        self, doc: dict, profile: dict, meeting_id: str, owner: str, owner_name: str,
    ) -> str | None:
        """Pick the snippet / document / fields to send. Returns an error message or None."""
        tool = doc["tool"]
        if tool == "share_contact":
            fields = shared_contact(profile)
            if not fields:
                return ("You haven't marked any contact details as shareable. "
                        "Choose them in Assistant settings.")
            doc["payload"] = {"fields": list(fields)}
            return None

        if tool == "share_snippet":
            snippets = profile.get("snippets") or []
            if not snippets:
                return "You have no saved snippets. Add one in Assistant settings."
            by_label = {s["label"]: s for s in snippets}
            label = _match_label(doc.get("argument"), list(by_label))
            if not label and len(snippets) == 1 and not doc.get("argument"):
                label = snippets[0]["label"]
            if not label:
                return (f"I couldn't find a snippet called \"{doc.get('argument') or ''}\". "
                        f"Your snippets: {', '.join(by_label)}.")
            doc["payload"] = {"snippet_id": by_label[label]["id"], "snippet_label": label}
            return None

        if tool == "send_document":
            docs = await self._documents(meeting_id, owner)
            if docs is None:
                return "Document sharing isn't available on this server yet."
            if not docs:
                return "You have no briefing documents for this meeting. Upload one first."
            chosen = None
            if len(docs) == 1:
                chosen = docs[0]
            else:
                name = _match_label(doc.get("argument"), [d.get("name", "") for d in docs])
                chosen = next((d for d in docs if d.get("name") == name), None)
            if not chosen:
                return (f"Which document? You have: {', '.join(d.get('name', '?') for d in docs[:8])}.")
            doc["payload"] = {"doc_id": chosen.get("id"), "doc_name": chosen.get("name") or "document"}
            return None

        if tool == "send_email":
            doc["payload"] = {}
            return None
        return f"Unknown tool {tool}."

    @staticmethod
    def _fixed_preview(doc: dict, profile: dict, owner_name: str) -> dict:
        tool, payload = doc["tool"], doc.get("payload") or {}
        if tool == "share_contact":
            fields = shared_contact(profile)
            return {"subject": f"{owner_name}'s contact details",
                    "body": contact_card_text(fields, owner_name)}
        if tool == "share_snippet":
            snippet = next((s for s in profile.get("snippets", []) if s["id"] == payload.get("snippet_id")), None)
            return {"subject": f"{snippet['label'] if snippet else 'Snippet'} — from {owner_name}",
                    "body": snippet["text"] if snippet else ""}
        if tool == "send_document":
            return {"subject": f"{payload.get('doc_name', 'Document')} — from {owner_name}",
                    "body": f"Hi,\n\n{owner_name} asked me to send you \"{payload.get('doc_name', 'this document')}\" "
                            f"from your meeting. It's attached.\n\n— {owner_name}'s assistant"}
        return {"subject": "", "body": ""}

    # ── execution ─────────────────────────────────────────────────────
    def _lock(self, meeting_id: str, owner: str) -> asyncio.Lock:
        return self._locks.setdefault((meeting_id, owner), asyncio.Lock())

    async def _execute(self, doc: dict, profile: dict, owner_name: str) -> dict:
        """Run an approved (or auto) action. Never raises: failures land on the action."""
        if doc["tool"] == "add_note":
            doc["status"], doc["message"] = "done", "Saved to your private notes."
            doc["summary"] = self._summary(doc)
            return await self._save(doc)

        async with self._lock(doc["meeting_id"], doc["owner"]):
            try:
                sent_already = await self._emails_sent(doc["meeting_id"], doc["owner"])
                if sent_already + len(doc["recipients"]) > MAX_EMAILS_PER_MEETING:
                    doc["status"] = "blocked"
                    doc["message"] = (f"Your assistant can send at most {MAX_EMAILS_PER_MEETING} emails "
                                      f"per meeting ({sent_already} sent so far).")
                    doc["summary"] = self._summary(doc)
                    return await self._save(doc)

                if doc["status"] != "running":
                    doc["status"] = "running"
                    doc["message"] = None
                    await self._save(doc)

                message = await self._compose(doc, profile, owner_name)
                owner_email = profile["contact"].get("email") or None
                ok, failed = [], {}
                for r in doc["recipients"]:
                    try:
                        await email_service.send_message(
                            to=[r["email"]], reply_to=owner_email, **message,
                        )
                        ok.append(r)
                    except EmailDeliveryError as exc:
                        failed[r.get("name") or r["email"]] = next(iter(exc.failed.values()), str(exc))
                    except EmailUnavailable:
                        raise

                doc["sent_count"] = int(doc.get("sent_count") or 0) + len(ok)
                if ok and not failed:
                    doc["status"], doc["message"] = "done", f"Sent to {', '.join(r['name'] for r in ok)}."
                    if doc.get("note"):
                        doc["message"] += f" {doc['note']}"
                elif ok:
                    doc["status"] = "done"
                    doc["message"] = (f"Sent to {', '.join(r['name'] for r in ok)}; failed for "
                                      f"{', '.join(failed)}.")
                else:
                    doc["status"] = "failed"
                    doc["message"] = "Delivery failed: " + "; ".join(f"{k} ({v})" for k, v in failed.items())
                doc["summary"] = self._summary(doc)
                public = await self._save(doc)
                if ok:
                    await self._notify(doc, ok, owner_name)
                return public

            except EmailUnavailable as exc:
                doc["status"], doc["message"] = "failed", str(exc)
            except Exception as exc:
                print(f"[agent] execution failed: {type(exc).__name__}: {exc}")
                doc["status"] = "failed"
                doc["message"] = f"Something went wrong sending this ({type(exc).__name__})."
            doc["summary"] = self._summary(doc)
            return await self._save(doc)

    async def _compose(self, doc: dict, profile: dict, owner_name: str) -> dict:
        """Build send_message kwargs from the (possibly owner-edited) preview."""
        tool, payload = doc["tool"], doc.get("payload") or {}
        preview = doc.get("preview") or {}
        subject = preview.get("subject") or f"From {owner_name}"
        body = preview.get("body") or ""

        if tool == "share_contact":
            fields = shared_contact(profile)
            if not fields:
                raise RuntimeError("no shareable contact fields")
            # The card itself is always rebuilt from the profile, never from
            # an edited preview: the attachment must carry only what the
            # owner marked shareable.
            vcf = build_vcard(fields, owner_name).encode("utf-8")
            filename = re.sub(r"[^A-Za-z0-9_-]+", "_", owner_name).strip("_") or "contact"
            return {
                "subject": subject, "text": body,
                "html": contact_card_html(fields, owner_name),
                "attachments": [(f"{filename}.vcf", vcf, "text/vcard")],
            }

        if tool == "send_document":
            try:
                from services.document_service import document_service  # noqa: WPS433
            except ImportError:
                raise RuntimeError("document service unavailable")
            found = await document_service.get_file(payload.get("doc_id"), doc["owner"])
            if not found:
                raise RuntimeError("that document no longer exists")
            filename, data, mime = found
            return {"subject": subject, "text": body, "html": text_to_html(subject, body, owner_name),
                    "attachments": [(filename, data, mime or "application/octet-stream")]}

        # share_snippet / send_email: the preview is the message.
        return {"subject": subject, "text": body, "html": text_to_html(subject, body, owner_name)}

    async def _notify(self, doc: dict, recipients: Iterable[dict], owner_name: str) -> None:
        first = owner_name.split()[0] if owner_name else doc["owner"]
        what = {
            "share_contact": "their contact card",
            "share_snippet": f"\"{(doc.get('payload') or {}).get('snippet_label', 'a snippet')}\"",
            "send_document": f"\"{(doc.get('payload') or {}).get('doc_name', 'a document')}\"",
            "send_email": "a message",
        }.get(doc["tool"], "something")
        online = manager.usernames(doc["meeting_id"])
        for r in recipients:
            username = r.get("username")
            if not username or username == doc["owner"] or username not in online:
                continue
            try:
                await manager.send_to_user(doc["meeting_id"], username, {
                    "type": "agent_notice",
                    "notice": {"from_name": owner_name,
                               "message": f"{first}'s assistant emailed you {what}."},
                })
            except Exception:
                pass

    # ── owner decisions ───────────────────────────────────────────────
    async def _load_action(self, meeting_id: str, action_id: str, owner: str) -> dict:
        doc = await _actions().find_one({"id": action_id})
        # 404 for someone else's action: its existence is the owner's business.
        if not doc or doc.get("owner") != owner or doc.get("meeting_id") != meeting_id:
            raise AgentError("action not found", 404)
        doc.pop("_id", None)
        return doc

    async def list_actions(self, meeting_id: str, owner: str, limit: int = 100) -> list[dict]:
        cursor = _actions().find({"meeting_id": meeting_id, "owner": owner}).sort("created_at", -1).limit(limit)
        return [self.public(d) async for d in cursor]

    async def reject(self, meeting_id: str, action_id: str, owner: str) -> dict:
        doc = await self._load_action(meeting_id, action_id, owner)
        if doc["status"] not in ("pending", "needs_input"):
            raise AgentError(f"This action is already {doc['status']}.", 409)
        doc["status"], doc["message"] = "rejected", None
        return await self._save(doc)

    async def approve(
        self,
        meeting: dict,
        action_id: str,
        owner: str,
        *,
        recipient_username: str | None = None,
        recipient_email: str | None = None,
        subject: str | None = None,
        body: str | None = None,
    ) -> dict:
        doc = await self._load_action(meeting["meeting_id"], action_id, owner)
        if doc["status"] not in ("pending", "needs_input"):
            raise AgentError(f"This action is already {doc['status']}.", 409)

        profile = await self.get_profile(owner)
        perm = profile["permissions"].get(doc["tool"]) or {}
        if not perm.get("enabled"):
            # Switched off between proposal and approval: honour the latest choice.
            doc["status"] = "blocked"
            doc["message"] = f"Turn on '{TOOLS[doc['tool']]['label']}' in Assistant settings."
            doc["summary"] = self._summary(doc)
            return await self._save(doc)

        participants = await self._participants(meeting)
        owner_name = self._owner_name(profile, owner, participants)

        if doc["tool"] in EMAIL_TOOLS:
            if recipient_username or recipient_email:
                chosen: list[dict] = []
                if recipient_username:
                    person = next((p for p in participants if p["username"] == recipient_username), None)
                    if not person:
                        raise AgentError("That person isn't in this meeting.", 400)
                    email = person.get("email")
                    if not email and not recipient_email:
                        raise AgentError(f"{person['name']} has no email address on file - type one instead.", 400)
                    chosen.append({"username": person["username"], "name": person["name"],
                                   "email": recipient_email.strip() if recipient_email else email})
                else:
                    addr = recipient_email.strip()
                    if not _EMAIL_RE.match(addr) or len(addr) > 254:
                        raise AgentError("That doesn't look like an email address.", 400)
                    known = next((p for p in participants if (p.get("email") or "").lower() == addr.lower()), None)
                    # Typed by the owner, so an outside address is allowed.
                    chosen.append({"username": known["username"] if known else None,
                                   "name": known["name"] if known else addr, "email": addr})
                if chosen[0].get("email") and not _EMAIL_RE.match(chosen[0]["email"]):
                    raise AgentError("That doesn't look like an email address.", 400)
                doc["recipients"], doc["candidates"], doc["note"] = chosen, [], None
            if not doc.get("recipients"):
                raise AgentError("Pick a recipient or type an email address first.", 400)

            preview = dict(doc.get("preview") or {})
            if subject is not None and subject.strip():
                preview["subject"] = " ".join(subject.split())[:200]
            if body is not None and body.strip():
                preview["body"] = body.strip()[:10000]
            doc["preview"] = preview

            if not email_service.available:
                doc["status"] = "failed"
                doc["message"] = ("Email is not configured. Set SMTP_HOST, SMTP_PORT and SMTP_FROM "
                                  "in backend/.env so your assistant can send email.")
                doc["summary"] = self._summary(doc)
                return await self._save(doc)
        elif doc["tool"] == "add_note" and body is not None and body.strip():
            doc["preview"] = {"subject": "Note", "body": body.strip()[:2000]}

        doc["summary"] = self._summary(doc)
        return await self._execute(doc, profile, owner_name)

    # ── the live hook ─────────────────────────────────────────────────
    def _debounced(self, meeting_id: str, owner: str, command: str) -> bool:
        """True when the same command was heard from this owner in the last 20 s."""
        key, now = (meeting_id, owner), time.monotonic()
        norm = _norm(command)
        recent = [(t, ts) for t, ts in self._recent.get(key, []) if now - ts < DEBOUNCE_SECONDS]
        dup = any(t == norm or difflib.SequenceMatcher(None, t, norm).ratio() > 0.92 for t, _ in recent)
        if not dup:
            recent.append((norm, now))
        self._recent[key] = recent[-10:]
        return dup

    async def _speaker_username(self, meeting: dict, speaker: str) -> str | None:
        """
        Map a transcript speaker to a username.

        Live entries carry the username of the socket they arrived on; entries
        written by other paths may carry a display name. Only an unambiguous
        match counts - acting as the wrong person is worse than not acting.
        """
        if not speaker:
            return None
        participants = await self._participants(meeting)
        for p in participants:
            if p["username"] == speaker:
                return speaker
        low = speaker.strip().lower()
        matches = {p["username"] for p in participants
                   if low in {(p.get("name") or "").lower(), (p.get("full_name") or "").lower()}}
        return matches.pop() if len(matches) == 1 else None

    async def on_transcript(
        self, meeting_id: str, entry: TranscriptEntry, context: list[TranscriptEntry]
    ) -> None:
        """
        Hook for every finalised transcript line. Never raises.

        Cheapest checks first: wake word (string match), then speaker has an
        enabled tool (cached), then the action/question pre-filter, and only
        then an LLM call to parse the command.
        """
        try:
            text = (entry.text or "").strip()
            if not text:
                return
            command, addressed = strip_agent_wake_word(text)
            speaker_key = (meeting_id, entry.speaker)

            if not addressed:
                # "hey meetai" alone, then the command as the next line.
                armed_at = self._armed.pop(speaker_key, None)
                if armed_at is None or time.monotonic() - armed_at > ARMED_SECONDS:
                    return
                command = text
            elif not command:
                self._armed[speaker_key] = time.monotonic()
                return

            if not looks_like_action(command):
                return  # a question: the voice assistant's job

            meeting = await get_meetings_collection().find_one({"meeting_id": meeting_id})
            if not meeting:
                return
            owner = await self._speaker_username(meeting, entry.speaker)
            if not owner or not await self._enabled_tools(owner):
                return

            if self._debounced(meeting_id, owner, command):
                return

            profile = await self.get_profile(owner)
            intent = await self.parse_intent(command, profile)
            if intent.tool == "none":
                return  # never create noise from a misheard aside

            await self.create_action(meeting, owner, command, source="voice",
                                     context=context, intent=intent)
        except Exception as exc:
            print(f"[agent] on_transcript error: {type(exc).__name__}: {exc}")


agent_service = AgentService()
