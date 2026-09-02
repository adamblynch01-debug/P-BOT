const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { requireAuth, requireAdmin, requireCurrentDiscordMember } = require('../utils/auth');
const { checkDiscordAccess } = require('../utils/discordAccess');
const { syncDeliveredGoodsToVault } = require('../utils/delivery');

const GUILD_ID = process.env.GUILD_ID;
// Discord membership is authoritative, but it does not need to be fetched on
// every Vault tab click. A short cache removes the sudden multi-second delay
// while still rechecking membership regularly.
const guildMembershipCache = new Map();
const GUILD_CACHE_MS = 60 * 1000;

async function assertGuildMember(user) {
  if (user && (user.role === 'admin' || user.role === 'staff')) return true;
  if (!user.discord_id || !user.discord_verified) {
    const err = new Error('You must link your Discord account on the main store before accessing the vault.');
    err.statusCode = 403;
    throw err;
  }
  const access = await checkDiscordAccess(String(user.discord_id));
  if (!access.inServer) {
    const err = new Error('You must be a member of our Discord server to access the vault.');
    err.statusCode = 403;
    throw err;
  }
  if (!access.hasCustomerRole) {
    const err = new Error('Your Discord account does not have the required member role.');
    err.statusCode = 403;
    throw err;
  }
  return true;
}

async function backfillTrackerForUser(userId) {
  try {
    const { rows: delivered } = await query(
      `SELECT id, invoice_no, web_user_id, email, discord_id, payment_method,
              paid_at, delivered_at, created_at, items_snapshot, delivered_goods
         FROM orders
        WHERE guild_id = $1 AND web_user_id = $2
          AND status IN ('delivered', 'paid')
          AND delivered_goods IS NOT NULL
        ORDER BY id DESC LIMIT 100`,
      [GUILD_ID, userId]
    );
    for (const order of delivered) {
      let goods = order.delivered_goods;
      if (typeof goods === 'string') { try { goods = JSON.parse(goods); } catch (_) { goods = []; } }
      if (Array.isArray(goods) && goods.length) await syncDeliveredGoodsToVault(order, goods);
    }
  } catch (syncErr) {
    console.error('[Vault] Order tracker backfill failed:', syncErr.message);
  }
}

// ─── GET /api/vault/check-access ──────────────────────────────────────────
// Check if the authenticated user has access to the vault:
// 1. Must have a web_users account (requireAuth ensures this)
// 2. Must be a member of the Discord guild
router.get('/check-access', requireAuth, async (req, res) => {
  try {
    // The Vault page calls this immediately before GET /api/vault. Reusing the
    // same verifier makes the second request a cache hit rather than another
    // Discord round-trip.
    await assertGuildMember(req.user);
    return res.json({
      access: true,
      user: { id: req.user.id, username: req.user.username, discord_id: req.user.discord_id }
    });
  } catch (err) {
    console.error('[Vault] check-access error:', err);
    res.status(err.statusCode || 500).json({
      error: err.statusCode === 403 ? 'Vault access denied' : 'Failed to verify access',
      message: err.statusCode === 403 ? err.message : undefined,
    });
  }
});

// ─── Migration: create vault_data table if not exists ─────────────────────
// This table stores the user's vault data (COD accounts, ARC accounts, etc.)
// The schema matches what vault_unified_fixed.html expects.
//
// Run this migration manually first:
//   CREATE TABLE IF NOT EXISTS vault_data (
//     id TEXT PRIMARY KEY,
//     user_id TEXT NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,
//     guild_id TEXT NOT NULL,
//     data JSONB NOT NULL DEFAULT '{}',
//     updated_at TIMESTAMPTZ DEFAULT NOW()
//   );
//   CREATE INDEX IF NOT EXISTS idx_vault_data_user ON vault_data(user_id, guild_id);

// ─── GET /api/vault ───────────────────────────────────────────────────────
// Fetch the current user's vault data
// Now also checks guild membership before allowing access
router.get('/', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT data FROM vault_data WHERE user_id = $1 AND guild_id = $2`,
      [req.user.id, GUILD_ID]
    );

    if (!rows.length) {
      // Return empty vault structure
      res.json({
        cod: [],
        arc: [],
        gta: [],
        fivem: [],
        discord: [],
        gamelib: [],
        email: [],
        streaming: [],
        ai: [],
        gamepass: [],
        sw: [],
        pk: [],
        personal_keys: []
      });
      setImmediate(() => backfillTrackerForUser(req.user.id));
      return;
    }

    res.json(rows[0].data || {});
    // Historical order repair is deliberately non-blocking. New deliveries
    // are synchronised before they are reported complete; this path only
    // repairs old records and can safely run after the response.
    setImmediate(() => backfillTrackerForUser(req.user.id));
  } catch (err) {
    console.error('[Vault] GET error:', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode === 403 ? err.message : 'Failed to load vault data' });
  }
});

// ─── POST /api/vault ──────────────────────────────────────────────────────
// Save/update the current user's vault data
// Body: { data: { cod: [...], arc: [...], sw: [...], pk: [...], personal_keys: [...] } }
router.post('/', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid data format' });
    }

    const now = new Date().toISOString();

    await withTransaction(async (exec) => {
      await exec(
        `INSERT INTO vault_data (user_id, guild_id, data, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, guild_id)
         DO UPDATE SET data = $3, updated_at = $4`,
        [req.user.id, GUILD_ID, JSON.stringify(data), now]
      );
    });

    res.json({ success: true, updated_at: now });
  } catch (err) {
    console.error('[Vault] POST error:', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode === 403 ? err.message : 'Failed to save vault data' });
  }
});

// ─── PATCH /api/vault/game/:gameKey ───────────────────────────────────────
// Update a specific game's data (cod, arc, sw, pk, personal_keys)
// Body: { items: [...] }
router.patch('/game/:gameKey', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { items } = req.body;

    // Keep this allow-list in step with the Vault's complete category map.
    // The previous list silently rejected newer categories (Game Library,
    // Email, GTA, etc.), which forced callers back to a whole-document POST
    // and made concurrent writes overwrite one another.
    const validKeys = [
      'cod', 'arc', 'gta', 'fivem', 'discord', 'gamelib', 'email',
      'streaming', 'ai', 'gamepass', 'sw', 'pk', 'personal_keys'
    ];
    if (!validKeys.includes(gameKey)) {
      return res.status(400).json({ error: 'Invalid game key' });
    }

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Items must be an array' });
    }

    const now = new Date().toISOString();

    await withTransaction(async (exec) => {
      // Fetch current data
      const { rows } = await exec(
        `SELECT data FROM vault_data WHERE user_id = $1 AND guild_id = $2 FOR UPDATE`,
        [req.user.id, GUILD_ID]
      );

      let currentData = rows.length ? (rows[0].data || {}) : {};

      // Update the specific game key
      currentData[gameKey] = items;

      // Upsert
      await exec(
        `INSERT INTO vault_data (user_id, guild_id, data, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, guild_id)
         DO UPDATE SET data = $3, updated_at = $4`,
        [req.user.id, GUILD_ID, JSON.stringify(currentData), now]
      );
    });

    res.json({ success: true, updated_at: now });
  } catch (err) {
    console.error('[Vault] PATCH game error:', err);
    res.status(500).json({ error: 'Failed to update game data' });
  }
});

// ─── GET /api/vault/admin/all ─────────────────────────────────────────────
// Admin endpoint: get all vault data for all users
router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         vd.user_id,
         vd.data,
         vd.updated_at,
         wu.username,
         wu.email,
         wu.discord_id,
         wu.role
       FROM vault_data vd
       JOIN web_users wu ON wu.id = vd.user_id
       WHERE vd.guild_id = $1
       ORDER BY vd.updated_at DESC`,
      [GUILD_ID]
    );

    res.json({ users: rows });
  } catch (err) {
    console.error('[Vault] admin/all error:', err);
    res.status(500).json({ error: 'Failed to fetch vault data' });
  }
});

// ─── GET /api/vault/admin/user/:userId ────────────────────────────────────
// Admin endpoint: get vault data for a specific user (by user_id or discord_id)
router.get('/admin/user/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    // Try to find by user_id first, then by discord_id
    let rows;
    if (userId.match(/^\d{17,19}$/)) {
      // Looks like a Discord snowflake
      const { rows: discordRows } = await query(
        `SELECT
           vd.user_id,
           vd.data,
           vd.updated_at,
           wu.username,
           wu.email,
           wu.discord_id,
           wu.role
         FROM vault_data vd
         JOIN web_users wu ON wu.id = vd.user_id
         WHERE vd.guild_id = $1 AND wu.discord_id = $2`,
        [GUILD_ID, userId]
      );
      rows = discordRows;
    } else {
      // Assume it's a user_id
      const { rows: userRows } = await query(
        `SELECT
           vd.user_id,
           vd.data,
           vd.updated_at,
           wu.username,
           wu.email,
           wu.discord_id,
           wu.role
         FROM vault_data vd
         JOIN web_users wu ON wu.id = vd.user_id
         WHERE vd.guild_id = $1 AND vd.user_id = $2`,
        [GUILD_ID, userId]
      );
      rows = userRows;
    }

    if (!rows.length) {
      return res.status(404).json({ error: 'User vault data not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[Vault] admin/user error:', err);
    res.status(500).json({ error: 'Failed to fetch user vault data' });
  }
});

module.exports = router;
