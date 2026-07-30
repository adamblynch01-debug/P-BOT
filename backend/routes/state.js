const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { getSessionUser, bearerToken } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// ─── Generic server-side state store ────────────────────────────────
// Replaces localStorage for storefront data that must survive across
// devices/browsers. Every key is classified so the same table can safely
// hold both customer-visible display config and admin-only records.
//
//   public : anyone may GET (read-only display data). Writes still admin.
//   admin  : only admin/staff may GET or POST (site-wide authored data).
//   user   : the owning account may GET/POST its own row (scope='user').
//
// Anything NOT listed here is treated as 'admin' (deny-by-default: a new
// key is never accidentally world-readable or user-writable).
const KEY_ACL = {
  // ── public display config (safe to read anonymously) ──
  ghostCheatHidden:        'public',
  ghostGameHidden:         'public',
  ghostVaultHidden:        'public',
  ghostVaultCatHidden:     'public',
  ghostDlHidden:           'public',
  ghostCustomProducts:     'public',
  ghostCustomGames:        'public',
  ghostCustomVaultProducts:'public',
  ghostCustomVaultCategories:'public',
  ghostCustomVaultTiles:   'public',
  // ghostDownloads / ghostVaultDownloads were 'public'. That served the direct
  // file URL for every product — vault exclusives included — to any anonymous
  // caller with one curl. They are admin-only now, and customers reach a link
  // through GET /api/downloads/:name, which checks they actually bought it.
  ghostDownloads:          'admin',
  ghostVaultDownloads:     'admin',
  ghostStatuses:           'public',
  ghostStatusHidden:       'public',
  ghostNFALoaderURL:       'public',
  ghostDiscordInvite:      'public',

  // ── admin-only site records ──
  ghostInventory:          'admin',
  ghostVaultInventory:     'admin',
  ghostResellerInventory:  'admin',
  ghostDeliveryLog:        'admin',
  ghostVaultDeliveryLog:   'admin',
  ghostIpBans:             'admin',
  ghostBanLog:             'admin',
  ghostAdminSettings:      'admin',
  ghostResellerRoles:      'admin',
  ghostResellerLog:        'admin',
  ghostResellerUsers:      'admin',
  ghostVaultUsers:         'admin',
  // ghostTickets, ghostVaultTickets and ghostHwidRequests were here. They are
  // per-user records, so the global scope was the wrong home twice over: the
  // 'admin' ACL rejected the customer's own write (401, silently swallowed by
  // the frontend, ticket lost), and storing the whole list as one JSON blob
  // meant two staff replying at once overwrote each other. They now live in
  // the tickets / ticket_messages / hwid_requests tables — see routes/tickets.js.
  // Anything not listed here is 'admin' by default, so a stale client writing
  // these keys is still refused rather than silently accepted.

  // ── per-user records (owner reads/writes its own) ──
  ghostVaultCart:          'user',
};

function aclFor(key) {
  return KEY_ACL[key] || 'admin';
}

async function sessionUser(req) {
  try { return await getSessionUser(bearerToken(req)); } catch { return null; }
}
function isAdmin(user) {
  return !!(user && ['admin', 'staff'].includes(user.role));
}

// ─── GET /api/state/global/:key ─────────────────────────────────────
router.get('/global/:key', async (req, res) => {
  try {
    const key = req.params.key;
    const acl = aclFor(key);
    if (acl !== 'public') {
      if (!isAdmin(await sessionUser(req))) return res.status(401).json({ error: 'Unauthorized' });
    }
    const { rows } = await query(
      `SELECT value FROM app_state WHERE guild_id = $1 AND scope = 'global' AND owner_id = '' AND key = $2`,
      [GUILD_ID, key]
    );
    res.json({ key, value: rows.length ? rows[0].value : null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read state' });
  }
});

// ─── POST /api/state/global/:key ────────────────────────────────────
// Writes to global scope always require admin/staff (public keys are still
// authored by admins; the public ACL only relaxes reads).
router.post('/global/:key', async (req, res) => {
  try {
    if (!isAdmin(await sessionUser(req))) return res.status(401).json({ error: 'Unauthorized' });
    const key = req.params.key;

    // Only keys this backend actually knows about. The route used to accept ANY
    // key name, so every request with a fresh name appended a new row — a typo
    // from the panel silently created a permanent orphan, and a loop could grow
    // the table until Supabase's storage cap started rejecting writes for the
    // whole system, order creation included.
    //
    // Rejecting an unknown key also surfaces frontend/backend drift instead of
    // writing data nothing will ever read back.
    if (!Object.prototype.hasOwnProperty.call(KEY_ACL, key)) {
      return res.status(400).json({
        error: `Unknown state key "${key}". Add it to KEY_ACL in routes/state.js if it is real.`,
      });
    }

    const value = req.body && 'value' in req.body ? req.body.value : null;
    const serialised = JSON.stringify(value);
    // app_state holds display config and admin records, not blobs. A cap here
    // keeps one oversized paste from bloating a row every other request reads.
    const MAX_STATE_BYTES = 512 * 1024;
    if (serialised && Buffer.byteLength(serialised, 'utf8') > MAX_STATE_BYTES) {
      return res.status(413).json({ error: 'That value is too large to store (512KB limit).' });
    }

    await query(
      `INSERT INTO app_state (guild_id, scope, owner_id, key, value, updated_at)
       VALUES ($1,'global','',$2,$3, now())
       ON CONFLICT (guild_id, scope, owner_id, key)
       DO UPDATE SET value = $3, updated_at = now()`,
      [GUILD_ID, key, serialised]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[State] global write error:', err);
    res.status(500).json({ error: 'Failed to write state' });
  }
});

// ─── GET /api/state/user/:key ───────────────────────────────────────
// The owning account's own row. Admins may read any user's row by passing
// ?owner=<web_user_id>.
router.get('/user/:key', async (req, res) => {
  try {
    const key = req.params.key;
    if (aclFor(key) !== 'user') return res.status(404).json({ error: 'Not a user-scoped key' });
    const user = await sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    let owner = String(user.id);
    if (req.query.owner && isAdmin(user)) owner = String(req.query.owner);
    const { rows } = await query(
      `SELECT value FROM app_state WHERE guild_id = $1 AND scope = 'user' AND owner_id = $2 AND key = $3`,
      [GUILD_ID, owner, key]
    );
    res.json({ key, value: rows.length ? rows[0].value : null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read state' });
  }
});

// ─── POST /api/state/user/:key ──────────────────────────────────────
router.post('/user/:key', async (req, res) => {
  try {
    const key = req.params.key;
    if (aclFor(key) !== 'user') return res.status(404).json({ error: 'Not a user-scoped key' });
    const user = await sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const owner = String(user.id);
    const value = req.body && 'value' in req.body ? req.body.value : null;
    await query(
      `INSERT INTO app_state (guild_id, scope, owner_id, key, value, updated_at)
       VALUES ($1,'user',$2,$3,$4, now())
       ON CONFLICT (guild_id, scope, owner_id, key)
       DO UPDATE SET value = $4, updated_at = now()`,
      [GUILD_ID, owner, key, JSON.stringify(value)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write state' });
  }
});

module.exports = router;
