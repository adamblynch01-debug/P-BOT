// SIGN IN / SIGN UP WITH GOOGLE.
//
// One button does both errands, because that is what the customer's single
// press means. Everything interesting here is in what that button must NOT be
// able to do:
//
//   • it must not hand a 30-day session token to a URL. The redirect carries a
//     single-use claim with a 2-minute life, POSTed back for the real token in
//     a response body — the same rule utils/auth.js already enforced when it
//     deleted its ?token= fallback.
//   • it must not bypass a second factor. Google settles who owns a mailbox; it
//     cannot settle an authenticator app. An enrolled account gets the ordinary
//     web_login_challenges row, so turning Google on cannot weaken an account
//     that was already protected.
//   • it must not take over an account. Resolution is sub → email → create, and
//     step two is only safe because an unverified Google email is refused
//     outright: otherwise anyone who can set an arbitrary address on a Google
//     account owns the matching account here for the price of one click.
//   • a link round trip and a login round trip share a callback, and the errand
//     is decided when the state is minted — never from the returning URL.
//
// And one thing it must not break: an account created this way has NO password.
// That is a genuinely new state for this codebase, and three routes used to
// gate on the current password — so enabling 2FA on a Google-only account would
// have been a one-way door. verifyReauth() is pinned here for that reason.
//
//   node test_google_oauth.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const http = require('http');

process.env.GUILD_ID = 'test-guild';
process.env.API_SECRET = 'test-secret';
process.env.BACKEND_PUBLIC_URL = 'https://backend.example';
process.env.STOREFRONT_ORIGINS = 'https://uhservices.xyz,https://www.uhservices.xyz';

// The child run (bottom of the file) re-executes this file with the Google
// credentials removed, to prove the feature is genuinely inert until the owner
// sets them — the storefront is hand-uploaded and asks /oauth-config whether to
// draw the button at all.
const OFF = process.env.GX_GOOGLE_OFF === '1';
if (!OFF) {
  process.env.GOOGLE_CLIENT_ID = 'google-client-id-123';
  process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret-456';
} else {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
}

// A second child run, for round 29 item 5: Google's consent screen reads "to
// continue to <host of redirect_uri>", so the only way it says uhservices.xyz
// is for the callback itself to live there. This leg proves the override moves
// GOOGLE's callback and leaves DISCORD's where it was — a single shared
// variable would move both, and Discord rejects any redirect_uri its developer
// portal has not been told about.
const DOMAIN = process.env.GX_GOOGLE_DOMAIN === '1';
const CUSTOM_CB = 'https://api.uhservices.xyz/api/auth/google-oauth/callback';
if (DOMAIN) {
  process.env.GOOGLE_REDIRECT_URI = CUSTOM_CB;
  // Only here: the other legs assert on a Discord-less config.
  process.env.DISCORD_CLIENT_ID = 'discord-client-id-123';
  process.env.DISCORD_CLIENT_SECRET = 'discord-client-secret-456';
} else {
  delete process.env.GOOGLE_REDIRECT_URI;
}

const totp = require('./utils/totp');
const TOTP_SECRET = totp.generateSecret();
const liveTotpCode = () => {
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
  const msg = Buffer.alloc(8);
  let c = Math.floor(Date.now() / 1000 / 30);
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const h = crypto.createHmac('sha1', dec(TOTP_SECRET)).update(msg).digest();
  const o = h[19] & 0xf;
  return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000).padStart(6, '0');
};

// ─── Stub the DB (before utils/auth binds `query`) ───────
let nextId = 100;
const store = {
  users: [
    // A password account that has never seen Google. Its address is the one the
    // first-link path has to find.
    {
      id: 1, guild_id: 'test-guild', username: 'buyer', email: 'buyer@example.com',
      password_hash: 'salt:hash', role: 'member', banned: false, avatar_version: 0,
      totp_enabled: false, totp_secret: null, discord_id: null, discord_verified: false,
      email_2fa_enabled: false, google_id: null, google_email: null, balance_cents: 0,
    },
    // Already signed up with Google once.
    {
      id: 2, guild_id: 'test-guild', username: 'returning', email: 'returning@example.com',
      password_hash: null, role: 'member', banned: false, avatar_version: 0,
      totp_enabled: false, totp_secret: null, discord_id: null, discord_verified: false,
      email_2fa_enabled: false, google_id: 'sub-returning', google_email: 'returning@example.com',
      balance_cents: 0,
    },
    // Banned.
    {
      id: 3, guild_id: 'test-guild', username: 'banned', email: 'banned@example.com',
      password_hash: null, role: 'member', banned: true, avatar_version: 0,
      totp_enabled: false, totp_secret: null, discord_id: null, discord_verified: false,
      email_2fa_enabled: false, google_id: 'sub-banned', google_email: 'banned@example.com',
      balance_cents: 0,
    },
    // Google-only AND carrying an authenticator: the account that proves Google
    // does not skip the second factor, and the one that would have been locked
    // into its own 2FA forever without verifyReauth().
    {
      id: 4, guild_id: 'test-guild', username: 'careful', email: 'careful@example.com',
      password_hash: null, role: 'member', banned: false, avatar_version: 0,
      totp_enabled: true, totp_secret: TOTP_SECRET, discord_id: null, discord_verified: false,
      email_2fa_enabled: false, google_id: 'sub-careful', google_email: 'careful@example.com',
      balance_cents: 0,
    },
    // Holds a Google identity that is NOT the one about to come back.
    {
      id: 5, guild_id: 'test-guild', username: 'taken', email: 'taken@example.com',
      password_hash: 'salt:hash', role: 'member', banned: false, avatar_version: 0,
      totp_enabled: false, totp_secret: null, discord_id: null, discord_verified: false,
      email_2fa_enabled: false, google_id: 'sub-somebody-else', google_email: 'other@gmail.com',
      balance_cents: 0,
    },
  ],
  sessions: [{ token: 'sess-buyer', userId: 1 }, { token: 'sess-careful', userId: 4 }],
  challenges: [],
  balances: [],
};
const userById = (id) => store.users.find(u => String(u.id) === String(id));
const row = (u) => Object.assign({}, u);

const exec = async (text, params) => {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const p = params || [];

  if (/FROM web_sessions s/.test(t)) {
    const s = store.sessions.find(x => x.token === p[0]);
    return { rows: s ? [row(userById(s.userId))] : [] };
  }
  // ── link mode ──
  if (/SELECT id FROM web_users WHERE guild_id = \$1 AND google_id = \$2 AND id <> \$3/.test(t)) {
    return { rows: store.users.filter(u => u.google_id === p[1] && String(u.id) !== String(p[2])).map(u => ({ id: u.id })) };
  }
  // Loose about the columns BETWEEN google_email and the WHERE: round 29 item 4
  // added google_avatar here, and the stub's exact-match regex stopped matching,
  // so the link silently never landed and two cases failed as if the product had
  // broken. A stub that pins the whole statement fails on every future column.
  if (/UPDATE web_users SET google_id = \$1, google_email = \$2.* WHERE id = \$3 AND guild_id = \$4/.test(t)) {
    const u = userById(p[2]);
    if (u) { u.google_id = p[0]; u.google_email = p[1]; if (p[4] !== undefined) u.google_avatar = p[4]; }
    return { rows: [] };
  }
  // ── resolution ──
  // Order matters: the post-race re-read matches BOTH columns and would be
  // answered by the by-sub branch if that ran first, and POST /login's lookup
  // shares the same SELECT as the by-email one.
  if (/lower\(u\.username\) = lower\(\$2\)/.test(t)) {
    const v = String(p[1] || '').toLowerCase();
    const u = store.users.find(x => x.username.toLowerCase() === v || x.email.toLowerCase() === v);
    return { rows: u ? [row(u)] : [] };
  }
  if (/u\.google_id = \$2 OR lower\(u\.email\) = lower\(\$3\)/.test(t)) {
    const u = store.users.find(x => x.google_id === p[1] ||
      x.email.toLowerCase() === String(p[2]).toLowerCase());
    return { rows: u ? [row(u)] : [] };
  }
  if (/WHERE u\.guild_id = \$1 AND u\.google_id = \$2/.test(t)) {
    const u = store.users.find(x => x.google_id && x.google_id === p[1]);
    return { rows: u ? [row(u)] : [] };
  }
  if (/WHERE u\.guild_id = \$1 AND lower\(u\.email\) = lower\(\$2\)/.test(t)) {
    const u = store.users.find(x => x.email.toLowerCase() === String(p[1]).toLowerCase());
    return { rows: u ? [row(u)] : [] };
  }
  if (/WHERE u\.id = \$1 AND u\.guild_id = \$2/.test(t)) {
    const u = userById(p[0]);
    return { rows: u ? [row(u)] : [] };
  }
  if (/UPDATE web_users SET google_id = \$1, google_email = \$2 WHERE id = \$3$/.test(t)) {
    const u = userById(p[2]); if (u) { u.google_id = p[0]; u.google_email = p[1]; }
    return { rows: [] };
  }
  if (/SELECT 1 FROM web_users WHERE guild_id = \$1 AND lower\(username\) = lower\(\$2\)/.test(t)) {
    const hit = store.users.some(u => u.username.toLowerCase() === String(p[1]).toLowerCase());
    return { rows: hit ? [{ '?column?': 1 }] : [] };
  }
  if (/INSERT INTO web_users \(guild_id, username, email, google_id, google_email/.test(t)) {
    const u = {
      id: nextId++, guild_id: p[0], username: p[1], email: p[2], password_hash: null,
      role: 'member', banned: false, avatar_version: 0,
      totp_enabled: false, totp_secret: null, discord_id: null, discord_verified: false,
      email_2fa_enabled: false, google_id: p[3], google_email: p[4], balance_cents: 0,
    };
    store.users.push(u);
    return { rows: [row(u)] };
  }
  if (/INSERT INTO balances/.test(t)) { store.balances.push({ userId: p[0] }); return { rows: [] }; }
  if (/INSERT INTO web_login_challenges/.test(t)) {
    store.challenges.push({ id: p[0], web_user_id: p[1], kind: p[3] });
    return { rows: [] };
  }
  if (/UPDATE web_users SET last_login_at/.test(t)) return { rows: [] };
  if (/INSERT INTO web_sessions/.test(t)) {
    store.sessions.push({ token: p[0], userId: p[1] });
    return { rows: [] };
  }
  // ── reauth / disable ──
  if (/SELECT \* FROM web_users WHERE id = \$1/.test(t)) {
    const u = userById(p[0]);
    return { rows: u ? [row(u)] : [] };
  }
  if (/UPDATE web_user_backup_codes SET used_at/.test(t)) return { rows: [] };
  if (/UPDATE web_users SET totp_secret = NULL, totp_enabled = false/.test(t)) {
    const u = userById(p[0]); if (u) { u.totp_enabled = false; u.totp_secret = null; }
    return { rows: [] };
  }
  if (/DELETE FROM web_user_backup_codes/.test(t)) return { rows: [] };
  if (/SELECT \(SELECT COUNT/.test(t)) return { rows: [{ codes_left: 0 }] };
  return { rows: [] };
};

const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (t, p) => exec(t, p), withTransaction: async (fn) => fn(exec), pool: {} },
};

// ─── Stub axios (Google's token + userinfo endpoints) ────
let identity = { sub: 'sub-new', email: 'newcomer@gmail.com', email_verified: true, name: 'New Comer' };
let tokenExchangeWorks = true;
let tokenResponse = { access_token: 'tok' };
let lastTokenBody = null;
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    post: async (url, body) => {
      if (/oauth2\.googleapis\.com\/token/.test(url)) {
        // Kept so the redirect_uri sent here can be compared with the one sent
        // to the consent screen. Google compares them too, and answers a
        // mismatch with invalid_grant — which reads like a broken code.
        lastTokenBody = body;
        if (!tokenExchangeWorks) throw new Error('invalid_grant');
        return { data: tokenResponse };
      }
      if (/oauth2\/token/.test(url)) return { data: { access_token: 'tok' } };
      if (/initiate-2fa/.test(url)) return { data: { userId: 'sb-session' } };
      return { data: {} };
    },
    get: async (url) => {
      if (/oauth2\/v3\/userinfo/.test(url)) return { data: identity };
      return { data: {} };
    },
  },
};

const app = express();
app.use(express.json());
app.use('/api/auth', require('./routes/auth'));
const server = http.createServer(app);

function call(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const isGet = method === 'GET';
    const data = JSON.stringify(body || {});
    // No Content-Length on a GET: express sits waiting for a body this helper
    // never sends, and the suite hangs with no output.
    const headers = isGet ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, location: res.headers.location || '' });
      });
    });
    req.on('error', reject);
    req.end(isGet ? undefined : data);
  });
}

const stateOf = (url) => new URL(url).searchParams.get('state');
const backParams = (loc) => new URL(loc).searchParams;

// Drive one whole round trip: mint a login state, come back with it.
async function signInWithGoogle(returnTo) {
  const start = await call('GET', '/api/auth/google-oauth/start' + (returnTo ? '?return_to=' + encodeURIComponent(returnTo) : ''));
  const back = await call('GET', '/api/auth/google-oauth/callback?code=abc&state=' + stateOf(start.location));
  return back;
}

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + (e && e.message)); process.exitCode = 1; }
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  // ── the custom-domain half, run as a child process ─────────────────────────
  if (DOMAIN) {
    console.log('\ngoogle sign-in, callback moved to a uhservices.xyz host');

    await check('the consent screen is sent the custom callback', async () => {
      const r = await call('GET', '/api/auth/google-oauth/start');
      assert.strictEqual(r.status, 302, JSON.stringify(r.body));
      const sent = new URL(r.location).searchParams.get('redirect_uri');
      assert.strictEqual(sent, CUSTOM_CB);
      // The screenshot in round 29: "to continue to captivating-happiness-
      // production-c944.up.railway.app". This host is what the customer reads.
      assert.strictEqual(new URL(sent).hostname, 'api.uhservices.xyz');
    });

    await check('the token exchange sends the SAME callback, byte for byte', async () => {
      // Google compares the two and answers a mismatch with invalid_grant,
      // which surfaces as "Google sign-in failed" with the reason nowhere.
      const start = await call('GET', '/api/auth/google-oauth/start');
      lastTokenBody = null;
      await call('GET', '/api/auth/google-oauth/callback?code=abc&state=' + stateOf(start.location));
      assert.ok(lastTokenBody, 'the token exchange never happened');
      assert.strictEqual(new URLSearchParams(lastTokenBody).get('redirect_uri'), CUSTOM_CB);
    });

    await check('moving Google does NOT move Discord', async () => {
      // The reason these are two variables. Discord refuses any redirect_uri
      // not listed in its developer portal, so dragging it along with a Google
      // branding change would break Discord login on deploy.
      const r = await call('GET', '/api/auth/discord-oauth/start');
      assert.strictEqual(r.status, 302, JSON.stringify(r.body));
      const sent = new URL(r.location).searchParams.get('redirect_uri');
      assert.strictEqual(sent, 'https://backend.example/api/auth/discord-oauth/callback');
    });

    await check('the storefront still learns nothing but booleans', async () => {
      const r = await call('GET', '/api/auth/oauth-config');
      assert.deepStrictEqual(Object.keys(r.body).sort(), ['discord', 'google'],
        'a callback URL is not a secret, but this route is the wrong place to grow one');
    });

    server.close();
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  }

  // ── the unconfigured half, run as a child process ──────────────────────────
  if (OFF) {
    console.log('\ngoogle sign-in, credentials NOT set');

    await check('/oauth-config reports google: false', async () => {
      const r = await call('GET', '/api/auth/oauth-config');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.google, false,
        'the storefront draws the button off this flag — true here means a button that only ever errors');
    });

    await check('the config endpoint names no secret either way', async () => {
      const r = await call('GET', '/api/auth/oauth-config');
      assert.deepStrictEqual(Object.keys(r.body).sort(), ['discord', 'google'],
        'this route is public: booleans only');
    });

    await check('/start refuses rather than redirecting somewhere useless', async () => {
      const r = await call('GET', '/api/auth/google-oauth/start');
      assert.strictEqual(r.status, 500);
      assert.strictEqual(r.location, '', 'sent the customer to Google with no client_id');
    });

    await check('link-start refuses with a JSON error the panel can show', async () => {
      const r = await call('POST', '/api/auth/google-oauth/link-start', {}, 'sess-buyer');
      assert.strictEqual(r.status, 503);
      assert.ok(r.body.error);
    });

    await check('2fa/status reports google_available: false', async () => {
      const r = await call('GET', '/api/auth/2fa/status', null, 'sess-buyer');
      assert.strictEqual(r.body.google_available, false);
    });

    server.close();
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  }

  console.log('\ngoogle sign-in / sign-up');

  // ── discovery ──────────────────────────────────────────────────────────────
  await check('/oauth-config reports google: true once the env vars exist', async () => {
    const r = await call('GET', '/api/auth/oauth-config');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.google, true);
    const blob = JSON.stringify(r.body);
    assert.ok(!blob.includes('google-client-secret-456'), 'the client secret is in a public response');
    assert.ok(!blob.includes('google-client-id-123'), 'no need to publish the client id either');
  });

  // ── the consent URL ────────────────────────────────────────────────────────
  let startUrl = null;
  await check('/start redirects to Google with the right request', async () => {
    const r = await call('GET', '/api/auth/google-oauth/start');
    assert.strictEqual(r.status, 302, JSON.stringify(r.body));
    startUrl = r.location;
    const u = new URL(startUrl);
    assert.strictEqual(u.host, 'accounts.google.com');
    assert.strictEqual(u.searchParams.get('client_id'), 'google-client-id-123');
    assert.strictEqual(u.searchParams.get('response_type'), 'code',
      'the implicit flow would put a token in the browser; the secret stays on the server');
    assert.strictEqual(u.searchParams.get('scope'), 'openid email profile');
    assert.strictEqual(u.searchParams.get('redirect_uri'),
      'https://backend.example/api/auth/google-oauth/callback');
    assert.strictEqual(u.searchParams.get('prompt'), 'select_account',
      'without this, a customer with several Google accounts is silently signed into the wrong store account');
    assert.ok(u.searchParams.get('state'), 'no state — CSRF protection missing');
  });

  await check('an unknown state is refused and nothing is created', async () => {
    const before = store.users.length;
    const r = await call('GET', '/api/auth/google-oauth/callback?code=abc&state=not-a-real-state');
    assert.ok(/google_login_error=/.test(r.location), 'got ' + r.location);
    assert.strictEqual(store.users.length, before);
  });

  await check('a state is single-use', async () => {
    identity = { sub: 'sub-returning', email: 'returning@example.com', email_verified: true, name: 'Returning' };
    const state = stateOf(startUrl);
    await call('GET', '/api/auth/google-oauth/callback?code=abc&state=' + state);
    const replay = await call('GET', '/api/auth/google-oauth/callback?code=abc&state=' + state);
    identity = { sub: 'sub-new', email: 'newcomer@gmail.com', email_verified: true, name: 'New Comer' };
    assert.ok(/_error=/.test(replay.location), 'a replayed state was accepted: ' + replay.location);
  });

  await check('a state minted for Discord cannot satisfy the Google callback', async () => {
    // Separate maps, deliberately. One shared map and a state from either
    // provider would open the other provider's callback.
    process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'd-id';
    const d = await call('GET', '/api/auth/discord-oauth/start');
    if (!d.location) return;                    // Discord not configured in this run
    const r = await call('GET', '/api/auth/google-oauth/callback?code=abc&state=' + stateOf(d.location));
    assert.ok(/google_login_error=/.test(r.location), 'got ' + r.location);
  });

  await check('return_to outside STOREFRONT_ORIGINS is ignored', async () => {
    // An account that already exists, so this check does not consume the
    // brand-new identity the sign-UP check below is about to assert on.
    identity = { sub: 'sub-returning', email: 'returning@example.com', email_verified: true, name: 'Returning' };
    const back = await signInWithGoogle('https://evil.example/steal');
    identity = { sub: 'sub-new', email: 'newcomer@gmail.com', email_verified: true, name: 'New Comer' };
    assert.ok(back.location.startsWith('https://uhservices.xyz/'), 'open redirect: ' + back.location);
  });

  // ── sign UP ────────────────────────────────────────────────────────────────
  let claim = null;
  await check('a Google account nobody has seen creates an account', async () => {
    const before = store.users.length;
    const back = await signInWithGoogle();
    const q = backParams(back.location);
    claim = q.get('google_login');
    assert.ok(claim, 'got ' + back.location);
    assert.strictEqual(q.get('google_new'), '1', 'the page greets a new customer differently');
    assert.strictEqual(store.users.length, before + 1);
    const u = store.users[store.users.length - 1];
    assert.strictEqual(u.google_id, 'sub-new');
    assert.strictEqual(u.email, 'newcomer@gmail.com');
    assert.strictEqual(u.password_hash, null,
      'a fake unusable hash would make this look exactly like an account whose password nobody remembers');
    assert.ok(store.balances.some(b => String(b.userId) === String(u.id)),
      'no balances row — the first credit to this account would fault');
  });

  await check('the redirect carries a CLAIM, never a session token', async () => {
    assert.ok(!store.sessions.some(s => claim === s.token),
      'the thing in the URL IS a session token — browser history, proxy logs and Referer all keep it');
    assert.strictEqual(claim.length, 64);
  });

  let sessionToken = null;
  await check('the claim trades for a real session over a response body', async () => {
    const r = await call('POST', '/api/auth/google-oauth/claim', { claim });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
    assert.strictEqual(r.body.user.email, 'newcomer@gmail.com');
    sessionToken = r.body.token;
  });

  await check('the claim is single-use', async () => {
    const r = await call('POST', '/api/auth/google-oauth/claim', { claim });
    assert.strictEqual(r.status, 401, 'a claim left in history by pressing Back is still live');
  });

  await check('a made-up claim is refused', async () => {
    const r = await call('POST', '/api/auth/google-oauth/claim', { claim: 'f'.repeat(64) });
    assert.strictEqual(r.status, 401);
  });

  await check('the session it minted actually works', async () => {
    const r = await call('GET', '/api/auth/2fa/status', null, sessionToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.google_linked, true);
    assert.strictEqual(r.body.has_password, false,
      'the security panel has to know not to ask for a password this account does not have');
  });

  await check('signing in AGAIN reuses the account, it does not make a second one', async () => {
    const before = store.users.length;
    const back = await signInWithGoogle();
    assert.ok(backParams(back.location).get('google_login'));
    assert.strictEqual(backParams(back.location).get('google_new'), null);
    assert.strictEqual(store.users.length, before, 'a duplicate account per sign-in');
  });

  await check('a colliding username gets a suffix, not a unique violation', async () => {
    identity = { sub: 'sub-collide', email: 'buyer@other.com', email_verified: true, name: 'buyer' };
    const back = await signInWithGoogle();
    identity = { sub: 'sub-new', email: 'newcomer@gmail.com', email_verified: true, name: 'New Comer' };
    assert.ok(backParams(back.location).get('google_login'), 'got ' + back.location);
    const u = store.users.find(x => x.google_id === 'sub-collide');
    assert.ok(u, 'no account created');
    assert.notStrictEqual(u.username, 'buyer', 'took a username that already existed');
    assert.ok(/^buyer/.test(u.username), 'got ' + u.username);
  });

  // ── sign IN by an existing identity ────────────────────────────────────────
  await check('a known sub signs into its own account', async () => {
    identity = { sub: 'sub-returning', email: 'returning@example.com', email_verified: true, name: 'Returning' };
    const back = await signInWithGoogle();
    const c = backParams(back.location).get('google_login');
    assert.ok(c, 'got ' + back.location);
    const r = await call('POST', '/api/auth/google-oauth/claim', { claim: c });
    assert.strictEqual(r.body.user.username, 'returning');
  });

  await check('a CHANGED Google address still resolves by sub', async () => {
    // The address on a Google account can be changed by its owner and reassigned
    // by a Workspace admin. Matching on it after the first link would hand the
    // account to whoever inherited the mailbox.
    identity = { sub: 'sub-returning', email: 'renamed@example.com', email_verified: true, name: 'Returning' };
    const before = store.users.length;
    const back = await signInWithGoogle();
    const c = backParams(back.location).get('google_login');
    const r = await call('POST', '/api/auth/google-oauth/claim', { claim: c });
    assert.strictEqual(r.body.user.username, 'returning');
    assert.strictEqual(store.users.length, before, 'made a new account for the same person');
  });

  // ── the first link, by email ───────────────────────────────────────────────
  await check('an UNVERIFIED Google email is refused and writes nothing', async () => {
    identity = { sub: 'sub-attacker', email: 'buyer@example.com', email_verified: false, name: 'Not Buyer' };
    const before = store.users.length;
    const back = await signInWithGoogle();
    assert.ok(/google_login_error=/.test(back.location), 'got ' + back.location);
    assert.strictEqual(userById(1).google_id, null,
      'setting an arbitrary unverified address on a Google account would be a one-click takeover');
    assert.strictEqual(store.users.length, before);
  });

  await check('a MISSING email_verified is not a pass either', async () => {
    identity = { sub: 'sub-attacker', email: 'buyer@example.com', name: 'Not Buyer' };
    const back = await signInWithGoogle();
    assert.ok(/google_login_error=/.test(back.location), 'got ' + back.location);
    assert.strictEqual(userById(1).google_id, null);
  });

  await check('a verified address adopts the existing password account', async () => {
    identity = { sub: 'sub-buyer', email: 'buyer@example.com', email_verified: true, name: 'Buyer' };
    const before = store.users.length;
    const back = await signInWithGoogle();
    const c = backParams(back.location).get('google_login');
    assert.ok(c, 'got ' + back.location);
    assert.strictEqual(store.users.length, before, 'a duplicate account instead of a link');
    assert.strictEqual(userById(1).google_id, 'sub-buyer');
    const r = await call('POST', '/api/auth/google-oauth/claim', { claim: c });
    assert.strictEqual(r.body.user.id, '1');
    assert.strictEqual(backParams(back.location).get('google_new'), null,
      'this account is not new — it just gained a way in');
  });

  await check('the password still works afterwards', async () => {
    // The account gained a sign-in method; it did not lose one.
    assert.strictEqual(userById(1).password_hash, 'salt:hash');
  });

  await check('a second Google account cannot overwrite the first link', async () => {
    identity = { sub: 'sub-different', email: 'taken@example.com', email_verified: true, name: 'Taken' };
    const back = await signInWithGoogle();
    assert.ok(/google_login_error=/.test(back.location), 'got ' + back.location);
    assert.strictEqual(userById(5).google_id, 'sub-somebody-else',
      'quietly overwriting would let a second Google account inherit the site account for good');
  });

  // ── the second factor is NOT bypassed ──────────────────────────────────────
  await check('an account with TOTP gets a challenge, not a session', async () => {
    identity = { sub: 'sub-careful', email: 'careful@example.com', email_verified: true, name: 'Careful' };
    const before = store.sessions.length;
    const back = await signInWithGoogle();
    const q = backParams(back.location);
    assert.strictEqual(q.get('google_login'), null,
      'Google proves a mailbox, not an authenticator — this would demote 2FA to "or press this button"');
    const challengeId = q.get('google_2fa');
    assert.ok(challengeId, 'got ' + back.location);
    assert.strictEqual(q.get('google_2fa_methods'), 'totp');
    assert.strictEqual(store.sessions.length, before, 'a session was minted before the second factor');
    const c = store.challenges.find(x => x.id === challengeId);
    assert.ok(c, 'no challenge row was written — /login/verify would refuse it');
    assert.strictEqual(String(c.web_user_id), '4');
    assert.strictEqual(c.kind, 'totp');
  });

  await check('the challenge id is not redeemable as a claim', async () => {
    const id = store.challenges[store.challenges.length - 1].id;
    const r = await call('POST', '/api/auth/google-oauth/claim', { claim: id });
    assert.strictEqual(r.status, 401);
  });

  // ── banned ─────────────────────────────────────────────────────────────────
  await check('a banned account is refused with no claim', async () => {
    identity = { sub: 'sub-banned', email: 'banned@example.com', email_verified: true, name: 'Banned' };
    const back = await signInWithGoogle();
    assert.ok(/google_login_error=/.test(back.location), 'got ' + back.location);
    assert.strictEqual(backParams(back.location).get('google_login'), null);
  });

  await check('a ban applied between the redirect and the claim still bites', async () => {
    identity = { sub: 'sub-returning', email: 'returning@example.com', email_verified: true, name: 'Returning' };
    const back = await signInWithGoogle();
    const c = backParams(back.location).get('google_login');
    userById(2).banned = true;
    const r = await call('POST', '/api/auth/google-oauth/claim', { claim: c });
    userById(2).banned = false;
    assert.strictEqual(r.status, 403, 'the claim is re-checked, not trusted from the callback');
  });

  // ── upstream failures ──────────────────────────────────────────────────────
  await check('a failed token exchange is an error bounce, not a 500 page', async () => {
    identity = { sub: 'sub-returning', email: 'returning@example.com', email_verified: true, name: 'Returning' };
    tokenExchangeWorks = false;
    const back = await signInWithGoogle();
    tokenExchangeWorks = true;
    assert.ok(back.location.startsWith('https://uhservices.xyz/'), 'got ' + back.location);
    assert.ok(/google_login_error=/.test(back.location));
  });

  await check('a token response with no access_token is refused', async () => {
    tokenResponse = { error: 'invalid_grant' };
    const back = await signInWithGoogle();
    tokenResponse = { access_token: 'tok' };
    assert.ok(/google_login_error=/.test(back.location), 'got ' + back.location);
  });

  await check('a userinfo payload with no sub is refused', async () => {
    identity = { email: 'nosub@example.com', email_verified: true };
    const before = store.users.length;
    const back = await signInWithGoogle();
    assert.ok(/google_login_error=/.test(back.location), 'got ' + back.location);
    assert.strictEqual(store.users.length, before);
  });

  // ── linking from the security panel ────────────────────────────────────────
  await check('link-start needs a session', async () => {
    const r = await call('POST', '/api/auth/google-oauth/link-start', {});
    assert.strictEqual(r.status, 401, 'anyone could mint a link state');
  });

  await check('link-start returns a consent URL that does not carry the token', async () => {
    const r = await call('POST', '/api/auth/google-oauth/link-start', {}, 'sess-buyer');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(new URL(r.body.url).host, 'accounts.google.com');
    assert.ok(!r.body.url.includes('sess-buyer'), 'a 30-day bearer would end up in history and access logs');
  });

  await check('a link round trip writes the link and echoes no identifier', async () => {
    userById(1).google_id = null;
    const start = await call('POST', '/api/auth/google-oauth/link-start', {}, 'sess-buyer');
    identity = { sub: 'sub-fresh-link', email: 'buyer-alt@gmail.com', email_verified: true, name: 'Buyer' };
    const back = await call('GET', '/api/auth/google-oauth/callback?code=abc&state=' + stateOf(start.body.url));
    assert.ok(/google_link=ok/.test(back.location), 'got ' + back.location);
    assert.strictEqual(userById(1).google_id, 'sub-fresh-link');
    assert.strictEqual(userById(1).google_email, 'buyer-alt@gmail.com');
    assert.ok(!back.location.includes('sub-fresh-link'), 'got ' + back.location);
  });

  await check('a Google account already on someone else is refused', async () => {
    const start = await call('POST', '/api/auth/google-oauth/link-start', {}, 'sess-buyer');
    identity = { sub: 'sub-somebody-else', email: 'other@gmail.com', email_verified: true, name: 'X' };
    const back = await call('GET', '/api/auth/google-oauth/callback?code=abc&state=' + stateOf(start.body.url));
    assert.ok(/google_link_error=/.test(back.location), 'got ' + back.location);
    assert.strictEqual(userById(1).google_id, 'sub-fresh-link', 'the duplicate link was written anyway');
    assert.strictEqual(userById(5).google_id, 'sub-somebody-else');
  });

  await check('a LOGIN state never writes a link', async () => {
    // Same callback, two errands. Which one is decided when the state is minted,
    // so editing the URL on the way back cannot convert one into the other.
    userById(1).google_id = null;
    identity = { sub: 'sub-returning', email: 'returning@example.com', email_verified: true, name: 'Returning' };
    const back = await signInWithGoogle();
    assert.ok(/google_login=/.test(back.location), 'got ' + back.location);
    assert.ok(!/google_link=/.test(back.location), 'a login was reported as a link');
    assert.strictEqual(userById(1).google_id, null, 'the login path wrote a link');
  });

  await check('a failed LINK reports a link error, not a login error', async () => {
    const start = await call('POST', '/api/auth/google-oauth/link-start', {}, 'sess-buyer');
    tokenExchangeWorks = false;
    const back = await call('GET', '/api/auth/google-oauth/callback?code=abc&state=' + stateOf(start.body.url));
    tokenExchangeWorks = true;
    assert.ok(/google_link_error=/.test(back.location), 'got ' + back.location);
  });

  // ── a passwordless account is not locked out of anything ───────────────────
  await check('the password login tells a Google-only account where to go', async () => {
    const r = await call('POST', '/api/auth/login', { username: 'returning', password: 'anything' });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'use_google',
      '"Invalid credentials" on an account that never had a password is a support ticket');
  });

  await check('a Google-only account can still DISABLE its 2FA with a live code', async () => {
    // The lockout this closes: the disable routes gated on the current password,
    // and this account has none. Enabling 2FA would have been a one-way door.
    assert.strictEqual(userById(4).password_hash, null);
    const bad = await call('POST', '/api/auth/2fa/disable', { password: '000000' }, 'sess-careful');
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(bad.body.needs, 'totp',
      'the panel would otherwise draw a password box this account can never fill');
    assert.strictEqual(userById(4).totp_enabled, true);

    const ok = await call('POST', '/api/auth/2fa/disable', { password: liveTotpCode() }, 'sess-careful');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(userById(4).totp_enabled, false);
    assert.strictEqual(userById(4).totp_secret, null);
  });

  await check('an empty proof is a 400 that says what to ask for', async () => {
    const r = await call('POST', '/api/auth/2fa/disable', {}, 'sess-buyer');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.needs, 'password', 'this account HAS a password');
  });

  server.close();
  console.log(`\n  ${passed} passed, ${failed} failed`);

  // ── and again with the credentials removed ─────────────────────────────────
  await new Promise((resolve) => {
    const child = require('child_process').spawn(
      process.execPath, [__filename],
      { env: Object.assign({}, process.env, {
          GX_GOOGLE_OFF: '1', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }),
        stdio: 'inherit' });
    child.on('exit', (code) => { if (code) failed++; resolve(); });
  });

  // ── and again with the callback on a uhservices.xyz host ───────────────────
  await new Promise((resolve) => {
    const child = require('child_process').spawn(
      process.execPath, [__filename],
      { env: Object.assign({}, process.env, { GX_GOOGLE_DOMAIN: '1' }), stdio: 'inherit' });
    child.on('exit', (code) => { if (code) failed++; resolve(); });
  });

  console.log(`${failed ? '\n  SOME CHECKS FAILED\n' : '\n  all green\n'}`);
  process.exit(failed ? 1 : 0);
})();
