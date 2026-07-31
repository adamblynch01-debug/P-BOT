// Outbound store email: order confirmations and 2FA codes.
//
// This used to be hardwired to the SAME Gmail login the payment watcher reads
// (GMAIL_USER / GMAIL_PASSWORD), which forced the address customers see to be
// the address PayPal notifications land in. It now resolves its own account —
// see utils/mailAccounts.js — and only falls back to the Gmail pair when no
// SMTP_* vars are set, so an unconfigured deployment behaves as before.
//
// Order confirmations are best-effort: if creds are missing or SMTP fails we
// log and move on — a delivery must never be blocked on an email. Login codes
// are NOT (see sendLoginCode).
'use strict';

const { outboundAccount } = require('./mailAccounts');
const { httpMailer } = require('./mailHttp');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* dependency added in package.json */ }

let transporter = null;
let fromAddress = null;
let lastProbeFailedAt = 0;

// Enough to tell two routes apart in a log line, and nothing that is a secret.
function describe(cfg) {
  return `${cfg.host}:${cfg.port} ${cfg.secure ? 'implicit TLS' : 'STARTTLS'}`;
}

// The account can offer more than one port (see mailAccounts.js). Which of
// them is actually reachable is a property of the machine we happen to be
// running on, not of the configuration, so it is settled by connecting rather
// than by guessing: verify() opens the socket and authenticates without
// sending anything, and the first route that answers is kept for the life of
// the process. A route that fails is logged by name — that log is the only
// way to tell "the password is wrong" from "the port is blocked" after the
// fact, and the difference used to be invisible.
async function getTransporter() {
  if (transporter) return transporter;
  const acct = outboundAccount();

  // An HTTPS provider is tried first and needs no probing — there is one route
  // to it, port 443, and the whole API already depends on that port working.
  // It also takes precedence over SMTP deliberately: the only reason to set an
  // API key is that SMTP is unavailable here, so falling back to a transport
  // we know times out would just make every send wait for nothing.
  const http = httpMailer(acct && acct.from);
  if (http) {
    fromAddress = http.from;
    transporter = http;
    console.log(`[Email] Outbound via ${http.label} HTTPS API as ${http.from}`);
    return transporter;
  }

  if (!nodemailer) return null;
  if (!acct) return null;

  // Every candidate failing costs a connection timeout apiece. Without this,
  // a mail outage would make each send re-walk the whole list and drag every
  // caller down with it.
  if (Date.now() - lastProbeFailedAt < 60000) return null;

  fromAddress = acct.from;
  for (const cfg of acct.transports) {
    const tx = nodemailer.createTransport(cfg);
    try {
      await tx.verify();
      transporter = tx;
      console.log(`[Email] Outbound via ${acct.provider} as ${acct.from} — ${describe(cfg)}`);
      return transporter;
    } catch (err) {
      console.warn(`[Email] ${describe(cfg)} unusable: ${err.message}`);
      try { tx.close(); } catch { /* nothing to close */ }
    }
  }
  lastProbeFailedAt = Date.now();
  console.error('[Email] No usable SMTP route — outbound email is down. '
    + 'If every port timed out, this host blocks outbound SMTP: set RESEND_API_KEY '
    + 'or BREVO_API_KEY plus MAIL_FROM and it will send over HTTPS instead.');
  return null;
}

// The envelope From. Falls back to the transport's own login, which is what
// every provider requires anyway — a From that is not the authenticated
// mailbox is rejected outright by Gmail and lands in spam elsewhere.
function senderAddress() {
  return fromAddress || process.env.SMTP_FROM || process.env.SMTP_USER || process.env.GMAIL_USER || '';
}

// The configured sender may already be a full header — MAIL_FROM is naturally
// written as `Ghost Store <no-reply@uhservices.xyz>`. Wrapping that in another
// display name yields `Ghost Store <Ghost Store <no-reply@…>>`, which is not a
// valid address: Resend answers 422 and nothing is delivered. Only a bare
// address gets the store name attached.
function fromHeader(storeName) {
  const addr = senderAddress();
  return addr.includes('<') ? addr : `${storeName} <${addr}>`;
}

function money(n) { return '$' + (Number(n) || 0).toFixed(2); }

// One place for the customer-facing name, and one fallback. It used to default
// to 'Ghost Store' here while /health and routes/config.js defaulted to 'H8ED
// Shop', so an unset STORE_NAME would have made the store call itself two
// different things depending on which file answered.
function storeName_() {
  return process.env.STORE_NAME || 'H8ED Shop';
}

function renderGoodsHtml(goods) {
  if (!Array.isArray(goods) || !goods.length) return '';
  return goods.map(g => {
    const items = (g.items || []).map(i => `<div style="font-family:monospace;font-size:13px;color:#0ff;background:#04121a;padding:6px 10px;margin:4px 0;border:1px solid #0ff3;border-radius:4px;">${escapeHtml(i)}</div>`).join('');
    return `<div style="margin:14px 0;"><div style="font-weight:700;color:#fff;margin-bottom:4px;">${escapeHtml(g.product || 'Item')}</div>${items}</div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Sends the order-confirmation email. `order` is the DB row; `goods` is the
// delivered_goods array. Returns true if the email was handed to SMTP.
async function sendOrderConfirmation(order, goods) {
  const tx = await getTransporter();
  if (!tx) { console.warn('[Email] Skipped — no usable SMTP route'); return false; }
  if (!order || !order.email) { console.warn('[Email] Skipped — no recipient'); return false; }

  const storeName = storeName_();
  const total = (order.total_cents != null ? order.total_cents / 100 : 0);
  const goodsHtml = renderGoodsHtml(goods);

  const html = `
  <div style="background:#03040a;padding:28px;font-family:Arial,Helvetica,sans-serif;color:#c9d6e5;">
    <div style="max-width:560px;margin:0 auto;background:#080b16;border:1px solid #0ff3;border-radius:8px;overflow:hidden;">
      <div style="padding:20px 24px;border-bottom:1px solid #0ff2;">
        <div style="font-size:18px;letter-spacing:2px;color:#0ff;font-weight:700;">${escapeHtml(storeName.toUpperCase())}</div>
        <div style="font-size:12px;color:#5a7080;margin-top:2px;">Order Confirmation</div>
      </div>
      <div style="padding:22px 24px;">
        <p style="margin:0 0 14px;font-size:14px;">Thank you for your purchase. Your order has been confirmed and delivered.</p>
        <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:8px;">
          <tr><td style="color:#5a7080;padding:4px 0;">Order ID</td><td style="text-align:right;color:#fff;font-family:monospace;">#${escapeHtml(order.id)}</td></tr>
          <tr><td style="color:#5a7080;padding:4px 0;">Payment</td><td style="text-align:right;color:#fff;">${escapeHtml(String(order.payment_method || '').toUpperCase())}</td></tr>
          <tr><td style="color:#5a7080;padding:4px 0;">Total</td><td style="text-align:right;color:#0ff;font-weight:700;">${money(total)}</td></tr>
        </table>
        ${goodsHtml ? `<div style="border-top:1px solid #0ff2;margin-top:12px;padding-top:12px;"><div style="font-size:12px;color:#5a7080;letter-spacing:1px;margin-bottom:6px;">YOUR GOODS</div>${goodsHtml}</div>` : ''}
        <p style="margin:18px 0 0;font-size:12px;color:#5a7080;line-height:1.6;">Keep this email for your records. If you have any issues, open a ticket in our Discord.</p>
      </div>
      <div style="padding:14px 24px;border-top:1px solid #0ff2;font-size:11px;color:#3d5060;text-align:center;">${escapeHtml(storeName)} • Automated confirmation</div>
    </div>
  </div>`;

  try {
    await tx.sendMail({
      from: fromHeader(storeName),
      to: order.email,
      subject: `Order #${order.id} confirmed — ${storeName}`,
      html,
    });
    console.log(`[Email] Order confirmation sent to ${order.email}`);
    return true;
  } catch (err) {
    console.error('[Email] Send failed:', err.message);
    return false;
  }
}

// ─── Email second factor ─────────────────────────────────────────────────────
// Sends a 6-digit login code. Unlike the order confirmation, this one is NOT
// best-effort from the caller's point of view: if it doesn't send, the customer
// is staring at a code prompt for a code that never arrives, so it returns
// false and the route turns that into a real error instead of a silent wait.
//
// `purpose` distinguishes a login challenge from the enrolment check, because
// "here is a code someone asked for" reads very differently when you did not
// ask for it — the login copy has to say the password was already accepted.
async function sendLoginCode(to, code, purpose) {
  const tx = await getTransporter();
  if (!tx) { console.warn('[Email] Login code skipped — no usable SMTP route'); return false; }
  if (!to) { console.warn('[Email] Login code skipped — no recipient'); return false; }

  const storeName = storeName_();
  const isSetup = purpose === 'setup';
  const heading = isSetup ? 'Confirm Email 2FA' : 'Login Verification';
  const lead = isSetup
    ? 'Enter this code on the security page to turn on email two-factor authentication.'
    : 'Someone entered the correct password for your account and is being asked for a second factor. Enter this code to finish signing in.';

  const html = `
  <div style="background:#03040a;padding:28px;font-family:Arial,Helvetica,sans-serif;color:#c9d6e5;">
    <div style="max-width:460px;margin:0 auto;background:#080b16;border:1px solid #0ff3;border-radius:8px;overflow:hidden;">
      <div style="padding:20px 24px;border-bottom:1px solid #0ff2;">
        <div style="font-size:18px;letter-spacing:2px;color:#0ff;font-weight:700;">${escapeHtml(storeName.toUpperCase())}</div>
        <div style="font-size:12px;color:#5a7080;margin-top:2px;">${escapeHtml(heading)}</div>
      </div>
      <div style="padding:22px 24px;">
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">${escapeHtml(lead)}</p>
        <div style="font-family:monospace;font-size:30px;letter-spacing:10px;color:#0ff;background:#04121a;border:1px solid #0ff3;border-radius:6px;padding:16px;text-align:center;font-weight:700;">${escapeHtml(code)}</div>
        <p style="margin:16px 0 0;font-size:12px;color:#5a7080;line-height:1.6;">
          This code expires in 10 minutes and can be used once.
          ${isSetup ? '' : 'If this was not you, your password is no longer safe — change it as soon as you can.'}
        </p>
      </div>
      <div style="padding:14px 24px;border-top:1px solid #0ff2;font-size:11px;color:#3d5060;text-align:center;">${escapeHtml(storeName)} • Never share this code with anyone</div>
    </div>
  </div>`;

  try {
    await tx.sendMail({
      from: fromHeader(storeName),
      to,
      subject: `${code} is your ${storeName} ${isSetup ? 'confirmation' : 'login'} code`,
      html,
    });
    return true;
  } catch (err) {
    console.error('[Email] Login code send failed:', err.message);
    return false;
  }
}

module.exports = { sendOrderConfirmation, sendLoginCode };
