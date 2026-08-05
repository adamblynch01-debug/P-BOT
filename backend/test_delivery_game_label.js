// Round 29 item 2: the delivery line has to name the GAME, not just the product.
//
// It used to read PRODUCT — DURATION, so a buyer holding three orders could
// not tell which game each was for, and neither could staff reading the audit
// copy in the log channel.
//
// The same delivered_goods row is still rendered by four renderers, but they no
// longer share a FORMAT — and pinning the format was the mistake this file made
// the first time round. The buyer's DM was rebuilt as labelled Discord fields
// (deliveryEmbed.js), the staff one-liner follows it with bullets, and the
// receipt email is HTML with coloured spans. Three media, three layouts, and
// forcing one string on all of them is not an invariant, it is a coincidence
// somebody has to keep re-establishing.
//
// What they DO have to agree on is which game is shown at all — the rule that
// suppresses a game already spelled out in the product name, and drops it
// entirely for a balance top-up. That rule now lives in exactly one function:
//
//   SUPERBOT   modules/deliveryEmbed.js   gameWorthShowing()  — the rule itself
//   SUPERBOT   modules/internalEvents.js  lineLabel()         — staff one-liner, calls it
//   SUPERBOT   modules/manualDelivery.js                      — no builder of its own now
//   backend    utils/email.js             goodsHeading()      — the receipt, its own copy
//   backend    (the two lookupTier queries)                   — where `game` comes from
//
// So the cases below fix WHICH GAME each renderer shows, and each renderer's own
// layout is asserted separately. It also asserts both SQL lookups resolve the
// game the same way — the paid path and the manual path deliver the same catalog
// and must not disagree — and that manualDelivery still has no title builder of
// its own, because building one again is how it drifted from the website DM
// before.
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

// ── the renderers, lifted from the real files ────────────────────────────
const evSrc = fs.readFileSync(path.join(BOT, 'modules', 'internalEvents.js'), 'utf8');
const mdSrc = fs.readFileSync(path.join(BOT, 'modules', 'manualDelivery.js'), 'utf8');
const deSrc = fs.readFileSync(path.join(BOT, 'modules', 'deliveryEmbed.js'), 'utf8');
const emSrc = fs.readFileSync(path.join(__dirname, 'utils', 'email.js'), 'utf8');

// The rule itself. Everything else in this file is a check that a renderer
// either calls it or reproduces it.
const deCtx = vm.createContext({ String, Number, RegExp });
vm.runInContext(extractFn(deSrc, 'gameWorthShowing', 'deliveryEmbed.js'), deCtx);
vm.runInContext(extractFn(deSrc, 'contextLine', 'deliveryEmbed.js'), deCtx);
const gameWorthShowing = deCtx.gameWorthShowing;
const contextLine = deCtx.contextLine;

// lineLabel calls gameWorthShowing, so it is given the real one rather than a
// stand-in — a stand-in would pass this file while the shipped pair disagreed.
const evCtx = vm.createContext({ String, Number, RegExp, gameWorthShowing });
vm.runInContext(extractFn(evSrc, 'lineLabel', 'internalEvents.js'), evCtx);
const lineLabel = evCtx.lineLabel;

const emCtx = vm.createContext({ String, Number, RegExp, escapeHtml: (s) => String(s) });
vm.runInContext(extractFn(emSrc, 'goodsHeading', 'email.js'), emCtx);
// Strip the inline <span>s so the heading can be compared as text.
const goodsHeading = (g) => emCtx.goodsHeading(g).replace(/<[^>]*>/g, '');

// ── the cases ────────────────────────────────────────────────────────────
// `game` is the one shared answer: which game name, if any, this row is
// entitled to show. Each renderer's expected string is derived from it below
// rather than written out, so a case can only ever say one thing.
const CASES = [
  {
    what: 'the ordinary case',
    goods: { game: 'Call of Duty: Warzone', product: 'H8ED Private External', tier_label: '1 Month', qty: 1 },
    game: 'Call of Duty: Warzone',
  },
  {
    what: 'a game whose name is already inside the product name is not repeated',
    goods: { game: 'HWID Spoofer', product: 'H8ED PERMANENT SPOOFER', tier_label: 'Lifetime', qty: 1 },
    // "Spoofer" alone is not the whole game name, so the guard does NOT fire —
    // the guard matches the FULL game name as a word run, not any word of it.
    game: 'HWID Spoofer',
  },
  {
    what: 'an exact repeat is dropped',
    goods: { game: 'HWID Spoofer', product: 'HWID Spoofer Pro', tier_label: '1 Day', qty: 1 },
    game: '',
  },
  {
    what: 'no game (balance top-up) shows the product alone',
    goods: { product: 'Balance Top-Up', tier_label: null, qty: 1 },
    game: '',
  },
  {
    what: 'an older payload with no game field at all still renders',
    goods: { product: 'H8ED MOBILE' },
    game: '',
  },
  {
    what: 'a blank game is treated as no game, not as an empty prefix',
    goods: { game: '   ', product: 'EXODUS SPOOFER', tier_label: '7 Days', qty: 1 },
    game: '',
  },
  {
    what: 'a game with regex metacharacters does not throw',
    goods: { game: 'S.T.A.L.K.E.R. 2 (Heart of Chornobyl)', product: 'Verse Cheat', tier_label: '1 Week', qty: 1 },
    game: 'S.T.A.L.K.E.R. 2 (Heart of Chornobyl)',
  },
];

// The staff one-liner: PRODUCT • GAME • TIER • ×N. The product leads because a
// staff member scanning a log is looking for what was sold, not for which game
// it was for.
const wantLine = (c) => [
  c.goods.product || 'Item', c.game, c.goods.tier_label || '',
  Number(c.goods.qty) > 1 ? `×${Number(c.goods.qty)}` : '',
].filter(Boolean).join(' • ');

// The receipt: GAME — PRODUCT — TIER — ×N, in coloured HTML. A different
// layout on purpose — it is a printed receipt, not a Discord field strip.
const wantEmail = (c) => (c.game ? `${c.game} — ` : '')
  + (c.goods.product || 'Item')
  + (c.goods.tier_label ? ` — ${c.goods.tier_label}` : '')
  + (Number(c.goods.qty) > 1 ? ` ×${Number(c.goods.qty)}` : '');

(function () {
  console.log('\n── which game is shown at all (deliveryEmbed.gameWorthShowing) ──');
  for (const c of CASES) {
    check(c.what, () => assert.strictEqual(gameWorthShowing(c.goods.game, c.goods.product), c.game));
  }

  console.log('\n── the staff one-liner (internalEvents.lineLabel) ──');
  for (const c of CASES) {
    check(c.what, () => assert.strictEqual(lineLabel(c.goods), wantLine(c)));
  }

  check('qty is appended last, and the product still leads', () => {
    assert.strictEqual(
      lineLabel({ game: 'Fortnite', product: 'Verse', tier_label: '1 Month', qty: 3 }),
      'Verse • Fortnite • 1 Month • ×3');
  });

  console.log('\n── the receipt email (email.goodsHeading) ──');
  for (const c of CASES) {
    check(c.what, () => assert.strictEqual(goodsHeading(c.goods), wantEmail(c)));
  }

  console.log('\n── the buyer\'s DM is built once, not per caller ──');

  check('manualDelivery has no title builder of its own', () => {
    // It had one, and it drifted from the website DM the moment either was
    // touched — both files even carried a comment promising the other they were
    // identical. The fix was to delete one, not to write a third test pinning
    // the two together.
    assert.ok(!/const _game = String\(data\.game_name/.test(mdSrc),
      'manualDelivery is building the game prefix itself again');
    assert.match(mdSrc, /buildDeliveryEmbed\(\{/,
      'manualDelivery no longer calls the shared renderer');
    assert.ok(!/new EmbedBuilder\(\)[\s\S]{0,200}Your Order is Ready/.test(mdSrc),
      'manualDelivery is assembling its own delivery embed again');
  });

  check('and internalEvents calls the same one', () => {
    assert.match(evSrc, /require\('\.\/deliveryEmbed'\)/,
      'internalEvents does not import the shared renderer');
    assert.match(evSrc, /buildDeliveryEmbed\(\{/,
      'internalEvents builds the buyer DM itself');
  });

  check('the shared renderer suppresses the game the same way everywhere', () => {
    // Both branches of buildDeliveryEmbed — the one-product field strip and the
    // several-products context line — read the SAME precomputed value, so a
    // two-item order cannot show a game the one-item version would have hidden.
    assert.match(deSrc, /const game = gameWorthShowing\(it\.game, product\);/,
      'the renderer no longer runs the suppression rule per item');
    assert.strictEqual(contextLine('', '1 Month', 1), '1 Month',
      'a suppressed game leaves a stray separator on the multi-item line');
    assert.strictEqual(contextLine('Fortnite', '1 Month', 2), '**Fortnite** • 1 Month • ×2');
  });

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
