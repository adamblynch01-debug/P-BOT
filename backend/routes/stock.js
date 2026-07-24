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

// Who made this stock change — a named admin, or the bot when it authed with
// the shared secret.
async function stockActor(req) {
  if (req.body && req.body.secret === process.env.API_SECRET) return 'bot';
  const user = await getSessionUser(bearerToken(req));
  return (user && user.username) || 'unknown';
}

async function unusedCount(tierId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM product_stock WHERE guild_id = $1 AND tier_id = $2 AND used = false',
    [GUILD_ID, tierId]
  );
  return rows[0].n;
}

// Record a stock change. Never allowed to break the write it's auditing — a
// logging failure is logged and swallowed so restocking still succeeds.
async function logStockChange({ tierId, action, before, after, source, actor }) {
  try {
    const { rows } = await query(
      'SELECT p.name, t.label FROM product_tiers t JOIN products p ON p.id = t.product_id WHERE t.id = $1 AND t.guild_id = $2',
      [tierId, GUILD_ID]
    );
    const label = rows[0]
      ? (rows[0].label ? `${rows[0].name} (${rows[0].label})` : rows[0].name)
      : null;
    await query(
      `INSERT INTO stock_log (guild_id, tier_id, product_name, action, delta, count_before, count_after, source, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [GUILD_ID, tierId, label, action, after - before, before, after, source || null, actor || null]
    );
  } catch (err) {
    console.error('[Stock] log write failed (stock change still applied):', err.message);
  }
}

// ─── GET /api/stock/bulk?ids=1,2,3 ───────────────────────
// One round-trip stock lookup for the whole catalog, so the storefront can
// badge every tier without firing a request per card. Returns a map keyed by
// tier_id → available count (only tiers that HAVE unused rows appear; callers
// treat a missing id as 0). MUST be declared before '/:product_id' or Express
// routes "bulk" into the catch-all param.
router.get('/bulk', async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isInteger(n));
    if (!ids.length) return res.json({ stock: {} });
    const { rows } = await query(
      `SELECT tier_id, COUNT(*)::int AS n FROM product_stock
       WHERE guild_id = $1 AND used = false AND tier_id = ANY($2::int[])
       GROUP BY tier_id`,
      [GUILD_ID, ids]
    );
    const stock = {};
    for (const r of rows) stock[r.tier_id] = r.n;
    res.json({ stock });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bulk stock' });
  }
});

// ─── GET /api/stock/log ──────────────────────────────────
// Admin-only restock history. ?tier_id= narrows to one tier; ?limit= caps
// rows (default 100, max 500). Backs the panel's RESTOCK LOG view. MUST be
// declared before '/:product_id' or Express routes "log" into the catch-all.
router.get('/log', async (req, res) => {
  try {
    const user = await getSessionUser(bearerToken(req));
    if (!user || !['admin', 'staff'].includes(user.role)) return res.status(401).json({ error: 'Unauthorized' });
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const tierId = req.query.tier_id ? parseInt(req.query.tier_id, 10) : null;
    const { rows } = await query(
      `SELECT id, tier_id, product_name, action, delta, count_before, count_after, source, actor, created_at
       FROM stock_log
       WHERE guild_id = $1 AND ($2::bigint IS NULL OR tier_id = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [GUILD_ID, tierId, limit]
    );
    res.json({
      entries: rows.map(r => ({
        id: String(r.id), tier_id: r.tier_id != null ? String(r.tier_id) : null,
        product_name: r.product_name, action: r.action, delta: r.delta,
        count_before: r.count_before, count_after: r.count_after,
        source: r.source, actor: r.actor, created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[Stock] log read error:', err);
    res.status(500).json({ error: 'Failed to fetch stock log' });
  }
});

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
    const { product_id, items, source } = req.body;
    const before = await unusedCount(product_id);
    let added = 0;
    for (const value of items) {
      await query('INSERT INTO product_stock (guild_id, tier_id, value) VALUES ($1,$2,$3)', [GUILD_ID, product_id, value]);
      added++;
    }
    await logStockChange({
      tierId: product_id, action: 'add', before, after: before + added,
      source, actor: await stockActor(req),
    });
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
    const { product_id, items, source } = req.body;
    if (!product_id || !Array.isArray(items)) return res.status(400).json({ error: 'product_id and items[] are required' });
    const clean = items.map(v => String(v).trim()).filter(v => v !== '');
    const before = await unusedCount(product_id);
    await query('DELETE FROM product_stock WHERE guild_id = $1 AND tier_id = $2 AND used = false', [GUILD_ID, product_id]);
    for (const value of clean) {
      await query('INSERT INTO product_stock (guild_id, tier_id, value) VALUES ($1,$2,$3)', [GUILD_ID, product_id, value]);
    }
    // A 'set' to zero is a deliberate wipe — log it as such so the history
    // distinguishes "cleared the tier" from "replaced the keys".
    if (before !== clean.length || clean.length === 0) {
      await logStockChange({
        tierId: product_id, action: clean.length === 0 ? 'clear' : 'set',
        before, after: clean.length, source, actor: await stockActor(req),
      });
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
