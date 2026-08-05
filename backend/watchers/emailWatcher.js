const Imap = require('imap');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const { query } = require('../db');
const { raiseAlert } = require('../utils/alerts');
const { inboundAccounts } = require('../utils/mailAccounts');

const GUILD_ID = process.env.GUILD_ID;

// One watcher instance per MAILBOX, not one per process. PayPal and Cash App
// notifications used to be required to land in the same inbox because there
// was a single module-global IMAP client; each payment method can now have its
// own login (see utils/mailAccounts.js), and every piece of connection state
// that used to be a module global lives on the instance instead. Two methods
// configured with identical credentials still share ONE connection — otherwise
// the same mailbox would be fetched twice and every message parsed twice.
const watchers = [];

// Backoff caps at 5 minutes and never gives up. The watcher used to stop
// permanently after 5 failures with only a console.error — after which every
// Cash App and PayPal payment went unconfirmed until somebody happened to
// redeploy. A payment processor that switches itself off silently is worse than
// one that is noisily broken.
const BACKOFF_MS = [10000, 30000, 60000, 120000, 300000];
const HEARTBEAT_CHECK_MS = 5 * 60 * 1000;
const SILENCE_ALERT_MS = 20 * 60 * 1000;
// A scan that has held the latch this long is presumed dead, not slow. Well
// above a normal two-day fetch, well below the 20-minute silence alarm.
const SCAN_STUCK_MS = 5 * 60 * 1000;

function makeWatcher(account) {
  return {
    account,
    // `label` is what shows up in logs and alerts. The mailbox address is
    // deliberately NOT logged — the methods it serves identify it well enough.
    label: account.methods.join('+'),
    imapClient: null,
    failCount: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    lastActivityAt: Date.now(),
    deadAlertSent: false,
    scanning: false,
    scanStartedAt: null,
  };
}

function start() {
  const accounts = inboundAccounts();
  if (!accounts.length) {
    console.warn('[EmailWatcher] No payment mailbox configured — disabled');
    return;
  }
  for (const account of accounts) {
    const w = makeWatcher(account);
    watchers.push(w);
    connectImap(w);
    startHeartbeat(w);
    console.log(`[EmailWatcher] Started ${w.label} via ${account.provider}`);
  }
}

// Being connected is not the same as being alive: a wedged IDLE keeps the
// socket open while delivering nothing. But "no mail arrived" is NOT the same
// as "broken" either — and that was the bug.
//
// markAlive() only ran on connect, on an inbound 'mail' event, and on a search
// that returned rows. A quiet mailbox therefore looked identical to a dead
// watcher, so a store with no orders alarmed every ~20 minutes forever. Worse,
// each reconnect called markAlive() and cleared deadAlertSent, so the alarm
// re-armed and fired again and again ("failCount: 0" in every one of those
// alerts is the tell — there were no failures at all).
//
// The heartbeat now ACTIVELY probes the connection instead of waiting to be
// spoken to. A probe that succeeds proves the watcher can still see the
// mailbox, whether or not anyone has emailed. Only a failed probe — or a
// client that is not in the authenticated state — is an actual outage.
function startHeartbeat(w) {
  if (w.heartbeatTimer) clearInterval(w.heartbeatTimer);
  w.heartbeatTimer = setInterval(async () => {
    const healthy = await probeConnection(w);
    if (healthy) {
      w.lastActivityAt = Date.now();
      w.deadAlertSent = false;
      return;
    }
    const silentFor = Date.now() - w.lastActivityAt;
    if (silentFor > SILENCE_ALERT_MS && !w.deadAlertSent) {
      w.deadAlertSent = true;
      // The alert key carries the label, so with the inboxes split one dead
      // mailbox's alarm cannot be de-duplicated away by the other one's.
      await raiseAlert(`email_watcher_silent_${w.label}`,
        `Payment email watcher (${w.label}) cannot reach its mailbox (no successful IMAP probe for ${Math.round(silentFor / 60000)} minutes) — those payments may not be confirming`,
        { severity: 'error', context: { mailbox: w.label, failCount: w.failCount, imapState: w.imapClient ? w.imapClient.state : 'none' } }).catch(() => {});
    }
  }, HEARTBEAT_CHECK_MS);
  if (w.heartbeatTimer.unref) w.heartbeatTimer.unref();
}

// Cheap liveness check: ask the server for the mailbox status. Resolves true
// only if the round trip actually completes, so a half-open socket that no
// longer answers is correctly reported as dead.
function probeConnection(w) {
  return new Promise((resolve) => {
    if (!w.imapClient || w.imapClient.state !== 'authenticated') return resolve(false);
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    // Don't hang the heartbeat on a wedged connection.
    const t = setTimeout(() => done(false), 15000);
    if (t.unref) t.unref();
    try {
      w.imapClient.status('INBOX', (err) => {
        clearTimeout(t);
        if (err) console.warn(`[EmailWatcher:${w.label}] health probe failed:`, err.message);
        done(!err);
      });
    } catch (e) {
      clearTimeout(t);
      console.warn(`[EmailWatcher:${w.label}] health probe threw:`, e.message);
      done(false);
    }
  });
}

function markAlive(w) {
  w.lastActivityAt = Date.now();
  w.deadAlertSent = false;
}

function connectImap(w) {
  const a = w.account;
  w.imapClient = new Imap({
    user: a.user,
    password: a.password,
    host: a.host,
    port: a.port,
    tls: true,
    // The provider presents a valid certificate. Skipping validation would let
    // anyone able to intercept the connection feed us forged "payment" mail and
    // harvest the mailbox password. servername has to be the host we actually
    // dialled, so it comes from the account rather than a hardcoded Gmail.
    tlsOptions: { servername: a.host },
    authTimeout: 15000,
    connTimeout: 15000,
    keepalive: {
      interval: 10000,
      idleInterval: 300000,
      forceNoop: true,
    },
  });

  w.imapClient.once('ready', () => {
    w.failCount = 0;
    markAlive(w);
    console.log(`[EmailWatcher:${w.label}] IMAP connected`);
    openInbox(w);
  });

  w.imapClient.once('error', (err) => {
    w.failCount++;
    console.error(`[EmailWatcher:${w.label}] IMAP error (attempt ${w.failCount}):`, err.message);
    if (w.failCount === 3) {
      raiseAlert(`email_watcher_failing_${w.label}`,
        `Payment email watcher (${w.label}) has failed to connect ${w.failCount} times: ${err.message}`,
        { severity: 'warn' }).catch(() => {});
    }
    scheduleReconnect(w);
  });

  w.imapClient.once('end', () => {
    console.log(`[EmailWatcher:${w.label}] IMAP disconnected — reconnecting...`);
    scheduleReconnect(w);
  });

  w.imapClient.connect();
}

function scheduleReconnect(w) {
  if (w.reconnectTimer) clearTimeout(w.reconnectTimer);
  const delay = BACKOFF_MS[Math.min(w.failCount, BACKOFF_MS.length - 1)];
  w.reconnectTimer = setTimeout(() => connectImap(w), delay);
}

function openInbox(w) {
  w.imapClient.openBox('INBOX', false, (err) => {
    if (err) {
      // This used to just `return`. The IMAP connection stayed up, so the
      // 'end'/'error' handlers that schedule a reconnect never fired, and no
      // 'mail' listener was ever attached — the watcher sat there connected
      // and permanently deaf. Payments stopped confirming with no error after
      // this one line. Force the reconnect instead.
      console.error(`[EmailWatcher:${w.label}] Failed to open inbox:`, err.message, '— forcing reconnect');
      w.scanning = false;
      try { w.imapClient.end(); } catch { /* already gone */ }
      scheduleReconnect(w);
      return;
    }
    console.log(`[EmailWatcher:${w.label}] Inbox open — watching for payments`);
    w.imapClient.on('mail', (numNew) => {
      markAlive(w);
      console.log(`[EmailWatcher:${w.label}] ${numNew} new email(s) — checking for payments`);
      fetchRecent(w);
    });
    fetchRecent(w);
  });
}

function fetchRecent(w) {
  // Serialised deliberately. Overlapping scans used to hand the same UID to two
  // parallel processEmail calls, and PayPal sends more than one notification per
  // payment, so concurrent confirmations of a single order were routine.
  //
  // The latch needs a way out, though: it survives a reconnect, so a fetch that
  // never fires 'end' (a dropped socket mid-stream, a parser that never calls
  // back) left `scanning` true forever and EVERY later scan returned on the
  // first line. The mailbox kept receiving payments and the watcher silently
  // stopped reading them. A stuck scan is now force-released so the next 'mail'
  // event can proceed. The latch is per-mailbox: one wedged inbox must not stop
  // the other one from scanning.
  if (w.scanning) {
    if (w.scanStartedAt && Date.now() - w.scanStartedAt > SCAN_STUCK_MS) {
      console.error(`[EmailWatcher:${w.label}] previous scan stuck for ${Math.round((Date.now() - w.scanStartedAt) / 1000)}s — releasing the latch`);
      w.scanning = false;
    } else {
      return;
    }
  }
  w.scanning = true;
  w.scanStartedAt = Date.now();

  const endScan = () => { w.scanning = false; w.scanStartedAt = null; };

  // Two days back, and NOT filtered on UNSEEN. The old `UNSEEN SINCE today`
  // window dropped mail permanently in two ways: a restart just after local
  // midnight abandoned everything from the previous day, and anyone glancing at
  // the mailbox on their phone marked a payment read before we ever saw it.
  // processed_emails is what prevents rework now, so a wider net is free.
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const dd = String(since.getDate()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sinceDate = `${dd}-${months[since.getMonth()]}-${since.getFullYear()}`;

  w.imapClient.search([['SINCE', sinceDate]], (err, results) => {
    if (err || !results || results.length === 0) { endScan(); return; }
    markAlive(w);

    const fetch = w.imapClient.fetch(results, { bodies: '' });
    const pending = [];

    fetch.on('message', (msg) => {
      pending.push(new Promise((resolve) => {
        msg.on('body', (stream) => {
          simpleParser(stream, async (parseErr, parsed) => {
            if (parseErr) {
              console.error(`[EmailWatcher:${w.label}] Parse error:`, parseErr.message);
              return resolve();
            }
            try {
              await processEmail(parsed, w.account);
            } catch (e) {
              console.error(`[EmailWatcher:${w.label}] processEmail threw:`, e.message);
            }
            resolve();
          });
        });
      }));
    });

    fetch.once('error', (fetchErr) => {
      console.error(`[EmailWatcher:${w.label}] Fetch error:`, fetchErr.message);
      endScan();
    });

    fetch.once('end', async () => {
      // Sequential, so two messages quoting the same note can never race each
      // other into /confirm.
      for (const p of pending) await p;
      endScan();
    });
  });
}

// ─── Sender verification ─────────────────────────────────
// This is the ONLY thing that decides whether an email is treated as a payment
// notification. A From line is trivially forged and `subject.includes(...)`
// let any stranger's email reach the confirm path, so neither is trusted here.
//
// The RECEIVING mail server has already run SPF/DKIM/DMARC by the time we fetch
// the message over IMAP and stamps its verdict into an Authentication-Results
// header. That verdict is the trustworthy signal. Only the FIRST such header is
// read: the receiving server prepends its own on arrival, so anything below it
// was supplied by the sender and is attacker-controlled.
//
// Whose stamp counts depends on where the mailbox lives, which is why each
// account carries it (see utils/mailAccounts.js). Google writes an authserv-id
// — `mx.google.com; ... dmarc=pass` — while Microsoft writes none at all and
// instead adds its own `compauth=` token, which no sender can forge into the
// first header position because Microsoft strips inbound copies of it. Point a
// mailbox at the wrong provider and every payment email is silently ignored.

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

// GMAIL_USER-only deployments have no account object at all in the tests that
// predate the split, so the Gmail rule stays the default when none is passed.
const DEFAULT_AUTHSERV = { authservId: 'mx.google.com', authservMarker: null };

function verifiedSenderDomain(parsed, account) {
  const header = (parsed.headerLines || []).find(h => h.key === 'authentication-results');
  if (!header) return null;

  const body = String(header.line).replace(/^authentication-results:\s*/i, '');
  const rule = account || DEFAULT_AUTHSERV;

  // The verdict must be the receiving server's own, not one the sender wrote
  // themselves. An authserv-id is checked at the very start of the header,
  // where only the receiving server can put it; a marker (Microsoft) is checked
  // anywhere in that same first header, since it has no id to anchor to.
  if (rule.authservId) {
    const esc = String(rule.authservId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp('^' + esc + '\\b', 'i').test(body.split(';')[0].trim())) return null;
  } else if (rule.authservMarker) {
    if (!body.toLowerCase().includes(String(rule.authservMarker).toLowerCase())) return null;
  } else {
    // Neither configured: refuse rather than trust an unidentified stamp.
    return null;
  }

  // DMARC only. The old dkim=pass fallback was strictly weaker: DKIM alone
  // accepts a signature that is not aligned with the From domain, which is
  // exactly the gap DMARC exists to close.
  const dmarc = body.match(/dmarc=pass[^;]*?header\.from=([a-z0-9.-]+)/i);
  return dmarc ? dmarc[1].toLowerCase().replace(/\.$/, '') : null;
}

// ─── Was the payment actually to US, and is it final? ────
// A passing DMARC verdict answers "did PayPal send this?" — not "did I get
// paid?". Those come apart badly: an attacker can PayPal themselves, receive a
// genuine paypal.com-signed "You received $19.99" naming our order note, and
// forward that raw message here. DKIM signs headers and body, not the envelope
// recipient, so it still verifies. The body must therefore be checked for our
// own receiving identity, and for evidence the money has actually settled.

function merchantIdentities(method) {
  const ids = [];
  if (method === 'paypal') {
    for (const v of [process.env.PAYPAL_EMAIL, process.env.PAYPAL_MERCHANT_NAME]) {
      if (v && v.trim()) ids.push(v.trim().toLowerCase());
    }
  } else if (method === 'cashapp') {
    // GMAIL_USER is deliberately NOT here. Gmail stamps `Delivered-To:
    // <GMAIL_USER>` on every message it accepts, so accepting our own mailbox
    // address as proof of receipt made the check tautological: it passed for any
    // email that had ever arrived, including a forwarded third-party receipt.
    for (const v of [process.env.CASHAPP_CASHTAG, process.env.CASHAPP_DISPLAY_NAME]) {
      if (v && v.trim()) ids.push(v.trim().toLowerCase());
    }
  }
  return ids;
}

// Where the payer's own words begin. Everything from here down is chosen by
// whoever sent the money — the memo is free text and may contain newlines — so
// it must not count as evidence of who was paid.
const MEMO_MARKERS = [
  /^note from\b/i, /^note[:\s]*$/i, /^note[:\s]/i, /^memo[:\s]/i,
  /^message from\b/i, /^message[:\s]/i, /^for[:\s]/i,
];

// The provider's own text, with the payer-controlled memo block stripped off.
function providerPortion(text) {
  const lines = String(text).split('\n');
  const cut = lines.findIndex(l => MEMO_MARKERS.some(m => m.test(l.trim())));
  return cut === -1 ? text : lines.slice(0, cut).join('\n');
}

// The forwarded-receipt attack fails here: a notification generated for someone
// else's account never names our cashtag or receiving email.
//
// Only the DKIM-signed body counts, and only the part above the memo. The To and
// Delivered-To headers are excluded on purpose: a forwarder rewrites To freely,
// and Delivered-To is always our own mailbox, so neither distinguishes a
// receipt addressed to us from one merely delivered to us. Searching the whole
// body was the same mistake one level down — an attacker could pay their own
// account with the memo "redfox1234\nstore@ghost.example" and our address would
// appear inside genuinely-signed content.
function addressedToUs(email, text, method) {
  const ids = merchantIdentities(method);
  if (!ids.length) return { ok: false, reason: `no merchant identity configured for ${method}` };

  const haystack = [providerPortion(text), email.subject || ''].join('\n').toLowerCase();

  const hit = ids.find(id => haystack.includes(id));
  return hit ? { ok: true } : { ok: false, reason: `email does not name our ${method} account` };
}

// Anything that is not settled money. An eCheck or a pending payment reads
// almost identically to a cleared one ("sent you $19.99", "Note from ...") but
// can bounce days after the key has been handed over; a refund or reversal is
// the opposite of a payment and must never confirm anything.
const NON_FINAL_PATTERNS = [
  /\bpending\b/i, /\beCheck\b/i, /\be-check\b/i, /\bunclaimed\b/i,
  /\bon hold\b/i, /\bbeing reviewed\b/i, /\bunder review\b/i,
  /\brefund(ed|ing)?\b/i, /\breversal\b/i, /\breversed\b/i, /\bchargeback\b/i,
  /\bdispute[ds]?\b/i, /\bcancell?ed\b/i, /\bfailed\b/i, /\bdeclined\b/i,
  /\brequest(ed|s)? (?:money|payment)\b/i, /\bis requesting\b/i,
  /\bwill be available\b/i, /\bmay take\b.*\bdays\b/i,
];

// Every provider receipt ends in boilerplate — a Resolution Center link, a
// refund policy, an unsubscribe line. Those legitimately contain "dispute",
// "refund", "cancelled" and "will be available", so scanning the whole body
// rejected successful payments: this list matched a real settled PayPal receipt
// on /\bdispute[ds]?\b/ every single time. Since a false positive here silently
// strands a paying customer, the scan is confined to the part of the message
// that actually states the transaction's status.
const FOOTER_MARKERS = [
  /^\s*(?:questions|need help|help center|resolution center)\b/i,
  /^\s*(?:please )?do not reply\b/i, /^\s*don'?t reply\b/i,
  /^\s*(?:to )?unsubscribe\b/i, /^\s*this email was sent\b/i,
  /^\s*copyright\b/i, /^\s*©/, /^\s*paypal(?:,| is) /i,
  /^\s*(?:privacy|legal) (?:policy|agreement)\b/i,
  /^\s*learn more about\b/i, /^\s*-{4,}\s*$/, /^\s*_{4,}\s*$/,
];

// The transaction statement: above the footer, and above the payer's memo.
function statusPortion(text) {
  const provider = providerPortion(text);
  const lines = provider.split('\n');
  const cut = lines.findIndex(l => FOOTER_MARKERS.some(m => m.test(l)));
  return cut === -1 ? provider : lines.slice(0, cut).join('\n');
}

function nonFinalReason(email, text) {
  const haystack = `${email.subject || ''}\n${statusPortion(text)}`;
  const hit = NON_FINAL_PATTERNS.find(p => p.test(haystack));
  return hit ? `matched non-final pattern ${hit}` : null;
}

// USD only. `(?:USD)?` made the currency optional while PayPal renders CAD, AUD,
// MXN and SGD with the same "$", so "sent you $19.99 MXN" (about one US dollar)
// used to settle a $19.99 invoice at face value.
//
// Scoped to the status text for the same reason as the non-final patterns: a
// currency-conversion footnote or a localized-site footer mentioning EUR must
// not reject a payment that was actually made in dollars.
const FOREIGN_CURRENCY = /\b(?:CAD|AUD|NZD|MXN|SGD|HKD|EUR|GBP|JPY|CHF|SEK|NOK|DKK|PLN|BRL|ILS|PHP|TWD|THB|CZK|HUF|RUB|INR|CNY|ZAR)\b/;

function foreignCurrencyReason(text) {
  const m = statusPortion(text).match(FOREIGN_CURRENCY);
  return m ? `amount appears to be in ${m[0]}, not USD` : null;
}

// A message must be considered at most once. Claimed by INSERT before any
// parsing, so a message redelivered by IMAP (reconnect, wider re-scan, or a
// human toggling read state) is skipped rather than reprocessed.
async function claimMessage(email) {
  const messageId = (email.messageId || '').trim();
  if (!messageId) {
    // No Message-ID means no way to recognise it again. Refusing is the safe
    // direction: every genuine provider notification has one.
    return { claimed: false, reason: 'email has no Message-ID' };
  }
  try {
    const { rowCount } = await query(
      `INSERT INTO processed_emails (message_id, subject) VALUES ($1,$2)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId.slice(0, 500), (email.subject || '').slice(0, 500)]
    );
    if (!rowCount) return { claimed: false, reason: 'already processed' };
    return { claimed: true, messageId: messageId.slice(0, 500) };
  } catch (err) {
    // If the dedupe store is unreachable we cannot promise exactly-once, so we
    // decline rather than risk a double delivery. The scan retries later.
    console.error('[EmailWatcher] Dedupe store unavailable:', err.message);
    return { claimed: false, reason: 'dedupe unavailable' };
  }
}

async function recordOutcome(messageId, outcome, orderId) {
  if (!messageId) return;
  await query(
    `UPDATE processed_emails SET outcome = $1, order_id = $2 WHERE message_id = $3`,
    [outcome, orderId != null ? String(orderId) : null, messageId]
  ).catch(() => {});
}

// Gives the claim back so a later scan may consider the message again.
//
// The claim is taken before parsing, which is right for anything that reached a
// verdict about money — but a message rejected by a *classifier* has not. If one
// of those patterns is wrong (a footer word matching a non-final phrase, say),
// keeping the claim would make the mistake permanent: the payment could never be
// reprocessed even after the pattern was fixed, and would need a hand-written
// DELETE against processed_emails to recover. These paths confirm nothing, so
// re-reading the message is harmless.
async function releaseClaim(messageId) {
  if (!messageId) return;
  await query('DELETE FROM processed_emails WHERE message_id = $1', [messageId]).catch(() => {});
}

async function processEmail(email, account) {
  const subject = email.subject || '';
  // Plain text only — HTML carries CSS noise like "0px" that breaks parsing.
  const text = (email.text || '');

  const verified = verifiedSenderDomain(email, account);
  if (!verified) {
    console.warn(`[EmailWatcher] Ignored "${subject}" — no DMARC pass stamped by this mailbox's own server`);
    return;
  }

  let method = null;
  if (domainMatches(verified, envDomains('CASHAPP_EMAIL_DOMAINS', DEFAULT_CASHAPP_DOMAINS))) method = 'cashapp';
  else if (domainMatches(verified, envDomains('PAYPAL_EMAIL_DOMAINS', DEFAULT_PAYPAL_DOMAINS))) method = 'paypal';

  if (!method) {
    console.log(`[EmailWatcher] Ignored "${subject}" — ${verified} is not a payment provider domain`);
    return;
  }

  // A mailbox only confirms the methods routed to it. With the inboxes split,
  // a Cash App notification landing in the PayPal inbox is not evidence of
  // anything we asked for — it means mail is being forwarded or the wrong
  // address was given out — so splitting the logins also narrows what each one
  // is trusted for. An unsplit deployment carries both methods on the one
  // account and behaves exactly as before.
  if (account && Array.isArray(account.methods) && !account.methods.includes(method)) {
    console.warn(`[EmailWatcher] Ignored "${subject}" — ${method} mail in the ${account.methods.join('+')} mailbox`);
    return;
  }

  const claim = await claimMessage(email);
  if (!claim.claimed) {
    console.log(`[EmailWatcher] Skipping "${subject}" — ${claim.reason}`);
    return;
  }

  const recipient = addressedToUs(email, text, method);
  if (!recipient.ok) {
    // Genuine provider mail that is not about a payment to us. Most often a
    // receipt for something we bought — but it is also the shape of a forwarded
    // notification for someone else's account, so it is worth surfacing.
    console.warn(`[EmailWatcher] Ignored "${subject}" — ${recipient.reason}`);
    await recordOutcome(claim.messageId, `rejected: ${recipient.reason}`, null);
    return;
  }

  const nonFinal = nonFinalReason(email, text);
  if (nonFinal) {
    console.warn(`[EmailWatcher] Ignored "${subject}" — not a settled payment (${nonFinal})`);
    await releaseClaim(claim.messageId);
    await raiseAlert('email_payment_not_final',
      `A ${method} email was rejected as not-final and needs a human: "${subject}"`,
      { severity: 'warn', context: { method, reason: nonFinal } }).catch(() => {});
    return;
  }

  const foreign = foreignCurrencyReason(text);
  if (foreign) {
    console.warn(`[EmailWatcher] Ignored "${subject}" — ${foreign}`);
    await releaseClaim(claim.messageId);
    await raiseAlert('email_payment_foreign_currency',
      `A ${method} payment arrived in a non-USD currency and needs manual handling: "${subject}"`,
      { severity: 'warn', context: { method, reason: foreign } }).catch(() => {});
    return;
  }

  if (method === 'cashapp') await handleCashApp(email, text, claim.messageId);
  else await handlePayPal(email, text, claim.messageId);
}

// Amount parsing. Anchored on the provider's own receipt wording rather than
// scanning for any dollar figure: a payer controls their display name and the
// memo, so a free-floating "$99.99" earlier in the body would otherwise win over
// the real figure. `.replace(/,/g)` — without the global flag only the first
// separator was stripped, so "$1,234,567.89" parsed as 1234.
function parseAmount(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const value = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

async function handleCashApp(email, text, messageId) {
  try {
    const amount = parseAmount(text, [
      /you received \$([\d,]+\.?\d*)/i,
      /\bpaid you \$([\d,]+\.?\d*)/i,
    ]);

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
      // Released, not recorded: if this is a format change, the fix should be
      // able to pick the payment up on the next scan.
      await releaseClaim(messageId);
      // A verified provider email we could not read is how format drift shows
      // up. Silence here means a paying customer waits forever.
      await raiseAlert('email_unparseable',
        `A verified Cash App email could not be parsed — check for a format change: "${email.subject || ''}"`,
        { severity: 'warn', context: { method: 'cashapp' } }).catch(() => {});
      return;
    }
    console.log(`[EmailWatcher] Cash App — amount: $${amount}, note: ${note}`);
    await matchAndConfirmOrder(note, amount, 'cashapp', messageId);
  } catch (err) {
    console.error('[EmailWatcher] Cash App parse error:', err.message);
  }
}

async function handlePayPal(email, text, messageId) {
  try {
    const amount = parseAmount(text, [
      /you received \$([\d,]+\.?\d*)/i,
      /sent you \$([\d,]+\.?\d*)/i,
      /\bamount received[:\s]+\$([\d,]+\.?\d*)/i,
    ]);

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
      await releaseClaim(messageId);
      await raiseAlert('email_unparseable',
        `A verified PayPal email could not be parsed — check for a format change: "${email.subject || ''}"`,
        { severity: 'warn', context: { method: 'paypal' } }).catch(() => {});
      return;
    }

    console.log(`[EmailWatcher] PayPal — amount: $${amount}, note: ${note}`);
    await matchAndConfirmOrder(note, amount, 'paypal', messageId);
  } catch (err) {
    console.error('[EmailWatcher] PayPal parse error:', err.message);
  }
}

async function matchAndConfirmOrder(note, amount, method, messageId) {
  try {
    console.log(`[EmailWatcher] Looking for pending ${method} order with note: ${note}`);

    // expires_at is enforced here as it already is in the crypto poller.
    // Without it, a months-old 'waiting' order could still settle at the price
    // it was quoted at, and stale notes stayed matchable forever.
    const { rows } = await query(
      `SELECT * FROM orders
       WHERE guild_id = $1 AND payment_note = $2 AND payment_method = $3
         AND status = 'waiting' AND expires_at > now()
       LIMIT 1`,
      [GUILD_ID, note, method]
    );
    const order = rows[0];

    if (!order) {
      console.warn(`[EmailWatcher] No pending ${method} order for note: ${note}`);

      // "Possibly expired or already paid" was as much as this could say, and
      // it was not enough to act on: staff got a payment note and had to go
      // find the order themselves. Now that unpaid orders are actually closed
      // (watchers/orderExpiry.js), late-but-genuine is the LIKELY reason to be
      // standing here rather than a rare one, so it is worth the second query
      // to name the order and write the money down on it.
      //
      // Deliberately the same treatment routes/webhooks.js gives late crypto:
      // record the receipt, move to 'expired_paid', page a human. Never
      // auto-deliver — the quote is stale and this path has already decided
      // the deadline was missed.
      let late = null;
      try {
        const { rows: hist } = await query(
          `SELECT id, invoice_no, status, total_cents, expires_at FROM orders
            WHERE guild_id = $1 AND payment_note = $2 AND payment_method = $3
            ORDER BY created_at DESC LIMIT 1`,
          [GUILD_ID, note, method]
        );
        late = hist[0] || null;
      } catch (e) { /* the alert below still goes out without it */ }

      const unpaidAndClosed = late
        && (late.status === 'expired' || late.status === 'waiting')
        && Number.isFinite(amount) && amount > 0;

      // Recorded after the lookup rather than before it so the replay record
      // carries the order this email actually belongs to. It is still the
      // first thing that must not be skipped — the same message arriving twice
      // has to be recognisable — so it goes ahead of the UPDATE.
      await recordOutcome(messageId,
        unpaidAndClosed ? 'rejected: order past its deadline, flagged expired_paid'
                        : 'rejected: no matching open order',
        late ? late.id : null);

      if (unpaidAndClosed) {
        await query(
          `UPDATE orders SET status = 'expired_paid', amount_received_cents = $1
            WHERE id = $2 AND guild_id = $3 AND status IN ('waiting','expired')`,
          [Math.round(amount * 100), late.id, GUILD_ID]
        ).catch(() => {});
      }

      await raiseAlert('email_payment_unmatched',
        late
          ? `A verified ${method} payment of $${amount} quoted note "${note}", which belongs to order ` +
            `${late.invoice_no || '#' + late.id} — status '${late.status}', deadline ${late.expires_at}, ` +
            `total $${((late.total_cents || 0) / 100).toFixed(2)}. ` +
            (unpaidAndClosed
              ? 'The amount has been recorded and the order flagged expired_paid; confirm it with /order forceconfirm if the payment is good.'
              : 'No change made — check whether it was already settled.')
          : `A verified ${method} payment of $${amount} quoted note "${note}" but no order has ever used that note`,
        { severity: 'error', order_id: late ? late.id : undefined,
          context: { method, note, amount, matched_status: late ? late.status : null } }).catch(() => {});
      return;
    }

    const total = order.total_cents / 100;

    // An unparseable amount used to fall straight through this check (`amount`
    // was null, so the guard was skipped and the order confirmed), which made
    // omitting the figure easier than forging it. No amount now means no
    // confirmation — the order waits for a human instead.
    if (!Number.isFinite(amount) || amount <= 0) {
      console.warn(`[EmailWatcher] Order ${order.id} NOT confirmed — no amount parsed from the ${method} email`);
      await recordOutcome(messageId, 'rejected: no amount parsed', order.id);
      await raiseAlert('email_payment_no_amount',
        `Order ${order.id} matched a ${method} email but no amount could be parsed — needs manual review`,
        { severity: 'error', order_id: order.id, context: { method, note } }).catch(() => {});
      return;
    }

    // Underpayment is rejected; overpayment is accepted and noted, since
    // refusing money the customer already sent just creates a support ticket.
    const tolerance = parseFloat(process.env.EMAIL_UNDERPAY_TOLERANCE_USD || '0.01');
    if (amount + tolerance < total) {
      console.warn(`[EmailWatcher] Order ${order.id} underpaid — expected $${total}, got $${amount}`);
      await query(
        `UPDATE orders SET status = 'underpaid', amount_received_cents = $1,
                amount_received_native = $2, amount_received_unit = 'usd'
          WHERE id = $3 AND status = 'waiting'`,
        [Math.round(amount * 100), amount, order.id]
      ).catch(() => {});
      await recordOutcome(messageId, 'underpaid', order.id);
      // An underpaid order is a customer who needs help or someone probing —
      // either way it sat in the database with nobody informed.
      await raiseAlert('order_underpaid',
        `Order ${order.id} underpaid via ${method}: expected $${total.toFixed(2)}, received $${amount.toFixed(2)}`,
        { severity: 'error', order_id: order.id, context: { method, expected: total, received: amount, email: order.email } }).catch(() => {});
      return;
    }
    if (amount > total) {
      console.warn(`[EmailWatcher] Order ${order.id} overpaid — expected $${total}, got $${amount}`);
      await raiseAlert('order_overpaid',
        `Order ${order.id} overpaid via ${method}: expected $${total.toFixed(2)}, received $${amount.toFixed(2)} — refund the difference`,
        { severity: 'warn', order_id: order.id, context: { method, expected: total, received: amount } }).catch(() => {});
    }

    await axios.post(`http://localhost:${process.env.PORT || 3000}/api/orders/confirm`, {
      secret: process.env.API_SECRET,
      order_id: order.id,
      amount_received: amount,
      method,
      // Ties this settlement to the specific email that caused it, so the same
      // provider notification cannot settle anything a second time.
      provider_txn_id: messageId || null,
    });

    await recordOutcome(messageId, 'confirmed', order.id);
    console.log(`[EmailWatcher] Order ${order.id} confirmed via ${method} — $${amount}`);
  } catch (err) {
    console.error('[EmailWatcher] Match/confirm error:', err.message);
    await raiseAlert('email_confirm_failed',
      `A verified ${method} payment for note "${note}" could not be confirmed: ${err.message}`,
      { severity: 'error', context: { method, note, amount } }).catch(() => {});
  }
}

module.exports = { start };
module.exports.__test__ = {
  processEmail, verifiedSenderDomain, domainMatches,
  addressedToUs, nonFinalReason, foreignCurrencyReason, parseAmount,
};
