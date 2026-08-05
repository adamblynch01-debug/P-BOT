const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { failureLimiter, safeCompare } = require('../utils/rateLimit');
const EXPIRY = require('../utils/expiry');

const GUILD_ID = process.env.GUILD_ID;

// Counts only rejected secrets, so the admin panel can save settings as often
// as it likes while a guesser gets 30 tries per 15 minutes.
const secretLimiter = failureLimiter({ windowMs: 15 * 60 * 1000, max: 30, globalMax: 300, name: 'config-update' });

// Keys that must come from the Railway env var and never from the `config`
// table. Enforced in BOTH directions — rejected on write below, and ignored on
// read in loadConfigFromDB — so a leftover or hand-inserted row can't quietly
// resurrect the old override behaviour.
//
// ORDER_LOG_CHANNEL_ID is on this list by the owner's explicit decision
// (2026-07-26): it is set directly in Railway and `/config set logchan` is not
// used. That closes the trap for the one key where it would be hardest to
// notice — a stale config row would silently redirect the entire order feed to
// a dead or wrong channel at boot, and the symptom (orders "not logging") looks
// identical to the bug that started this whole audit.
const ENV_ONLY_KEYS = ['PANEL_PASSWORD', 'VAULT_PASSWORD', 'ORDER_LOG_CHANNEL_ID'];

router.get('/', (req, res) => {
  res.json({
    store_name: process.env.STORE_NAME || 'H8ED Shop',
    cashapp_cashtag: process.env.CASHAPP_CASHTAG || null,
    paypal_email: process.env.PAYPAL_EMAIL || null,
    cashapp_fee: process.env.CASHAPP_FEE_PERCENT || 10,
    paypal_fee: process.env.PAYPAL_FEE_PERCENT || 10,
    crypto_discount: process.env.CRYPTO_DISCOUNT_PERCENT || 5,
    // The number routes/orders.js actually ADDS to a crypto total. It is a fee,
    // not a discount: `crypto_discount` above is served to nobody who applies
    // it and has never been subtracted from a total. Both are here rather than
    // one quietly replacing the other, because a caller reading the old key is
    // better off seeing them disagree than being silently re-pointed.
    crypto_fee: process.env.CRYPTO_FEE_PERCENT || 5,
    // How long an unpaid order of each kind stays payable — the same values the
    // expiry sweeper enforces, so a payment window quoted to a buyer on Discord
    // cannot drift from the one the pay screen counts down to.
    expiry_minutes: {
      crypto: EXPIRY.ORDER_EXPIRY_MINUTES_CRYPTO,
      cash: EXPIRY.ORDER_EXPIRY_MINUTES_CASH,
      default: EXPIRY.ORDER_EXPIRY_MINUTES,
    },
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
    // Was `secret !== process.env.API_SECRET`, which is `undefined !== undefined`
    // → false when the env var is unset: the route failed OPEN. Refuse to serve
    // at all rather than authorize everyone, and compare in constant time.
    if (!process.env.API_SECRET) return res.status(503).json({ error: 'Server not configured' });
    if (!safeCompare(secret, process.env.API_SECRET)) {
      if (secretLimiter.blocked(req, res)) return;
      secretLimiter.fail(req);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key is required' });

    // Keys the admin panel may store in the `config` table. A row here beats
    // the Railway env var at boot (see loadConfigFromDB below), which is what
    // makes this list security-relevant rather than cosmetic.
    //
    // PANEL_PASSWORD and VAULT_PASSWORD were REMOVED from this list. They were
    // the two keys where DB-wins was actively harmful: rotating them in Railway
    // appeared to succeed and silently did nothing, because boot restored the
    // old row. It also meant anyone holding API_SECRET could set the admin
    // panel password through this endpoint. Both now come from the Railway env
    // var and nowhere else — change them there, redeploy, done.
    const allowed_keys = [
      'CASHAPP_CASHTAG', 'PAYPAL_EMAIL', 'GMAIL_USER', 'GMAIL_PASSWORD',
      'DISCORD_GUILD_ID', 'CASHAPP_FEE_PERCENT', 'PAYPAL_FEE_PERCENT',
      'CRYPTO_DISCOUNT_PERCENT', 'STORE_NAME', 'BTC_XPUB', 'LTC_XPUB',
      'ORDER_LOG_CHANNEL_ID',
    ];

    // Rejected by name so the error explains itself instead of looking like a
    // typo, and so nobody re-adds them to allowed_keys without reading why.
    if (ENV_ONLY_KEYS.includes(String(key).toUpperCase())) {
      return res.status(400).json({
        error: `${String(key).toUpperCase()} is set in Railway only. Change it there and redeploy — ` +
               `storing it here would override the Railway value at boot.`,
      });
    }

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
    // A DB row wins over the Railway env var. That is the intent for settings
    // the admin panel edits (store name, fees, cashtag), but it made rotating a
    // leaked credential in Railway silently ineffective — the new value gets
    // set, the service restarts, and boot quietly puts the old one back.
    //
    // ENV_ONLY_KEYS are skipped outright so that can't happen to the panel and
    // vault passwords again even if a row is left behind or re-inserted by
    // hand. For everything else, name the keys that got overridden (never the
    // values) so the next surprise rotation fails loudly instead of silently.
    const overridden = [];
    const ignored = [];
    let applied = 0;
    for (const row of rows) {
      if (row.value == null) continue;
      if (ENV_ONLY_KEYS.includes(row.key)) { ignored.push(row.key); continue; }
      const prev = process.env[row.key];
      if (prev !== undefined && prev !== row.value) overridden.push(row.key);
      process.env[row.key] = row.value;
      applied += 1;
    }
    if (applied) console.log(`[Config] Restored ${applied} config value(s) from DB`);
    if (ignored.length) {
      console.warn(
        `[Config] IGNORED stale config row(s) for env-only key(s): ${ignored.join(', ')} — ` +
        `the Railway value applies. Delete these rows.`
      );
    }
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
