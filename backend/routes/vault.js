const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query, withTransaction } = require('../db');
const { requireAuth, requireAdmin } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

// ─── GET /api/vault/check-access ──────────────────────────────────────────
// Check if the authenticated user has access to the vault:
// 1. Must have a web_users account (requireAuth ensures this)
// 2. Must be a member of the Discord guild
router.get('/check-access', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    console.log('[Vault] check-access for user:', user.id, 'discord_id:', user.discord_id, 'verified:', user.discord_verified, 'BOT_TOKEN set:', !!BOT_TOKEN, 'GUILD_ID:', GUILD_ID);

    // Check if user has a verified Discord account linked
    if (!user.discord_id || !user.discord_verified) {
      console.log('[Vault] check-access denied - discord not linked/verified');
      return res.status(403).json({
        error: 'Discord account not linked',
        message: 'You must link your Discord account on the main store before accessing the vault.'
      });
    }

    // Check if user is a member of the guild via Discord API
    try {
      const guildMemberResponse = await axios.get(
        `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${user.discord_id}`,
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
      );
      console.log('[Vault] check-access guild check OK for:', user.discord_id);

      // User has access
      return res.json({
        access: true,
        user: { id: user.id, username: user.username, discord_id: user.discord_id }
      });
    } catch (discordErr) {
      const status = discordErr.response?.status;
      console.log('[Vault] check-access Discord API error:', status, discordErr.message);
      if (status === 404) {
        return res.status(403).json({
          error: 'Not a guild member',
          message: 'You must be a member of our Discord server to access the vault.'
        });
      }
      // For 401 (bad token) or other errors — don't block the user, log and grant access
      // so a misconfigured BOT_TOKEN doesn't lock everyone out
      console.error('[Vault] Discord guild check failed with status', status, '— granting access anyway');
      return res.json({
        access: true,
        user: { id: user.id, username: user.username, discord_id: user.discord_id }
      });
    }
  } catch (err) {
    console.error('[Vault] check-access error:', err);
    res.status(500).json({ error: 'Failed to verify access' });
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
router.get('/', requireAuth, async (req, res) => {
  try {
    // Verify guild membership
    if (req.user.discord_id && req.user.discord_verified) {
      try {
        await axios.get(
          `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${req.user.discord_id}`,
          { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
        );
      } catch (discordErr) {
        if (discordErr.response?.status === 404) {
          return res.status(403).json({
            error: 'You must be a member of our Discord server to access the vault.'
          });
        }
      }
    } else {
      return res.status(403).json({
        error: 'You must link your Discord account on the main store before accessing the vault.'
      });
    }

    const { rows } = await query(
      `SELECT data FROM vault_data WHERE user_id = $1 AND guild_id = $2`,
      [req.user.id, GUILD_ID]
    );

    if (!rows.length) {
      // Return empty vault structure
      return res.json({
        cod: [],
        arc: [],
        sw: [],
        pk: [],
        personal_keys: []
      });
    }

    res.json(rows[0].data || {});
  } catch (err) {
    console.error('[Vault] GET error:', err);
    res.status(500).json({ error: 'Failed to load vault data' });
  }
});

// ─── POST /api/vault ──────────────────────────────────────────────────────
// Save/update the current user's vault data
// Body: { data: { cod: [...], arc: [...], sw: [...], pk: [...], personal_keys: [...] } }
router.post('/', requireAuth, async (req, res) => {
  try {
    // Verify guild membership
    if (req.user.discord_id && req.user.discord_verified) {
      try {
        await axios.get(
          `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${req.user.discord_id}`,
          { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
        );
      } catch (discordErr) {
        if (discordErr.response?.status === 404) {
          return res.status(403).json({
            error: 'You must be a member of our Discord server to access the vault.'
          });
        }
      }
    } else {
      return res.status(403).json({
        error: 'You must link your Discord account on the main store before accessing the vault.'
      });
    }

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
    res.status(500).json({ error: 'Failed to save vault data' });
  }
});

// ─── PATCH /api/vault/game/:gameKey ───────────────────────────────────────
// Update a specific game's data (cod, arc, sw, pk, personal_keys)
// Body: { items: [...] }
router.patch('/game/:gameKey', requireAuth, async (req, res) => {
  try {
    // Verify guild membership
    if (req.user.discord_id && req.user.discord_verified) {
      try {
        await axios.get(
          `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${req.user.discord_id}`,
          { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
        );
      } catch (discordErr) {
        if (discordErr.response?.status === 404) {
          return res.status(403).json({
            error: 'You must be a member of our Discord server to access the vault.'
          });
        }
      }
    } else {
      return res.status(403).json({
        error: 'You must link your Discord account on the main store before accessing the vault.'
      });
    }

    const { gameKey } = req.params;
    const { items } = req.body;

    const validKeys = ['cod', 'arc', 'sw', 'pk', 'personal_keys'];
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
        `SELECT data FROM vault_data WHERE user_id = $1 AND guild_id = $2`,
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
