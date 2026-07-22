const cron = require('node-cron');
const axios = require('axios');
const { query } = require('../db');

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
    const { rows: orders } = await query(
      `SELECT * FROM orders
       WHERE guild_id = $1 AND payment_method IN ('btc','ltc') AND status = 'waiting' AND expires_at > now()`,
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

    const confirmed = res.data.balance || 0;
    if (confirmed > 0) {
      await axios.post(`http://localhost:${process.env.PORT || 3000}/api/orders/confirm`, {
        secret: process.env.API_SECRET,
        order_id: order.id,
        amount_received: confirmed,
        method: coin,
      });
    }
  } catch (err) {
    console.error(`[CryptoWatcher] Address check error:`, err.message);
  }
}

module.exports = { start };
