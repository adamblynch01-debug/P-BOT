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

async function processEmail(email) {
  const from = (email.from?.text || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  // Use plain text only — HTML has CSS noise like "0px" that breaks parsing
  const text = (email.text || '');

  console.log(`[EmailWatcher] Checking: from="${from}" | subject="${subject}"`);

  if (
    from.includes('cash.app') ||
    from.includes('square.com') ||
    from.includes('squareup.com') ||
    subject.includes('sent you') ||
    subject.includes('payment received')
  ) {
    await handleCashApp(email, text);
  }

  if (
    from.includes('paypal.com') ||
    from.includes('@paypal') ||
    subject.includes('sent you') ||
    subject.includes('you received') ||
    subject.includes('payment received')
  ) {
    await handlePayPal(email, text);
  }
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

    // Note is a single lowercase word 4-12 chars, no numbers only
    const notePatterns = [
      /note[:\s]+([a-z]{4,12})/i,
      /for[:\s]+"?([a-z]{4,12})"?/i,
      /memo[:\s]+([a-z]{4,12})/i,
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
    console.log('[EmailWatcher] PayPal plain text:');
    console.log(text.substring(0, 500));

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
        const match = nextLine.match(/^([a-z][a-z0-9]{3,15})$/i);
        if (match) {
          note = match[1].toLowerCase();
          console.log(`[EmailWatcher] Found note on next line: "${note}"`);
          break;
        }
      }
    }

    // Fallback: scan all pending orders and match note in text
    if (!note) {
      await findNoteInText(text, amount, 'paypal');
      return;
    }

    console.log(`[EmailWatcher] PayPal — amount: $${amount}, note: ${note}`);
    await matchAndConfirmOrder(note, amount, 'paypal');
  } catch (err) {
    console.error('[EmailWatcher] PayPal parse error:', err.message);
  }
}

async function findNoteInText(text, amount, method) {
  try {
    const { rows: orders } = await query(
      `SELECT id, payment_note, total_cents FROM orders
       WHERE guild_id = $1 AND payment_method = $2 AND status = 'waiting'`,
      [GUILD_ID, method]
    );

    if (!orders.length) return;

    for (const order of orders) {
      if (order.payment_note && text.toLowerCase().includes(order.payment_note.toLowerCase())) {
        console.log(`[EmailWatcher] Found note "${order.payment_note}" in email text!`);
        await matchAndConfirmOrder(order.payment_note, amount, method);
        return;
      }
    }
    console.warn('[EmailWatcher] Could not find any pending order note in email');
  } catch (err) {
    console.error('[EmailWatcher] findNoteInText error:', err.message);
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
    console.log(`[EmailWatcher] Found order ${order.id} — total: $${total}, received: $${amount}`);

    if (amount && Math.abs(amount - total) > 1.00) {
      console.warn(`[EmailWatcher] Amount mismatch — expected $${total}, got $${amount}`);
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
