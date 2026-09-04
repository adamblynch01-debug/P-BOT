'use strict';

const express = require('express');
const db = require('../db');
const { requireOwnerAdmin, bearerToken, getSessionUser } = require('../utils/auth');

const router = express.Router();
const GUILD_ID = process.env.GUILD_ID;

// The storefront is served by nginx, so a page visit never reaches this
// Express process automatically. The browser sends one lightweight beacon on
// load; attach the verified session user when there is one and retain an
// anonymous event for unusual/intruder traffic as well. No request body is
// accepted and the event is rate-limited by the client-side session marker.
router.post('/visit', async (req, res) => {
  try {
    const user = await getSessionUser(bearerToken(req));
    await db.query(
      `INSERT INTO user_activity
         (guild_id, user_id, event_type, ip_address, user_agent, metadata)
       VALUES ($1,$2,'website_visit',$3,$4,$5::jsonb)`,
      [GUILD_ID, user ? Number(user.id) : null,
        clean(req.ip || req.headers?.['x-forwarded-for'] || '', 64) || null,
        clean(req.headers?.['user-agent'] || '', 500) || null,
        JSON.stringify({ authenticated: !!user })]
    );
    return res.status(204).end();
  } catch (error) {
    if (error.code !== '42P01' && error.code !== '42703') console.warn('[Activity] visit log failed:', error.message);
    return res.status(204).end();
  }
});

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

router.get('/admin', requireOwnerAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(250, Number.parseInt(req.query.limit, 10) || 100));
  const type = clean(req.query.type || '', 80);
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.event_type, a.ip_address, a.user_agent, a.metadata,
              a.created_at, a.user_id, COALESCE(u.username, 'Unknown user') AS username
         FROM user_activity a
         LEFT JOIN web_users u ON u.id = a.user_id
        WHERE a.guild_id = $1 AND ($2 = '' OR a.event_type = $2)
        ORDER BY a.created_at DESC LIMIT $3`, [GUILD_ID, type, limit]
    );
    return res.json({ activity: rows.map((row) => ({
      id: Number(row.id), event_type: clean(row.event_type, 80), user_id: row.user_id ? Number(row.user_id) : null,
      username: clean(row.username, 100), ip_address: clean(row.ip_address, 64) || null,
      user_agent: clean(row.user_agent, 500) || null, metadata: row.metadata || {}, created_at: row.created_at,
    })) });
  } catch (error) {
    if (error.code === '42P01') return res.status(503).json({ error: 'Activity logging migration is not installed yet' });
    console.error('[Activity] admin list failed:', error.message);
    return res.status(500).json({ error: 'Could not load activity log' });
  }
});

router.delete('/admin', requireOwnerAdmin, async (_req, res) => {
  try {
    const result = await db.query('DELETE FROM user_activity WHERE guild_id = $1', [GUILD_ID]);
    return res.json({ success: true, deleted: Number(result.rowCount) || 0 });
  } catch (error) {
    if (error.code === '42P01') return res.status(503).json({ error: 'Activity logging migration is not installed yet' });
    return res.status(500).json({ error: 'Could not clear activity log' });
  }
});

module.exports = router;
