/**
 * Summarizer — turns a raw call transcript into a structured summary the
 * CRM can actually display: key points, concerns, services discussed,
 * suggested next step, and overall sentiment. Runs server-side (right after
 * the call ends) so the Anthropic key never touches the browser.
 *
 * ENV: ANTHROPIC_API_KEY
 */

const SYSTEM_PROMPT = `You are summarizing a voice conversation between a visitor and "Dr. CV", a compliance/business-expansion advisory AI for Comply Globally. You will be given the full transcript as alternating user/ai turns.

Return ONLY a JSON object (no markdown fences, no preamble) with this exact shape:
{
  "summary": "2-3 sentence plain-English overview of the conversation",
  "keyPoints": ["short bullet", "short bullet", ...],
  "concernsRaised": ["short bullet", ...],
  "servicesDiscussed": ["short bullet", ...],
  "nextSteps": "1-2 sentence recommendation for what the sales team should do next",
  "sentiment": "positive" | "neutral" | "negative"
}

Keep every bullet short (under 15 words). If a section has nothing relevant, return an empty array for it. Base everything only on what's actually in the transcript — never invent details.`;

export async function summarizeConversation(transcript) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY not set — skipping summary generation');
    return null;
  }
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return null;
  }

  const body = transcript
    .sort((a, b) => (a.n || 0) - (b.n || 0) || (a.ts || 0) - (b.ts || 0))
    .map(t => `${t.role === 'ai' ? 'Dr. CV' : 'Visitor'}: ${t.text}`)
    .join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: body }],
      }),
    });

    if (!res.ok) {
      console.error('Anthropic summarize error:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const raw = (data.content || []).map(c => c.text || '').join('').trim();
    const cleaned = raw.replace(/^```json\s*|```$/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Summarize failed:', err.message);
    return null;
  }
}
