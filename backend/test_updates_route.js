'use strict';
// Tests for GET/POST /api/updates.
//
// Auth: botAuthorized() reads req.body.secret (body-based, same as
// POST /api/status/update). Bearer header is NOT the gate here.
//
// Mutation: a route with botAuthorized always true must be caught by
// no-secret and wrong-secret. Both checks are required -- remove either
// and the mutation slips through.
//
//   node backend/test_updates_route.js

const assert = require('assert');
let passed = 0, failed = 0;
const check = async (name, fn) => {
  try   { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

const Module = require('module');
const origRequire = Module.prototype.require;
const store = []; let nextId = 1;

const fakeDb = {
  query: async (sql, params) => {
    if (/INSERT INTO product_updates/.test(sql)) {
      const id = nextId++;
      store.push({ id, guild_id: params[0], update_type: params[1], product_name: params[2],
        title: params[3], notes: params[4], status_from: params[5], status_to: params[6],
        image_url: params[7], posted_at: new Date().toISOString() });
      return { rows: [{ id, posted_at: store[store.length - 1].posted_at }] };
    }
    if (/SELECT[\s\S]*FROM product_updates/.test(sql)) {
      const gid = params[0], before = params[1] ? Number(params[1]) : null, limit = params[2] || 50;
      return { rows: store.filter(r => r.guild_id === gid && (before == null || r.id < before))
        .sort((a, b) => b.id - a.id).slice(0, limit).map(r => ({ ...r })) };
    }
    return { rows: [] };
  },
};

// mirrors backend/utils/auth.js: body.secret || query.secret
const fakeAuth = {
  botAuthorized:  (req) => { const s = (req.body && req.body.secret) || (req.query && req.query.secret) || ''; return !!s && s === process.env.API_SECRET; },
  bearerToken:    () => null,
  getSessionUser: async () => null,
  botAuthUnavailable: () => false,
};

function loadRoute(auth) {
  Module.prototype.require = function (id) {
    if (id === '../db')         return fakeDb;
    if (id === '../utils/auth') return auth;
    return origRequire.call(this, id);
  };
  delete require.cache[require.resolve('./routes/updates')];
  const r = require('./routes/updates');
  Module.prototype.require = origRequire;
  return r;
}

process.env.GUILD_ID   = 'TEST_GUILD';
process.env.API_SECRET = 'test-secret-abc';

function makeReq({ body = {}, query = {} } = {}) { return { body, query, headers: {}, params: {} }; }
function makeRes() { return { _status:200, _body:null, status(c){this._status=c;return this;}, json(o){this._body=o;return this;} }; }
function getHandler(router, method) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path === '/' && layer.route.methods[method.toLowerCase()]) { const s=layer.route.stack; return s[s.length-1].handle; }
  }
  throw new Error('No ' + method + ' / handler found');
}

main();
async function main() {
  const router   = loadRoute(fakeAuth);
  const postRoot = getHandler(router, 'POST');
  const getRoot  = getHandler(router, 'GET');

  console.log('\nPOST /api/updates -- auth gate  [both needed to kill mutations]');

  await check('no-secret -> 401  [mutation kill A]', async () => {
    const res = makeRes();
    await postRoot(makeReq({ body: { update_type: 'restock', product_name: 'X' } }), res);
    assert.strictEqual(res._status, 401);
  });
  await check('wrong-secret -> 401  [mutation kill B]', async () => {
    const res = makeRes();
    await postRoot(makeReq({ body: { secret: 'wrong', update_type: 'restock', product_name: 'X' } }), res);
    assert.strictEqual(res._status, 401);
  });

  console.log('\nPOST /api/updates -- input validation');

  await check('missing update_type -> 400', async () => {
    const res = makeRes();
    await postRoot(makeReq({ body: { secret: 'test-secret-abc', product_name: 'X' } }), res);
    assert.strictEqual(res._status, 400); assert.ok(/update_type/.test(res._body.error));
  });
  await check('missing product_name -> 400', async () => {
    const res = makeRes();
    await postRoot(makeReq({ body: { secret: 'test-secret-abc', update_type: 'restock' } }), res);
    assert.strictEqual(res._status, 400); assert.ok(/product_name/.test(res._body.error));
  });
  await check('unknown update_type -> 400', async () => {
    const res = makeRes();
    await postRoot(makeReq({ body: { secret: 'test-secret-abc', update_type: 'blah', product_name: 'X' } }), res);
    assert.strictEqual(res._status, 400); assert.ok(/update_type/.test(res._body.error));
  });

  console.log('\nPOST /api/updates -- SUPERBOT type coverage');

  const superbotTypes = ['status_change','update','patch','undetected','detected','disabled','enabled',
    'new_product','sale','bug_fix','time_extension','new_feature'];
  for (const t of superbotTypes) {
    await check('type "' + t + '" accepted', async () => {
      const res = makeRes();
      await postRoot(makeReq({ body: { secret: 'test-secret-abc', update_type: t, product_name: 'P' } }), res);
      assert.strictEqual(res._status, 200, 'update_type "' + t + '" rejected -- add it to VALID_TYPES');
    });
  }

  console.log('\nPOST /api/updates -- saves correctly');

  await check('valid post saves and returns id + posted_at', async () => {
    store.length = 0; nextId = 1;
    const res = makeRes();
    await postRoot(makeReq({ body: { secret: 'test-secret-abc', update_type: 'restock',
      product_name: 'H8ED V2', title: 'Back in stock', notes: '50 keys' } }), res);
    assert.strictEqual(res._status, 200, JSON.stringify(res._body));
    assert.ok(res._body.success); assert.ok(res._body.id); assert.ok(res._body.posted_at);
    assert.strictEqual(store.length, 1); assert.strictEqual(store[0].title, 'Back in stock');
  });

  console.log('\nGET /api/updates -- public, DESC order');

  await check('GET requires no auth', async () => {
    const res = makeRes(); await getRoot(makeReq(), res);
    assert.strictEqual(res._status, 200); assert.ok(Array.isArray(res._body.updates));
  });
  await check('GET returns newest first', async () => {
    for (const p of ['Alpha', 'Beta']) { const r=makeRes(); await postRoot(makeReq({body:{secret:'test-secret-abc',update_type:'new',product_name:p}}),r); }
    const res = makeRes(); await getRoot(makeReq(), res);
    const ids = res._body.updates.map(u => Number(u.id));
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i-1] > ids[i]);
  });
  await check('GET ?before= cursor excludes the pivot id', async () => {
    const res = makeRes();
    await getRoot(makeReq({ query: { before: '3' } }), res);
    const ids = res._body.updates.map(u => Number(u.id));
    assert.ok(!ids.includes(3)); assert.ok(ids.includes(2) && ids.includes(1));
  });
  await check('GET ids are strings', async () => {
    const res = makeRes(); await getRoot(makeReq(), res);
    for (const u of res._body.updates) assert.strictEqual(typeof u.id, 'string');
  });

  console.log('\n-- mutation: gate disabled --');

  const brokenRouter   = loadRoute({ ...fakeAuth, botAuthorized: () => true });
  const brokenPostRoot = getHandler(brokenRouter, 'POST');
  await check('no-secret POST succeeds on broken gate (proves kill-A matters)', async () => {
    const res = makeRes();
    await brokenPostRoot(makeReq({ body: { update_type: 'fix', product_name: 'Mutation' } }), res);
    assert.strictEqual(res._status, 200, 'expected 200 from gate-disabled route');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}
