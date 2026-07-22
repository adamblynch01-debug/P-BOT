const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { generateNote } = require('../utils/noteGenerator');
const { generateCryptoAddress, registerWebhook } = require('../utils/cryptoUtils');
const { notifyBot } = require('../utils/botNotify');

const GUILD_ID = process.env.GUILD_ID;

// ─── POST /api/orders/create ────────────────────────────
router.post('/create', async (req, res) => {
  try {
    const { items, email, discord_id, payment_method } = req.body;

    if (!items || !email || !payment_method) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let subtotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let total = subtotal;
    let fee_note = '';

    if (payment_method === 'cashapp') {
      const fee = parseFloat(process.env.CASHAPP_FEE_PERCENT || 10);
      total = subtotal * (1 + fee / 100);
      fee_note = `+${fee}% Cash App fee`;
    } else if (payment_method === 'paypal') {
      const fee = parseFloat(process.env.PAYPAL_FEE_PERCENT || 10);
      total = subtotal * (1 + fee / 100);
      fee_note = `+${fee}% PayPal fee`;
    } else if (payment_method === 'btc' || payment_method === 'ltc') {
      const fee = parseFloat(process.env.CRYPTO_FEE_PERCENT || 5);
      total = subtotal * (1 + fee / 100);
      fee_note = `+${fee}% crypto fee`;
    }

    total = parseFloat(total.toFixed(2));
    const note = generateNote();

    // Unified schema uses BIGSERIAL ids (not client-generated UUIDs), so the
    // row has to exist before a crypto address can be derived/stored against
    // it — insert first, then generate + UPDATE the address once we know id.
    const { rows } = await query(
      `INSERT INTO orders
         (guild_id, email, discord_id, items_snapshot, subtotal_cents, total_cents,
          payment_method, payment_note, status, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'waiting', now(), now() + interval '24 hours')
       RETURNING *`,
      [
        GUILD_ID, email, discord_id || null, JSON.stringify(items),
        Math.round(subtotal * 100), Math.round(total * 100),
        payment_method, note,
      ]
    );
    const order = rows[0];

    let crypto_address = null;
    if (payment_method === 'btc' || payment_method === 'ltc') {
      crypto_address = await generateCryptoAddress(payment_method, order.id);
      if (crypto_address) {
        await query('UPDATE orders SET crypto_address = $1 WHERE id = $2', [crypto_address, order.id]);
        await registerWebhook(payment_method, crypto_address, order.id);
      }
    }

    let payment_info = {};
    if (payment_method === 'cashapp') {
      payment_info = { cashtag: process.env.CASHAPP_CASHTAG || '$YOUR_CASHTAG', note, amount: total };
    } else if (payment_method === 'paypal') {
      payment_info = { email: process.env.PAYPAL_EMAIL || 'your@paypal.com', note, amount: total };
    } else if (payment_method === 'btc') {
      payment_info = { address: crypto_address, amount: total, coin: 'BTC' };
    } else if (payment_method === 'ltc') {
      payment_info = { address: crypto_address, amount: total, coin: 'LTC' };
    }

    await query('UPDATE orders SET payment_info = $1 WHERE id = $2', [JSON.stringify(payment_info), order.id]);

    await notifyBot('new_order', { order: { ...order, id: String(order.id) }, payment_info });

    res.json({
      success: true,
      order_id: String(order.id),
      payment_method,
      payment_info,
      total,
      fee_note,
      expires_at: order.expires_at,
    });

  } catch (err) {
    console.error('[Orders] Create error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ─── GET /api/orders/:id ────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    const data = rows[0];
    if (!data) return res.status(404).json({ error: 'Order not found' });

    res.json({
      order_id: String(data.id),
      status: data.status,
      payment_method: data.payment_method,
      total: data.total_cents / 100,
      created_at: data.created_at,
      expires_at: data.expires_at,
      delivered: data.status === 'delivered',
    });
  } catch (err) {
    res.status(404).json({ error: 'Order not found' });
  }
});

// ─── POST /api/orders/confirm ───────────────────────────
router.post('/confirm', async (req, res) => {
  try {
    const { secret, order_id, amount_received, method } = req.body;

    if (secret !== process.env.API_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows } = await query('SELECT * FROM orders WHERE id = $1', [order_id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'paid' || order.status === 'delivered') {
      return res.json({ message: 'Already confirmed' });
    }

    // NOTE: amount_received's unit depends on `method` — dollars for
    // cashapp/paypal, satoshis for btc/ltc (mirrors the original backend's
    // single ambiguous amount_received column). Stored as-is here; don't
    // assume this column is actually cents despite the name.
    await query(
      `UPDATE orders SET status = 'paid', paid_at = now(), amount_received_cents = $1 WHERE id = $2`,
      [amount_received != null ? amount_received : null, order_id]
    );

    const { rows: updatedRows } = await query('SELECT * FROM orders WHERE id = $1', [order_id]);
    await require('../utils/delivery').deliver(updatedRows[0]);

    res.json({ success: true, message: 'Order confirmed and delivery triggered' });

  } catch (err) {
    console.error('[Orders] Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm order' });
  }
});

module.exports = router;
