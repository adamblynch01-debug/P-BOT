// The reorder controls, and the one thing they were added to fix.
//
// The reported bug was not "there is no way to reorder". Every sort_order column
// already existed. It was that the ADMIN GRID AND THE SHOP WINDOW DISAGREED:
// syncMainSiteGameBanners honoured game_tiles.sort_order, renderAdminGameTiles
// did `Object.keys(gp).sort()` — plain alphabetical — so the moment anyone set a
// number, the person setting it was the only one who could not see the result.
//
// Two copies of an ordering rule is the whole failure. So the assertion that
// matters here is not "the comparator returns -1": it is that BOTH GRIDS, driven
// for real, in one DOM, off one set of tile rows, come out in THE SAME ORDER.
// Comparing them to a third list written here would just be a third copy.
//
// Also pinned, because each was a real hazard while building this:
//   * the card must NOT be draggable — it carries an onclick that drills into
//     the game, and a draggable card ends as an accidental navigation.
//   * the persisted list comes from the CATALOG, not the DOM. The DOM is filtered
//     by the search box; an order built from a filtered view renumbers what you
//     can see and leaves everything else on its old numbers.
//   * a hidden product still holds a sort_order. /api/products/reorder refuses a
//     partial list, so omitting hidden products is a 400 and appending them is a
//     silent demotion.
//
//   npm install --no-save jsdom && node backend/test_storefront_order.js
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('\nSKIP  test_storefront_order — jsdom is not installed.');
  console.log('      npm install --no-save jsdom && node backend/test_storefront_order.js\n');
  process.exit(0);
}

const STOREFRONT = process.env.STOREFRONT_HTML ||
  'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG/index.html';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// Same lifter as test_storefront_tiles.js: take the real function out of the
// real file. A re-implementation here would pass forever regardless of what the
// page does, which is exactly the failure this file exists to catch.
function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found in ${path.basename(STOREFRONT)}`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const html = fs.readFileSync(STOREFRONT, 'utf8');

// Four games. Two of them are deliberately NOT in alphabetical agreement with
// the order we pin them into, or the test would pass on a plain .sort().
const GAMES = ['Apex Legends', 'Call of Duty: Warzone', 'Dead by Daylight', 'Rust'];

const banner = (g) => `
    <div class="game-banner" onclick="openModal('${g}','x')">
      <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/1/header.jpg" alt="${g}">
      <div class="banner-overlay"></div>
      <div class="banner-bottom"><span class="banner-name">${g}</span><span class="banner-arrow">→</span></div>
    </div>`;

// The Donation tile is in the fixture because invCatalog() injects it into the
// admin grid whether or not the backend knows about it, so leaving it out would
// mean comparing a 4-tile grid against a 5-tile one. It is excluded from the
// ORDER assertions on purpose: the storefront pins it with data-sortname, a
// static-markup hack the panel has no access to and which is not part of the
// sort_order contract this file is about. A dedicated check below covers it.
const DONATION = 'Donation / Custom Order';

const dom = new JSDOM(`<!DOCTYPE html><body>
  <div class="game-banner-grid">${GAMES.map(banner).join('')}
    <div class="game-banner" data-sortname="Dune Awakening~" onclick="openDonationModal()">
      <div class="banner-overlay"></div>
      <div class="banner-bottom"><span class="banner-name">${DONATION}</span><span class="banner-arrow">→</span></div>
    </div>
  </div>
  <div id="invToolbar"></div>
  <input id="invSearch" value="">
  <select id="invFilter"><option value="all" selected>all</option></select>
  <div id="adminGameTileGrid"></div>
  <div id="gameKeyPanel" style="display:none"></div>
  <div id="deliveryLogBox"></div>
</body>`, { url: 'https://uhservices.xyz/' });

// ─── the sandbox ─────────────────────────────────────────────────────────────
// Everything the two renderers reach for that is not the thing under test is
// stubbed to the least interesting answer that still lets them run. The stock
// hydrate and tile-fetch latches are pre-set so neither renderer tries the
// network on its one-shot retry.
const posts = [];                       // every fetch the page makes, recorded
let nextResponse = { ok: true, body: { success: true } };
const toasts = [];
let repaints = 0;

const ctx = vm.createContext({
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  console,
  PAYMENT_BACKEND: 'https://backend.invalid',
  ghostAuthToken: 'tok-admin',
  STEAM_APP_IDS: {}, STEAM_BANNER_URLS: {},
  _gxRemovedGames: {},
  _gxTilesLoaded: true,                 // skip the tile-fetch retry
  _gxStockLoaded: true,                 // skip the stock-hydrate retry
  _gtTilesHydrateTried: true,
  _gtStockHydrateTried: true,
  gxLoadGameTiles: async () => {},
  hydrateStockMap: async () => {},
  allBackendTierIds: () => [],
  invTierStockCount: () => 5,
  getDeliveryLog: () => [],
  renderDeliveryLog: () => {},
  setEl: () => {},
  getCatalogSync: null,
  escapeHtml: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  stockToast: (msg, ok) => { toasts.push({ msg, ok }); },
  gtRefreshView: () => { repaints++; },
  gtAfterTileChange: async () => { repaints++; },
  loadAdminProductIndex: async () => {},
  fetchCatalog: async () => {},
  fetch: async (url, opt) => {
    posts.push({ url, body: JSON.parse((opt && opt.body) || '{}'), headers: (opt && opt.headers) || {} });
    const r = nextResponse;
    return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => r.body };
  },
  Number, Array, Object, JSON, String, Math, Promise, Boolean, RegExp, Error,
  parseInt, parseFloat, setTimeout, isNaN,
});

const SRC = [
  'gxTile', 'gxTileLabel', 'gxOrderRank', 'gxCmpOrdered', 'gxTileOrderCmp', 'gxTileImage',
  'gxApplyTileOverrides', 'syncMainSiteGameBanners',
  'invCheatsOf', 'invCatalog',
  'gtMoveStripHtml', 'gtDragStart', 'gtDragOver', 'gtDragLeave', 'gtDragEnd', 'gtDrop',
  'gtOrderedGames', 'gtOrderedProducts', 'gtApplyMove', 'gtNudge',
  'gtPersistGameOrder', 'gtPersistProductOrder',
  'renderAdminGameTiles',
].map(n => extractFn(html, n)).join('\n');

// Lifted, not retyped: invCatalog() injects whatever is in this map, and a copy
// here would go stale the day another decorative tile is added.
const NON_PRODUCT_LINE = (html.match(/^const INV_NON_PRODUCT_TILES = .*$/m) || [])[0];
assert.ok(NON_PRODUCT_LINE, 'INV_NON_PRODUCT_TILES not found in index.html');

console.log('\n── extraction ──');
check('the reorder layer lifts out of index.html and compiles', () => {
  assert.ok(SRC.length > 4000, 'suspiciously small extraction — a lift probably truncated');
  vm.runInContext(
    'var _gxGameTiles = {}; var gameProducts = {}; var _gtDrag = null; var _gtCurrentGame = null;\n' +
    // The once-only guard on the admin product hydrate. Declared here rather
    // than in the sandbox object because it is a `var` in the page and the
    // functions assign to it — a missing declaration only surfaces on the path
    // that reads it, which is exactly how this went unnoticed.
    'var _gtAdminIdxTried = false;\n' +
    NON_PRODUCT_LINE + '\n' + SRC,
    ctx);
  assert.strictEqual(typeof ctx.renderAdminGameTiles, 'function');
  assert.strictEqual(typeof ctx.syncMainSiteGameBanners, 'function');
});

// ─── driving both grids off one set of rows ──────────────────────────────────
function setTiles(list) {
  const map = {};
  list.forEach(t => { map[t.game_name] = t; });
  vm.runInContext('_gxGameTiles = ' + JSON.stringify(map), ctx);
}
function setCatalog(games) {
  const gp = {};
  games.forEach(g => { gp[g] = { cheats: [{ name: g + ' Cheat', pricing: [{ label: 'Day' }] }] }; });
  vm.runInContext('gameProducts = ' + JSON.stringify(gp), ctx);
  vm.runInContext('window.gameProducts = gameProducts', ctx);
}

// The storefront grid, read back off the DOM after the real sort ran.
const shopOrder = () => Array.from(dom.window.document.querySelectorAll('.game-banner-grid .game-banner'))
  .map(b => b.querySelector('.banner-name').textContent.trim())
  .filter(n => n !== DONATION);

// The admin grid, likewise — the key is read out of the real ondrop handler,
// which doubles as proof the drop target is wired to the right game.
const panelKeys = () => Array.from(dom.window.document.querySelectorAll('#adminGameTileGrid [ondrop]'))
  .map(el => (el.getAttribute('ondrop').match(/gtDrop\(event,'game','(.*)'\)/) || [])[1]);
const panelOrder = () => panelKeys().filter(n => n !== DONATION);

function renderBoth() {
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  vm.runInContext('renderAdminGameTiles()', ctx);
}

setCatalog(GAMES);

console.log('\n── the bug: the panel and the shop window must agree ──');

check('with no tile rows at all, both grids are plain A-Z', () => {
  setTiles([]);
  renderBoth();
  assert.deepStrictEqual(shopOrder(), GAMES);
  assert.deepStrictEqual(panelOrder(), GAMES, 'the admin grid disagrees with the storefront');
});

check('a pinned order is honoured — IN BOTH', () => {
  // Deliberately the reverse of alphabetical, so a bare .sort() cannot pass.
  setTiles([
    { game_name: 'Rust', sort_order: 0 },
    { game_name: 'Dead by Daylight', sort_order: 1 },
    { game_name: 'Call of Duty: Warzone', sort_order: 2 },
    { game_name: 'Apex Legends', sort_order: 3 },
  ]);
  renderBoth();
  const want = ['Rust', 'Dead by Daylight', 'Call of Duty: Warzone', 'Apex Legends'];
  assert.deepStrictEqual(shopOrder(), want, 'the storefront ignored sort_order');
  assert.deepStrictEqual(panelOrder(), want, 'THE PANEL SHOWS A DIFFERENT ORDER THAN THE SHOP WINDOW');
});

check('a half-ordered grid agrees too — pinned first, the rest alphabetical', () => {
  // The realistic state: the admin dragged two tiles and never touched the
  // other 41. NULL means "sort me like you always did", and the two halves must
  // not interleave or the untouched tiles appear to have moved on their own.
  setTiles([
    { game_name: 'Rust', sort_order: 0 },
    { game_name: 'Dead by Daylight', sort_order: 1 },
  ]);
  renderBoth();
  const want = ['Rust', 'Dead by Daylight', 'Apex Legends', 'Call of Duty: Warzone'];
  assert.deepStrictEqual(shopOrder(), want);
  assert.deepStrictEqual(panelOrder(), want);
});

check('a renamed tile sorts by the name that is PAINTED, in both', () => {
  // The storefront breaks ties on the visible banner text and has no access to
  // the lookup key. If the panel tie-broke on game_name instead, a renamed tile
  // would land in a different place in each grid.
  setTiles([{ game_name: 'Rust', display_name: 'AAA Rust' }]);
  renderBoth();
  assert.deepStrictEqual(shopOrder()[0], 'AAA Rust');
  assert.deepStrictEqual(panelOrder(), ['Rust', 'Apex Legends', 'Call of Duty: Warzone', 'Dead by Daylight'],
    'the panel must place the RENAMED tile first, keyed by game_name');
});

check('sort_order 0 is an order, not "unset"', () => {
  // parseInt-and-truthy would rank 0 as unpinned and drop it into the
  // alphabetical block — and 0 is the number the very first drag writes.
  assert.strictEqual(vm.runInContext('gxOrderRank(0)', ctx), 0);
  assert.strictEqual(vm.runInContext('gxOrderRank("0")', ctx), 0);
  assert.strictEqual(vm.runInContext('gxOrderRank(null)', ctx), Number.MAX_SAFE_INTEGER);
  assert.strictEqual(vm.runInContext('gxOrderRank("")', ctx), Number.MAX_SAFE_INTEGER);
});

console.log('\n── the controls themselves ──');

setTiles([]);
renderBoth();

check('the HANDLE is draggable and the CARD is not', () => {
  const card = dom.window.document.querySelector('#adminGameTileGrid [ondrop]');
  assert.ok(card, 'no drop target rendered');
  assert.notStrictEqual(card.getAttribute('draggable'), 'true',
    'the card carries an onclick that drills into the game — dragging it would navigate');
  const handle = card.querySelector('[draggable="true"]');
  assert.ok(handle, 'no drag handle on the tile');
  assert.match(handle.getAttribute('ondragstart'), /gtDragStart\(event,'game',/);
});

check('the arrows do not drill into the game they are sitting on', () => {
  const strip = dom.window.document.querySelector('#adminGameTileGrid [ondrop] [draggable="true"]').parentNode;
  assert.match(strip.getAttribute('onclick') || '', /stopPropagation/,
    'a click on ◀ would bubble to the card onclick and open the game instead of moving it');
  assert.strictEqual(strip.querySelectorAll('button').length, 2, 'expected ◀ and ▶');
});

check('every card is a drop target, and dragover cancels the default', () => {
  const cards = Array.from(dom.window.document.querySelectorAll('#adminGameTileGrid [ondrop]'));
  assert.strictEqual(cards.length, GAMES.length);
  cards.forEach(c => assert.match(c.getAttribute('ondragover') || '', /gtDragOver/,
    'without a preventDefault on dragover the drop event never fires at all'));
});

check('the Donation tile renders, but with NO handle and NO drop target', () => {
  // It is not a game. It has no products, and the storefront pins it with
  // data-sortname, so a sort_order written for it would move it in the panel and
  // nowhere else. Dead controls that look live are worse than no controls.
  const all = Array.from(dom.window.document.querySelectorAll('#adminGameTileGrid > *'));
  const don = all.find(el => (el.innerHTML || '').includes(DONATION));
  assert.ok(don, 'the Donation tile stopped rendering in the panel entirely');
  assert.strictEqual(don.getAttribute('ondrop'), null, 'it accepts drops it cannot act on');
  assert.strictEqual(don.querySelector('[draggable="true"]'), null, 'it has a dead drag handle');
  assert.strictEqual(panelKeys().indexOf(DONATION), -1);
});

console.log('\n── what actually gets POSTed ──');

const lastPost = () => posts[posts.length - 1];
const settle = () => new Promise(r => setTimeout(r, 0));

async function run() {
  setTiles([]);
  setCatalog(GAMES);

  posts.length = 0;
  vm.runInContext("gtNudge('game','Rust',-1)", ctx);
  await settle();
  check('◀ moves one place earlier and POSTs the WHOLE grid', () => {
    assert.strictEqual(posts.length, 1, 'expected exactly one request');
    assert.match(lastPost().url, /\/api\/game-tiles\/reorder$/);
    assert.deepStrictEqual(lastPost().body.order,
      ['Apex Legends', 'Call of Duty: Warzone', 'Rust', 'Dead by Daylight'],
      'a partial list would leave every unsent tile on its old number');
    assert.strictEqual(lastPost().body.order.indexOf(DONATION), -1,
      'the Donation tile is not a game and the storefront will not honour a number for it');
    assert.strictEqual(lastPost().headers.Authorization, 'Bearer tok-admin');
  });

  posts.length = 0;
  vm.runInContext("gtNudge('game','Apex Legends',-1)", ctx);
  await settle();
  check('◀ on the first tile is a no-op, not a wrap-around', () =>
    assert.strictEqual(posts.length, 0, 'it POSTed something'));

  posts.length = 0;
  vm.runInContext("gtNudge('game','Rust',1)", ctx);
  await settle();
  check('▶ on the last tile is a no-op', () =>
    assert.strictEqual(posts.length, 0, 'it POSTed something'));

  // Drag is the other half: it drops BETWEEN any two, not one place at a time.
  posts.length = 0;
  vm.runInContext("gtApplyMove('game','Rust','Apex Legends',null)", ctx);
  await settle();
  check('dragging the last tile onto the first puts it first', () => {
    assert.deepStrictEqual(lastPost().body.order,
      ['Rust', 'Apex Legends', 'Call of Duty: Warzone', 'Dead by Daylight']);
  });

  // The reason the list is built from the catalog and not the DOM.
  posts.length = 0;
  dom.window.document.getElementById('invSearch').value = 'rust';
  vm.runInContext('renderAdminGameTiles()', ctx);
  check('the search box really does filter the grid down', () =>
    assert.deepStrictEqual(panelOrder(), ['Rust']));
  vm.runInContext("gtNudge('game','Rust',-1)", ctx);
  await settle();
  check('reordering UNDER A FILTER still sends every game, not just the visible one', () => {
    assert.strictEqual(lastPost().body.order.length, GAMES.length,
      'the order was built from the DOM — the filtered-out tiles keep their old numbers and the grid scrambles');
    assert.deepStrictEqual(lastPost().body.order,
      ['Apex Legends', 'Call of Duty: Warzone', 'Rust', 'Dead by Daylight']);
  });
  dom.window.document.getElementById('invSearch').value = '';
  vm.runInContext('renderAdminGameTiles()', ctx);

  // A rejected reorder must put the grid back rather than leave the browser
  // showing an order the server never accepted.
  posts.length = 0; toasts.length = 0; repaints = 0;
  nextResponse = { ok: false, body: { error: 'Missing from the new order: 12' } };
  vm.runInContext("gtNudge('game','Rust',-1)", ctx);
  await settle(); await settle();
  check('a rejected grid reorder repaints and says why', () => {
    assert.strictEqual(repaints > 0, true, 'the panel kept showing an order the server refused');
    assert.match(toasts[toasts.length - 1].msg, /Missing from the new order/);
    assert.strictEqual(toasts[toasts.length - 1].ok, false);
  });
  nextResponse = { ok: true, body: { success: true } };

  console.log('\n── products: hidden rows are part of the order ──');

  // /api/products/admin/all order, hidden ones included — this is the array
  // loadAdminProductIndex keeps.
  vm.runInContext(`window._gxAdminProductList = [
    { id: 10, game_name: 'Call of Duty: Warzone', name: 'Ancient',  hidden: false },
    { id: 11, game_name: 'Call of Duty: Warzone', name: 'Orion',    hidden: true  },
    { id: 12, game_name: 'Call of Duty: Warzone', name: 'Punisher', hidden: false },
    { id: 20, game_name: 'Rust',                  name: 'Fluent',   hidden: false }
  ]; window._gtCurrentGame = 'Call of Duty: Warzone';`, ctx);

  posts.length = 0;
  vm.runInContext("gtNudge('product','Punisher',-1)", ctx);
  await settle();
  check('a product move sends ids, in full, INCLUDING the hidden product', () => {
    assert.match(lastPost().url, /\/api\/products\/reorder$/);
    assert.strictEqual(lastPost().body.game_name, 'Call of Duty: Warzone');
    assert.deepStrictEqual(lastPost().body.ids, [10, 12, 11],
      'omitting the hidden product is a 400; appending it silently demotes it');
  });

  check('a product from another game is not dragged in', () => {
    assert.strictEqual(lastPost().body.ids.indexOf(20), -1,
      'products.sort_order is guild-global — a foreign id is a 400');
  });

  posts.length = 0; toasts.length = 0;
  vm.runInContext("window._gxAdminProductList = [{ id: 10, game_name: 'Call of Duty: Warzone', name: 'Ancient', hidden: false }]", ctx);
  vm.runInContext("gtPersistProductOrder('Call of Duty: Warzone', ['Ancient', 'Renamed Since'])", ctx);
  await settle();
  check('a name with no id sends NOTHING and says the list is stale', () => {
    assert.strictEqual(posts.length, 0, 'it sent a list with a null in it');
    assert.match(toasts[toasts.length - 1].msg, /out of date/i);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

run().catch(e => { console.error(e); process.exitCode = 1; });
