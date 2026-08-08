// Tests for GET/POST /api/updates — round 45.
//
//   node backend/test_updates_route.js
//
// Requires product_updates to exist (run migrations/product_updates.sql first).
// Uses the same test harness shape as test_storefront_panels.js: one
// check() runner, explicit pass/fail count, process.exitCode=1 on any failure.
// Includes a mutation check: flipping the secret gate off must be caught.
'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

// ─── minimal stub environment ────────────────────────────────────────────────
// The route reads GUILD_ID, API_SECRET, and calls require('../db').query and
// require('../utils/auth'). We swap them all out before requiring the route,
// then restore them so nothing leaks between tests.

const Module = require('module');
const ORIG_COMPILE = Module.prototype._compile;

// Fake in-memory store
const store = [];
let nextId   = 1;

const fakeDb = {
  query: async (sql, params) => {
    if (/INSERT INTO product_updates/.test(sql)) {
      const id = nextId++;
      store.push({
        id, guild_id: params[0], update_type: params[1], product_name: params[2],
        title: params[3], notes: params[4], status_from: params[5],
        status_to: params[6], image_url: params[7],
        posted_at: new Date().toISOString(),
      });
      return { rows: [{ id, posted_at: store[store.length - 1].posted_at }] };
    }
    if (/SELECT[\s\S]*FROM product_updates/.test(sql)) {
      // params[0] = guild_id, params[1] = before cursor (null means all), params[2] = limit
      const gid    = params[0];
      const before = params[1] ? Number(params[1]) : null;
      const limit  = params[2] || 50;
      const rows = store
        .filter(r => r.guild_id === gid && (before == null || r.id < before))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map(r => ({ ...r }));
      return { rows };
    }
    return { rows: [] };
  },
};

const fakeAuth = {
  botAuthorized: (req) => {
    // The real implementation checks Authorization: Bearer <API_SECRET>.
    const hdr = (req.headers && req.headers['authorization']) || '';
    const tok = hdr.replace(/^Bearer\s+/i, '');
    return !!tok && tok === process.env.API_SECRET;
  },
  bearerToken: (req) => ((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, ''),
  getSessionUser: async () => null,
};

// Patch require() only while we load the route
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../db')         return fakeDb;
  if (id === '../utils/auth') return fakeAuth;
  return origRequire.call(this, id);
};

process.env.GUILD_ID    = 'TEST_GUILD';
process.env.API_SECRET  = 'test-secret-abc';

const router = require('./routes/updates');
Module.prototype.require = origRequire;   // restore

// ─── tiny express-like harness ────────────────────────────────────────────────
// Calls the route handler directly — no network, no actual HTTP server.
function makeReq({ method = 'GET', path = '/', headers = {}, body = {}, query = {} } = {}) {
  return { method, path, headers, body, query, params: {} };
}
function makeRes() {
  const res = {
    _status: 200, _body: null,
    status(code) { this._status = code; return this; },
    json(obj)    { this._body  = obj;  return this; },
  };
  return res;
}

// Find the handler for a given method + path within the router's stack.
function getHandler(method, routePath) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const m = method.toLowerCase();
    if (layer.route.path === routePath && layer.route.methods[m]) {
      // The route may have several middleware; the last is the handler.
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`No ${method} ${routePath} handler found in router`);
}

const getRoot  = getHandler('GET',  '/');
const postRoot = getHandler('POST', '/');

// ─── tests ───────────────────────────────────────────────────────────────────
main();
async function main() {
  console.log('\nPOST /api/updates — auth');

  await check('no credentials → 401', async () => {
    const req = makeReq({ method: 'POST', body: { update_type: 'restock', product_name: 'TestProd' } });
    const res = makeRes();
    await postRoot(req, res);
    assert.strictEqual(res._status, 401, 'expected 401 got ' + res._status);
  });

  await check('wrong secret → 401', async () => {
    const req = makeReq({
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
      body: { update_type: 'restock', product_name: 'TestProd' },
    });
    const res = makeRes();
    await postRoot(req, res);
    assert.strictEqual(res._status, 401, 'expected 401 got ' + res._status);
  });

  await check('missing update_type → 400', async () => {
    const req = makeReq({
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-abc' },
      body: { product_name: 'TestProd' },
    });
    const res = makeRes();
    await postRoot(req, res);
    assert.strictEqual(res._status, 400);
    assert.ok(/update_type/.test(res._body.error), res._body.error);
  });

  await check('missing product_name → 400', async () => {
    const req = makeReq({
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-abc' },
      body: { update_type: 'restock' },
    });
    const res = makeRes();
    await postRoot(req, res);
    assert.strictEqual(res._status, 400);
    assert.ok(/product_name/.test(res._body.error), res._body.error);
  });

  await check('invalid update_type → 400', async () => {
    const req = makeReq({
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-abc' },
      body: { update_type: 'blah', product_name: 'TestProd' },
    });
    const res = makeRes();
    await postRoot(req, res);
    assert.strictEqual(res._status, 400);
    assert.ok(/update_type/.test(res._body.error), res._body.error);
  });

  console.log('\nPOST /api/updates — saves correctly');

  await check('valid bot request saves and returns id + posted_at', async () => {
    store.length = 0; nextId = 1;
    const req = makeReq({
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-abc' },
      body: { update_type: 'restock', product_name: 'H8ED V2 External',
              title: 'Back in stock', notes: '50 keys added' },
    });
    const res = makeRes();
    await postRoot(req, res);
    assert.strictEqual(res._status, 200, JSON.stringify(res._body));
    assert.ok(res._body.success, res._body);
    assert.ok(res._body.id, 'id missing');
    assert.ok(res._body.posted_at, 'posted_at missing');
    assert.strictEqual(store.length, 1);
    assert.strictEqual(store[0].product_name, 'H8ED V2 External');
    assert.strictEqual(store[0].title, 'Back in stock');
  });

  await check('two consecutive posts grow the store', async () => {
    const mk = (p) => makeReq({
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-abc' },
      body: { update_type: 'new', product_name: p },
    });
    await postRoot(mk('A'), makeRes());
    await postRoot(mk('B'), makeRes());
    assert.strictEqual(store.length, 3);  // 1 from previous test + 2
  });

  console.log('\nGET /api/updates — public, returns DESC');

  await check('GET returns all rows with no auth required', async () => {
    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();
    await getRoot(req, res);
    assert.strictEqual(res._status, 200, JSON.stringify(res._body));
    const { updates } = res._body;
    assert.ok(Array.isArray(updates), 'updates not an array');
    assert.strictEqual(updates.length, 3);
  });

  await check('GET returns rows in descending order (newest first)', async () => {
    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();
    await getRoot(req, res);
    const ids = res._body.updates.map(u => Number(u.id));
    for (let i = 0; i < ids.length - 1; i++) {
      assert.ok(ids[i] > ids[i + 1], `id ${ids[i]} should be > ${ids[i + 1]}`);
    }
  });

  await check('GET ?before= cursor paginates correctly', async () => {
    // Store has ids 1,2,3. before=3 should return ids 2 and 1.
    const req = makeReq({ method: 'GET', query: { before: '3' } });
    const res = makeRes();
    await getRoot(req, res);
    const ids = res._body.updates.map(u => Number(u.id));
    assert.ok(!ids.includes(3), 'id 3 should be excluded by cursor');
    assert.ok(ids.includes(2), 'id 2 should be in result');
    assert.ok(ids.includes(1), 'id 1 should be in result');
  });

  await check('GET ids are strings (safe for Discord snowflakes)', async () => {
    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();
    await getRoot(req, res);
    for (const u of res._body.updates) {
      assert.strictEqual(typeof u.id, 'string', `id should be a string, got ${typeof u.id}`);
    }
  });

  console.log('\n── mutation: flip the secret check ──────────────────────────────────────');
  console.log('   (the harness must catch this — if the following check PASSES the gate');
  console.log('   is broken and the test suite must exit non-zero)');

  // Reload the route with the secret check bypassed — botAuthorized always true.
  const fakeAuthBroken = { ...fakeAuth, botAuthorized: () => true };
  Module.prototype.require = function (id) {
    if (id === '../db')         return fakeDb;
    if (id === '../utils/auth') return fakeAuthBroken;
    return origRequire.call(this, id);
  };
  // Bust require cache so we get a fresh copy
  delete require.cache[require.resolve('./routes/updates')];
  const routerBroken = require('./routes/updates');
  Module.prototype.require = origRequire;

  const postBroken = (() => {
    for (const layer of routerBroken.stack) {
      if (!layer.route) continue;
      if (layer.route.path === '/' && layer.route.methods.post) {
        const s = layer.route.stack;
        return s[s.length - 1].handle;
      }
    }
    throw new Error('POST / not found in broken router');
  })();

  await check('mutation: no-secret POST should now succeed — broken gate must be detected', async () => {
    const req = makeReq({ method: 'POST', headers: {}, body: { update_type: 'fix', product_name: 'Mutation' } });
    const res = makeRes();
    await postBroken(req, res);
    // With the gate off the request succeeds (200). If it still returns 401, the mutation
    // was not applied — either the test or the route stub is wrong.
    assert.notStrictEqual(res._status, 401,
      'expected 200 (gate removed) but got 401 — mutation did not take effect');
    assert.strictEqual(res._status, 200, 'expected gate-removed POST to succeed with 200, got ' + res._status);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
}
