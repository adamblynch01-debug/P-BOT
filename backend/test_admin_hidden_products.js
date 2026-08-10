// Hiding a product must not be a one-way door.
//
// The bug this pins: "ACCIDENTLY REMOVED ONTOP PRIVATE EXTERNAL, WAS TRYING TO
// HIDE IT." Nothing had been removed. The row, its three tiers and its 300 keys
// were all still in the database with `hidden = true`. What had gone was the
// CARD — and with it the 👁 Show button, which is the only way back.
//
// Why: the panel's grid is built by invCatalog() from two sources, and neither
// one contains a hidden product.
//
//   • GET /api/products filters `hidden = false` — that is the storefront's
//     catalog, and hiding is exactly what takes a product out of it.
//   • window.gameProducts is the hardcoded local mirror, which only ever held
//     the products that shipped in the HTML. Anything ADDED through the panel
//     was never in it.
//
// So for a panel-created product, hide = vanish. From the operator's side that
// is indistinguishable from a delete, which is how it got reported as one.
//
// /api/products/admin/all is the one source that returns hidden rows, and the
// panel already loads it into _gxAdminProductList. invCatalog() now injects
// from it.
//
// Runs the REAL functions out of index.html — no re-typed copy, or this file
// would keep passing after the page changed.
//
//   node test_admin_hidden_products.js
'use strict';

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

const STOREFRONT = process.env.STOREFRONT_HTML ||
  'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG/index.html';
const html = fs.readFileSync(STOREFRONT, 'utf8');

// Lifted whole, closing brace included. A regex that stopped at the next
// `function` would swallow the following function's comment — and in this file
// the comments say the same words the code does, so a deleted call would still
// be matched by the prose describing it. (That is not hypothetical: it is how
// mutant S4 survived in round 42.)
function lift(sig) {
  const a = html.indexOf(sig);
  assert.ok(a > -1, sig + ' was not found in index.html');
  return html.slice(a, html.indexOf('\n}', a) + 2);
}

const sandbox = {
  window: {},
  console,
  // The hardcoded mirror. Deliberately holds ONE product and not the hidden
  // one — that asymmetry IS the bug: a panel-created product is never in here.
  gameProducts: {
    'Call of Duty: Warzone': { tag: 'FPS', cheats: [{ name: 'SHIPPED WITH THE PAGE', pricing: [] }] },
  },
  getCatalogSync: () => ({
    'Call of Duty: Warzone': {
      tag: 'FPS',
      cheats: [{ name: 'VISIBLE PRODUCT', _productId: 900, pricing: [{ label: 'Day', price: 5, tierId: 1 }] }],
    },
  }),
};
sandbox.window.gameProducts = sandbox.gameProducts;
vm.createContext(sandbox);

const INV_TILES = (() => {
  const a = html.indexOf('const INV_NON_PRODUCT_TILES =');
  assert.ok(a > -1, 'INV_NON_PRODUCT_TILES was not found');
  return html.slice(a, html.indexOf('\n', a) + 1);
})();
vm.runInContext(INV_TILES, sandbox);
vm.runInContext(lift('function invCheatsOf('), sandbox);
vm.runInContext(lift('function invCatalog('), sandbox);

// What /api/products/admin/all returns: EVERY product — hidden ones, and the
// vault half of the catalog too. Four rows, each a case that broke something:
//
//   900  visible, and in the storefront catalog — the ordinary product.
//   179  hidden, three tiers, in a category that also has visible products.
//        The real row this round restored.
//   500  hidden and the ONLY product in its category, so hiding it takes the
//        whole category tile with it and there is nothing left to drill into.
//   901  hidden, and ALSO present in the hardcoded local mirror. Real: BLITZ
//        EXTERNAL ships in the page and is hidden in the DB right now. Both
//        sources have it, so without a de-dupe it renders twice.
//   902  visible, and absent from the storefront catalog — because it is a
//        VAULT product, and /admin/all returns both halves. It must not be
//        injected: the vault has its own tab, and there are 90 of these.
function adminRows() {
  return [
    { id: 900, name: 'VISIBLE PRODUCT', game_name: 'Call of Duty: Warzone', hidden: false, tiers: [] },
    { id: 179, name: 'ONTOP Private External', game_name: 'Call of Duty: Warzone', hidden: true,
      status: 'updating', specs: 'STEAM / BATTLE.NET / XBOX', spoofer: false, sections: [{ title: 'ESP', features: ['Box'] }],
      tiers: [
        { id: 408, label: 'Day', price_cents: 799, period: '24 hours' },
        { id: 409, label: '2 Weeks', price_cents: 1799, period: '14 days' },
        { id: 410, label: 'Month', price_cents: 4999, period: '30 days' },
      ] },
    { id: 500, name: 'ONLY PRODUCT HERE', game_name: 'Rust', hidden: true, tiers: [] },
    { id: 901, name: 'SHIPPED WITH THE PAGE', game_name: 'Call of Duty: Warzone', hidden: true,
      tiers: [{ id: 77, label: 'Day', price_cents: 100, period: '24 hours' }] },
    { id: 902, name: 'VAULT ONLY', game_name: 'Rust', hidden: false, vault: true, tiers: [] },
  ];
}

const find = (cat, name) => {
  const g = sandbox.invCatalog()[cat];
  return g ? sandbox.invCheatsOf(g).find(c => c.name === name) : null;
};

console.log('\nwithout the admin index, a hidden product is invisible (the bug)');

check('the panel cannot see it from the catalog alone', () => {
  sandbox.window._gxAdminProductList = null;
  assert.strictEqual(find('Call of Duty: Warzone', 'ONTOP Private External'), undefined,
    'the fixture is wrong — the public catalog is not supposed to contain a hidden product');
  // The visible one still renders, so this is a fixture check, not a pass.
  assert.ok(find('Call of Duty: Warzone', 'VISIBLE PRODUCT'), 'the ordinary case is broken');
});

console.log('\nwith it, the card is back and can be un-hidden');

check('a hidden product renders a card', () => {
  sandbox.window._gxAdminProductList = adminRows();
  const c = find('Call of Duty: Warzone', 'ONTOP Private External');
  assert.ok(c, 'a hidden product still has no card — 👁 Show is unreachable and hiding is a one-way door');
  assert.strictEqual(c._productId, 179, 'the card carries no product id, so Show cannot address the row');
});

check('it carries its tiers, with tier ids', () => {
  sandbox.window._gxAdminProductList = adminRows();
  const c = find('Call of Duty: Warzone', 'ONTOP Private External');
  assert.strictEqual(c.pricing.length, 3, 'the tiers were dropped');
  assert.deepStrictEqual(c.pricing.map(t => t.label), ['Day', '2 Weeks', 'Month']);
  // Without tierId a save deletes and recreates the tier — and takes its keys
  // with it. The product came back with 300 keys on it; losing them to the fix
  // would be worse than the bug.
  assert.deepStrictEqual(c.pricing.map(t => t.tierId), [408, 409, 410],
    'the tier ids were lost, so opening Edit and saving would destroy the keys');
});

check('price_cents becomes a price, not a hundredfold number', () => {
  sandbox.window._gxAdminProductList = adminRows();
  const c = find('Call of Duty: Warzone', 'ONTOP Private External');
  assert.deepStrictEqual(c.pricing.map(t => t.price), [7.99, 17.99, 49.99],
    'the panel would show 799 instead of 7.99 — and a save would write it back');
});

check('a category whose every product is hidden still gets a tile', () => {
  sandbox.window._gxAdminProductList = adminRows();
  const cat = sandbox.invCatalog();
  assert.ok(cat['Rust'], 'the category vanished, so there is nothing to drill into and no way back');
  assert.ok(find('Rust', 'ONLY PRODUCT HERE'), 'the category exists but holds no card');
});

check('a product both sources know about renders exactly one card', () => {
  // BLITZ EXTERNAL is the live example: it ships in the hardcoded page AND is
  // hidden in the database, so both sources hold it. Two cards means two 👁
  // buttons that disagree about which one you just pressed.
  sandbox.window._gxAdminProductList = adminRows();
  const all = sandbox.invCheatsOf(sandbox.invCatalog()['Call of Duty: Warzone']);
  const names = all.map(c => c.name);
  assert.strictEqual(new Set(names).size, names.length, 'a product is on screen twice: ' + names.join(', '));
  assert.strictEqual(names.filter(n => n === 'SHIPPED WITH THE PAGE').length, 1,
    'the product in both the local mirror and the admin index rendered twice');
});

check('a VISIBLE product missing from the catalog is not dragged in', () => {
  // /admin/all returns the vault half too, and the vault has its own tab. The
  // filter that keeps them out is `!p.hidden` — drop it and 90 vault products
  // land in the storefront grid, every one of them badged HIDDEN.
  sandbox.window._gxAdminProductList = adminRows();
  assert.strictEqual(find('Rust', 'VAULT ONLY'), undefined,
    'a product that is visible elsewhere was injected into this grid as a hidden card');
});

check('the injected card is marked as coming from the admin index', () => {
  sandbox.window._gxAdminProductList = adminRows();
  assert.strictEqual(find('Call of Duty: Warzone', 'ONTOP Private External')._hiddenOnly, true);
  assert.ok(!find('Call of Duty: Warzone', 'VISIBLE PRODUCT')._hiddenOnly,
    'a product that is in the catalog was labelled as hidden-only');
});

console.log('\nthe grid loads the index it needs');

check('renderAdminGameTiles asks for the hidden-product index', () => {
  // The drill-down has always loaded it. The grid did not — and the grid is
  // what decides whether a category is on screen at all, so a category with
  // only hidden products had no tile to drill into.
  const body = lift('function renderAdminGameTiles(');
  assert.match(body, /loadAdminProductIndex/,
    'the game grid never loads the hidden-product index, so an all-hidden category has no tile');
});

check('invCatalog reads the list, not just the id map', () => {
  // _gxAdminProducts is "game||name" -> {id, hidden} and carries no tiers or
  // order. Building cards from it would produce a card with no prices.
  assert.match(lift('function invCatalog('), /_gxAdminProductList/,
    'invCatalog is back to a source that cannot answer what a hidden product costs');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
