// "Is this sellable?" for a tier we do not hold a single key for.
//
// The bug this pins: mapping ONTOP V2 EXTERNAL to AimBetter made all four of its
// price buttons read SOLD OUT and disabled them. Nothing was broken — the
// product had zero rows in product_stock and always would, because every sale
// buys a key upstream at the moment of sale. The stock badge was answering a
// question nobody asked.
//
// Two halves, both against the real code:
//
//   1. THE BACKEND must say WHICH tiers are bought upstream, and must say it
//      using the same rule that decides whether a purchase actually happens.
//      A badge that says "in stock" while delivery falls back to an empty pool
//      is worse than the SOLD OUT it replaced.
//   2. THE STOREFRONT must treat "bought upstream" as unknown-but-available,
//      never as zero — and must stop doing so the moment the link is switched
//      off, without a reload.
//
// There is no third half: a supplier-backed tier still cannot be *counted*.
// Their panel exposes a purchase endpoint and nothing else, so any number here
// would be invented, and a customer could hit it.
//
//   node test_supplier_stock.js
'use strict';

const fs = require('fs');
const vm = require('vm');
const http = require('http');
const assert = require('assert');

process.env.GUILD_ID = 'test-guild';
process.env.GANDY_API_KEY = 'gandy-key';
// Deliberately UNSET. A link pointing here must fall back to the local pool,
// and the difference between the two suppliers is what proves the key check is
// still per-link rather than global.
process.env.AIMBETTER_API_KEY = '';
process.env.SUPPLIER_OFF = '';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// ── the fake world ───────────────────────────────────────────────────────────
// 401 buys from gandy (key set)         → upstream
// 402 buys from gandy but is switched off → local pool
// 403 buys from aimbetter, whose key is unset → local pool
// 404 was never mapped                  → local pool
let links, stockRows;
function reset() {
  links = [
    { id: 1, guild_id: 'test-guild', tier_id: 401, supplier: 'gandy', enabled: true },
    { id: 2, guild_id: 'test-guild', tier_id: 402, supplier: 'gandy', enabled: false },
    { id: 3, guild_id: 'test-guild', tier_id: 403, supplier: 'aimbetter', enabled: true },
    // A typo, or a row left behind by a build that knew a supplier this one
    // does not. It must fall back to the local pool, never to whichever
    // supplier happens to be the default — their product ids are unrelated, so
    // "resolve it to the default" sells a different item at a different price.
    { id: 4, guild_id: 'test-guild', tier_id: 405, supplier: 'notasupplier', enabled: true },
  ];
  // 401 is the interesting one: mapped upstream AND empty, exactly like the
  // real ONTOP V2 tiers. 404 holds keys so a non-supplier count still proves out.
  stockRows = [{ tier_id: 404, used: false }, { tier_id: 404, used: false }];
  process.env.SUPPLIER_OFF = '';
}
reset();

const exec = async (text, params) => {
  const t = String(text).replace(/\s+/g, ' ').trim();

  // Answers what was ASKED, not what the code ought to have asked — same rule
  // as the delivery harness. If the real query stops filtering on `enabled`,
  // this stub stops filtering too and the toggle check goes red, which is the
  // whole point of having it.
  if (/SELECT tier_id, supplier, enabled FROM supplier_links/.test(t)) {
    const wantsEnabled = /enabled = TRUE/i.test(t);
    const ids = params[1].map(Number);
    return { rows: links.filter(l =>
      l.guild_id === params[0] && ids.includes(l.tier_id) && (!wantsEnabled || l.enabled)) };
  }
  if (/SELECT \* FROM supplier_links/.test(t)) {
    const wantsEnabled = /enabled = TRUE/i.test(t);
    return { rows: links.filter(l =>
      l.guild_id === params[0] && l.tier_id === Number(params[1]) && (!wantsEnabled || l.enabled)) };
  }
  if (/SELECT tier_id, COUNT\(\*\)::int AS n FROM product_stock/.test(t)) {
    const ids = params[1].map(Number);
    const counts = {};
    for (const s of stockRows) if (!s.used && ids.includes(s.tier_id)) counts[s.tier_id] = (counts[s.tier_id] || 0) + 1;
    return { rows: Object.entries(counts).map(([tier_id, n]) => ({ tier_id: Number(tier_id), n })) };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM product_stock/.test(t)) {
    const n = stockRows.filter(s => !s.used && s.tier_id === Number(params[1])).length;
    return { rows: [{ n }] };
  }
  // anyLinkTierIds: all tiers with ANY link row regardless of enabled or key
  if (/SELECT DISTINCT tier_id FROM supplier_links/.test(t)) {
    const ids = params[1].map(Number);
    const seen = new Set();
    return { rows: links.filter(l =>
      l.guild_id === params[0] && ids.includes(l.tier_id) && !seen.has(l.tier_id) && seen.add(l.tier_id)
    ).map(l => ({ tier_id: l.tier_id })) };
  }
  return { rows: [] };
};

const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('./db', { query: exec, withTransaction: async fn => fn({ query: exec }) });
stub('./utils/restockNotify', { queueRestock: () => {} });
// The stock routes' write half authenticates; the read half this file exercises
// does not. Stubbed so requiring the router does not drag in a real session.
stub('./utils/auth', {
  getSessionUser: async () => null, bearerToken: () => null,
  botAuthorized: async () => false, botAuthUnavailable: () => false,
});

const supplier = require('./utils/supplier');

// ── half one: which tiers are bought upstream ────────────────────────────────
console.log('\nthe backend knows which tiers do not need a key pool');

check('linkIsLive is the SAME rule the purchase uses', () => {
  // Not a re-implementation of the three conditions — the point is that one
  // function answers for both the badge and the buy. If this ever becomes two
  // functions, the badge and the delivery can disagree, and the visible symptom
  // is a customer paying for a key that never arrives.
  //
  // Sliced to the END OF THE FUNCTION, not to the start of the next one. The
  // first version stopped at `async function liveLinkTierIds`, which swept up
  // that function's comment — and its comment says the words "linkIsLive()".
  // So a mutant that deleted the actual call passed, matched by the prose
  // describing it.
  assert.strictEqual(typeof supplier.linkIsLive, 'function', 'linkIsLive is not exported');
  const src = fs.readFileSync(require.resolve('./utils/supplier'), 'utf8');
  const start = src.indexOf('async function linkForTier');
  const body = src.slice(start, src.indexOf('\n}', start) + 2);
  assert.match(body, /linkIsLive\(/, 'linkForTier no longer asks linkIsLive — the two paths can now drift');
});

async function run() {
await checkAsync('a live mapping means the tier sells with an empty pool', async () => {
  const live = await supplier.liveLinkTierIds([401, 402, 403, 404]);
  assert.ok(live.has(401), 'the mapped, enabled, keyed tier is not reported as bought upstream');
});

await checkAsync('a switched-off mapping falls back to our own keys', async () => {
  const live = await supplier.liveLinkTierIds([401, 402, 403, 404]);
  assert.ok(!live.has(402), 'a disabled link still badged as available — switching it off is meant to hand the tier back to the local pool');
});

await checkAsync('a mapping whose supplier has no key falls back too', async () => {
  const live = await supplier.liveLinkTierIds([401, 402, 403, 404]);
  assert.ok(!live.has(403), 'a link to a supplier with no key was reported sellable; it can buy nothing');
  // And the one that IS keyed keeps working — the per-link check, not a global.
  assert.ok(live.has(401), 'one missing key switched off the supplier that works fine');
});

await checkAsync('an unmapped tier is left entirely alone', async () => {
  const live = await supplier.liveLinkTierIds([401, 402, 403, 404]);
  assert.ok(!live.has(404), 'a tier nobody mapped was claimed by the supplier path');
});

await checkAsync('a supplier this build does not know is not the default supplier', async () => {
  const live = await supplier.liveLinkTierIds([401, 405]);
  assert.ok(!live.has(405), 'an unrecognised supplier name resolved to a real one');
});

await checkAsync('the purchase path refuses exactly what the badge refuses', async () => {
  // The behavioural half of the shared-rule check above. linkForTier is what
  // delivery calls; if it and liveLinkTierIds ever answer differently, one of
  // the two is lying to a paying customer.
  assert.ok(await supplier.linkForTier(401), 'the live mapping is not buyable');
  for (const tier of [402, 403, 405]) {
    assert.strictEqual(await supplier.linkForTier(tier), null,
      `tier ${tier} would be bought upstream but is badged as falling back — or the reverse`);
  }
});

await checkAsync('the global kill switch takes every mapping down at once', async () => {
  process.env.SUPPLIER_OFF = '1';
  const live = await supplier.liveLinkTierIds([401, 402, 403, 404]);
  assert.strictEqual(live.size, 0, 'SUPPLIER_OFF is on and tiers are still badged as bought upstream');
  reset();
});

await checkAsync('no supplier_links table is a shop that sells from its own pool', async () => {
  // The migration may not have run. That must degrade to "no mappings", never
  // to a 500 — this lookup sits in front of every stock badge on the site.
  const boom = async () => { const e = new Error('relation "supplier_links" does not exist'); e.code = '42P01'; throw e; };
  stub('./db', { query: boom, withTransaction: async fn => fn({ query: boom }) });
  delete require.cache[require.resolve('./utils/supplier')];
  const fresh = require('./utils/supplier');
  const live = await fresh.liveLinkTierIds([401]);
  assert.strictEqual(live.size, 0);
  stub('./db', { query: exec, withTransaction: async fn => fn({ query: exec }) });
  delete require.cache[require.resolve('./utils/supplier')];
});

// ── half one and a half: the route the storefront actually calls ─────────────
console.log('\nGET /api/stock/bulk answers with both facts');

const express = require('express');
const app = express();
app.use('/api/stock', require('./routes/stock'));
const server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const getJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();

await checkAsync('/bulk reports counts and upstream tiers as separate facts', async () => {
  const d = await getJson('/api/stock/bulk?ids=401,402,403,404');
  assert.deepStrictEqual(d.stock, { 404: 2 }, 'the local counts are wrong');
  assert.deepStrictEqual((d.supplier || []).sort(), [401],
    'the response does not name the tiers that sell without a key pool');
});

await checkAsync('an upstream tier is NOT given an invented count', async () => {
  const d = await getJson('/api/stock/bulk?ids=401');
  // The temptation is to answer 999 and be done with it. There is no stock
  // endpoint at either supplier, so any number here is a guess a paying
  // customer can walk into.
  assert.ok(!(401 in (d.stock || {})), 'a fabricated stock count was reported for a tier nobody counted');
});

await checkAsync('/bulk with no ids still answers in the right shape', async () => {
  const d = await getJson('/api/stock/bulk?ids=');
  assert.deepStrictEqual(d, { stock: {}, supplier: [], supplierMapped: [] },
    'the empty answer lost a field, so a caller reading .supplier would throw');
});

await checkAsync('the single-tier lookup agrees with /bulk', async () => {
  const one = await getJson('/api/stock/401');
  assert.strictEqual(one.available, 0, 'the local count must stay honest — we hold no keys');
  assert.strictEqual(one.supplier, true, 'the singular endpoint disagrees with /bulk about the same tier');
});

await new Promise(r => server.close(r));

// ── half two: the storefront, running the real functions ─────────────────────
console.log('\nthe storefront stops calling an upstream product SOLD OUT');

const STOREFRONT = process.env.STOREFRONT_HTML ||
  'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG/index.html';
const html = fs.readFileSync(STOREFRONT, 'utf8');

// The whole block, lifted rather than retyped: the state declarations matter as
// much as the functions here, and a re-typed `let _gxStockLoaded = false` would
// keep this file passing after the real one changed.
const BLOCK = (() => {
  const a = html.indexOf('window._gxStock = window._gxStock ||');
  const b = html.indexOf('function stockBadgeHtml');
  assert.ok(a > -1 && b > a, 'the stock block was not found in index.html');
  const end = html.indexOf('\n}', b);
  return html.slice(a, end + 2);
})();

let lastReply = { stock: { 404: 2 }, supplier: [401], supplierMapped: [401, 402, 403] };
// A fresh page, as far as this block is concerned: new window, nothing
// hydrated. Used again at the end, because "does a first load survive an older
// backend" is a different question from "does a repaint survive one".
// The admin panel's half of the same question, lifted the same way. Three
// things in the PRODUCT KEYS tab used to answer "0 keys" three different ways —
// the filter, the stats strip and the card — so they all go through this one
// function now, and this is what stops it quietly becoming a stub.
const GROUP_FN = (() => {
  const a = html.indexOf('function invGroupSupplierTiers(');
  assert.ok(a > -1, 'invGroupSupplierTiers was not found in index.html');
  return html.slice(a, html.indexOf('\n}', a) + 2);
})();

function makeSandbox() {
  const s = { window: {}, console, apiFetch: async () => lastReply, backendCatalog: {} };
  vm.createContext(s);
  vm.runInContext(BLOCK, s);
  // The panel's inv-key → tier-id index, faked. 'ontop|day' is the mapped tier.
  s.backendTierIdForInvKey = (k) => ({ 'ontop|day': 401, 'ontop|week': 402, 'other|day': 404 }[k] ?? null);
  vm.runInContext(GROUP_FN, s);
  return s;
}
const sandbox = makeSandbox();
const { stockFor, isSupplierBacked, hydrateStockMap, stockBadgeHtml } = sandbox;

await checkAsync('before hydration nothing is gated', async () => {
  assert.strictEqual(stockFor(401), null, 'cards were gated against a map that had not loaded');
});

await hydrateStockMap([401, 402, 403, 404]);

await checkAsync('an upstream tier is not zero, it is unknown', async () => {
  // null is the storefront's word for "do not gate this" — the same answer a
  // product with no backend tier at all gets. Returning 0 here is the bug:
  // every `stockFor(id) === 0` in the page disables the buy button.
  assert.strictEqual(stockFor(401), null,
    'an upstream tier still reports a number, so its price buttons still read SOLD OUT');
  assert.strictEqual(isSupplierBacked(401), true);
});

await checkAsync('a tier with real keys still reports its real count', async () => {
  assert.strictEqual(stockFor(404), 2, 'the ordinary case broke');
});

await checkAsync('a genuinely empty tier is still SOLD OUT', async () => {
  // The check that stops this fix from becoming "nothing is ever out of stock".
  assert.strictEqual(stockFor(402), 0,
    'a tier with no keys and no live mapping is no longer gated — every empty product now sells nothing');
  assert.strictEqual(stockFor(403), 0, 'a tier whose supplier has no key must still gate');
});

await checkAsync('the badge says IN STOCK without inventing a number', async () => {
  const badge = stockBadgeHtml(401);
  assert.match(badge, /IN STOCK/, 'an upstream tier renders no badge at all');
  assert.ok(!/\d/.test(badge.replace(/[^>]*>/g, '')), 'the badge printed a count nobody can know');
  assert.match(stockBadgeHtml(402), /OUT OF STOCK/, 'the empty tier lost its badge');
});

await checkAsync('the admin PRODUCT KEYS tab knows the empty pool is deliberate', async () => {
  // Without this the card reads OUT OF STOCK in red, the stats strip counts the
  // product as out, and the "out of stock" filter serves it up — three separate
  // invitations to go and load keys that will never be handed out.
  assert.strictEqual(
    sandbox.invGroupSupplierTiers({ tiers: [{ key: 'ontop|day' }, { key: 'ontop|week' }] }), 2,
    'the panel cannot tell which of a product\'s tiers are bought upstream (any link row counts, not just live ones)');
  assert.strictEqual(sandbox.invGroupSupplierTiers({ tiers: [{ key: 'other|day' }] }), 0,
    'an ordinary product was claimed by the supplier path');
});

await checkAsync('switching a link off takes effect on the next refresh, not the next reload', async () => {
  // hydrateStockMap runs again after checkout and on panel repaints. If it
  // MERGED, a link switched off would keep badging as available until someone
  // reloaded the page — and every sale in between would try an upstream that
  // is meant to be off.
  lastReply = { stock: { 404: 2 }, supplier: [] };
  await hydrateStockMap([401, 402, 403, 404]);
  assert.strictEqual(isSupplierBacked(401), false, 'the upstream flag survived a refresh that dropped it');
  assert.strictEqual(stockFor(401), 0, 'the tier did not fall back to being gated on its own keys');
});

await checkAsync('an old backend that does not send `supplier` still works', async () => {
  // The storefront is hand-uploaded and the backend deploys separately, so the
  // two are briefly out of step every single time.
  //
  // A FRESH page on purpose. hydrateStockMap swallows its own exceptions, so on
  // an already-hydrated page a throw in there is invisible — the previous
  // load's answers are still sitting in the map and every assertion passes. On
  // a first load a throw leaves the page unhydrated, and the way that shows up
  // here is a count that comes back null instead of 2.
  lastReply = { stock: { 404: 2 } };
  const fresh = makeSandbox();
  await fresh.hydrateStockMap([401, 404]);
  assert.strictEqual(fresh.stockFor(404), 2, 'a reply with no `supplier` field stopped the page hydrating at all');
  assert.strictEqual(fresh.stockFor(401), 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
}

run().catch(e => { console.error(e); process.exitCode = 1; });

