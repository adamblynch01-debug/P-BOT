// Mailbox-split regression tests.
//
// Everything used to ride ONE Gmail login: it sent the order confirmations AND
// was the inbox both payment watchers read. utils/mailAccounts.js gives each of
// the three purposes its own credentials, and these assertions pin the two
// properties that make that safe to ship:
//
//   1. a deployment that sets none of the new vars behaves EXACTLY as before,
//   2. a mailbox is only trusted for the payment methods routed to it, and the
//      DMARC verdict it is checked against is its own provider's.
//
// (2) is the one worth being paranoid about. verifiedSenderDomain is the only
// thing standing between a stranger's email and the confirm path, and it works
// by trusting the receiving server's Authentication-Results stamp. Point a
// mailbox at the wrong provider and either every payment is silently ignored,
// or — much worse — a stamp the sender wrote themselves gets believed.

const path = require('path');

const BACKEND = __dirname;
process.env.GUILD_ID = 'g1';
process.env.API_SECRET = 'secret';
process.env.PORT = '3000';
process.env.PAYPAL_EMAIL = 'store@ghost.example';
process.env.CASHAPP_CASHTAG = '$ghoststore';

// ─── stub db + axios before the watcher requires them ───
const CONFIRMS = [];
let SEEN = new Set();

const dbStub = {
  query: async (sql, params) => {
    if (/INSERT INTO processed_emails/.test(sql)) {
      if (SEEN.has(params[0])) return { rows: [], rowCount: 0 };
      SEEN.add(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM processed_emails/.test(sql)) { SEEN.delete(params[0]); return { rows: [], rowCount: 1 }; }
    if (/FROM orders/.test(sql)) {
      const [, note, method] = params;
      return { rows: [{ id: 'o1', payment_note: note, payment_method: method, total_cents: 1999, status: 'pending' }] };
    }
    return { rows: [], rowCount: 0 };
  },
};
require.cache[require.resolve(path.join(BACKEND, 'db.js'))] = { id: 'db', filename: 'db', loaded: true, exports: dbStub };
require.cache[require.resolve('axios', { paths: [BACKEND] })] = {
  id: 'axios', filename: 'axios', loaded: true,
  exports: {
    post: async (url, body) => {
      if (/internal\//.test(url)) return { data: {} };   // botNotify
      CONFIRMS.push({ url, body });
      return { data: {} };
    },
    get: async () => ({ data: {} }),
  },
};

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  PASS ', name); }
  else { failed++; console.log('  FAIL ', name); }
}

// mailAccounts reads process.env at call time, so each scenario clears the
// variables it does not set — a leftover from an earlier case would otherwise
// make a later one pass for the wrong reason.
const MAIL_VARS = [
  'GMAIL_USER', 'GMAIL_PASSWORD', 'MAIL_PROVIDER',
  'UHSERVICES_GMAIL_USER', 'UHSERVICES_GMAIL_PASSWORD',
  'PAYPAL_GMAIL_USER', 'PAYPAL_GMAIL_PASSWORD',
  'CASHAPP_GMAIL_USER', 'CASHAPP_GMAIL_PASSWORD',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM',
  'PAYPAL_IMAP_USER', 'PAYPAL_IMAP_PASSWORD', 'PAYPAL_IMAP_PROVIDER', 'PAYPAL_IMAP_HOST', 'PAYPAL_IMAP_PORT', 'PAYPAL_IMAP_AUTHSERV',
  'CASHAPP_IMAP_USER', 'CASHAPP_IMAP_PASSWORD', 'CASHAPP_IMAP_PROVIDER', 'CASHAPP_IMAP_HOST', 'CASHAPP_IMAP_PORT', 'CASHAPP_IMAP_AUTHSERV',
];
function setEnv(vars) {
  for (const k of MAIL_VARS) delete process.env[k];
  Object.assign(process.env, vars);
}

const { outboundAccount, inboundAccounts, imapAccountFor, providerFromAddress } =
  require(path.join(BACKEND, 'utils', 'mailAccounts.js'));
const { verifiedSenderDomain, processEmail } =
  require(path.join(BACKEND, 'watchers', 'emailWatcher.js')).__test__;

function run() {
  console.log('\n=== backwards compatibility: GMAIL_* alone ===');
  setEnv({ GMAIL_USER: 'ghoststore.mail@gmail.com', GMAIL_PASSWORD: 'app-password' });
  {
    const out = outboundAccount();
    check('outbound falls back to the Gmail pair', !!out && out.user === 'ghoststore.mail@gmail.com');
    check('outbound guesses gmail from the address', out.provider === 'gmail');
    // The `service: 'gmail'` shorthand meant port 465, which our host cannot
    // reach; the preferred route is now an explicit 587 with 465 behind it.
    check('outbound dials smtp.gmail.com on 587 with STARTTLS',
      out.transport.host === 'smtp.gmail.com' && out.transport.port === 587 && out.transport.secure === false);
    check('465 is kept as a fallback route, not dropped',
      out.transports.length === 2 && out.transports[1].port === 465 && out.transports[1].secure === true);
    check('every route fails faster than the storefront gives up',
      out.transports.every(t => t.connectionTimeout > 0 && t.connectionTimeout < 30000));
    check('From defaults to the authenticated mailbox', out.from === 'ghoststore.mail@gmail.com');

    const inbound = inboundAccounts();
    check('one connection, not two, when both methods share a login', inbound.length === 1);
    check('that one connection is trusted for both methods',
      inbound[0].methods.includes('paypal') && inbound[0].methods.includes('cashapp'));
    check('it still dials imap.gmail.com:993', inbound[0].host === 'imap.gmail.com' && inbound[0].port === 993);
    check('and still checks Google\'s authserv-id', inbound[0].authservId === 'mx.google.com');
  }

  console.log('\n=== nothing configured ===');
  setEnv({});
  check('outbound returns null rather than a broken transport', outboundAccount() === null);
  check('no mailbox to watch means no connection', inboundAccounts().length === 0);

  console.log('\n=== the user\'s split: Outlook out, two separate inboxes ===');
  setEnv({
    SMTP_USER: 'store@outlook.com', SMTP_PASSWORD: 'pw', MAIL_PROVIDER: 'outlook',
    PAYPAL_IMAP_USER: 'paypal.inbox@gmail.com', PAYPAL_IMAP_PASSWORD: 'pw1',
    CASHAPP_IMAP_USER: 'cashapp.inbox@outlook.com', CASHAPP_IMAP_PASSWORD: 'pw2',
  });
  {
    const out = outboundAccount();
    check('outbound uses the Outlook SMTP host', out.transport.host === 'smtp-mail.outlook.com');
    check('outbound uses port 587 with STARTTLS, not implicit TLS',
      out.transport.port === 587 && out.transport.secure === false);
    check('outbound no longer touches the Gmail login', out.user === 'store@outlook.com');

    const inbound = inboundAccounts();
    check('two distinct logins mean two connections', inbound.length === 2);
    const pp = inbound.find(a => a.methods.includes('paypal'));
    const ca = inbound.find(a => a.methods.includes('cashapp'));
    check('each connection serves exactly one method', pp.methods.length === 1 && ca.methods.length === 1);
    check('the Gmail inbox checks Google\'s authserv-id', pp.authservId === 'mx.google.com' && !pp.authservMarker);
    check('the Outlook inbox checks Microsoft\'s compauth marker',
      ca.authservMarker === 'compauth=' && !ca.authservId);
    check('the Outlook inbox dials outlook.office365.com', ca.host === 'outlook.office365.com');
  }

  console.log('\n=== three Gmail logins, the short names ===');
  setEnv({
    UHSERVICES_GMAIL_USER: 'store@uhservices.xyz', UHSERVICES_GMAIL_PASSWORD: 'app-pw-1',
    PAYPAL_GMAIL_USER: 'paypal.uh@gmail.com', PAYPAL_GMAIL_PASSWORD: 'app-pw-2',
    CASHAPP_GMAIL_USER: 'cashapp.uh@gmail.com', CASHAPP_GMAIL_PASSWORD: 'app-pw-3',
  });
  {
    const out = outboundAccount();
    check('outbound takes the UHSERVICES pair', out.user === 'store@uhservices.xyz');
    // The Workspace case: the address ends in a custom domain, so guessing from
    // it would say "custom" and dial localhost. GMAIL in the variable name is
    // the only thing that gets this right.
    check('a Workspace address on a custom domain is still Gmail', out.provider === 'gmail');
    check('and so dials Google\'s SMTP host, not a made-up one',
      out.transport.host === 'smtp.gmail.com' && out.transport.port === 587);

    const inbound = inboundAccounts();
    check('three logins mean two watched inboxes', inbound.length === 2);
    const pp = inbound.find(a => a.methods.includes('paypal'));
    const ca = inbound.find(a => a.methods.includes('cashapp'));
    check('PayPal and Cash App are on separate connections',
      pp.user !== ca.user && pp.methods.length === 1 && ca.methods.length === 1);
    check('neither inbox is the outbound mailbox',
      pp.user !== 'store@uhservices.xyz' && ca.user !== 'store@uhservices.xyz');
    check('both still check Google\'s authserv-id',
      pp.authservId === 'mx.google.com' && ca.authservId === 'mx.google.com');
    check('both dial imap.gmail.com:993',
      pp.host === 'imap.gmail.com' && ca.host === 'imap.gmail.com' && pp.port === 993);
  }

  // A username with no password (or the reverse) must not silently borrow the
  // other family's half — that produces an auth failure no log line explains.
  console.log('\n=== a half-set pair is refused, not mixed ===');
  setEnv({ PAYPAL_GMAIL_USER: 'paypal.uh@gmail.com', GMAIL_USER: 'old@gmail.com', GMAIL_PASSWORD: 'old-pw' });
  {
    const a = imapAccountFor('paypal');
    check('a user with no password falls through to the complete pair', a.user === 'old@gmail.com');
  }
  setEnv({ UHSERVICES_GMAIL_PASSWORD: 'pw', SMTP_USER: 'store@outlook.com', SMTP_PASSWORD: 'pw2' });
  check('a password with no user does not hijack the next family\'s user',
    outboundAccount().user === 'store@outlook.com');

  console.log('\n=== provider detection ===');
  check('gmail.com', providerFromAddress('a@gmail.com') === 'gmail');
  check('googlemail.com', providerFromAddress('a@googlemail.com') === 'gmail');
  check('hotmail.com', providerFromAddress('a@hotmail.com') === 'outlook');
  check('live.com', providerFromAddress('a@live.com') === 'outlook');
  check('a custom domain is not guessed', providerFromAddress('a@ghost.example') === null);
  setEnv({ PAYPAL_IMAP_USER: 'p@ghost.example', PAYPAL_IMAP_PASSWORD: 'pw' });
  check('a custom domain with no host is skipped, not dialled blind', inboundAccounts().length === 0);
  setEnv({
    PAYPAL_IMAP_USER: 'p@ghost.example', PAYPAL_IMAP_PASSWORD: 'pw',
    PAYPAL_IMAP_HOST: 'mail.ghost.example', PAYPAL_IMAP_PORT: '993',
    PAYPAL_IMAP_AUTHSERV: 'mail.ghost.example',
  });
  {
    const a = imapAccountFor('paypal');
    check('an explicit custom host is honoured', a.host === 'mail.ghost.example');
    check('an explicit authserv-id is honoured', a.authservId === 'mail.ghost.example');
  }

  console.log('\n=== whose DMARC verdict is believed ===');
  const GOOGLE = { authservId: 'mx.google.com', authservMarker: null };
  const MICROSOFT = { authservId: null, authservMarker: 'compauth=' };
  const gmailStamp = 'Authentication-Results: mx.google.com; dkim=pass header.i=@paypal.com; spf=pass; dmarc=pass header.from=paypal.com';
  const msStamp = 'Authentication-Results: spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=paypal.com; dkim=pass header.d=paypal.com; dmarc=pass action=none header.from=paypal.com; compauth=pass reason=100';
  const mail = (line) => ({ headerLines: [{ key: 'authentication-results', line }] });

  check('Google stamp accepted by a Google mailbox',
    verifiedSenderDomain(mail(gmailStamp), GOOGLE) === 'paypal.com');
  check('Microsoft stamp accepted by a Microsoft mailbox',
    verifiedSenderDomain(mail(msStamp), MICROSOFT) === 'paypal.com');
  // The cross cases are the whole reason the provider is not cosmetic: a
  // Microsoft-hosted inbox configured as gmail rejects every genuine payment.
  check('Microsoft stamp rejected by a mailbox told it is Google',
    verifiedSenderDomain(mail(msStamp), GOOGLE) === null);
  check('Google stamp rejected by a mailbox told it is Microsoft',
    verifiedSenderDomain(mail(gmailStamp), MICROSOFT) === null);
  check('no rule configured means no trust', verifiedSenderDomain(mail(gmailStamp), {}) === null);
  check('the Gmail rule is still the default when no account is passed',
    verifiedSenderDomain(mail(gmailStamp)) === 'paypal.com');

  // A sender can put whatever they like in a header — the receiving server
  // prepends its own ABOVE it, so only the first one is read and it must start
  // with our provider's id. This is the forgery that the anchor prevents.
  const forged = 'Authentication-Results: evil.example; dmarc=pass header.from=paypal.com; mx.google.com; dmarc=pass header.from=paypal.com';
  check('a sender-supplied verdict is not believed',
    verifiedSenderDomain(mail(forged), GOOGLE) === null);
  // Microsoft's marker has no position to anchor to, so at minimum the token
  // has to be present; a header without it is not Microsoft's.
  check('a header with no compauth is not a Microsoft verdict',
    verifiedSenderDomain(mail(gmailStamp.replace('mx.google.com', 'evil.example')), MICROSOFT) === null);

  console.log('\n=== a mailbox only confirms the methods routed to it ===');
  const paypalMail = {
    messageId: '<split-1@paypal.com>',
    subject: 'You received a payment',
    headerLines: [{ key: 'authentication-results', line: gmailStamp }],
    text: 'Hello store@ghost.example,\n\nYou received $19.99 USD\n\nNote from Buyer\nredfox1234\n\nThanks',
  };
  return (async () => {
    setEnv({});
    CONFIRMS.length = 0; SEEN = new Set();
    await processEmail(paypalMail, { methods: ['paypal'], authservId: 'mx.google.com' });
    check('PayPal mail in the PayPal inbox is processed', CONFIRMS.length === 1);

    CONFIRMS.length = 0; SEEN = new Set();
    await processEmail(paypalMail, { methods: ['cashapp'], authservId: 'mx.google.com' });
    check('the same mail in the Cash App inbox is ignored', CONFIRMS.length === 0);

    CONFIRMS.length = 0; SEEN = new Set();
    await processEmail(paypalMail, { methods: ['paypal', 'cashapp'], authservId: 'mx.google.com' });
    check('a shared inbox still confirms both', CONFIRMS.length === 1);

    // The routing check runs BEFORE the claim, so a misrouted message is not
    // burned in processed_emails — re-pointing the env vars is enough to
    // recover it, with no hand-written DELETE.
    CONFIRMS.length = 0; SEEN = new Set();
    await processEmail(paypalMail, { methods: ['cashapp'], authservId: 'mx.google.com' });
    check('a misrouted message keeps its claim, so it stays reprocessable', SEEN.size === 0);

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
  })();
}

run();
