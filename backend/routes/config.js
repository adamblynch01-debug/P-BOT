const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { failureLimiter, safeCompare } = require('../utils/rateLimit');
const EXPIRY = require('../utils/expiry');
const { payableMethods, isPayableCashtag, isPayableEmail,
        methodStates, normalisePaypalMe, toggleMethod, ALL_METHODS } = require('../utils/paymentAddress');
const { requireOwnerAdmin } = require('../utils/auth');

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
//
// The supplier keys are on the list for the same reason as the two passwords,
// plus a worse one: they spend real money. A key in a `config` row is a key
// readable by anything holding API_SECRET, and one that boot would restore over
// a rotation made after the old one leaked. Railway only.
//
// One entry per supplier, listed explicitly rather than matched on a pattern
// like /_API_KEY$/: a rule that guesses which names are dangerous will one day
// guess wrong in the direction that costs money.
const ENV_ONLY_KEYS = ['PANEL_PASSWORD', 'VAULT_PASSWORD', 'ORDER_LOG_CHANNEL_ID',
  'GANDY_API_KEY', 'AIMBETTER_API_KEY'];

router.get('/', (req, res) => {
  res.json({
    store_name: process.env.STORE_NAME || 'H8ED Shop',
    // Served as null when it is not an address, so no caller can print it as
    // one. Production had " your $cashtag" here and the storefront was
    // publishing it. See utils/paymentAddress.js.
    cashapp_cashtag: isPayableCashtag(process.env.CASHAPP_CASHTAG) ? String(process.env.CASHAPP_CASHTAG).trim() : null,
    paypal_email: isPayableEmail(process.env.PAYPAL_EMAIL) ? String(process.env.PAYPAL_EMAIL).trim() : null,
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
    // A method whose address cannot be paid is not a method. This was
    // `!!process.env.CASHAPP_CASHTAG`, which is true of a placeholder, so
    // checkout offered Cash App and then showed the placeholder as the address.
    payment_methods: payableMethods(),
    // The same four booleans with the REASON attached. `payment_methods` stays
    // exactly as it was so nothing reading it has to change; this is what the
    // admin panel renders, because "off" and "misconfigured" want opposite
    // reactions from whoever is looking at the switch.
    payment_method_states: methodStates(),
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
      // Which methods are switched off, and the PayPal.Me handle the pay
      // screen's QR is built from. Both belong in the DB rather than in
      // Railway: closing a payment method is something you do in the middle of
      // a busy day, and a Railway variable costs a redeploy to change.
      'PAYMENT_METHODS_OFF', 'PAYPAL_ME',
      // The supplier kill switch. Same reasoning: switching off an upstream
      // that has stopped delivering is something you do mid-incident, and a
      // Railway variable costs a redeploy. The KEY it gates (GANDY_API_KEY) is
      // env-only and listed above — this is the switch, not the credential.
      'SUPPLIER_OFF',
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

    // Refused on the way IN as well as on the way out. Saving a payment address
    // that cannot be paid is never what anybody meant, and accepting it here is
    // how " your $cashtag" got onto production in the first place — silently,
    // with a success message.
    if (key.toUpperCase() === 'CASHAPP_CASHTAG' && String(value || '').trim() && !isPayableCashtag(value)) {
      return res.status(400).json({
        error: `"${String(value).trim()}" is not a cashtag. It must be $ followed by up to 20 letters, `
             + 'digits or underscores — e.g. $uhservices. Cash App stays switched off until it is.',
      });
    }
    if (key.toUpperCase() === 'PAYPAL_EMAIL' && String(value || '').trim() && !isPayableEmail(value)) {
      return res.status(400).json({
        error: `"${String(value).trim()}" is not an email address, so PayPal would show it to buyers as one.`,
      });
    }

    // What actually gets stored. Two keys are normalised rather than taken
    // verbatim, so the stored form is the canonical one and every reader gets
    // the same answer without re-parsing.
    let stored = value;

    // A typo here must be LOUD. "payapl" would otherwise be filtered out as an
    // unknown method, stored, and report success while PayPal stayed on — the
    // owner would believe they had closed a payment method during whatever
    // incident made them want to.
    if (key.toUpperCase() === 'PAYMENT_METHODS_OFF') {
      const parts = String(value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const unknown = parts.filter(p => !ALL_METHODS.includes(p));
      if (unknown.length) {
        return res.status(400).json({
          error: `Not a payment method: ${unknown.join(', ')}. Valid values are ${ALL_METHODS.join(', ')} `
               + '— send an empty value to switch every method back on.',
        });
      }
      // De-duplicated and in a fixed order, so the same set of switches always
      // stores the same string.
      stored = ALL_METHODS.filter(m => parts.includes(m)).join(',');
    }

    // Accepts a bare handle, @handle, paypal.me/handle or the full URL, and
    // stores the handle. Refuses anything that is not one, because the
    // alternative is a QR that silently does not render.
    if (key.toUpperCase() === 'PAYPAL_ME' && String(value || '').trim()) {
      const handle = normalisePaypalMe(value);
      if (!handle) {
        return res.status(400).json({
          error: `"${String(value).trim()}" is not a PayPal.Me handle. It is 1-20 letters or digits — the name `
               + 'at the end of your paypal.me link. Paste the link itself if that is easier.',
        });
      }
      stored = handle;
    }

    await query(
      `INSERT INTO config (guild_id, key, value, updated_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (guild_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [GUILD_ID, key.toUpperCase(), stored]
    );

    process.env[key.toUpperCase()] = stored;
    res.json({ success: true, message: `${key} updated successfully`, value: stored });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// ─── Switching a payment method on and off ───────────────────────────────────
//
// A separate route from POST /update for one reason: that one authenticates
// with API_SECRET, which is a SERVER credential. The admin panel runs in a
// browser and holds a session token, not the secret — so before this existed
// the panel had no way to reach config at all, which is why the payment
// section of the panel was simply missing rather than merely incomplete.
//
// Gated on requireOwnerAdmin rather than requireAdmin. requireAdmin accepts
// 'staff', and closing the store's payment methods is not a moderation
// action — it decides whether the shop can take money. Same reasoning that
// split /admin/set-role off from the rest.
router.post('/payment-methods', requireOwnerAdmin, async (req, res) => {
  try {
    const { method, enabled } = req.body || {};
    let next;
    try {
      next = toggleMethod(method, !!enabled);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    await query(
      `INSERT INTO config (guild_id, key, value, updated_at) VALUES ($1,'PAYMENT_METHODS_OFF',$2, now())
       ON CONFLICT (guild_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [GUILD_ID, next]
    );
    process.env.PAYMENT_METHODS_OFF = next;

    const m = String(method).trim().toLowerCase();
    console.log(`[Config] ${m} payment switched ${enabled ? 'ON' : 'OFF'} by ${req.user.username || req.user.id}`);

    // The full state goes back, not just the method that moved. The panel
    // re-renders from this, so a second admin toggling something in another
    // tab cannot leave one browser showing a switch that is no longer true.
    res.json({ success: true, payment_method_states: methodStates(), payment_methods: payableMethods() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update payment methods' });
  }
});

// The PayPal.Me handle, from the panel. Same owner-only gate: it decides what
// a buyer's phone opens when they scan the QR on the pay screen, so it is a
// payment address in everything but name.
router.post('/paypal-me', requireOwnerAdmin, async (req, res) => {
  try {
    const raw = String((req.body || {}).handle || '').trim();
    // An empty value is a deliberate CLEAR, not a mistake — it hides the QR
    // and leaves PayPal working by email, which is exactly the state the store
    // has been in all along.
    let stored = '';
    if (raw) {
      stored = normalisePaypalMe(raw);
      if (!stored) {
        return res.status(400).json({
          error: `"${raw}" is not a PayPal.Me handle. It is the 1-20 letters or digits at the end of your `
               + 'paypal.me link — paste the whole link if that is easier. Leave this empty to show no QR.',
        });
      }
    }
    await query(
      `INSERT INTO config (guild_id, key, value, updated_at) VALUES ($1,'PAYPAL_ME',$2, now())
       ON CONFLICT (guild_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [GUILD_ID, stored]
    );
    process.env.PAYPAL_ME = stored;
    res.json({ success: true, paypal_me: stored || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save the PayPal.Me handle' });
  }
});

// Read side for the panel. GET / is public and deliberately says only whether
// a method is available; this says WHY, and whether the address behind a
// switched-off method is still intact — which is the question the owner will
// actually have when they come back to turn it on again.
router.get('/payment-methods', requireOwnerAdmin, (req, res) => {
  res.json({
    payment_method_states: methodStates(),
    paypal_me: normalisePaypalMe(process.env.PAYPAL_ME),
  });
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
