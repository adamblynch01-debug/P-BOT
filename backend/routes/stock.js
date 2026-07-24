const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { getSessionUser, bearerToken } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// Bot (secret) and admin panel (logged-in admin/staff session) both manage
// stock — same dual-gate pattern as routes/products.js. The static site can
// never hold API_SECRET, so its stock writes authenticate with the admin's
// session token instead.
async function isAuthorizedOrAdmin(req) {
  if (req.body && req.body.secret === process.env.API_SECRET) return true;
  const user = await getSessionUser(bearerToken(req));
  return !!(user && ['admin', 'staff'].includes(user.role));
}

router.get('/:product_id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM product_stock WHERE guild_id = $1 AND tier_id = $2 AND used = false',
      [GUILD_ID, req.params.product_id]
    );
    res.json({ product_id: req.params.product_id, available: rows[0].n });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stock' });
  }
});

router.post('/add', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { product_id, items } = req.body;
    let added = 0;
    for (const value of items) {
      await query('INSERT INTO product_stock (guild_id, tier_id, value) VALUES ($1,$2,$3)', [GUILD_ID, product_id, value]);
      added++;
    }
    res.json({ success: true, added });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add stock' });
  }
});

// ─── POST /api/stock/set ─────────────────────────────────
// Replace the UNUSED stock for a tier with exactly `items` (used/claimed keys
// are preserved for order history). Lets the admin panel's "SAVE STOCK"
// textarea be the source of truth for available keys without holding secrets.
router.post('/set', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { product_id, items } = req.body;
    if (!product_id || !Array.isArray(items)) return res.status(400).json({ error: 'product_id and items[] are required' });
    const clean = items.map(v => String(v).trim()).filter(v => v !== '');
    await query('DELETE FROM product_stock WHERE guild_id = $1 AND tier_id = $2 AND used = false', [GUILD_ID, product_id]);
    for (const value of clean) {
      await query('INSERT INTO product_stock (guild_id, tier_id, value) VALUES ($1,$2,$3)', [GUILD_ID, product_id, value]);
    }
    res.json({ success: true, count: clean.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set stock' });
  }
});

// ─── GET /api/stock/list/:product_id ─────────────────────
// Admin-only readback of the UNUSED keys for a tier, so the panel's stock
// textarea can prefill with what's actually deliverable server-side.
router.get('/list/:product_id', async (req, res) => {
  try {
    const user = await getSessionUser(bearerToken(req));
    if (!user || !['admin', 'staff'].includes(user.role)) return res.status(401).json({ error: 'Unauthorized' });
    const { rows } = await query(
      'SELECT value FROM product_stock WHERE guild_id = $1 AND tier_id = $2 AND used = false ORDER BY id ASC',
      [GUILD_ID, req.params.product_id]
    );
    res.json({ product_id: req.params.product_id, items: rows.map(r => r.value) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list stock' });
  }
});

router.post('/claim', async (req, res) => {
  try {
    const { secret, product_id, order_id } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    // Atomic claim: lock+skip so concurrent deliveries can't hand out the
    // same key twice (mirrors the pattern SUPERBOT's own index.js already
    // uses for key issuance).
    const { rows } = await query(
      `UPDATE product_stock SET used = true, used_at = now(), order_id = $1
       WHERE id = (
         SELECT id FROM product_stock
         WHERE guild_id = $2 AND tier_id = $3 AND used = false
         ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING value`,
      [order_id, GUILD_ID, product_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Out of stock' });
    res.json({ success: true, value: rows[0].value });
  } catch (err) {
    res.status(500).json({ error: 'Failed to claim stock' });
  }
});

module.exports = router;
