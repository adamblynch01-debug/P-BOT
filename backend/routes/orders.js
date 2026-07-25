const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { generateNote } = require('../utils/noteGenerator');
const { generateCryptoAddress, registerWebhook } = require('../utils/cryptoUtils');
const { notifyBot } = require('../utils/botNotify');
const { attachUser, requireAuth, requireAdmin } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// Per-line qty ceiling, so a crafted cart can't ask delivery to claim an
// unbounded number of keys in one order.
const MAX_ITEM_QTY = 25;

// Re-price a cart against product_tiers. The browser sends a price so it can
// render a total, but that number is worthless as an authority: this is the
// public checkout route, and `price` flows straight into the wallet debit.
// A negative price would turn that debit into a credit, so every catalog line
// is re-read from the DB and anything unpriceable is rejected outright when
// the wallet is paying.
async function repriceItems(items, { paidFromBalance }) {
  const ids = items
    .filter(i => /^\d+$/.test(String(i.id)))
    .map(i => parseInt(String(i.id), 10));

  const priced = {};
  if (ids.length) {
    const { rows } = await query(
      `SELECT t.id, t.price_cents, t.label, p.name AS product_name
       FROM product_tiers t JOIN products p ON p.id = t.product_id
       WHERE t.guild_id = $1 AND t.id = ANY($2::bigint[])`,
      [GUILD_ID, ids]
    );
    for (const r of rows) priced[String(r.id)] = r;
  }

  const out = [];
  for (const item of items) {
    const qty = parseInt(item.qty, 10) || 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_ITEM_QTY) {
      return { error: `qty must be between 1 and ${MAX_ITEM_QTY}` };
    }

    const id = String(item.id);
    const row = priced[id];

    if (row) {
      const cents = Number(row.price_cents) || 0;
      if (cents <= 0) return { error: `"${row.product_name}" is quote-only and cannot be bought online` };
      out.push({
        id, qty,
        name: row.label ? `${row.product_name} (${row.label})` : row.product_name,
        price: cents / 100,
      });
      continue;
    }

    // Not a catalog tier: a user-set amount, or a legacy synthetic slug from
    // the embedded catalog. Those still carry a client price, so they may only
    // be paid for externally where a human confirms the amount received.
    if (paidFromBalance) {
      return { error: 'This item is not available for balance checkout. Please contact support.' };
    }
    const price = Number(item.price);
    if (!Number.isFinite(price) || price <= 0) return { error: 'Invalid item price' };
    out.push({ id, qty, name: item.name || 'Item', price });
  }
  return { items: out };
}

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
    // The guard lives in the UPDATE itself: a plain `balance_cents - $1` lets
    // two concurrent checkouts each pass the earlier read and drive the wallet
    // negative, handing out keys that were never paid for.
    const { rows: debited } = await query(
      `UPDATE balances SET balance_cents = balance_cents - $1, updated_at = now()
       WHERE web_user_id = $2 AND balance_cents >= $1 RETURNING balance_cents`,
      [Math.round(total * 100), web_user_id]
    );
    if (!debited.length) {
      await query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
      const err = new Error('Insufficient balance');
      err.statusCode = 400;
      throw err;
    }
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

    if (!items || !Array.isArray(items) || !items.length || !payment_method) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (items.length > 50) return res.status(400).json({ error: 'Too many items' });

    const paidFromBalance = payment_method === 'balance';
    if (paidFromBalance && !req.user) {
      return res.status(401).json({ error: 'Log in to pay with balance' });
    }

    // Prices come from product_tiers, never from the request body.
    const repriced = await repriceItems(items, { paidFromBalance });
    if (repriced.error) return res.status(400).json({ error: repriced.error });
    const safeItems = repriced.items;

    if (paidFromBalance) {
      const subtotal = safeItems.reduce((sum, item) => sum + (item.price * item.qty), 0);
      if ((req.user.balance_cents || 0) < Math.round(subtotal * 100)) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
    }

    if (!email && !(req.user && req.user.email)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { order, payment_info, total, fee_note } = await createOrder({
      items: safeItems,
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
    if (err && err.statusCode === 400) return res.status(400).json({ error: err.message });
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

// ─── GET /api/orders/admin/user/:userId ─────────────────
// One user's order history for the admin panel's per-user detail view.
// The admin Users tab reads real accounts from web_users, which carry no
// embedded purchase list — their orders live only in the `orders` table.
router.get('/admin/user/:userId', requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM orders WHERE guild_id = $1 AND web_user_id = $2 ORDER BY created_at DESC LIMIT 200`,
      [GUILD_ID, req.params.userId]
    );
    res.json({ orders: rows.map(formatOrder) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user orders' });
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
