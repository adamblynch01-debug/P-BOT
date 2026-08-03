// Tests for the #restocks announcement batcher.
//
// The failure this guards against is not "the embed looks wrong" — it is the
// admin panel's SYNC ALL button firing one POST /api/stock/set per tier and
// the channel receiving one message per tier. 178 embeds for one button press
// is worse than no feature at all, so the batching, the "only announce a real
// increase" rule, and the explicit suppression flag are what is asserted here.
//
//   node test_restock_notify.js
'use strict';

const assert = require('assert');

// ─── Fakes, installed before restockNotify is required ───
const dbPath = require.resolve('./db');
const notifyPath = require.resolve('./utils/botNotify');

// One product (#100, "Arc Raiders / NEON") with three tiers; tier 11 and 12
// are the ones we restock. Tier 13 belongs to a HIDDEN product so it must
// never be announced.
const CATALOG = [
  { product_id: 100, product_name: 'NEON', game_name: 'Arc Raiders', media: { image: 'https://cdn.example/n.png' }, hidden: false, tier_id: 11, label: '1 DAY',   price_cents: 999,  sort_order: 1, available: 100 },
  { product_id: 100, product_name: 'NEON', game_name: 'Arc Raiders', media: { image: 'https://cdn.example/n.png' }, hidden: false, tier_id: 12, label: '1 WEEK',  price_cents: 2999, sort_order: 2, available: 50 },
  { product_id: 100, product_name: 'NEON', game_name: 'Arc Raiders', media: { image: 'https://cdn.example/n.png' }, hidden: false, tier_id: 14, label: '1 MONTH', price_cents: 4999, sort_order: 3, available: 0 },
  { product_id: 200, product_name: 'SECRET', game_name: 'Services', media: null, hidden: true, tier_id: 13, label: 'Lifetime', price_cents: 100, sort_order: 1, available: 7 },
];

let queries = 0;
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (_text, params) => {
      queries++;
      const ids = (params[1] || []).map(String);
      const productIds = new Set(CATALOG.filter(r => ids.includes(String(r.tier_id))).map(r => r.product_id));
      return { rows: CATALOG.filter(r => productIds.has(r.product_id)) };
    },
  },
};

let sent = [];
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { notifyBot: async (event, data) => { sent.push({ event, data }); return { ok: true }; } },
};

process.env.RESTOCK_BATCH_MS = '30';
process.env.STORE_URL = 'https://uhservices.xyz/';
const { queueRestock, __test__ } = require('./utils/restockNotify');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS ', name); passed++; }
  catch (err) { console.log('  FAIL ', name, '\n        ', err.message); failed++; }
}
function section(s) { console.log('\n' + s); }

(async () => {
  // ── one flush for a burst ────────────────────────────────
  section('a burst of per-tier writes becomes ONE notification');
  sent = []; queries = 0;
  queueRestock({ tierId: 11, added: 40 });
  queueRestock({ tierId: 12, added: 60 });
  await sleep(120);

  check('exactly one notifyBot call, not one per tier', () => assert.strictEqual(sent.length, 1));
  check('exactly one database round-trip', () => assert.strictEqual(queries, 1));
  check('the event name is "restock"', () => assert.strictEqual(sent[0].event, 'restock'));

  const p = sent[0].data.products[0];
  check('the two tiers are grouped under their one product', () => {
    assert.strictEqual(sent[0].data.products.length, 1);
    assert.strictEqual(p.product_name, 'NEON');
  });
  check('both restocked tiers are listed with their added counts', () => {
    const byLabel = Object.fromEntries(p.restocked.map(r => [r.label, r.added]));
    assert.deepStrictEqual(byLabel, { '1 DAY': 40, '1 WEEK': 60 });
  });
  check('the variant list carries EVERY tier, not just the restocked ones', () => {
    assert.deepStrictEqual(p.variants.map(v => v.label), ['1 DAY', '1 WEEK', '1 MONTH']);
  });
  check('prices are rendered from cents', () => {
    assert.deepStrictEqual(p.variants.map(v => v.price), ['$9.99', '$29.99', '$49.99']);
  });
  check('a zero price reads TBD rather than $0.00', () => {
    assert.strictEqual(__test__.money(0), 'TBD');
    assert.strictEqual(__test__.money(null), 'TBD');
  });
  check('the store url loses its trailing slash', () => assert.strictEqual(sent[0].data.store_url, 'https://uhservices.xyz'));

  // ── nothing to announce ──────────────────────────────────
  section('a save that is not an increase announces nothing');
  sent = [];
  queueRestock({ tierId: 11, added: 0 });      // an unchanged SAVE
  queueRestock({ tierId: 11, added: -25 });    // a partial wipe
  queueRestock({ tierId: 11, added: NaN });
  await sleep(120);
  check('no notification for 0, negative, or NaN deltas', () => assert.strictEqual(sent.length, 0));

  section('announce:false suppresses the bulk fill');
  sent = [];
  for (let i = 0; i < 50; i++) queueRestock({ tierId: 11, added: 100, announce: false });
  await sleep(120);
  check('a 50-tier administrative fill posts nothing', () => assert.strictEqual(sent.length, 0));
  check('and leaves no queued state behind for the next real restock', () => assert.strictEqual(__test__.pending.size, 0));

  // ── hidden products ──────────────────────────────────────
  section('a hidden product is never advertised');
  sent = [];
  queueRestock({ tierId: 13, added: 10 });
  await sleep(120);
  check('restocking a hidden product produces no notification', () => assert.strictEqual(sent.length, 0));

  // ── image handling ───────────────────────────────────────
  section('media is only used when it is actually an image');
  check('an http image url is taken', () =>
    assert.strictEqual(__test__.imageFrom({ image: 'https://x/y.png' }), 'https://x/y.png'));
  check('a screenshot counts as one', () =>
    assert.strictEqual(__test__.imageFrom({ screenshot: 'https://x/y.jpg' }), 'https://x/y.jpg'));
  check('a youtube id is NOT an image url', () =>
    assert.strictEqual(__test__.imageFrom({ youtube: 'FkTq5Qqbg9E' }), null));
  check('a bare filename is not an embeddable url', () =>
    assert.strictEqual(__test__.imageFrom({ gif: 'ARCRAIDERSG.gif' }), null));
  check('no media at all is handled', () => assert.strictEqual(__test__.imageFrom(null), null));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
