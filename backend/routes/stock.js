const express = require('express');
const router = express.Router();
const { supabase } = require('../db');

router.get('/:product_id', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('stock').select('*', { count: 'exact', head: true })
      .eq('product_id', req.params.product_id).eq('used', false);
    if (error) throw error;
    res.json({ product_id: req.params.product_id, available: count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stock' });
  }
});

router.post('/add', async (req, res) => {
  try {
    const { secret, product_id, items } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    const rows = items.map(value => ({
      product_id, value, used: false,
      added_at: new Date().toISOString(),
    }));
    const { data, error } = await supabase.from('stock').insert(rows).select();
    if (error) throw error;
    res.json({ success: true, added: data.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add stock' });
  }
});

router.post('/claim', async (req, res) => {
  try {
    const { secret, product_id, order_id } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    const { data, error } = await supabase
      .from('stock').select('*').eq('product_id', product_id)
      .eq('used', false).limit(1).single();
    if (error || !data) return res.status(404).json({ error: 'Out of stock' });
    await supabase.from('stock').update({
      used: true, used_at: new Date().toISOString(), order_id,
    }).eq('id', data.id);
    res.json({ success: true, value: data.value });
  } catch (err) {
    res.status(500).json({ error: 'Failed to claim stock' });
  }
});

module.exports = router;
