const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth, requireAdmin, attachUser } = require('../utils/auth');
const { notifyBot } = require('../utils/botNotify');

const GUILD_ID = process.env.GUILD_ID;

// ─── Support tickets and HWID reset requests ────────────────────────
// See migrations/tickets.sql for why these moved off app_state.
//
// The ownership rule throughout: web_user_id comes from the SESSION, never
// from the request body. The old client-side records carried a `userId` field
// the browser filled in, which would have let anyone file — or read — under
// someone else's id once this became a real endpoint.

const MAX_BODY = 4000;
const MAX_SHORT = 200;

function clip(v, max) {
  const s = v == null ? '' : String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function ownsOrAdmin(user, row) {
  if (!user || !row) return false;
  if (['admin', 'staff'].includes(user.role)) return true;
  return row.web_user_id != null && String(row.web_user_id) === String(user.id);
}

// ─── POST /api/tickets ──────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { category, priority, subject, message, name, email } = req.body;
    const body = clip(message, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'A message is required' });

    const pri = ['low', 'normal', 'high', 'urgent'].includes(String(priority))
      ? String(priority) : 'normal';

    const { rows } = await query(
      `INSERT INTO web_tickets (guild_id, web_user_id, name, email, category, priority, subject, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open')
       RETURNING id, created_at`,
      [
        GUILD_ID, req.user.id,
        clip(name, MAX_SHORT) || req.user.username,
        clip(email, MAX_SHORT) || req.user.email,
        clip(category, MAX_SHORT), pri, clip(subject, MAX_SHORT),
      ]
    );
    const ticket = rows[0];

    await query(
      `INSERT INTO web_ticket_messages (ticket_id, author_user_id, author_name, role, body)
       VALUES ($1,$2,$3,'client',$4)`,
      [ticket.id, req.user.id, req.user.username, body]
    );

    // Best-effort: staff should hear about a new ticket without polling.
    notifyBot('new_ticket', {
      ticket_id: String(ticket.id),
      username: req.user.username,
      category: clip(category, MAX_SHORT),
      priority: pri,
    }).catch(() => {});

    res.status(201).json({ success: true, ticket_id: String(ticket.id), created_at: ticket.created_at });
  } catch (err) {
    console.error('[Tickets] create error:', err);
    res.status(500).json({ error: 'Failed to submit ticket' });
  }
});

// ─── GET /api/tickets/mine ──────────────────────────────
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*,
              (SELECT COUNT(*)::int FROM web_ticket_messages m WHERE m.ticket_id = t.id) AS message_count
         FROM web_tickets t
        WHERE t.guild_id = $1 AND t.web_user_id = $2
        ORDER BY t.created_at DESC LIMIT 100`,
      [GUILD_ID, req.user.id]
    );
    res.json({ tickets: rows.map(r => ({ ...r, id: String(r.id), web_user_id: String(r.web_user_id) })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// ─── GET /api/tickets ───────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, u.username,
              (SELECT COUNT(*)::int FROM web_ticket_messages m WHERE m.ticket_id = t.id) AS message_count
         FROM web_tickets t LEFT JOIN web_users u ON u.id = t.web_user_id
        WHERE t.guild_id = $1
        ORDER BY (t.status = 'open') DESC, t.updated_at DESC LIMIT 500`,
      [GUILD_ID]
    );
    res.json({
      tickets: rows.map(r => ({
        ...r, id: String(r.id),
        web_user_id: r.web_user_id != null ? String(r.web_user_id) : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// ─── GET /api/tickets/:id ───────────────────────────────
// Owner or staff. A non-owner gets 404 rather than 403 so ticket ids are not
// probeable for existence.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM web_tickets WHERE id = $1 AND guild_id = $2',
      [req.params.id, GUILD_ID]
    );
    const ticket = rows[0];
    if (!ticket || !ownsOrAdmin(req.user, ticket)) return res.status(404).json({ error: 'Ticket not found' });

    const { rows: msgs } = await query(
      `SELECT id, author_name, role, body, created_at FROM web_ticket_messages
        WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [ticket.id]
    );
    res.json({
      ticket: { ...ticket, id: String(ticket.id), web_user_id: ticket.web_user_id != null ? String(ticket.web_user_id) : null },
      messages: msgs.map(m => ({ ...m, id: String(m.id) })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

// ─── POST /api/tickets/:id/messages ─────────────────────
// One row per reply, so two staff replying at once no longer overwrite each
// other the way the single-JSON-blob app_state row did.
router.post('/:id/messages', requireAuth, async (req, res) => {
  try {
    const body = clip(req.body && req.body.body, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'A message is required' });

    const { rows } = await query(
      'SELECT * FROM web_tickets WHERE id = $1 AND guild_id = $2',
      [req.params.id, GUILD_ID]
    );
    const ticket = rows[0];
    if (!ticket || !ownsOrAdmin(req.user, ticket)) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.status === 'closed') return res.status(400).json({ error: 'This ticket is closed' });

    const role = ['admin', 'staff'].includes(req.user.role) ? 'staff' : 'client';
    const { rows: ins } = await query(
      `INSERT INTO web_ticket_messages (ticket_id, author_user_id, author_name, role, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [ticket.id, req.user.id, req.user.username, role, body]
    );
    await query(
      `UPDATE web_tickets SET updated_at = now(), status = CASE WHEN $2 = 'staff' THEN 'pending' ELSE 'open' END
        WHERE id = $1`,
      [ticket.id, role]
    );
    res.status(201).json({ success: true, message_id: String(ins[0].id), created_at: ins[0].created_at });
  } catch (err) {
    res.status(500).json({ error: 'Failed to post reply' });
  }
});

// ─── POST /api/tickets/:id/status ───────────────────────
router.post('/:id/status', requireAdmin, async (req, res) => {
  try {
    const status = String((req.body && req.body.status) || '');
    if (!['open', 'pending', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'status must be open, pending, or closed' });
    }
    const { rows } = await query(
      'UPDATE web_tickets SET status = $1, updated_at = now() WHERE id = $2 AND guild_id = $3 RETURNING id',
      [status, req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// ─── HWID reset requests ────────────────────────────────

// ─── POST /api/tickets/hwid ─────────────────────────────
router.post('/hwid/request', requireAuth, async (req, res) => {
  try {
    const { product, license_key, reason, email } = req.body;
    const key = clip(license_key, MAX_SHORT);
    if (!key) return res.status(400).json({ error: 'A license key is required' });

    const { rows } = await query(
      `INSERT INTO web_hwid_requests (guild_id, web_user_id, username, email, product, license_key, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
       RETURNING id, created_at`,
      [
        GUILD_ID, req.user.id, req.user.username,
        clip(email, MAX_SHORT) || req.user.email,
        clip(product, MAX_SHORT), key, clip(reason, MAX_BODY),
      ]
    );

    notifyBot('new_hwid_request', {
      request_id: String(rows[0].id),
      username: req.user.username,
      product: clip(product, MAX_SHORT),
    }).catch(() => {});

    res.status(201).json({ success: true, request_id: String(rows[0].id) });
  } catch (err) {
    console.error('[Tickets] hwid request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ─── GET /api/tickets/hwid/mine ─────────────────────────
router.get('/hwid/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM web_hwid_requests WHERE guild_id = $1 AND web_user_id = $2
        ORDER BY created_at DESC LIMIT 100`,
      [GUILD_ID, req.user.id]
    );
    res.json({ requests: rows.map(r => ({ ...r, id: String(r.id) })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// ─── GET /api/tickets/hwid/all ──────────────────────────
router.get('/hwid/all', requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT h.*, u.username AS account_username FROM web_hwid_requests h
       LEFT JOIN web_users u ON u.id = h.web_user_id
        WHERE h.guild_id = $1
        ORDER BY (h.status = 'pending') DESC, h.created_at DESC LIMIT 500`,
      [GUILD_ID]
    );
    res.json({ requests: rows.map(r => ({ ...r, id: String(r.id) })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// ─── POST /api/tickets/hwid/:id/status ──────────────────
router.post('/hwid/:id/status', requireAdmin, async (req, res) => {
  try {
    const status = String((req.body && req.body.status) || '');
    if (!['pending', 'approved', 'denied'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending, approved, or denied' });
    }
    const { rows } = await query(
      `UPDATE web_hwid_requests SET status = $1, handled_by = $2, handled_at = now()
        WHERE id = $3 AND guild_id = $4 RETURNING id`,
      [status, req.user.username, req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update request' });
  }
});

module.exports = router;
