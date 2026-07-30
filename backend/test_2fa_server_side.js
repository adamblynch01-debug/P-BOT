// Offline tests for the server-side 2FA state machine and the bot-secret gate.
//
// The two things being pinned down here are the ones that were broken:
//
//   1. POST /api/auth/login used to return a 30-day bearer token on the
//      password alone. The TOTP prompt and the Discord DM were page
//      JavaScript that ran AFTER the token was already issued, so `curl` with
//      a stolen password skipped both. A login that requires 2FA must now
//      return NO token.
//   2. Every bot-secret gate was spelled `secret === process.env.API_SECRET`,
//      which is `undefined === undefined` — true — when the variable is
//      missing. botAuthorized() must fail closed instead.
//
// No network, no database: the pg pool is stubbed through require.cache before
// any route module loads.
//
//   node test_2fa_server_side.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

// ─── Stub the DB before routes are required ──────────────
let dbHandler = async () => ({ rows: [] });
const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (text, params) => dbHandler(text, params),
    withTransaction: async (fn) => fn((t, p) => dbHandler(t, p)),
    pool: {},
  },
};

process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';
process.env.API_SECRET = 'test-api-secret-value';

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++; console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++; console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

const { hashPassword } = require('./utils/auth');
const totp = require('./utils/totp');

// ─── Test server ─────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/auth', require('./routes/auth'));
const server = http.createServer(app);

function post(path, body) {
  return request(path, body, null);
}

// Same, with a bearer token so requireAuth resolves a session.
function postAuthed(path, body) {
  return request(path, body, 'test-session-token');
}

function request(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
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

const PASSWORD = 'correct-horse-battery-staple';
const PW_HASH = hashPassword(PASSWORD);
const SECRET = totp.generateSecret();

// Minimal fake of the queries routes/auth.js issues during login.
function makeUser(overrides) {
  return Object.assign({
    id: 42, guild_id: 'test-guild', username: 'victim', email: 'victim@example.com',
    password_hash: PW_HASH, role: 'member', banned: false,
    discord_id: null, discord_verified: false,
    totp_secret: null, totp_enabled: false, balance_cents: 0,
  }, overrides || {});
}

let currentUser = makeUser();
let challengeRow = null;

function routeQuery(text, params) {
  const t = text.replace(/\s+/g, ' ').trim();

  // requireAuth's session lookup: JOIN web_sessions -> web_users.
  if (/FROM web_sessions s/.test(t)) {
    return { rows: params[0] === 'test-session-token' && currentUser ? [currentUser] : [] };
  }

  if (/FROM web_users u/.test(t) && /web_sessions/.test(t) === false && /lower\(u\.username\)/.test(t)) {
    return { rows: currentUser ? [currentUser] : [] };
  }
  if (/INSERT INTO web_login_challenges/.test(t)) {
    challengeRow = {
      id: params[0], web_user_id: params[1], guild_id: params[2],
      kind: params[3], ref: null, attempts: 0, consumed_at: null,
    };
    return { rows: [] };
  }
  if (/FROM web_login_challenges/.test(t) && /JOIN web_users/.test(t)) {
    if (!challengeRow || challengeRow.id !== params[0]) return { rows: [] };
    return { rows: [Object.assign({}, challengeRow, currentUser)] };
  }
  if (/FROM web_login_challenges/.test(t)) {
    if (!challengeRow || challengeRow.id !== params[0] || challengeRow.consumed_at) return { rows: [] };
    return { rows: [challengeRow] };
  }
  if (/UPDATE web_login_challenges SET attempts/.test(t)) {
    if (challengeRow) challengeRow.attempts++;
    return { rows: [] };
  }
  if (/UPDATE web_login_challenges SET consumed_at/.test(t)) {
    if (challengeRow) challengeRow.consumed_at = new Date();
    return { rows: [] };
  }
  if (/FROM web_users u LEFT JOIN balances/.test(t) || (/FROM web_users u/.test(t) && /u\.id = \$1/.test(t))) {
    return { rows: currentUser ? [currentUser] : [] };
  }
  if (/UPDATE web_user_backup_codes SET used_at/.test(t)) {
    return { rows: params[1] === totp.hashBackupCode('AAAABBBB') ? [{ id: 1 }] : [] };
  }
  if (/INSERT INTO web_sessions/.test(t)) return { rows: [] };
  if (/UPDATE web_users SET last_login_at/.test(t)) return { rows: [] };
  return { rows: [] };
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  dbHandler = async (text, params) => routeQuery(text, params);

  // ─── The core regression: no token before the second factor ──
  console.log('\nlogin does not mint a session before 2FA');

  currentUser = makeUser({ totp_enabled: true, totp_secret: SECRET });
  challengeRow = null;
  let res = await post('/api/auth/login', { username: 'victim', password: PASSWORD });
  await check('a correct password alone returns NO token', () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.requires_2fa, true, 'should require 2FA');
    assert.ok(!res.body.token, 'a token was issued before the second factor');
  });
  await check('it returns a challenge id instead', () => {
    assert.ok(res.body.challenge_id, 'no challenge_id returned');
    assert.ok(Array.isArray(res.body.methods) && res.body.methods.includes('totp'));
  });
  await check('the response leaks no password hash or secret', () => {
    const s = JSON.stringify(res.body);
    assert.ok(!/password_hash/.test(s), 'password_hash leaked');
    assert.ok(!s.includes(SECRET), 'TOTP secret leaked to the client');
  });

  const challengeId = res.body.challenge_id;

  // ─── Wrong codes ────────────────────────────────────────
  console.log('\nverify rejects bad codes');

  res = await post('/api/auth/login/verify', { challenge_id: challengeId, code: '000000' });
  await check('a wrong TOTP code is rejected with no token', () => {
    assert.strictEqual(res.status, 401);
    assert.ok(!res.body.token);
  });
  await check('the failed attempt is counted', () => {
    assert.strictEqual(challengeRow.attempts, 1);
  });

  res = await post('/api/auth/login/verify', { challenge_id: 'not-a-real-challenge', code: '123456' });
  await check('an unknown challenge id is rejected', () => {
    assert.strictEqual(res.status, 401);
    assert.ok(!res.body.token);
  });

  // ─── Correct code ───────────────────────────────────────
  console.log('\nverify accepts the real code');

  const goodCode = (function () {
    // Derive the current code the same way the server will.
    const crypto = require('crypto');
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const dec = (str) => {
      let bits = 0, val = 0; const out = [];
      for (const ch of str.toUpperCase()) {
        const i = B32.indexOf(ch); if (i < 0) continue;
        val = (val << 5) | i; bits += 5;
        if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
      }
      return Buffer.from(out);
    };
    const counter = Math.floor(Date.now() / 1000 / 30);
    const msg = Buffer.alloc(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
    const h = crypto.createHmac('sha1', dec(SECRET)).update(msg).digest();
    const o = h[19] & 0xf;
    return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000).padStart(6, '0');
  })();

  res = await post('/api/auth/login/verify', { challenge_id: challengeId, code: goodCode });
  await check('a valid TOTP code mints the session', () => {
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.token, 'no token issued after a valid code');
  });
  await check('the challenge is consumed', () => {
    assert.ok(challengeRow.consumed_at, 'challenge was not marked consumed');
  });

  res = await post('/api/auth/login/verify', { challenge_id: challengeId, code: goodCode });
  await check('the same challenge cannot be replayed', () => {
    assert.strictEqual(res.status, 401);
    assert.ok(!res.body.token);
  });

  // ─── Backup codes ───────────────────────────────────────
  console.log('\nbackup codes');

  challengeRow = null;
  res = await post('/api/auth/login', { username: 'victim', password: PASSWORD });
  const bcChallenge = res.body.challenge_id;
  res = await post('/api/auth/login/verify', { challenge_id: bcChallenge, code: 'AAAABBBB' });
  await check('a valid backup code mints the session', () => {
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.token);
    assert.strictEqual(res.body.used_backup_code, true);
  });

  challengeRow = null;
  res = await post('/api/auth/login', { username: 'victim', password: PASSWORD });
  res = await post('/api/auth/login/verify', { challenge_id: res.body.challenge_id, code: 'ZZZZZZZZ' });
  await check('an unknown backup code is rejected', () => {
    assert.strictEqual(res.status, 401);
    assert.ok(!res.body.token);
  });

  // ─── Attempt ceiling ────────────────────────────────────
  console.log('\nbrute force is bounded');

  challengeRow = null;
  res = await post('/api/auth/login', { username: 'victim', password: PASSWORD });
  const bfChallenge = res.body.challenge_id;
  let last;
  for (let i = 0; i < 10; i++) {
    last = await post('/api/auth/login/verify', { challenge_id: bfChallenge, code: '111111' });
  }
  await check('the challenge is burned after repeated wrong codes', () => {
    assert.ok(last.status === 429 || last.status === 401, `got ${last.status}`);
    assert.ok(!last.body.token);
    assert.ok(challengeRow.consumed_at || challengeRow.attempts >= 8,
      'attempts were never capped');
  });

  // ─── No 2FA configured ──────────────────────────────────
  console.log('\naccounts with no second factor');

  currentUser = makeUser();
  challengeRow = null;
  res = await post('/api/auth/login', { username: 'victim', password: PASSWORD });
  await check('an account with no 2FA logs in directly', () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.requires_2fa, false);
    assert.ok(res.body.token);
  });

  currentUser = makeUser({ discord_id: '123456789012345678', discord_verified: true });
  challengeRow = null;
  res = await post('/api/auth/login', { username: 'victim', password: PASSWORD });
  await check('a Discord-verified account still requires the second factor', () => {
    assert.strictEqual(res.body.requires_2fa, true);
    assert.ok(!res.body.token);
    assert.ok(res.body.methods.includes('discord'));
  });

  // ─── Wrong password ─────────────────────────────────────
  console.log('\nwrong password');

  currentUser = makeUser({ totp_enabled: true, totp_secret: SECRET });
  challengeRow = null;
  res = await post('/api/auth/login', { username: 'victim', password: 'wrong-password' });
  await check('a wrong password gets no challenge and no token', () => {
    assert.strictEqual(res.status, 401);
    assert.ok(!res.body.token);
    assert.ok(!res.body.challenge_id, 'a challenge was handed out for a bad password');
  });

  // ─── botAuthorized fails closed ─────────────────────────
  console.log('\nbotAuthorized fails closed when API_SECRET is unset');

  const authPath = require.resolve('./utils/auth');
  delete require.cache[authPath];
  const saved = process.env.API_SECRET;
  delete process.env.API_SECRET;
  const authNoSecret = require('./utils/auth');
  await check('an empty request is NOT authorized when API_SECRET is missing', () => {
    assert.strictEqual(authNoSecret.botAuthorized({ body: {}, query: {} }), false,
      'undefined === undefined authorized an anonymous caller');
  });
  await check('an explicitly undefined secret is not authorized either', () => {
    assert.strictEqual(authNoSecret.botAuthorized({ body: { secret: undefined }, query: {} }), false);
  });
  await check('botAuthUnavailable reports the misconfiguration', () => {
    assert.strictEqual(authNoSecret.botAuthUnavailable(), true);
  });
  process.env.API_SECRET = saved;

  delete require.cache[authPath];
  const authWithSecret = require('./utils/auth');
  await check('the correct secret is authorized', () => {
    assert.strictEqual(authWithSecret.botAuthorized({ body: { secret: saved }, query: {} }), true);
  });
  await check('a wrong secret is not', () => {
    assert.strictEqual(authWithSecret.botAuthorized({ body: { secret: 'nope' }, query: {} }), false);
  });
  await check('a secret in the query string is accepted (the bot uses GET routes)', () => {
    assert.strictEqual(authWithSecret.botAuthorized({ body: {}, query: { secret: saved } }), true);
  });

  // ─── bearerToken no longer reads ?token= ────────────────
  // ─── Discord linking is not client-asserted ─────────────
  // The old POST /api/auth/confirm-discord took a discord_id from the request
  // body and wrote discord_verified = true. Any signup could therefore claim
  // any snowflake, including the owner's.
  console.log('\nDiscord linking cannot be asserted by the client');

  currentUser = makeUser();
  challengeRow = null;
  let link = await post('/api/auth/confirm-discord', { discord_id: '999888777666555444' });
  await check('confirm-discord with no session is rejected', () => {
    assert.strictEqual(link.status, 401);
  });

  // With a session but a raw discord_id and no pending link, it must refuse:
  // the id is no longer an accepted input at all.
  const savedGet = null;
  link = await postAuthed('/api/auth/confirm-discord', { discord_id: '999888777666555444' });
  await check('a raw discord_id in the body is refused (no pending_id)', () => {
    assert.strictEqual(link.status, 400);
    assert.ok(/pending_id/i.test(link.body.error || ''), 'should demand a pending_id');
  });

  link = await postAuthed('/api/auth/confirm-discord', { pending_id: 'forged-pending-id' });
  await check('a forged pending_id is refused', () => {
    assert.strictEqual(link.status, 400);
    assert.ok(!link.body.success);
  });

  console.log('\nbearerToken ignores the query string');

  await check('a token in the query string is NOT accepted', () => {
    const req = { get: () => '', body: {}, query: { token: 'leaked-in-access-logs' } };
    assert.strictEqual(authWithSecret.bearerToken(req), null);
  });
  await check('the Authorization header still works', () => {
    const req = { get: () => 'Bearer abc123', body: {}, query: {} };
    assert.strictEqual(authWithSecret.bearerToken(req), 'abc123');
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
