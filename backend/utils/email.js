// Outbound order-confirmation email over the SAME Gmail account the
// emailWatcher already reads from (GMAIL_USER / GMAIL_PASSWORD, an app
// password). Sending is best-effort: if creds are missing or SMTP fails we
// log and move on — a delivery must never be blocked on an email.
'use strict';

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* dependency added in package.json */ }

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!nodemailer || !process.env.GMAIL_USER || !process.env.GMAIL_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASSWORD },
  });
  return transporter;
}

function money(n) { return '$' + (Number(n) || 0).toFixed(2); }

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
  const tx = getTransporter();
  if (!tx) { console.warn('[Email] Skipped — SMTP not configured'); return false; }
  if (!order || !order.email) { console.warn('[Email] Skipped — no recipient'); return false; }

  const storeName = process.env.STORE_NAME || 'Ghost Store';
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
      from: `${storeName} <${process.env.GMAIL_USER}>`,
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
  const tx = getTransporter();
  if (!tx) { console.warn('[Email] Login code skipped — SMTP not configured'); return false; }
  if (!to) { console.warn('[Email] Login code skipped — no recipient'); return false; }

  const storeName = process.env.STORE_NAME || 'Ghost Store';
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
      from: `${storeName} <${process.env.GMAIL_USER}>`,
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
