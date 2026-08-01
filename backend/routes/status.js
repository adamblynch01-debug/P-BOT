const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAdmin, getSessionUser, bearerToken, botAuthorized } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// The website product statuses, in display order.
const STATUSES = ['undetected', 'testing', 'updating', 'detected'];

// ─── GET /api/status ─────────────────────────────────────
// Per-product status (fixes the old localStorage page only showing
// categories, not individual products). product_status overrides win when
// present; otherwise falls back to the product's own `status` column so a
// product never has to be touched twice to show up here.
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT p.id AS product_id, p.game_name, p.name AS product_name,
              COALESCE(ps.status, p.status) AS status, ps.note, COALESCE(ps.updated_at, p.updated_at) AS updated_at
       FROM products p
       LEFT JOIN product_status ps ON ps.product_id = p.id
       WHERE p.guild_id = $1 AND p.hidden = false AND p.vault = false
       ORDER BY p.game_name ASC, p.sort_order DESC`,
      [GUILD_ID]
    );
    res.json({
      statuses: rows.map(r => ({
        product_id: String(r.product_id),
        game_name: r.game_name,
        product_name: r.product_name,
        status: r.status,
        note: r.note,
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ─── GET /api/status/vault ───────────────────────────────
// Vault-side product status (vault = true). Backs the /post-status-vault bot
// command and any vault status view. Same shape as GET /.
router.get('/vault', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT p.id AS product_id, p.game_name, p.name AS product_name,
              COALESCE(ps.status, p.status) AS status, ps.note, COALESCE(ps.updated_at, p.updated_at) AS updated_at
       FROM products p
       LEFT JOIN product_status ps ON ps.product_id = p.id
       WHERE p.guild_id = $1 AND p.hidden = false AND p.vault = true
       ORDER BY p.game_name ASC, p.sort_order DESC`,
      [GUILD_ID]
    );
    res.json({
      statuses: rows.map(r => ({
        product_id: String(r.product_id),
        game_name: r.game_name,
        product_name: r.product_name,
        status: r.status,
        note: r.note,
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch vault status' });
  }
});

// ─── POST /api/status/update ─────────────────────────────
// Bot (/statusupdate) and admin panel both write through this — API_SECRET
// covers the bot, requireAdmin covers a logged-in website admin.
router.post('/update', async (req, res) => {
  try {
    const { product_id, game_name, product_name, status, note } = req.body;
    const isBot = botAuthorized(req);
    if (!isBot) {
      const user = await getSessionUser(bearerToken(req));
      if (!user || !['admin', 'staff'].includes(user.role)) return res.status(401).json({ error: 'Unauthorized' });
    }
    // 'testing' is the fourth status — a product that is up but not yet
    // signed off. This list is the ONLY validation there is (neither
    // products.status nor product_status.status carries a CHECK constraint),
    // so anything the site or the bot can pick has to be named here.
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }

    let gname = game_name, pname = product_name, pid = product_id || null;
    if (pid && (!gname || !pname)) {
      const { rows } = await query('SELECT game_name, name FROM products WHERE id = $1 AND guild_id = $2', [pid, GUILD_ID]);
      if (rows[0]) { gname = rows[0].game_name; pname = rows[0].name; }
    }
    if (!gname || !pname) return res.status(400).json({ error: 'product_id or (game_name and product_name) required' });

    await query(
      `INSERT INTO product_status (guild_id, product_id, game_name, product_name, status, note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (guild_id, game_name, product_name)
       DO UPDATE SET status = $5, note = $6, updated_by = $7, updated_at = now(), product_id = COALESCE(EXCLUDED.product_id, product_status.product_id)`,
      [GUILD_ID, pid, gname, pname, status, note || null, isBot ? 'bot' : 'website']
    );
    if (pid) await query('UPDATE products SET status = $1, updated_at = now() WHERE id = $2', [status, pid]);

    res.json({ success: true });
  } catch (err) {
    console.error('[Status] Update error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ─── GET / POST /api/status/panel ────────────────────────
// Where the bot last posted its live status panel. /post-status used to be a
// snapshot: it rendered the statuses once and left a message that was wrong
// the moment anything changed, so the only way to correct it was to post the
// whole thing again. The bot now edits those messages in place instead — but
// it can only do that if it still knows which messages they are, and its own
// memory does not survive a redeploy. So it keeps them here.
//
// Bot-only, both directions. This is the bot's bookkeeping about its own
// messages; nothing on the website reads or writes it.
//
// Stored in app_state rather than a table of its own so this needs no
// migration — one row per guild holding one small JSON object. `kind` keys it
// ('status' today, 'vault' if that panel ever wants the same treatment) so a
// second panel does not need a second key.
const PANEL_KEY = 'ghostStatusPanel';

async function readPanels() {
  const { rows } = await query(
    `SELECT value FROM app_state WHERE guild_id = $1 AND scope = 'global' AND owner_id = '' AND key = $2`,
    [GUILD_ID, PANEL_KEY]
  );
  const v = rows[0] && rows[0].value;
  return v && typeof v === 'object' ? v : {};
}

router.get('/panel', async (req, res) => {
  try {
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const panels = await readPanels();
    const kind = String(req.query.kind || 'status');
    res.json({ panel: panels[kind] || null, panels });
  } catch (err) {
    console.error('[Status] panel read error:', err);
    res.status(500).json({ error: 'Failed to read panel' });
  }
});

router.post('/panel', async (req, res) => {
  try {
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const kind = String((req.body && req.body.kind) || 'status');
    const panels = await readPanels();

    // A null/absent channel_id means "forget this panel" — the bot sends that
    // when the messages have been deleted out from under it, so it stops
    // trying to edit something that is gone.
    if (!req.body || !req.body.channel_id) {
      delete panels[kind];
    } else {
      panels[kind] = {
        channel_id: String(req.body.channel_id),
        message_ids: Array.isArray(req.body.message_ids) ? req.body.message_ids.map(String) : [],
        updated_at: new Date().toISOString(),
      };
    }

    await query(
      `INSERT INTO app_state (guild_id, scope, owner_id, key, value)
       VALUES ($1,'global','',$2,$3)
       ON CONFLICT (guild_id, scope, owner_id, key) DO UPDATE SET value = $3, updated_at = now()`,
      [GUILD_ID, PANEL_KEY, JSON.stringify(panels)]
    );
    res.json({ success: true, panel: panels[kind] || null });
  } catch (err) {
    console.error('[Status] panel write error:', err);
    res.status(500).json({ error: 'Failed to save panel' });
  }
});

module.exports = router;
