const express = require('express');
const router = express.Router();
const axios = require('axios');

// POST /api/webhooks/crypto
// BlockCypher calls this when a watched address receives payment
router.post('/crypto', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[Webhook] Crypto payment received:', JSON.stringify(payload));

    // BlockCypher sends tx data — extract address and value
    const outputs = payload.outputs || [];
    const input_addresses = payload.addresses || [];

    // Find which address is ours (the receiving address)
    // BlockCypher includes metadata we set when registering webhook
    const order_id = payload.user_data || req.query.order_id;
    if (!order_id) {
      console.warn('[Webhook] No order_id in crypto webhook');
      return res.sendStatus(200);
    }

    // Only confirm after 1+ confirmations
    const confirmations = payload.confirmations || 0;
    if (confirmations < 1) {
      console.log(`[Webhook] TX has ${confirmations} confirmations, waiting...`);
      return res.sendStatus(200);
    }

    // Calculate total received in USD equivalent (simplified — you'd use price API)
    const satoshis = outputs.reduce((sum, o) => sum + (o.value || 0), 0);

    // Confirm the order via internal API
    await axios.post(`http://localhost:${process.env.PORT || 3000}/api/orders/confirm`, {
      secret: process.env.API_SECRET,
      order_id,
      amount_received: satoshis,
      method: 'crypto',
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook] Crypto error:', err);
    res.sendStatus(200); // Always 200 to BlockCypher
  }
});

module.exports = router;
