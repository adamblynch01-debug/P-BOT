const express = require('express');
const router = express.Router();
const { query } = require('../db');

const GUILD_ID = process.env.GUILD_ID;

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
      'ORDER_LOG_CHANNEL_ID', 'PANEL_PASSWORD', 'VAULT_PASSWORD',
    ];

    if (!allowed_keys.includes(key.toUpperCase())) {
      return res.status(400).json({ error: `Key "${key}" is not configurable` });
    }

    await query(
      `INSERT INTO config (guild_id, key, value, updated_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (guild_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [GUILD_ID, key.toUpperCase(), value]
    );

    process.env[key.toUpperCase()] = value;
    res.json({ success: true, message: `${key} updated successfully` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// Restores any config previously set via POST /update back into process.env.
// The original backend upserted to Supabase but never read it back on boot,
// so a Railway restart silently reverted to whatever's in the real env vars.
// Called once from server.js before the app starts listening.
async function loadConfigFromDB() {
  try {
    const { rows } = await query('SELECT key, value FROM config WHERE guild_id = $1', [GUILD_ID]);
    // A DB row wins over the Railway env var. That is the intent, but it makes
    // rotating a leaked credential in Railway silently ineffective for any key
    // that also has a row here — the new value is set, the service restarts,
    // and boot quietly puts the old one back. PANEL_PASSWORD and VAULT_PASSWORD
    // both sit in allowed_keys, so both are exposed to this. Name the keys that
    // got overridden (never the values) so the next rotation fails loudly.
    const overridden = [];
    for (const row of rows) {
      if (row.value == null) continue;
      const prev = process.env[row.key];
      if (prev !== undefined && prev !== row.value) overridden.push(row.key);
      process.env[row.key] = row.value;
    }
    if (rows.length) console.log(`[Config] Restored ${rows.length} config value(s) from DB`);
    if (overridden.length) {
      console.warn(
        `[Config] DB value overrode a DIFFERENT env var for: ${overridden.join(', ')} — ` +
        `if you just rotated one of these in Railway, the DB row still holds the old value`
      );
    }
  } catch (err) {
    console.warn('[Config] Could not preload config from DB:', err.message);
  }
}

module.exports = router;
module.exports.loadConfigFromDB = loadConfigFromDB;
