const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAdmin, getSessionUser, bearerToken } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

function isAuthorized(req) {
  return req.body.secret === process.env.API_SECRET;
}

// Bot (secret) and admin panel (logged-in admin/staff session) both manage
// the catalog — same dual-gate pattern as routes/status.js.
async function isAuthorizedOrAdmin(req) {
  if (isAuthorized(req)) return true;
  const user = await getSessionUser(bearerToken(req));
  return !!(user && ['admin', 'staff'].includes(user.role));
}

// This API predates the unified schema's products/product_tiers split — the
// live site's checkout never calls it (it ships its own embedded catalog),
// so it's kept working but adapted minimally: a "product" here is really a
// priced tier (product_tiers row) joined with its parent product for context.

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.id, t.label, t.price_cents, t.stock_type, t.delivery_type,
              p.id AS product_id, p.name, p.game_name, p.tag, p.specs, p.platforms,
              p.spoofer, p.sections, p.media, p.status, p.hidden
       FROM product_tiers t
       JOIN products p ON p.id = t.product_id
       WHERE t.guild_id = $1 AND p.hidden = false
       ORDER BY p.sort_order DESC, t.sort_order ASC`,
      [GUILD_ID]
    );
    res.json(rows.map(r => ({
      id: r.id,
      product_id: r.product_id,
      tier_label: r.label,
      name: `${r.name} (${r.label})`,
      product_name: r.name,
      description: `${r.game_name} — ${r.label}`,
      price: r.price_cents / 100,
      category: r.game_name,
      tag: r.tag,
      specs: r.specs,
      platforms: r.platforms,
      spoofer: r.spoofer,
      sections: r.sections,
      media: r.media,
      status: r.status,
      stock_type: r.stock_type,
      delivery_type: r.delivery_type,
      active: !r.hidden,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// ─── GET /api/products/admin/all ─────────────────────────
// Full catalog including hidden products, grouped with all their tiers —
// what the admin panel's product manager reads/writes against.
router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    const { rows: products } = await query(
      `SELECT * FROM products WHERE guild_id = $1 ORDER BY sort_order DESC, created_at DESC`,
      [GUILD_ID]
    );
    const { rows: tiers } = await query(
      `SELECT * FROM product_tiers WHERE guild_id = $1 ORDER BY sort_order ASC`,
      [GUILD_ID]
    );
    const byProduct = {};
    for (const t of tiers) {
      (byProduct[t.product_id] ||= []).push(t);
    }
    res.json({
      products: products.map(p => ({ ...p, tiers: byProduct[p.id] || [] })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin product list' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, p.name, p.game_name
       FROM product_tiers t JOIN products p ON p.id = t.product_id
       WHERE t.id = $1 AND t.guild_id = $2`,
      [req.params.id, GUILD_ID]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Product not found' });
    res.json({
      id: r.id,
      name: `${r.name} (${r.label})`,
      price: r.price_cents / 100,
      category: r.game_name,
      stock_type: r.stock_type,
      delivery_type: r.delivery_type,
    });
  } catch (err) {
    res.status(404).json({ error: 'Product not found' });
  }
});

// ─── POST /api/products/new ──────────────────────────────
// Creates a parent product row. sort_order defaults to current max + 1 so
// new products show at the TOP of the storefront (GET / orders DESC).
router.post('/new', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { game_name, name, tag, specs, platforms, spoofer, sections, media, status } = req.body;
    if (!game_name || !name) return res.status(400).json({ error: 'game_name and name are required' });

    const { rows: maxRows } = await query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM products WHERE guild_id = $1',
      [GUILD_ID]
    );
    const { rows } = await query(
      `INSERT INTO products (guild_id, game_name, name, tag, specs, platforms, spoofer, sections, media, status, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        GUILD_ID, game_name, name, tag || null, specs || null, platforms || null,
        !!spoofer, JSON.stringify(sections || []), JSON.stringify(media || {}),
        status || 'undetected', maxRows[0].next,
      ]
    );
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    console.error('[Products] Create product error:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// ─── PATCH /api/products/product/:id ─────────────────────
// Edits the parent product (hide/show, re-sort, rename, status, media, etc).
router.patch('/product/:id', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { game_name, name, tag, specs, platforms, spoofer, sections, media, status, hidden, sort_order } = req.body;
    const { rows } = await query(
      `UPDATE products SET
         game_name  = COALESCE($1, game_name),
         name       = COALESCE($2, name),
         tag        = COALESCE($3, tag),
         specs      = COALESCE($4, specs),
         platforms  = COALESCE($5, platforms),
         spoofer    = COALESCE($6, spoofer),
         sections   = COALESCE($7, sections),
         media      = COALESCE($8, media),
         status     = COALESCE($9, status),
         hidden     = COALESCE($10, hidden),
         sort_order = COALESCE($11, sort_order),
         updated_at = now()
       WHERE id = $12 AND guild_id = $13
       RETURNING *`,
      [
        game_name || null, name || null, tag || null, specs || null, platforms || null,
        spoofer != null ? !!spoofer : null,
        sections ? JSON.stringify(sections) : null,
        media ? JSON.stringify(media) : null,
        status || null, hidden != null ? !!hidden : null, sort_order != null ? sort_order : null,
        req.params.id, GUILD_ID,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    console.error('[Products] Update product error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// ─── DELETE /api/products/product/:id ────────────────────
router.delete('/product/:id', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    await query('DELETE FROM products WHERE id = $1 AND guild_id = $2', [req.params.id, GUILD_ID]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Creates a pricing tier under an existing product — create the parent
// product row (in the `products` table) first; this endpoint only manages
// tiers/pricing, matching what p-bot's flat model called a "product".
router.post('/', async (req, res) => {
  try {
    const { secret, product_id, name, price, stock_type, delivery_type } = req.body;
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { rows } = await query(
      `INSERT INTO product_tiers (product_id, guild_id, label, price_cents, stock_type, delivery_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [product_id, GUILD_ID, name, Math.round(parseFloat(price) * 100), stock_type || 'auto', delivery_type || 'auto']
    );
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { secret, name, price, stock_type, delivery_type } = req.body;
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { rows } = await query(
      `UPDATE product_tiers SET
         label = COALESCE($1, label),
         price_cents = COALESCE($2, price_cents),
         stock_type = COALESCE($3, stock_type),
         delivery_type = COALESCE($4, delivery_type)
       WHERE id = $5 AND guild_id = $6
       RETURNING *`,
      [
        name || null,
        price != null ? Math.round(parseFloat(price) * 100) : null,
        stock_type || null, delivery_type || null,
        req.params.id, GUILD_ID,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// ─── DELETE /api/products/:id ────────────────────────────
// Deletes a single pricing tier (not the parent product).
router.delete('/:id', async (req, res) => {
  try {
    const { secret } = req.body;
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    await query('DELETE FROM product_tiers WHERE id = $1 AND guild_id = $2', [req.params.id, GUILD_ID]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete tier' });
  }
});

module.exports = router;
