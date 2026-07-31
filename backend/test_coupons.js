// Tests for coupon codes — a discount that is only live for a time period.
//
// Three things can go wrong with a discount, and only one of them is arithmetic:
//
//   1. The window. "Valid until Friday" has to mean the code is dead on
//      Saturday, dead before it opens, and alive with no window set at all.
//   2. The authority. The browser types the code, but the browser must never be
//      able to STATE the discount — `total` flows into the wallet debit.
//   3. The use count. A limited coupon that two concurrent checkouts both pass,
//      or that a failed checkout silently eats, is a money bug either way.
//
//   node test_coupons.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

// ─── In-memory stand-ins for the tables ──────────────────
const TIERS = {
  1: { id: 1, price_cents: 4000, label: 'Month', product_name: 'Ghost Pro' },
  2: { id: 2, price_cents: 1550, label: null, product_name: 'Ghost Lite' },
};
let currentUser = null;
let COUPONS = [];
let REDEMPTIONS = [];
let ORDERS = [];
let nextCouponId = 1, nextRedId = 1, nextOrderId = 1000;
let balanceCents = 1000000;   // the wallet the balance path debits

const HOUR = 3600 * 1000;
const ago = ms => new Date(Date.now() - ms);
const ahead = ms => new Date(Date.now() + ms);

function makeCoupon(over) {
  const c = {
    id: nextCouponId++, guild_id: 'test-guild', code: 'SAVE', description: null,
    kind: 'percent', percent_off: 25, amount_off_cents: null,
    starts_at: null, expires_at: null, max_uses: null, max_uses_per_user: null,
    min_subtotal_cents: 0, uses: 0, active: true,
    ...over,
  };
  COUPONS.push(c);
  return c;
}

const dbPath = require.resolve('./db');
const exec = async (text, params) => {
  const t = text.replace(/\s+/g, ' ').trim();

  if (/FROM product_tiers t JOIN products p/.test(t)) {
    const ids = params[1] || [];
    return { rows: ids.map(id => TIERS[id]).filter(Boolean) };
  }
  if (/FROM web_sessions s/.test(t)) {
    return { rows: currentUser ? [{ ...currentUser, balance_cents: balanceCents }] : [] };
  }

  // ── coupons ──
  if (/FROM coupons WHERE guild_id/.test(t)) {
    const row = COUPONS.find(c => c.code === params[1]);
    return { rows: row ? [row] : [] };
  }
  if (/UPDATE coupons SET uses = uses \+ 1/.test(t)) {
    const c = COUPONS.find(x => x.id === params[0]);
    if (!c || (c.max_uses != null && c.uses >= c.max_uses)) return { rows: [] };
    c.uses += 1;
    return { rows: [{ uses: c.uses }] };
  }
  if (/UPDATE coupons SET uses = GREATEST/.test(t)) {
    const c = COUPONS.find(x => x.id === params[0]);
    if (c) c.uses = Math.max(0, c.uses - 1);
    return { rows: [] };
  }
  if (/COUNT\(\*\)::int AS n FROM coupon_redemptions/.test(t)) {
    const n = REDEMPTIONS.filter(r => r.coupon_id === params[0] && String(r.web_user_id) === String(params[1])).length;
    return { rows: [{ n }] };
  }
  if (/INSERT INTO coupon_redemptions/.test(t)) {
    const row = {
      id: nextRedId++, coupon_id: params[0], guild_id: params[1],
      web_user_id: params[2], code: params[3], discount_cents: params[4], order_id: null,
    };
    REDEMPTIONS.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (/UPDATE coupon_redemptions SET order_id/.test(t)) {
    const r = REDEMPTIONS.find(x => x.id === params[1]);
    if (r) r.order_id = params[0];
    return { rows: [] };
  }
  if (/DELETE FROM coupon_redemptions WHERE id/.test(t)) {
    const i = REDEMPTIONS.findIndex(x => x.id === params[0]);
    if (i === -1) return { rows: [] };
    const [gone] = REDEMPTIONS.splice(i, 1);
    return { rows: [{ coupon_id: gone.coupon_id }] };
  }

  // ── orders ──
  if (/INSERT INTO orders/.test(t)) {
    const row = {
      id: nextOrderId++, guild_id: params[0], web_user_id: params[1], email: params[2],
      discord_id: params[3], items_snapshot: JSON.parse(params[4]),
      subtotal_cents: params[5], total_cents: params[6], payment_method: params[7],
      payment_note: params[8], public_ref: params[9], invoice_no: params[10],
      coupon_code: params[11], coupon_discount_cents: params[12],
      status: 'waiting',
    };
    ORDERS.push(row);
    return { rows: [row] };
  }
  if (/UPDATE balances SET balance_cents/.test(t)) {
    if (balanceCents < params[0]) return { rows: [] };
    balanceCents -= params[0];
    return { rows: [{ balance_cents: balanceCents }] };
  }
  if (/UPDATE orders SET status = 'paid'/.test(t)) {
    const o = ORDERS.find(x => x.id === params[1]);
    if (o) o.status = 'paid';
    return { rows: o ? [o] : [] };
  }
  return { rows: [] };
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: exec, withTransaction: async (fn) => fn(exec), pool: {} },
};

// Delivery and the Discord notify are network side-effects with nothing to say
// about pricing. Stubbed so the suite is hermetic.
const notifyPath = require.resolve('./utils/botNotify');
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { notifyBot: async () => null },
};
const deliveryPath = require.resolve('./utils/delivery');
require.cache[deliveryPath] = {
  id: deliveryPath, filename: deliveryPath, loaded: true,
  exports: { deliver: async () => null },
};

process.env.GUILD_ID = 'test-guild';
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

const quote = (body, tok) => post('/api/orders/quote', body, tok);
const create = (body, tok) => post('/api/orders/create', body, tok);
const PRO = { id: '1', qty: 1 };            // $40.00
const LITE = { id: '2', qty: 1 };           // $15.50

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}
function section(t) { console.log('\n── ' + t + ' ──'); }
function reset() {
  COUPONS = []; REDEMPTIONS = []; ORDERS = [];
  nextCouponId = 1; nextRedId = 1;
  balanceCents = 1000000;
  currentUser = { id: 7, username: 'u', email: 'u@x.c', role: 'member', banned: false, reseller_discount: 0,
                  discord_id: '111', discord_verified: true };
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  // ─────────────────────────────────────────────────────────
  section('the time period is the feature');

  reset();
  makeCoupon({ code: 'LIVE', percent_off: 25, starts_at: ago(HOUR), expires_at: ahead(HOUR) });
  let q = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'LIVE' }, 'tok');
  await check('a coupon inside its window applies', () => {
    assert.strictEqual(q.status, 200);
    assert.strictEqual(q.body.coupon_discount, 10);   // 25% of $40
    assert.strictEqual(q.body.coupon_error, null);
  });
  await check('and the fee is charged on the DISCOUNTED subtotal', () => {
    // $40 - $10 = $30, +10% Cash App = $33. Fee-then-discount would bill the
    // fee on money the customer never sends.
    assert.strictEqual(q.body.subtotal, 40);
    assert.strictEqual(q.body.fee, 3);
    assert.strictEqual(q.body.total, 33);
  });

  reset();
  makeCoupon({ code: 'SOON', starts_at: ahead(HOUR) });
  q = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'SOON' }, 'tok');
  await check('a coupon that has not opened yet does not apply', () => {
    assert.strictEqual(q.body.coupon_discount, 0);
    assert.ok(/not active/i.test(q.body.coupon_error || ''), q.body.coupon_error);
  });
  await check('and the cart is still priced (a bad code must not blank the overlay)', () => {
    assert.strictEqual(q.status, 200);
    assert.strictEqual(q.body.total, 44);
  });

  reset();
  makeCoupon({ code: 'GONE', expires_at: ago(1000) });
  q = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'GONE' }, 'tok');
  await check('a coupon that lapsed a second ago is dead', () => {
    assert.strictEqual(q.body.coupon_discount, 0);
    assert.ok(/expired/i.test(q.body.coupon_error || ''), q.body.coupon_error);
  });

  reset();
  makeCoupon({ code: 'FOREVER' });
  q = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'FOREVER' }, 'tok');
  await check('no window at all means always live', () => assert.strictEqual(q.body.coupon_discount, 10));

  reset();
  makeCoupon({ code: 'OFF', active: false });
  q = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'OFF' }, 'tok');
  await check('a deactivated coupon is refused even inside its window', () => {
    assert.strictEqual(q.body.coupon_discount, 0);
    assert.ok(q.body.coupon_error);
  });

  // ─────────────────────────────────────────────────────────
  section('what it takes off');

  reset();
  makeCoupon({ code: 'TEN', kind: 'fixed', percent_off: null, amount_off_cents: 1500 });
  q = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'TEN' }, 'tok');
  await check('a fixed-amount coupon takes its face value', () => {
    assert.strictEqual(q.body.coupon_discount, 15);
    assert.strictEqual(q.body.total, 27.5);          // ($40-$15) * 1.10
  });

  reset();
  makeCoupon({ code: 'HUGE', kind: 'fixed', percent_off: null, amount_off_cents: 50000 });
  q = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'HUGE' }, 'tok');
  await check('a fixed coupon larger than the cart is CLAMPED, never negative', () => {
    // An unclamped $500-off on a $40 cart is a -$460 total, and a negative
    // total on the balance path is a wallet credit.
    assert.strictEqual(q.body.coupon_discount, 40);
    assert.strictEqual(q.body.total, 0);
    assert.ok(q.body.total >= 0);
  });

  reset();
  makeCoupon({ code: 'QUARTER', percent_off: 25 });
  q = await quote({ items: [LITE], payment_method: 'cashapp', coupon_code: 'QUARTER' }, 'tok');
  await check('a percentage rounds in integer cents, not float dollars', () => {
    // 25% of 1550 = 387.5 → 388. A float path lands on 387.49999… and truncates.
    assert.strictEqual(q.body.coupon_discount, 3.88);
    assert.strictEqual(q.body.total, 12.78);         // (1550-388) * 1.10 = 1278.2 → 1278
  });

  // ─────────────────────────────────────────────────────────
  section('a coupon only discounts prices WE set');

  reset();
  makeCoupon({ code: 'HALF', percent_off: 50 });
  q = await quote({
    items: [{ id: 'donation', qty: 1, price: 100 }], payment_method: 'cashapp', coupon_code: 'HALF',
  }, 'tok');
  await check('a cart of only custom payments has nothing to discount', () => {
    assert.strictEqual(q.body.coupon_discount, 0);
    assert.ok(/does not apply/i.test(q.body.coupon_error || ''), q.body.coupon_error);
    assert.strictEqual(q.body.total, 110);
  });

  reset();
  makeCoupon({ code: 'HALF', percent_off: 50 });
  q = await quote({
    items: [PRO, { id: 'donation', qty: 1, price: 100 }], payment_method: 'cashapp', coupon_code: 'HALF',
  }, 'tok');
  await check('in a mixed cart it applies to the catalog lines only', () => {
    // 50% of the $40 catalog line = $20. The $100 the customer typed is theirs.
    assert.strictEqual(q.body.subtotal, 140);
    assert.strictEqual(q.body.coupon_discount, 20);
    assert.strictEqual(q.body.total, 132);           // ($140-$20) * 1.10
  });

  reset();
  makeCoupon({ code: 'BIGONLY', min_subtotal_cents: 10000 });
  q = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'BIGONLY' }, 'tok');
  await check('a minimum subtotal is enforced', () => {
    assert.strictEqual(q.body.coupon_discount, 0);
    assert.ok(/at least \$100\.00/.test(q.body.coupon_error || ''), q.body.coupon_error);
  });

  reset();
  makeCoupon({ code: 'STACK', percent_off: 10 });
  currentUser = { id: 7, username: 'r', email: 'r@x.c', role: 'reseller', banned: false, reseller_discount: 25,
                 discord_id: '111', discord_verified: true };
  q = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'STACK' }, 'tok');
  await check('a coupon stacks on top of the reseller discount, in that order', () => {
    // $40 → reseller 25% → $30 → coupon 10% of $30 = $3 → $27 → +10% fee.
    assert.strictEqual(q.body.subtotal, 30);
    assert.strictEqual(q.body.coupon_discount, 3);
    assert.strictEqual(q.body.total, 29.7);
  });

  // ─────────────────────────────────────────────────────────
  section('the browser types the code, it never states the discount');

  reset();
  q = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'NOSUCHCODE' }, 'tok');
  await check('an unknown code is reported, not honoured', () => {
    assert.strictEqual(q.status, 200);
    assert.strictEqual(q.body.coupon_discount, 0);
    assert.strictEqual(q.body.total, 44);
    assert.ok(q.body.coupon_error);
  });
  await check('an unknown code does not reveal whether it ever existed', () => {
    assert.ok(!/expired|redeemed|not active/i.test(q.body.coupon_error));
  });

  await check('a malformed code is rejected without pretending to price it', async () => {
    const r = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'no spaces $$' }, 'tok');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.coupon_error);
    assert.strictEqual(r.body.total, 44);
  });

  await check('a client-sent coupon_discount is ignored entirely', async () => {
    const r = await quote({
      items: [PRO], payment_method: 'cashapp', coupon_discount: 39.99, discount: 39.99, total: 0.01,
    }, 'tok');
    assert.strictEqual(r.body.coupon_discount, 0);
    assert.strictEqual(r.body.total, 44);
  });

  reset();
  makeCoupon({ code: 'GONE', expires_at: ago(1000) });
  await check('/create REFUSES an invalid code rather than quietly charging full price', async () => {
    // The failure mode this guards: the overlay showed $33, the code lapsed
    // between quote and submit, and the customer is charged $44 with no notice.
    const r = await create({ items: [PRO], payment_method: 'cashapp', email: 'u@x.c', coupon_code: 'GONE' }, 'tok');
    assert.strictEqual(r.status, 400);
    assert.ok(/expired/i.test(r.body.error || ''), r.body.error);
    assert.strictEqual(ORDERS.length, 0);
  });

  // ─────────────────────────────────────────────────────────
  section('usage limits');

  reset();
  makeCoupon({ code: 'ONCE', max_uses: 1 });
  await check('the first checkout consumes the only use', async () => {
    const r = await create({ items: [PRO], payment_method: 'cashapp', email: 'u@x.c', coupon_code: 'ONCE' }, 'tok');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.total, 33);
    assert.strictEqual(COUPONS[0].uses, 1);
  });
  await check('and the order stores what was actually taken off', () => {
    assert.strictEqual(ORDERS[0].coupon_code, 'ONCE');
    assert.strictEqual(ORDERS[0].coupon_discount_cents, 1000);
    // The GROSS subtotal is kept beside it so a receipt can show the line
    // rather than an unexplained gap.
    assert.strictEqual(ORDERS[0].subtotal_cents, 4000);
    assert.strictEqual(ORDERS[0].total_cents, 3300);
    // The reference the customer is shown and types into /claim-customer. It is
    // written at INSERT time, not backfilled later, so an order can never exist
    // without one — the positional map above is what catches a column being
    // added to the statement without this test noticing.
    assert.match(ORDERS[0].invoice_no, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });
  await check('the redemption is linked to the order it paid for', () => {
    assert.strictEqual(REDEMPTIONS.length, 1);
    assert.strictEqual(REDEMPTIONS[0].order_id, ORDERS[0].id);
    assert.strictEqual(REDEMPTIONS[0].discount_cents, 1000);
  });
  await check('the second checkout is refused', async () => {
    const r = await create({ items: [PRO], payment_method: 'cashapp', email: 'u@x.c', coupon_code: 'ONCE' }, 'tok');
    assert.strictEqual(r.status, 400);
    assert.ok(/fully redeemed/i.test(r.body.error || ''), r.body.error);
    assert.strictEqual(COUPONS[0].uses, 1);   // not 2
  });
  await check('and an exhausted coupon stops quoting a discount too', async () => {
    const r = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'ONCE' }, 'tok');
    assert.strictEqual(r.body.coupon_discount, 0);
    assert.ok(/fully redeemed/i.test(r.body.coupon_error || ''));
  });

  reset();
  makeCoupon({ code: 'PERPERSON', max_uses_per_user: 1 });
  await check('a per-user cap lets the first order through', async () => {
    const r = await create({ items: [PRO], payment_method: 'cashapp', email: 'u@x.c', coupon_code: 'PERPERSON' }, 'tok');
    assert.strictEqual(r.status, 200);
  });
  await check('and blocks the same account the second time', async () => {
    const r = await create({ items: [PRO], payment_method: 'cashapp', email: 'u@x.c', coupon_code: 'PERPERSON' }, 'tok');
    assert.strictEqual(r.status, 400);
    assert.ok(/already used/i.test(r.body.error || ''), r.body.error);
  });
  await check('but a different account may still use it', async () => {
    currentUser = { id: 99, username: 'other', email: 'o@x.c', role: 'member', banned: false, reseller_discount: 0,
                   discord_id: '222', discord_verified: true };
    const r = await create({ items: [PRO], payment_method: 'cashapp', email: 'o@x.c', coupon_code: 'PERPERSON' }, 'tok');
    assert.strictEqual(r.status, 200);
  });
  await check('a per-user cap requires a session — a guest cannot replay it', async () => {
    // With no account there is nothing to count against, so "one per customer"
    // would be unenforceable. Say so instead of pretending.
    currentUser = null;
    const r = await quote({ items: [PRO], payment_method: 'cashapp', coupon_code: 'PERPERSON' });
    assert.ok(/log in/i.test(r.body.coupon_error || ''), r.body.coupon_error);
  });

  // ─────────────────────────────────────────────────────────
  section('a checkout that fails must not eat the use');

  reset();
  makeCoupon({ code: 'ONCE', max_uses: 1 });
  balanceCents = 100;   // $1.00 — nowhere near the $30 discounted total
  await check('an insufficient balance is refused', async () => {
    const r = await create({ items: [PRO], payment_method: 'balance', coupon_code: 'ONCE' }, 'tok');
    assert.strictEqual(r.status, 400);
    assert.ok(/insufficient/i.test(r.body.error || ''), r.body.error);
  });
  await check('and the use is handed back, not stranded', () => {
    // Without release(), a limited coupon is silently burned by a checkout the
    // customer never completed — and they cannot use it again.
    assert.strictEqual(COUPONS[0].uses, 0);
    assert.strictEqual(REDEMPTIONS.length, 0);
  });
  await check('so the customer can still redeem it once funded', async () => {
    balanceCents = 1000000;
    const r = await create({ items: [PRO], payment_method: 'balance', coupon_code: 'ONCE' }, 'tok');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(COUPONS[0].uses, 1);
  });

  reset();
  makeCoupon({ code: 'WALLET', percent_off: 50 });
  balanceCents = 2000;   // exactly the discounted total, $20.00
  await check('a wallet holding exactly the DISCOUNTED total is enough', async () => {
    // The pre-flight balance check has to know about the coupon, or a customer
    // is turned away for being short of a price they were never charged.
    const r = await create({ items: [PRO], payment_method: 'balance', coupon_code: 'WALLET' }, 'tok');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.total, 20);
  });
  await check('and the wallet is debited the discounted amount, not the list price', () => {
    assert.strictEqual(balanceCents, 0);
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
})();
