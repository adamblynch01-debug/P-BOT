'use strict';
// ─── /api/updates ────────────────────────────────────────────────────────────
// Public GET lets the storefront fetch the latest product updates.
// POST is bot-only (API_SECRET), same dual-gate pattern as /api/status/update.
// Requires product_updates table — run backend/migrations/product_updates.sql
// before deploying.

const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { botAuthorized, bearerToken, getSessionUser } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// Valid update types — the storefront picks an emoji per type, so an unknown
// type falls back to a generic icon rather than erroring.
const VALID_TYPES = ['restock', 'new', 'maintenance', 'fix', 'announcement', 'removal', 'other'];
const PAGE_SIZE   = 50;

// ─── GET /api/updates ────────────────────────────────────────────────────────
// Public. Returns last PAGE_SIZE rows DESC posted_at. Optional ?before=<id>
// for cursor-based "load more" pagination.
router.get('/', async (req, res) => {
  try {
    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    const { rows } = await query(
      `SELECT id, update_type, product_name, title, notes,
              status_from, status_to, image_url, posted_at
       FROM product_updates
       WHERE guild_id = $1
         AND ($2::int IS NULL OR id < $2)
       ORDER BY posted_at DESC, id DESC
       LIMIT $3`,
      [GUILD_ID, before, PAGE_SIZE]
    );
    res.json({ updates: rows.map(r => ({ ...r, id: String(r.id) })) });
  } catch (err) {
    console.error('[Updates] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch updates' });
  }
});

// ─── POST /api/updates ───────────────────────────────────────────────────────
// Bot (API_SECRET) or admin/staff session. Inserts one update row.
// Body: { update_type, product_name, title?, notes?, status_from?, status_to?,
//         image_url? }
router.post('/', async (req, res) => {
  try {
    const isBot = botAuthorized(req);
    if (!isBot) {
      const user = await getSessionUser(bearerToken(req));
      if (!user || !['admin', 'staff'].includes(user.role)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const { update_type, product_name, title, notes,
            status_from, status_to, image_url } = req.body;

    if (!update_type)   return res.status(400).json({ error: 'update_type is required' });
    if (!product_name)  return res.status(400).json({ error: 'product_name is required' });
    if (!VALID_TYPES.includes(update_type)) {
      return res.status(400).json({ error: `update_type must be one of: ${VALID_TYPES.join(', ')}` });
    }

    const { rows } = await query(
      `INSERT INTO product_updates
         (guild_id, update_type, product_name, title, notes, status_from, status_to, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, posted_at`,
      [GUILD_ID, update_type, String(product_name).slice(0, 200),
       title     ? String(title).slice(0, 300)      : null,
       notes     ? String(notes).slice(0, 2000)     : null,
       status_from ? String(status_from).slice(0, 50) : null,
       status_to   ? String(status_to).slice(0, 50)   : null,
       image_url   ? String(image_url).slice(0, 500)   : null]
    );

    res.json({ success: true, id: String(rows[0].id), posted_at: rows[0].posted_at });
  } catch (err) {
    console.error('[Updates] POST error:', err);
    res.status(500).json({ error: 'Failed to save update' });
  }
});

module.exports = router;
