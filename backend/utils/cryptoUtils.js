const axios = require('axios');
const { supabase } = require('../server');

// ─── Generate unique crypto address per order ────────────
// Uses BlockCypher's address generation endpoint
// In production you'd derive from xpub for full HD wallet control
async function generateCryptoAddress(coin, order_id) {
  try {
    const chain = coin === 'btc' ? 'btc/main' : 'ltc/main';
    const token = process.env.BLOCKCYPHER_TOKEN;

    const response = await axios.post(
      `https://api.blockcypher.com/v1/${chain}/addrs?token=${token}`
    );

    const address = response.data.address;

    // Save address → order mapping
    await supabase.from('crypto_addresses').insert({
      address,
      order_id,
      coin: coin.toUpperCase(),
      created_at: new Date().toISOString(),
    });

    return address;
  } catch (err) {
    console.error('[Crypto] Address generation error:', err.message);
    // Fallback: return a placeholder (replace with xpub derivation in prod)
    return null;
  }
}

// ─── Register BlockCypher webhook for address ────────────
async function registerWebhook(coin, address, order_id) {
  try {
    const chain = coin === 'btc' ? 'btc/main' : 'ltc/main';
    const token = process.env.BLOCKCYPHER_TOKEN;
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;

    await axios.post(
      `https://api.blockcypher.com/v1/${chain}/hooks?token=${token}`,
      {
        event: 'confirmed-tx',
        address,
        url: `${backendUrl}/api/webhooks/crypto?order_id=${order_id}`,
        confirmations: 1,
      }
    );

    console.log(`[Crypto] Webhook registered for ${address}`);
  } catch (err) {
    console.error('[Crypto] Webhook registration error:', err.message);
  }
}

module.exports = { generateCryptoAddress, registerWebhook };
