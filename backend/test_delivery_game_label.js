// Round 29 item 2: the delivery line must read GAME — PRODUCT — DURATION.
//
// It used to read PRODUCT — DURATION, so a buyer holding three orders could
// not tell which game each was for, and neither could staff reading the audit
// copy in the log channel.
//
// The label is now built in FOUR places that have to agree, because the same
// delivered_goods row is rendered by four different renderers:
//
//   SUPERBOT   modules/internalEvents.js  lineLabel()     — the buyer's DM + staff summary
//   SUPERBOT   modules/manualDelivery.js  `title`         — the /manual-order-delivery DM
//   backend    utils/email.js             goodsHeading()  — the receipt email
//   backend    (the two lookupTier queries)               — where `game` comes from at all
//
// This file drives the first three off the same table of cases, so a change to
// one that is not made to the others fails here rather than in a customer's
// inbox. It also asserts both SQL lookups resolve the game the same way — the
// paid path and the manual path deliver the same catalog and must not disagree.
//
//   node backend/test_delivery_game_label.js
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const BOT = process.env.SUPERBOT_DIR || 'C:/Users/VENOM-NODE/Downloads/SUPERBOT-main';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

function extractFn(src, name, file) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found in ${file}`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// ── the three renderers, lifted from the real files ──────────────────────
const evSrc = fs.readFileSync(path.join(BOT, 'modules', 'internalEvents.js'), 'utf8');
const mdSrc = fs.readFileSync(path.join(BOT, 'modules', 'manualDelivery.js'), 'utf8');
const emSrc = fs.readFileSync(path.join(__dirname, 'utils', 'email.js'), 'utf8');

const evCtx = vm.createContext({ String, Number, RegExp });
vm.runInContext(extractFn(evSrc, 'lineLabel', 'internalEvents.js'), evCtx);
const lineLabel = evCtx.lineLabel;

const emCtx = vm.createContext({ String, Number, RegExp, escapeHtml: (s) => String(s) });
vm.runInContext(extractFn(emSrc, 'goodsHeading', 'email.js'), emCtx);
// Strip the inline <span>s so the heading can be compared as text.
const goodsHeading = (g) => emCtx.goodsHeading(g).replace(/<[^>]*>/g, '');

// manualDelivery builds its title inline rather than in a function, so the
// three lines are lifted verbatim by anchor. If they are ever refactored into
// a function this throws and the test gets fixed — which is the point.
const mdBlock = (() => {
  const a = mdSrc.indexOf('const _game = String(data.game_name');
  const b = mdSrc.indexOf('\n', mdSrc.indexOf('const title  =', a));
  assert.ok(a > -1 && b > a, 'the title builder in manualDelivery.js has moved');
  return mdSrc.slice(a, b);
})();
function manualTitle(data) {
  const c = vm.createContext({ String, RegExp, data });
  vm.runInContext(mdBlock + '\n_out = title;', c);
  return c._out;
}

// ── the cases, run through all three ─────────────────────────────────────
const CASES = [
  {
    what: 'the ordinary case',
    goods: { game: 'Call of Duty: Warzone', product: 'H8ED Private External', tier_label: '1 Month', qty: 1 },
    want: 'Call of Duty: Warzone — H8ED Private External — 1 Month',
  },
  {
    what: 'a game whose name is already inside the product name is not repeated',
    goods: { game: 'HWID Spoofer', product: 'H8ED PERMANENT SPOOFER', tier_label: 'Lifetime', qty: 1 },
    // "Spoofer" alone is not the whole game name, so the guard does NOT fire —
    // the guard matches the FULL game name as a word run, not any word of it.
    want: 'HWID Spoofer — H8ED PERMANENT SPOOFER — Lifetime',
  },
  {
    what: 'an exact repeat is dropped',
    goods: { game: 'HWID Spoofer', product: 'HWID Spoofer Pro', tier_label: '1 Day', qty: 1 },
    want: 'HWID Spoofer Pro — 1 Day',
  },
  {
    what: 'no game (balance top-up) keeps the old two-part label',
    goods: { product: 'Balance Top-Up', tier_label: null, qty: 1 },
    want: 'Balance Top-Up',
  },
  {
    what: 'an older payload with no game field at all still renders',
    goods: { product: 'H8ED MOBILE' },
    want: 'H8ED MOBILE',
  },
  {
    what: 'a blank game is treated as no game, not as an empty prefix',
    goods: { game: '   ', product: 'EXODUS SPOOFER', tier_label: '7 Days', qty: 1 },
    want: 'EXODUS SPOOFER — 7 Days',
  },
  {
    what: 'a game with regex metacharacters does not throw',
    goods: { game: 'S.T.A.L.K.E.R. 2 (Heart of Chornobyl)', product: 'Verse Cheat', tier_label: '1 Week', qty: 1 },
    want: 'S.T.A.L.K.E.R. 2 (Heart of Chornobyl) — Verse Cheat — 1 Week',
  },
];

(function () {
  console.log('\n── the buyer\'s DM (internalEvents.lineLabel) ──');
  for (const c of CASES) {
    check(c.what, () => assert.strictEqual(lineLabel(c.goods), c.want));
  }

  check('qty is appended after the duration, not before the game', () => {
    assert.strictEqual(
      lineLabel({ game: 'Fortnite', product: 'Verse', tier_label: '1 Month', qty: 3 }),
      'Fortnite — Verse — 1 Month ×3');
  });

  console.log('\n── the receipt email (email.goodsHeading) ──');
  for (const c of CASES) {
    check(c.what, () => assert.strictEqual(goodsHeading(c.goods), c.want));
  }

  console.log('\n── the hand-delivered DM (manualDelivery title) ──');
  for (const c of CASES) {
    // manualDelivery has no qty in the title (it appends ×N separately) and
    // reads game_name/product_name off the backend response shape.
    const want = c.want;
    check(c.what, () => assert.strictEqual(
      manualTitle({ game_name: c.goods.game, product_name: c.goods.product, tier_label: c.goods.tier_label }),
      want));
  }

  console.log('\n── the game actually reaches the renderers ──');

  check('the paid path selects a game and attaches it to every real line', () => {
    const src = fs.readFileSync(path.join(__dirname, 'utils', 'delivery.js'), 'utf8');
    assert.match(src, /COALESCE\(NULLIF\(gt\.display_name, ''\), p\.game_name\) AS game_name/,
      'lookupTier does not select a game — lineLabel has nothing to print');
    const pushes = (src.match(/deliveredGoods\.push\(\{ product: tier\.product_name/g) || []).length;
    const withGame = (src.match(/deliveredGoods\.push\(\{ product: tier\.product_name, game: tier\.game_name/g) || []).length;
    assert.strictEqual(withGame, pushes,
      `${pushes - withGame} of ${pushes} real-product lines are pushed without the game`);
    assert.ok(pushes >= 2, `only found ${pushes} product pushes`);
  });

  check('the manual path resolves the game IDENTICALLY to the paid path', () => {
    const a = fs.readFileSync(path.join(__dirname, 'utils', 'delivery.js'), 'utf8');
    const b = fs.readFileSync(path.join(__dirname, 'routes', 'orders.js'), 'utf8');
    const grab = (s) => {
      const m = /COALESCE\(NULLIF\(gt\.display_name, ''\), p\.game_name\) AS game_name[\s\S]*?LEFT JOIN game_tiles gt\s*\n\s*ON ([^\n]+)/.exec(s);
      assert.ok(m, 'the game_tiles join is missing or reshaped');
      return m[1].replace(/\s+/g, ' ').trim();
    };
    assert.strictEqual(grab(a), grab(b),
      'the two lookups join game_tiles differently — a buyer would see a different ' +
      'game depending on whether checkout or staff delivered the order');
  });

  check('the tile override wins over the raw grouping key, and blanks do not', () => {
    // NULLIF is what makes a tile row with display_name = '' fall through to
    // products.game_name. Without it, an admin who cleared the field would put
    // an empty prefix on every DM for that game.
    for (const f of ['utils/delivery.js', 'routes/orders.js']) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      assert.ok(src.includes("COALESCE(NULLIF(gt.display_name, ''), p.game_name)"),
        `${f} uses COALESCE without NULLIF — a cleared display_name becomes an empty game`);
    }
  });

  check('the manual route accepts and returns game_name', () => {
    const src = fs.readFileSync(path.join(__dirname, 'routes', 'orders.js'), 'utf8');
    assert.match(src, /tier_id, product_name, game_name, tier_label/,
      'game_name is not destructured off the request body');
    assert.match(src, /game_name: gName/,
      'the response omits game_name, so /manual-order-delivery cannot title its own DM');
    assert.match(src, /product: pName, game: gName, items: values/,
      'delivered_goods omits the game on the manual path');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
