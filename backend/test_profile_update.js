// Editing your own profile.
//
// Until now there was no endpoint here at all: the storefront wrote the new
// username, email, avatar and password into localStorage and said "Profile
// updated!". The database never heard about any of it. That surfaced when a
// customer changed their email, turned on email 2FA, and the enrolment code
// went to the address the account was CREATED with — the only one that had
// ever existed. The password half was quieter and worse: you could change your
// password, be told it worked, and still be signed in with the old one.
//
// So what is pinned here is mostly the things that make a profile edit
// dangerous rather than the happy path:
//
//   • the email really moves, and /me agrees afterwards
//   • the password really changes — the OLD one stops working
//   • moving the email or password needs the current password
//   • a Discord-only account (no password) is not locked out of its profile
//   • the new email cannot collide with someone else's
//   • moving the email turns email 2FA OFF, so the factor never points at a
//     mailbox nobody has proved they can read
//   • changing the password drops other sessions but NOT the caller's
//
//   node test_profile_update.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

process.env.GUILD_ID = 'test-guild';
process.env.API_SECRET = 'test-secret';
process.env.STORE_NAME = 'Ghost Store';

// The mailer is never wanted here, but routes/auth.js pulls it in.
const emailPath = require.resolve('./utils/email');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true,
  exports: { sendOrderConfirmation: async () => true, sendLoginCode: async () => true },
};

// Stub the DB before utils/auth is required — it destructures `query` at load
// time, so the order matters (see test_email_2fa.js for what that looks like
// when it goes wrong).
const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (t, p) => exec(t, p), withTransaction: async (fn) => fn(exec), pool: {} },
};

const { hashPassword, verifyPassword } = require('./utils/auth');
const PASSWORD = 'correct horse';
const store = {
  users: [
    {
      id: 1, guild_id: 'test-guild', username: 'buyer', email: 'buyer@example.com',
      avatar: '👻', password_hash: hashPassword(PASSWORD), role: 'member', banned: false,
      totp_enabled: false, totp_secret: null, discord_id: null, discord_verified: false,
      email_2fa_enabled: true, balance_cents: 0,
    },
    {
      id: 2, guild_id: 'test-guild', username: 'taken', email: 'taken@example.com',
      avatar: null, password_hash: hashPassword(PASSWORD), role: 'member', banned: false,
      totp_enabled: false, totp_secret: null, discord_id: null, discord_verified: false,
      email_2fa_enabled: false, balance_cents: 0,
    },
    {
      // Signed up through Discord: there is no password to prove anything with.
      id: 3, guild_id: 'test-guild', username: 'discordonly', email: 'disc@example.com',
      avatar: null, password_hash: null, role: 'member', banned: false,
      totp_enabled: false, totp_secret: null, discord_id: '123456789012345678',
      discord_verified: true, email_2fa_enabled: false, balance_cents: 0,
    },
  ],
  sessions: [],
};
const userById = (id) => store.users.find(u => String(u.id) === String(id));

const exec = async (text, params) => {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const p = params || [];

  if (/FROM web_sessions s/.test(t)) {
    const s = store.sessions.find(x => x.token === p[0] && x.expiresAt > Date.now());
    return { rows: s ? [Object.assign({}, userById(s.userId))] : [] };
  }
  if (/SELECT password_hash FROM web_users WHERE id/.test(t)) {
    const u = userById(p[0]);
    return { rows: u ? [{ password_hash: u.password_hash }] : [] };
  }
  // The uniqueness pre-check.
  if (/SELECT id FROM web_users WHERE guild_id = \$1 AND id <> \$2/.test(t)) {
    const [, id, username, email] = p;
    const hit = store.users.filter(u => String(u.id) !== String(id)).filter(u =>
      u.username.toLowerCase() === String(username).toLowerCase() ||
      String(u.email).toLowerCase() === String(email).toLowerCase());
    return { rows: hit.map(u => ({ id: u.id })) };
  }
  if (/^UPDATE web_users SET username = \$1, email = \$2/.test(t)) {
    // Rebuild the assignment list from the SQL so the test follows whatever
    // the route decided to write rather than assuming a fixed shape.
    const setPart = t.slice(t.indexOf('SET ') + 4, t.indexOf(' WHERE '));
    const idIdx = Number(t.match(/WHERE id = \$(\d+)/)[1]) - 1;
    const u = userById(p[idIdx]);
    if (!u) return { rows: [], rowCount: 0 };
    for (const piece of setPart.split(', ')) {
      const [col, val] = piece.split(' = ');
      if (val === 'false') { u[col] = false; continue; }
      const m = val.match(/^\$(\d+)$/);
      if (m) u[col] = p[Number(m[1]) - 1];
    }
    return { rows: [Object.assign({}, u)], rowCount: 1 };
  }
  if (/DELETE FROM web_sessions WHERE web_user_id = \$1 AND token IS DISTINCT FROM \$2/.test(t)) {
    const before = store.sessions.length;
    store.sessions = store.sessions.filter(s =>
      String(s.userId) !== String(p[0]) || s.token === p[1]);
    return { rows: [], rowCount: before - store.sessions.length };
  }
  if (/UPDATE web_users SET last_login_at/.test(t)) return { rows: [] };
  return { rows: [], rowCount: 0 };
};

// Hand out a session directly — /login would drag the whole 2FA state machine
// into a test that is not about it.
let tokenSeq = 0;
function session(userId) {
  const token = `tok-${++tokenSeq}`;
  store.sessions.push({ token, userId, expiresAt: Date.now() + 3600e3 });
  return token;
}

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
        try { parsed = JSON.parse(raw); } catch { /* non-JSON body is a failure the assertion will show */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const patch = (p, b, t) => call('PATCH', p, b, t);
const get = (p, t) => call('GET', p, null, t);

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + (e && e.message)); process.exitCode = 1; }
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  console.log('\nprofile update');

  await check('an anonymous caller cannot edit a profile', async () => {
    const r = await patch('/api/auth/profile', { username: 'whoever' });
    assert.strictEqual(r.status, 401);
  });

  await check('username and avatar change without a password', async () => {
    const t = session(1);
    const r = await patch('/api/auth/profile', { username: 'buyer2', avatar: '💀' }, t);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.user.username, 'buyer2');
    assert.strictEqual(r.body.user.avatar, '💀');
    assert.strictEqual(userById(1).username, 'buyer2');
  });

  await check('the avatar reaches /me, so another device sees it', async () => {
    const t = session(1);
    const r = await get('/api/auth/me', t);
    assert.strictEqual(r.body.user.avatar, '💀');
  });

  await check('changing the email without the current password is refused', async () => {
    const t = session(1);
    const r = await patch('/api/auth/profile', { email: 'new@example.com' }, t);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(userById(1).email, 'buyer@example.com');
  });

  await check('a wrong current password does not move the email', async () => {
    const t = session(1);
    const r = await patch('/api/auth/profile',
      { email: 'new@example.com', current_password: 'nope' }, t);
    assert.strictEqual(r.status, 401);
    assert.strictEqual(userById(1).email, 'buyer@example.com');
  });

  await check('a malformed email is rejected before anything is written', async () => {
    const t = session(1);
    const r = await patch('/api/auth/profile',
      { email: 'not-an-email', current_password: PASSWORD }, t);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(userById(1).email, 'buyer@example.com');
  });

  await check('an email already in use is a 409, not a silent no-op', async () => {
    const t = session(1);
    const r = await patch('/api/auth/profile',
      { email: 'TAKEN@example.com', current_password: PASSWORD }, t);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(userById(1).email, 'buyer@example.com');
  });

  await check('a username already in use is a 409', async () => {
    const t = session(1);
    const r = await patch('/api/auth/profile', { username: 'taken' }, t);
    assert.strictEqual(r.status, 409);
  });

  // The bug this whole endpoint exists for.
  await check('the email really moves, and email 2FA is turned off with it', async () => {
    const t = session(1);
    assert.strictEqual(userById(1).email_2fa_enabled, true);
    const r = await patch('/api/auth/profile',
      { email: 'real@example.com', current_password: PASSWORD }, t);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.user.email, 'real@example.com');
    assert.strictEqual(r.body.email_2fa_disabled, true);
    assert.strictEqual(userById(1).email, 'real@example.com');
    assert.strictEqual(userById(1).email_2fa_enabled, false);
  });

  await check('/me returns the new address — the DB is what 2FA will mail', async () => {
    const t = session(1);
    const r = await get('/api/auth/me', t);
    assert.strictEqual(r.body.user.email, 'real@example.com');
  });

  await check('re-saving the same address is not treated as a move', async () => {
    const t = session(1);
    userById(1).email_2fa_enabled = true;
    const r = await patch('/api/auth/profile', { email: 'REAL@example.com' }, t);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.email_2fa_disabled, false);
    assert.strictEqual(userById(1).email_2fa_enabled, true, 'the factor survived a no-op save');
    userById(1).email_2fa_enabled = false;
  });

  await check('a short password is refused', async () => {
    const t = session(1);
    const r = await patch('/api/auth/profile',
      { new_password: '12345', current_password: PASSWORD }, t);
    assert.strictEqual(r.status, 400);
  });

  await check('the password really changes and the old hash stops matching', async () => {
    const keep = session(1);
    const other = session(1);
    const r = await patch('/api/auth/profile',
      { new_password: 'a whole new password', current_password: PASSWORD }, keep);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(verifyPassword('a whole new password', userById(1).password_hash), 'new password works');
    assert.ok(!verifyPassword(PASSWORD, userById(1).password_hash), 'old password no longer works');
    assert.strictEqual(r.body.password_changed, true);
    // Other sessions go; the caller's stays, or the customer is thrown out of
    // the tab they just used.
    assert.ok(r.body.sessions_revoked >= 1, 'other sessions were revoked');
    assert.ok(store.sessions.some(s => s.token === keep), "the caller's session survived");
    assert.ok(!store.sessions.some(s => s.token === other), 'the other session is gone');
  });

  await check('a Discord-only account can edit its email with no password', async () => {
    const t = session(3);
    const r = await patch('/api/auth/profile', { email: 'moved@example.com' }, t);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(userById(3).email, 'moved@example.com');
  });

  await check('an empty username is refused rather than saved', async () => {
    const t = session(1);
    const r = await patch('/api/auth/profile', { username: '   ' }, t);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(userById(1).username, 'buyer2');
  });

  await check('an oversized avatar is refused — it is rendered into the page', async () => {
    const t = session(1);
    const r = await patch('/api/auth/profile', { avatar: 'x'.repeat(400) }, t);
    assert.strictEqual(r.status, 400);
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
