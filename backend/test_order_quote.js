// Tests for POST /api/orders/quote — the single authority for what a cart costs.
//
// The payment overlay used to compute the method fee and grand total in the
// browser from a separately-fetched config. When that config request failed the
// fee row silently vanished and TOTAL showed the bare subtotal, while the
// payment instructions (server-generated) asked for the fee-inclusive amount.
// Customers sent the smaller figure, the watcher rejected it as an
// underpayment, and the order sat unpaid with the buyer certain they had paid.
//
// What matters here: quote and create must agree, always.
//
//   node test_order_quote.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

// ─── Stub the DB: two priced tiers ───────────────────────
const TIERS = {
  1: { id: 1, price_cents: 4000, label: 'Month', product_name: 'Ghost Pro' },
  2: { id: 2, price_cents: 1550, label: null, product_name: 'Ghost Lite' },
};
let currentUser = null;

const dbPath = require.resolve('./db');
const exec = async (text, params) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (/FROM product_tiers t JOIN products p/.test(t)) {
    const ids = params[1] || [];
    return { rows: ids.map(id => TIERS[id]).filter(Boolean) };
  }
  if (/FROM web_sessions s/.test(t)) {
    return { rows: currentUser ? [currentUser] : [] };
  }
  return { rows: [] };
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: exec, withTransaction: async (fn) => fn(exec), pool: {} },
};

process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';
process.env.CASHAPP_FEE_PERCENT = '10';
process.env.PAYPAL_FEE_PERCENT = '10';
process.env.CRYPTO_FEE_PERCENT = '5';

const app = express();
app.use(express.json());
app.use('/api/orders', require('./routes/orders'));
const server = http.createServer(app);

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers,
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

  console.log('\nthe server prices the cart, not the browser');

  // A client-sent price must be ignored entirely.
  let q = await post('/api/orders/quote', {
    items: [{ id: '1', qty: 1, price: 0.01, name: 'LIES' }],
    payment_method: 'cashapp',
  });
  await check('a client-supplied price is ignored', () => {
    assert.strictEqual(q.status, 200);
    assert.strictEqual(q.body.subtotal, 40);       // from product_tiers, not 0.01
  });
  await check('the Cash App fee is applied (10%)', () => {
    assert.strictEqual(q.body.fee, 4);
    assert.strictEqual(q.body.total, 44);
  });
  await check('the fee is described for the UI', () => {
    assert.ok(/10%/.test(q.body.fee_note), 'fee_note missing the percentage');
  });
  await check('the item name comes from the catalog, not the request', () => {
    assert.ok(/Ghost Pro/.test(q.body.items[0].name));
    assert.ok(!/LIES/.test(JSON.stringify(q.body.items)));
  });

  console.log('\nfees differ per method and crypto is cheaper');

  const cash = await post('/api/orders/quote', { items: [{ id: '1', qty: 1 }], payment_method: 'cashapp' });
  const btc  = await post('/api/orders/quote', { items: [{ id: '1', qty: 1 }], payment_method: 'btc' });
  await check('crypto carries the 5% fee', () => assert.strictEqual(btc.body.total, 42));
  await check('crypto total is below the Cash App total', () => {
    assert.ok(btc.body.total < cash.body.total);
  });

  console.log('\nquantities and rounding');

  q = await post('/api/orders/quote', { items: [{ id: '2', qty: 3 }], payment_method: 'cashapp' });
  await check('qty multiplies the catalog price', () => assert.strictEqual(q.body.subtotal, 46.5));
  await check('the fee is computed in integer cents, never a float drift', () => {
    // 4650 cents * 1.10 = 5115 exactly. A float path yields 5114.999... and
    // toFixed would round DOWN — a systematic undercharge.
    assert.strictEqual(q.body.total, 51.15);
    assert.strictEqual(q.body.fee, 4.65);
  });

  console.log('\nquote and create agree');

  const both = await Promise.all([
    post('/api/orders/quote', { items: [{ id: '1', qty: 2 }, { id: '2', qty: 1 }], payment_method: 'paypal' }),
    post('/api/orders/quote', { items: [{ id: '1', qty: 2 }, { id: '2', qty: 1 }], payment_method: 'paypal' }),
  ]);
  await check('the same cart quotes identically twice', () => {
    assert.strictEqual(both[0].body.total, both[1].body.total);
  });
  await check('subtotal + fee === total (no display-only rounding gap)', () => {
    const b = both[0].body;
    assert.strictEqual(Math.round((b.subtotal + b.fee) * 100), Math.round(b.total * 100));
  });

  console.log('\nvalidation');

  await check('an empty cart is refused', async () => {
    const r = await post('/api/orders/quote', { items: [], payment_method: 'cashapp' });
    assert.strictEqual(r.status, 400);
  });
  await check('balance checkout without a session is refused', async () => {
    currentUser = null;
    const r = await post('/api/orders/quote', { items: [{ id: '1', qty: 1 }], payment_method: 'balance' });
    assert.strictEqual(r.status, 401);
  });
  await check('an unknown tier cannot be balance-purchased', async () => {
    currentUser = { id: 7, username: 'u', email: 'u@x.c', role: 'member', banned: false, reseller_discount: 0, balance_cents: 100000 };
    const r = await post('/api/orders/quote', { items: [{ id: 'made-up-slug', qty: 1, price: 5 }], payment_method: 'balance' }, 'tok');
    assert.strictEqual(r.status, 400);
  });

  console.log('\nreseller discount comes from the session, not the request');

  currentUser = { id: 7, username: 'r', email: 'r@x.c', role: 'reseller', banned: false, reseller_discount: 25, balance_cents: 0 };
  q = await post('/api/orders/quote', { items: [{ id: '1', qty: 1 }], payment_method: 'cashapp' }, 'tok');
  await check('the discount is applied server-side', () => {
    assert.strictEqual(q.body.discount_percent, 25);
    assert.strictEqual(q.body.subtotal, 30);   // 40 - 25%
  });
  await check('the fee is charged on the DISCOUNTED subtotal', () => {
    assert.strictEqual(q.body.total, 33);      // 30 + 10%
  });
  await check('a discount cannot be requested by an ordinary account', async () => {
    currentUser = { id: 8, username: 'm', email: 'm@x.c', role: 'member', banned: false, reseller_discount: 0, balance_cents: 0 };
    const r = await post('/api/orders/quote',
      { items: [{ id: '1', qty: 1 }], payment_method: 'cashapp', discount_percent: 90, reseller_discount: 90 }, 'tok');
    assert.strictEqual(r.body.discount_percent, 0);
    assert.strictEqual(r.body.subtotal, 40);
  });

  console.log('\na custom payment may use the wallet — nothing else client-priced may');

  // Custom orders are the one client-priced item allowed on the balance path.
  // The reason it is safe is narrow and worth pinning: the id names no
  // product, so there is nothing to underprice, and the customer debits their
  // own wallet by the figure they typed. The moment that whitelist widens to
  // any non-numeric id, a synthetic slug for a REAL product sells for a cent.
  currentUser = { id: 9, username: 'c', email: 'c@x.c', role: 'member', banned: false, reseller_discount: 0, balance_cents: 500000 };

  q = await post('/api/orders/quote', { items: [{ id: 'donation', qty: 1, price: 25, name: 'Custom Order' }], payment_method: 'balance' }, 'tok');
  await check('a custom order can be paid from balance', () => {
    assert.strictEqual(q.status, 200);
    assert.strictEqual(q.body.subtotal, 25);
  });
  await check('and the wallet charges no fee', () => {
    assert.strictEqual(q.body.fee, 0);
    assert.strictEqual(q.body.total, 25);
  });
  await check('the alias id custom-amount works too', async () => {
    const r = await post('/api/orders/quote', { items: [{ id: 'custom-amount', qty: 1, price: 12.5 }], payment_method: 'balance' }, 'tok');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.total, 12.5);
  });

  await check('a NEGATIVE custom amount cannot credit the wallet', async () => {
    const r = await post('/api/orders/quote', { items: [{ id: 'donation', qty: 1, price: -50 }], payment_method: 'balance' }, 'tok');
    assert.strictEqual(r.status, 400);
  });
  await check('a zero custom amount is refused', async () => {
    const r = await post('/api/orders/quote', { items: [{ id: 'donation', qty: 1, price: 0 }], payment_method: 'balance' }, 'tok');
    assert.strictEqual(r.status, 400);
  });

  await check('a real product slug is STILL barred from balance', async () => {
    // The whole point of the whitelist: this must keep failing.
    const r = await post('/api/orders/quote',
      { items: [{ id: 'ghost-pro-month', qty: 1, price: 0.01 }], payment_method: 'balance' }, 'tok');
    assert.strictEqual(r.status, 400);
  });
  await check('and it stays barred when smuggled beside a valid custom payment', async () => {
    const r = await post('/api/orders/quote', {
      items: [{ id: 'donation', qty: 1, price: 5 }, { id: 'ghost-pro-month', qty: 1, price: 0.01 }],
      payment_method: 'balance',
    }, 'tok');
    assert.strictEqual(r.status, 400);
  });

  await check('a reseller gets NO discount on a custom amount', async () => {
    // The server deliberately does not discount a price it did not set. The
    // storefront must not either, or the wallet reads "available" on a total
    // the server then rejects as short.
    currentUser = { id: 10, username: 'r2', email: 'r2@x.c', role: 'reseller', banned: false, reseller_discount: 25, balance_cents: 500000 };
    const r = await post('/api/orders/quote', { items: [{ id: 'donation', qty: 1, price: 100 }], payment_method: 'balance' }, 'tok');
    assert.strictEqual(r.body.subtotal, 100);
    assert.strictEqual(r.body.total, 100);
  });

  await check('a custom payment still works on an external method', async () => {
    const r = await post('/api/orders/quote', { items: [{ id: 'donation', qty: 1, price: 40 }], payment_method: 'cashapp' }, 'tok');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.total, 44);   // 40 + 10%, undiscounted
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
})();
