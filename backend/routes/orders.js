const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { generateNote } = require('../utils/noteGenerator');
const { generateCryptoAddress, registerWebhook, quoteCrypto } = require('../utils/cryptoUtils');
const { notifyBot } = require('../utils/botNotify');
const { attachUser, requireAuth, requireAdmin, botAuthorized, botAuthUnavailable } = require('../utils/auth');
const { safeCompare } = require('../utils/rateLimit');
const {
  normalizeCode, previewCoupon, reserveCoupon, attachRedemptionOrder, releaseCoupon, publicView,
} = require('../utils/coupons');

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
//
// The reseller discount is applied HERE, from web_users.reseller_discount, and
// nowhere else. The storefront cart used to compute it in the browser and
// paint the discounted figure as the amount due while this route charged full
// list price — so every reseller was overcharged by exactly their discount,
// and the cart, the balance check and the actual debit were three different
// numbers. The client's arithmetic is now display-only; this is the authority.
// Item ids that mean "an amount the customer typed", not a product. Kept in
// step with utils/delivery.js, which matches the same two ids to record a
// manual-fulfillment note instead of claiming stock.
const CUSTOM_PAYMENT_IDS = new Set(['donation', 'custom-amount']);

async function repriceItems(items, { paidFromBalance, discountPercent }) {
  const ids = items
    .filter(i => /^\d+$/.test(String(i.id)))
    .map(i => parseInt(String(i.id), 10));

  // Clamped and converted to basis points so the arithmetic stays in integers
  // — same shape as routes/reseller.js, which had this right already.
  const pct = Math.max(0, Math.min(99, Number(discountPercent) || 0));
  const discountBp = Math.round(pct * 100);

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
  // The portion of the cart a coupon is allowed to discount: catalog lines
  // only. A custom payment is an amount the customer typed and a legacy
  // synthetic slug carries a browser-set price — taking a percentage off
  // either would be discounting a number we did not choose, which is the same
  // rule the reseller discount already follows a few lines below.
  let catalogSubtotalCents = 0;
  for (const item of items) {
    const qty = parseInt(item.qty, 10) || 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_ITEM_QTY) {
      return { error: `qty must be between 1 and ${MAX_ITEM_QTY}` };
    }

    const id = String(item.id);
    const row = priced[id];

    if (row) {
      const listCents = Number(row.price_cents) || 0;
      if (listCents <= 0) return { error: `"${row.product_name}" is quote-only and cannot be bought online` };
      const cents = discountBp
        ? Math.round((listCents * (10000 - discountBp)) / 10000)
        : listCents;
      out.push({
        id, qty,
        name: row.label ? `${row.product_name} (${row.label})` : row.product_name,
        price: cents / 100,
        ...(discountBp ? { list_price: listCents / 100 } : {}),
      });
      catalogSubtotalCents += cents * qty;
      continue;
    }

    // Not a catalog tier: a user-set amount, or a legacy synthetic slug from
    // the embedded catalog. Those still carry a client price, so they may only
    // be paid for externally where a human confirms the amount received.
    // No discount is applied to these — the price is not ours to trust.
    //
    // The one exception is an explicit custom payment. It maps to no catalog
    // product, so there is nothing to underprice, and delivery.js hands it to
    // staff as a manual-fulfillment note rather than releasing goods — the
    // customer simply debits their own wallet by the figure they typed, which
    // is not a way to gain anything. Every OTHER client-priced item stays
    // barred from the wallet: a legacy synthetic slug names a REAL product,
    // and letting a browser set its price would sell it for a cent.
    // A negative or zero amount is rejected just below, so this cannot be run
    // backwards to credit a balance.
    if (paidFromBalance && !CUSTOM_PAYMENT_IDS.has(id)) {
      return { error: 'This item is not available for balance checkout. Please contact support.' };
    }
    const price = Number(item.price);
    if (!Number.isFinite(price) || price <= 0) return { error: 'Invalid item price' };
    out.push({ id, qty, name: item.name || 'Item', price });
  }
  return { items: out, discount_percent: pct, catalogSubtotalCents };
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

// Money is summed in integer cents. Item prices are dollars-as-floats at the
// API boundary, so each line is rounded once on the way in and never again;
// accumulating the floats and rounding the sum lets binary representation
// error decide the last cent.
function subtotalCentsOf(items) {
  return items.reduce(
    (sum, item) => sum + Math.round(item.price * 100) * (item.qty || 1), 0
  );
}

// Reserving the coupon wraps order creation rather than sitting inside it. The
// use must be consumed BEFORE the total is computed — otherwise two checkouts
// race past the last use of a limited code — and it must be handed back if
// anything downstream throws, or a customer whose checkout failed permanently
// burns a use they never received. Expressing that inline would mean a
// try/catch around the whole of createOrderPriced for the sake of one
// statement at the top.
async function createOrder(opts) {
  const code = normalizeCode(opts.coupon_code);
  if (code === false) {
    const e = new Error('That coupon code is not valid.');
    e.statusCode = 400;
    throw e;
  }
  if (!code) return createOrderPriced({ ...opts, coupon: null, couponDiscountCents: 0 });

  // Callers pass the coupon-eligible subtotal (catalog lines only) separately
  // from the cart subtotal. Falling back to the whole subtotal would let a
  // percentage code discount a donation.
  const eligibleCents = opts.coupon_eligible_cents == null
    ? subtotalCentsOf(opts.items)
    : opts.coupon_eligible_cents;

  const reserved = await reserveCoupon({ code, eligibleCents, web_user_id: opts.web_user_id });
  if (reserved.error) {
    const e = new Error(reserved.error);
    e.statusCode = 400;
    throw e;
  }

  try {
    const result = await createOrderPriced({
      ...opts,
      coupon: reserved.coupon,
      couponDiscountCents: reserved.discountCents,
    });
    await attachRedemptionOrder(reserved.redemptionId, result.order.id);
    return result;
  } catch (err) {
    await releaseCoupon(reserved.redemptionId, reserved.coupon && reserved.coupon.id);
    throw err;
  }
}

// Shared by POST /create and balance top-ups (backend/routes/balance.js) so
// both paths go through the exact same fee/note/crypto-address/notify logic.
async function createOrderPriced({ items, email, discord_id, payment_method, web_user_id,
                                   coupon, couponDiscountCents }) {
  const subtotalCents = subtotalCentsOf(items);

  // The coupon comes off the subtotal BEFORE the payment-method fee, so the
  // fee is charged on what the customer actually pays. Fee-then-discount would
  // bill a 10% Cash App fee on money nobody sent.
  const discountCents = Math.max(0, Math.min(subtotalCents, Number(couponDiscountCents) || 0));
  const { totalCents, fee_note } = applyFee(subtotalCents - discountCents, payment_method);

  const total = totalCents / 100;

  // The payment note is drawn from a 5.76M-value space and constrained by the
  // partial unique index uniq_orders_open_note (one open order per note). A
  // collision is rare but not impossible, and the crypto-address path already
  // retries its own 23505 — the note path never did, so an unlucky customer
  // got a bare 500 with nothing to act on. Retry with a fresh note instead.
  let order = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const note = generateNote();
    const publicRef = crypto.randomBytes(16).toString('hex');
    try {
      const { rows } = await query(
        `INSERT INTO orders
           (guild_id, web_user_id, email, discord_id, items_snapshot, subtotal_cents, total_cents,
            payment_method, payment_note, public_ref, coupon_code, coupon_discount_cents,
            status, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'waiting', now(), now() + interval '24 hours')
         RETURNING *`,
        [
          GUILD_ID, web_user_id || null, email, discord_id || null, JSON.stringify(items),
          // subtotal_cents stays GROSS and the discount is stored beside it, so
          // a receipt can show the coupon line instead of an unexplained gap
          // between subtotal and total.
          subtotalCents, totalCents,
          payment_method, note, publicRef,
          coupon ? coupon.code : null, discountCents,
        ]
      );
      order = rows[0];
      break;
    } catch (err) {
      if (err && err.code === '23505') {
        lastErr = err;
        console.warn(`[Orders] note/ref collision on attempt ${attempt + 1}, retrying`);
        continue;
      }
      throw err;
    }
  }
  if (!order) {
    console.error('[Orders] exhausted note retries:', lastErr && lastErr.message);
    const e = new Error('Could not allocate a payment reference. Please try again.');
    e.statusCode = 400;
    throw e;
  }

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
    payment_info = { cashtag: process.env.CASHAPP_CASHTAG || '$YOUR_CASHTAG', note: order.payment_note, amount: total };
  } else if (payment_method === 'paypal') {
    payment_info = { email: process.env.PAYPAL_EMAIL || 'your@paypal.com', note: order.payment_note, amount: total };
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
    //
    // The three writes are one transaction because they were previously
    // independent: a failure after the debit but before the status flip left
    // the customer charged for an order still sitting at `waiting`, which then
    // expired. Money taken, nothing delivered, nothing logged as wrong.
    let paidOrder = null;
    try {
      paidOrder = await withTransaction(async (exec) => {
        const { rows: debited } = await exec(
          `UPDATE balances SET balance_cents = balance_cents - $1, updated_at = now()
           WHERE web_user_id = $2 AND balance_cents >= $1 RETURNING balance_cents`,
          [totalCents, web_user_id]
        );
        if (!debited.length) {
          const err = new Error('Insufficient balance');
          err.statusCode = 400;
          err.insufficient = true;
          throw err;
        }
        await exec(
          `INSERT INTO transactions (guild_id, web_user_id, kind, amount_cents, description, order_id)
           VALUES ($1,$2,'debit',$3,$4,$5)`,
          [GUILD_ID, web_user_id, totalCents, `Order #${order.id}`, order.id]
        );
        const { rows: paidRows } = await exec(
          `UPDATE orders SET status = 'paid', paid_at = now(),
                  amount_received_cents = $1, amount_received_unit = 'usd'
            WHERE id = $2 AND status = 'waiting' RETURNING *`,
          [totalCents, order.id]
        );
        return paidRows[0] || null;
      });
    } catch (err) {
      // Cancelling the order is deliberately OUTSIDE the transaction: the
      // rollback has already undone the debit, and this write must survive.
      await query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]).catch(() => {});
      throw err;
    }

    // Every payment method converges here: staff get one order feed regardless
    // of how the customer paid. This notify used to live only in the `else`
    // branch, so a balance checkout — which settles instantly and is the most
    // common path for a returning customer — produced no Discord entry at all.
    // Fired BEFORE delivery so the order is visible even if delivery then
    // fails and flips the order to needs_attention.
    //
    // NOT awaited. This is a network call to Discord that can take the full
    // 8s timeout, and it used to sit directly in the customer's checkout
    // response — so a slow Discord API left the browser stuck on "PROCESSING…"
    // for an order that had already been paid and delivered. Nothing here
    // affects the money or the goods: notifyBot is non-fatal by contract and
    // returns null on any failure, so there is no result worth waiting for.
    notifyBot('new_order', {
      order: { ...freshOrder, id: String(order.id), status: 'paid' },
      payment_info,
    }).catch(() => {});

    // Delivery only after COMMIT. Inside the transaction a later rollback would
    // un-charge the customer while the keys were already sent — the one failure
    // mode worse than the one being fixed.
    if (paidOrder) await require('../utils/delivery').deliver(paidOrder);
  } else {
    // Same reasoning as the balance branch above — the customer waits on a
    // payment page, not on Discord.
    notifyBot('new_order', { order: { ...freshOrder, id: String(order.id) }, payment_info }).catch(() => {});
  }

  return {
    order: freshOrder, payment_info, total, fee_note,
    subtotal: subtotalCents / 100,
    coupon: coupon ? publicView(coupon, discountCents) : null,
    coupon_discount: discountCents / 100,
  };
}

// ─── POST /api/orders/quote ─────────────────────────────
// Prices a cart WITHOUT creating an order, using exactly the same repriceItems
// + applyFee path /create uses.
//
// The payment overlay used to compute the method fee and grand total in the
// browser from a config it had fetched separately. If /api/config was briefly
// unreachable the fee row silently vanished and the summary showed the
// undiscounted subtotal as TOTAL — while the payment instructions, which come
// from the server, asked for the fee-inclusive amount. The customer sent what
// the site displayed, the watcher's amount check rejected it as an
// underpayment, and the order sat unpaid with the buyer certain they had paid.
// The same divergence was permanent if a fee percent changed on Railway.
//
// One authority for money: this route.
router.post('/quote', attachUser, async (req, res) => {
  try {
    const { items, payment_method, coupon_code } = req.body;
    if (!items || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items[] is required' });
    }
    if (items.length > 50) return res.status(400).json({ error: 'Too many items' });

    const paidFromBalance = payment_method === 'balance';
    if (paidFromBalance && !req.user) {
      return res.status(401).json({ error: 'Log in to pay with balance' });
    }

    const repriced = await repriceItems(items, {
      paidFromBalance,
      discountPercent: (req.user && req.user.reseller_discount) || 0,
    });
    if (repriced.error) return res.status(400).json({ error: repriced.error });

    const subtotalCents = subtotalCentsOf(repriced.items);

    // A bad coupon does NOT fail the quote. The overlay needs the totals in
    // order to render at all, so returning 400 here would blank the summary
    // over a typo; the code is simply not applied and `coupon_error` says why.
    // /create is the one that must refuse, so a customer can never be charged
    // full price against a screen that showed a discount.
    let couponDiscountCents = 0;
    let coupon = null;
    let coupon_error = null;
    if (normalizeCode(coupon_code)) {
      const preview = await previewCoupon({
        code: coupon_code,
        eligibleCents: repriced.catalogSubtotalCents || 0,
        web_user_id: req.user ? req.user.id : null,
      });
      if (preview.error) coupon_error = preview.error;
      else if (preview.coupon) {
        coupon = preview.coupon;
        couponDiscountCents = preview.discountCents;
      }
    } else if (coupon_code != null && String(coupon_code).trim() !== '') {
      coupon_error = 'That coupon code is not valid.';
    }

    const { totalCents, fee_note } = applyFee(subtotalCents - couponDiscountCents, payment_method);

    res.json({
      items: repriced.items,
      discount_percent: repriced.discount_percent || 0,
      subtotal: subtotalCents / 100,
      coupon: coupon ? publicView(coupon, couponDiscountCents) : null,
      coupon_discount: couponDiscountCents / 100,
      coupon_error,
      fee: (totalCents - (subtotalCents - couponDiscountCents)) / 100,
      fee_note,
      total: totalCents / 100,
    });
  } catch (err) {
    console.error('[Orders] quote error:', err);
    res.status(500).json({ error: 'Failed to price this cart' });
  }
});

// ─── POST /api/orders/create ────────────────────────────
router.post('/create', attachUser, async (req, res) => {
  try {
    const { items, email, discord_id, payment_method, coupon_code } = req.body;

    if (!items || !Array.isArray(items) || !items.length || !payment_method) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (items.length > 50) return res.status(400).json({ error: 'Too many items' });

    const paidFromBalance = payment_method === 'balance';
    if (paidFromBalance && !req.user) {
      return res.status(401).json({ error: 'Log in to pay with balance' });
    }

    // Prices come from product_tiers, never from the request body. The
    // reseller discount likewise comes from the session's own web_users row —
    // an anonymous checkout gets none, and the client cannot ask for one.
    const repriced = await repriceItems(items, {
      paidFromBalance,
      discountPercent: (req.user && req.user.reseller_discount) || 0,
    });
    if (repriced.error) return res.status(400).json({ error: repriced.error });
    const safeItems = repriced.items;

    if (paidFromBalance) {
      // Sized with a PREVIEW of the coupon, never a reservation. This check is
      // only here to produce a friendly error ahead of the atomic debit, and a
      // reservation at this point would consume a use on a checkout that is
      // about to be rejected. It also cannot be skipped: without the discount
      // a wallet holding exactly the discounted total would be turned away.
      let previewDiscountCents = 0;
      if (normalizeCode(coupon_code)) {
        const preview = await previewCoupon({
          code: coupon_code,
          eligibleCents: repriced.catalogSubtotalCents || 0,
          web_user_id: req.user.id,
        });
        if (preview.error) return res.status(400).json({ error: preview.error });
        previewDiscountCents = preview.discountCents || 0;
      }
      const subtotalCents = subtotalCentsOf(safeItems);
      if ((req.user.balance_cents || 0) < Math.max(0, subtotalCents - previewDiscountCents)) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
    }

    if (!email && !(req.user && req.user.email)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { order, payment_info, total, fee_note, coupon, coupon_discount } = await createOrder({
      items: safeItems,
      email: email || req.user.email,
      discord_id: discord_id || (req.user && req.user.discord_id) || null,
      payment_method,
      web_user_id: req.user ? req.user.id : null,
      coupon_code,
      coupon_eligible_cents: repriced.catalogSubtotalCents || 0,
    });

    res.json({
      success: true,
      order_id: String(order.id),
      // Returned exactly once, to whoever created the order. GET /api/orders/:id
      // requires it (or an owning/admin session) — the numeric id alone is not
      // a credential.
      public_ref: order.public_ref || null,
      // What the server actually applied, so the cart can render the server's
      // number instead of its own guess.
      discount_percent: repriced.discount_percent || 0,
      coupon: coupon || null,
      coupon_discount: coupon_discount || 0,
      items: safeItems,
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
    coupon_code: data.coupon_code || null,
    coupon_discount: (Number(data.coupon_discount_cents) || 0) / 100,
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
// The payment overlay polls this every 5s, including for guest checkouts with
// no session, so it cannot simply require auth. But orders.id is a BIGSERIAL:
// leaving it as the only credential let anyone enumerate 1,2,3… and read the
// status, method, total and timestamps of every order ever placed.
//
// Three ways to read an order now, in order of preference:
//   ?ref=<public_ref>  — the unguessable handle returned only to the creator
//   a session that owns the order
//   an admin/staff session
// Anything else gets 404 — deliberately not 403, so a probe cannot use the
// status code to confirm that an id exists.
router.get('/:id', attachUser, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM orders WHERE id = $1 AND guild_id = $2',
      [req.params.id, GUILD_ID]
    );
    const data = rows[0];
    if (!data) return res.status(404).json({ error: 'Order not found' });

    const ref = req.query.ref ? String(req.query.ref) : '';
    const refMatches = !!data.public_ref && safeCompare(ref, data.public_ref);
    const isOwner = !!(req.user && data.web_user_id && String(req.user.id) === String(data.web_user_id));
    const isAdmin = !!(req.user && ['admin', 'staff'].includes(req.user.role));
    if (!refMatches && !isOwner && !isAdmin) {
      return res.status(404).json({ error: 'Order not found' });
    }

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
    const { order_id, email } = req.body;
    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
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
    const { order_id, amount_received, method, provider_txn_id } = req.body;

    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) {
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
