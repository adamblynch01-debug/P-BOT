const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { generateNote } = require('../utils/noteGenerator');
const { generateCryptoAddress, registerWebhook, quoteCrypto } = require('../utils/cryptoUtils');
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

const FEES = { cashapp: ['CASHAPP_FEE_PERCENT', 10, 'Cash App'],
               paypal:  ['PAYPAL_FEE_PERCENT', 10, 'PayPal'],
               btc:     ['CRYPTO_FEE_PERCENT', 5, 'crypto'],
               ltc:     ['CRYPTO_FEE_PERCENT', 5, 'crypto'] };

// Adds the payment-method fee to an integer-cents subtotal.
//
// `subtotal * (1 + fee/100)` then `toFixed(2)` rounded the fee DOWN every time
// the product landed a hair under the half-cent in binary — a systematic
// undercharge (never an overcharge). Scaling by an integer basis-point factor
// keeps the arithmetic exact.
function applyFee(subtotalCents, payment_method) {
  // payment_method === 'balance': no fee, paid instantly from wallet.
  if (!FEES[payment_method]) return { totalCents: subtotalCents, fee_note: '' };
  const [envKey, defaultPct, label] = FEES[payment_method];
  const pct = parseFloat(process.env[envKey] || defaultPct);
  const fee = Number.isFinite(pct) ? pct : defaultPct;
  return {
    totalCents: Math.round(subtotalCents * (10000 + Math.round(fee * 100)) / 10000),
    fee_note: `+${fee}% ${label} fee`,
  };
}

// Shared by POST /create and balance top-ups (backend/routes/balance.js) so
// both paths go through the exact same fee/note/crypto-address/notify logic.
async function createOrder({ items, email, discord_id, payment_method, web_user_id }) {
  // Money is summed in integer cents. Item prices are dollars-as-floats at the
  // API boundary, so each line is rounded once on the way in and never again;
  // accumulating the floats and rounding the sum lets binary representation
  // error decide the last cent.
  const subtotalCents = items.reduce(
    (sum, item) => sum + Math.round(item.price * 100) * (item.qty || 1), 0
  );

  const { totalCents, fee_note } = applyFee(subtotalCents, payment_method);

  const total = totalCents / 100;
  const note = generateNote();

  const { rows } = await query(
    `INSERT INTO orders
       (guild_id, web_user_id, email, discord_id, items_snapshot, subtotal_cents, total_cents,
        payment_method, payment_note, status, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'waiting', now(), now() + interval '24 hours')
     RETURNING *`,
    [
      GUILD_ID, web_user_id || null, email, discord_id || null, JSON.stringify(items),
      subtotalCents, totalCents,
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
  } else if (payment_method === 'btc' || payment_method === 'ltc') {
    // Lock the USD→coin rate at order time. The customer is quoted dollars but
    // pays satoshis, so without a stored quote there is nothing to validate the
    // incoming payment against — which is exactly how a 1-satoshi payment used
    // to settle any invoice. expected_sats is what the confirm path checks.
    const coin = payment_method;
    const quote = await quoteCrypto(coin, total);
    payment_info = {
      address: crypto_address,
      amount: total,
      coin: coin.toUpperCase(),
      ...(quote ? {
        coin_amount: quote.coin_amount,
        expected_sats: quote.expected_sats,
        rate_usd: quote.rate_usd,
        quoted_at: new Date().toISOString(),
      } : {}),
    };
    if (!quote) {
      // No rate means no verifiable quote. Say so loudly: verifyCryptoPayment
      // fails closed on a missing quote, so these orders will need manual
      // review rather than settling on their own.
      console.error(`[Orders] No ${coin.toUpperCase()} rate for order ${order.id} — payment cannot be auto-verified`);
    }
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
      [totalCents, web_user_id]
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
      [GUILD_ID, web_user_id, totalCents, `Order #${order.id}`, order.id]
    );
    const { rows: paidRows } = await query(
      `UPDATE orders SET status = 'paid', paid_at = now(),
              amount_received_cents = $1, amount_received_unit = 'usd'
        WHERE id = $2 AND status = 'waiting' RETURNING *`,
      [totalCents, order.id]
    );
    if (paidRows.length) await require('../utils/delivery').deliver(paidRows[0]);
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

// Converts the figure a payment provider reported into USD cents.
//
// `amount_received` arrives in whatever unit the provider speaks: dollars from
// the email watchers, satoshis from the crypto paths. Storing it raw is what
// left one column holding three different units, so the native figure is kept
// beside its unit name and the canonical cents value is derived here.
function nativeToUsdCents(order, native, method) {
  if (native == null || !Number.isFinite(Number(native))) return { cents: null, unit: null };
  const value = Number(native);

  if (method === 'btc' || method === 'ltc') {
    // payment_info comes back as an object from a JSONB column but as a string
    // from a TEXT one. Reading .rate_usd off the string yields undefined, which
    // fails closed but silently throws away a USD figure we could have derived.
    let info = order.payment_info;
    if (typeof info === 'string') {
      try { info = JSON.parse(info); } catch { info = null; }
    }
    const rate = Number((info || {}).rate_usd);
    // No locked rate means no defensible USD figure. Record the satoshis and
    // leave cents null rather than inventing a number a report would trust.
    if (!Number.isFinite(rate) || rate <= 0) return { cents: null, unit: 'sats' };
    return { cents: Math.round((value / 1e8) * rate * 100), unit: 'sats' };
  }
  return { cents: Math.round(value * 100), unit: 'usd' };
}

// ─── POST /api/orders/confirm ───────────────────────────
router.post('/confirm', async (req, res) => {
  try {
    const { secret, order_id, amount_received, method, provider_txn_id } = req.body;

    if (secret !== process.env.API_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows } = await query('SELECT * FROM orders WHERE id = $1', [order_id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { cents, unit } = nativeToUsdCents(order, amount_received, method || order.payment_method);

    // The status transition IS the lock. This used to be a read, a check, and
    // then an unconditional write: two confirmations arriving within one DB
    // round-trip both saw 'waiting', both wrote 'paid', and both ran delivery —
    // claiming a second set of keys and, on a balance top-up, crediting the
    // wallet twice. Gating the UPDATE on the status it expects to replace makes
    // exactly one caller win, no matter how many arrive together.
    //
    // Only 'waiting' and 'underpaid' are confirmable. Previously anything that
    // wasn't already paid qualified, which included 'cancelled' and 'expired'.
    const { rows: claimed } = await query(
      `UPDATE orders
          SET status = 'paid', paid_at = now(),
              amount_received_cents = $1, amount_received_native = $2, amount_received_unit = $3,
              provider_txn_id = COALESCE($4, provider_txn_id)
        WHERE id = $5 AND status IN ('waiting', 'underpaid')
        RETURNING *`,
      [cents, amount_received != null ? amount_received : null, unit, provider_txn_id || null, order_id]
    );

    if (!claimed.length) {
      // Either already confirmed, or in a status we refuse to settle from.
      const settled = order.status === 'paid' || order.status === 'delivered';
      console.log(`[Orders] Confirm ignored for ${order_id} — status ${order.status}`);
      return res.json({ message: settled ? 'Already confirmed' : `Not confirmable from status ${order.status}` });
    }

    await require('../utils/delivery').deliver(claimed[0]);

    res.json({ success: true, message: 'Order confirmed and delivery triggered' });

  } catch (err) {
    // A duplicate provider_txn_id trips uniq_orders_provider_txn — that means
    // this exact provider event already settled an order. Not an error.
    if (err && err.code === '23505') {
      console.warn('[Orders] Confirm rejected — provider transaction already applied');
      return res.json({ message: 'Provider transaction already applied' });
    }
    console.error('[Orders] Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm order' });
  }
});

module.exports = router;
module.exports.createOrder = createOrder;
module.exports.formatOrder = formatOrder;
module.exports.__test__ = { applyFee, nativeToUsdCents, repriceItems };
