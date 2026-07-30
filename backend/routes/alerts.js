const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAdmin, botAuthorized, botAuthUnavailable, getSessionUser, bearerToken } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// ─── Operational alert queue ────────────────────────────────────────
// raiseAlert() has always written to ops_alerts, and the migration comment
// calls the row "the real alert" — but nothing ever read it back. No route, no
// bot command, no admin screen. So a `delivery_incomplete` alert (a customer
// who PAID and got nothing, with their confirmation email deliberately
// suppressed) landed in a table no human could reach, and the only other trace
// was a Railway stdout line that scrolls away.
//
// This is that read path. Staff can see the queue, and acknowledge an alert
// once it has been dealt with.

// Admin session OR the bot's shared secret, so /alerts works from Discord even
// when the storefront is down.
async function adminOrBot(req, res, next) {
  if (botAuthorized(req)) return next();
  try {
    const user = await getSessionUser(bearerToken(req));
    if (user && ['admin', 'staff'].includes(user.role)) { req.user = user; return next(); }
  } catch { /* fall through */ }
  return res.status(401).json({ error: 'Unauthorized' });
}

function mapAlert(r) {
  return {
    id: String(r.id),
    kind: r.kind,
    severity: r.severity,
    message: r.message,
    context: r.context,
    order_id: r.order_id,
    created_at: r.created_at,
    acknowledged_at: r.acknowledged_at,
    acknowledged_by: r.acknowledged_by,
  };
}

// ─── GET /api/alerts ────────────────────────────────────
// Open alerts by default; ?all=1 includes acknowledged ones.
router.get('/', adminOrBot, async (req, res) => {
  try {
    const all = req.query.all === '1' || req.query.all === 'true';
    const { rows } = await query(
      `SELECT * FROM ops_alerts
        WHERE (guild_id = $1 OR guild_id IS NULL)
          ${all ? '' : 'AND acknowledged_at IS NULL'}
        ORDER BY created_at DESC LIMIT 200`,
      [GUILD_ID]
    );
    res.json({ alerts: rows.map(mapAlert) });
  } catch (err) {
    console.error('[Alerts] list error:', err);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// ─── GET /api/alerts/count ──────────────────────────────
// Cheap badge poll for the admin panel.
router.get('/count', adminOrBot, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int AS open,
         COUNT(*) FILTER (WHERE severity = 'error')::int AS errors
       FROM ops_alerts
        WHERE (guild_id = $1 OR guild_id IS NULL) AND acknowledged_at IS NULL`,
      [GUILD_ID]
    );
    res.json({ open: rows[0].open, errors: rows[0].errors });
  } catch (err) {
    res.status(500).json({ error: 'Failed to count alerts' });
  }
});

// ─── POST /api/alerts/:id/ack ───────────────────────────
router.post('/:id/ack', adminOrBot, async (req, res) => {
  try {
    const who = (req.user && req.user.username) || 'bot';
    const { rows } = await query(
      `UPDATE ops_alerts SET acknowledged_at = now(), acknowledged_by = $1
        WHERE id = $2 AND acknowledged_at IS NULL
        RETURNING id`,
      [who, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Alert not found or already acknowledged' });
    res.json({ success: true, acknowledged_by: who });
  } catch (err) {
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

module.exports = router;
