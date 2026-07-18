const cron = require('node-cron');
const axios = require('axios');
const { supabase } = require('../db');

function start() {
  if (!process.env.BLOCKCYPHER_TOKEN) {
    console.warn('[CryptoWatcher] No BlockCypher token — crypto polling disabled');
    return;
  }

  // Poll every 2 minutes as a fallback to webhooks
  cron.schedule('*/2 * * * *', checkPendingCryptoOrders);
  console.log('[CryptoWatcher] Started — polling every 2 minutes');
}

async function checkPendingCryptoOrders() {
  try {
    // Get all pending crypto orders that haven't expired
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .in('payment_method', ['btc', 'ltc'])
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString());

    if (error || !orders || orders.length === 0) return;

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

    const confirmed = res.data.balance || 0;
    const unconfirmed = res.data.unconfirmed_balance || 0;
    const total = confirmed + unconfirmed;

    if (total > 0) {
      console.log(`[CryptoWatcher] Payment detected on ${order.crypto_address} — ${total} satoshis`);

      // Only confirm if we have at least 1 confirmation
      if (confirmed > 0) {
        await axios.post(
          `http://localhost:${process.env.PORT || 3000}/api/orders/confirm`,
          {
            secret: process.env.API_SECRET,
            order_id: order.id,
            amount_received: confirmed,
            method: coin,
          }
        );
      }
    }
  } catch (err) {
    console.error(`[CryptoWatcher] Address check error for ${order.crypto_address}:`, err.message);
  }
}

module.exports = { start };
