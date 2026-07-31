// Sending mail over HTTPS instead of SMTP.
//
// Why this exists: our host does not allow outbound SMTP. Port 587 and port
// 465 both time out from inside the container, while IMAP on 993 to the very
// same Google servers connects fine — so it is not the credentials, not DNS
// and not Google refusing us, it is the platform blocking the SMTP ports.
// That is not something a transport option can work around: enabling email
// 2FA failed for exactly this reason, and no amount of retrying would have
// helped. Port 443 is obviously open (the whole API runs on it), so the fix
// is to hand the message to a provider's HTTPS API and let them do the SMTP.
//
// Two providers are supported because they ask different things of you:
//
//   RESEND_API_KEY   — resend.com. Wants a domain you control (uhservices.xyz)
//                      verified by DNS. That buys properly aligned SPF/DKIM,
//                      so mail lands in inboxes rather than spam, and the From
//                      becomes your own domain instead of a gmail address.
//   BREVO_API_KEY    — brevo.com. Verifies a single sender address by clicking
//                      a link, no DNS at all. Faster to switch on; a From at
//                      gmail.com cannot align with DKIM, so deliverability is
//                      the price.
//
// Set one. Whichever key is present is the one used; Resend wins if both are.
// With neither set, this returns null and the caller falls back to SMTP, so a
// deployment on a host that does permit SMTP keeps working untouched.
'use strict';

const axios = require('axios');

function env(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : null;
}

// Accepts either a bare address or a `Display Name <addr@host>` header and
// splits it, because Brevo wants the two apart while Resend takes the header
// whole. Anything unparseable is treated as a bare address rather than
// dropped — a malformed display name must not cost us the email.
function splitAddress(value) {
  const s = String(value || '').trim();
  const m = s.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].replace(/^"|"$/g, '') || null, email: m[2].trim() };
  return { name: null, email: s };
}

// One recipient per call is all this codebase ever sends, but both APIs take a
// list and normalising here keeps the two senders identical at the call site.
function recipients(to) {
  return (Array.isArray(to) ? to : String(to || '').split(','))
    .map(s => String(s).trim()).filter(Boolean);
}

// Providers answer failures in the body, not just the status code, and axios
// only throws on the status. A 200 carrying an error is still a failure, and
// silently treating it as sent is how a customer ends up waiting for a code
// that was never accepted.
function assertAccepted(provider, res) {
  const body = res && res.data;
  if (body && typeof body === 'object' && body.error) {
    const msg = typeof body.error === 'string' ? body.error : (body.error.message || JSON.stringify(body.error));
    throw new Error(`${provider} rejected the message: ${msg}`);
  }
}

// axios reports a rejection as "Request failed with status code 422" and keeps
// the useful part in the response body. That default cost a debugging round:
// the provider had said precisely what was wrong with the message and the log
// showed only the number. Everything these APIs return here is a diagnostic —
// a domain that is not verified, a malformed From — never a secret.
async function post(provider, url, data, headers) {
  try {
    const res = await axios.post(url, data, { headers, timeout: 15000 });
    assertAccepted(provider, res);
    return res.data || {};
  } catch (err) {
    const body = err.response && err.response.data;
    const detail = body && typeof body === 'object'
      ? (body.message || (body.error && (body.error.message || body.error)) || JSON.stringify(body))
      : (body || err.message);
    const status = err.response ? ` (HTTP ${err.response.status})` : '';
    throw new Error(`${provider}${status}: ${detail}`);
  }
}

const PROVIDERS = [
  {
    label: 'resend',
    key: 'RESEND_API_KEY',
    async send(apiKey, msg) {
      const data = await post('Resend', 'https://api.resend.com/emails', {
        from: msg.from,
        to: recipients(msg.to),
        subject: msg.subject,
        html: msg.html,
      }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });
      return data.id;
    },
  },
  {
    label: 'brevo',
    key: 'BREVO_API_KEY',
    async send(apiKey, msg) {
      const from = splitAddress(msg.from);
      const data = await post('Brevo', 'https://api.brevo.com/v3/smtp/email', {
        sender: from.name ? { name: from.name, email: from.email } : { email: from.email },
        to: recipients(msg.to).map(email => ({ email })),
        subject: msg.subject,
        htmlContent: msg.html,
      }, { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' });
      return data.messageId;
    },
  },
];

// The address the provider sends as. MAIL_FROM is the one to set for an HTTP
// provider — SMTP_FROM is honoured too so a deployment that already had one
// does not need a second variable saying the same thing.
function fromAddress() {
  return env('MAIL_FROM') || env('SMTP_FROM') || null;
}

// Returns a mailer shaped like a nodemailer transport — it answers sendMail —
// so utils/email.js can hold either kind without caring which. null means no
// HTTP provider is configured and SMTP should be tried instead.
function httpMailer(defaultFrom) {
  const from = fromAddress() || defaultFrom || null;
  for (const p of PROVIDERS) {
    const apiKey = env(p.key);
    if (!apiKey) continue;
    if (!from) {
      // Without a From there is nothing to send as, and the provider would
      // reject every message with an error nobody is reading. Say so once,
      // here, where the reason is obvious.
      console.error(`[Email] ${p.key} is set but no sender address — set MAIL_FROM to the address you verified with ${p.label}`);
      return null;
    }
    return {
      label: p.label,
      from,
      // The signature nodemailer callers already use: { from, to, subject, html }.
      sendMail: msg => p.send(apiKey, Object.assign({}, msg, { from: msg.from || from })),
    };
  }
  return null;
}

module.exports = { httpMailer, splitAddress, recipients, __test__: { PROVIDERS, assertAccepted } };
