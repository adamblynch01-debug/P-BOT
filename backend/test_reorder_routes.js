// The three reorder routes, over real HTTP against a stubbed db.
//
// Ordering has been half-built here for months and it kept being half-built for
// the same reason each time: the columns all exist, so it LOOKS done.
//   * products.sort_order    — column, PATCH accepts it, no UI ever set it
//   * game_tiles.sort_order  — column, PATCH accepts it, the ADMIN grid ignored
//                              it outright, so the panel and the shop window
//                              disagreed the moment anyone typed a number in
//   * product_tiers.sort_order — column, and NO route exposed it at all, so
//                              every tier created since the panel shipped landed
//                              on 0 and the price buttons rendered shuffled.
//                              Flagged 31 July, fixed here.
//
// What is actually worth pinning is not "the number was written" but the two
// invariants that make writing it safe:
//   1. products.sort_order is GLOBAL across the guild. Reordering one category
//      must not move a product in another one. Hence a permutation of the values
//      those rows already hold, never a renumber.
//   2. Omitting sort_order must leave it alone. A caller repricing a tier must
//      not silently reshuffle the buttons.
//
//   node test_reorder_routes.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// Reorder is a CATALOG edit, so staff are allowed — the same gate PATCH already
// uses. The owner-only line in this file is drawn around DELETE, not around
// moving a tile. Three roles so that stays exercised rather than assumed.
const USERS = [
  { id: 1, username: 'owner', email: 'o@x.com', role: 'admin', banned: false },
  { id: 2, username: 'mod',   email: 'm@x.com', role: 'staff', banned: false },
  { id: 3, username: 'buyer', email: 'b@x.com', role: 'user',  banned: false },
];
const TOKENS = { 'tok-owner': 1, 'tok-staff': 2, 'tok-user': 3 };

process.env.GUILD_ID = 'test-guild';
process.env.API_SECRET = 'test-secret';

// ── the two tables, as objects ───────────────────────────────────────────────
// Warzone and Rust interleave on the number line ON PURPOSE. sort_order is
// global, so a renumber of Warzone to 0..3 would drop all four of them below
// Rust — the exact bug the permutation design exists to prevent, and it is only
// visible in a fixture where the categories share a range.
let products, tiers, tiles;
function reset() {
  products = [
    { id: 10, game_name: 'Call of Duty: Warzone', sort_order: 900 },
    { id: 11, game_name: 'Call of Duty: Warzone', sort_order: 880 },
    { id: 12, game_name: 'Call of Duty: Warzone', sort_order: 860 },
    { id: 13, game_name: 'Call of Duty: Warzone', sort_order: 840 },
    { id: 20, game_name: 'Rust',                  sort_order: 890 },
    { id: 21, game_name: 'Rust',                  sort_order: 870 },
  ];
  tiers = [
    { id: 401, product_id: 10, label: 'Lifetime', price_cents: 1200, period: null, sort_order: 0 },
    { id: 402, product_id: 10, label: 'Day',      price_cents: 60,   period: null, sort_order: 0 },
    { id: 403, product_id: 10, label: 'Month',    price_cents: 600,  period: null, sort_order: 0 },
    { id: 404, product_id: 10, label: 'Week',     price_cents: 300,  period: null, sort_order: 0 },
    { id: 501, product_id: 11, label: 'Day',      price_cents: 200,  period: null, sort_order: 0 },
  ];
  tiles = [];                     // most games have never been edited: no row
}
reset();

const snapshot = () => products.map(p => ({ id: p.id, g: p.game_name, s: p.sort_order }));
const orderOf = (game) => products.filter(p => p.game_name === game)
  .sort((a, b) => b.sort_order - a.sort_order).map(p => p.id);
const tierOrderOf = (pid) => tiers.filter(t => t.product_id === pid)
  .sort((a, b) => a.sort_order - b.sort_order).map(t => t.label);

let currentToken = null;
const dbPath = require.resolve('./db');

// The SET clause is READ OUT OF THE REAL SQL rather than re-implemented here.
//
// It was re-implemented, once, as `if (params[7] != null) row.sort_order = ...`
// — which is a hand-written copy of what COALESCE($8, sort_order) means. That
// copy passes whether or not the route still says COALESCE, so the one check
// that matters ("a reprice must not reshuffle the buttons") was asserting
// against the stub's opinion, not the route's. Changing the route to
// COALESCE($8, 0) killed nothing.
//
// Parsing it instead means the fallback is whatever the statement says: the
// column itself (leave alone) or a literal (write it).
function applySet(text, params, row) {
  const clause = text.slice(text.indexOf(' SET ') + 5, text.indexOf(' WHERE '));
  const re = /(\w+)\s*=\s*(?:COALESCE\(\s*\$(\d+)\s*,\s*([\w']+)\s*\)|\$(\d+))/g;
  let m;
  while ((m = re.exec(clause))) {
    const [, col, cIdx, fallback, pIdx] = m;
    const idx = Number(cIdx || pIdx) - 1;
    const val = params[idx];
    if (val != null) {
      row[col] = typeof row[col] === 'number' ? Number(val) : val;
    } else if (cIdx && fallback !== col) {
      // COALESCE onto something that is NOT this column — a literal default.
      row[col] = /^\d+$/.test(fallback) ? Number(fallback) : fallback.replace(/'/g, '');
    }
    // else: COALESCE($n, samecol) with a null param — left alone, as intended.
  }
}

const exec = async (text, params) => {
  const t = text.replace(/\s+/g, ' ').trim();

  if (/FROM web_sessions s/.test(t)) {
    const u = USERS.find(x => x.id === TOKENS[currentToken]);
    return { rows: u ? [{ ...u }] : [] };
  }

  // products: the locked read, then the per-row write
  if (/SELECT id, sort_order FROM products/.test(t)) {
    return { rows: products.filter(p => p.game_name === params[1]).map(p => ({ id: p.id, sort_order: p.sort_order })) };
  }
  if (/UPDATE products SET sort_order/.test(t)) {
    const row = products.find(p => p.id === Number(params[1]));
    if (row) row.sort_order = Number(params[0]);
    return { rows: row ? [row] : [] };
  }

  // tiers
  if (/SELECT id FROM product_tiers/.test(t)) {
    return { rows: tiers.filter(x => x.product_id === Number(params[1])).map(x => ({ id: x.id })) };
  }
  if (/UPDATE product_tiers SET sort_order = \$1/.test(t)) {
    const row = tiers.find(x => x.id === Number(params[1]));
    if (row) row.sort_order = Number(params[0]);
    return { rows: row ? [row] : [] };
  }
  if (/SELECT COALESCE\(MAX\(sort_order\), -1\) \+ 1 AS next FROM product_tiers/.test(t)) {
    const mine = tiers.filter(x => x.product_id === Number(params[1]));
    return { rows: [{ next: mine.length ? Math.max(...mine.map(x => x.sort_order)) + 1 : 0 }] };
  }
  if (/INSERT INTO product_tiers/.test(t)) {
    const row = {
      id: 900 + tiers.length, product_id: Number(params[0]), label: params[2],
      price_cents: Number(params[3]), period: params[4], sort_order: Number(params[7]),
    };
    tiers.push(row);
    return { rows: [row] };
  }
  if (/UPDATE product_tiers SET label/.test(t)) {
    const row = tiers.find(x => x.id === Number(params[5]));
    if (!row) return { rows: [] };
    applySet(t, params, row);
    return { rows: [row] };
  }

  // game tiles
  if (/INSERT INTO game_tiles/.test(t)) {
    let row = tiles.find(x => x.game_name === params[1]);
    if (!row) {
      row = { id: tiles.length + 1, guild_id: params[0], game_name: params[1], image_version: 0, hidden: false, sort_order: null };
      tiles.push(row);
    }
    row.sort_order = Number(params[2]);
    return { rows: [row] };
  }

  return { rows: [] };
};

require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: exec,
    // The routes call client.query inside; the stub hands back an object with
    // the same one method rather than a pg client.
    withTransaction: async (fn) => fn({ query: exec }),
    pool: {},
  },
};

const app = express();
app.use(express.json());
app.use('/api/products', require('./routes/products'));
app.use('/api/game-tiles', require('./routes/gameTiles'));
const server = http.createServer(app);

function req(method, path, { token, body } = {}) {
  currentToken = token || null;
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

server.listen(0, '127.0.0.1', async () => {
  let r;

  console.log('\nwho is allowed to move things');

  reset();
  r = await req('POST', '/api/products/reorder', { body: { game_name: 'Rust', ids: [21, 20] } });
  check('anonymous cannot reorder', () => {
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(orderOf('Rust'), [20, 21], 'it moved anyway');
  });

  r = await req('POST', '/api/products/reorder', { token: 'tok-user', body: { game_name: 'Rust', ids: [21, 20] } });
  check('a customer cannot reorder', () => {
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(orderOf('Rust'), [20, 21], 'it moved anyway');
  });

  // Deliberately different from the payment kill switch, which is owner-only.
  // Arranging the shelves IS the staff job; closing the till is not.
  r = await req('POST', '/api/products/reorder', { token: 'tok-staff', body: { game_name: 'Rust', ids: [21, 20] } });
  check('staff CAN reorder — it is a catalogue edit', () => {
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(orderOf('Rust'), [21, 20]);
  });

  console.log('\nreordering one category cannot move another');

  reset();
  const before = snapshot();
  r = await req('POST', '/api/products/reorder',
    { token: 'tok-owner', body: { game_name: 'Call of Duty: Warzone', ids: [13, 12, 11, 10] } });
  check('the requested order is what renders', () => {
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(orderOf('Call of Duty: Warzone'), [13, 12, 11, 10]);
  });
  // The invariant, stated as the invariant: same numbers, redistributed.
  check('it is a PERMUTATION — the same sort_order values, reused', () => {
    const was = before.filter(p => p.g === 'Call of Duty: Warzone').map(p => p.s).sort();
    const now = snapshot().filter(p => p.g === 'Call of Duty: Warzone').map(p => p.s).sort();
    assert.deepStrictEqual(now, was, 'the values changed, so it renumbered');
  });
  check('Rust did not move, and neither did its numbers', () => {
    const was = before.filter(p => p.g === 'Rust');
    const now = snapshot().filter(p => p.g === 'Rust');
    assert.deepStrictEqual(now, was);
    assert.deepStrictEqual(orderOf('Rust'), [20, 21]);
  });
  // Rust sat at 890/870, between Warzone's rows. If the route had renumbered
  // Warzone 0..3 this is the assertion that would catch it.
  check('the two categories still interleave exactly as they did', () => {
    const all = snapshot().sort((a, b) => b.s - a.s).map(p => p.id);
    assert.deepStrictEqual(all, [13, 20, 12, 21, 11, 10]);
  });

  console.log('\na partial or foreign list is refused, not guessed at');

  reset();
  r = await req('POST', '/api/products/reorder',
    { token: 'tok-owner', body: { game_name: 'Call of Duty: Warzone', ids: [13, 12] } });
  check('leaving products out is a 400, not a half-order', () => {
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /Missing/i);
    assert.deepStrictEqual(orderOf('Call of Duty: Warzone'), [10, 11, 12, 13], 'it wrote anyway');
  });

  reset();
  r = await req('POST', '/api/products/reorder',
    { token: 'tok-owner', body: { game_name: 'Call of Duty: Warzone', ids: [10, 11, 12, 13, 20] } });
  check('an id from another category is a 400', () => {
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /Not in/i);
    assert.deepStrictEqual(snapshot(), before, 'something moved');
  });

  reset();
  r = await req('POST', '/api/products/reorder',
    { token: 'tok-owner', body: { game_name: 'Call of Duty: Warzone', ids: [10, 10, 11, 12] } });
  check('a duplicated id is a 400', () => assert.strictEqual(r.status, 400));

  r = await req('POST', '/api/products/reorder', { token: 'tok-owner', body: { ids: [10] } });
  check('no game_name is a 400', () => assert.strictEqual(r.status, 400));

  r = await req('POST', '/api/products/reorder', { token: 'tok-owner', body: { game_name: 'Rust', ids: [] } });
  check('an empty list is a 400 — it would mean nothing', () => assert.strictEqual(r.status, 400));

  console.log('\nthe price buttons: the five-week-old gap');

  reset();
  check('the fixture starts shuffled, the way a real import leaves it', () => {
    // Every one of these is sort_order 0, so the order is insertion order:
    // Lifetime first. This is what a customer sees today.
    assert.deepStrictEqual(tierOrderOf(10), ['Lifetime', 'Day', 'Month', 'Week']);
  });

  r = await req('POST', '/api/products/tiers/reorder',
    { token: 'tok-owner', body: { product_id: 10, ids: [402, 404, 403, 401] } });
  check('a tier reorder puts them in price order', () => {
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(tierOrderOf(10), ['Day', 'Week', 'Month', 'Lifetime']);
  });
  check('tiers renumber 0..N-1 — they were all colliding on 0', () => {
    assert.deepStrictEqual(tiers.filter(t => t.product_id === 10).map(t => t.sort_order).sort(), [0, 1, 2, 3]);
  });
  check('another product\'s tiers are untouched', () => {
    assert.strictEqual(tiers.find(t => t.id === 501).sort_order, 0);
  });

  r = await req('POST', '/api/products/tiers/reorder',
    { token: 'tok-owner', body: { product_id: 10, ids: [402, 404, 501] } });
  check('a tier from another product is a 400', () => {
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /Not tiers of/i);
  });

  console.log('\nsort_order on the tier routes themselves');

  reset();
  r = await req('PATCH', '/api/products/402', { token: 'tok-owner', body: { sort_order: 7 } });
  check('PATCH can set a tier\'s order', () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(tiers.find(t => t.id === 402).sort_order, 7);
  });
  // The COALESCE. A caller changing the price must not reshuffle the buttons.
  r = await req('PATCH', '/api/products/402', { token: 'tok-owner', body: { price: 9.99 } });
  check('a reprice with no sort_order LEAVES THE ORDER ALONE', () => {
    assert.strictEqual(tiers.find(t => t.id === 402).sort_order, 7, 'repricing reshuffled the buttons');
    assert.strictEqual(tiers.find(t => t.id === 402).price_cents, 999);
  });

  reset();
  r = await req('POST', '/api/products', { token: 'tok-owner', body: { product_id: 11, name: 'Week', price: 8 } });
  check('a new tier lands AFTER the existing ones, not on top of them', () => {
    assert.strictEqual(r.status, 200);
    // product 11 had one tier at 0, so the new one is 1 — not another 0.
    assert.strictEqual(r.body.product.sort_order, 1);
    assert.deepStrictEqual(tierOrderOf(11), ['Day', 'Week']);
  });
  r = await req('POST', '/api/products', { token: 'tok-owner', body: { product_id: 11, name: 'Month', price: 20, sort_order: 0 } });
  check('an explicit sort_order on create is honoured', () => {
    assert.strictEqual(r.body.product.sort_order, 0);
  });

  console.log('\nthe game grid');

  reset();
  r = await req('POST', '/api/game-tiles/reorder', { body: { order: ['Rust', 'Apex Legends'] } });
  check('anonymous cannot reorder the grid', () => {
    assert.strictEqual(r.status, 401);
    assert.strictEqual(tiles.length, 0, 'it wrote a row anyway');
  });

  r = await req('POST', '/api/game-tiles/reorder',
    { token: 'tok-staff', body: { order: ['Rust', 'Apex Legends', 'Dead by Daylight'] } });
  check('staff can, and it writes 0..N-1 in the order given', () => {
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(tiles.map(t => [t.game_name, t.sort_order]),
      [['Rust', 0], ['Apex Legends', 1], ['Dead by Daylight', 2]]);
  });
  // Most games have never been edited, so most have no row. If reorder could
  // only UPDATE, dragging would silently do nothing for all of them.
  check('it CREATED rows for games that had none', () => {
    assert.strictEqual(tiles.length, 3);
  });

  r = await req('POST', '/api/game-tiles/reorder',
    { token: 'tok-owner', body: { order: ['Apex Legends', 'Rust', 'Dead by Daylight'] } });
  check('a second pass rewrites rather than appends', () => {
    assert.strictEqual(tiles.length, 3);
    assert.deepStrictEqual(tiles.find(t => t.game_name === 'Apex Legends').sort_order, 0);
    assert.deepStrictEqual(tiles.find(t => t.game_name === 'Rust').sort_order, 1);
  });

  r = await req('POST', '/api/game-tiles/reorder', { token: 'tok-owner', body: { order: ['Rust', 'Rust'] } });
  check('a duplicated game name is a 400', () => assert.strictEqual(r.status, 400));

  r = await req('POST', '/api/game-tiles/reorder', { token: 'tok-owner', body: { order: ['Rust', '  '] } });
  check('a blank game name is a 400', () => assert.strictEqual(r.status, 400));

  r = await req('POST', '/api/game-tiles/reorder', { token: 'tok-owner', body: {} });
  check('no order at all is a 400', () => assert.strictEqual(r.status, 400));

  // /reorder must not be read as a tile literally named "reorder".
  check('the reorder path did not create a tile called "reorder"', () => {
    assert.ok(!tiles.some(t => t.game_name === 'reorder'));
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
});
