# Deployment

MeetAI splits into a static frontend and a stateful API, so they deploy
separately. The reference deployment is Vercel + Render + MongoDB Atlas, all on
free tiers.

| Piece | Host | Why |
|---|---|---|
| Frontend | Vercel | Static build, global CDN, deploy from git |
| Backend | Render | Long-lived WebSockets, which serverless functions cannot hold |
| Database | MongoDB Atlas M0 | Free, managed, TLS on by default |
| Video | LiveKit Cloud | WebRTC SFU; self-hosting one is not a portfolio-scale problem |

The backend **must not** go on a serverless platform. Live transcription holds
a WebSocket open for the length of a meeting; Vercel/Netlify functions cap out
long before that.

---

## 1. Database — MongoDB Atlas

SQLite is the default and is genuinely fine for a single instance, but Render's
free tier has an ephemeral filesystem: the disk is wiped on every deploy and on
every idle spin-down. Use Atlas in production, or attach a Render persistent
disk and keep SQLite.

1. Create a free M0 cluster at <https://cloud.mongodb.com>.
2. **Database Access** → add a user with a generated password.
3. **Network Access** → allow `0.0.0.0/0` (Render egress IPs are not static on
   the free tier).
4. Copy the connection string.

---

## 2. Backend — Render

1. **New → Web Service**, point it at the repository, root directory `meetai/backend`.
2. Build command:
   ```
   pip install -r requirements.txt
   ```
3. Start command — bind to Render's `$PORT`, not a hardcoded one:
   ```
   uvicorn main:app --host 0.0.0.0 --port $PORT
   ```
4. Environment:

   | Key | Value |
   |---|---|
   | `ENVIRONMENT` | `production` |
   | `SECRET_KEY` | a fresh 64-hex-char secret |
   | `DATABASE_BACKEND` | `mongodb` |
   | `MONGODB_URL` | the Atlas connection string |
   | `MONGODB_DB_NAME` | `meetai` |
   | `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | from LiveKit Cloud |
   | `GROQ_API_KEY` | from console.groq.com |
   | `ALLOWED_ORIGINS` | `["https://your-app.vercel.app"]` |
   | `GOOGLE_REDIRECT_URI` | `https://your-api.onrender.com/calendar/oauth2callback` |

Set `DATABASE_BACKEND=mongodb` explicitly rather than leaving it on `auto`. On
`auto`, an Atlas outage silently falls back to SQLite on an ephemeral disk, and
the app keeps serving while quietly writing meetings to a volume that is about
to be deleted. Failing loudly is the correct behaviour in production.

Generate the secret with:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

> Free-tier Render spins down after 15 minutes idle; the next request takes
> ~50 s to wake it. If someone is reviewing this from a link, either warm it
> first or use the paid instance.

---

## 3. Frontend — Vercel

1. **New Project** → import the repository, root directory `meetai/frontend`.
2. Framework preset: **Vite**. Build `npm run build`, output `dist`.
3. Environment:

   | Key | Value |
   |---|---|
   | `VITE_API_URL` | `https://your-api.onrender.com` |
   | `VITE_WS_URL` | `wss://your-api.onrender.com` |
   | `VITE_LIVEKIT_URL` | `wss://your-project.livekit.cloud` |

`VITE_WS_URL` must be `wss://`, not `ws://`. A secure page cannot open an
insecure WebSocket; the browser blocks it as mixed content and live
transcription silently never connects.

---

## 4. After deploying

- Set `ALLOWED_ORIGINS` on the backend to the exact Vercel URL, including
  scheme and no trailing slash.
- Add the production redirect URI to the Google Cloud OAuth client, or the
  calendar flow fails with `redirect_uri_mismatch`.
- Check `GET /health` — it reports which database backend is actually live.

---

## Docker

`docker-compose.yml` at the repository root brings up backend, frontend and
MongoDB together:

```bash
docker compose up -d --build
docker compose logs -f backend
docker compose down
```

Useful for a self-hosted VPS deployment, and for reproducing the production
topology locally.

---

## Security checklist

- [ ] `ENVIRONMENT=production` (enables the HTTPS redirect middleware)
- [ ] `SECRET_KEY` fresh, ≥64 hex chars, never the development value
- [ ] `ALLOWED_ORIGINS` narrowed to your domain — not `*`
- [ ] Atlas user scoped to one database, not an admin account
- [ ] `ENCRYPTION_KEY` set if transcripts contain anything sensitive
- [ ] No `.env` committed — verify with `git ls-files | grep -i env`

That last item is not hypothetical. An earlier revision of this repository
committed `backend/.env` with live credentials for Groq, LiveKit, AWS, OpenAI,
ElevenLabs, Deepgram and Azure. Deleting the file does not help — git history
retains it, and automated scanners find committed keys within minutes.
Rotation is the only remedy.
