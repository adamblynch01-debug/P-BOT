const express = require('express');
const router = express.Router();
const { query } = require('../db');

const GUILD_ID = process.env.GUILD_ID;

// This API predates the unified schema's products/product_tiers split — the
// live site's checkout never calls it (it ships its own embedded catalog),
// so it's kept working but adapted minimally: a "product" here is really a
// priced tier (product_tiers row) joined with its parent product for context.

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.id, t.label, t.price_cents, t.stock_type, t.delivery_type,
              p.name, p.game_name, p.hidden
       FROM product_tiers t
       JOIN products p ON p.id = t.product_id
       WHERE t.guild_id = $1 AND p.hidden = false
       ORDER BY p.sort_order DESC, t.sort_order ASC`,
      [GUILD_ID]
    );
    res.json(rows.map(r => ({
      id: r.id,
      name: `${r.name} (${r.label})`,
      description: `${r.game_name} — ${r.label}`,
      price: r.price_cents / 100,
      category: r.game_name,
      stock_type: r.stock_type,
      delivery_type: r.delivery_type,
      active: !r.hidden,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
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

// Creates a pricing tier under an existing product — create the parent
// product row (in the `products` table) first; this endpoint only manages
// tiers/pricing, matching what p-bot's flat model called a "product".
router.post('/', async (req, res) => {
  try {
    const { secret, product_id, name, price, stock_type, delivery_type } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
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
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
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

module.exports = router;
