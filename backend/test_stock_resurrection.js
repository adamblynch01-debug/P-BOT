// Tests for the stock routes' anti-resurrection guard.
//
// The vault admin panel posts the BROWSER's mirror of a tier, which still holds
// every key it has ever seen — including ones sold since, because nothing tells
// the browser about a sale. A routine SAVE therefore re-listed credentials that
// had already been delivered to paying customers as available, and the
// stock_log entry read like an ordinary restock. The same class of bug let the
// vault keygen hand out keys without ever marking them used.
//
//   node test_stock_resurrection.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

// ─── Fake product_stock ──────────────────────────────────
// rows: { id, tier_id, value, used }
let rows = [];
let nextId = 1;
let logged = [];

const dbPath = require.resolve('./db');
const exec = async (text, params) => {
  const t = text.replace(/\s+/g, ' ').trim();

  if (/SELECT COUNT\(\*\)::int AS n FROM product_stock/.test(t)) {
    const n = rows.filter(r => String(r.tier_id) === String(params[1]) && !r.used).length;
    return { rows: [{ n }] };
  }
  if (/SELECT value FROM product_stock .* used = true/.test(t)) {
    return { rows: rows.filter(r => String(r.tier_id) === String(params[1]) && r.used).map(r => ({ value: r.value })) };
  }
  if (/DELETE FROM product_stock/.test(t)) {
    rows = rows.filter(r => !(String(r.tier_id) === String(params[1]) && !r.used));
    return { rows: [] };
  }
  if (/INSERT INTO product_stock .* unnest/.test(t)) {
    for (const v of params[2]) rows.push({ id: nextId++, tier_id: params[1], value: v, used: false });
    return { rows: [] };
  }
  if (/UPDATE product_stock SET used = true/.test(t)) {
    const avail = rows.filter(r => String(r.tier_id) === String(params[1]) && !r.used)
                      .sort((a, b) => a.id - b.id)
                      .slice(0, params[2]);
    for (const r of avail) r.used = true;
    return { rows: avail.map(r => ({ value: r.value })) };
  }
  if (/INSERT INTO stock_log/.test(t)) { logged.push(params); return { rows: [] }; }
  if (/SELECT .* FROM product_tiers/.test(t)) return { rows: [{ id: params[0], product_name: 'Test', label: 'T' }] };
  return { rows: [] };
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: exec, withTransaction: async (fn) => fn(exec), pool: {} },
};

process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';
process.env.API_SECRET = 'test-secret';

// Authenticate as the bot via the shared secret so isAuthorizedOrAdmin passes
// without needing a session.
const app = express();
app.use(express.json());
app.use('/api/stock', require('./routes/stock'));
const server = http.createServer(app);

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(Object.assign({ secret: 'test-secret' }, body));
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

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  console.log('\nsold keys are never resurrected');

  // Tier 1: 10 keys, 4 sold.
  rows = []; nextId = 1;
  const all = Array.from({ length: 10 }, (_, i) => 'KEY-' + (i + 1));
  await post('/api/stock/set', { product_id: 1, items: all });
  rows.filter(r => ['KEY-1', 'KEY-2', 'KEY-3', 'KEY-4'].includes(r.value)).forEach(r => { r.used = true; });

  // The browser re-posts its full mirror (all 10) plus one new key.
  const resp = await post('/api/stock/set', { product_id: 1, items: all.concat(['KEY-11']) });

  await check('the four sold keys are NOT re-listed as available', () => {
    const unsoldValues = rows.filter(r => !r.used).map(r => r.value);
    for (const sold of ['KEY-1', 'KEY-2', 'KEY-3', 'KEY-4']) {
      assert.ok(!unsoldValues.includes(sold), `${sold} was resurrected`);
    }
  });
  await check('the sold rows are still marked used (history preserved)', () => {
    const used = rows.filter(r => r.used).map(r => r.value).sort();
    assert.deepStrictEqual(used, ['KEY-1', 'KEY-2', 'KEY-3', 'KEY-4']);
  });
  await check('the response reports how many were ignored', () => {
    assert.strictEqual(resp.body.skipped_already_sold, 4);
    assert.strictEqual(resp.body.count, 7); // KEY-5..10 + KEY-11
  });

  console.log('\ninput validation');

  await check('a non-array items is rejected, not crashed on', async () => {
    const r = await post('/api/stock/set', { product_id: 2, items: 'not-an-array' });
    assert.strictEqual(r.status, 400);
  });
  await check('an oversized upload is refused', async () => {
    const r = await post('/api/stock/add', { product_id: 2, items: new Array(10001).fill('x') });
    assert.strictEqual(r.status, 400);
  });
  await check('duplicate keys in one paste are deduped', async () => {
    rows = []; nextId = 1;
    const r = await post('/api/stock/set', { product_id: 3, items: ['A', 'A', 'A', 'B'] });
    assert.strictEqual(r.body.count, 2);
    assert.strictEqual(rows.filter(x => String(x.tier_id) === '3').length, 2);
  });

  console.log('\nmanual issue marks keys used');

  rows = []; nextId = 1;
  await post('/api/stock/set', { product_id: 4, items: ['M1', 'M2', 'M3'] });
  const issued = await post('/api/stock/issue', { product_id: 4, qty: 2 });

  await check('issue returns the keys', () => {
    assert.strictEqual(issued.status, 200);
    assert.strictEqual(issued.body.items.length, 2);
  });
  await check('issued keys are marked used, so checkout cannot sell them again', () => {
    const used = rows.filter(r => r.used).map(r => r.value).sort();
    assert.deepStrictEqual(used, ['M1', 'M2']);
  });
  await check('only the unissued key remains available', () => {
    const avail = rows.filter(r => !r.used).map(r => r.value);
    assert.deepStrictEqual(avail, ['M3']);
  });
  await check('issuing more than stock returns 404 rather than partial silence', async () => {
    const r = await post('/api/stock/issue', { product_id: 4, qty: 50 });
    // One key left, so it issues that one; a second call has nothing.
    assert.ok(r.status === 200 || r.status === 404);
    const r2 = await post('/api/stock/issue', { product_id: 4, qty: 1 });
    assert.strictEqual(r2.status, 404);
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
})();
