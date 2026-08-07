// The storefront half of the game tile editor.
//
// The storefront is a single hand-uploaded index.html with no build step and no
// test runner, so the only way to find a bug in it is to open it in a browser —
// which means the owner uploads, looks, and reports. That loop is expensive
// enough that the last three rounds each spent one on it.
//
// This lifts the tile-override layer straight out of that file (no copy, no
// re-implementation — a copy would drift and then test itself) and drives it
// against a jsdom copy of the real .game-banner-grid markup.
//
// What it protects:
//   * game_name stays the lookup key. openModal('Rust') must still say 'Rust'
//     after the tile is renamed to something else, or the modal opens empty.
//   * clearing display_name reverts to the ORIGINAL static label, not to
//     whatever was painted last — the page has no other copy of it.
//   * sort_order pins ahead of the alphabetical block without interleaving.
//   * game_tiles.hidden hides the tile for everyone, which ghostGameHidden
//     (localStorage) never did.
//   * a tile with no row is untouched. This layer is additive or it is a
//     regression on 43 games at once.
//
//   npm install --no-save jsdom && node backend/test_storefront_tiles.js
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const STOREFRONT = process.env.STOREFRONT_HTML ||
  'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG/index.html';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// Pull one top-level `function name(` … matching-brace block out of the file.
// Brace counting is enough here because the extracted functions contain no
// braces inside string or regex literals — asserted below, so a future edit
// that adds one fails loudly instead of silently truncating.
function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found in ${path.basename(STOREFRONT)}`);
  // Take the `async` with it, or the extracted body is a plain function full of
  // `await` and the whole file fails to compile for a reason that points
  // nowhere near the real code.
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const html = fs.readFileSync(STOREFRONT, 'utf8');

// A miniature of the real grid: two tiles with Steam artwork, one CSS-only
// tile with no <img> at all (HWID / Accounts / Services are built that way),
// and one pinned by data-sortname (the Donation tile).
const dom = new JSDOM(`<!DOCTYPE html><body>
  <div class="game-banner-grid">
    <div class="game-banner" onclick="openModal('Rust','Survival')">
      <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/252490/header.jpg" alt="Rust">
      <div class="banner-overlay"></div>
      <div class="banner-bottom"><span class="banner-name">Rust</span><span class="banner-arrow">→</span></div>
    </div>
    <div class="game-banner" onclick="openModal('Apex Legends','Battle Royale')">
      <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/1172470/header.jpg" alt="Apex Legends">
      <div class="banner-overlay"></div>
      <div class="banner-bottom"><span class="banner-name">Apex Legends</span><span class="banner-arrow">→</span></div>
    </div>
    <div class="game-banner" onclick="openModal('HWID Spoofer','Utility')">
      <div class="banner-overlay"></div>
      <div class="banner-bottom"><span class="banner-name">HWID Spoofer</span><span class="banner-arrow">→</span></div>
    </div>
    <div class="game-banner" data-sortname="Dune Awakening~" onclick="openDonationModal()">
      <div class="banner-overlay"></div>
      <div class="banner-bottom"><span class="banner-name">Donation / Custom Order</span><span class="banner-arrow">→</span></div>
    </div>
  </div></body>`,
  // jsdom refuses localStorage on an opaque origin, and syncMainSiteGameBanners
  // reads ghostGameHidden on every call.
  { url: 'https://uhservices.xyz/' });

const ctx = vm.createContext({
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  Image: dom.window.Image,
  console,
  fetch: async () => { throw new Error('no network in this test'); },
  PAYMENT_BACKEND: 'https://backend.invalid',
  STEAM_APP_IDS: { 'Rust': 252490, 'Apex Legends': 1172470 },
  STEAM_BANNER_URLS: {},
  _gxRemovedGames: {},
  ghostAuthToken: null,
  Number, Array, Object, JSON, String, Math, Promise, Boolean, RegExp, Error, parseInt, setTimeout,
});

// Source, verbatim.
const SRC = [
  'getSteamBanner', 'gxLoadGameTiles', 'gxTile', 'gxTileLabel', 'gxTileImage',
  // The ordering rule is now ONE comparator shared by the storefront grid and
  // the admin grid — two copies of it are how the two came to disagree. Lifting
  // it here rather than letting the storefront keep a private sort is the point.
  'gxOrderRank', 'gxCmpOrdered',
  'gxApplyTileOverrides', 'syncMainSiteGameBanners',
].map(n => extractFn(html, n)).join('\n');

console.log('\n── extraction ──');
check('the tile layer still exists in index.html and lifts cleanly', () => {
  assert.ok(SRC.length > 2000, 'suspiciously small extraction');
  vm.runInContext('var _gxGameTiles = {}; var _gxTilesLoaded = false;\n' + SRC, ctx);
  assert.strictEqual(typeof ctx.gxApplyTileOverrides, 'function');
});

const setTiles = (list) => {
  const map = {};
  list.forEach(t => { map[t.game_name] = t; });
  ctx._gxGameTiles = map;
  vm.runInContext('_gxGameTiles = ' + JSON.stringify(map), ctx);
};
const $ = (sel) => dom.window.document.querySelector(sel);
const bannerFor = (key) => Array.from(dom.window.document.querySelectorAll('.game-banner'))
  .find(b => (b.getAttribute('onclick') || '').includes(`'${key}'`));
const order = () => Array.from(dom.window.document.querySelectorAll('.game-banner'))
  .map(b => b.querySelector('.banner-name').textContent);

console.log('\n── no overrides: the static page is untouched ──');
check('every tile keeps its own name, artwork and onclick', () => {
  setTiles([]);
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  assert.strictEqual(bannerFor('Rust').querySelector('.banner-name').textContent, 'Rust');
  assert.match(bannerFor('Rust').querySelector('img').getAttribute('src'), /252490/);
  assert.strictEqual(bannerFor('HWID Spoofer').querySelector('img'), null,
    'a CSS-only tile must not gain an empty <img>');
  assert.deepStrictEqual(order(),
    ['Apex Legends', 'Donation / Custom Order', 'HWID Spoofer', 'Rust'],
    'plain A-Z, with the Donation tile pinned by its data-sortname');
});

console.log('\n── display_name ──');
check('the tile paints the display name', () => {
  setTiles([{ game_name: 'Rust', display_name: 'RUST — 2026', image_version: 0 }]);
  vm.runInContext('gxApplyTileOverrides()', ctx);
  assert.strictEqual(bannerFor('Rust').querySelector('.banner-name').textContent, 'RUST — 2026');
});

check('but the ONCLICK still carries the real key', () => {
  assert.match(bannerFor('Rust').getAttribute('onclick'), /openModal\('Rust'/,
    'a renamed tile that stops answering to products.game_name opens an empty modal');
});

check('gxTileLabel is the display name; the key is unchanged', () => {
  assert.strictEqual(vm.runInContext('gxTileLabel("Rust")', ctx), 'RUST — 2026');
  assert.strictEqual(vm.runInContext('gxTileLabel("Apex Legends")', ctx), 'Apex Legends',
    'a game with no row must return its own name, not undefined');
});

check('clearing display_name reverts to the ORIGINAL static label', () => {
  setTiles([{ game_name: 'Rust', display_name: null, image_version: 0 }]);
  vm.runInContext('gxApplyTileOverrides()', ctx);
  assert.strictEqual(bannerFor('Rust').querySelector('.banner-name').textContent, 'Rust',
    'the page holds no other copy of the static label — without the stash this is unrecoverable');
});

console.log('\n── artwork precedence ──');
check('an uploaded banner beats an image URL, which beats a Steam id', () => {
  setTiles([{ game_name: 'Rust', image_version: 4, banner_url: '/api/game-tiles/Rust/banner?v=4',
              image_url: 'https://cdn.example.com/a.jpg', steam_app_id: 730 }]);
  assert.strictEqual(vm.runInContext('gxTileImage("Rust")', ctx),
    'https://backend.invalid/api/game-tiles/Rust/banner?v=4');

  setTiles([{ game_name: 'Rust', image_url: 'https://cdn.example.com/a.jpg', steam_app_id: 730 }]);
  assert.strictEqual(vm.runInContext('gxTileImage("Rust")', ctx), 'https://cdn.example.com/a.jpg');

  setTiles([{ game_name: 'Rust', steam_app_id: 730 }]);
  assert.match(vm.runInContext('gxTileImage("Rust")', ctx), /apps\/730\/header\.jpg$/);

  setTiles([{ game_name: 'Rust' }]);
  assert.strictEqual(vm.runInContext('gxTileImage("Rust")', ctx), null,
    'a tile that says nothing about artwork must leave the static <img> alone');
});

check('a tile with no artwork override does not blank the static image', () => {
  setTiles([{ game_name: 'Rust', display_name: 'Rust' }]);
  vm.runInContext('gxApplyTileOverrides()', ctx);
  assert.match(bannerFor('Rust').querySelector('img').getAttribute('src'), /252490/);
});

check('a CSS-only tile GAINS an <img> when given one, ahead of the overlay', () => {
  setTiles([{ game_name: 'HWID Spoofer', image_url: 'https://cdn.example.com/hwid.jpg' }]);
  vm.runInContext('gxApplyTileOverrides()', ctx);
  const b = bannerFor('HWID Spoofer');
  const img = b.querySelector('img');
  assert.ok(img, 'no <img> was inserted');
  assert.strictEqual(img.getAttribute('src'), 'https://cdn.example.com/hwid.jpg');
  assert.strictEqual(b.firstElementChild, img,
    'inserted after the overlay it would sit on top of the gradient and the label');
});

console.log('\n── subtitle and badge ──');
check('a subtitle appears, and is removed again when cleared', () => {
  setTiles([{ game_name: 'Apex Legends', subtitle: 'Undetected' }]);
  vm.runInContext('gxApplyTileOverrides()', ctx);
  assert.strictEqual(bannerFor('Apex Legends').querySelector('.gx-banner-sub').textContent, 'Undetected');
  setTiles([{ game_name: 'Apex Legends' }]);
  vm.runInContext('gxApplyTileOverrides()', ctx);
  assert.strictEqual(bannerFor('Apex Legends').querySelector('.gx-banner-sub'), null,
    'a cleared subtitle that stays on the page is worse than one that never appeared');
});

check('a badge appears once, not once per repaint', () => {
  setTiles([{ game_name: 'Apex Legends', badge: 'hot' }]);
  vm.runInContext('gxApplyTileOverrides(); gxApplyTileOverrides(); gxApplyTileOverrides()', ctx);
  const badges = bannerFor('Apex Legends').querySelectorAll('.gx-banner-badge');
  assert.strictEqual(badges.length, 1, `${badges.length} badges after three repaints`);
  assert.strictEqual(badges[0].className, 'gx-banner-badge gx-badge-hot');
});

console.log('\n── hidden ──');
check('game_tiles.hidden hides the tile for EVERYONE', () => {
  setTiles([{ game_name: 'Apex Legends', hidden: true }]);
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  assert.strictEqual(bannerFor('Apex Legends').style.display, 'none',
    'ghostGameHidden only ever hid it in the admin browser');
  setTiles([{ game_name: 'Apex Legends', hidden: false }]);
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  assert.strictEqual(bannerFor('Apex Legends').style.display, '',
    'un-hiding must work — hiding was a one-way door once already');
});

check('the localStorage map still hides, as the fallback', () => {
  dom.window.localStorage.setItem('ghostGameHidden', JSON.stringify({ 'Rust': true }));
  setTiles([]);
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  assert.strictEqual(bannerFor('Rust').style.display, 'none');
  dom.window.localStorage.setItem('ghostGameHidden', '{}');
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  assert.strictEqual(bannerFor('Rust').style.display, '');
});

console.log('\n── sort_order ──');
check('a sort order pins ahead of the whole alphabetical block', () => {
  setTiles([{ game_name: 'Rust', sort_order: 1 }]);
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  assert.deepStrictEqual(order(),
    ['Rust', 'Apex Legends', 'Donation / Custom Order', 'HWID Spoofer']);
});

check('two pinned tiles order among themselves, low first', () => {
  setTiles([{ game_name: 'Rust', sort_order: 20 }, { game_name: 'HWID Spoofer', sort_order: 5 }]);
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  assert.deepStrictEqual(order(),
    ['HWID Spoofer', 'Rust', 'Apex Legends', 'Donation / Custom Order']);
});

check('a pinned tile is not un-pinned by a repaint', () => {
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  assert.strictEqual(order()[0], 'HWID Spoofer');
});

check('clearing the order returns the tile to A-Z', () => {
  setTiles([]);
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  assert.deepStrictEqual(order(),
    ['Apex Legends', 'Donation / Custom Order', 'HWID Spoofer', 'Rust'],
    'a stale data-gx-order left on the element would pin it forever');
});

check('a renamed tile sorts under its NEW name', () => {
  setTiles([{ game_name: 'Rust', display_name: 'AAA Rust' }]);
  vm.runInContext('syncMainSiteGameBanners()', ctx);
  assert.strictEqual(order()[0], 'AAA Rust',
    'the overrides have to be applied before the sort reads the labels');
  setTiles([]);
  vm.runInContext('syncMainSiteGameBanners()', ctx);
});

console.log('\n── the store modal agrees with the tile ──');
check('modal-title is routed through gxTileLabel at all three render sites', () => {
  const hits = html.match(/class="modal-title">\$\{typeof gxTileLabel/g) || [];
  assert.strictEqual(hits.length, 3,
    `${hits.length} of 3 — a tile that reads one name on the grid and another in the modal is a bug report`);
});

check('openModal is still called with the raw key everywhere in the grid', () => {
  const grid = html.slice(html.indexOf('<div class="game-banner-grid">'));
  const calls = grid.match(/openModal\('([^']+)'/g) || [];
  assert.ok(calls.length > 30, `only ${calls.length} banners found`);
  assert.ok(!/openModal\(\s*gxTileLabel/.test(grid),
    'the display name must never be passed as the lookup argument');
});

console.log('\n── the editor is wired to the tile, not to the product form ──');
check('invEditGame opens the tile editor', () => {
  const fn = extractFn(html, 'invEditGame');
  assert.match(fn, /gtOpenTileEditor/);
  assert.ok(!/openAddProductModal/.test(fn),
    'this is the exact symptom that was reported: Edit opened // ADD PRODUCT / CHEAT');
});

check('the browser-side cap matches the server-side one', () => {
  const client = /GX_TILE_MAX_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(html);
  const server = fs.readFileSync(path.join(__dirname, 'routes', 'gameTiles.js'), 'utf8');
  const srv = /MAX_BANNER_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(server);
  assert.ok(client && srv, 'could not find both caps');
  assert.strictEqual(client[1], srv[1],
    'a browser cap above the server cap turns every large upload into an unexplained 400');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
