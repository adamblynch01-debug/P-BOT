const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth, requireAdmin, getSessionUser, bearerToken } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// Bot (secret) and admin panel (logged-in admin/staff session) both moderate
// reviews — same dual-gate pattern as routes/status.js and routes/products.js.
async function requireAdminOrBot(req, res, next) {
  const secret = req.body.secret || req.query.secret;
  if (secret === process.env.API_SECRET) return next();
  const user = await getSessionUser(bearerToken(req));
  if (user && ['admin', 'staff'].includes(user.role)) { req.user = user; return next(); }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ─── GET /api/reviews ────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, display_name, rating, body, source, product_id, created_at
       FROM reviews WHERE guild_id = $1 AND approved = true ORDER BY created_at DESC LIMIT 200`,
      [GUILD_ID]
    );
    res.json({ reviews: rows.map(r => ({ ...r, id: String(r.id), product_id: r.product_id ? String(r.product_id) : null })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// ─── POST /api/reviews ───────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { rating, body, product_id } = req.body;
    const r = parseInt(rating, 10);
    if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'rating must be 1-5' });

    const { rows } = await query(
      `INSERT INTO reviews (guild_id, web_user_id, display_name, product_id, rating, body, source)
       VALUES ($1,$2,$3,$4,$5,$6,'website') RETURNING *`,
      [GUILD_ID, req.user.id, req.user.username, product_id || null, r, body || null]
    );
    res.json({ success: true, review: { ...rows[0], id: String(rows[0].id) } });
  } catch (err) {
    console.error('[Reviews] Create error:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// ─── GET /api/reviews/admin/all ──────────────────────────
router.get('/admin/all', requireAdminOrBot, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM reviews WHERE guild_id = $1 ORDER BY created_at DESC`,
      [GUILD_ID]
    );
    res.json({ reviews: rows.map(r => ({ ...r, id: String(r.id) })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// ─── PATCH /api/reviews/:id/approve ──────────────────────
router.patch('/:id/approve', requireAdminOrBot, async (req, res) => {
  try {
    const { approved } = req.body;
    const { rows } = await query(
      `UPDATE reviews SET approved = $1 WHERE id = $2 AND guild_id = $3 RETURNING *`,
      [approved !== false, req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'Review not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update review' });
  }
});

// ─── DELETE /api/reviews/:id ──────────────────────────────
router.delete('/:id', requireAdminOrBot, async (req, res) => {
  try {
    await query('DELETE FROM reviews WHERE id = $1 AND guild_id = $2', [req.params.id, GUILD_ID]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

module.exports = router;
