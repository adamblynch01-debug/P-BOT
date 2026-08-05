const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { generateNote } = require('../utils/noteGenerator');
const { generateCryptoAddress, registerWebhook, quoteCrypto } = require('../utils/cryptoUtils');
const { notifyBot } = require('../utils/botNotify');
const { invoiceNo, normalizeInvoiceNo } = require('../utils/invoiceNo');
const { attachUser, requireAuth, requireAdmin, requireDiscordLinked, botAuthorized, botAuthUnavailable } = require('../utils/auth');
const { safeCompare } = require('../utils/rateLimit');
// Shared with routes/auth.js, which creates the same kind of row when an OAuth
// consent names a snowflake we have never seen. Two writers of one account
// shape is how a customer ends up with two half-accounts.
const { ensureDiscordAccount } = require('../utils/discordAccount');
const {
  normalizeCode, previewCoupon, reserveCoupon, attachRedemptionOrder, releaseCoupon, publicView,
} = require('../utils/coupons');

const GUILD_ID = process.env.GUILD_ID;

// An order has two names and every route that takes an "order id" must accept
// both. Customers are given an INVOICE NUMBER ("YFTG-25ED"); orders.id is a
// BIGSERIAL. Feeding the first into `WHERE id = $1` is not a miss — Postgres
// raises "invalid input syntax for type bigint", the route's catch turns that
// into a 404, and the reply reads "Order not found" for an order that plainly
// exists. That is what `/order lookup order_id:YFTG-25ED` was hitting.
//
// Returns the column to match on, or null if the string is neither — which is
// a genuine "no such order" rather than a lookup that was never attempted.
function orderIdentifier(raw) {
  const invNo = normalizeInvoiceNo(raw);
  if (invNo) return { column: 'invoice_no', value: invNo };
  const s = String(raw == null ? '' : raw).trim();
  if (/^\d+$/.test(s)) return { column: 'id', value: s };
  return null;
}

// Per-line qty ceiling, so a crafted cart can't ask delivery to claim an
// unbounded number of keys in one order.
const MAX_ITEM_QTY = 25;

// How long an unpaid order stays live. This was a hardcoded 24 hours, and
// nothing ever swept the deadline — both watchers refuse to settle a payment
// past `expires_at`, so an order simply sat at 'waiting' forever, looking
// actionable in `/manual-order-delivery pending` while being unconfirmable by
// either watcher. One from July was still listed a fortnight later.
//
// One number could not serve every method, which is why there are now three.
// The deadline is not an arbitrary cutoff: it is the moment BOTH payment
// watchers stop settling this order (each filters `expires_at > now()`), so it
// has to be longer than the payment itself plausibly takes.
//
//   cashapp / paypal — 60 minutes. The transfer is instant and the customer is
//     sitting in front of the app; an hour is already generous for someone who
//     has to go and find their phone.
//
//   btc / ltc — 3 hours. A crypto payment is not instant and the customer does
//     not control how long it takes: the transaction has to be composed, the
//     fee guessed, then broadcast and mined, and a fee guessed low on a busy
//     mempool can leave it unconfirmed for an hour on its own. An hour here
//     meant a send started at minute fifty landed on a dead order — the money
//     is not lost (routes/webhooks.js records it as 'expired_paid' and pages
//     staff) but it needs a human, and it should not have needed one.
//
//   anything else — 60 minutes. 'balance' settles inside the checkout request
//     and never reaches 'waiting' at all, so this is really the default for a
//     method added later: short, and therefore safe, because a method whose
//     window is too short fails loudly on the pay screen while one that is too
//     long goes back to hanging silently.
//
// Longer is not free, which is why crypto is 3 hours and not a day. The coin
// amount on the pay screen is quoted at the rate when the order was placed, so
// the window is also how long the customer holds a free option on the price.
//
// The values themselves, and the reasoning for each, now live in
// utils/expiry.js — /api/config serves them to the Discord bot's payment panel,
// and a window quoted to a buyer must be the same one the sweeper enforces.
const { expiryMinutesFor } = require('../utils/expiry');

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
      // product_name and label are carried SEPARATELY as well as jammed into
      // `name`. items_snapshot is what every receipt renders from, and with only
      // the collapsed string a confirmation could not say which subscription
      // duration was bought without re-parsing "Ancient (Day)" back apart.
      // `name` stays for the callers (and stored orders) that already read it.
      out.push({
        id, qty,
        name: row.label ? `${row.product_name} (${row.label})` : row.product_name,
        product_name: row.product_name,
        tier_label: row.label || null,
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
    out.push({ id, qty, name: item.name || 'Item', product_name: item.name || 'Item', tier_label: null, price });
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
  //
  // invoice_no rides the same retry. It is the reference printed on receipts
  // and typed into /claim-customer, and uniq_orders_invoice_no makes a repeat
  // impossible rather than merely unlikely — a second customer holding the
  // first one's invoice number could claim against their order.
  let order = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const note = generateNote();
    const publicRef = crypto.randomBytes(16).toString('hex');
    const invNo = invoiceNo();
    try {
      const { rows } = await query(
        `INSERT INTO orders
           (guild_id, web_user_id, email, discord_id, items_snapshot, subtotal_cents, total_cents,
            payment_method, payment_note, public_ref, invoice_no, coupon_code, coupon_discount_cents,
            status, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'waiting', now(),
                 now() + ($14::int * interval '1 minute'))
         RETURNING *`,
        [
          GUILD_ID, web_user_id || null, email, discord_id || null, JSON.stringify(items),
          // subtotal_cents stays GROSS and the discount is stored beside it, so
          // a receipt can show the coupon line instead of an unexplained gap
          // between subtotal and total.
          subtotalCents, totalCents,
          payment_method, note, publicRef, invNo,
          coupon ? coupon.code : null, discountCents,
          // Resolved from the method, not a single global: crypto gets hours
          // because a crypto payment takes them. See expiryMinutesFor.
          expiryMinutesFor(payment_method),
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
  // product_name is the PRODUCT and tier_label is the duration, in their own
  // columns. This used to write the collapsed "Ancient (Day)" into product_name
  // and leave tier_label NULL, so the one table that exists specifically to
  // hold a per-line breakdown could not answer "which duration" without string
  // surgery — and every receipt built from it said nothing about the term or
  // the quantity bought.
  for (const item of items) {
    if (!/^\d+$/.test(String(item.id))) continue;
    await query(
      `INSERT INTO order_items (order_id, guild_id, tier_id, product_name, tier_label, unit_cents, qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [order.id, GUILD_ID, item.id,
       item.product_name || item.name || 'Item', item.tier_label || null,
       Math.round((item.price || 0) * 100), item.qty || 1]
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
// Anonymous checkout is gone, and so is checkout from an account with no
// verified Discord link — see requireDiscordLinked in utils/auth.js for why.
// The pair also closes a smaller hole this route had all along: `discord_id`
// arrived in the BODY, so an order could name any snowflake the buyer liked,
// and the delivery DM went to a stranger. It is now read from the session and
// the body field is ignored.
router.post('/create', requireAuth, requireDiscordLinked, async (req, res) => {
  try {
    const { items, email, payment_method, coupon_code } = req.body;

    if (!items || !Array.isArray(items) || !items.length || !payment_method) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (items.length > 50) return res.status(400).json({ error: 'Too many items' });

    const paidFromBalance = payment_method === 'balance';

    // Prices come from product_tiers, never from the request body. The
    // reseller discount likewise comes from the session's own web_users row,
    // so the client cannot ask for one it has not been granted.
    const repriced = await repriceItems(items, {
      paidFromBalance,
      discountPercent: req.user.reseller_discount || 0,
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

    if (!email && !req.user.email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { order, payment_info, total, fee_note, coupon, coupon_discount } = await createOrder({
      items: safeItems,
      email: email || req.user.email,
      discord_id: req.user.discord_id,
      payment_method,
      web_user_id: req.user.id,
      coupon_code,
      coupon_eligible_cents: repriced.catalogSubtotalCents || 0,
    });

    res.json({
      success: true,
      order_id: String(order.id),
      invoice_no: order.invoice_no || null,
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
// Keyed on web_user_id ALONE this missed every order the customer did not
// place while signed in — a staff hand-delivery through
// /manual-order-delivery writes a discord_id and can leave web_user_id null,
// and the buyer then had a delivered order that appeared in no list they could
// reach. Round 29 item 6: "So order can be looked up by user also".
//
// The second leg is safe because `discord_verified` is what it reads: that
// flag is only ever set by an OAuth consent on Discord's own domain or by a
// DM the member clicked, so an order carrying that snowflake is the same
// person by the same standard the claim uses. An UNVERIFIED discord_id is a
// number someone typed into a profile field, and would let anyone type their
// way into someone else's order history.
//
// guild_id is in the WHERE for the first time here. It is one store today, so
// this changes nothing now and is wrong to leave out the moment it is not.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const linked = (req.user.discord_id && req.user.discord_verified) ? String(req.user.discord_id) : null;
    const { rows } = await query(
      `SELECT * FROM orders
        WHERE guild_id = $1
          AND (web_user_id = $2 OR ($3::text IS NOT NULL AND discord_id = $3))
        ORDER BY created_at DESC`,
      [GUILD_ID, req.user.id, linked]
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
//
// This MUST match what /mine shows that same customer, and it did not. /mine
// finds an order two ways — by web_user_id, and by the account's verified
// discord_id — while this found it only the first way. An order delivered by
// `/order manual` to a Discord id that had no site account at the time carries
// a discord_id and a NULL web_user_id forever; the customer sees it the moment
// they sign up and link Discord, and staff looking at that same customer saw a
// shorter history and no sign that anything was missing. Answering "where is
// my order" from a list that is quietly incomplete is the worst version of
// this endpoint. Six of the thirty orders on this store are in exactly that
// shape.
router.get('/admin/user/:userId', requireAdmin, async (req, res) => {
  try {
    const { rows: [acct] } = await query(
      `SELECT discord_id, discord_verified FROM web_users WHERE guild_id = $1 AND id = $2`,
      [GUILD_ID, req.params.userId]
    );
    const linked = (acct && acct.discord_id && acct.discord_verified) ? String(acct.discord_id) : null;
    const { rows } = await query(
      `SELECT * FROM orders
        WHERE guild_id = $1
          AND (web_user_id = $2 OR ($3::text IS NOT NULL AND discord_id = $3))
        ORDER BY created_at DESC LIMIT 200`,
      [GUILD_ID, req.params.userId, linked]
    );
    res.json({ orders: rows.map(formatOrder) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user orders' });
  }
});

function formatOrder(data) {
  return {
    order_id: String(data.id),
    // What the customer is shown and what they type into /claim-customer.
    // Older rows predate the column; the migration backfills them, but a row
    // written between deploy and migration would be null, and printing "null"
    // on a receipt is worse than printing the internal id.
    invoice_no: data.invoice_no || null,
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
// ─── GET /api/orders/pending ────────────────────────────
// Every order still waiting on money, newest first. `/order forceconfirm`
// needs an id to confirm, and staff answering "I paid, where is my stuff?" in
// a ticket have no way to find one — the site shows a customer only their OWN
// orders, and the order-log channel is a firehose. This is the list.
//
// It MUST be declared above GET /:id. Express matches in registration order,
// so below it "pending" would be read as an order identifier, fail to parse as
// either an invoice number or a BIGSERIAL, and 404 — a route that exists,
// answering as though it does not.
router.get('/pending', async (req, res) => {
  try {
    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

    const limit = Math.max(1, Math.min(25, parseInt(req.query.limit, 10) || 15));
    const { rows } = await query(
      `SELECT id, invoice_no, email, discord_id, total_cents, payment_method, payment_note,
              status, source, created_at, expires_at, items_snapshot
         FROM orders
        WHERE guild_id = $1 AND status IN ('waiting','underpaid','needs_attention')
        ORDER BY created_at DESC
        LIMIT $2`,
      [GUILD_ID, limit]
    );
    res.json({
      orders: rows.map(o => {
        let items = o.items_snapshot;
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
        return {
          order_id: String(o.id),
          invoice_no: o.invoice_no,
          email: o.email,
          discord_id: o.discord_id,
          total: (o.total_cents || 0) / 100,
          payment_method: o.payment_method,
          payment_note: o.payment_note,
          status: o.status,
          source: o.source || 'website',
          created_at: o.created_at,
          expires_at: o.expires_at,
          summary: (Array.isArray(items) ? items : [])
            .map(i => `${i.qty || 1}× ${i.product_name || i.name || 'Item'}${i.tier_label ? ` (${i.tier_label})` : ''}`)
            .join(', ') || '—',
        };
      }),
    });
  } catch (err) {
    console.error('[Orders] pending error:', err);
    res.status(500).json({ error: 'Failed to list pending orders' });
  }
});

router.get('/:id', attachUser, async (req, res) => {
  try {
    const ident = orderIdentifier(req.params.id);
    if (!ident) return res.status(404).json({ error: 'Order not found' });

    const { rows } = await query(
      `SELECT * FROM orders WHERE ${ident.column} = $1 AND guild_id = $2`,
      [ident.value, GUILD_ID]
    );
    const data = rows[0];
    if (!data) return res.status(404).json({ error: 'Order not found' });

    const ref = req.query.ref ? String(req.query.ref) : '';
    const refMatches = !!data.public_ref && safeCompare(ref, data.public_ref);
    const isOwner = !!(req.user && data.web_user_id && String(req.user.id) === String(data.web_user_id));
    const isAdmin = !!(req.user && ['admin', 'staff'].includes(req.user.role));
    // …and the bot, which holds API_SECRET and has no session to present.
    // /order lookup is a STAFF command, but it ran as an anonymous request and
    // so fell through to the same 404 as a stranger enumerating ids — the
    // command could never have worked once this route was gated.
    const isBot = !botAuthUnavailable() && botAuthorized(req);
    if (!refMatches && !isOwner && !isAdmin && !isBot) {
      return res.status(404).json({ error: 'Order not found' });
    }
    // Whoever is asking, is it someone acting on the shop's behalf? A customer
    // holding the ref gets the receipt; staff and the bot get the operational
    // detail underneath it — who placed it, what was actually received, and
    // which payment it was matched to.
    const privileged = isAdmin || isBot;

    // The confirmation overlay polls this and then renders the receipt from
    // it. It used to get four scalars, so the "ORDER CONFIRMED" screen could
    // only list the collapsed item names it still had in the browser's cart —
    // no duration, no quantity, no unit price, no date. Everything below is
    // already the caller's own order: this route is gated on the ref, the
    // owning session, or staff.
    const payload = {
      order_id: String(data.id),
      invoice_no: data.invoice_no || null,
      status: data.status,
      payment_method: data.payment_method,
      items: data.items_snapshot,
      subtotal: data.subtotal_cents / 100,
      coupon_code: data.coupon_code || null,
      coupon_discount: (Number(data.coupon_discount_cents) || 0) / 100,
      total: data.total_cents / 100,
      delivered_goods: data.delivered_goods,
      created_at: data.created_at,
      paid_at: data.paid_at,
      delivered_at: data.delivered_at,
      expires_at: data.expires_at,
      delivered: data.status === 'delivered',
    };

    // Staff answering "what happened with my order" need the half of the row
    // the receipt deliberately leaves out: which account placed it, what was
    // actually received against what was owed, and which payment it was
    // matched to. Withheld from a ref-only caller, who is the customer and
    // already knows who they are.
    //
    // NOTE: this is where the email now lives. verify-claim still exists as a
    // separate secret-gated route because it answers a different question
    // (does THIS address match) without the caller having to be shown the
    // address at all.
    if (privileged) {
      payload.email = data.email || null;
      payload.discord_id = data.discord_id || null;
      payload.web_user_id = data.web_user_id != null ? String(data.web_user_id) : null;
      payload.fee = (Number(data.fee_cents) || 0) / 100;
      payload.paid_from_balance = !!data.paid_from_balance;
      payload.amount_received = data.amount_received_cents != null ? Number(data.amount_received_cents) / 100 : null;
      payload.amount_received_native = data.amount_received_native != null ? String(data.amount_received_native) : null;
      payload.amount_received_unit = data.amount_received_unit || null;
      payload.payment_note = data.payment_note || null;
      payload.crypto_address = data.crypto_address || null;
      payload.provider_txn_id = data.provider_txn_id || null;
      payload.external_ref = data.external_ref || null;
      payload.payment_info = data.payment_info || null;
    }

    res.json(payload);
  } catch (err) {
    res.status(404).json({ error: 'Order not found' });
  }
});

// Enough of an address for its owner to recognise it, not enough for anyone
// else to learn it: first and last character of the local part, full domain.
// A one-character local part keeps its single character rather than being
// padded out to look longer than it is.
function maskEmail(e) {
  const s = String(e == null ? '' : e).trim();
  const at = s.lastIndexOf('@');
  if (at < 1) return null;
  const local = s.slice(0, at), domain = s.slice(at + 1);
  const head = local[0];
  const tail = local.length > 1 ? local[local.length - 1] : '';
  return `${head}***${tail}@${domain}`;
}

// ─── Who is allowed to claim an order ───────────────────
// One function, because two routes now ask: /verify-claim, which only answers,
// and /claim, which answers and then WRITES. A second copy of this rule would
// mean the thing that grants the role and the thing that hands over the order
// history could drift apart, and the one that drifted would be the one nobody
// tested.
//
// Three independent proofs, any one of which is enough:
//
//   discord   the order names this exact Discord account. The strongest of the
//             three — checkout writes it from a verified link and staff write
//             it when hand-delivering — and the ONLY one available for an order
//             with no address on it at all.
//   email     the claimer typed an address belonging to this buyer.
//   account   the order already belongs to the site account this Discord user
//             signs into.
//
// An order with no email, no discord_id and no web_user_id is claimable by
// NOBODY, deliberately. The invoice number alone must never be sufficient:
// invoice numbers get screenshotted into tickets and pasted into chats, and
// treating one as a credential would hand the order to whoever saw it.
async function resolveClaim({ order_id, email, discord_id }) {
  // Customers are given an invoice number, not the internal id, so that is
  // what they will type. The numeric id still works: every order placed before
  // invoice numbers existed was confirmed with one, and those receipts are
  // already in people's inboxes.
  const ident = orderIdentifier(order_id);
  if (!ident) return { notFound: true };

  const { rows } = await query(
    `SELECT id, invoice_no, status, email, discord_id, web_user_id
       FROM orders WHERE ${ident.column} = $1 AND guild_id = $2`,
    [ident.value, GUILD_ID]
  );
  const order = rows[0];
  if (!order) return { notFound: true };

  // Every address that belongs to this buyer, not just the one captured at
  // checkout.
  //
  // This used to be a single comparison against orders.email, which is
  // narrower than the truth. A customer with two addresses — a personal one
  // used on some orders, the account one on others — types the wrong half of
  // their own history and gets told their own invoice is not theirs, with no
  // hint as to which address the order actually carries. It is the same
  // person either way, so the account behind the order and every other order
  // that same account (or the same Discord user) has placed all count.
  //
  // A guest checkout has neither a web_user_id nor a discord_id, and falls
  // back to exactly the old behaviour: the order's own address.
  const norm = s => String(s == null ? '' : s).trim().toLowerCase();
  const known = new Set();
  if (order.email) known.add(norm(order.email));
  if (order.web_user_id) {
    const { rows: acct } = await query(
      'SELECT email FROM web_users WHERE id = $1 AND guild_id = $2',
      [order.web_user_id, GUILD_ID]
    );
    if (acct[0] && acct[0].email) known.add(norm(acct[0].email));
  }
  if (order.web_user_id || order.discord_id) {
    // `= NULL` is NULL rather than true, so a null side never widens this.
    const { rows: siblings } = await query(
      `SELECT DISTINCT email FROM orders
        WHERE guild_id = $1 AND email IS NOT NULL
          AND (web_user_id = $2 OR discord_id = $3)`,
      [GUILD_ID, order.web_user_id || null, order.discord_id || null]
    );
    for (const s of siblings) if (s.email) known.add(norm(s.email));
  }
  known.delete('');

  const claimer = String(discord_id || '').trim() || null;
  const emailMatch = !!email && known.has(norm(email));
  const ownsByDiscord = !!claimer && !!order.discord_id && String(order.discord_id) === claimer;

  // The third proof needs a lookup of its own: the claimer may already hold a
  // site account, and the order may already be attached to it, without either
  // carrying the other's identifier directly.
  let ownsByAccount = false;
  if (claimer && order.web_user_id) {
    const { rows: mine } = await query(
      `SELECT id FROM web_users
        WHERE guild_id = $1 AND discord_id = $2 AND discord_verified = true`,
      [GUILD_ID, claimer]
    );
    ownsByAccount = !!mine[0] && String(mine[0].id) === String(order.web_user_id);
  }

  return {
    order,
    emailMatch,
    ownsByDiscord,
    ownsByAccount,
    proven: emailMatch || ownsByDiscord || ownsByAccount,
    paid: ['paid', 'delivered'].includes(order.status),
    // Which proof carried it, for the reply the customer reads. Ordered
    // strongest first so "Discord account on the order" wins the label when
    // both happen to hold.
    via: ownsByDiscord ? 'discord' : ownsByAccount ? 'account' : emailMatch ? 'email' : null,
    // Whether this order carries an address at all decides what the failure
    // message should say — "that email does not match" is nonsense advice for
    // an order that has no email to match against.
    hasEmail: !!order.email,
  };
}

// ─── POST /api/orders/verify-claim ──────────────────────
// Secret-gated: the read-only half. Answers "does this prove ownership" without
// the caller needing to be shown the address at all — which is why it is kept
// separate from GET /:id, which does hand the address to staff and to the bot.
//
// `email` is no longer required. An order hand-delivered through
// /manual-order-delivery can have no address on it, and demanding one meant the
// buyer had nothing to type and their own paid order was unclaimable — the
// Discord proof below was already accepted, the form just never let anyone
// reach it. Round 29 item 6.
router.post('/verify-claim', async (req, res) => {
  try {
    const { order_id, email, discord_id } = req.body;
    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (!order_id) return res.status(400).json({ error: 'order_id is required' });
    if (!email && !discord_id) {
      return res.status(400).json({ error: 'order_id needs an email or a discord_id to check against' });
    }

    const c = await resolveClaim({ order_id, email, discord_id });
    if (c.notFound) return res.status(404).json({ error: 'Order not found' });

    res.json({
      order_id: String(c.order.id),
      invoice_no: c.order.invoice_no || null,
      status: c.order.status,
      email_match: c.emailMatch,
      owns_by_discord: c.ownsByDiscord,
      owns_by_account: c.ownsByAccount,
      eligible: c.proven && c.paid,
      proven: c.proven,
      via: c.via,
      paid: c.paid,
      has_email: c.hasEmail,
      discord_id: c.order.discord_id || null,
      // Masked, so a failed attempt can say WHICH address is expected without
      // handing the address itself to whoever typed the invoice number.
      email_hint: maskEmail(c.order.email),
    });
  } catch (err) {
    console.error('[Orders] verify-claim error:', err);
    res.status(500).json({ error: 'Failed to verify claim' });
  }
});

// ─── POST /api/orders/claim ─────────────────────────────
// Secret-gated. Verify-claim's writing counterpart, and the whole of round 29
// item 6: "If user has not made an account and no email found. Have it register
// with their discord account then. So they can redeem. So order can be looked up
// by user also!!"
//
// Granting the Customer role was all a claim ever did. The order stayed exactly
// as it was — web_user_id null — so it appeared in no list the buyer could
// reach, and a buyer with no site account had nothing for it to appear in. This
// route closes both:
//
//   1. proves ownership (resolveClaim, above — unchanged rules)
//   2. finds or CREATES the claimer's site account from their Discord identity
//   3. attaches the order, and the rest of their unowned history with it
//
// The role itself is still the bot's to grant; this route touches no Discord
// state and the bot calls it before adding the role, so a failure here never
// leaves a member holding a role for an order that was not attached.
router.post('/claim', async (req, res) => {
  try {
    const { order_id, email, discord_id, discord_username, discord_avatar } = req.body;
    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (!order_id) return res.status(400).json({ error: 'order_id is required' });
    // Unlike verify-claim, this one cannot run without knowing WHO is claiming:
    // there is no account to attach anything to otherwise.
    if (!discord_id) return res.status(400).json({ error: 'discord_id is required' });

    const c = await resolveClaim({ order_id, email, discord_id });
    if (c.notFound) return res.status(404).json({ error: 'Order not found' });

    // Refused before anything is created. An account conjured for a claim that
    // then fails is an orphan the customer never asked for.
    if (!c.proven || !c.paid) {
      return res.json({
        success: false,
        proven: c.proven,
        paid: c.paid,
        status: c.order.status,
        has_email: c.hasEmail,
        invoice_no: c.order.invoice_no || null,
        email_hint: maskEmail(c.order.email),
      });
    }

    const { user, created } = await ensureDiscordAccount({
      discordId: discord_id,
      username: discord_username,
      avatarHash: discord_avatar,
    });

    // `web_user_id IS NULL` on every attach: an order that already belongs to
    // an account is not moved. Two people who can both prove a claim — a
    // shared address, a resold invoice — must not be able to take an order off
    // each other, and staff reassigning an owner must not be silently undone
    // by the next claim.
    const { rows: mine } = await query(
      `UPDATE orders SET web_user_id = $1, discord_id = COALESCE(discord_id, $2)
        WHERE id = $3 AND guild_id = $4 AND web_user_id IS NULL
        RETURNING id`,
      [user.id, String(discord_id), c.order.id, GUILD_ID]
    );

    // The sweep, and the reason a claim is worth making once rather than once
    // per invoice: everything else this Discord account bought and never had
    // attached comes across too.
    //
    // Keyed on discord_id ONLY, never on the typed address. The bot checked
    // that this snowflake is the member standing in front of it, so it is
    // proof of an account the claimer controls; a typed address is proof of a
    // string they know, and sweeping on it would let anyone holding one
    // invoice-and-email pair collect a stranger's whole history.
    const { rows: swept } = await query(
      `UPDATE orders SET web_user_id = $1
        WHERE guild_id = $2 AND web_user_id IS NULL AND discord_id = $3
        RETURNING id`,
      [user.id, GUILD_ID, String(discord_id)]
    );

    const attached = new Set([...mine, ...swept].map(r => String(r.id)));
    console.log(`[Orders] claim ${c.order.invoice_no || c.order.id} by ${discord_id} via ${c.via}`
      + ` → account ${user.username}${created ? ' (created)' : ''}, ${attached.size} order(s) attached`);

    res.json({
      success: true,
      proven: true,
      paid: true,
      via: c.via,
      invoice_no: c.order.invoice_no || null,
      status: c.order.status,
      account_created: created,
      username: user.username,
      has_email: !!user.email,
      orders_attached: attached.size,
      // False when the order already belonged to someone — the role is still
      // owed (ownership was proven), but nothing moved, and a reply that
      // claimed otherwise would be a lie the customer could check.
      order_attached: mine.length > 0,
    });
  } catch (err) {
    console.error('[Orders] claim error:', err);
    res.status(500).json({ error: 'Failed to claim order' });
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

    // Same two names as everywhere else: staff force-confirming from Discord
    // types whatever they just looked the order up by, and that is now an
    // invoice number more often than not.
    const ident = orderIdentifier(order_id);
    if (!ident) return res.status(404).json({ error: 'Order not found' });

    const { rows } = await query(`SELECT * FROM orders WHERE ${ident.column} = $1`, [ident.value]);
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
    // 'paid' and 'delivered' are the two that must never be re-settled — that
    // is the double-delivery this gate exists for, and they stay excluded.
    //
    // 'expired' IS confirmable, and has to be. Unpaid orders are now closed an
    // hour after they are placed (watchers/orderExpiry.js), and the customer
    // who pays at minute seventy is a real person whose money has arrived.
    // Refusing here would answer them with "Not confirmable" and leave staff
    // nothing to do about it. Neither watcher can reach this branch — both scan
    // `status = 'waiting'` — so in practice it is staff, holding the shared
    // secret, deciding a late payment is good.
    //
    // 'cancelled' stays out, and the distinction is the point. The sweeper
    // writes 'expired'; the only thing that writes 'cancelled' is a balance
    // checkout that FAILED and had its debit rolled back (see the catch in
    // createOrder). Confirming one of those would deliver the goods against a
    // wallet that was never charged. Two different closed states because they
    // mean two different things.
    const { rows: claimed } = await query(
      `UPDATE orders
          SET status = 'paid', paid_at = now(),
              amount_received_cents = $1, amount_received_native = $2, amount_received_unit = $3,
              provider_txn_id = COALESCE($4, provider_txn_id)
        WHERE id = $5 AND status IN ('waiting', 'underpaid', 'expired')
        RETURNING *`,
      // The row is already in hand, so settle on its numeric id — the caller's
      // spelling of the identifier does not need interpreting twice.
      [cents, amount_received != null ? amount_received : null, unit, provider_txn_id || null, order.id]
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

// ─── POST /api/orders/manual ────────────────────────────
// An order that never went through checkout: a key handed over in a ticket, an
// off-platform payment settled by hand, a replacement for a burned account.
//
// Until now those left NO record at all. Staff DM'd the key and that was the
// end of it — so `/order lookup` could not find it, `/claim-customer` had no
// invoice to verify against (the buyer could not get the customer role for
// something they had genuinely paid for), and the order log showed a quiet day.
// The bot's own /genkey path has the same shape and the same gap.
//
// This route writes the same row the storefront writes, differing only in
// `source = 'manual'`, so every reader downstream — lookup, claim, the site's
// order list, the receipt email — works on it without knowing it was manual.
//
// Two ways to source what is delivered, and NEITHER is optional-by-omission:
//   • `keys[]`     — staff typed the values. Nothing is taken from inventory.
//   • `from_stock` — claim `qty` values from product_stock for this tier, with
//                    the same FOR UPDATE SKIP LOCKED claim the paid path uses,
//                    so a manual delivery and a real checkout cannot hand out
//                    the same key.
// A "delivered" order with nothing in it is a lie the rest of the system would
// then repeat, so one of the two is required.
router.post('/manual', async (req, res) => {
  try {
    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

    const {
      tier_id, product_name, game_name, tier_label, unit_cents,
      qty, keys, from_stock, discord_id, email, staff_id, note, notify,
    } = req.body || {};

    const count = Math.max(1, Math.min(MAX_ITEM_QTY, parseInt(qty, 10) || 1));
    const typed = Array.isArray(keys)
      ? keys.map(k => String(k == null ? '' : k).trim()).filter(Boolean)
      : String(keys || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    if (!typed.length && !from_stock) {
      return res.status(400).json({ error: 'Nothing to deliver — send keys[] or set from_stock' });
    }

    // The tier is what gives the order a real product name, a price and a
    // link back into the catalog. It is optional so a one-off ("custom build",
    // "replacement") can still be recorded, but then the caller must name it.
    let tier = null;
    if (tier_id != null && /^\d+$/.test(String(tier_id))) {
      // game_name resolves the same way as the paid path in utils/delivery.js:
      // the tile's display_name if the game has one, else the raw grouping key.
      // Both DMs come out of the same lineLabel() in the bot, so if these two
      // queries disagree the buyer sees a different game depending on whether
      // staff or the checkout delivered the order.
      const { rows } = await query(
        `SELECT t.*, p.name AS product_name,
                COALESCE(NULLIF(gt.display_name, ''), p.game_name) AS game_name
           FROM product_tiers t
           JOIN products p ON p.id = t.product_id
           LEFT JOIN game_tiles gt
                  ON gt.game_name = p.game_name AND gt.guild_id = t.guild_id
          WHERE t.id = $1 AND t.guild_id = $2`,
        [String(tier_id), GUILD_ID]
      );
      tier = rows[0] || null;
      if (!tier) return res.status(404).json({ error: `No product tier ${tier_id}` });
    }

    const pName = String(product_name || (tier && tier.product_name) || '').trim();
    if (!pName) return res.status(400).json({ error: 'product_name is required when no tier_id is given' });
    const label = String(tier_label || (tier && tier.label) || '').trim() || null;
    // A one-off with no tier has no game, and inventing one would be worse
    // than the line simply reading "PRODUCT — DURATION" the way it always did.
    const gName = String(game_name || (tier && tier.game_name) || '').trim() || null;

    // Price: what staff said, else the tier's list price, else free. A manual
    // delivery is often a comp or a replacement, so 0 is a legitimate answer
    // and is recorded as 0 rather than silently borrowing the list price.
    const unit = unit_cents != null && Number.isFinite(Number(unit_cents))
      ? Math.max(0, Math.round(Number(unit_cents)))
      : (tier ? Math.round(Number(tier.price_cents ?? (Number(tier.price) || 0) * 100) || 0) : 0);
    const totalCents = unit * count;

    // Claim real inventory only when asked. Done BEFORE the order row exists,
    // so `order_id` is stamped in a second pass — the alternative (insert the
    // order, then claim) leaves a delivered order holding OUT_OF_STOCK, which
    // is the exact failure delivery.js has to raise alerts about.
    let values = typed;
    if (from_stock) {
      if (!tier) return res.status(400).json({ error: 'from_stock needs a tier_id' });
      const claimed = [];
      for (let i = 0; i < count; i++) {
        const { rows } = await query(
          `UPDATE product_stock SET used = true, used_at = now()
            WHERE id = (
              SELECT id FROM product_stock
               WHERE guild_id = $1 AND tier_id = $2 AND used = false
               ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            RETURNING id, value`,
          [GUILD_ID, tier.id]
        );
        if (!rows.length) break;
        claimed.push(rows[0]);
      }
      if (claimed.length < count) {
        // Put back what we took. Half a delivery is worse than none: the
        // customer gets fewer keys than the embed promises and the stock is
        // gone either way.
        for (const c of claimed) {
          await query(`UPDATE product_stock SET used = false, used_at = NULL WHERE id = $1`, [c.id]).catch(() => {});
        }
        return res.status(409).json({ error: `Only ${claimed.length} of ${count} in stock for ${pName}${label ? ` (${label})` : ''}` });
      }
      values = claimed.map(c => c.value);
      req._claimedStockIds = claimed.map(c => c.id);
    }

    // Tie the order to the website account behind this Discord user when there
    // is one, so it appears in their ORDERS list on the site rather than only
    // in a DM they may lose. Unverified links are ignored — a verified link is
    // the only one that proves the account and the snowflake are the same
    // person.
    let webUserId = null;
    let acctEmail = null;
    if (discord_id) {
      const { rows } = await query(
        `SELECT id, email FROM web_users WHERE guild_id = $1 AND discord_id = $2 AND discord_verified = true LIMIT 1`,
        [GUILD_ID, String(discord_id)]
      );
      if (rows[0]) { webUserId = rows[0].id; acctEmail = rows[0].email || null; }
    }
    // Second try: the address staff typed on the order. A customer who has an
    // account but has not linked Discord — or linked it and never finished the
    // verification — resolved to nothing above, so the order was written with
    // web_user_id NULL and never appeared in their Purchase History. Nothing
    // told anyone: staff saw a delivered order, the customer saw an empty page,
    // and the two had no way to discover they were looking at the same order.
    //
    // The address is not user input here. Staff type it when they issue the
    // delivery, and the store already treats it as proof of ownership —
    // /claim-customer verifies an invoice against exactly this field. Matching
    // it is the same test, applied earlier.
    if (!webUserId && String(email || '').trim()) {
      const { rows } = await query(
        `SELECT id, email FROM web_users WHERE guild_id = $1 AND lower(email) = lower($2) LIMIT 1`,
        [GUILD_ID, String(email).trim()]
      );
      if (rows[0]) { webUserId = rows[0].id; acctEmail = acctEmail || rows[0].email || null; }
    }
    // /claim-customer verifies an invoice against the buyer's email, so an
    // order with no address on it can never be claimed. Falling back to the
    // linked account's address makes the claim work without staff having to
    // know it.
    const buyerEmail = String(email || '').trim() || acctEmail || null;

    const itemsSnapshot = [{
      id: tier ? String(tier.id) : 'manual',
      name: pName, product_name: pName, tier_label: label,
      price: unit / 100, qty: count,
    }];
    const deliveredGoods = [{
      product: pName, game: gName, items: values,
      tier_label: label, qty: count, unit_price: unit / 100,
    }];

    // Same 5-attempt retry as checkout: invoice_no carries a UNIQUE index and
    // the whole point of this order is that the number can be looked up later.
    let order = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const invNo = invoiceNo();
      try {
        const { rows } = await query(
          `INSERT INTO orders
             (guild_id, web_user_id, email, discord_id, items_snapshot, subtotal_cents, total_cents,
              payment_method, public_ref, invoice_no, source, status, external_ref,
              created_at, paid_at, delivered_at, delivered_goods,
              amount_received_cents, amount_received_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,'manual','delivered',$10,
                   now(), now(), now(), $11, $6, 'usd')
           RETURNING *`,
          [
            GUILD_ID, webUserId, buyerEmail, discord_id ? String(discord_id) : null,
            JSON.stringify(itemsSnapshot), totalCents, totalCents,
            crypto.randomBytes(16).toString('hex'), invNo,
            // external_ref is the row's only free-text field and nothing else
            // writes it. It is returned by GET /:id to staff and the bot only,
            // never to a customer holding the public ref — which is the right
            // audience for "who did this and why".
            [staff_id ? `staff:${staff_id}` : null, note ? String(note) : null]
              .filter(Boolean).join(' — ').slice(0, 500) || null,
            JSON.stringify(deliveredGoods),
          ]
        );
        order = rows[0];
        break;
      } catch (err) {
        if (err && err.code === '23505') { lastErr = err; continue; }
        throw err;
      }
    }
    if (!order) {
      // The keys are already claimed at this point — hand them back rather
      // than burning stock on an order that does not exist.
      for (const id of req._claimedStockIds || []) {
        await query(`UPDATE product_stock SET used = false, used_at = NULL WHERE id = $1`, [id]).catch(() => {});
      }
      console.error('[Orders] manual: exhausted invoice retries:', lastErr && lastErr.message);
      return res.status(500).json({ error: 'Could not allocate an invoice number' });
    }

    for (const id of req._claimedStockIds || []) {
      await query(`UPDATE product_stock SET order_id = $1 WHERE id = $2`, [order.id, id]).catch(() => {});
    }

    // One line, qty N — the same shape checkout writes.
    //
    // NOT one row per value with the value in `delivered_key`: that column is a
    // FOREIGN KEY to keys(key), the licence-key table, so it can only ever hold
    // a key the bot itself minted. A value typed by staff or drawn from
    // product_stock is not in `keys` and the insert is rejected outright. The
    // delivered values live in orders.delivered_goods, which is what the DM,
    // the receipt email and the site's order screen all read anyway.
    await query(
      `INSERT INTO order_items (order_id, guild_id, tier_id, product_name, tier_label, unit_cents, qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [order.id, GUILD_ID, tier ? tier.id : null, pName, label, unit, count]
    ).catch((e) => console.warn('[Orders] manual: order_items line not written:', e.message));

    console.log(`[Orders] MANUAL order ${order.id} (${order.invoice_no}) — ${pName}${label ? ` / ${label}` : ''} ×${count} by staff ${staff_id || 'unknown'}`);

    // The bot owns the DM and the channel posts. `notify: false` lets the
    // caller send its own (the /manual-order-delivery command builds a richer
    // embed and would otherwise deliver twice).
    if (notify !== false) {
      notifyBot('deliver_goods', {
        order_id: order.id,
        invoice_no: order.invoice_no,
        email: order.email,
        discord_id: order.discord_id,
        goods: deliveredGoods,
        source: 'manual',
      }).catch(() => {});
    }

    res.json({
      success: true,
      order_id: String(order.id),
      invoice_no: order.invoice_no,
      product_name: pName,
      // The caller (/manual-order-delivery, which passes notify:false and
      // builds its own embed) has to be able to title the DM the same way
      // lineLabel() does, or a hand-delivered order reads differently from
      // one bought on the site.
      game_name: gName,
      tier_label: label,
      qty: count,
      values,
      total_cents: totalCents,
      email: order.email,
      web_user_id: webUserId,
      claimed_from_stock: !!from_stock,
    });
  } catch (err) {
    console.error('[Orders] manual error:', err);
    res.status(500).json({ error: err.message || 'Failed to record the manual order' });
  }
});

module.exports = router;
module.exports.createOrder = createOrder;
module.exports.formatOrder = formatOrder;
module.exports.__test__ = { applyFee, nativeToUsdCents, repriceItems, expiryMinutesFor };
