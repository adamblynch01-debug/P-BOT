// Offline tests for the auth-hardening batch: the in-memory rate limiter,
// constant-time compare, the env-only config keys, and /set-role's identifier
// resolution. No network and no database — the pg pool is stubbed out through
// require.cache before any route module is loaded.
//
//   node test_auth_hardening.js
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

// ─── Stub the DB before routes are required ──────────────
// routes/*.js call require('../db') at module load; injecting into the cache
// first means they get this stub instead of opening a real pool.
let dbCalls = [];
let dbHandler = async () => ({ rows: [] });
const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (text, params) => {
      dbCalls.push({ text, params });
      return dbHandler(text, params);
    },
    withTransaction: async (fn) => fn((t, p) => dbHandler(t, p)),
    pool: {},
  },
};

process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';
process.env.API_SECRET = 'test-api-secret-value';
process.env.PANEL_PASSWORD = 'panel-correct-horse-battery';
process.env.VAULT_PASSWORD = 'vault-correct-horse-battery';

const express = require('express');
const { rateLimit, failureLimiter, safeCompare } = require('./utils/rateLimit');

let passed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => { passed++; console.log(`  ok  ${name}`); },
      (e) => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; });
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
  return Promise.resolve();
}

// ─── safeCompare ─────────────────────────────────────────
console.log('\nsafeCompare');
const sc = [];
sc.push(check('equal strings match', () => assert.strictEqual(safeCompare('abc', 'abc'), true)));
sc.push(check('different strings do not match', () => assert.strictEqual(safeCompare('abc', 'abd'), false)));
sc.push(check('different LENGTHS do not throw (timingSafeEqual would)', () =>
  assert.strictEqual(safeCompare('a', 'aaaaaaaaaaaaaaaaaaaa'), false)));
sc.push(check('null/undefined never match', () => {
  assert.strictEqual(safeCompare(undefined, undefined), false);
  assert.strictEqual(safeCompare(null, 'x'), false);
  assert.strictEqual(safeCompare('x', null), false);
  assert.strictEqual(safeCompare(undefined, 'x'), false);
}));
sc.push(check('numbers are coerced, not object-compared', () => assert.strictEqual(safeCompare(123, '123'), true)));
sc.push(check('empty string matches empty string but not undefined', () => {
  assert.strictEqual(safeCompare('', ''), true);
  assert.strictEqual(safeCompare('', undefined), false);
}));

// ─── rateLimit (unit, fake req/res) ──────────────────────
function fakeReqRes(ip) {
  const res = {
    statusCode: 200, body: null, headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return [{ ip, socket: {}, get: () => '' }, res];
}
function run(mw, ip) {
  const [req, res] = fakeReqRes(ip);
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { nexted, res };
}

console.log('\nrateLimit');
sc.push(check('allows up to max then blocks with 429', () => {
  const mw = rateLimit({ windowMs: 60000, max: 3, name: 't1' });
  for (let i = 0; i < 3; i++) assert.strictEqual(run(mw, '1.1.1.1').nexted, true, `req ${i + 1} should pass`);
  const r = run(mw, '1.1.1.1');
  assert.strictEqual(r.nexted, false);
  assert.strictEqual(r.res.statusCode, 429);
}));
sc.push(check('429 body carries retry_after and Retry-After header', () => {
  const mw = rateLimit({ windowMs: 60000, max: 1, name: 't2' });
  run(mw, '2.2.2.2');
  const r = run(mw, '2.2.2.2');
  assert.strictEqual(r.res.statusCode, 429);
  assert.ok(r.res.body.retry_after > 0, 'retry_after should be positive');
  assert.ok(Number(r.res.headers['Retry-After']) > 0, 'Retry-After header should be set');
  assert.ok(!JSON.stringify(r.res.body).includes('panel'), 'error must not leak config');
}));
sc.push(check('buckets are per-IP — one abuser does not block others', () => {
  const mw = rateLimit({ windowMs: 60000, max: 2, name: 't3' });
  run(mw, '3.3.3.3'); run(mw, '3.3.3.3');
  assert.strictEqual(run(mw, '3.3.3.3').nexted, false, 'abuser blocked');
  assert.strictEqual(run(mw, '4.4.4.4').nexted, true, 'other IP unaffected');
}));
sc.push(check('window expiry resets the counter', async () => {
  const mw = rateLimit({ windowMs: 40, max: 1, name: 't4' });
  assert.strictEqual(run(mw, '5.5.5.5').nexted, true);
  assert.strictEqual(run(mw, '5.5.5.5').nexted, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(run(mw, '5.5.5.5').nexted, true, 'should pass after window');
}));
sc.push(check('globalMax blocks across distinct IPs (botnet case)', () => {
  const mw = rateLimit({ windowMs: 60000, max: 100, globalMax: 3, name: 't5' });
  for (let i = 0; i < 3; i++) assert.strictEqual(run(mw, `10.0.0.${i}`).nexted, true);
  assert.strictEqual(run(mw, '10.0.0.99').nexted, false, 'fresh IP still blocked by global ceiling');
}));
sc.push(check('no globalMax means unlimited distinct IPs pass (login case)', () => {
  const mw = rateLimit({ windowMs: 60000, max: 1, name: 't6' });
  for (let i = 0; i < 50; i++) assert.strictEqual(run(mw, `11.0.0.${i}`).nexted, true);
}));
sc.push(check('missing req.ip falls back without throwing', () => {
  const mw = rateLimit({ windowMs: 60000, max: 1, name: 't7' });
  const res = { statusCode: 200, set() { return this; }, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  let ok = false;
  mw({ socket: {}, get: () => '' }, res, () => { ok = true; });
  assert.strictEqual(ok, true);
}));

console.log('\nfailureLimiter');
sc.push(check('successes are never counted — unlimited correct attempts', () => {
  const g = failureLimiter({ windowMs: 60000, max: 2, name: 'f1' });
  for (let i = 0; i < 100; i++) {
    const [req, res] = fakeReqRes('6.6.6.6');
    assert.strictEqual(g.blocked(req, res), false, `success ${i} must pass`);
    // no .fail() — this models a correct password
  }
}));
sc.push(check('failures accumulate and then block', () => {
  const g = failureLimiter({ windowMs: 60000, max: 2, name: 'f2' });
  for (let i = 0; i < 2; i++) {
    const [req, res] = fakeReqRes('7.7.7.7');
    assert.strictEqual(g.blocked(req, res), false);
    g.fail(req);
  }
  const [req, res] = fakeReqRes('7.7.7.7');
  assert.strictEqual(g.blocked(req, res), true);
  assert.strictEqual(res.statusCode, 429);
}));
sc.push(check('a global ceiling still stops distributed guessing', () => {
  const g = failureLimiter({ windowMs: 60000, max: 100, globalMax: 3, name: 'f3' });
  for (let i = 0; i < 3; i++) {
    const [req, res] = fakeReqRes(`12.0.0.${i}`);
    assert.strictEqual(g.blocked(req, res), false);
    g.fail(req);
  }
  const [req, res] = fakeReqRes('12.0.0.99');
  assert.strictEqual(g.blocked(req, res), true, 'fresh IP blocked by the global ceiling');
}));

// ─── Route-level tests over a real HTTP server ───────────
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/auth', require('./routes/auth'));
app.use('/api/config', require('./routes/config'));
const server = http.createServer(app);

function post(pathname, body, ip) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        // trust proxy 1 → req.ip comes from the last XFF entry, letting each
        // test use a distinct address so limiters don't bleed between cases.
        'X-Forwarded-For': ip || '127.0.0.1',
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); } catch { resolve({ status: res.statusCode, body: out }); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  await Promise.all(sc);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  console.log('\npanel-unlock / vault-unlock');
  await check('correct panel password → ok true', async () => {
    const r = await post('/api/auth/panel-unlock', { password: process.env.PANEL_PASSWORD }, '20.0.0.1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
  });
  await check('wrong panel password → ok false, no value echoed', async () => {
    const r = await post('/api/auth/panel-unlock', { password: 'nope' }, '20.0.0.2');
    assert.strictEqual(r.body.ok, false);
    assert.ok(!JSON.stringify(r.body).includes('correct-horse'), 'must never echo the configured value');
  });
  await check('correct vault password → ok true', async () => {
    const r = await post('/api/auth/vault-unlock', { password: process.env.VAULT_PASSWORD }, '20.0.0.3');
    assert.strictEqual(r.body.ok, true);
  });
  await check('panel and vault passwords are not interchangeable', async () => {
    const r = await post('/api/auth/panel-unlock', { password: process.env.VAULT_PASSWORD }, '20.0.0.4');
    assert.strictEqual(r.body.ok, false);
  });
  await check('missing password → 400', async () => {
    const r = await post('/api/auth/panel-unlock', {}, '20.0.0.5');
    assert.strictEqual(r.status, 400);
  });
  await check('unset PANEL_PASSWORD → ok false, never open', async () => {
    const saved = process.env.PANEL_PASSWORD;
    delete process.env.PANEL_PASSWORD;
    const r = await post('/api/auth/panel-unlock', { password: 'anything' }, '20.0.0.6');
    process.env.PANEL_PASSWORD = saved;
    assert.strictEqual(r.body.ok, false);
  });
  await check('brute force is cut off by the limiter (was unlimited)', async () => {
    let blocked = 0;
    for (let i = 0; i < 14; i++) {
      const r = await post('/api/auth/panel-unlock', { password: `guess${i}` }, '20.9.9.9');
      if (r.status === 429) blocked++;
    }
    assert.ok(blocked > 0, 'expected some attempts to be rate limited');
  });
  await check('a wrong-guess burst does NOT lock out the correct password', async () => {
    // The whole reason unlock counts failures only. With every-request counting
    // and a global ceiling, anyone could keep staff out of the panel for 15
    // minutes by spamming this endpoint from anywhere.
    for (let i = 0; i < 25; i++) await post('/api/auth/panel-unlock', { password: `flood${i}` }, '20.8.8.8');
    const r = await post('/api/auth/panel-unlock', { password: process.env.PANEL_PASSWORD }, '20.8.8.7');
    assert.strictEqual(r.status, 200, 'staff on a clean IP must still get in');
    assert.strictEqual(r.body.ok, true);
  });
  await check('correct password works even from the flooding IP itself', async () => {
    // The password is verified BEFORE the limiter is consulted, so no volume of
    // wrong guesses — from this IP or any other — can lock out someone holding
    // the real password. Without that ordering the global ceiling would be a
    // free admin-lockout DoS for any stranger.
    for (let i = 0; i < 15; i++) await post('/api/auth/panel-unlock', { password: `flood${i}` }, '20.7.7.7');
    const blockedNow = await post('/api/auth/panel-unlock', { password: 'still-wrong' }, '20.7.7.7');
    assert.strictEqual(blockedNow.status, 429, 'wrong guesses from that IP are throttled');
    const r = await post('/api/auth/panel-unlock', { password: process.env.PANEL_PASSWORD }, '20.7.7.7');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true, 'the correct password still gets through');
  });

  console.log('\nconfig /update — env-only keys');
  await check('PANEL_PASSWORD is rejected, not stored', async () => {
    dbCalls = [];
    const r = await post('/api/config/update', { secret: process.env.API_SECRET, key: 'PANEL_PASSWORD', value: 'hijack' }, '21.0.0.1');
    assert.strictEqual(r.status, 400);
    assert.ok(/Railway/i.test(r.body.error), 'error should point at Railway');
    assert.strictEqual(dbCalls.length, 0, 'must not touch the config table');
    assert.strictEqual(process.env.PANEL_PASSWORD, 'panel-correct-horse-battery', 'env must be untouched');
  });
  await check('VAULT_PASSWORD is rejected (lowercase key too)', async () => {
    const r = await post('/api/config/update', { secret: process.env.API_SECRET, key: 'vault_password', value: 'hijack' }, '21.0.0.2');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(process.env.VAULT_PASSWORD, 'vault-correct-horse-battery');
  });
  await check('a normal key still updates', async () => {
    dbCalls = [];
    const r = await post('/api/config/update', { secret: process.env.API_SECRET, key: 'STORE_NAME', value: 'Test Store' }, '21.0.0.3');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(dbCalls.length, 1, 'should have upserted');
  });
  await check('wrong secret → 401', async () => {
    const r = await post('/api/config/update', { secret: 'wrong', key: 'STORE_NAME', value: 'x' }, '21.0.0.4');
    assert.strictEqual(r.status, 401);
  });
  await check('unset API_SECRET → 503, NOT authorized (was fail-open)', async () => {
    const saved = process.env.API_SECRET;
    delete process.env.API_SECRET;
    const r = await post('/api/config/update', { key: 'STORE_NAME', value: 'pwned' }, '21.0.0.5');
    process.env.API_SECRET = saved;
    assert.strictEqual(r.status, 503, 'undefined !== undefined used to authorize this');
  });
  await check('missing key → 400, not a 500', async () => {
    const r = await post('/api/config/update', { secret: process.env.API_SECRET, value: 'x' }, '21.0.0.6');
    assert.strictEqual(r.status, 400);
  });

  console.log('\nloadConfigFromDB — env-only rows ignored');
  await check('a stale PANEL_PASSWORD row does NOT override the env var', async () => {
    dbHandler = async () => ({ rows: [
      { key: 'PANEL_PASSWORD', value: 'OLD-LEAKED-VALUE' },
      { key: 'VAULT_PASSWORD', value: 'OLD-LEAKED-VALUE' },
      { key: 'STORE_NAME', value: 'From DB' },
    ] });
    await require('./routes/config').loadConfigFromDB();
    dbHandler = async () => ({ rows: [] });
    assert.strictEqual(process.env.PANEL_PASSWORD, 'panel-correct-horse-battery', 'this is the config-row trap');
    assert.strictEqual(process.env.VAULT_PASSWORD, 'vault-correct-horse-battery');
    assert.strictEqual(process.env.STORE_NAME, 'From DB', 'non-secret keys still load');
  });

  console.log('\nset-role — identifier resolution');
  const USER = { id: 42n, username: 'ghost', email: 'g@example.com', discord_id: '1400773021274341396', discord_verified: true, role: 'member' };
  function roleDb(matchOn) {
    return async (text, params) => {
      if (/^\s*SELECT/i.test(text)) {
        const [, ident, mail, did] = params;
        const hit = (matchOn === 'username' && ident && ident.toLowerCase() === 'ghost')
          || (matchOn === 'email' && ((ident && ident.toLowerCase() === USER.email) || (mail && mail.toLowerCase() === USER.email)))
          || (matchOn === 'discord' && did === USER.discord_id);
        return { rows: hit ? [USER] : [] };
      }
      return { rows: [{ id: USER.id, username: USER.username, email: USER.email, role: params[0] }] };
    };
  }
  await check('promote by username', async () => {
    dbHandler = roleDb('username');
    const r = await post('/api/auth/set-role', { secret: process.env.API_SECRET, username: 'ghost', role: 'admin' }, '22.0.0.1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user.role, 'admin');
    assert.strictEqual(r.body.previous_role, 'member');
  });
  await check('promote by EMAIL passed as username (used to 404)', async () => {
    dbHandler = roleDb('email');
    const r = await post('/api/auth/set-role', { secret: process.env.API_SECRET, username: 'g@example.com', role: 'admin' }, '22.0.0.2');
    assert.strictEqual(r.status, 200, 'the bot option always promised "username or email"');
  });
  await check('promote by explicit email field', async () => {
    dbHandler = roleDb('email');
    const r = await post('/api/auth/set-role', { secret: process.env.API_SECRET, email: 'G@Example.com', role: 'staff' }, '22.0.0.3');
    assert.strictEqual(r.status, 200);
  });
  await check('promote by discord_id', async () => {
    dbHandler = roleDb('discord');
    const r = await post('/api/auth/set-role', { secret: process.env.API_SECRET, discord_id: '1400773021274341396', role: 'admin' }, '22.0.0.4');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.discord_linked, true);
  });
  await check('19-digit snowflake survives as a string (parseInt would round it)', async () => {
    let seen = null;
    dbHandler = async (text, params) => {
      if (/^\s*SELECT/i.test(text)) { seen = params[3]; return { rows: [USER] }; }
      return { rows: [{ id: USER.id, username: USER.username, email: USER.email, role: 'admin' }] };
    };
    await post('/api/auth/set-role', { secret: process.env.API_SECRET, discord_id: '1400773021274341396', role: 'admin' }, '22.0.0.5');
    assert.strictEqual(seen, '1400773021274341396');
    assert.notStrictEqual(seen, String(parseInt('1400773021274341396', 10)));
  });
  await check('unlinked discord user gets an actionable 404', async () => {
    dbHandler = async () => ({ rows: [] });
    const r = await post('/api/auth/set-role', { secret: process.env.API_SECRET, discord_id: '999', role: 'admin' }, '22.0.0.6');
    assert.strictEqual(r.status, 404);
    assert.ok(/link/i.test(r.body.error), 'should tell staff what to do next');
  });
  await check('ambiguous match across identifiers → 409, promotes nobody', async () => {
    dbHandler = async (text) => {
      if (/^\s*SELECT/i.test(text)) return { rows: [USER, { ...USER, id: 43n, username: 'other' }] };
      throw new Error('must not UPDATE on an ambiguous match');
    };
    const r = await post('/api/auth/set-role', { secret: process.env.API_SECRET, username: 'ghost', discord_id: '1', role: 'admin' }, '22.0.0.7');
    assert.strictEqual(r.status, 409);
  });
  await check('no identifier at all → 400', async () => {
    dbHandler = async () => ({ rows: [] });
    const r = await post('/api/auth/set-role', { secret: process.env.API_SECRET, role: 'admin' }, '22.0.0.8');
    assert.strictEqual(r.status, 400);
  });
  await check('empty-string identifiers are not treated as a wildcard', async () => {
    let ran = false;
    dbHandler = async (text) => { ran = true; if (/^\s*SELECT/i.test(text)) return { rows: [] }; return { rows: [] }; };
    const r = await post('/api/auth/set-role', { secret: process.env.API_SECRET, username: '   ', email: '', role: 'admin' }, '22.0.0.9');
    assert.strictEqual(r.status, 400, 'whitespace-only must not reach the query');
    assert.strictEqual(ran, false);
  });
  await check('invalid role rejected', async () => {
    const r = await post('/api/auth/set-role', { secret: process.env.API_SECRET, username: 'ghost', role: 'owner' }, '22.0.1.0');
    assert.strictEqual(r.status, 400);
  });
  await check('wrong secret → 401', async () => {
    const r = await post('/api/auth/set-role', { secret: 'bad', username: 'ghost', role: 'admin' }, '22.0.1.1');
    assert.strictEqual(r.status, 401);
  });
  await check('unset API_SECRET → 503, not fail-open', async () => {
    const saved = process.env.API_SECRET;
    delete process.env.API_SECRET;
    const r = await post('/api/auth/set-role', { username: 'ghost', role: 'admin' }, '22.0.1.2');
    process.env.API_SECRET = saved;
    assert.strictEqual(r.status, 503);
  });
  await check('set-role is rate limited', async () => {
    dbHandler = async () => ({ rows: [] });
    let blocked = 0;
    for (let i = 0; i < 34; i++) {
      const r = await post('/api/auth/set-role', { secret: 'guess' + i, username: 'ghost', role: 'admin' }, '23.9.9.9');
      if (r.status === 429) blocked++;
    }
    assert.ok(blocked > 0, 'the 401 oracle should not be unlimited');
  });
  await check('the real API_SECRET still works from a throttled IP (bot must not be locked out)', async () => {
    dbHandler = roleDb('username');
    const r = await post('/api/auth/set-role', { secret: process.env.API_SECRET, username: 'ghost', role: 'admin' }, '23.9.9.9');
    assert.strictEqual(r.status, 200, 'a valid secret bypasses the failure counter');
  });

  console.log('\nlogin / signup limiters');
  await check('login is rate limited but has no global ceiling', async () => {
    dbHandler = async () => ({ rows: [] });
    let blocked = 0;
    for (let i = 0; i < 24; i++) {
      const r = await post('/api/auth/login', { username: 'x', password: 'y' + i }, '24.0.0.1');
      if (r.status === 429) blocked++;
    }
    assert.ok(blocked > 0, 'same IP should eventually be blocked');
    const other = await post('/api/auth/login', { username: 'x', password: 'y' }, '24.0.0.2');
    assert.notStrictEqual(other.status, 429, 'a different customer must NOT be locked out');
  });
  await check('a valid login still succeeds from a throttled IP', async () => {
    // Several people behind one NAT/office IP is normal; one of them fat-
    // fingering their password 20 times must not lock the others out.
    const { hashPassword } = require('./utils/auth');
    const hash = hashPassword('right-password');
    dbHandler = async (text) => {
      if (/FROM web_users u/i.test(text)) {
        return { rows: [{ id: 7n, username: 'real', email: 'r@e.com', role: 'member', banned: false, password_hash: hash, balance_cents: 0 }] };
      }
      return { rows: [] };
    };
    const r = await post('/api/auth/login', { username: 'real', password: 'right-password' }, '24.0.0.1');
    assert.strictEqual(r.status, 200, 'correct credentials are checked before the limiter');
    assert.ok(r.body.token, 'should have minted a session');
  });
  await check('signup counts every request, not just failures', async () => {
    // Each signup that succeeds still costs a row, so unlike login there is no
    // "success is free" case to exempt.
    dbHandler = async (text) => {
      if (/SELECT id FROM web_users/i.test(text)) return { rows: [] };
      if (/INSERT INTO web_users/i.test(text)) return { rows: [{ id: 1n, username: 'u', email: 'e' }] };
      return { rows: [] };
    };
    let blocked = 0;
    for (let i = 0; i < 12; i++) {
      const r = await post('/api/auth/signup', { username: 'u' + i, email: `u${i}@e.com`, password: 'password1' }, '25.0.0.1');
      if (r.status === 429) blocked++;
    }
    assert.ok(blocked > 0, 'signup should cap even when every request succeeds');
  });

  server.close();
  console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures above)' : ''}`);
})();
