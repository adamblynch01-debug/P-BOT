require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// ─── Startup environment check ───────────────────────────────────────────────
// There was none. The process started happily with API_SECRET absent, which is
// exactly the condition that made every `secret === process.env.API_SECRET`
// gate authorize anonymous callers (see utils/auth.js botAuthorized). Those
// compares are fixed, but a backend running without its shared secret still
// cannot talk to the bot at all — better to refuse to start than to serve a
// storefront whose delivery and notification paths are quietly broken.
(function checkEnvironment() {
  const required = {
    DATABASE_URL: 'no database connection is possible',
    API_SECRET: 'the bot and watchers cannot authenticate to this backend',
    GUILD_ID: 'every query is scoped by guild and would match nothing',
  };
  const recommended = {
    BOT_INTERNAL_URL: 'defaults to localhost — Discord notifications will not reach the bot',
    WEBHOOK_SECRET: 'the crypto webhook endpoint will reject all callbacks',
    PAYPAL_EMAIL: 'PayPal checkout shows a placeholder address',
    CASHAPP_CASHTAG: 'Cash App checkout shows a placeholder cashtag',
    BLOCKCYPHER_TOKEN: 'crypto address monitoring is rate-limited or unavailable',
  };

  const missingRequired = Object.keys(required).filter(k => !process.env[k]);
  const missingRecommended = Object.keys(recommended).filter(k => !process.env[k]);

  // Not a plain key check any more: GMAIL_USER used to be the one and only way
  // to feed the payment watcher, but each method can now point at its own
  // mailbox, so naming a single variable here would warn about a perfectly
  // configured split deployment. Ask the resolver what it actually found.
  try {
    const { inboundAccounts, outboundAccount } = require('./utils/mailAccounts');
    const inbound = inboundAccounts();
    if (!inbound.length) {
      console.warn('[Startup] no payment mailbox configured — the email payment watcher cannot start ' +
        '(set PAYPAL_GMAIL_USER/_PASSWORD and CASHAPP_GMAIL_USER/_PASSWORD, or the GMAIL_USER/GMAIL_PASSWORD pair)');
    } else {
      // Names and routing only. The addresses themselves are never logged.
      console.log(`[Startup] payment mailboxes: ${inbound.map(a => `${a.methods.join('+')} via ${a.provider}`).join(', ')}`);
    }
    // An HTTPS provider is a complete outbound setup on its own — this host
    // blocks outbound SMTP, so a deployment with only an API key is the
    // working case, not the broken one.
    const { httpMailer } = require('./utils/mailHttp');
    const outHttp = httpMailer((outboundAccount() || {}).from);
    if (outHttp) {
      console.log(`[Startup] outbound mail: ${outHttp.label} HTTPS API`);
    } else if (!outboundAccount()) {
      console.warn('[Startup] no outbound mail account — order confirmations and email 2FA codes will not send ' +
        '(set RESEND_API_KEY or BREVO_API_KEY plus MAIL_FROM, or the UHSERVICES_GMAIL_USER/_PASSWORD SMTP pair)');
    }
  } catch (e) {
    console.warn('[Startup] mail account check failed:', e.message);
  }

  for (const k of missingRequired) console.error(`[Startup] MISSING ${k} — ${required[k]}`);
  for (const k of missingRecommended) console.warn(`[Startup] missing ${k} — ${recommended[k]}`);

  // SET but not usable, which is the state nothing was looking for. Production
  // ran for months with CASHAPP_CASHTAG = " your $cashtag": non-empty, so every
  // check above passed it, and checkout published it to buyers as the address
  // to send money to.
  let addressProblems = () => [];
  try { ({ addressProblems } = require('./utils/paymentAddress')); } catch (_) {}
  for (const line of addressProblems()) console.error(`[Startup] ${line}`);

  // The other half of the same question. An address a customer can pay is
  // worthless if the receipt for it cannot be matched back to an order, and
  // that is not hypothetical — every PayPal payment this store took was
  // refused by the watcher because PAYPAL_MERCHANT_NAME was never set and
  // PayPal receipts do not contain an email address to match instead.
  let confirmationProblems = () => [];
  try { ({ confirmationProblems } = require('./watchers/emailWatcher')); } catch (_) {}
  for (const line of confirmationProblems()) console.error(`[Startup] ${line}`);

  if (missingRequired.length) {
    console.error('[Startup] Refusing to start. Set the above on the Railway service.');
    process.exit(1);
  }
  if (!missingRecommended.length && !addressProblems().length && !confirmationProblems().length) {
    console.log('[Startup] Environment check passed.');
  }
})();

// Railway terminates TLS at its edge and forwards to us over plain HTTP, so
// req.ip is the proxy's address unless we trust the X-Forwarded-For header.
// The rate limiters in utils/rateLimit.js key on req.ip — without this every
// visitor collapses into one bucket and the per-IP limits would lock out real
// customers the moment anyone hit them. '1' = trust exactly one proxy hop
// (Railway's), so a client-supplied X-Forwarded-For can't spoof its way past
// the limiter by prepending fake entries.
app.set('trust proxy', 1);

app.use(cors({
  origin: ['https://zeropoint.wtf', 'https://www.zeropoint.wtf', 'https://uhservices.xyz', 'https://www.uhservices.xyz'],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.options('*', cors());

// Everything is JSON, and everything is small — express.json()'s default 100kb
// ceiling is deliberate: it is the cheapest brake there is on a request that
// would otherwise buffer arbitrary megabytes into memory before any auth check
// runs. Exactly one endpoint has to carry more than that, because a customer's
// review can have a screenshot attached, so it parses its own body with its own
// limit (routes/reviews.js) and this parser stands aside for it. Adding a route
// here is a deliberate act; raising the global limit instead would hand every
// unauthenticated endpoint on the API the same allowance.
const BIG_BODY_ROUTES = [
  { method: 'POST', path: '/api/reviews' },
  // Profile picture upload. Same shape as the review screenshot: a data URL in
  // JSON, decoded and signature-checked by the route, which sets its own limit.
  { method: 'POST', path: '/api/auth/avatar' },
  // Game tile banner. `path` is a RegExp here because the game name sits in the
  // middle of the route. Anchored at both ends and with the name segment
  // spelled out as "anything but a slash", so it can only ever match the one
  // endpoint — a loose pattern here would quietly hand the 4MB allowance to
  // whatever else lives under /api/game-tiles later.
  { method: 'POST', path: /^\/api\/game-tiles\/[^/]+\/banner$/ },
];
const jsonParser = express.json();
app.use((req, res, next) => {
  // '/api/reviews/' and '/api/reviews' are the same endpoint to the router, so
  // they have to be the same endpoint to this test — otherwise a trailing slash
  // silently reinstates the 100kb limit and the upload fails with a 413 that
  // points at nothing.
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
  const match = (r) => (r.path instanceof RegExp ? r.path.test(path) : r.path === path);
  if (BIG_BODY_ROUTES.some(r => r.method === req.method && match(r))) return next();
  return jsonParser(req, res, next);
});

// ─── Routes ─────────────────────────────────────────────
app.use('/api/orders',   require('./routes/orders'));
app.use('/api/products', require('./routes/products'));
app.use('/api/stock',    require('./routes/stock'));
app.use('/api/config',   require('./routes/config'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/balance',  require('./routes/balance'));
app.use('/api/reviews',  require('./routes/reviews'));
app.use('/api/status',   require('./routes/status'));
app.use('/api/updates',  require('./routes/updates'));
app.use('/api/state',    require('./routes/state'));
app.use('/api/reseller', require('./routes/reseller'));
app.use('/api/tickets',  require('./routes/tickets'));
app.use('/api/alerts',   require('./routes/alerts'));
app.use('/api/downloads', require('./routes/downloads'));
app.use('/api/coupons', require('./routes/coupons'));
app.use('/api/game-tiles', require('./routes/gameTiles'));
app.use('/api/unsplash', require('./routes/unsplash'));
app.use('/api/supplier', require('./routes/supplier'));
app.use('/api/vault', require('./routes/vault'));

// Discord access gate - with error handling
try {
  app.use('/api/access', require('./routes/access'));
  console.log('[Startup] Discord access gate loaded');
} catch (error) {
  console.error('[Startup] Failed to load Discord access gate:', error.message);
  console.error('[Startup] Stack:', error.stack);
}

// ─── Health ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', store: process.env.STORE_NAME || 'ONTOP Shop' }));

// ─── 404 ────────────────────────────────────────────────
// Without this Express answers an unknown /api path with its HTML default
// page, which a fetch() then fails to parse — the caller sees a confusing
// syntax error instead of "no such endpoint".
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'No such endpoint' });
});

// ─── Error handler ──────────────────────────────────────
// Express needs the 4-arg signature to recognise this as an error handler.
// Anything a route throws outside its own try/catch used to fall through to
// Express's default, which replies with a stack trace in the body.
app.use((err, req, res, next) => {
  console.error(`[Error] ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(err && err.statusCode ? err.statusCode : 500).json({ error: 'Internal server error' });
});

// ─── Last-resort process guards ─────────────────────────
// An unhandled rejection anywhere (a watcher, a fire-and-forget notify) kills
// the process on modern Node, taking the whole storefront down. Log it and
// stay up: the alternative is a payment backend that dies from a Discord
// timeout.
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err && err.stack ? err.stack : err);
});

// ─── Start ──────────────────────────────────────────────
// Guarded so a test can `require('./server')` and drive the REAL app — with
// the real body-parser exemptions and the real route mounting — without
// starting the email and crypto watchers against production alongside it.
// Railway runs `node server.js`, so this is always true there.
module.exports = app;
if (require.main !== module) return;

const PORT = process.env.PORT || 3000;
require('./routes/config').loadConfigFromDB().finally(() => {
  const server = app.listen(PORT, () => {
    console.log(`[ONTOP] Backend running on port ${PORT}`);
    require('./watchers/emailWatcher').start();
    require('./watchers/cryptoWatcher').start();
    // Closes orders nobody paid for. Both watchers above already refuse to
    // settle anything past its deadline, so without this an expired order is
    // dead but still reads as 'waiting' everywhere staff look.
    require('./watchers/orderExpiry').start();
  });

  // Railway sends SIGTERM on every deploy. Without this the process is killed
  // mid-request, which can cut an in-flight checkout between the wallet debit
  // and the delivery. Stop accepting new connections, let the open ones
  // finish, then exit.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ONTOP] ${signal} received — finishing in-flight requests…`);
    server.close(() => {
      console.log('[ONTOP] Closed cleanly.');
      process.exit(0);
    });
    // Don't hang forever on a stuck connection.
    setTimeout(() => {
      console.warn('[ONTOP] Forcing exit after shutdown timeout.');
      process.exit(0);
    }, 15000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});
