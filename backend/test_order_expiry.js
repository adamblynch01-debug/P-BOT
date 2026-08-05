// What the expiry sweeper is allowed to close, and what it must leave alone.
//
// The finding these pin: `orders.expires_at` was written on every order and
// read by nobody except the two watchers, which use it only to decide what they
// will NOT settle. So an order that passed its deadline became permanently
// unconfirmable while still reading 'waiting' — listed by
// /manual-order-delivery pending as though staff could act on it. One was
// thirteen days old.
//
// The risk in fixing it is the opposite one: a sweeper that closes an order
// somebody has actually paid for. Every check below is about that.
//
//   node test_order_expiry.js
'use strict';

const assert = require('assert');

process.env.GUILD_ID = 'test-guild';

// ─── A fake `orders` table that answers the sweeper's one UPDATE ─────────────
//
// The statement is matched, not executed: what is being pinned is the WHERE
// clause, so the rows it selects are worked out here from the same predicates
// spelled out in JS. If a guard is dropped from the SQL, the parse below stops
// finding it and the corresponding test fails.
let ORDERS = [];
let lastSql = '';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
const ahead = ms => new Date(NOW + ms).toISOString();
const HOUR = 3600000;

function runUpdate(sql) {
  lastSql = sql.replace(/\s+/g, ' ').trim();
  const has = re => re.test(lastSql);

  // Each guard is honoured only if it is actually present in the statement.
  const hit = ORDERS.filter(o => {
    if (has(/guild_id = \$1/) && o.guild_id !== process.env.GUILD_ID) return false;
    if (has(/status = 'waiting'/) && o.status !== 'waiting') return false;
    if (has(/expires_at IS NOT NULL/) && o.expires_at == null) return false;
    if (has(/expires_at < now\(\)/) && !(o.expires_at != null && Date.parse(o.expires_at) < NOW)) return false;
    if (has(/COALESCE\(amount_received_cents, 0\) = 0/) && (Number(o.amount_received_cents) || 0) !== 0) return false;
    if (has(/COALESCE\(amount_received_native, 0\) = 0/) && (Number(o.amount_received_native) || 0) !== 0) return false;
    return true;
  });

  const to = (lastSql.match(/SET status = '(\w+)'/) || [])[1];
  hit.forEach(o => { o.status = to; });
  return { rows: hit.map(o => ({ ...o })) };
}

const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (text) => (/^UPDATE orders/i.test(text.trim()) ? runUpdate(text) : { rows: [] }),
    withTransaction: async (fn) => fn(async () => ({ rows: [] })),
    pool: {},
  },
};

// The sweeper pages staff on a large batch; that path must not try to reach
// Discord from a test.
const alertsPath = require.resolve('./utils/alerts');
let alerts = [];
require.cache[alertsPath] = {
  id: alertsPath, filename: alertsPath, loaded: true,
  exports: { raiseAlert: async (kind, message, opts) => { alerts.push({ kind, message, ...opts }); } },
};

const { sweep } = require('./watchers/orderExpiry');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}
const statusOf = id => (ORDERS.find(o => o.id === id) || {}).status;

const order = (o) => ({
  id: o.id, guild_id: process.env.GUILD_ID, status: 'waiting',
  invoice_no: 'INV-' + o.id, total_cents: 1100, payment_method: 'cashapp',
  created_at: ago(2 * HOUR), expires_at: ago(HOUR),
  amount_received_cents: null, amount_received_native: null, ...o,
});

(async () => {
  console.log('\nan order nobody paid for stops looking live');

  ORDERS = [order({ id: 1 })];
  await sweep();
  await check('a waiting order past its deadline is closed', () => {
    assert.strictEqual(statusOf(1), 'expired');
  });
  await check("...as 'expired', which /order forceconfirm still accepts", () => {
    // Not 'cancelled'. That word is already taken by a balance checkout whose
    // debit was rolled back, and those must never be confirmable — see the
    // catch in createOrder and the status list in POST /confirm.
    assert.ok(/SET status = 'expired'/.test(lastSql), lastSql);
  });

  ORDERS = [order({ id: 2, expires_at: ahead(HOUR) })];
  await sweep();
  await check('an order still inside its hour is left alone', () => {
    assert.strictEqual(statusOf(2), 'waiting');
  });

  console.log('\nnothing that has seen money is touched');

  // The whole hazard. 'underpaid' means a real payment arrived and fell short;
  // closing it writes off money that is sitting in an account.
  ORDERS = [order({ id: 3, status: 'underpaid', amount_received_cents: 500 })];
  await sweep();
  await check('an underpaid order is never closed', () => {
    assert.strictEqual(statusOf(3), 'underpaid');
  });

  // Belt and braces on the line above: the amount and the status are written by
  // different paths, so an amount recorded before the status moved must also
  // stop the sweep.
  ORDERS = [order({ id: 4, amount_received_cents: 1100 })];
  await sweep();
  await check('a waiting order with a recorded receipt is not closed', () => {
    assert.strictEqual(statusOf(4), 'waiting');
  });

  ORDERS = [order({ id: 5, amount_received_native: 0.00042 })];
  await sweep();
  await check('...and that holds for a crypto amount too, not just cents', () => {
    // A BTC payment records amount_received_native and leaves the cents column
    // null, so checking only the cents would have swept it.
    assert.strictEqual(statusOf(5), 'waiting');
  });

  ORDERS = [order({ id: 6, status: 'expired_paid', amount_received_native: 0.001 })];
  await sweep();
  await check('late crypto money flagged for review is not swept away', () => {
    assert.strictEqual(statusOf(6), 'expired_paid');
  });

  console.log('\nsettled and closed orders are not re-touched');

  ORDERS = [order({ id: 7, status: 'delivered' }), order({ id: 8, status: 'paid' }),
            order({ id: 9, status: 'cancelled' }), order({ id: 10, status: 'expired' })];
  await sweep();
  await check('delivered, paid, cancelled and expired all stay as they are', () => {
    assert.deepStrictEqual([7, 8, 9, 10].map(statusOf),
      ['delivered', 'paid', 'cancelled', 'expired']);
  });

  ORDERS = [order({ id: 11, expires_at: null })];
  await sweep();
  await check('an order with no deadline at all is not assumed to have passed one', () => {
    assert.strictEqual(statusOf(11), 'waiting');
  });

  ORDERS = [order({ id: 12, guild_id: 'someone-elses-guild' })];
  await sweep();
  await check('another guild\'s orders are out of scope', () => {
    assert.strictEqual(statusOf(12), 'waiting');
  });

  console.log('\nstaff hear about a batch, not about every abandoned cart');

  alerts = [];
  ORDERS = [order({ id: 20 }), order({ id: 21 })];
  await sweep();
  await check('two abandoned carts raise nothing', () => {
    assert.strictEqual(alerts.length, 0, JSON.stringify(alerts));
  });

  alerts = [];
  ORDERS = Array.from({ length: 12 }, (_, i) => order({ id: 100 + i }));
  await sweep();
  await check('twelve at once is a payment watcher failing, and says so', () => {
    // Twelve people do not abandon a cart in the same five minutes. The likely
    // reading is that the email watcher stopped settling and every one of these
    // was actually paid.
    assert.strictEqual(alerts.length, 1, JSON.stringify(alerts));
    assert.strictEqual(alerts[0].kind, 'orders_expired_batch');
    assert.strictEqual(alerts[0].severity, 'error');
    assert.ok(/watcher/i.test(alerts[0].message), alerts[0].message);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
})();
