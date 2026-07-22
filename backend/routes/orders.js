const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { generateNote } = require('../utils/noteGenerator');
const { generateCryptoAddress, registerWebhook } = require('../utils/cryptoUtils');
const { notifyBot } = require('../utils/botNotify');
const { attachUser, requireAuth, requireAdmin } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// Shared by POST /create and balance top-ups (backend/routes/balance.js) so
// both paths go through the exact same fee/note/crypto-address/notify logic.
async function createOrder({ items, email, discord_id, payment_method, web_user_id }) {
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
  // payment_method === 'balance': no fee, paid instantly from wallet.

  total = parseFloat(total.toFixed(2));
  const note = generateNote();

  const { rows } = await query(
    `INSERT INTO orders
       (guild_id, web_user_id, email, discord_id, items_snapshot, subtotal_cents, total_cents,
        payment_method, payment_note, status, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'waiting', now(), now() + interval '24 hours')
     RETURNING *`,
    [
      GUILD_ID, web_user_id || null, email, discord_id || null, JSON.stringify(items),
      Math.round(subtotal * 100), Math.round(total * 100),
      payment_method, note,
    ]
  );
  const order = rows[0];

  // Snapshot line items into order_items when checkout sent real numeric
  // tier ids (the new /api/products-backed catalog); older synthetic slugs
  // from the legacy embedded catalog just skip this without failing.
  for (const item of items) {
    if (!/^\d+$/.test(String(item.id))) continue;
    await query(
      `INSERT INTO order_items (order_id, guild_id, tier_id, product_name, unit_cents, qty)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [order.id, GUILD_ID, item.id, item.name || 'Item', Math.round((item.price || 0) * 100), item.qty || 1]
    ).catch(() => {}); // tier_id may not exist (FK) — non-fatal, items_snapshot is the source of truth
  }

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
  } else if (payment_method === 'balance') {
    payment_info = { amount: total };
  }

  await query('UPDATE orders SET payment_info = $1 WHERE id = $2', [JSON.stringify(payment_info), order.id]);

  const freshOrder = { ...order, payment_info };

  if (payment_method === 'balance') {
    // Paid instantly from wallet — deduct + mark paid, then hand off to the
    // normal delivery pipeline exactly like a confirmed cashapp/paypal order.
    await query(
      `UPDATE balances SET balance_cents = balance_cents - $1, updated_at = now() WHERE web_user_id = $2`,
      [Math.round(total * 100), web_user_id]
    );
    await query(
      `INSERT INTO transactions (guild_id, web_user_id, kind, amount_cents, description, order_id)
       VALUES ($1,$2,'debit',$3,$4,$5)`,
      [GUILD_ID, web_user_id, Math.round(total * 100), `Order #${order.id}`, order.id]
    );
    await query(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [order.id]);
    const { rows: paidRows } = await query('SELECT * FROM orders WHERE id = $1', [order.id]);
    await require('../utils/delivery').deliver(paidRows[0]);
  } else {
    await notifyBot('new_order', { order: { ...freshOrder, id: String(order.id) }, payment_info });
  }

  return { order: freshOrder, payment_info, total, fee_note };
}

// ─── POST /api/orders/create ────────────────────────────
router.post('/create', attachUser, async (req, res) => {
  try {
    const { items, email, discord_id, payment_method } = req.body;

    if (!items || !items.length || !payment_method) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (payment_method === 'balance') {
      if (!req.user) return res.status(401).json({ error: 'Log in to pay with balance' });
      const subtotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
      if ((req.user.balance_cents || 0) < Math.round(subtotal * 100)) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
    }

    if (!email && !(req.user && req.user.email)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { order, payment_info, total, fee_note } = await createOrder({
      items,
      email: email || req.user.email,
      discord_id: discord_id || (req.user && req.user.discord_id) || null,
      payment_method,
      web_user_id: req.user ? req.user.id : null,
    });

    res.json({
      success: true,
      order_id: String(order.id),
      payment_method,
      payment_info,
      total,
      fee_note,
      status: order.status,
      expires_at: order.expires_at,
    });

  } catch (err) {
    console.error('[Orders] Create error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ─── GET /api/orders/mine ───────────────────────────────
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM orders WHERE web_user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ orders: rows.map(formatOrder) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ─── GET /api/orders/admin/list ─────────────────────────
router.get('/admin/list', requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.*, u.username FROM orders o
       LEFT JOIN web_users u ON u.id = o.web_user_id
       WHERE o.guild_id = $1 ORDER BY o.created_at DESC LIMIT 500`,
      [GUILD_ID]
    );
    res.json({ orders: rows.map(r => ({ ...formatOrder(r), username: r.username })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

function formatOrder(data) {
  return {
    order_id: String(data.id),
    status: data.status,
    payment_method: data.payment_method,
    items: data.items_snapshot,
    subtotal: data.subtotal_cents / 100,
    total: data.total_cents / 100,
    delivered_goods: data.delivered_goods,
    email: data.email,
    discord_id: data.discord_id,
    created_at: data.created_at,
    paid_at: data.paid_at,
    delivered_at: data.delivered_at,
    expires_at: data.expires_at,
    delivered: data.status === 'delivered',
  };
}

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

// ─── POST /api/orders/verify-claim ──────────────────────
// Secret-gated: SUPERBOT's /claim-customer checks that an order is paid and
// that the supplied email matches the order on record before granting the
// Customer role. Kept separate from the public GET /:id (which never exposes
// the email) so the address is only ever revealed to the trusted bot.
router.post('/verify-claim', async (req, res) => {
  try {
    const { secret, order_id, email } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!order_id || !email) return res.status(400).json({ error: 'order_id and email are required' });

    const { rows } = await query(
      'SELECT status, email, discord_id FROM orders WHERE id = $1 AND guild_id = $2',
      [order_id, GUILD_ID]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const emailMatch = !!order.email && order.email.toLowerCase() === String(email).toLowerCase();
    const isPaid = ['paid', 'delivered'].includes(order.status);
    res.json({
      order_id: String(order_id),
      status: order.status,
      email_match: emailMatch,
      paid: isPaid,
      eligible: emailMatch && isPaid,
      discord_id: order.discord_id || null,
    });
  } catch (err) {
    console.error('[Orders] verify-claim error:', err);
    res.status(500).json({ error: 'Failed to verify claim' });
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
module.exports.createOrder = createOrder;
module.exports.formatOrder = formatOrder;
