const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query } = require('../db');
const { verifyCryptoPayment, fetchTotalReceived, receivedSinceBaseline } = require('../utils/cryptoUtils');
const { raiseAlert } = require('../utils/alerts');

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
      `SELECT ca.order_id, ca.address, ca.baseline_received
         FROM crypto_addresses ca
        WHERE ca.guild_id = $1 AND ca.address = ANY($2::text[])`,
      [GUILD_ID, paidAddresses]
    );
    if (!addrRows.length) {
      console.warn('[Webhook] Payment to an address we do not own — ignoring');
      return res.sendStatus(200);
    }
    // One transaction can pay more than one of our addresses (an exchange
    // batching two withdrawals, or a buyer settling two invoices from one
    // wallet). Only addrRows[0] was ever considered, so the second order's
    // funds arrived with no confirmation and no alert.
    if (addrRows.length > 1) {
      await raiseAlert('crypto_multi_address_tx',
        `One transaction paid ${addrRows.length} of our addresses — only the first is auto-processed, review the rest`,
        { severity: 'error', context: { orders: addrRows.map(r => String(r.order_id)) } }).catch(() => {});
    }
    const { order_id, address: ourAddress, baseline_received: baseline } = addrRows[0];

    // 4. Count what has been paid TO US in TOTAL, not just in this payload.
    //
    //    Summing this transaction's outputs alone meant a payment split across
    //    two transactions never settled: each one fell short of the quote on
    //    its own, and a customer topping up after an "underpaid" message stayed
    //    stuck forever with the full amount on-chain. Re-reading the address's
    //    cumulative total (minus whatever was there before we issued it) is the
    //    same figure the poller uses, so both paths now agree.
    let receivedSats = outputs
      .filter(o => (o.addresses || []).includes(ourAddress))
      .reduce((sum, o) => sum + (o.value || 0), 0);
    try {
      const total = await fetchTotalReceived(payload.coin || (payload.chain === 'litecoin' ? 'ltc' : 'btc'), ourAddress);
      const cumulative = receivedSinceBaseline(total, baseline);
      // Fails closed: on a bad read, fall back to this payload's own figure
      // rather than confirming on a number we do not trust.
      if (cumulative.ok && cumulative.sats >= receivedSats) receivedSats = cumulative.sats;
      else if (!cumulative.ok) console.warn(`[Webhook] cumulative read unusable (${cumulative.reason}) — using payload amount`);
    } catch (e) {
      console.warn('[Webhook] Could not re-read address total, using payload amount:', e.message);
    }

    const { rows: orderRows } = await query(
      'SELECT * FROM orders WHERE id = $1 AND guild_id = $2',
      [order_id, GUILD_ID]
    );
    const order = orderRows[0];
    if (!order) return res.sendStatus(200);
    if (order.status === 'paid' || order.status === 'delivered') {
      // Coins arrived at an address whose order is already settled. That money
      // is real and nobody was being told about it.
      await raiseAlert('crypto_payment_after_settlement',
        `Received ${receivedSats} sats at ${ourAddress} for order ${order_id}, which is already ${order.status}`,
        { severity: 'error', order_id, context: { address: ourAddress, received_sats: receivedSats } }).catch(() => {});
      return res.sendStatus(200);
    }

    // 4b. Enforce the order's own deadline. The poller already did
    //     (`expires_at > now()`), but BlockCypher hooks outlive the order, so a
    //     payment days later still settled at a quote locked long ago — a free
    //     option on the coin price. Late money is kept and flagged, not
    //     auto-delivered.
    if (order.expires_at && new Date(order.expires_at) < new Date()) {
      console.warn(`[Webhook] Order ${order_id} paid after expiry — manual review`);
      // 'expired' is in this list because that is now the status the order is
      // MOST likely to be in when we get here. This branch fires precisely
      // when `expires_at` has passed, and watchers/orderExpiry.js moves an
      // unpaid order off 'waiting' within a couple of minutes of that instant
      // — so the old two-status list matched no row in the common case, and
      // the sats that just arrived were never written down. The alert below
      // still fired, which is how it would have been noticed eventually, but
      // an alert is not a record: staff would have had nothing on the order
      // itself to reconcile against.
      //
      // 'paid'/'delivered' are handled and returned above; 'expired_paid'
      // stays out so a second webhook for the same address cannot overwrite a
      // recorded amount with a partial one.
      await query(
        `UPDATE orders SET status = 'expired_paid', amount_received_native = $1, amount_received_unit = 'sats'
          WHERE id = $2 AND status IN ('waiting','underpaid','expired')`,
        [receivedSats, order_id]
      ).catch(() => {});
      await raiseAlert('crypto_payment_after_expiry',
        `Order ${order_id} received ${receivedSats} sats after it expired (${order.expires_at}) — quote is stale, review before delivering`,
        { severity: 'error', order_id, context: { address: ourAddress, received_sats: receivedSats } }).catch(() => {});
      return res.sendStatus(200);
    }

    // 4c. Was this address recently handed to a DIFFERENT order?
    //     Recycling rebinds an expired order's address to a new customer. If
    //     the ORIGINAL customer then finally pays, the funds resolve to the new
    //     order — and if they cover its quote, the new customer is delivered
    //     for free while the person who actually paid gets nothing. A
    //     settlement that lands soon after a handover is therefore not
    //     auto-confirmable; a human has to attribute it.
    try {
      const { rows: hist } = await query(
        `SELECT order_id, assigned_at FROM crypto_address_assignments
          WHERE guild_id = $1 AND address = $2
          ORDER BY assigned_at DESC LIMIT 1`,
        [GUILD_ID, ourAddress]
      );
      const h = hist[0];
      if (h && String(h.order_id) === String(order_id)) {
        const heldForMs = Date.now() - new Date(h.assigned_at).getTime();
        const RECYCLE_SUSPICION_MS = 48 * 60 * 60 * 1000;
        if (heldForMs < RECYCLE_SUSPICION_MS) {
          console.warn(`[Webhook] Order ${order_id} paid on a recently recycled address — holding for review`);
          await query(
            `UPDATE orders SET amount_received_native = $1, amount_received_unit = 'sats'
              WHERE id = $2 AND status IN ('waiting','underpaid')`,
            [receivedSats, order_id]
          ).catch(() => {});
          await raiseAlert('crypto_recycled_address_payment',
            `Order ${order_id} received ${receivedSats} sats at ${ourAddress}, which was recycled from another order ${Math.round(heldForMs / 3600000)}h ago. Confirm the payer before delivering.`,
            { severity: 'error', order_id, context: { address: ourAddress, received_sats: receivedSats, assigned_at: h.assigned_at } }).catch(() => {});
          return res.sendStatus(200);
        }
      }
    } catch (e) {
      console.warn('[Webhook] Could not check address assignment history:', e.message);
    }

    // 5. Verify the amount covers the locked quote. Fails closed when the order
    //    has no quote, leaving it for manual review rather than free delivery.
    const check = verifyCryptoPayment(order, receivedSats);
    if (!check.ok) {
      console.warn(`[Webhook] Order ${order_id} NOT confirmed: ${check.reason}`);
      await query(
        `UPDATE orders SET status = 'underpaid', amount_received_native = $1, amount_received_unit = 'sats'
          WHERE id = $2 AND status IN ('waiting','underpaid')`,
        [receivedSats, order_id]
      ).catch(() => {});
      await raiseAlert('order_underpaid',
        `Order ${order_id} underpaid via ${order.payment_method}: ${check.reason}`,
        { severity: 'error', order_id, context: { received_sats: receivedSats, reason: check.reason } }).catch(() => {});
      return res.sendStatus(200);
    }

    await axios.post(`http://localhost:${process.env.PORT || 3000}/api/orders/confirm`, {
      secret: process.env.API_SECRET,
      order_id,
      amount_received: receivedSats,
      method: order.payment_method,
      // The chain's own transaction hash. Ties the settlement to a specific tx
      // so a redelivered callback cannot settle anything twice.
      provider_txn_id: payload.hash || null,
    });
    console.log(`[Webhook] Order ${order_id} confirmed — ${receivedSats} sats`);

    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook] Crypto error:', err);
    res.sendStatus(200); // Always 200 to BlockCypher so it stops retrying
  }
});

module.exports = router;
