// Linking Discord from the security panel via OAuth instead of a typed user ID.
//
// The typed-ID path needs a DM click to prove ownership, because a snowflake is
// just a number anyone can copy — that was a real hole once: /confirm-discord
// wrote discord_verified = true on the strength of the request body, so any
// signup could claim the owner's Discord and poison every admin lookup keyed by
// it. OAuth proves ownership on Discord's own domain, so the DM step is
// genuinely unnecessary there — which makes it worth pinning that the two modes
// cannot be confused for one another at the shared callback:
//
//   • a LINK state is minted only by an authenticated POST
//   • a LOGIN state (anonymous GET) must never write a link
//   • return_to may only be a known storefront origin (no open redirect)
//   • a snowflake already verified elsewhere is refused, not stolen
//
//   node test_discord_oauth_link.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

process.env.GUILD_ID = 'test-guild';
process.env.API_SECRET = 'test-secret';
process.env.DISCORD_CLIENT_ID = 'client-id-123';
process.env.DISCORD_CLIENT_SECRET = 'client-secret-456';
process.env.BACKEND_PUBLIC_URL = 'https://backend.example';
process.env.STOREFRONT_ORIGINS = 'https://uhservices.xyz,https://www.uhservices.xyz';

// ─── Stub the DB (before utils/auth binds `query`) ───────
const store = {
  users: [
    { id: 1, guild_id: 'test-guild', username: 'buyer', email: 'buyer@example.com', role: 'member', banned: false, discord_id: null, discord_verified: false, balance_cents: 0 },
    { id: 2, guild_id: 'test-guild', username: 'other', email: 'other@example.com', role: 'member', banned: false, discord_id: '999999999999999999', discord_verified: true, balance_cents: 0 },
  ],
  sessions: [{ token: 'sess-buyer', userId: 1 }],
};
const userById = (id) => store.users.find(u => String(u.id) === String(id));

const exec = async (text, params) => {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const p = params || [];
  if (/FROM web_sessions s/.test(t)) {
    const s = store.sessions.find(x => x.token === p[0]);
    return { rows: s ? [Object.assign({}, userById(s.userId))] : [] };
  }
  if (/SELECT id FROM web_users WHERE guild_id = \$1 AND discord_id = \$2 AND discord_verified = true AND id <> \$3/.test(t)) {
    const rows = store.users.filter(u => u.discord_id === p[1] && u.discord_verified && String(u.id) !== String(p[2]));
    return { rows: rows.map(u => ({ id: u.id })) };
  }
  if (/UPDATE web_users SET discord_id = \$1, discord_verified = true/.test(t)) {
    const u = userById(p[1]);
    if (u) { u.discord_id = p[0]; u.discord_verified = true; }
    return { rows: [] };
  }
  if (/SELECT id, email, username, banned FROM web_users/.test(t)) {
    const rows = store.users.filter(u => u.discord_id === p[1] && u.discord_verified);
    return { rows: rows.map(u => ({ id: u.id, email: u.email, username: u.username, banned: u.banned })) };
  }
  return { rows: [] };
};
const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (t, p) => exec(t, p), withTransaction: async (fn) => fn(exec), pool: {} },
};

// ─── Stub axios (Discord's token + identity endpoints) ───
let discordIdentity = '111111111111111111';
let tokenExchangeWorks = true;
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    post: async (url) => {
      if (/oauth2\/token/.test(url)) {
        if (!tokenExchangeWorks) throw new Error('bad_verification_code');
        return { data: { access_token: 'tok' } };
      }
      if (/initiate-2fa/.test(url)) return { data: { userId: 'sb-session' } };
      return { data: {} };
    },
    get: async (url) => {
      if (/users\/@me/.test(url)) return { data: { id: discordIdentity } };
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
    // No Content-Length on a GET: express would sit waiting for a body that
    // this helper never sends, and the whole suite hangs with no output.
    const headers = isGet
      ? {}
      : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
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

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + (e && e.message)); process.exitCode = 1; }
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  console.log('\ndiscord OAuth linking');

  await check('link-start needs a session', async () => {
    const r = await call('POST', '/api/auth/discord-oauth/link-start', {});
    assert.strictEqual(r.status, 401, 'anyone could mint a link state');
  });

  let authorizeUrl = null;
  await check('link-start returns a Discord consent URL', async () => {
    const r = await call('POST', '/api/auth/discord-oauth/link-start', {}, 'sess-buyer');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    authorizeUrl = r.body.url;
    const u = new URL(authorizeUrl);
    assert.strictEqual(u.host, 'discord.com');
    assert.strictEqual(u.searchParams.get('client_id'), 'client-id-123');
    assert.strictEqual(u.searchParams.get('scope'), 'identify', 'ask for no more than identify');
    assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://backend.example/api/auth/discord-oauth/callback');
    assert.ok(u.searchParams.get('state'), 'no state — CSRF protection missing');
  });

  await check('the session token never appears in the consent URL', async () => {
    assert.ok(!authorizeUrl.includes('sess-buyer'), 'a 30-day bearer would end up in history and access logs');
  });

  await check('an unknown state is refused and writes nothing', async () => {
    const r = await call('GET', '/api/auth/discord-oauth/callback?code=abc&state=not-a-real-state');
    assert.ok(/discord_l(ogin|ink)_error=/.test(r.location), 'got ' + r.location);
    assert.strictEqual(userById(1).discord_id, null);
  });

  await check('the callback links the account the state was bound to', async () => {
    const r = await call('GET', '/api/auth/discord-oauth/callback?code=abc&state=' + stateOf(authorizeUrl));
    assert.ok(r.location.startsWith('https://uhservices.xyz/'), 'got ' + r.location);
    assert.ok(/discord_link=ok/.test(r.location), 'got ' + r.location);
    assert.strictEqual(userById(1).discord_id, '111111111111111111');
    assert.strictEqual(userById(1).discord_verified, true);
  });

  await check('the Discord id is not echoed back in the URL', async () => {
    // The page re-reads it from /2fa/status with its own session instead.
    const r = await call('POST', '/api/auth/discord-oauth/link-start', {}, 'sess-buyer');
    const back = await call('GET', '/api/auth/discord-oauth/callback?code=abc&state=' + stateOf(r.body.url));
    assert.ok(!back.location.includes(discordIdentity), 'got ' + back.location);
  });

  await check('a state is single-use', async () => {
    const r = await call('POST', '/api/auth/discord-oauth/link-start', {}, 'sess-buyer');
    const state = stateOf(r.body.url);
    await call('GET', '/api/auth/discord-oauth/callback?code=abc&state=' + state);
    const replay = await call('GET', '/api/auth/discord-oauth/callback?code=abc&state=' + state);
    assert.ok(/_error=/.test(replay.location), 'a replayed state was accepted: ' + replay.location);
  });

  await check('a snowflake verified on another account is refused', async () => {
    const r = await call('POST', '/api/auth/discord-oauth/link-start', {}, 'sess-buyer');
    const before = userById(1).discord_id;
    discordIdentity = '999999999999999999';   // already on user 2
    const back = await call('GET', '/api/auth/discord-oauth/callback?code=abc&state=' + stateOf(r.body.url));
    discordIdentity = '111111111111111111';
    assert.ok(/discord_link_error=/.test(back.location), 'got ' + back.location);
    assert.strictEqual(userById(1).discord_id, before, 'the duplicate link was written anyway');
    assert.strictEqual(userById(2).discord_id, '999999999999999999');
  });

  await check('return_to outside the storefront origins is ignored', async () => {
    const r = await call('POST', '/api/auth/discord-oauth/link-start', { return_to: 'https://evil.example/steal' }, 'sess-buyer');
    const back = await call('GET', '/api/auth/discord-oauth/callback?code=abc&state=' + stateOf(r.body.url));
    assert.ok(back.location.startsWith('https://uhservices.xyz/'), 'open redirect: ' + back.location);
  });

  await check('a login-mode state does not write a link', async () => {
    // Same callback, but the state came from the anonymous GET /start. It must
    // fall through to the passwordless-login path, not touch web_users.
    store.users[0].discord_id = null;
    store.users[0].discord_verified = false;
    const start = await call('GET', '/api/auth/discord-oauth/start?return_to=https://uhservices.xyz');
    const state = stateOf(start.location);
    const back = await call('GET', '/api/auth/discord-oauth/callback?code=abc&state=' + state);
    assert.ok(/discord_login=/.test(back.location), 'got ' + back.location);
    assert.ok(!/discord_link=/.test(back.location), 'a login was reported as a link');
    assert.strictEqual(userById(1).discord_id, null, 'the login path wrote a link');
  });

  await check('a failed token exchange reports a LINK error, not a login error', async () => {
    const r = await call('POST', '/api/auth/discord-oauth/link-start', {}, 'sess-buyer');
    tokenExchangeWorks = false;
    const back = await call('GET', '/api/auth/discord-oauth/callback?code=abc&state=' + stateOf(r.body.url));
    tokenExchangeWorks = true;
    assert.ok(/discord_link_error=/.test(back.location), 'got ' + back.location);
  });

  server.close();
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
