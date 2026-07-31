/**
 * Mailer — sends the "talk to Dr. CV whenever you're ready" resume link,
 * and an internal alert when a call scores hot enough for human follow-up.
 *
 * Uses plain SMTP via nodemailer so it works with Zoho, Gmail, or any
 * provider — set SMTP_HOST/PORT/USER/PASS in the environment.
 */
import nodemailer from 'nodemailer';

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587/STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

function buildResumeLink(lead) {
  const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  const params = new URLSearchParams({
    name:      lead.name    || '',
    email:     lead.email   || '',
    company:   lead.company || '',
    country:   lead.country || '',
    stage:     lead.stage   || '',
    leadId:    lead.leadId,
    sessionId: lead.sessionId,
  });
  return `${base}/call.html?${params.toString()}`;
}

export async function sendResumeEmail(lead) {
  const t = getTransporter();
  if (!t) {
    console.warn('SMTP not configured — skipping resume email for', lead.email);
    return;
  }
  const link = buildResumeLink(lead);
  const firstName = (lead.name || '').split(' ')[0] || 'there';

  await t.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: lead.email,
    subject: 'Talk to Dr. CV whenever you\u2019re ready',
    html: `
      <p>Hi ${firstName},</p>
      <p>Thanks for reaching out to Comply Globally. Whenever you're ready,
      you can have a live conversation with <strong>Dr. CV</strong>, our
      compliance champion, using the link below \u2014 no scheduling needed:</p>
      <p><a href="${link}">${link}</a></p>
      <p>It carries your details from the form, so the conversation picks up
      right where you left off.</p>
      <p>\u2014 Comply Globally</p>
    `,
  });
}

export async function sendNewLeadAlert(lead) {
  const t = getTransporter();
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!t || !to) return;

  const s = lead.summary || {};
  const bullets = (arr) => (arr && arr.length)
    ? `<ul>${arr.map(x => `<li>${x}</li>`).join('')}</ul>`
    : '<p style="color:#888">None noted</p>';

  await t.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: `New Dr. CV conversation: ${lead.name || 'Unknown'} (${lead.company || 'no company'})`,
    html: `
      <p><strong>${lead.name || ''}</strong> \u00b7 ${lead.email || ''} \u00b7 ${lead.phone || ''}</p>
      <p>Country: ${lead.country || 'n/a'} \u2014 Stage: ${lead.stage || 'n/a'}</p>
      <p>${s.summary || 'No summary generated.'}</p>
      <p><strong>Key points</strong></p>${bullets(s.keyPoints)}
      <p><strong>Concerns raised</strong></p>${bullets(s.concernsRaised)}
      <p><strong>Services discussed</strong></p>${bullets(s.servicesDiscussed)}
      <p><strong>Suggested next step:</strong> ${s.nextSteps || 'n/a'}</p>
      <p><strong>Sentiment:</strong> ${s.sentiment || 'n/a'}</p>
      <p>Lead ID: ${lead.leadId}</p>
    `,
  });
}
