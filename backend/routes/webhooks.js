const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query } = require('../db');
const { verifyCryptoPayment } = require('../utils/cryptoUtils');

const GUILD_ID = process.env.GUILD_ID;

// POST /api/webhooks/crypto
// BlockCypher calls this when a watched address receives payment.
//
// This endpoint hands the caller the server's own API_SECRET when it confirms
// an order, so anything it trusts is effectively an authentication bypass. It
// previously trusted (a) that the caller was BlockCypher, (b) the order id, and
// (c) that any payment at all meant the order was paid — none of which were
// checked. A forged POST could mark any order paid, and since a balance top-up
// is just an order whose amount the user picks, that minted unlimited credit.
//
// Now: the caller must know WEBHOOK_SECRET, the order is resolved from the
// on-chain address (never from caller-supplied data), and the amount must
// actually cover the locked quote.
router.post('/crypto', async (req, res) => {
  try {
    // 1. Authenticate. BlockCypher doesn't sign callbacks, so an unguessable
    //    URL token is the available mechanism. Fail closed if unset — an empty
    //    env var must never mean "allow anyone".
    const expectedToken = process.env.WEBHOOK_SECRET;
    if (!expectedToken) {
      console.error('[Webhook] WEBHOOK_SECRET not set — rejecting crypto webhook');
      return res.sendStatus(404);
    }
    const presented = req.query.token || req.get('X-Webhook-Token') || '';
    if (presented !== expectedToken) {
      console.warn('[Webhook] Rejected crypto webhook with bad/missing token');
      return res.sendStatus(404);
    }

    const payload = req.body || {};

    // 2. Require confirmations before crediting anything.
    const confirmations = payload.confirmations || 0;
    if (confirmations < 1) {
      console.log(`[Webhook] TX has ${confirmations} confirmations, waiting...`);
      return res.sendStatus(200);
    }

    // 3. Resolve the order from the chain, NOT from the caller. The old code
    //    read the order id out of payload.user_data, so whoever called it chose
    //    which order got paid. Addresses are derived one-per-order, so the
    //    address that received funds identifies the order on its own.
    const outputs = Array.isArray(payload.outputs) ? payload.outputs : [];
    const paidAddresses = [...new Set(outputs.flatMap(o => o.addresses || []))];
    if (!paidAddresses.length) {
      console.warn('[Webhook] No output addresses in payload');
      return res.sendStatus(200);
    }

    const { rows: addrRows } = await query(
      `SELECT order_id, address FROM crypto_addresses
       WHERE guild_id = $1 AND address = ANY($2::text[])`,
      [GUILD_ID, paidAddresses]
    );
    if (!addrRows.length) {
      console.warn('[Webhook] Payment to an address we do not own — ignoring');
      return res.sendStatus(200);
    }
    const { order_id, address: ourAddress } = addrRows[0];

    // 4. Count only what was paid TO US. Summing every output credited the
    //    sender's own change back to the order, so a large change output could
    //    cover a tiny real payment.
    const receivedSats = outputs
      .filter(o => (o.addresses || []).includes(ourAddress))
      .reduce((sum, o) => sum + (o.value || 0), 0);

    const { rows: orderRows } = await query(
      'SELECT * FROM orders WHERE id = $1 AND guild_id = $2',
      [order_id, GUILD_ID]
    );
    const order = orderRows[0];
    if (!order) return res.sendStatus(200);
    if (order.status === 'paid' || order.status === 'delivered') return res.sendStatus(200);

    // 5. Verify the amount covers the locked quote. Fails closed when the order
    //    has no quote, leaving it for manual review rather than free delivery.
    const check = verifyCryptoPayment(order, receivedSats);
    if (!check.ok) {
      console.warn(`[Webhook] Order ${order_id} NOT confirmed: ${check.reason}`);
      await query(
        `UPDATE orders SET status = 'underpaid', amount_received_cents = $1 WHERE id = $2 AND status = 'waiting'`,
        [receivedSats, order_id]
      ).catch(() => {});
      return res.sendStatus(200);
    }

    await axios.post(`http://localhost:${process.env.PORT || 3000}/api/orders/confirm`, {
      secret: process.env.API_SECRET,
      order_id,
      amount_received: receivedSats,
      method: order.payment_method,
    });
    console.log(`[Webhook] Order ${order_id} confirmed — ${receivedSats} sats`);

    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook] Crypto error:', err);
    res.sendStatus(200); // Always 200 to BlockCypher so it stops retrying
  }
});

module.exports = router;
