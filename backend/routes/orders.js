const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { supabase } = require('../db');
const { generateNote } = require('../utils/noteGenerator');
const { generateCryptoAddress } = require('../utils/cryptoUtils');
const { notifyBot } = require('../utils/botNotify');

// ─── POST /api/orders/create ────────────────────────────
// Called by website checkout when user submits order
router.post('/create', async (req, res) => {
  try {
    const { items, email, discord_id, payment_method } = req.body;

    if (!items || !email || !payment_method) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Calculate total
    let subtotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let total = subtotal;
    let fee_note = '';

    // Apply payment method fee/discount
    if (payment_method === 'cashapp') {
      const fee = process.env.CASHAPP_FEE_PERCENT || 10;
      total = subtotal * (1 + fee / 100);
      fee_note = `+${fee}% Cash App fee`;
    } else if (payment_method === 'paypal') {
      const fee = process.env.PAYPAL_FEE_PERCENT || 10;
      total = subtotal * (1 + fee / 100);
      fee_note = `+${fee}% PayPal fee`;
    } else if (payment_method === 'btc' || payment_method === 'ltc') {
      const disc = process.env.CRYPTO_DISCOUNT_PERCENT || 5;
      total = subtotal * (1 - disc / 100);
      fee_note = `-${disc}% crypto discount`;
    }

    total = parseFloat(total.toFixed(2));

    // Generate unique order note (for Cash App / PayPal memo)
    const note = generateNote();
    const order_id = uuidv4();

    // Generate crypto address if needed
    let crypto_address = null;
    if (payment_method === 'btc' || payment_method === 'ltc') {
      crypto_address = await generateCryptoAddress(payment_method, order_id);
    }

    // Build payment instructions
    let payment_info = {};
    if (payment_method === 'cashapp') {
      payment_info = {
        cashtag: process.env.CASHAPP_CASHTAG || '$YOUR_CASHTAG',
        note,
        amount: total,
      };
    } else if (payment_method === 'paypal') {
      payment_info = {
        email: process.env.PAYPAL_EMAIL || 'your@paypal.com',
        note,
        amount: total,
      };
    } else if (payment_method === 'btc') {
      payment_info = {
        address: crypto_address,
        amount: total,
        coin: 'BTC',
      };
    } else if (payment_method === 'ltc') {
      payment_info = {
        address: crypto_address,
        amount: total,
        coin: 'LTC',
      };
    }

    // Save order to Supabase
    const { data, error } = await supabase.from('orders').insert({
      id: order_id,
      email,
      discord_id: discord_id || null,
      items: JSON.stringify(items),
      subtotal,
      total,
      fee_note,
      payment_method,
      payment_note: note,
      crypto_address,
      status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select().single();

    if (error) throw error;

    // Register crypto webhook with BlockCypher if crypto order
    if (crypto_address) {
      await require('../utils/cryptoUtils').registerWebhook(payment_method, crypto_address, order_id);
    }

    // Notify Discord bot of new order
    await notifyBot('new_order', { order: data, payment_info });

    res.json({
      success: true,
      order_id,
      payment_method,
      payment_info,
      total,
      fee_note,
      expires_at: data.expires_at,
    });

  } catch (err) {
    console.error('[Orders] Create error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ─── GET /api/orders/:id ────────────────────────────────
// Poll for order status (website payment waiting page)
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Order not found' });

    res.json({
      order_id: data.id,
      status: data.status,
      payment_method: data.payment_method,
      total: data.total,
      created_at: data.created_at,
      expires_at: data.expires_at,
      delivered: data.delivered || false,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ─── POST /api/orders/confirm ───────────────────────────
// Internal — called by watchers when payment detected
router.post('/confirm', async (req, res) => {
  try {
    const { secret, order_id, amount_received, method } = req.body;

    if (secret !== process.env.API_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get order
    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', order_id)
      .single();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'paid') return res.json({ message: 'Already confirmed' });

    // Mark as paid
    await supabase.from('orders').update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      amount_received,
    }).eq('id', order_id);

    // Trigger delivery
    await require('../utils/delivery').deliver(order);

    res.json({ success: true, message: 'Order confirmed and delivery triggered' });

  } catch (err) {
    console.error('[Orders] Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm order' });
  }
});

module.exports = router;
