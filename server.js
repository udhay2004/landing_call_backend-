/**
 * Comply Globally — Dr. CV Voice Backend
 * ─────────────────────────────────────────────────────
 * Serves two purposes:
 *   1. POST /session → mints an OpenAI Realtime ephemeral token
 *      and returns it to the browser so WebRTC can connect directly
 *      to OpenAI (browser ↔ OpenAI, audio never touches this server).
 *   2. GET /         → health-check / keep-alive for Render.
 *
 * ENV VARS required on Render:
 *   OPENAI_API_KEY   — your OpenAI secret key (NOT Anthropic)
 *
 * Optional:
 *   PORT             — defaults to 3000
 */

import express from 'express';
import cors    from 'cors';

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Middleware ── */
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
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

app.listen(PORT, () => {
  console.log(`Comply Globally Dr.CV proxy → port ${PORT}`);
});
