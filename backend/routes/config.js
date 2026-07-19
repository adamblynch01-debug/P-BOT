const express = require('express');
const router = express.Router();
const { supabase } = require('../db');

router.get('/', (req, res) => {
  res.json({
    store_name: process.env.STORE_NAME || 'H8ED Shop',
    cashapp_cashtag: process.env.CASHAPP_CASHTAG || null,
    paypal_email: process.env.PAYPAL_EMAIL || null,
    cashapp_fee: process.env.CASHAPP_FEE_PERCENT || 10,
    paypal_fee: process.env.PAYPAL_FEE_PERCENT || 10,
    crypto_discount: process.env.CRYPTO_DISCOUNT_PERCENT || 5,
    payment_methods: {
      cashapp: !!process.env.CASHAPP_CASHTAG,
      paypal: !!process.env.PAYPAL_EMAIL,
      btc: !!process.env.BTC_XPUB,
      ltc: !!process.env.LTC_XPUB,
    }
  });
});

router.post('/update', async (req, res) => {
  try {
    const { secret, key, value } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const allowed_keys = [
      'CASHAPP_CASHTAG', 'PAYPAL_EMAIL', 'GMAIL_USER', 'GMAIL_PASSWORD',
      'DISCORD_GUILD_ID', 'CASHAPP_FEE_PERCENT', 'PAYPAL_FEE_PERCENT',
      'CRYPTO_DISCOUNT_PERCENT', 'STORE_NAME', 'BTC_XPUB', 'LTC_XPUB',
    ];

    if (!allowed_keys.includes(key.toUpperCase())) {
      return res.status(400).json({ error: `Key "${key}" is not configurable` });
    }

    const { error } = await supabase.from('config').upsert({
      key: key.toUpperCase(), value, updated_at: new Date().toISOString(),
    });
    if (error) throw error;

    process.env[key.toUpperCase()] = value;
    res.json({ success: true, message: `${key} updated successfully` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update config' });
  }
});

module.exports = router;
