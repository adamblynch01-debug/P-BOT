const express = require('express');
const router = express.Router();
const { query } = require('../db');

const GUILD_ID = process.env.GUILD_ID;

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
    const { secret, product_id, items } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
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
