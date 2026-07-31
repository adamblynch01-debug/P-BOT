const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth, requireAdmin, getSessionUser, bearerToken, botAuthorized, botAuthUnavailable, discordLinked } = require('../utils/auth');
const { notifyBot } = require('../utils/botNotify');

const GUILD_ID = process.env.GUILD_ID;

// Bot (secret) and admin panel (logged-in admin/staff session) both moderate
// reviews — same dual-gate pattern as routes/status.js and routes/products.js.
async function requireAdminOrBot(req, res, next) {
  if (botAuthorized(req)) return next();
  const user = await getSessionUser(bearerToken(req));
  if (user && ['admin', 'staff'].includes(user.role)) { req.user = user; return next(); }
  return res.status(401).json({ error: 'Unauthorized' });
}

// A website vouch is only worth anything to the store if it reaches the
// #vouches channel, so the post is fired from here rather than left to the
// admin panel. Sending it is deliberately fire-and-forget: the review is
// already committed, and a Discord outage must not turn a saved vouch into a
// 500 the customer reads as "it didn't work".
function postVouchToDiscord(review) {
  notifyBot('web_review', {
    guild_id: GUILD_ID,
    review: {
      id: String(review.id),
      display_name: review.display_name,
      rating: review.rating,
      body: review.body,
      product_id: review.product_id ? String(review.product_id) : null,
      discord_id: review.discord_id || null,
    },
  }).catch(() => {});
}

// ─── GET /api/reviews ────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, display_name, rating, body, source, product_id, created_at
       FROM reviews WHERE guild_id = $1 AND approved = true ORDER BY created_at DESC LIMIT 200`,
      [GUILD_ID]
    );
    res.json({ reviews: rows.map(r => ({ ...r, id: String(r.id), product_id: r.product_id ? String(r.product_id) : null })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// ─── POST /api/reviews ───────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { rating, body, product_id } = req.body;
    const r = parseInt(rating, 10);
    if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'rating must be 1-5' });

    // A vouch from an account whose Discord is verified goes live immediately
    // and posts itself to #vouches — that account belongs to a real member who
    // can be found and, if it turns out to be abuse, removed. Everything else
    // still waits for a human in the admin panel; the alternative is a public
    // channel any signup can write into.
    const live = discordLinked(req.user);

    const { rows } = await query(
      `INSERT INTO reviews (guild_id, web_user_id, display_name, product_id, rating, body, source, discord_id, approved)
       VALUES ($1,$2,$3,$4,$5,$6,'website',$7,$8) RETURNING *`,
      [GUILD_ID, req.user.id, req.user.username, product_id || null, r, body || null,
       req.user.discord_id || null, live]
    );
    if (live) postVouchToDiscord(rows[0]);
    res.json({
      success: true,
      approved: live,
      // The storefront says either "thanks, it's live" or "thanks, it's waiting
      // for review" — guessing wrong in either direction reads as a bug.
      pending: !live,
      review: { ...rows[0], id: String(rows[0].id) },
    });
  } catch (err) {
    console.error('[Reviews] Create error:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// ─── GET /api/reviews/admin/all ──────────────────────────
router.get('/admin/all', requireAdminOrBot, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM reviews WHERE guild_id = $1 ORDER BY created_at DESC`,
      [GUILD_ID]
    );
    res.json({ reviews: rows.map(r => ({ ...r, id: String(r.id) })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// ─── PATCH /api/reviews/:id/approve ──────────────────────
router.patch('/:id/approve', requireAdminOrBot, async (req, res) => {
  try {
    const { approved } = req.body;
    const makeApproved = approved !== false;

    // Guard the UPDATE on the *prior* approved state so a row is only returned
    // on an actual transition — this makes the Discord vouch post fire exactly
    // once, never again on repeated approve toggles.
    const { rows } = await query(
      `UPDATE reviews SET approved = $1
       WHERE id = $2 AND guild_id = $3 AND approved IS DISTINCT FROM $1
       RETURNING *`,
      [makeApproved, req.params.id, GUILD_ID]
    );
    // No transition (already in that state) — still a success, just nothing to do.
    if (!rows.length) return res.json({ success: true, unchanged: true });

    const review = rows[0];
    // Newly approved + came from the website → post it as a Discord vouch.
    // Discord-sourced reviews are already visible in the server, so skip those.
    if (makeApproved && review.source === 'website') postVouchToDiscord(review);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update review' });
  }
});

// ─── DELETE /api/reviews/:id ──────────────────────────────
router.delete('/:id', requireAdminOrBot, async (req, res) => {
  try {
    await query('DELETE FROM reviews WHERE id = $1 AND guild_id = $2', [req.params.id, GUILD_ID]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// ─── POST /api/reviews/bot ───────────────────────────────
// SUPERBOT pushes Discord-posted vouches here (secret-gated). Stored with
// source='discord' and auto-approved (a staff member already vouched in the
// server), so they surface on the website immediately. Idempotent on
// (guild_id, source, external_id) when the bot supplies a message id.
router.post('/bot', async (req, res) => {
  try {
    const { display_name, rating, body, product_id, external_id, discord_id } = req.body;
    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const r = parseInt(rating, 10) || 5;
    if (r < 1 || r > 5) return res.status(400).json({ error: 'rating must be 1-5' });
    if (!display_name) return res.status(400).json({ error: 'display_name is required' });

    if (external_id) {
      const { rows: dup } = await query(
        `SELECT id FROM reviews WHERE guild_id = $1 AND source = 'discord' AND external_id = $2`,
        [GUILD_ID, String(external_id)]
      );
      if (dup.length) return res.json({ success: true, deduped: true, id: String(dup[0].id) });
    }

    const { rows } = await query(
      `INSERT INTO reviews (guild_id, display_name, product_id, rating, body, source, external_id, discord_id, approved)
       VALUES ($1,$2,$3,$4,$5,'discord',$6,$7,true) RETURNING *`,
      [GUILD_ID, display_name, product_id || null, r, body || null, external_id ? String(external_id) : null, discord_id || null]
    );
    res.json({ success: true, review: { ...rows[0], id: String(rows[0].id) } });
  } catch (err) {
    console.error('[Reviews] Bot create error:', err);
    res.status(500).json({ error: 'Failed to sync review' });
  }
});

module.exports = router;
