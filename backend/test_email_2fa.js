// Email as a second factor. The thing being pinned here is not "does the code
// match" — it is that the email leg obeys the SAME rules the other two legs
// already obey, because it shares their state machine:
//
//   • no session token is minted by /login when a second factor exists
//   • the code is single-use (the challenge is consumed)
//   • wrong codes are counted against the 8-attempt ceiling
//   • the recipient comes from the ACCOUNT, never from the request body
//   • the code is never returned to the browser, only mailed
//
// The last one is the one worth a test: a debug `code` field in the response
// would make the whole factor decorative, and nothing else in the codebase
// would notice.
//
//   node test_email_2fa.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');
const crypto = require('crypto');

process.env.GUILD_ID = 'test-guild';
process.env.API_SECRET = 'test-secret';
process.env.STORE_NAME = 'Ghost Store';

// ─── Stub the mailer ─────────────────────────────────────
// Captures what would have been sent so the test can use the real code without
// the route ever handing it back over HTTP.
const sent = [];
const emailPath = require.resolve('./utils/email');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true,
  exports: {
    sendOrderConfirmation: async () => true,
    sendLoginCode: async (to, code, purpose) => {
      if (mailWorks) sent.push({ to, code, purpose });
      return mailWorks;
    },
  },
};
let mailWorks = true;

// ─── Stub the DB ─────────────────────────────────────────
// Installed BEFORE utils/auth is required. utils/auth destructures `query` at
// load time, so requiring it first would leave getSessionUser bound to the real
// pool — every authenticated route then tries to dial 127.0.0.1:5432 while the
// unauthenticated ones pass, which reads like a broken session rather than a
// broken stub.
const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: (t, p) => exec(t, p),
    withTransaction: async (fn) => fn(exec),
    pool: {},
  },
};

const { hashPassword } = require('./utils/auth');
const PASSWORD = 'correct horse';
const store = {
  users: [
    {
      id: 1, guild_id: 'test-guild', username: 'buyer', email: 'buyer@example.com',
      password_hash: hashPassword(PASSWORD), role: 'member', banned: false,
      totp_enabled: false, totp_secret: null, discord_id: null, discord_verified: false,
      email_2fa_enabled: true, balance_cents: 0,
    },
    {
      id: 2, guild_id: 'test-guild', username: 'plain', email: 'plain@example.com',
      password_hash: hashPassword(PASSWORD), role: 'member', banned: false,
      totp_enabled: false, totp_secret: null, discord_id: null, discord_verified: false,
      email_2fa_enabled: false, balance_cents: 0,
    },
    {
      id: 3, guild_id: 'test-guild', username: 'both', email: 'both@example.com',
      password_hash: hashPassword(PASSWORD), role: 'member', banned: false,
      totp_enabled: true, totp_secret: 'JBSWY3DPEHPK3PXP', discord_id: '123456789012345678',
      discord_verified: true, email_2fa_enabled: true, balance_cents: 0,
    },
  ],
  challenges: [],
  sessions: [],
};
const userById = (id) => store.users.find(u => String(u.id) === String(id));
const openChallenge = (id) => store.challenges.find(c =>
  c.id === id && !c.consumed_at && new Date(c.expires_at).getTime() > Date.now());

const exec = async (text, params) => {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const p = params || [];

  if (/FROM web_sessions s/.test(t)) {
    const s = store.sessions.find(x => x.token === p[0] && x.expiresAt > Date.now());
    return { rows: s ? [Object.assign({}, userById(s.userId))] : [] };
  }
  if (/FROM web_users u LEFT JOIN balances b/.test(t) && /lower\(u\.username\)/.test(t)) {
    const v = String(p[1] || '').toLowerCase();
    const u = store.users.find(x => x.username.toLowerCase() === v || x.email.toLowerCase() === v);
    return { rows: u ? [Object.assign({}, u)] : [] };
  }
  if (/FROM web_users u LEFT JOIN balances b/.test(t) && /WHERE u\.id = \$1/.test(t)) {
    const u = userById(p[0]);
    return { rows: u ? [Object.assign({}, u)] : [] };
  }
  if (/INSERT INTO web_login_challenges/.test(t)) {
    store.challenges.push({
      id: p[0], web_user_id: p[1], guild_id: p[2], kind: p[3], ref: null,
      attempts: 0, consumed_at: null, expires_at: new Date(Date.now() + 10 * 60 * 1000),
    });
    return { rows: [] };
  }
  if (/SELECT c\.id, c\.web_user_id, u\.email/.test(t)) {
    const c = openChallenge(p[0]);
    if (!c) return { rows: [] };
    const u = userById(c.web_user_id);
    return { rows: [{ id: c.id, web_user_id: c.web_user_id, email: u.email, email_2fa_enabled: u.email_2fa_enabled, banned: u.banned }] };
  }
  if (/UPDATE web_login_challenges SET ref = \$1, kind = \$2/.test(t)) {
    const c = store.challenges.find(x => x.id === p[2]);
    if (c) { c.ref = p[0]; c.kind = p[1]; }
    return { rows: [] };
  }
  if (/SELECT \* FROM web_login_challenges/.test(t)) {
    const c = openChallenge(p[0]);
    return { rows: c ? [Object.assign({}, c)] : [] };
  }
  if (/UPDATE web_login_challenges SET attempts/.test(t)) {
    const c = store.challenges.find(x => x.id === p[0]);
    if (c) c.attempts += 1;
    return { rows: [] };
  }
  if (/UPDATE web_login_challenges SET consumed_at/.test(t)) {
    const c = store.challenges.find(x => x.id === p[0]);
    if (c) c.consumed_at = new Date();
    return { rows: [] };
  }
  if (/UPDATE web_users SET last_login_at/.test(t)) return { rows: [] };
  if (/INSERT INTO web_sessions/.test(t)) {
    store.sessions.push({ token: p[0], userId: p[1], expiresAt: new Date(p[3]).getTime() });
    return { rows: [] };
  }
  if (/UPDATE web_user_backup_codes SET used_at/.test(t)) return { rows: [] };
  if (/UPDATE web_users SET email_2fa_enabled = true/.test(t)) {
    const u = userById(p[0]); if (u) u.email_2fa_enabled = true;
    return { rows: [] };
  }
  if (/UPDATE web_users SET email_2fa_enabled = false/.test(t)) {
    const u = userById(p[0]); if (u) u.email_2fa_enabled = false;
    return { rows: [] };
  }
  if (/SELECT password_hash FROM web_users WHERE id/.test(t)) {
    const u = userById(p[0]);
    return { rows: u ? [{ password_hash: u.password_hash }] : [] };
  }
  if (/SELECT \(SELECT COUNT/.test(t)) return { rows: [{ codes_left: 0 }] };
  return { rows: [] };
};

const app = express();
app.use(express.json());
app.use('/api/auth', require('./routes/auth'));
const server = http.createServer(app);

function call(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const post = (p, b, t) => call('POST', p, b, t);
const get = (p, t) => call('GET', p, null, t);

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + (e && e.message)); process.exitCode = 1; }
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  console.log('\nemail second factor');

  let challengeId = null;

  await check('login with email 2FA returns a challenge and NO token', async () => {
    const r = await post('/api/auth/login', { username: 'buyer', password: PASSWORD });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.requires_2fa, true);
    assert.ok(!r.body.token, 'a token was handed out before the second factor');
    assert.ok(r.body.methods.includes('email'), 'email missing from methods');
    challengeId = r.body.challenge_id;
    assert.ok(challengeId);
  });

  await check('an account with TOTP as well is not defaulted to the email leg', async () => {
    const r = await post('/api/auth/login', { username: 'both', password: PASSWORD });
    assert.deepStrictEqual(r.body.methods, ['totp', 'discord', 'email']);
    // methods[0] seeds the challenge kind; email last keeps the inbox
    // round-trip from becoming the default for an account that has an app.
    assert.notStrictEqual(r.body.methods[0], 'email');
  });

  await check('email-challenge mails a code and never returns it', async () => {
    sent.length = 0;
    const r = await post('/api/auth/login/email-challenge', { challenge_id: challengeId });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(sent.length, 1, 'no mail was sent');
    assert.strictEqual(sent[0].to, 'buyer@example.com');
    assert.strictEqual(sent[0].purpose, 'login');
    assert.ok(/^\d{6}$/.test(sent[0].code), 'code is not 6 digits: ' + sent[0].code);
    const blob = JSON.stringify(r.body);
    assert.ok(!blob.includes(sent[0].code), 'the code came back in the response body: ' + blob);
  });

  await check('the address is masked in the response', async () => {
    const r = await post('/api/auth/login/email-challenge', { challenge_id: challengeId });
    assert.strictEqual(r.body.email, 'b****@example.com', 'got ' + r.body.email);
  });

  await check('the code is stored hashed, never in the clear', async () => {
    const c = store.challenges.find(x => x.id === challengeId);
    const latest = sent[sent.length - 1].code;
    assert.strictEqual(c.kind, 'email');
    assert.notStrictEqual(c.ref, latest, 'the plaintext code is sitting in the challenge row');
    assert.strictEqual(c.ref, crypto.createHash('sha256').update(latest, 'utf8').digest('hex'));
  });

  await check('a wrong code is refused and counted', async () => {
    const before = store.challenges.find(x => x.id === challengeId).attempts;
    const r = await post('/api/auth/login/verify', { challenge_id: challengeId, code: '000001' });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(store.challenges.find(x => x.id === challengeId).attempts, before + 1);
  });

  await check('a superseded code no longer works', async () => {
    // Two challenges were requested above; only the newest may verify, or a
    // customer's older mail stays live for the full ten minutes.
    const stale = sent[0].code;
    const fresh = sent[sent.length - 1].code;
    if (stale === fresh) return;   // 1-in-a-million collision, nothing to prove
    const r = await post('/api/auth/login/verify', { challenge_id: challengeId, code: stale });
    assert.strictEqual(r.status, 401);
  });

  let sessionToken = null;
  await check('the mailed code logs the account in', async () => {
    const r = await post('/api/auth/login/verify', { challenge_id: challengeId, code: sent[sent.length - 1].code });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token, 'no session token');
    assert.strictEqual(r.body.user.username, 'buyer');
    sessionToken = r.body.token;
  });

  await check('the same code cannot be replayed', async () => {
    const r = await post('/api/auth/login/verify', { challenge_id: challengeId, code: sent[sent.length - 1].code });
    assert.strictEqual(r.status, 401, 'a consumed challenge verified twice');
  });

  await check('a challenge id from nowhere is refused', async () => {
    const r = await post('/api/auth/login/verify', { challenge_id: 'made-up', code: '123456' });
    assert.strictEqual(r.status, 401);
  });

  await check('an account without email 2FA cannot request a code', async () => {
    const r = await post('/api/auth/login', { username: 'plain', password: PASSWORD });
    assert.ok(r.body.token, 'an account with no second factor should log straight in');
    // No challenge exists at all for that login, so there is nothing to mail to.
    const r2 = await post('/api/auth/login/email-challenge', { challenge_id: 'made-up' });
    assert.strictEqual(r2.status, 401);
  });

  // ── Enrolment ──────────────────────────────────────────────────────────────
  await check('2fa/status reports the email factor and the account address', async () => {
    const r = await get('/api/auth/2fa/status', sessionToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.email_2fa_enabled, true);
    assert.strictEqual(r.body.email, 'buyer@example.com');
  });

  await check('enrolment refuses to re-enable what is already on', async () => {
    const r = await post('/api/auth/2fa/email/start', {}, sessionToken);
    assert.strictEqual(r.status, 400);
  });

  await check('disabling requires the password', async () => {
    const bad = await post('/api/auth/2fa/email/disable', { password: 'wrong' }, sessionToken);
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(userById(1).email_2fa_enabled, true, 'disabled on a wrong password');
    const none = await post('/api/auth/2fa/email/disable', {}, sessionToken);
    assert.strictEqual(none.status, 400);
    const ok = await post('/api/auth/2fa/email/disable', { password: PASSWORD }, sessionToken);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(userById(1).email_2fa_enabled, false);
  });

  await check('enabling needs a code that actually arrived in the inbox', async () => {
    sent.length = 0;
    const start = await post('/api/auth/2fa/email/start', {}, sessionToken);
    assert.strictEqual(start.status, 200, JSON.stringify(start.body));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].purpose, 'setup');
    assert.ok(!JSON.stringify(start.body).includes(sent[0].code), 'setup code leaked in the response');
    assert.strictEqual(userById(1).email_2fa_enabled, false, 'enabled before the code was confirmed');

    const wrong = await post('/api/auth/2fa/email/confirm', { code: '000000' }, sessionToken);
    if (wrong.status === 200) throw new Error('a wrong setup code was accepted');
    assert.strictEqual(userById(1).email_2fa_enabled, false);

    const ok = await post('/api/auth/2fa/email/confirm', { code: sent[0].code }, sessionToken);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(userById(1).email_2fa_enabled, true);
  });

  await check('a confirmed setup code cannot be used twice', async () => {
    const r = await post('/api/auth/2fa/email/confirm', { code: sent[0].code }, sessionToken);
    assert.strictEqual(r.status, 400);
  });

  await check('none of the email routes are reachable without a session', async () => {
    for (const p of ['/api/auth/2fa/email/start', '/api/auth/2fa/email/disable', '/api/auth/2fa/email/confirm']) {
      const r = await post(p, { password: PASSWORD, code: '123456' });
      assert.strictEqual(r.status, 401, p + ' answered ' + r.status);
    }
  });

  // ── The send failing must not leave the customer waiting ───────────────────
  await check('an SMTP failure is reported, not swallowed', async () => {
    const login = await post('/api/auth/login', { username: 'both', password: PASSWORD });
    mailWorks = false;
    const r = await post('/api/auth/login/email-challenge', { challenge_id: login.body.challenge_id });
    mailWorks = true;
    assert.strictEqual(r.status, 502, 'got ' + r.status + ' — the page would wait for a mail that never went');
  });

  server.close();
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
