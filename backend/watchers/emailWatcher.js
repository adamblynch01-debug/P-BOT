const Imap = require('imap');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const { supabase } = require('../server');

let imapClient = null;

function start() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASSWORD) {
    console.warn('[EmailWatcher] Gmail credentials not set — email monitoring disabled');
    return;
  }

  connectImap();
  console.log('[EmailWatcher] Started');
}

function connectImap() {
  imapClient = new Imap({
    user: process.env.GMAIL_USER,
    password: process.env.GMAIL_PASSWORD,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  });

  imapClient.once('ready', () => {
    console.log('[EmailWatcher] IMAP connected');
    openInbox();
  });

  imapClient.once('error', (err) => {
    console.error('[EmailWatcher] IMAP error:', err.message);
    setTimeout(connectImap, 30000); // Reconnect in 30s
  });

  imapClient.once('end', () => {
    console.log('[EmailWatcher] IMAP disconnected — reconnecting...');
    setTimeout(connectImap, 10000);
  });

  imapClient.connect();
}

function openInbox() {
  imapClient.openBox('INBOX', false, (err, box) => {
    if (err) {
      console.error('[EmailWatcher] Failed to open inbox:', err.message);
      return;
    }

    // Listen for new emails in real time
    imapClient.on('mail', () => {
      fetchUnread();
    });

    // Also check on startup
    fetchUnread();
  });
}

function fetchUnread() {
  imapClient.search(['UNSEEN'], (err, results) => {
    if (err || !results || results.length === 0) return;

    const fetch = imapClient.fetch(results, { bodies: '' });

    fetch.on('message', (msg) => {
      msg.on('body', (stream) => {
        simpleParser(stream, async (err, parsed) => {
          if (err) return;
          await processEmail(parsed);
        });
      });

      msg.once('attributes', (attrs) => {
        // Mark as seen
        imapClient.addFlags(attrs.uid, ['\\Seen'], () => {});
      });
    });
  });
}

async function processEmail(email) {
  const from = (email.from?.text || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const text = (email.text || '') + (email.html || '');

  // ─── Cash App Detection ──────────────────────────────
  if (from.includes('cash.app') || from.includes('square.com') || subject.includes('payment received')) {
    await handleCashApp(email, text);
  }

  // ─── PayPal Detection ────────────────────────────────
  if (from.includes('paypal.com') || subject.includes('you received a payment')) {
    await handlePayPal(email, text);
  }
}

async function handleCashApp(email, text) {
  try {
    // Extract amount — Cash App emails say "You received $XX.XX"
    const amountMatch = text.match(/you received \$?([\d,]+\.?\d*)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : null;

    // Extract note — Cash App includes the note in email body
    const noteMatch = text.match(/note[:\s]+([a-z0-9]+)/i) ||
                      text.match(/for[:\s]+"?([a-z0-9]+)"?/i);
    const note = noteMatch ? noteMatch[1].toLowerCase().trim() : null;

    console.log(`[EmailWatcher] Cash App payment — amount: $${amount}, note: ${note}`);

    if (!note) return;

    // Find pending order with this note
    await matchAndConfirmOrder(note, amount, 'cashapp');
  } catch (err) {
    console.error('[EmailWatcher] Cash App parse error:', err.message);
  }
}

async function handlePayPal(email, text) {
  try {
    // Extract amount — PayPal emails say "You've received $XX.XX"
    const amountMatch = text.match(/(?:you.ve received|received)\s+\$?([\d,]+\.?\d*)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : null;

    // Extract note — PayPal "What's this for?" field
    const noteMatch = text.match(/what.s this for\??\s*:?\s*([a-z0-9]+)/i) ||
                      text.match(/note[:\s]+([a-z0-9]+)/i) ||
                      text.match(/message[:\s]+"?([a-z0-9]+)"?/i);
    const note = noteMatch ? noteMatch[1].toLowerCase().trim() : null;

    console.log(`[EmailWatcher] PayPal payment — amount: $${amount}, note: ${note}`);

    if (!note) return;

    await matchAndConfirmOrder(note, amount, 'paypal');
  } catch (err) {
    console.error('[EmailWatcher] PayPal parse error:', err.message);
  }
}

async function matchAndConfirmOrder(note, amount, method) {
  try {
    // Find pending order with matching note
    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('payment_note', note)
      .eq('payment_method', method)
      .eq('status', 'pending')
      .single();

    if (error || !order) {
      console.warn(`[EmailWatcher] No pending ${method} order found for note: ${note}`);
      return;
    }

    // Loose amount check — allow small rounding differences
    if (amount && Math.abs(amount - order.total) > 0.50) {
      console.warn(`[EmailWatcher] Amount mismatch for order ${order.id}: expected ${order.total}, got ${amount}`);
      return;
    }

    // Confirm order
    await axios.post(
      `http://localhost:${process.env.PORT || 3000}/api/orders/confirm`,
      {
        secret: process.env.API_SECRET,
        order_id: order.id,
        amount_received: amount,
        method,
      }
    );

    console.log(`[EmailWatcher] Order ${order.id} confirmed via ${method} email`);
  } catch (err) {
    console.error('[EmailWatcher] Match/confirm error:', err.message);
  }
}

module.exports = { start };
