// Which mailbox does what.
//
// Everything used to run through ONE Gmail login: GMAIL_USER / GMAIL_PASSWORD
// sent the order confirmations AND was the inbox the payment watcher read for
// both PayPal and Cash App. That is three unrelated jobs sharing one
// credential — the store's outbound identity, the PayPal notification stream
// and the Cash App notification stream — so the address customers see is
// forced to be the address that receives payment mail, and a rotation for one
// purpose breaks the other two.
//
// Each purpose now resolves its own account. All of them fall back to the old
// GMAIL_* pair, so a deployment that sets nothing new keeps working exactly as
// before; set only the ones you want to split off.
//
// THREE GMAIL LOGINS — the short way, and the one this store uses:
//
//     UHSERVICES_GMAIL_USER / UHSERVICES_GMAIL_PASSWORD   outbound store mail
//     PAYPAL_GMAIL_USER     / PAYPAL_GMAIL_PASSWORD       PayPal inbox
//     CASHAPP_GMAIL_USER    / CASHAPP_GMAIL_PASSWORD      Cash App inbox
//
// Those six are enough on their own: naming Gmail in the variable pins the
// provider, so the host, the port and the DMARC verdict to trust are all filled
// in — including for a Google Workspace address on a custom domain, which the
// address alone cannot be recognised from.
//
// The generic forms below still work and are what to use for anything that is
// NOT Gmail:
//
//   OUTBOUND (order confirmations + 2FA codes)
//     SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM
//     or MAIL_PROVIDER=gmail|outlook to fill host/port for you
//
//   PAYPAL INBOX          CASHAPP INBOX
//     PAYPAL_IMAP_USER      CASHAPP_IMAP_USER
//     PAYPAL_IMAP_PASSWORD  CASHAPP_IMAP_PASSWORD
//     PAYPAL_IMAP_PROVIDER  CASHAPP_IMAP_PROVIDER   (gmail | outlook | custom)
//     PAYPAL_IMAP_HOST      CASHAPP_IMAP_HOST       (only for custom)
//     PAYPAL_IMAP_PORT      CASHAPP_IMAP_PORT       (only for custom)
//     PAYPAL_IMAP_AUTHSERV  CASHAPP_IMAP_AUTHSERV   (only for custom)
//
// Every Gmail login here needs an APP PASSWORD, not the account password —
// Google rejects the real password on IMAP and SMTP.
//
// NOTE on the provider: it is not cosmetic. The watcher decides whether an
// email is genuinely from PayPal by reading the DMARC verdict the RECEIVING
// mail server stamped on it, and it has to know whose verdict to trust —
// Google writes `mx.google.com; ... dmarc=pass`, Microsoft writes no
// authserv-id at all but adds its own `compauth=`. Point a mailbox at the
// wrong provider and every payment email is silently ignored.
'use strict';

const PROVIDERS = {
  gmail: {
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpService: 'gmail',
    // The first Authentication-Results header must be Google's own.
    authservId: 'mx.google.com',
  },
  outlook: {
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp-mail.outlook.com',
    smtpPort: 587,
    smtpSecure: false,          // STARTTLS on 587
    // Microsoft does not emit an RFC 8601 authserv-id; its stamp is the
    // `compauth=` token, which no other provider writes.
    authservMarker: 'compauth=',
  },
};

function env(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : null;
}

// Credentials are resolved as a PAIR, never variable by variable. Falling back
// independently would let a half-configured mailbox pick up one family's
// username and another family's password — a login that fails authentication
// for a reason no log line explains. `families` is tried in order; the first
// one whose user AND password are both set wins, and its name comes back so the
// caller can tell whether Gmail was named explicitly.
function credentialPair(families) {
  for (const f of families) {
    const user = env(f.user);
    const pass = env(f.pass);
    if (user && pass) return { user, pass, family: f.name };
    if (user || pass) {
      console.warn(`[MailAccounts] ${f.user} and ${f.pass} must BOTH be set — ignoring the half that is`);
    }
  }
  return null;
}

// Guess from the address so a single-provider setup needs no PROVIDER var.
function providerFromAddress(address) {
  const dom = String(address || '').split('@')[1] || '';
  if (/(^|\.)gmail\.com$/i.test(dom) || /(^|\.)googlemail\.com$/i.test(dom)) return 'gmail';
  if (/(^|\.)(outlook|hotmail|live|msn)\.com$/i.test(dom)) return 'outlook';
  if (/(^|\.)office365\.com$/i.test(dom)) return 'outlook';
  return null;
}

// ─── Outbound ────────────────────────────────────────────────────────────────
// Returns a nodemailer transport config plus the From address, or null when
// nothing is configured (sending is then skipped, as it always was).
function outboundAccount() {
  const cred = credentialPair([
    { name: 'gmail', user: 'UHSERVICES_GMAIL_USER', pass: 'UHSERVICES_GMAIL_PASSWORD' },
    { name: 'smtp', user: 'SMTP_USER', pass: 'SMTP_PASSWORD' },
    { name: 'gmail', user: 'GMAIL_USER', pass: 'GMAIL_PASSWORD' },
  ]);
  if (!cred) return null;
  const { user, pass } = cred;

  // A variable with GMAIL in its name settles the provider outright. Guessing
  // from the address cannot: a Google Workspace mailbox is store@uhservices.xyz,
  // which looks like a custom host and would otherwise be dialled as one.
  // MAIL_PROVIDER still wins, so an explicit override is never overruled.
  const name = env('MAIL_PROVIDER') || (cred.family === 'gmail' ? 'gmail' : null)
    || providerFromAddress(user) || 'custom';
  const preset = PROVIDERS[name] || {};
  const host = env('SMTP_HOST') || preset.smtpHost || null;
  const port = Number(env('SMTP_PORT') || preset.smtpPort || 587);
  // SMTP_SECURE is only consulted when it is actually set; otherwise implicit
  // TLS is assumed on 465 and STARTTLS everywhere else, which is the rule
  // every mainstream provider follows.
  const secureEnv = env('SMTP_SECURE');
  const secure = secureEnv != null ? /^(1|true|yes)$/i.test(secureEnv) : (port === 465);

  const transport = (!host && preset.smtpService)
    ? { service: preset.smtpService, auth: { user, pass } }
    : { host: host || 'localhost', port, secure, auth: { user, pass } };

  return { transport, user, from: env('SMTP_FROM') || user, provider: name };
}

// ─── Inbound ─────────────────────────────────────────────────────────────────
// One entry per payment method. Two methods pointed at the SAME login are
// collapsed into a single connection by the caller — otherwise the watcher
// would open two IMAP sessions to one mailbox and fetch every message twice.
function imapAccountFor(method) {
  const P = method === 'paypal' ? 'PAYPAL' : 'CASHAPP';
  const cred = credentialPair([
    { name: 'gmail', user: P + '_GMAIL_USER', pass: P + '_GMAIL_PASSWORD' },
    { name: 'imap', user: P + '_IMAP_USER', pass: P + '_IMAP_PASSWORD' },
    { name: 'gmail', user: 'GMAIL_USER', pass: 'GMAIL_PASSWORD' },
  ]);
  if (!cred) return null;
  const { user, pass: password } = cred;

  // An explicit provider wins; then GMAIL in the variable name, which is the
  // only signal that survives a Workspace address on a custom domain; then the
  // address itself. Getting this wrong is not cosmetic — see the note above.
  const name = env(P + '_IMAP_PROVIDER') || (cred.family === 'gmail' ? 'gmail' : null)
    || providerFromAddress(user) || 'custom';
  const preset = PROVIDERS[name] || {};

  return {
    method,
    user,
    password,
    host: env(P + '_IMAP_HOST') || preset.imapHost || null,
    port: Number(env(P + '_IMAP_PORT') || preset.imapPort || 993),
    provider: name,
    // Whose Authentication-Results verdict this mailbox's server writes.
    authservId: env(P + '_IMAP_AUTHSERV') || preset.authservId || null,
    authservMarker: preset.authservMarker || null,
  };
}

// The distinct mailboxes to connect to, each carrying the list of payment
// methods it is allowed to confirm. A mailbox only ever confirms the methods
// routed to it: mail from Cash App arriving in the PayPal inbox is ignored, so
// splitting the inboxes also narrows what each one is trusted for.
function inboundAccounts() {
  const byKey = new Map();
  for (const method of ['paypal', 'cashapp']) {
    const acct = imapAccountFor(method);
    if (!acct) continue;
    if (!acct.host) {
      console.warn(`[MailAccounts] ${method}: no IMAP host — set ${method.toUpperCase()}_IMAP_PROVIDER or _HOST`);
      continue;
    }
    const key = `${acct.user.toLowerCase()}@${acct.host}:${acct.port}`;
    const existing = byKey.get(key);
    if (existing) { existing.methods.push(method); continue; }
    byKey.set(key, { key, ...acct, methods: [method] });
  }
  return Array.from(byKey.values());
}

module.exports = { outboundAccount, inboundAccounts, imapAccountFor, providerFromAddress, PROVIDERS };
