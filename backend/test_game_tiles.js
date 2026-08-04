// An admin editing a game tile.
//
// Until now a "game" had no row anywhere — it was products.game_name, a
// hand-written .game-banner in the storefront's index.html, and an entry in
// that file's STEAM_APP_IDS map. Which is exactly why ADMIN → INVENTORY →
// GAME TILES → ✏ Edit could only open the ADD PRODUCT form: there was nothing
// else to open. game_tiles is that row, and it holds only the overrides.
//
// What is worth protecting here.
//
//  1. game_name is a KEY, not a label. products.game_name, ghostGameHidden,
//     openModal() and the reseller pricing table all look games up by that
//     string. The route must never let it be renamed — display_name is the
//     thing that gets painted. This codebase has already lost two rounds to a
//     display string moving out from under a lookup key.
//
//  2. The upsert. A tile row is created by the FIRST edit, so every PATCH has
//     to work whether or not the row exists, and a second PATCH must amend
//     rather than blank the fields it did not mention. ON CONFLICT needs the
//     UNIQUE (guild_id, game_name) constraint to exist or every write raises.
//
//  3. The banner is a public URL whose Content-Type is replayed from what was
//     stored, same as an avatar — HTML declared as image/png would be a stored
//     XSS on the shop window. And it travels as a data URL in JSON, so the
//     route must be in BIG_BODY_ROUTES or every upload is a 413.
//
//  4. Deletion is not staff's to have, and the storefront's public GET must
//     stay public — it is the shop window, rendered before anyone logs in.
//
// Runs against the real database. It writes tiles for a throwaway game name
// that no product uses and removes them at the end.
//
//   railway run node backend/test_game_tiles.js
'use strict';

const assert = require('assert');
const http = require('http');

process.env.SKIP_BACKGROUND = process.env.SKIP_BACKGROUND || '1';

const { pool } = require('./db');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 9)]);
const url = (mime, buf) => `data:${mime};base64,` + buf.toString('base64');

const GUILD_ID = process.env.GUILD_ID;
const stamp = Date.now();
// A name with a space and an apostrophe, because it goes in a URL path and
// comes back out of one. Nothing in the catalog uses it.
const GAME = `_tiletest ${stamp}'s Game`;
const ENC = encodeURIComponent(GAME);

(async () => {
  console.log('\n── schema ──');
  await check('game_tiles has UNIQUE (guild_id, game_name) — the upsert needs it', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'game_tiles'::regclass AND contype = 'u'`);
    assert.ok(rows.some(r => /UNIQUE \(guild_id, game_name\)/.test(r.def)),
      'run migrations/game_tiles.sql — without this every PATCH raises ON CONFLICT');
  });

  await check('game_tile_images cascades from game_tiles', async () => {
    const { rows } = await pool.query(
      `SELECT rc.delete_rule FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
        WHERE tc.table_name = 'game_tile_images'`);
    assert.ok(rows.length, 'no FK on game_tile_images');
    assert.strictEqual(rows[0].delete_rule, 'CASCADE',
      'resetting a tile must not leave its banner bytes orphaned');
  });

  // ── live routes ────────────────────────────────────────
  const app = require('./server');
  const server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  let token = null;                       // admin session
  let staffToken = null;                  // same account demoted, for the delete gate
  let userId = null;
  const creds = {
    username: `_tiletest_${stamp}`,
    email: `_tiletest_${stamp}@example.invalid`,
    password: 'game-tile-test-password-123',
  };

  const api = async (path, opts = {}) => {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const t = Object.prototype.hasOwnProperty.call(opts, 'as') ? opts.as : token;
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(base + path, Object.assign({}, opts, { headers }));
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body };
  };

  try {
    await check('throwaway admin account created', async () => {
      const r = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify(creds), as: null });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      token = r.body.token;
      userId = r.body.user.id;
      await pool.query('UPDATE web_users SET role = $1 WHERE id = $2', ['admin', userId]);
    });

    console.log('\n── auth ──');
    await check('an anonymous PATCH is refused', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, {
        method: 'PATCH', as: null, body: JSON.stringify({ display_name: 'Pwned' }) });
      assert.strictEqual(r.status, 401);
    });
    await check('GET / is public — it is the shop window', async () => {
      const r = await api('/api/game-tiles', { as: null });
      assert.strictEqual(r.status, 200);
      assert.ok(Array.isArray(r.body.tiles));
    });

    console.log('\n── upsert ──');
    await check('the first PATCH CREATES the row — no tile existed to edit before', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, {
        method: 'PATCH',
        body: JSON.stringify({ display_name: 'Call of Duty: BO7', subtitle: 'Undetected', badge: 'HOT' }),
      });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.tile.game_name, GAME, 'the key must come back verbatim');
      assert.strictEqual(r.body.tile.display_name, 'Call of Duty: BO7');
      assert.strictEqual(r.body.tile.badge, 'hot', 'badge is normalised to lowercase');
      assert.strictEqual(r.body.tile.banner_url, null, 'no bytes uploaded yet');
    });

    await check('a second PATCH amends and leaves absent fields ALONE', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, {
        method: 'PATCH', body: JSON.stringify({ subtitle: 'Full Access' }) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.tile.subtitle, 'Full Access');
      assert.strictEqual(r.body.tile.display_name, 'Call of Duty: BO7',
        'an unmentioned field must survive — otherwise editing one field blanks the rest');
    });

    await check('an empty string CLEARS a field — that is "revert to the static default"', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, {
        method: 'PATCH', body: JSON.stringify({ subtitle: '   ' }) });
      assert.strictEqual(r.body.tile.subtitle, null,
        'stored as null, not "" — a blank string paints a tile that lost its name');
    });

    await check('game_name is never writable — it is the lookup key', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, {
        method: 'PATCH', body: JSON.stringify({ game_name: 'Something Else', display_name: 'X' }) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.tile.game_name, GAME,
        'a rename here would orphan products.game_name, ghostGameHidden and openModal()');
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM game_tiles WHERE guild_id = $1 AND game_name = $2',
        [GUILD_ID, 'Something Else']);
      assert.strictEqual(rows[0].n, 0, 'and it must not have created a second row either');
    });

    await check('a body with nothing recognised is a 400, not a silent no-op', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, { method: 'PATCH', body: JSON.stringify({ nonsense: 1 }) });
      assert.strictEqual(r.status, 400);
    });

    console.log('\n── validation ──');
    await check('a javascript: image URL is refused', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, {
        method: 'PATCH', body: JSON.stringify({ image_url: 'javascript:alert(1)' }) });
      assert.strictEqual(r.status, 400, 'this string ends up in an <img src> on the storefront');
    });
    await check('a data: image URL is refused', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, {
        method: 'PATCH', body: JSON.stringify({ image_url: url('image/png', PNG) }) });
      assert.strictEqual(r.status, 400, 'GET / returns this column for EVERY tile on every page load');
    });
    await check('an https image URL is accepted', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, {
        method: 'PATCH', body: JSON.stringify({ image_url: 'https://cdn.example.com/a.jpg' }) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.tile.image_url, 'https://cdn.example.com/a.jpg');
    });
    await check('a bogus badge is refused, and an empty one clears it', async () => {
      const bad = await api(`/api/game-tiles/${ENC}`, { method: 'PATCH', body: JSON.stringify({ badge: 'free' }) });
      assert.strictEqual(bad.status, 400);
      const ok = await api(`/api/game-tiles/${ENC}`, { method: 'PATCH', body: JSON.stringify({ badge: '' }) });
      assert.strictEqual(ok.body.tile.badge, null);
    });
    await check('a negative Steam App ID is refused', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, { method: 'PATCH', body: JSON.stringify({ steam_app_id: -5 }) });
      assert.strictEqual(r.status, 400);
    });
    await check('hidden round-trips as a real boolean', async () => {
      const on = await api(`/api/game-tiles/${ENC}`, { method: 'PATCH', body: JSON.stringify({ hidden: true }) });
      assert.strictEqual(on.body.tile.hidden, true);
      const off = await api(`/api/game-tiles/${ENC}`, { method: 'PATCH', body: JSON.stringify({ hidden: false }) });
      assert.strictEqual(off.body.tile.hidden, false, 'hiding must not be a one-way door — see round 27');
    });

    console.log('\n── banner ──');
    await check('an anonymous banner upload is refused', async () => {
      const r = await api(`/api/game-tiles/${ENC}/banner`, {
        method: 'POST', as: null, body: JSON.stringify({ image: url('image/png', PNG) }) });
      assert.strictEqual(r.status, 401, 'the auth check must run before 4MB is buffered');
    });

    await check('upload succeeds and the tile advertises a versioned banner_url', async () => {
      const r = await api(`/api/game-tiles/${ENC}/banner`, {
        method: 'POST', body: JSON.stringify({ image: url('image/png', PNG) }) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.tile.banner_url, `/api/game-tiles/${ENC}/banner?v=1`, r.body.tile.banner_url);
    });

    await check('a 300KB body gets through — the 100kb global parser stood aside', async () => {
      const big = Buffer.concat([JPEG, Buffer.alloc(300 * 1024, 3)]);
      const r = await api(`/api/game-tiles/${ENC}/banner`, {
        method: 'POST', body: JSON.stringify({ image: url('image/jpeg', big) }) });
      assert.strictEqual(r.status, 200,
        `413 here means BIG_BODY_ROUTES does not match this path — the game name sits mid-route (${r.status})`);
      assert.match(r.body.tile.banner_url, /\?v=2$/, 'version must move with the bytes');
    });

    await check('HTML declared as image/png is refused', async () => {
      const r = await api(`/api/game-tiles/${ENC}/banner`, {
        method: 'POST', body: JSON.stringify({ image: url('image/png', Buffer.from('<script>alert(1)</script>')) }) });
      assert.strictEqual(r.status, 400,
        'the stored mime is replayed as Content-Type on a public URL');
    });

    await check('over the 2MB cap is a 400, not a 413 or a 500', async () => {
      const huge = Buffer.concat([PNG, Buffer.alloc(2200 * 1024, 5)]);
      const r = await api(`/api/game-tiles/${ENC}/banner`, {
        method: 'POST', body: JSON.stringify({ image: url('image/png', huge) }) });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body).slice(0, 120));
    });

    await check('GET serves the bytes publicly, with nosniff', async () => {
      const r = await api(`/api/game-tiles/${ENC}/banner?v=2`, { as: null });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('content-type'), 'image/jpeg');
      assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(r.body.length > 300 * 1024, `got ${r.body.length} bytes`);
    });

    await check('only the ?v= URL is pinned for a year', async () => {
      const a = await api(`/api/game-tiles/${ENC}/banner?v=2`, { as: null });
      const b = await api(`/api/game-tiles/${ENC}/banner`, { as: null });
      assert.match(a.headers.get('cache-control'), /immutable/);
      assert.doesNotMatch(b.headers.get('cache-control'), /immutable/,
        'a versionless URL must not be pinned — its bytes can change');
    });

    await check('a game with no banner 404s rather than 500s', async () => {
      const r = await api('/api/game-tiles/_no_such_game_at_all/banner', { as: null });
      assert.strictEqual(r.status, 404);
    });

    await check('deleting the banner keeps the high-water mark and the other overrides', async () => {
      const r = await api(`/api/game-tiles/${ENC}/banner`, { method: 'DELETE' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.tile.banner_url, null);
      assert.strictEqual(r.body.tile.display_name, 'X', 'the banner delete must not touch the rest of the tile');
      const { rows } = await pool.query(
        'SELECT image_version FROM game_tiles WHERE guild_id = $1 AND game_name = $2', [GUILD_ID, GAME]);
      assert.strictEqual(rows[0].image_version, -2,
        'negative, not zero: a browser holding the immutable ?v=1 would serve the deleted banner back forever');
      const gone = await api(`/api/game-tiles/${ENC}/banner?v=2`, { as: null });
      assert.strictEqual(gone.status, 404, 'the bytes must actually be gone');
    });

    await check('re-uploading never reissues a spent ?v=', async () => {
      const r = await api(`/api/game-tiles/${ENC}/banner`, {
        method: 'POST', body: JSON.stringify({ image: url('image/png', PNG) }) });
      assert.match(r.body.tile.banner_url, /\?v=3$/, 'counting up from |−2|');
    });

    console.log('\n── the tile shows up where the storefront reads it ──');
    await check('GET / includes the tile, anonymously', async () => {
      const r = await api('/api/game-tiles', { as: null });
      const tile = r.body.tiles.find(t => t.game_name === GAME);
      assert.ok(tile, 'the storefront applies this list on every load');
      assert.strictEqual(tile.display_name, 'X');
      assert.match(tile.banner_url, /\?v=3$/);
    });

    console.log('\n── reset ──');
    await check('staff cannot reset a tile', async () => {
      await pool.query('UPDATE web_users SET role = $1 WHERE id = $2', ['staff', userId]);
      staffToken = token;
      const r = await api(`/api/game-tiles/${ENC}`, { method: 'DELETE', as: staffToken });
      await pool.query('UPDATE web_users SET role = $1 WHERE id = $2', ['admin', userId]);
      assert.strictEqual(r.status, 403,
        'the staff panel hides the button; the gate has to be here or that IS the protection');
    });

    await check('admin reset removes the row and cascades the banner away', async () => {
      const { rows: before } = await pool.query(
        'SELECT id FROM game_tiles WHERE guild_id = $1 AND game_name = $2', [GUILD_ID, GAME]);
      const tileId = before[0].id;
      const r = await api(`/api/game-tiles/${ENC}`, { method: 'DELETE' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.removed, 1);
      const { rows: img } = await pool.query(
        'SELECT 1 FROM game_tile_images WHERE game_tile_id = $1', [tileId]);
      assert.strictEqual(img.length, 0, 'ON DELETE CASCADE should have taken the bytes');
    });

    await check('resetting a tile that has no overrides is a success, not a 404', async () => {
      const r = await api(`/api/game-tiles/${ENC}`, { method: 'DELETE' });
      assert.strictEqual(r.status, 200, '"this tile now has no overrides" is already true');
      assert.strictEqual(r.body.removed, 0);
    });

    await check('nothing in products was touched by any of this', async () => {
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM products WHERE guild_id = $1 AND game_name = $2', [GUILD_ID, GAME]);
      assert.strictEqual(rows[0].n, 0);
    });
  } finally {
    await pool.query('DELETE FROM game_tiles WHERE guild_id = $1 AND game_name = $2', [GUILD_ID, GAME]).catch(() => {});
    if (userId) await pool.query('DELETE FROM web_users WHERE id = $1', [userId]).catch(() => {});
    server.close();
    await pool.end().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS FAILED:', e); process.exit(1); });
