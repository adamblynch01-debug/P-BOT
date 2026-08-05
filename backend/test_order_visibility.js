// Who can SEE an order — the customer, and the staff member they are asking.
//
// The finding these pin: those two lists disagreed. A customer's own
// /api/orders/mine matches an order two ways — by web_user_id, and by the
// verified discord_id on their account — because an order delivered by
// `/order manual` to a Discord user who had no site account at the time keeps
// a discord_id and a NULL web_user_id forever. The admin's per-user view
// matched only the first way.
//
// So a customer could open a ticket saying "my manual order is not in my
// purchase history", staff could pull up that same customer, and BOTH of them
// could be looking at incomplete lists — in opposite directions — with nothing
// on either screen admitting anything was missing.
//
// The second half is the linking itself. A manual order only attached to an
// account when the buyer's Discord link was VERIFIED. A customer who has an
// account but never finished the Discord verification got web_user_id NULL and
// an empty Purchase History, while staff saw a delivered order.
//
//   node test_order_visibility.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

// ─── The store, as a handful of rows ─────────────────────────────────────────
//
// Three accounts, deliberately covering the three ways a buyer can exist:
//   7  linked and verified          — the normal case
//   9  linked but NOT verified      — the case that was being orphaned
//   11 no Discord at all, email only
const USERS = [
  { id: 7,  email: 'ghost@example.com',  discord_id: '111', discord_verified: true,  role: 'admin', banned: false },
  { id: 9,  email: 'vexy@example.com',   discord_id: '222', discord_verified: false, role: 'user',  banned: false },
  { id: 11, email: 'quiet@example.com',  discord_id: null,  discord_verified: false, role: 'user',  banned: false },
];

// Order 28 is the shape the owner reported: a manual delivery that DID land on
// an account. Order 22 is the shape that quietly did not.
const ORDERS = [
  { id: 28, invoice_no: '23G8-7UKQ', web_user_id: 7,    discord_id: '111', status: 'delivered',
    payment_method: 'manual', items_snapshot: [], delivered_goods: [], subtotal_cents: 4999,
    total_cents: 4999, email: 'ghost@example.com', created_at: '2026-08-04T22:08:56Z' },
  { id: 22, invoice_no: 'SSEQ-BQPV', web_user_id: null, discord_id: '111', status: 'delivered',
    payment_method: 'manual', items_snapshot: [], delivered_goods: [], subtotal_cents: 1000,
    total_cents: 1000, email: null, created_at: '2026-08-03T10:00:00Z' },
];

let sessionUserId = null;
let insertedManual = null;

const GUILD = 'test-guild';
process.env.GUILD_ID = GUILD;
// /manual is a bot route behind the shared secret, and botAuthorized() returns
// false outright when API_SECRET is unset — so without this every manual case
// below would 401 and "no order was inserted" would look like a linking bug.
process.env.API_SECRET = 'test-secret';

const dbPath = require.resolve('./db');
const exec = async (text, params) => {
  const t = text.replace(/\s+/g, ' ').trim();

  // requireAuth / requireAdmin
  if (/FROM web_sessions s/.test(t)) {
    const u = USERS.find(x => x.id === sessionUserId);
    return { rows: u ? [{ ...u }] : [] };
  }
  // The account behind a user id, for the admin view's discord leg.
  if (/SELECT discord_id, discord_verified FROM web_users/.test(t)) {
    const u = USERS.find(x => String(x.id) === String(params[1]));
    return { rows: u ? [{ discord_id: u.discord_id, discord_verified: u.discord_verified }] : [] };
  }
  // The two order lookups share a WHERE shape, so answer it once.
  if (/FROM orders WHERE guild_id/.test(t) || /FROM orders WHERE guild_id = \$1 AND \(web_user_id/.test(t)) {
    const [, webUserId, linked] = params;
    const rows = ORDERS.filter(o =>
      String(o.web_user_id) === String(webUserId) || (linked != null && o.discord_id === linked));
    return { rows };
  }
  // Manual-order account resolution: by verified Discord, then by email.
  if (/SELECT id, email FROM web_users .* discord_id = \$2 AND discord_verified = true/.test(t)) {
    const u = USERS.find(x => x.discord_id === String(params[1]) && x.discord_verified);
    return { rows: u ? [{ id: u.id, email: u.email }] : [] };
  }
  if (/SELECT id, email FROM web_users .* lower\(email\) = lower\(\$2\)/.test(t)) {
    const u = USERS.find(x => (x.email || '').toLowerCase() === String(params[1]).toLowerCase());
    return { rows: u ? [{ id: u.id, email: u.email }] : [] };
  }
  if (/^INSERT INTO orders/i.test(t)) {
    // Column order is fixed by the statement; web_user_id is what this test is
    // about, so read it off by name rather than by a magic index.
    const cols = (t.match(/INSERT INTO orders \(([^)]*)\)/i) || [, ''])[1]
      .split(',').map(s => s.trim());
    const row = {};
    cols.forEach((c, i) => { row[c] = params[i]; });
    insertedManual = row;
    return { rows: [{ ...row, id: 99, invoice_no: row.invoice_no || 'TEST-0001' }] };
  }
  return { rows: [] };
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: exec, withTransaction: async (fn) => fn(exec), pool: {} },
};

const app = express();
app.use(express.json());
app.use('/api/orders', require('./routes/orders'));
const server = http.createServer(app);

function get(path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path, method: 'GET',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
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
    req.end();
  });
}

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

const invoices = r => (r.body.orders || []).map(o => o.invoice_no).sort();

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  console.log('\nthe customer and the staff member see the SAME list');

  sessionUserId = 7;
  const mine = await get('/api/orders/mine', 'tok');
  await check('a customer sees the manual order that landed on their account', () => {
    assert.strictEqual(mine.status, 200);
    assert.ok(invoices(mine).includes('23G8-7UKQ'), invoices(mine).join(','));
  });
  await check('...and the one that only carries their verified Discord id', () => {
    // web_user_id is NULL on this row. The account is reachable only through
    // the snowflake, which is the whole reason the second leg exists.
    assert.ok(invoices(mine).includes('SSEQ-BQPV'), invoices(mine).join(','));
  });

  const asAdmin = await get('/api/orders/admin/user/7', 'tok');
  await check('staff pulling up that customer see exactly the same orders', () => {
    assert.strictEqual(asAdmin.status, 200);
    assert.deepStrictEqual(invoices(asAdmin), invoices(mine));
  });

  console.log('\nan unverified Discord link is not a way into someone else\'s orders');

  sessionUserId = 9;   // discord_id 222, unverified
  const other = await get('/api/orders/mine', 'tok');
  await check('an unverified link matches nothing', () => {
    assert.deepStrictEqual(invoices(other), []);
  });
  // Same on the staff side: user 9's Discord is unverified, so the admin view
  // must not widen to it either, or staff would be shown orders belonging to
  // whoever really owns that snowflake.
  sessionUserId = 7;
  const admin9 = await get('/api/orders/admin/user/9', 'tok');
  await check('and staff are not shown them on that account either', () => {
    assert.deepStrictEqual(invoices(admin9), []);
  });

  console.log('\na manual delivery finds the account it belongs to');

  // notify:false keeps the bot notification off the wire — this is about the
  // row, not the DM. The secret is what /manual is gated on.
  const manual = (body) => new Promise((resolve, reject) => {
    const data = JSON.stringify({ secret: 'test-secret', notify: false, ...body });
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/api/orders/manual', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
                 Authorization: 'Bearer tok' },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { let p = {}; try { p = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: p }); });
    });
    req.on('error', reject);
    req.end(data);
  });

  insertedManual = null;
  await manual({ discord_id: '111', product_name: 'H8ED Private External', keys: ['KEY-1'] });
  await check('a verified Discord link attaches the order to that account', () => {
    assert.ok(insertedManual, 'no order was inserted');
    assert.strictEqual(String(insertedManual.web_user_id), '7');
  });

  insertedManual = null;
  await manual({ discord_id: '222', email: 'vexy@example.com',
                 product_name: 'H8ED Private External', keys: ['KEY-2'] });
  await check('an UNVERIFIED link falls back to the address staff typed', () => {
    // This is the orphan case. Before, the Discord lookup failed, nothing else
    // was tried, and the row went in with web_user_id NULL — delivered, and
    // invisible on the site to the person who paid for it.
    assert.ok(insertedManual, 'no order was inserted');
    assert.strictEqual(String(insertedManual.web_user_id), '9');
  });

  insertedManual = null;
  await manual({ email: 'quiet@example.com', product_name: 'H8ED Private External', keys: ['KEY-3'] });
  await check('an account with no Discord at all is still found by email', () => {
    assert.ok(insertedManual, 'no order was inserted');
    assert.strictEqual(String(insertedManual.web_user_id), '11');
  });

  insertedManual = null;
  await manual({ email: 'nobody@example.com', product_name: 'H8ED Private External', keys: ['KEY-4'] });
  await check('an address nobody holds links to nobody, rather than guessing', () => {
    assert.ok(insertedManual, 'no order was inserted');
    assert.strictEqual(insertedManual.web_user_id, null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
})();
