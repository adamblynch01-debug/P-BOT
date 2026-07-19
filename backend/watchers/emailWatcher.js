const Imap = require('imap');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const { supabase } = require('../db');

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

    // Watch for new emails in real time
    imapClient.on('mail', (numNew) => {
      console.log(`[EmailWatcher] ${numNew} new email(s) detected`);
      fetchUnread();
    });

    // Check existing unread on startup
    fetchUnread();
  });
}

function fetchUnread() {
  imapClient.search(['UNSEEN'], (err, results) => {
    if (err) {
      console.error('[EmailWatcher] Search error:', err.message);
      return;
    }
    if (!results || results.length === 0) {
      console.log('[EmailWatcher] No unread emails');
      return;
    }

    console.log(`[EmailWatcher] Processing ${results.length} unread email(s)`);
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

async function processEmail(email) {
  const from = (email.from?.text || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const textBody = (email.text || '');
  const htmlBody = (email.html || '');
  const fullText = textBody + ' ' + htmlBody;

  console.log(`[EmailWatcher] Email from: ${from} | subject: ${subject}`);

  // ─── Cash App Detection ──────────────────────────────
  if (
    from.includes('cash.app') ||
    from.includes('square.com') ||
    from.includes('squareup.com') ||
    subject.includes('sent you') ||
    subject.includes('payment received')
  ) {
    await handleCashApp(email, fullText);
  }

  // ─── PayPal Detection ────────────────────────────────
  if (
    from.includes('paypal.com') ||
    from.includes('@paypal') ||
    subject.includes('sent you') ||
    subject.includes('you received') ||
    subject.includes('payment received') ||
    subject.includes('money from')
  ) {
    await handlePayPal(email, fullText);
  }
}

async function handleCashApp(email, text) {
  try {
    // Multiple Cash App email patterns
    const amountPatterns = [
      /you received \$?([\d,]+\.?\d*)/i,
      /received \$?([\d,]+\.?\d*)/i,
      /\$([\d,]+\.?\d*)\s*(?:USD)?(?:\s*from)/i,
    ];

    let amount = null;
    for (const p of amountPatterns) {
      const m = text.match(p);
      if (m) { amount = parseFloat(m[1].replace(',', '')); break; }
    }

    const notePatterns = [
      /note[:\s]+([a-z0-9]+)/i,
      /for[:\s]+"?([a-z0-9]+)"?/i,
      /memo[:\s]+([a-z0-9]+)/i,
    ];

    let note = null;
    for (const p of notePatterns) {
      const m = text.match(p);
      if (m) { note = m[1].toLowerCase().trim(); break; }
    }

    console.log(`[EmailWatcher] Cash App — amount: $${amount}, note: ${note}`);
    if (!note) return;
    await matchAndConfirmOrder(note, amount, 'cashapp');
  } catch (err) {
    console.error('[EmailWatcher] Cash App parse error:', err.message);
  }
}

async function handlePayPal(email, text) {
  try {
    // Multiple PayPal email patterns
    const amountPatterns = [
      /you received \$?([\d,]+\.?\d*)\s*(?:USD)?/i,
      /sent you \$?([\d,]+\.?\d*)\s*(?:USD)?/i,
      /\$\s*([\d,]+\.?\d*)\s*USD/i,
      /amount[:\s]+\$?([\d,]+\.?\d*)/i,
      /([\d,]+\.?\d*)\s*USD/i,
    ];

    let amount = null;
    for (const p of amountPatterns) {
      const m = text.match(p);
      if (m) { amount = parseFloat(m[1].replace(',', '')); break; }
    }

    // PayPal note patterns — "Note from Name: noteword"
    const notePatterns = [
      /note from[^:]+:\s*([a-z0-9]+)/i,
      /what.s this for\??\s*:?\s*([a-z0-9]+)/i,
      /note[:\s]+([a-z0-9]+)/i,
      /message[:\s]+"?([a-z0-9]+)"?/i,
      /memo[:\s]+([a-z0-9]+)/i,
    ];

    let note = null;
    for (const p of notePatterns) {
      const m = text.match(p);
      if (m) { note = m[1].toLowerCase().trim(); break; }
    }

    console.log(`[EmailWatcher] PayPal — amount: $${amount}, note: ${note}`);
    if (!note) return;
    await matchAndConfirmOrder(note, amount, 'paypal');
  } catch (err) {
    console.error('[EmailWatcher] PayPal parse error:', err.message);
  }
}

async function matchAndConfirmOrder(note, amount, method) {
  try {
    console.log(`[EmailWatcher] Looking for pending ${method} order with note: ${note}`);

    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('payment_note', note)
      .eq('payment_method', method)
      .eq('status', 'pending')
      .single();

    if (error || !order) {
      console.warn(`[EmailWatcher] No pending ${method} order for note: ${note}`);
      return;
    }

    console.log(`[EmailWatcher] Found order ${order.id} — total: $${order.total}, received: $${amount}`);

    // Allow $1 tolerance for rounding
    if (amount && Math.abs(amount - order.total) > 1.00) {
      console.warn(`[EmailWatcher] Amount mismatch — expected $${order.total}, got $${amount}`);
      return;
    }

    await axios.post(`http://localhost:${process.env.PORT || 3000}/api/orders/confirm`, {
      secret: process.env.API_SECRET,
      order_id: order.id,
      amount_received: amount,
      method,
    });

    console.log(`[EmailWatcher] ✅ Order ${order.id} confirmed via ${method}!`);
  } catch (err) {
    console.error('[EmailWatcher] Match/confirm error:', err.message);
  }
}

module.exports = { start };
