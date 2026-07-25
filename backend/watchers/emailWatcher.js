const Imap = require('imap');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const { query } = require('../db');

const GUILD_ID = process.env.GUILD_ID;

let imapClient = null;
let failCount = 0;
let reconnectTimer = null;
const MAX_FAILS = 5;

function start() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASSWORD) {
    console.warn('[EmailWatcher] Gmail credentials not set — disabled');
    return;
  }
  failCount = 0;
  connectImap();
  console.log('[EmailWatcher] Started');
}

function connectImap() {
  if (failCount >= MAX_FAILS) {
    console.error('[EmailWatcher] Too many failures — stopped');
    return;
  }

  imapClient = new Imap({
    user: process.env.GMAIL_USER,
    password: process.env.GMAIL_PASSWORD,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 15000,
    connTimeout: 15000,
    keepalive: {
      interval: 10000,
      idleInterval: 300000,
      forceNoop: true,
    },
  });

  imapClient.once('ready', () => {
    failCount = 0;
    console.log('[EmailWatcher] IMAP connected');
    openInbox();
  });

  imapClient.once('error', (err) => {
    failCount++;
    console.error(`[EmailWatcher] IMAP error (${failCount}/${MAX_FAILS}):`, err.message);
    scheduleReconnect(30000);
  });

  imapClient.once('end', () => {
    console.log('[EmailWatcher] IMAP disconnected — reconnecting...');
    scheduleReconnect(10000);
  });

  imapClient.connect();
}

function scheduleReconnect(delay) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (failCount < MAX_FAILS) {
    reconnectTimer = setTimeout(connectImap, delay);
  }
}

function openInbox() {
  imapClient.openBox('INBOX', false, (err) => {
    if (err) {
      console.error('[EmailWatcher] Failed to open inbox:', err.message);
      return;
    }
    console.log('[EmailWatcher] Inbox open — watching for payments');
    imapClient.on('mail', (numNew) => {
      console.log(`[EmailWatcher] ${numNew} new email(s) — checking for payments`);
      fetchRecent();
    });
    fetchRecent();
  });
}

function fetchRecent() {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mm = months[today.getMonth()];
  const yyyy = today.getFullYear();
  const sinceDate = `${dd}-${mm}-${yyyy}`;

  imapClient.search(['UNSEEN', ['SINCE', sinceDate]], (err, results) => {
    if (err || !results || results.length === 0) return;
    console.log(`[EmailWatcher] Found ${results.length} unread email(s) from today`);

    const fetch = imapClient.fetch(results, { bodies: '' });
    fetch.on('message', (msg) => {
      msg.on('body', (stream) => {
        simpleParser(stream, async (err, parsed) => {
          if (err) return;
          await processEmail(parsed);
        });
      });
      msg.once('attributes', (attrs) => {
        imapClient.addFlags(attrs.uid, ['\\Seen'], () => {});
      });
    });
    fetch.once('error', (err) => {
      console.error('[EmailWatcher] Fetch error:', err.message);
    });
  });
}

// ─── Sender verification ─────────────────────────────────
// This is the ONLY thing that decides whether an email is treated as a payment
// notification. A From line is trivially forged and `subject.includes(...)`
// let any stranger's email reach the confirm path, so neither is trusted here.
//
// Gmail has already run SPF/DKIM/DMARC by the time we fetch the message over
// IMAP and stamps its verdict into an Authentication-Results header. That
// verdict is the trustworthy signal. Only the FIRST such header is read:
// Gmail prepends its own on receipt, so anything below it was supplied by the
// sender and is attacker-controlled.

const DEFAULT_CASHAPP_DOMAINS = ['cash.app', 'square.com', 'squareup.com'];
const DEFAULT_PAYPAL_DOMAINS = ['paypal.com'];

function envDomains(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : fallback;
}

// Exact domain or a subdomain of it (e.g. "e.paypal.com" for "paypal.com").
function domainMatches(domain, allowed) {
  if (!domain) return false;
  const d = String(domain).toLowerCase();
  return allowed.some(a => d === a || d.endsWith('.' + a));
}

function verifiedSenderDomain(parsed) {
  const header = (parsed.headerLines || []).find(h => h.key === 'authentication-results');
  if (!header) return null;

  const body = String(header.line).replace(/^authentication-results:\s*/i, '');
  // The verdict must be Gmail's own, not one the sender wrote themselves.
  if (!/^mx\.google\.com\b/i.test(body.split(';')[0].trim())) return null;

  const dmarc = body.match(/dmarc=pass[^;]*?header\.from=([a-z0-9.-]+)/i);
  if (dmarc) return dmarc[1].toLowerCase();

  const dkim = body.match(/dkim=pass[^;]*?header\.(?:i=@|d=)([a-z0-9.-]+)/i);
  if (dkim) return dkim[1].toLowerCase();

  return null;
}

async function processEmail(email) {
  const subject = email.subject || '';
  // Plain text only — HTML carries CSS noise like "0px" that breaks parsing.
  const text = (email.text || '');

  const verified = verifiedSenderDomain(email);
  if (!verified) {
    console.warn(`[EmailWatcher] Ignored "${subject}" — no Gmail DMARC/DKIM pass on the sender`);
    return;
  }

  if (domainMatches(verified, envDomains('CASHAPP_EMAIL_DOMAINS', DEFAULT_CASHAPP_DOMAINS))) {
    await handleCashApp(email, text);
    return;
  }
  if (domainMatches(verified, envDomains('PAYPAL_EMAIL_DOMAINS', DEFAULT_PAYPAL_DOMAINS))) {
    await handlePayPal(email, text);
    return;
  }

  console.log(`[EmailWatcher] Ignored "${subject}" — ${verified} is not a payment provider domain`);
}

async function handleCashApp(email, text) {
  try {
    const amountPatterns = [
      /you received \$?([\d,]+\.?\d*)/i,
      /received \$?([\d,]+\.?\d*)/i,
    ];
    let amount = null;
    for (const p of amountPatterns) {
      const m = text.match(p);
      if (m) { amount = parseFloat(m[1].replace(',', '')); break; }
    }

    // Note is a single word: letters then the 4-digit suffix generateNote adds.
    const notePatterns = [
      /note[:\s]+([a-z]{4,12}\d{4})/i,
      /for[:\s]+"?([a-z]{4,12}\d{4})"?/i,
      /memo[:\s]+([a-z]{4,12}\d{4})/i,
    ];
    let note = null;
    for (const p of notePatterns) {
      const m = text.match(p);
      if (m) { note = m[1].toLowerCase().trim(); break; }
    }

    if (!note) {
      console.warn('[EmailWatcher] Cash App email had no parseable note — ignoring');
      return;
    }
    console.log(`[EmailWatcher] Cash App — amount: $${amount}, note: ${note}`);
    await matchAndConfirmOrder(note, amount, 'cashapp');
  } catch (err) {
    console.error('[EmailWatcher] Cash App parse error:', err.message);
  }
}

async function handlePayPal(email, text) {
  try {
    // Amount
    const amountPatterns = [
      /sent you \$?([\d,]+\.?\d*)\s*(?:USD)?/i,
      /you received \$?([\d,]+\.?\d*)\s*(?:USD)?/i,
      /\$\s*([\d,]+\.?\d*)\s*USD/i,
      /amount[:\s]+\$?([\d,]+\.?\d*)/i,
    ];
    let amount = null;
    for (const p of amountPatterns) {
      const m = text.match(p);
      if (m) { amount = parseFloat(m[1].replace(',', '')); break; }
    }

    // Note — PayPal format has note on the LINE AFTER "Note from Name"
    let note = null;

    // Split into lines and find the note
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().startsWith('note from') || lines[i].toLowerCase() === 'note') {
        // Note text is on the next line
        const nextLine = lines[i + 1] || '';
        const match = nextLine.match(/^([a-z]{4,12}\d{4})$/i);
        if (match) {
          note = match[1].toLowerCase();
          break;
        }
      }
    }

    if (!note) {
      console.warn('[EmailWatcher] PayPal email had no parseable note — ignoring');
      return;
    }

    console.log(`[EmailWatcher] PayPal — amount: $${amount}, note: ${note}`);
    await matchAndConfirmOrder(note, amount, 'paypal');
  } catch (err) {
    console.error('[EmailWatcher] PayPal parse error:', err.message);
  }
}

async function matchAndConfirmOrder(note, amount, method) {
  try {
    console.log(`[EmailWatcher] Looking for pending ${method} order with note: ${note}`);

    const { rows } = await query(
      `SELECT * FROM orders
       WHERE guild_id = $1 AND payment_note = $2 AND payment_method = $3 AND status = 'waiting'
       LIMIT 1`,
      [GUILD_ID, note, method]
    );
    const order = rows[0];

    if (!order) {
      console.warn(`[EmailWatcher] No pending ${method} order for note: ${note}`);
      return;
    }

    const total = order.total_cents / 100;

    // An unparseable amount used to fall straight through this check (`amount`
    // was null, so the guard was skipped and the order confirmed), which made
    // omitting the figure easier than forging it. No amount now means no
    // confirmation — the order waits for a human instead.
    if (!Number.isFinite(amount) || amount <= 0) {
      console.warn(`[EmailWatcher] Order ${order.id} NOT confirmed — no amount parsed from the ${method} email`);
      return;
    }

    // Underpayment is rejected; overpayment is accepted and noted, since
    // refusing money the customer already sent just creates a support ticket.
    const tolerance = parseFloat(process.env.EMAIL_UNDERPAY_TOLERANCE_USD || '0.01');
    if (amount + tolerance < total) {
      console.warn(`[EmailWatcher] Order ${order.id} underpaid — expected $${total}, got $${amount}`);
      await query(
        `UPDATE orders SET status = 'underpaid', amount_received_cents = $1 WHERE id = $2 AND status = 'waiting'`,
        [Math.round(amount * 100), order.id]
      ).catch(() => {});
      return;
    }
    if (amount > total) {
      console.warn(`[EmailWatcher] Order ${order.id} overpaid — expected $${total}, got $${amount}`);
    }

    await axios.post(`http://localhost:${process.env.PORT || 3000}/api/orders/confirm`, {
      secret: process.env.API_SECRET,
      order_id: order.id,
      amount_received: amount,
      method,
    });

    console.log(`[EmailWatcher] Order ${order.id} confirmed via ${method} — $${amount}`);
  } catch (err) {
    console.error('[EmailWatcher] Match/confirm error:', err.message);
  }
}

module.exports = { start };
module.exports.__test__ = { processEmail, verifiedSenderDomain, domainMatches };
