const express = require('express');
const router = express.Router();
const { supabase } = require('../server');

// GET /api/products — list all active products
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Product not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// POST /api/products — add product (bot admin only)
router.post('/', async (req, res) => {
  try {
    const { secret, name, description, price, category, stock_type, delivery_type } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabase.from('products').insert({
      name,
      description,
      price: parseFloat(price),
      category: category || 'general',
      stock_type: stock_type || 'key', // key | account | manual
      delivery_type: delivery_type || 'auto', // auto | manual
      active: true,
      created_at: new Date().toISOString(),
    }).select().single();

    if (error) throw error;
    res.json({ success: true, product: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PATCH /api/products/:id — update product
router.patch('/:id', async (req, res) => {
  try {
    const { secret, ...updates } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', req.params.id)
      .select().single();

    if (error) throw error;
    res.json({ success: true, product: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

module.exports = router;
