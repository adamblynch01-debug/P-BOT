const cron = require('node-cron');
const axios = require('axios');
const { query } = require('../db');
const { verifyCryptoPayment, receivedSinceBaseline } = require('../utils/cryptoUtils');
const { raiseAlert } = require('../utils/alerts');

const GUILD_ID = process.env.GUILD_ID;

function start() {
  if (!process.env.BLOCKCYPHER_TOKEN) {
    console.warn('[CryptoWatcher] No BlockCypher token — crypto polling disabled');
    return;
  }
  cron.schedule('*/2 * * * *', checkPendingCryptoOrders);
  console.log('[CryptoWatcher] Started — polling every 2 minutes');
}

async function checkPendingCryptoOrders() {
  try {
    // baseline_received comes along for the ride: what the address had already
    // received when it was issued, which is what makes "paid for this order"
    // distinguishable from "this address has a past".
    const { rows: orders } = await query(
      `SELECT o.*, ca.baseline_received
         FROM orders o
         LEFT JOIN crypto_addresses ca
           ON ca.guild_id = o.guild_id AND ca.address = o.crypto_address
        WHERE o.guild_id = $1 AND o.payment_method IN ('btc','ltc')
          AND o.status = 'waiting' AND o.expires_at > now()`,
      [GUILD_ID]
    );
    for (const order of orders) {
      if (!order.crypto_address) continue;
      await checkAddress(order);
    }
  } catch (err) {
    console.error('[CryptoWatcher] Poll error:', err.message);
  }
}

async function checkAddress(order) {
  try {
    const coin = order.payment_method;
    const chain = coin === 'btc' ? 'btc/main' : 'ltc/main';
    const token = process.env.BLOCKCYPHER_TOKEN;

    const res = await axios.get(
      `https://api.blockcypher.com/v1/${chain}/addrs/${order.crypto_address}/balance?token=${token}`
    );

    // Count only what arrived AFTER this address was issued. Reading
    // `res.data.balance` meant an address with a prior balance settled an order
    // instantly on the merchant's own coins, and a sweep before the next poll
    // hid a genuine payment. See receivedSinceBaseline.
    const delta = receivedSinceBaseline(res.data.total_received, order.baseline_received);
    if (!delta.ok) {
      console.warn(`[CryptoWatcher] Order ${order.id} not auto-confirmable: ${delta.reason}`);
      return;
    }
    const confirmed = delta.sats;
    if (confirmed <= 0) return;

    // Previously any balance > 0 confirmed the order, so a single satoshi paid
    // off a $500 invoice. Check the received amount against the quote locked at
    // order time; underpaid orders are flagged for manual review, never
    // delivered.
    const check = verifyCryptoPayment(order, confirmed);
    if (!check.ok) {
      console.warn(`[CryptoWatcher] Order ${order.id} NOT confirmed: ${check.reason}`);
      // `confirmed` is satoshis. Writing it into amount_received_cents claimed
      // 4,000,000 sats was $40,000.00 — the native figure goes in the native
      // column, and the USD conversion is left to whoever has the rate.
      await query(
        `UPDATE orders SET status = 'underpaid', amount_received_native = $1, amount_received_unit = 'sats'
          WHERE id = $2 AND status = 'waiting'`,
        [confirmed, order.id]
      ).catch(() => {});
      await raiseAlert('order_underpaid',
        `Order ${order.id} underpaid via ${coin.toUpperCase()}: ${check.reason}`,
        { severity: 'error', order_id: order.id, context: { received_sats: confirmed, reason: check.reason } }).catch(() => {});
      return;
    }

    // No provider_txn_id: the balance endpoint does not report which tx paid.
    // /confirm's conditional status transition is the idempotency guard, and
    // leaving the column null lets the webhook's real chain hash fill it in
    // later via COALESCE.
    await axios.post(`http://localhost:${process.env.PORT || 3000}/api/orders/confirm`, {
      secret: process.env.API_SECRET,
      order_id: order.id,
      amount_received: confirmed,
      method: coin,
    });
    console.log(`[CryptoWatcher] Order ${order.id} confirmed — ${confirmed} sats`);
  } catch (err) {
    console.error(`[CryptoWatcher] Address check error:`, err.message);
    await raiseAlert('crypto_poll_failed',
      `Could not check ${order.payment_method.toUpperCase()} address for order ${order.id}: ${err.message}`,
      { severity: 'warn', order_id: order.id, context: { address: order.crypto_address } }).catch(() => {});
  }
}

module.exports = { start };
