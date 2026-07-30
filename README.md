# Dr. CV Voice Backend (drcv-backend)

A tiny Express proxy that mints short-lived OpenAI Realtime API tokens so the
browser (see the `landing` repo's `call.html`) can open a live voice call
with "Dr. CV" without ever exposing your real OpenAI API key to the client.

## How it works

1. Browser calls `POST /session` on this server.
2. This server calls OpenAI's Realtime API (`/v1/realtime/client_secrets`)
   using your real `OPENAI_API_KEY`, and gets back a short-lived ephemeral
   token (`value`).
3. This server returns that ephemeral token to the browser.
4. The browser uses the ephemeral token to open a WebRTC connection
   directly to OpenAI (`/v1/realtime/calls`). Audio never passes through
   this server — only the token-minting request does.

## Files

| File               | Purpose                                              |
|--------------------|-------------------------------------------------------|
| `serverr.js`       | The Express server (entry point — see `package.json`) |
| `package.json`     | Dependencies + start command                         |
| `package-lock.json`| Locked dependency versions (keep this committed)      |
| `.env.example`     | Template for required environment variables           |

> Note the filename is `serverr.js` (double r) — that's intentional, it
> matches what `package.json`'s `main`/`start` point to. Don't rename one
> without updating the other, that mismatch is what broke deploys before.

## Local setup

```bash
npm install
cp .env.example .env
# edit .env and paste your real OPENAI_API_KEY
npm start
```

Server runs on `http://localhost:3000` by default. Health check: `GET /`.

## Deploying on Render

1. New → Web Service → connect this GitHub repo.
2. Build command: `npm install`
3. Start command: `npm start`
4. Environment → add `OPENAI_API_KEY` = your real OpenAI secret key.
5. Deploy. Render will give you a URL like `https://drcv.onrender.com`.
6. Put that exact URL into `CFG.BACKEND` in `call.html` in the `landing` repo.

Render's free tier spins the service down when idle, so the first call
after inactivity may take ~30–60s to wake up (the `GET /` health check
endpoint exists to help with this).

## Updating the Realtime model

This currently targets `gpt-realtime-2.1` on OpenAI's GA Realtime API. If
OpenAI ships a newer Realtime model, update the `model` field inside
`sessionConfig` in `serverr.js` — nothing else needs to change unless
OpenAI changes the API shape again.

## Env vars

See `.env.example`. Only `OPENAI_API_KEY` is required; `PORT` is optional
and Render sets it automatically in production.
