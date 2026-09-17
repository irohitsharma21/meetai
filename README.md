# MeetAI

**A meeting platform that produces a record you can act on.**

HD video via LiveKit, live speech-to-text, and an LLM watching the transcript
for the moments that actually matter — commitments, deadlines, task
assignments — surfaced as a confirmable prompt while the meeting is still
happening, then written up as minutes when it ends.

---

## Why this exists

Meeting notes are written after the meeting, by someone who was in it, from
memory. The commitments made in minute 12 are the ones that get lost.

MeetAI treats the transcript as a live signal rather than an artefact. When
someone says "I'll send that over by Friday", the system detects a commitment,
shows the host a prompt, and — if confirmed — writes it to Google Calendar
before anyone has left the call.

---

## Features

| | |
|---|---|
| **Live video** | LiveKit WebRTC SFU, room + token management server-side |
| **Join by code** | Every meeting gets a shareable code (`abc-defg-hij`) and invite link. Anyone signed in who holds the code can join, so participants do not have to be invited by username first |
| **Waiting room & host controls** | Newcomers wait until the host admits them; the host can lock the room, server-mute anyone's mic or camera, mute everyone, and remove someone for good. All enforced on the server, not just hidden in the UI |
| **Live transcription** | Audio streamed over WebSocket in 1.5 s chunks → Deepgram `nova-3` streaming, punctuated and cased. Survives mute/unmute and silences past Deepgram's 10 s timeout; nothing is sent while muted. Groq Whisper Large v3 is retained as an alternative backend |
| **Action detection** | Fast LLM pass over each new utterance; detects scheduling, commitments, deadlines and task assignments, with a confidence score |
| **Minutes of Meeting** | Structured Markdown: agenda → discussion → decisions → action table → next steps |
| **Executive summary** | ≤200 words, decision-focused |
| **Sentiment analysis** | Overall tone plus emotional shifts by timestamp |
| **Calendar** | Google Calendar OAuth2; confirmed actions become events |
| **Auth** | JWT access + refresh, bcrypt, role-based access |
| **Ask your meetings** | Semantic search across every transcript. Local embeddings (fastembed ONNX) into an embedded Qdrant collection; answers cite the passage they came from |
| **Voice assistant** | Push-to-talk during a meeting: speech-to-text → grounded LLM answer → spoken reply. Provider-agnostic TTS |
| **Meeting analytics** | Share of voice, turns, questions, fillers, participation balance, salient topics — computed from the transcript, no API calls |
| **Email digest** | Post-meeting summary, action items and participation stats mailed to participants |
| **Transcript export** | TXT or JSON |

---

## Quick start

```bash
cd backend
python -m venv .venv && . .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --port 8000
```

```bash
cd frontend
npm install
npm run dev
```

<http://localhost:5173> · API docs at <http://localhost:8000/docs>

From the repository root, `./run.ps1 start meetai` starts both in the
background.

**No database server required.** MeetAI persists to SQLite by default — clone,
run, done.

---

## Persistence

MeetAI uses MongoDB as a plain document store: five collection methods, eight
query operators, no aggregation pipelines. Requiring a running `mongod` or an
Atlas account just to open the app is a lot of setup friction for a data model
that never exploits any of it.

So persistence is pluggable, and both backends sit behind one API:

| `DATABASE_BACKEND` | Behaviour |
|---|---|
| `auto` *(default)* | MongoDB when `MONGODB_URL` is reachable, otherwise SQLite |
| `sqlite` | Always SQLite. Zero setup; persists to `SQLITE_PATH` |
| `mongodb` | Always MongoDB; fails loudly if unreachable |

The SQLite driver ([`db/sqlite_store.py`](backend/db/sqlite_store.py))
implements the subset of the Motor async collection API the app actually uses
— `find_one`, `find` with sort/skip/limit and async iteration, `insert_one`,
`update_one`, `delete_one`, `count_documents` — plus `$or`, `$ne`, `$in`,
`$text`/`$search`, dotted paths that reach into arrays of subdocuments,
`$set`, `$push`/`$each`, and `$slice` projections.

Documents are stored as JSON and filtered in Python, because the query surface
is tiny and the working set is small. **Uniqueness is not** — that is delegated
to real SQLite expression indexes over `json_extract`, so a duplicate username
fails at the database with an `IntegrityError` rather than in application code.

`GET /health` reports which backend is live.

> The previous implementation fell back to `mongomock` when MongoDB was
> unreachable. That kept the app running but silently discarded every meeting
> on restart, and did not enforce unique indexes.

---

## Configuration

Everything lives in `backend/.env` (see `.env.example`).

| Variable | Required | Purpose |
|---|---|---|
| `SECRET_KEY` | ✅ | JWT signing key (≥32 chars) |
| `DATABASE_BACKEND` | | `auto` \| `sqlite` \| `mongodb` |
| `SQLITE_PATH` | | defaults to `./data/meetai.db` |
| `MONGODB_URL` | | only for the `mongodb` backend |
| `LIVEKIT_URL` / `_API_KEY` / `_API_SECRET` | for video | free tier at [cloud.livekit.io](https://cloud.livekit.io/) |
| `STT_PROVIDER` | | `deepgram` *(default)* \| `groq` |
| `DEEPGRAM_API_KEY` | for transcription | free credit at [console.deepgram.com](https://console.deepgram.com/signup) |
| `DEEPGRAM_MODEL` / `DEEPGRAM_LANGUAGE` | | default to `nova-3` and `en` |
| `OPENROUTER_API_KEY` | for AI | free key at [openrouter.ai](https://openrouter.ai/keys); every default model is free tier |
| `OPENROUTER_MODEL` / `_FAST_MODEL` | | `nex-agi/nex-n2.5-pro:free` and `nex-agi/nex-n2.5-mini:free` |
| `OPENROUTER_FALLBACK_MODELS` | | ordered list tried when the primary model is busy |
| `OPENROUTER_BASE_URL` | | only to point at another OpenAI-compatible endpoint |
| `OPENROUTER_SITE_URL` / `OPENROUTER_APP_NAME` | | attribution headers, per OpenRouter's convention |
| `GROQ_API_KEY` | | alternative backend — speech-to-text when `STT_PROVIDER=groq`, and the LLM when `OPENROUTER_API_KEY` is empty |
| `GOOGLE_CLIENT_ID` / `_SECRET` | for calendar | Google Cloud Console |
| `SMTP_HOST` / `_PORT` / `_FROM` | for digests | any SMTP provider |
| `TTS_PROVIDER` | | `browser` (no key) \| `elevenlabs` \| `murf` \| `sarvam` |
| `SEMANTIC_SEARCH_ENABLED` | | defaults on; embeddings are local |
| `QDRANT_URL` | | only to use a Qdrant server instead of embedded mode |
| `ENCRYPTION_KEY` | | AES-256 field encryption (base64, 32 bytes) |

```bash
python -c "import secrets; print(secrets.token_hex(32))"              # SECRET_KEY
python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"  # ENCRYPTION_KEY
```

### Why these two providers

Speech-to-text defaults to Deepgram because the browser's `MediaRecorder`
produces WebM/Opus and Deepgram decodes that container natively — there is no
transcode step, and therefore no ffmpeg in the request path. `smart_format`
returns punctuation and casing, which earns its place twice over: the
transcript is read by people, and it is also fed to an LLM whose action
detection works better on punctuated text than on an undifferentiated run of
words. Groq Whisper is kept as an alternative backend for anyone who already
holds a Groq key — set `STT_PROVIDER=groq`.

In practice `nova-3` transcribed a WebM/Opus clip of synthesised speech
word-perfectly in about 1.7 s, punctuation and the proper noun "Priya"
included, and the action-detection pass over it returned in 1.8 s with the task
("Send the vendor contract"), assignee ("Priya") and deadline ("Friday") all
correct at 0.98 confidence.

The LLM is OpenRouter, which speaks the OpenAI chat-completions dialect and
fronts many providers behind one key, so changing model is an `.env` edit
rather than a client rewrite. The default models are all free tier, so the AI
features are demonstrable without a payment method. Groq remains the fallback:
if `OPENROUTER_API_KEY` is empty and `GROQ_API_KEY` is set, the same prompts
run there instead.

### Missing keys degrade, they do not crash

The app boots and runs with no credentials at all. Without `DEEPGRAM_API_KEY`,
meetings still work — video, rooms, participants, transcripts you type — and
transcription returns a clear "not configured" message naming the key to set.
Without an LLM key, report generation does the same. Without LiveKit,
everything but joining a room works.

Crucially, a degraded feature says so. Both providers are probed once at
startup, so `GET /health` reports the truth before anyone joins a meeting:

```jsonc
"transcription": {
  "available": true, "reason": null,
  "model": "nova-3", "provider": "deepgram"
},
"llm": {
  "available": true, "provider": "openrouter",
  "model": "nex-agi/nex-n2.5-pro:free", "reason": null
}
```

When a key is rejected the same fields carry the reason instead:

```jsonc
"transcription": {
  "available": false,
  "reason": "Deepgram rejected the API key (401). Speech-to-text is off until
             a valid DEEPGRAM_API_KEY is set in backend/.env and the API
             restarts.",
  "model": "nova-3", "provider": "deepgram"
}
```

Both probes run as detached background tasks at startup, so a provider that is
slow or unreachable cannot hold the app closed while it waits on a third
party. The service boots, and the health endpoint fills in the answer when it
arrives.

The same status is pushed over the meeting WebSocket on connect. The room
header reads **Transcription off** rather than "Transcribing", and the
transcript panel states the reason. An empty transcript panel otherwise has two
indistinguishable causes — nobody has spoken, or speech-to-text cannot run at
all — and only the server knows which.

---

## One LLM client, one fallback chain

Every AI feature — action detection, minutes, executive summary, sentiment, RAG
answers and the voice assistant — goes through
[`services/llm_client.py`](backend/services/llm_client.py). Centralising access
makes the model an `.env` value rather than something written into six separate
call sites, and leaves one place that has to know how a provider misbehaves.

On the free tier a 429 is routine rather than exceptional: a model can be busy
for a few seconds and be perfectly fine immediately afterwards. A single-model
client reports that as "AI reports are broken". So each request walks
`OPENROUTER_MODEL` and then `OPENROUTER_FALLBACK_MODELS` in order until one
answers, and a busy model degrades into a slower answer rather than a failed
feature.

The status codes are not treated alike. A 429 or a 5xx moves to the next model,
because the request is fine and the model is not. A 401 disables the client
outright and records the reason — a rejected key never fixes itself, and
retrying it on every request turns one configuration mistake into a flood of
identical failures.

Responses are parsed tolerantly. Several free models emit their reasoning
alongside the answer, or wrap the JSON in a markdown fence, whatever the prompt
asked for. The parser scans for a balanced JSON object rather than using a
greedy `{.*}`, which swallows trailing prose and fails on any response that
continues past the JSON.

Timeouts follow from the same arithmetic. Minutes, summary and sentiment over a
full transcript run past a minute on free models — roughly 64 s for a nine-turn
transcript — so the frontend allows 240 s for `generate-report`, `insights/ask`
and the assistant rather than the default 30 s. A client that gives up while
the server is still working produces an error message and a finished report
that nobody ever sees.

---

## Multiple participants

A meeting is addressable two ways: by its `meeting_id` (a UUID, used
internally and in URLs) and by its **join code** — ten characters formatted
`abc-defg-hij`, generated from an alphabet with no `0`/`O` and no `1`/`I`/`l`,
so a code read aloud or copied off a screen survives the trip.

Two ways in:

1. **Invite by username** at creation. Names are checked against real accounts,
   so a typo is reported rather than stored as a participant who can never sign
   in. Invited people see the meeting on their dashboard.
2. **Share the code or link.** Anyone signed in who holds it can join, which is
   the point of a code — no invite needed. `POST /meetings/join-by-code`
   resolves it.

The server normalises what people actually paste, so all of these resolve to
the same meeting:

```
abc-defg-hij      ABC-DEFG-HIJ      abcdefghij
  abc-defg-hij    http://localhost:5173/join/abc-defg-hij
```

The host is on the roster from the moment they create the meeting; everyone
else is added when they first join. The code appears in the meetings table
(click to copy the invite link) and in the meeting header, with separate
buttons for the bare code and the full link.

An unknown code returns 404 with the code echoed back; a meeting that has
already ended returns 410 pointing at its report, rather than dropping the
person into a dead room.

---

## Waiting room & host controls

Holding a shareable code should not be the same as being in the room. By
default every meeting has a **waiting room**: the host walks straight in, and
everyone else asks.

`POST /meetings/{id}/join` answers with what should happen next rather than
a token-or-error:

| Response | Meaning |
|---|---|
| `200` + LiveKit token | In. Host always; participants once admitted or when the waiting room is off |
| `202 {"status": "waiting", ...}` | Holding in the lobby. The client polls `GET /meetings/{id}/lobby/me` every 2 s and calls `join` again once it reads `"admitted"` |
| `403` | Declined by the host, or removed from the meeting earlier |
| `410` | The meeting has ended |
| `423` | The host has locked the room; nobody new gets in, admitted or not |

The host sees the queue (`GET /meetings/{id}/lobby`) and admits or denies
one person (`POST .../lobby/{username}/admit` / `deny`) or everyone at once
(`POST .../lobby/admit-all`). Admitting a name that has not asked yet
pre-approves them. Room policy lives in `PATCH /meetings/{id}/settings`:

```
waiting_room   true    hold newcomers until admitted
locked         false   nobody new can join, even if admitted
allow_chat, allow_screen_share, allow_reactions   true  (participants; host always can)
```

Controls that act on the live call go through LiveKit's server API rather
than a polite message the client could ignore:

- `GET  /meetings/{id}/participants/live` — who is actually connected, with
  their audio / video / screen tracks and mute state
- `POST /meetings/{id}/participants/{identity}/mute` body `{"kind": "audio"|"video"}`
  — mutes that published track at the SFU; the person may unmute themselves
- `POST /meetings/{id}/mute-all` — mutes every non-host microphone
- `POST /meetings/{id}/participants/{identity}/remove` — disconnects them,
  adds them to the meeting's `banned` list so a still-valid token or a fresh
  `join` no longer works, and stamps `left_at` on the roster

Everyone with the meeting WebSocket open hears about it as it happens:
`lobby_update` (waiting count), `settings_update`, `participant_removed`
and `meeting_ended`, so the host's badge and the participants' screens
change without a refresh; polling `lobby/me` remains the source of truth for
the person waiting. Hand-raise, reactions and chat ride the LiveKit data
channel and participant attributes and never touch the backend.

A LiveKit outage during any of these returns `502` with a message saying so,
not a traceback. Meetings created before this feature existed carry no
`settings`, `lobby` or `banned` fields; they read as the defaults above.

---

## Ask your meetings

Meeting knowledge is unsearchable by nature — the decision you need is nine
minutes into a call from three weeks ago. This indexes every transcript and
answers questions over them:

> **"When did we agree the migration deadline?"**
> → *Arjun said he would have the migration script ready by Friday, and the
> schema freeze was agreed for the fifteenth.* [Platform Migration Planning]

Three decisions worth calling out:

**Embeddings run locally.** `fastembed` executes a quantised ONNX model
(`bge-small-en-v1.5`, 384-d) on CPU — no API key, no per-query cost, and no
transcript content leaving the host. Meeting transcripts are exactly the kind
of data that should not be shipped to a third party to be indexed.

**Qdrant runs embedded.** Vectors live in a local directory, so search needs no
extra service. Setting `QDRANT_URL` switches to a real Qdrant server with no
other change.

**Chunks are windows of consecutive turns.** A lone line — *"Yes, Thursday
morning."* — carries almost no retrievable meaning; the question it answers is
in the turn before it. Windows of six turns overlap by three so an exchange is
never split across a boundary.

Retrieval works with no LLM key at all. Only the composed answer needs a model,
and when that fails the passages are still returned with the reason stated.

---

## Voice assistant

Hold the mic during a meeting and ask a question aloud:

```
mic ──► Deepgram STT ──► question
                             │
           live transcript ──┼──► LLM ──► answer ──► TTS ──► spoken reply
           past meetings  ───┘
```

It is grounded twice: recent turns of the current meeting for immediate context
("what did she just commit to?"), and semantic search over past meetings for
history. The prompt keeps the two sources separate so the model cannot present
last month's decision as something just said.

Push-to-talk, not always-on. The button is the addressing gesture, so meeting
audio only reaches the STT endpoint when someone deliberately asks — a system
that streams every meeting to a third party on the chance it is addressed is a
worse product and a worse privacy posture.

TTS is provider-agnostic (`TTS_PROVIDER`): `elevenlabs`, `murf`, `sarvam`, or
`browser`. The browser option needs no key — the client speaks the reply with
the Web Speech API — so the feature is demonstrable with zero credentials, and
a failed synthesis degrades to it rather than losing the answer.

---

## Analytics

Computed from the stored transcript, so it costs nothing and works whether or
not AI reports were generated: share of voice, turns, words per turn,
questions, filler words, longest turn, and salient topics.

Participation balance is normalised Shannon entropy over talk-time share — 1.0
is an even split, 0.0 is one person talking — which accounts for the whole
distribution rather than just the loudest speaker.

Two measurements are deliberately conservative:

- **Talk time is estimated from word count**, not from timestamp gaps. Entries
  carry a start time but no duration, and inferring duration from the gap to
  the next entry counts silence as speech.
- **Interruption counts are suppressed when timestamps are degenerate.** If
  transcript entries share near-identical offsets — a burst flush after a
  reconnect, say — every speaker change looks like an interruption. The API
  reports `timing_reliable: false` and the UI explains why the number is
  missing, rather than showing a figure that means nothing.

---

## Architecture

```
backend/
  main.py                 FastAPI app, CORS, lifespan
  core/
    config.py             pydantic-settings; all env vars typed
    security.py           JWT, bcrypt, AES-256-GCM field encryption
  db/
    mongodb.py            backend selection + index declaration
    sqlite_store.py       SQLite driver behind the Motor collection API
  models/meeting_model.py all pydantic models
  services/
    livekit_service.py    room + access token management
    transcription_service.py  provider selection; buffered path for Groq Whisper
    deepgram_live.py      one resilient Deepgram stream per speaker: new socket per
                          recording, idle-close before the 10 s timeout, dropped
                          sockets replaced and primed with the WebM init segment
    llm_client.py             one LLM client, model fallback, tolerant JSON
    ai_analysis_service.py    prompts, action detection, reports
    calendar_service.py   Google Calendar OAuth2
    search_service.py     chunking, local embeddings, Qdrant retrieval
    assistant_service.py  in-meeting voice Q&A, grounded twice
    analytics_service.py  participation statistics
    tts_service.py        provider-agnostic speech synthesis
    email_service.py      HTML digest over SMTP
  routers/
    auth_routes.py        register / login / refresh / me
    meeting_routes.py     CRUD, join, start, end, report, WS transcription
    transcript_routes.py  fetch + export
    calendar_routes.py    OAuth2 flow + event creation
    insight_routes.py     analytics, search, assistant, digests

frontend/src/
  index.css               design tokens + component styles
  pages/                  auth · dashboard · meeting · report · calendar
  components/             navbar, toasts, video grid, transcript, action popup
  store/                  zustand
  hooks/useWebSocket.ts   transcription socket + mic capture
  lib/api.ts              axios client with token refresh
```

---

## WebSocket protocol

Connect to `ws://localhost:8000/meetings/{meeting_id}/ws`.

```jsonc
// client → server
{"cmd": "identify", "token": "<access_token>"}
{"cmd": "audio_config", "format": "webm", "sample_rate": 16000}
// then binary WebM/Opus chunks, every 1.5 s from MediaRecorder

// server → client
{"type": "connected", "username": "alice"}
{"type": "transcription_status", "available": false,
 "reason": "Deepgram rejected the API key (401). ...", "model": "nova-3"}
{"type": "transcript", "entry": {"speaker": "alice", "text": "...", "time": "00:01:23"}}
{"type": "action_detected", "result": {"trigger": true, "type": "schedule",
                                        "confidence": 0.92,
                                        "suggested_action": "Schedule review Friday 5PM?"}}
{"type": "error", "message": "..."}
```

---

## API

```
POST   /auth/register                     GET    /meetings/{id}
POST   /auth/login                        POST   /meetings/{id}/join
POST   /auth/refresh                      POST   /meetings/{id}/start
GET    /auth/me                           POST   /meetings/{id}/end
                                          POST   /meetings/{id}/generate-report
POST   /meetings/                         POST   /meetings/{id}/actions/{aid}/confirm
GET    /meetings/                         POST   /meetings/{id}/actions/{aid}/reject
POST   /meetings/join-by-code             DELETE /meetings/{id}
                                          WS     /meetings/{id}/ws

GET    /meetings/{id}/lobby               GET    /meetings/{id}/participants/live
GET    /meetings/{id}/lobby/me            POST   /meetings/{id}/participants/{identity}/mute
POST   /meetings/{id}/lobby/admit-all     POST   /meetings/{id}/participants/{identity}/remove
POST   /meetings/{id}/lobby/{user}/admit  POST   /meetings/{id}/mute-all
POST   /meetings/{id}/lobby/{user}/deny
PATCH  /meetings/{id}/settings

GET    /transcripts/{id}                  GET    /calendar/connect
GET    /transcripts/{id}/export           GET    /calendar/status
POST   /transcripts/{id}/entry            POST   /calendar/events
GET    /health                            POST   /calendar/confirm-action

POST   /insights/search                   GET    /insights/{id}/analytics
POST   /insights/ask                      POST   /insights/{id}/digest
POST   /insights/{id}/index               POST   /insights/{id}/assistant/ask
POST   /insights/reindex-all              POST   /insights/{id}/assistant/listen
GET    /insights/search/status            GET    /insights/assistant/status
GET    /insights/email/status
```

Full OpenAPI at `/docs`.

---

## Security notes

- Secrets are gitignored. `.env.example` is the template; `.env` is never
  committed.
- Passwords are bcrypt-hashed; JWTs are short-lived with a separate refresh
  token.
- `HTTPSRedirectMiddleware` engages automatically when `ENVIRONMENT=production`.
- `ALLOWED_ORIGINS` should be narrowed to your domain in production.
- Optional AES-256-GCM field encryption for transcript content at rest.

> An earlier revision of this repository committed a `.env` containing live
> credentials for Groq, LiveKit, AWS, OpenAI and several other services. Those
> keys have been revoked. If you fork any repository with a committed `.env`,
> assume every key in it is compromised — rotation is the only fix, because
> git history keeps the file even after deletion.

---

## Deployment

See [`docs/deployment.md`](docs/deployment.md). Short version: frontend to
Vercel, backend to Render, database to MongoDB Atlas free tier (or keep SQLite
on a persistent disk).

---

## Licence

MIT.
