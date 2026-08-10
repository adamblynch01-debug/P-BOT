const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { requireAuth, requireAdmin } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

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
router.get('/', requireAuth, async (req, res) => {
  try {
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
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid data format' });
    }

    const now = new Date().toISOString();

    await withTransaction(async (exec) => {
      // Upsert: insert or update
      const id = `vault_${req.user.id}_${GUILD_ID}`;
      await exec(
        `INSERT INTO vault_data (id, user_id, guild_id, data, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, guild_id)
         DO UPDATE SET data = $4, updated_at = $5`,
        [id, req.user.id, GUILD_ID, JSON.stringify(data), now]
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
      const id = `vault_${req.user.id}_${GUILD_ID}`;
      await exec(
        `INSERT INTO vault_data (id, user_id, guild_id, data, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, guild_id)
         DO UPDATE SET data = $4, updated_at = $5`,
        [id, req.user.id, GUILD_ID, JSON.stringify(currentData), now]
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
