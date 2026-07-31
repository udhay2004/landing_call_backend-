/**
 * Comply Globally — Dr. CV Voice Backend
 * ─────────────────────────────────────────────────────
 * Serves:
 *   1. POST /session     → mints an OpenAI Realtime ephemeral token.
 *   2. POST /lead        → creates a lead record (source of truth for
 *                           leadId/sessionId), called right after the
 *                           landing page form is submitted.
 *   3. POST /consent     → records the visitor's yes/no answer to
 *                           "connect me with Dr. CV now?". On "no", emails
 *                           a resumable link to the address they gave.
 *   4. POST /transcript  → appends live call turns and, at the end of the
 *                           call, generates a structured summary (key points,
 *                           concerns, services discussed, next steps) via
 *                           Claude so every completed call is CRM-ready —
 *                           no scoring/threshold, every lead shows up.
 *   5. GET  /             → health-check / keep-alive.
 *
 * ENV VARS required:
 *   OPENAI_API_KEY    — your OpenAI secret key (NOT Anthropic), for the Realtime session
 *   MONGODB_URI       — connection string for lead/transcript storage
 *   ANTHROPIC_API_KEY — used to generate the structured conversation summary
 *
 * Optional:
 *   PORT               — defaults to 3000
 *   MONGODB_DB         — defaults to "drcv"
 *   FRONTEND_ORIGIN    — your landing page's origin, locks down CORS (defaults to "*")
 *   FRONTEND_URL       — your landing page's base URL, used to build the resume link
 *   SMTP_HOST/PORT/SECURE/USER/PASS — outgoing mail for the resume link + new-lead alerts
 *   MAIL_FROM          — "from" address for both emails (defaults to SMTP_USER)
 *   ADMIN_NOTIFY_EMAIL — where new-lead alerts get sent once a call completes (skipped if unset)
 */

import express from 'express';
import cors    from 'cors';
import { getDb, leadsCollection } from './db.js';
import { sendResumeEmail, sendNewLeadAlert } from './mailer.js';
import { summarizeConversation } from './summarize.js';

const app  = express();
const PORT = process.env.PORT || 3000;

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ── Middleware ── */
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Admin-Key'],
}));
app.use(express.json());

/* ── Health check (also wakes Render from sleep) ── */
app.get('/', (_req, res) => {
  res.json({ status: 'Dr. CV proxy running', ts: new Date().toISOString() });
});

/**
 * POST /session
 *
 * Body (optional JSON):
 *   { systemPrompt: string, voice: string }
 *
 * Mints a short-lived OpenAI Realtime ephemeral token via
 * POST https://api.openai.com/v1/realtime/sessions
 * and returns the full response to the browser.
 *
 * The browser then uses `client_secret.value` as the Bearer token
 * for its WebRTC SDP exchange directly with OpenAI.
 *
 * Note: the system prompt / voice / VAD config are set here so the
 * browser never needs to hold the real API key.
 */
app.post('/session', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not set on server' });
  }

  const { systemPrompt = '', voice = 'marin' } = req.body || {};

  // GA Realtime API session shape (the old beta "sessions" endpoint and
  // flat config shape were shut down on 2026-05-12).
  const sessionConfig = {
    session: {
      type: 'realtime',
      model: 'gpt-realtime-2.1',
      instructions: systemPrompt || 'You are a helpful assistant.',
      audio: {
        input: {
          transcription: { model: 'whisper-1' },
          turn_detection: {
            type:                 'server_vad',
            threshold:            0.45,
            prefix_padding_ms:    400,
            silence_duration_ms:  1200,
            create_response:      true,
            interrupt_response:   true,
          },
        },
        output: { voice },
      },
    },
  };

  try {
    const oaiRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(sessionConfig),
    });

    if (!oaiRes.ok) {
      const errText = await oaiRes.text();
      console.error('OpenAI session error:', oaiRes.status, errText);
      return res.status(oaiRes.status).json({ error: errText });
    }

    // GA response shape: { value: "ek_...", expires_at, session: {...} }
    const data = await oaiRes.json();
    return res.json(data);

  } catch (err) {
    console.error('Session proxy error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /lead
 *
 * Body: { name, email, phone, company, country, stage }
 *
 * Creates the lead record — this server is the source of truth for
 * leadId/sessionId from here on, so the same IDs flow through the
 * consent step, the call, and the transcript.
 */
app.post('/lead', async (req, res) => {
  const { name, email, phone, company, country, stage } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  const lead = {
    leadId:    newId('l'),
    sessionId: newId('s'),
    name, email, phone: phone || '', company: company || '',
    country: country || '', stage: stage || '',
    consent: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
    transcript: [],
    summary: null,
    completedAt: null,
  };

  try {
    const db = await getDb();
    await leadsCollection(db).insertOne(lead);
    return res.json({ leadId: lead.leadId, sessionId: lead.sessionId });
  } catch (err) {
    console.error('Lead create error:', err.message);
    return res.status(500).json({ error: 'Could not save lead' });
  }
});

/**
 * POST /consent
 *
 * Body: { leadId, sessionId, consent: 'yes' | 'no' }
 *
 * Records the visitor's answer to "connect me with Dr. CV now?".
 * On "no", emails them a resumable link to the call carrying their info.
 */
app.post('/consent', async (req, res) => {
  const { leadId, sessionId, consent } = req.body || {};
  if (!leadId || !sessionId || !['yes', 'no'].includes(consent)) {
    return res.status(400).json({ error: 'leadId, sessionId and consent (yes|no) are required' });
  }

  try {
    const db = await getDb();
    const result = await leadsCollection(db).findOneAndUpdate(
      { leadId, sessionId },
      { $set: { consent, consentAt: new Date(), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    const lead = result.value || result; // driver version differences
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    if (consent === 'no') {
      sendResumeEmail(lead).catch(err => console.error('Resume email failed:', err.message));
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('Consent update error:', err.message);
    return res.status(500).json({ error: 'Could not record consent' });
  }
});

/**
 * POST /transcript
 *
 * Called repeatedly during a call, and once more at the end.
 *
 * Mid-call body:  { leadId, sessionId, turn: { role, text, n, ts } }
 * End-of-call:    { leadId, sessionId, complete: true, duration, turnCount }
 *
 * At completion, generates a structured summary from the full stored
 * transcript (key points, concerns, services discussed, next steps) via
 * Claude, and emails a new-lead alert. No scoring/threshold — every
 * completed call becomes a reviewable lead in the CRM.
 */
app.post('/transcript', async (req, res) => {
  const { leadId, sessionId, turn, complete, duration, turnCount } = req.body || {};
  if (!leadId || !sessionId) {
    return res.status(400).json({ error: 'leadId and sessionId are required' });
  }

  try {
    const db = await getDb();
    const col = leadsCollection(db);

    if (turn) {
      await col.updateOne(
        { leadId, sessionId },
        { $push: { transcript: turn }, $set: { updatedAt: new Date() } },
        { upsert: true }
      );
      return res.json({ ok: true });
    }

    if (complete) {
      const existing = await col.findOne({ leadId, sessionId });
      const summary = await summarizeConversation(existing?.transcript || []);

      const result = await col.findOneAndUpdate(
        { leadId, sessionId },
        { $set: { duration, turnCount, summary, completedAt: new Date(), updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      const lead = result.value || result;

      if (lead) {
        sendNewLeadAlert(lead).catch(err => console.error('New lead alert failed:', err.message));
      }
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Provide either turn or complete' });
  } catch (err) {
    console.error('Transcript update error:', err.message);
    return res.status(500).json({ error: 'Could not save transcript' });
  }
});

/**
 * GET /lead/:leadId — for internal/CRM use only, gated by ADMIN_API_KEY.
 * Pass the key as header X-Admin-Key.
 */
app.get('/lead/:leadId', async (req, res) => {
  const key = process.env.ADMIN_API_KEY;
  if (key && req.headers['x-admin-key'] !== key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const db = await getDb();
    const lead = await leadsCollection(db).findOne({ leadId: req.params.leadId });
    if (!lead) return res.status(404).json({ error: 'Not found' });
    return res.json(lead);
  } catch (err) {
    console.error('Lead fetch error:', err.message);
    return res.status(500).json({ error: 'Could not fetch lead' });
  }
});

app.listen(PORT, () => {
  console.log(`Comply Globally Dr.CV proxy → port ${PORT}`);
});
