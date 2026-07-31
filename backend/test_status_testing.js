// POST /api/status/update is the only thing validating a product status —
// neither products.status nor product_status.status carries a CHECK
// constraint. So the whitelist in routes/status.js IS the schema, and a status
// the admin panel can pick but the route rejects shows up as a silent
// "Save failed" on a dropdown that looked fine.
//
// Adding the fourth status ('testing') is therefore only done when the route
// accepts it AND still refuses everything else.
//
//   node test_status_testing.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

// ─── Stub the DB ─────────────────────────────────────────
// Records what got written so the test can prove the status reached BOTH
// tables — product_status is what the status page reads, products.status is
// the fallback when there's no override row, and only writing one of them
// makes a status that reverts on the next deploy.
const writes = { product_status: [], products: [] };
const dbPath = require.resolve('./db');
const exec = async (text, params) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (/INSERT INTO product_status/.test(t)) { writes.product_status.push(params); return { rows: [] }; }
  if (/UPDATE products SET status/.test(t)) { writes.products.push(params); return { rows: [] }; }
  if (/FROM products WHERE id/.test(t)) return { rows: [{ game_name: 'Rust', name: 'Ghost Pro' }] };
  return { rows: [] };
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: exec, withTransaction: async (fn) => fn(exec), pool: {} },
};

process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';
process.env.API_SECRET = 'test-secret';

const app = express();
app.use(express.json());
app.use('/api/status', require('./routes/status'));
const server = http.createServer(app);

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
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

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

const asBot = (status) => ({ secret: 'test-secret', product_id: '7', status });

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  console.log('\nfour product statuses, not three');

  for (const s of ['undetected', 'testing', 'updating', 'detected']) {
    await check(`'${s}' is accepted`, async () => {
      const r = await post('/api/status/update', asBot(s));
      assert.strictEqual(r.status, 200, `got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.success, true);
    });
  }

  await check('testing is written to product_status AND products', async () => {
    writes.product_status.length = 0;
    writes.products.length = 0;
    await post('/api/status/update', asBot('testing'));
    assert.strictEqual(writes.product_status.length, 1, 'no product_status row');
    assert.ok(writes.product_status[0].includes('testing'), 'status not in the product_status params');
    assert.strictEqual(writes.products.length, 1, 'products.status was not updated');
    assert.strictEqual(writes.products[0][0], 'testing');
  });

  // The whitelist has to stay a whitelist. 'detected' was previously the only
  // value the /webstatus colour ternary fell through to, so a typo used to
  // paint a product red rather than fail.
  for (const s of ['TESTING', 'test', 'tested', 'undetcted', 'live', '', null, 'undetected; DROP TABLE products']) {
    await check(`'${s}' is refused`, async () => {
      const r = await post('/api/status/update', asBot(s));
      assert.strictEqual(r.status, 400, `got ${r.status}`);
      assert.ok(/status must be one of/.test(r.body.error || ''), 'error should name the valid values');
    });
  }

  await check('the error message lists all four so the panel can be fixed', async () => {
    const r = await post('/api/status/update', asBot('nope'));
    for (const s of ['undetected', 'testing', 'updating', 'detected']) {
      assert.ok(r.body.error.includes(s), `${s} missing from: ${r.body.error}`);
    }
  });

  // Unauthenticated callers must still be turned away — the status page is a
  // public read, but writing it is not.
  await check('a caller with no secret and no session is rejected', async () => {
    const r = await post('/api/status/update', { product_id: '7', status: 'testing' });
    assert.strictEqual(r.status, 401);
  });

  await check('a wrong secret is rejected', async () => {
    const r = await post('/api/status/update', { secret: 'nope', product_id: '7', status: 'testing' });
    assert.strictEqual(r.status, 401);
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
})();
