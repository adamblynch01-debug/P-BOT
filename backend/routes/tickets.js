const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth, requireAdmin, requireOwnerAdmin, attachUser, botAuthorized, botAuthUnavailable } = require('../utils/auth');
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

// ─── Discord bridge ─────────────────────────────────────
// Tell the bot a ticket exists and remember where it put it. The bot answers
// with the channel and message id of the post it made, which is what lets a
// later reply land under the same post instead of starting a new one.
//
// Deliberately awaited and deliberately wrapped: the ticket is already
// committed by this point, so a Discord outage must not turn a successfully
// filed ticket into a 500 for the customer. What it may do is leave
// discord_message_id null — and announceTicket is written so that a reply to
// such a ticket re-announces it rather than silently going nowhere.
async function announceTicket(ticket, extra = {}) {
  try {
    const ack = await notifyBot('new_ticket', {
      ticket_id: String(ticket.id),
      username: ticket.name || ticket.username || 'customer',
      email: ticket.email || null,
      category: ticket.category || null,
      priority: ticket.priority || 'normal',
      subject: ticket.subject || null,
      body: extra.body || null,
      // Only set for the HWID path. The bot uses it to add the key/product
      // fields to the embed; a plain support ticket has no such block.
      hwid: extra.hwid || null,
    });
    const channelId = ack && ack.channel_id;
    const messageId = ack && ack.message_id;
    if (!channelId || !messageId) return null;

    await query(
      'UPDATE web_tickets SET discord_channel_id = $1, discord_message_id = $2 WHERE id = $3',
      [String(channelId), String(messageId), ticket.id]
    );
    return { channelId: String(channelId), messageId: String(messageId) };
  } catch (err) {
    console.error('[Tickets] Discord announce failed for ticket', ticket && ticket.id, '-', err.message);
    return null;
  }
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

    // Staff should hear about a new ticket without polling, and be able to
    // answer it where they already are. This used to be a fire-and-forget
    // notify to an event the bot had no route for.
    await announceTicket(
      {
        id: ticket.id,
        name: clip(name, MAX_SHORT) || req.user.username,
        email: clip(email, MAX_SHORT) || req.user.email,
        category: clip(category, MAX_SHORT),
        priority: pri,
        subject: clip(subject, MAX_SHORT),
      },
      { body }
    );

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

// ─── GET /api/tickets/admin/pending-clear ───────────────
// What CLEAR TICKETS is about to destroy, so the confirmation can name it. An
// "are you sure?" that cannot say how many OPEN customer tickets are in the
// pile is not really a question.
router.get('/admin/pending-clear', requireOwnerAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status <> 'closed')::int AS unresolved
         FROM web_tickets WHERE guild_id = $1`,
      [GUILD_ID]
    );
    res.json({ total: rows[0].total, unresolved: rows[0].unresolved });
  } catch (err) {
    res.status(500).json({ error: 'Failed to count tickets' });
  }
});

// ─── POST /api/tickets/admin/clear ──────────────────────
// The admin panel's CLEAR TICKETS button had NO backend at all: it removed a
// localStorage key called 'ghostTickets' that nothing has read since tickets
// became real rows, then re-rendered from the API — so the scary confirmation
// destroyed nothing and the list came back unchanged. Same shape as every
// other "unconditional success" bug in this codebase: the UI existed, the
// feature never did.
//
// requireOwnerAdmin, not requireAdmin — requireAdmin admits role 'staff', and
// staff are edit/hide only. web_ticket_messages goes with it by ON DELETE
// CASCADE (see migrations/tickets.sql).
//
// `only_closed` is the default because wiping an OPEN ticket throws away a
// conversation a paying customer is still waiting on. Passing
// { only_closed: false } does what the button's warning text says.
router.post('/admin/clear', requireOwnerAdmin, async (req, res) => {
  try {
    const onlyClosed = req.body && req.body.only_closed === false ? false : true;
    const { rowCount } = await query(
      onlyClosed
        ? `DELETE FROM web_tickets WHERE guild_id = $1 AND status = 'closed'`
        : `DELETE FROM web_tickets WHERE guild_id = $1`,
      [GUILD_ID]
    );
    console.log(`[Tickets] ${req.user.username} cleared ${rowCount} ${onlyClosed ? 'closed ' : ''}ticket(s)`);
    res.json({ success: true, deleted: rowCount, only_closed: onlyClosed });
  } catch (err) {
    console.error('[Tickets] Clear failed:', err.message);
    res.status(500).json({ error: 'Failed to clear tickets' });
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

    // Mirror the customer's side of the conversation into Discord. Staff
    // replies are NOT mirrored: they either came from the panel (where the
    // person is already looking at the thread) or from the Discord button
    // itself, and echoing the latter back would double-post it.
    if (role === 'client') {
      if (ticket.discord_message_id) {
        notifyBot('ticket_reply', {
          ticket_id: String(ticket.id),
          channel_id: String(ticket.discord_channel_id || ''),
          message_id: String(ticket.discord_message_id),
          author: req.user.username,
          body,
        }).catch(() => {});
      } else {
        // The original announce never landed — the bot was down or being
        // redeployed when the ticket was filed. Re-announce rather than post a
        // reply to nothing, so the conversation still becomes visible.
        announceTicket(ticket, { body }).catch(() => {});
      }
    }

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

    // A HWID reset IS a support request, so it opens a real ticket too.
    //
    // Before this it wrote web_hwid_requests and stopped there: the customer
    // saw a success toast and then had nothing to look at — no entry under
    // "Your Tickets", no way to add "actually it's the other PC", and no thread
    // for staff to answer in. The only surface was the admin panel's HWID list,
    // and the notify it sent ('new_hwid_request') had no route on the bot.
    //
    // The two rows have different jobs and both are kept: the request row holds
    // the license key and the approve/deny state the HWID tab works from; the
    // ticket holds the conversation. hwid_request_id joins them.
    const reqRow = rows[0];
    const summary = [
      `**HWID reset requested**`,
      `Product: ${clip(product, MAX_SHORT) || '—'}`,
      `License key: ${key}`,
      `Reason: ${clip(reason, MAX_BODY) || '—'}`,
    ].join('\n');

    let ticket = null;
    try {
      const { rows: tRows } = await query(
        `INSERT INTO web_tickets (guild_id, web_user_id, name, email, category, priority, subject, status, hwid_request_id)
         VALUES ($1,$2,$3,$4,'HWID Reset','normal',$5,'open',$6)
         RETURNING id, created_at`,
        [
          GUILD_ID, req.user.id, req.user.username,
          clip(email, MAX_SHORT) || req.user.email,
          `HWID Reset — ${clip(product, MAX_SHORT) || 'license'}`,
          reqRow.id,
        ]
      );
      ticket = tRows[0];
      await query(
        `INSERT INTO web_ticket_messages (ticket_id, author_user_id, author_name, role, body)
         VALUES ($1,$2,$3,'client',$4)`,
        [ticket.id, req.user.id, req.user.username, summary]
      );
    } catch (err) {
      // The reset request itself is already safely recorded. Losing the ticket
      // costs visibility, not the request — so it is reported, not thrown.
      console.error('[Tickets] could not open a ticket for HWID request', reqRow.id, '-', err.message);
    }

    if (ticket) {
      await announceTicket(
        {
          id: ticket.id,
          name: req.user.username,
          email: clip(email, MAX_SHORT) || req.user.email,
          category: 'HWID Reset',
          priority: 'normal',
          subject: `HWID Reset — ${clip(product, MAX_SHORT) || 'license'}`,
        },
        {
          body: clip(reason, MAX_BODY) || null,
          hwid: {
            request_id: String(reqRow.id),
            product: clip(product, MAX_SHORT) || null,
            license_key: key,
          },
        }
      );
    }

    res.status(201).json({
      success: true,
      request_id: String(reqRow.id),
      ticket_id: ticket ? String(ticket.id) : null,
    });
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

// ─── Bot-authenticated ticket actions ───────────────────
//
// The half of the bridge that runs the other way: staff press Reply or Close on
// the embed in the ticket-log channel and the bot calls these. They cannot use
// requireAuth — the bot has no session, it holds API_SECRET — so they are
// separate paths rather than a role carve-out inside the session routes, which
// is what would have made it possible to reach a session route without a
// session.
//
// botAuthorized compares in constant time and returns false when API_SECRET is
// unset, so an unconfigured deploy refuses rather than accepting everyone.
function requireBot(req, res, next) {
  if (botAuthUnavailable()) {
    return res.status(503).json({ error: 'API_SECRET is not configured on the backend' });
  }
  if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── POST /api/tickets/bot/:id/reply ────────────────────
router.post('/bot/:id/reply', requireBot, async (req, res) => {
  try {
    const body = clip(req.body && req.body.body, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'A message is required' });

    const { rows } = await query(
      'SELECT * FROM web_tickets WHERE id = $1 AND guild_id = $2',
      [req.params.id, GUILD_ID]
    );
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.status === 'closed') return res.status(400).json({ error: 'This ticket is closed' });

    // author_user_id is left NULL on purpose. The replier is a Discord member,
    // not necessarily a web_users row, and inventing one would create an
    // account nobody can log into. The name is what the customer sees; the
    // Discord id is kept in the name for traceability only when supplied.
    const author = clip(req.body && req.body.author_name, MAX_SHORT) || 'Support';
    await query(
      `INSERT INTO web_ticket_messages (ticket_id, author_user_id, author_name, role, body)
       VALUES ($1, NULL, $2, 'staff', $3)`,
      [ticket.id, author, body]
    );
    await query(
      `UPDATE web_tickets SET updated_at = now(), status = 'pending' WHERE id = $1`,
      [ticket.id]
    );

    res.status(201).json({ success: true, ticket_id: String(ticket.id) });
  } catch (err) {
    console.error('[Tickets] bot reply error:', err);
    res.status(500).json({ error: 'Failed to post reply' });
  }
});

// ─── POST /api/tickets/bot/:id/status ───────────────────
router.post('/bot/:id/status', requireBot, async (req, res) => {
  try {
    const status = String((req.body && req.body.status) || '');
    if (!['open', 'pending', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'status must be open, pending, or closed' });
    }
    const actor = clip(req.body && req.body.actor, MAX_SHORT) || 'Support';

    const { rows } = await query(
      'UPDATE web_tickets SET status = $1, updated_at = now() WHERE id = $2 AND guild_id = $3 RETURNING id, hwid_request_id',
      [status, req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });

    // A closed ticket that the customer can still see needs to say who closed
    // it and when, otherwise it just stops responding with no explanation.
    if (status === 'closed') {
      await query(
        `INSERT INTO web_ticket_messages (ticket_id, author_user_id, author_name, role, body)
         VALUES ($1, NULL, $2, 'staff', $3)`,
        [rows[0].id, actor, 'This ticket has been closed by support.']
      );
    }
    res.json({ success: true, status });
  } catch (err) {
    console.error('[Tickets] bot status error:', err);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// ─── GET /api/tickets/bot/:id ───────────────────────────
// Read a ticket plus its transcript, so the Discord side can show the
// conversation so far instead of only the opening message.
router.get('/bot/:id', requireBot, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM web_tickets WHERE id = $1 AND guild_id = $2',
      [req.params.id, GUILD_ID]
    );
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const { rows: msgs } = await query(
      `SELECT author_name, role, body, created_at FROM web_ticket_messages
        WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT 50`,
      [ticket.id]
    );
    res.json({
      ticket: {
        ...ticket,
        id: String(ticket.id),
        web_user_id: ticket.web_user_id != null ? String(ticket.web_user_id) : null,
        hwid_request_id: ticket.hwid_request_id != null ? String(ticket.hwid_request_id) : null,
      },
      messages: msgs,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

// ─── POST /api/tickets/bot/hwid/:id/status ──────────────
// Approve or deny a HWID reset from Discord, and tell the customer in the
// ticket — the two rows are kept in step here so the website view of the
// request never disagrees with what staff actually did.
router.post('/bot/hwid/:id/status', requireBot, async (req, res) => {
  try {
    const status = String((req.body && req.body.status) || '');
    if (!['pending', 'approved', 'denied'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending, approved, or denied' });
    }
    const actor = clip(req.body && req.body.actor, MAX_SHORT) || 'Support';

    const { rows } = await query(
      `UPDATE web_hwid_requests SET status = $1, handled_by = $2, handled_at = now()
        WHERE id = $3 AND guild_id = $4 RETURNING id`,
      [status, actor, req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });

    const { rows: linked } = await query(
      'SELECT id FROM web_tickets WHERE hwid_request_id = $1 AND guild_id = $2',
      [req.params.id, GUILD_ID]
    );
    for (const t of linked) {
      await query(
        `INSERT INTO web_ticket_messages (ticket_id, author_user_id, author_name, role, body)
         VALUES ($1, NULL, $2, 'staff', $3)`,
        [t.id, actor,
         status === 'approved'
           ? 'Your HWID reset has been approved. Re-launch the loader and it will bind to this machine.'
           : status === 'denied'
             ? 'Your HWID reset request was denied. Reply here if you think this is a mistake.'
             : 'Your HWID reset request has been re-opened.'],
      );
      await query(
        `UPDATE web_tickets SET updated_at = now(), status = $2 WHERE id = $1`,
        [t.id, status === 'pending' ? 'open' : 'pending']
      );
    }
    res.json({ success: true, status, tickets_updated: linked.length });
  } catch (err) {
    console.error('[Tickets] bot hwid status error:', err);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

module.exports = router;
