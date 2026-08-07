// ─── Game tile overrides ─────────────────────────────────────────────────────
// The storefront's game grid is hand-written markup in a static index.html the
// owner uploads by hand. This route is how an admin changes a tile without
// touching that file: a row here overrides what the static markup says, and a
// game with no row renders exactly as it always did.
//
// See migrations/game_tiles.sql for why game_name is a key and display_name is
// not, and why the banner bytes live in a side table.
'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { getSessionUser, bearerToken, botAuthorized } = require('../utils/auth');
const { decodeImageDataUrl } = require('../utils/imageUpload');

const GUILD_ID = process.env.GUILD_ID;
const MAX_BANNER_BYTES = 2 * 1024 * 1024;   // must match GX_TILE_MAX_BYTES on the storefront
const BANNER_BODY_LIMIT = '4mb';

// Same dual gate as routes/products.js: the bot's API_SECRET, or a logged-in
// admin/staff session. Editing a tile is a catalog edit, not a destructive one.
async function isAuthorizedOrAdmin(req) {
  if (botAuthorized(req)) return true;
  const user = await getSessionUser(bearerToken(req));
  return !!(user && ['admin', 'staff'].includes(user.role));
}

// Deletion is the one thing 'staff' must not have — the same split routes/
// products.js draws, and for the same reason: the staff panel is a view of the
// admin panel with the destructive controls hidden, so the gate has to be on
// the route or hiding a button is the whole protection. NOT requireAdmin,
// which accepts 'staff' by design.
async function isOwnerAdminOrBot(req) {
  if (botAuthorized(req)) return true;
  const user = await getSessionUser(bearerToken(req));
  return !!(user && user.role === 'admin');
}

function publicTile(row) {
  return {
    game_name: row.game_name,
    display_name: row.display_name || null,
    subtitle: row.subtitle || null,
    image_url: row.image_url || null,
    steam_app_id: row.steam_app_id != null ? Number(row.steam_app_id) : null,
    // Same contract as publicUser().avatar_url: null unless there really are
    // bytes, so every caller keeps its existing artwork as the fallback and
    // nothing had to change to stay correct.
    banner_url: Number(row.image_version) > 0
      ? `/api/game-tiles/${encodeURIComponent(row.game_name)}/banner?v=${row.image_version}`
      : null,
    badge: row.badge || null,
    hidden: !!row.hidden,
    sort_order: row.sort_order != null ? Number(row.sort_order) : null,
  };
}

// ─── GET /api/game-tiles ─────────────────────────────────
// Public: the storefront applies these on every load, logged in or not. Nothing
// here is private — it is the shop window.
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM game_tiles WHERE guild_id = $1 ORDER BY game_name ASC', [GUILD_ID]);
    res.json({ tiles: rows.map(publicTile) });
  } catch (err) {
    console.error('[GameTiles] list error:', err);
    res.status(500).json({ error: 'Failed to load game tiles' });
  }
});

// ─── PATCH /api/game-tiles/:gameName ─────────────────────
// Upsert. The tile may not exist yet — for most games it will not, because a
// row is only created the first time somebody edits one. Fields absent from the
// body are left alone; fields present as '' or null are CLEARED, which is what
// "revert this one field to the static default" means.
router.patch('/:gameName', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const gameName = String(req.params.gameName || '').trim();
    if (!gameName) return res.status(400).json({ error: 'gameName is required' });

    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
    // Trimmed to null rather than kept as '': an empty string here would
    // override the static default with a blank, which reads on the storefront
    // as a tile that lost its name.
    const str = (v, max) => {
      const s = String(v == null ? '' : v).trim();
      return s ? s.slice(0, max) : null;
    };

    const cols = [];
    const vals = [];
    const put = (col, val) => { cols.push(col); vals.push(val); };

    if (has('display_name')) put('display_name', str(req.body.display_name, 80));
    if (has('subtitle'))     put('subtitle', str(req.body.subtitle, 80));
    if (has('image_url')) {
      const u = str(req.body.image_url, 500);
      // http(s) only. A data: URL would put the whole banner in a column that
      // GET / returns for every tile, and a javascript: URL would end up in an
      // <img src> on the storefront.
      if (u && !/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'Image URL must start with http:// or https://' });
      put('image_url', u);
    }
    if (has('steam_app_id')) {
      const raw = req.body.steam_app_id;
      const n = (raw === '' || raw == null) ? null : parseInt(raw, 10);
      if (n != null && (!Number.isFinite(n) || n <= 0)) return res.status(400).json({ error: 'Steam App ID must be a positive number' });
      put('steam_app_id', n);
    }
    if (has('badge')) {
      const b = str(req.body.badge, 8);
      const norm = b ? b.toLowerCase() : null;
      if (norm && !['hot', 'new'].includes(norm)) return res.status(400).json({ error: 'badge must be "hot", "new" or empty' });
      put('badge', norm);
    }
    if (has('hidden'))     put('hidden', !!req.body.hidden);
    if (has('sort_order')) {
      const raw = req.body.sort_order;
      const n = (raw === '' || raw == null) ? null : parseInt(raw, 10);
      if (n != null && !Number.isFinite(n)) return res.status(400).json({ error: 'Sort order must be a number' });
      put('sort_order', n);
    }
    if (!cols.length) return res.status(400).json({ error: 'Nothing to update' });

    // Upsert, so the first edit of a game creates its row and every later one
    // amends it — the caller never has to know which case it is in. The UPDATE
    // half reads EXCLUDED, so the column list is stated once and there are no
    // placeholder indices to keep in step.
    const insertCols = ['guild_id', 'game_name'].concat(cols);
    const insertVals = [GUILD_ID, gameName].concat(vals);
    const placeholders = insertVals.map((_, i) => `$${i + 1}`);
    const updateSet = cols.map(c => `${c} = EXCLUDED.${c}`).concat(['updated_at = now()']);

    const { rows } = await query(
      `INSERT INTO game_tiles (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})
       ON CONFLICT (guild_id, game_name) DO UPDATE SET ${updateSet.join(', ')}
       RETURNING *`,
      insertVals
    );
    res.json({ success: true, tile: publicTile(rows[0]) });
  } catch (err) {
    console.error('[GameTiles] patch error:', err);
    res.status(500).json({ error: 'Failed to save that tile' });
  }
});

// ─── POST /api/game-tiles/reorder ────────────────────────
// The whole grid, in the order the admin dragged it into.
//
// Kept above POST /:gameName/banner deliberately. Nothing shadows it today —
// there is no single-segment POST on this router — but a literal path and a
// wildcard on the same method is exactly the pair that starts matching each
// other the moment somebody adds `POST /:gameName`, and Express resolves that
// in declaration order.
//
// Unlike products, tile order is 0..N-1 outright rather than a permutation of
// existing values. Most tiles have `sort_order NULL` (= "sort me
// alphabetically"), so there is no set of numbers to permute, and the first
// drag has to materialise a full explicit order or the moved tile would jump
// ahead of the alphabetical block while every other tile stayed where it was.
//
// One request and one transaction, not N PATCHes: a half-applied order is a
// visibly scrambled shop window, and this route is what the public front page
// reads on every load.
router.post('/reorder', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const order = Array.isArray(req.body.order) ? req.body.order.map(n => String(n || '').trim()) : null;
    if (!order || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of game names' });
    if (order.some(n => !n)) return res.status(400).json({ error: 'order contains an empty game name' });
    if (new Set(order).size !== order.length) return res.status(400).json({ error: 'order contains a duplicate game name' });

    const tiles = await withTransaction(async (client) => {
      const out = [];
      for (let i = 0; i < order.length; i++) {
        // Upsert, same as PATCH: most games have never been edited and so have
        // no row at all. Only sort_order is touched — a tile's name, badge and
        // artwork are somebody else's edit and must survive a drag.
        const { rows } = await client.query(
          `INSERT INTO game_tiles (guild_id, game_name, sort_order)
           VALUES ($1, $2, $3)
           ON CONFLICT (guild_id, game_name)
           DO UPDATE SET sort_order = EXCLUDED.sort_order, updated_at = now()
           RETURNING *`,
          [GUILD_ID, order[i], i]
        );
        out.push(rows[0]);
      }
      return out;
    });

    res.json({ success: true, tiles: tiles.map(publicTile) });
  } catch (err) {
    console.error('[GameTiles] reorder error:', err);
    res.status(500).json({ error: 'Failed to save that order' });
  }
});

// ─── DELETE /api/game-tiles/:gameName ────────────────────
// Reverts a tile to whatever the static file says. Admin only, not staff: it
// throws away every override on the tile at once, including the banner.
router.delete('/:gameName', async (req, res) => {
  try {
    if (!(await isOwnerAdminOrBot(req))) return res.status(403).json({ error: 'Owner admin only' });
    const { rowCount } = await query(
      'DELETE FROM game_tiles WHERE guild_id = $1 AND game_name = $2',
      [GUILD_ID, String(req.params.gameName || '').trim()]
    );
    // Not a 404 when there was no row: "this tile now has no overrides" is the
    // outcome the caller asked for, and it is already true.
    res.json({ success: true, removed: rowCount });
  } catch (err) {
    console.error('[GameTiles] delete error:', err);
    res.status(500).json({ error: 'Failed to reset that tile' });
  }
});

// ─── POST /api/game-tiles/:gameName/banner ───────────────
// Parses its own body — the global parser is capped at 100kb and stands aside
// for this path (BIG_BODY_ROUTES in server.js). The auth check runs first so an
// anonymous caller cannot make us buffer 4MB before being told no.
router.post('/:gameName/banner', express.json({ limit: BANNER_BODY_LIMIT }), async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const gameName = String(req.params.gameName || '').trim();
    if (!gameName) return res.status(400).json({ error: 'gameName is required' });

    // Same decoder the review screenshots and avatars use: the declared type
    // must match the file's magic bytes, and SVG is refused — this URL is
    // public and its Content-Type is replayed from what was stored.
    const img = decodeImageDataUrl(req.body && req.body.image, MAX_BANNER_BYTES);
    if (img.error) return res.status(400).json({ error: img.error });
    if (!img.data) return res.status(400).json({ error: 'No image supplied' });

    const tile = await withTransaction(async (exec) => {
      const { rows } = await exec(
        `INSERT INTO game_tiles (guild_id, game_name, image_version, updated_at)
         VALUES ($1, $2, 1, now())
         ON CONFLICT (guild_id, game_name)
         DO UPDATE SET image_version = abs(game_tiles.image_version) + 1, updated_at = now()
         RETURNING *`,
        [GUILD_ID, gameName]
      );
      await exec(
        `INSERT INTO game_tile_images (game_tile_id, data, mime, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (game_tile_id) DO UPDATE SET data = EXCLUDED.data, mime = EXCLUDED.mime, updated_at = now()`,
        [rows[0].id, img.data, img.mime]
      );
      return rows[0];
    });

    res.json({ success: true, tile: publicTile(tile) });
  } catch (err) {
    console.error('[GameTiles] banner upload error:', err);
    res.status(500).json({ error: 'Failed to save that banner' });
  }
});

// DELETE the uploaded banner only, leaving the tile's other overrides alone.
// The version goes negative rather than to zero — see user_avatars.sql.
router.delete('/:gameName/banner', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const tile = await withTransaction(async (exec) => {
      const { rows } = await exec(
        `UPDATE game_tiles SET image_version = -abs(image_version), updated_at = now()
          WHERE guild_id = $1 AND game_name = $2 RETURNING *`,
        [GUILD_ID, String(req.params.gameName || '').trim()]
      );
      if (!rows.length) return null;
      await exec('DELETE FROM game_tile_images WHERE game_tile_id = $1', [rows[0].id]);
      return rows[0];
    });
    if (!tile) return res.status(404).json({ error: 'That tile has no overrides' });
    res.json({ success: true, tile: publicTile(tile) });
  } catch (err) {
    console.error('[GameTiles] banner delete error:', err);
    res.status(500).json({ error: 'Failed to remove that banner' });
  }
});

// ─── GET /api/game-tiles/:gameName/banner ────────────────
// Public, because it is the shop window. Immutable-for-a-year is only correct
// with the ?v= that publicTile() puts in the URL.
router.get('/:gameName/banner', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT i.data, i.mime
         FROM game_tile_images i
         JOIN game_tiles t ON t.id = i.game_tile_id
        WHERE t.guild_id = $1 AND t.game_name = $2`,
      [GUILD_ID, String(req.params.gameName || '').trim()]
    );
    if (!rows.length) return res.status(404).end();
    res.set('Content-Type', rows[0].mime || 'image/png');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    res.send(rows[0].data);
  } catch (err) {
    console.error('[GameTiles] banner fetch error:', err);
    res.status(500).end();
  }
});

module.exports = router;
