const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAdmin } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// ─── GET /api/status ─────────────────────────────────────
// Per-product status (fixes the old localStorage page only showing
// categories, not individual products). product_status overrides win when
// present; otherwise falls back to the product's own `status` column so a
// product never has to be touched twice to show up here.
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT p.id AS product_id, p.game_name, p.name AS product_name,
              COALESCE(ps.status, p.status) AS status, ps.note, COALESCE(ps.updated_at, p.updated_at) AS updated_at
       FROM products p
       LEFT JOIN product_status ps ON ps.product_id = p.id
       WHERE p.guild_id = $1 AND p.hidden = false AND p.vault = false
       ORDER BY p.game_name ASC, p.sort_order DESC`,
      [GUILD_ID]
    );
    res.json({
      statuses: rows.map(r => ({
        product_id: String(r.product_id),
        game_name: r.game_name,
        product_name: r.product_name,
        status: r.status,
        note: r.note,
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ─── GET /api/status/vault ───────────────────────────────
// Vault-side product status (vault = true). Backs the /post-status-vault bot
// command and any vault status view. Same shape as GET /.
router.get('/vault', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT p.id AS product_id, p.game_name, p.name AS product_name,
              COALESCE(ps.status, p.status) AS status, ps.note, COALESCE(ps.updated_at, p.updated_at) AS updated_at
       FROM products p
       LEFT JOIN product_status ps ON ps.product_id = p.id
       WHERE p.guild_id = $1 AND p.hidden = false AND p.vault = true
       ORDER BY p.game_name ASC, p.sort_order DESC`,
      [GUILD_ID]
    );
    res.json({
      statuses: rows.map(r => ({
        product_id: String(r.product_id),
        game_name: r.game_name,
        product_name: r.product_name,
        status: r.status,
        note: r.note,
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch vault status' });
  }
});

// ─── POST /api/status/update ─────────────────────────────
// Bot (/statusupdate) and admin panel both write through this — API_SECRET
// covers the bot, requireAdmin covers a logged-in website admin.
router.post('/update', async (req, res) => {
  try {
    const { secret, product_id, game_name, product_name, status, note } = req.body;
    const isBot = secret === process.env.API_SECRET;
    if (!isBot) {
      const { getSessionUser, bearerToken } = require('../utils/auth');
      const user = await getSessionUser(bearerToken(req));
      if (!user || !['admin', 'staff'].includes(user.role)) return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!['undetected', 'updating', 'detected'].includes(status)) {
      return res.status(400).json({ error: 'status must be undetected, updating, or detected' });
    }

    let gname = game_name, pname = product_name, pid = product_id || null;
    if (pid && (!gname || !pname)) {
      const { rows } = await query('SELECT game_name, name FROM products WHERE id = $1 AND guild_id = $2', [pid, GUILD_ID]);
      if (rows[0]) { gname = rows[0].game_name; pname = rows[0].name; }
    }
    if (!gname || !pname) return res.status(400).json({ error: 'product_id or (game_name and product_name) required' });

    await query(
      `INSERT INTO product_status (guild_id, product_id, game_name, product_name, status, note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (guild_id, game_name, product_name)
       DO UPDATE SET status = $5, note = $6, updated_by = $7, updated_at = now(), product_id = COALESCE(EXCLUDED.product_id, product_status.product_id)`,
      [GUILD_ID, pid, gname, pname, status, note || null, isBot ? 'bot' : 'website']
    );
    if (pid) await query('UPDATE products SET status = $1, updated_at = now() WHERE id = $2', [status, pid]);

    res.json({ success: true });
  } catch (err) {
    console.error('[Status] Update error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

module.exports = router;
