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
| **Live transcription** | Audio streamed over WebSocket in 1.5 s chunks → Groq Whisper Large v3 |
| **Action detection** | Fast LLM pass over each new utterance; detects scheduling, commitments, deadlines and task assignments, with a confidence score |
| **Minutes of Meeting** | Structured Markdown: agenda → discussion → decisions → action table → next steps |
| **Executive summary** | ≤200 words, decision-focused |
| **Sentiment analysis** | Overall tone plus emotional shifts by timestamp |
| **Calendar** | Google Calendar OAuth2; confirmed actions become events |
| **Auth** | JWT access + refresh, bcrypt, role-based access |
| **Ask your meetings** | Semantic search across every transcript. Local embeddings (fastembed ONNX) into an embedded Qdrant collection; answers cite the passage they came from |
| **Voice assistant** | Push-to-talk during a meeting: Whisper STT → grounded LLM answer → spoken reply. Provider-agnostic TTS |
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
| `GROQ_API_KEY` | for AI | free key at [console.groq.com](https://console.groq.com/keys) |
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

### Missing keys degrade, they do not crash

The app boots and runs with no credentials at all. Without `GROQ_API_KEY`,
meetings still work — video, rooms, participants, transcripts you type — and
transcription and report generation return a clear "not configured" message
naming the key to set. Without LiveKit, everything but joining a room works.

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

Retrieval works with no LLM key at all. Only the composed answer needs Groq,
and when that fails the passages are still returned with the reason stated.

---

## Voice assistant

Hold the mic during a meeting and ask a question aloud:

```
mic ──► Whisper STT ──► question
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
    transcription_service.py  audio buffering → Groq Whisper
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
                                          WS     /meetings/{id}/ws

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
