const express = require('express');
const axios = require('axios');
const router = express.Router();
const { query } = require('../db');
const { requireAuth, requireAdmin, getSessionUser, bearerToken, botAuthorized, botAuthUnavailable, discordLinked } = require('../utils/auth');
const { notifyBot } = require('../utils/botNotify');
const { decodeImageDataUrl } = require('../utils/imageUpload');

const GUILD_ID = process.env.GUILD_ID;

// Never `SELECT *` off this table any more — image_data is bytea, and a JSON
// response would carry every screenshot as a base64 blob on a list endpoint.
const REVIEW_COLS = `id, guild_id, web_user_id, display_name, product_id, rating, body,
                     source, external_id, discord_id, approved, created_at, image_url,
                     image_mime, (image_data IS NOT NULL) AS has_image`;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// A customer's own upload is held to a tighter budget than a Discord CDN fetch:
// the storefront downscales before sending, so anything near this ceiling is
// either an unresized phone photo or someone probing. It is the decoded size —
// the base64 body carrying it is a third larger again, which is what BODY_LIMIT
// below has to allow for.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const BODY_LIMIT = '6mb';

// Pull the picture down once, at sync time, instead of pointing the storefront
// at Discord's CDN. Those URLs are signed and expire within the day, so a
// stored link shows the image right up until the moment someone checks it
// again. Fetch failures are not errors: the vouch itself is the thing that
// matters, and image_url is kept so it can be retried later.
async function fetchImage(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: MAX_IMAGE_BYTES,
      maxRedirects: 3,
    });
    const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) {
      console.warn('[Reviews] vouch image is not an image:', mime || 'no content-type');
      return null;
    }
    const data = Buffer.from(res.data);
    if (!data.length || data.length > MAX_IMAGE_BYTES) return null;
    return { data, mime };
  } catch (err) {
    console.warn('[Reviews] vouch image download failed:', err.message);
    return null;
  }
}

// What the storefront should put in <img src>. Our own copy when we have one,
// the original link as a last resort so a failed download still shows
// something while it lasts.
function imageSrc(req, row) {
  if (row.has_image) return `${req.protocol}://${req.get('host')}/api/reviews/${row.id}/image`;
  return row.image_url || null;
}

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
function postVouchToDiscord(review, imageUrl) {
  notifyBot('web_review', {
    guild_id: GUILD_ID,
    review: {
      id: String(review.id),
      display_name: review.display_name,
      rating: review.rating,
      body: review.body,
      product_id: review.product_id ? String(review.product_id) : null,
      discord_id: review.discord_id || null,
      image_url: imageUrl || null,
    },
  }).catch(() => {});
}

// ─── GET /api/reviews ────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, display_name, rating, body, source, product_id, created_at,
              image_url, (image_data IS NOT NULL) AS has_image
       FROM reviews WHERE guild_id = $1 AND approved = true ORDER BY created_at DESC LIMIT 200`,
      [GUILD_ID]
    );
    res.json({
      reviews: rows.map(r => ({
        id: String(r.id),
        display_name: r.display_name,
        rating: r.rating,
        body: r.body,
        source: r.source,
        product_id: r.product_id ? String(r.product_id) : null,
        created_at: r.created_at,
        image: imageSrc(req, r),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// ─── POST /api/reviews ───────────────────────────────────
// This route parses its own body: server.js exempts it from the global 100kb
// express.json() so a screenshot can come with the review in one request.
// Doing it in one request is the point — a vouch that reaches #vouches without
// the picture the customer attached, because the image was a second call that
// arrived late, is worse than no picture at all.
// requireAuth runs BEFORE the parser on purpose. It reads only the bearer
// header, so it needs no body — and putting it first means an anonymous caller
// cannot make the process buffer six megabytes before being told to log in.
router.post('/', requireAuth, express.json({ limit: BODY_LIMIT }), async (req, res) => {
  try {
    const { rating, body, product_id, image } = req.body;
    const r = parseInt(rating, 10);
    if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'rating must be 1-5' });

    // Rejected before anything is written: a review saved without the image the
    // customer chose, with a warning they never see, reads as the upload having
    // silently failed — which is exactly what they would then report as a bug.
    const img = decodeImageDataUrl(image, MAX_UPLOAD_BYTES);
    if (img.error) return res.status(400).json({ error: img.error });

    // A vouch from an account whose Discord is verified goes live immediately
    // and posts itself to #vouches — that account belongs to a real member who
    // can be found and, if it turns out to be abuse, removed. Everything else
    // still waits for a human in the admin panel; the alternative is a public
    // channel any signup can write into.
    const live = discordLinked(req.user);

    const { rows } = await query(
      `INSERT INTO reviews (guild_id, web_user_id, display_name, product_id, rating, body, source, discord_id, approved,
                            image_data, image_mime)
       VALUES ($1,$2,$3,$4,$5,$6,'website',$7,$8,$9,$10) RETURNING ${REVIEW_COLS}`,
      [GUILD_ID, req.user.id, req.user.username, product_id || null, r, body || null,
       req.user.discord_id || null, live, img.data || null, img.mime || null]
    );
    // image_url stays null for an upload: there is no upstream link to retry,
    // our own copy IS the original. imageSrc() falls back to image_url only
    // when we have no bytes, so it resolves to our endpoint either way.
    if (live) postVouchToDiscord(rows[0], imageSrc(req, rows[0]));
    res.json({
      success: true,
      approved: live,
      // The storefront says either "thanks, it's live" or "thanks, it's waiting
      // for review" — guessing wrong in either direction reads as a bug.
      pending: !live,
      image_stored: !!img.data,
      review: { ...rows[0], id: String(rows[0].id), image: imageSrc(req, rows[0]) },
    });
  } catch (err) {
    console.error('[Reviews] Create error:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// ─── GET /api/reviews/:id/image ──────────────────────────
// Public and unauthenticated on purpose: it is the <img src> of a vouch that
// is already on the public storefront. Only approved reviews are served, so a
// screenshot attached to a queued vouch stays private until a human clears it.
router.get('/:id/image', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT image_data, image_mime, approved, web_user_id FROM reviews
       WHERE id = $1 AND guild_id = $2 AND image_data IS NOT NULL`,
      [req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).end();
    if (!rows[0].approved) {
      // Staff still need to see the picture they are being asked to publish, so
      // the moderation queue can load it. So does the customer who just
      // uploaded it — their own submission showing a broken image while it
      // waits for approval looks like the upload failed. Nobody else can.
      const user = await getSessionUser(bearerToken(req));
      const owner = user && rows[0].web_user_id && String(user.id) === String(rows[0].web_user_id);
      if (!(botAuthorized(req) || owner || (user && ['admin', 'staff'].includes(user.role)))) {
        return res.status(404).end();
      }
    }
    // The bytes for a given review id never change, so an approved one can be
    // cached hard. An unapproved one must NOT be: this response depends on who
    // asked, and a shared cache handed the staff-or-owner copy would serve it
    // to everyone from then on.
    res.set('Content-Type', rows[0].image_mime || 'image/png');
    res.set('Cache-Control', rows[0].approved
      ? 'public, max-age=31536000, immutable'
      : 'private, no-store');
    // Belt and braces with the signature check in utils/imageUpload.js: the
    // stored mime is derived from the file's own magic bytes, and this stops a
    // browser second-guessing it back into something executable.
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(rows[0].image_data);
  } catch (err) {
    res.status(500).end();
  }
});

// ─── GET /api/reviews/admin/all ──────────────────────────
router.get('/admin/all', requireAdminOrBot, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT ${REVIEW_COLS} FROM reviews WHERE guild_id = $1 ORDER BY created_at DESC`,
      [GUILD_ID]
    );
    // `image` is what /importvouches re-posts from, so it has to be an
    // absolute URL — the bot is a different service on a different host.
    res.json({ reviews: rows.map(r => ({ ...r, id: String(r.id), image: imageSrc(req, r) })) });
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
       RETURNING ${REVIEW_COLS}`,
      [makeApproved, req.params.id, GUILD_ID]
    );
    // No transition (already in that state) — still a success, just nothing to do.
    if (!rows.length) return res.json({ success: true, unchanged: true });

    const review = rows[0];
    // Newly approved + came from the website → post it as a Discord vouch.
    // Discord-sourced reviews are already visible in the server, so skip those.
    if (makeApproved && review.source === 'website') postVouchToDiscord(review, imageSrc(req, review));
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
    const { display_name, rating, body, product_id, external_id, discord_id, image_url } = req.body;
    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const r = parseInt(rating, 10) || 5;
    if (r < 1 || r > 5) return res.status(400).json({ error: 'rating must be 1-5' });
    if (!display_name) return res.status(400).json({ error: 'display_name is required' });

    if (external_id) {
      const { rows: dup } = await query(
        `SELECT id, image_url, (image_data IS NOT NULL) AS has_image FROM reviews
         WHERE guild_id = $1 AND source = 'discord' AND external_id = $2`,
        [GUILD_ID, String(external_id)]
      );
      if (dup.length) {
        // The screenshot usually arrives AFTER the vouch. The bot posts the
        // vouch, then waits up to a minute for the customer to drop an image
        // in the channel, then calls back here with the same external_id. So a
        // duplicate is not always a no-op: if this call is carrying a picture
        // the stored row does not have, that is the whole point of it.
        if (image_url && !dup[0].has_image) {
          const img = await fetchImage(image_url);
          await query(
            `UPDATE reviews SET image_url = $1, image_data = $2, image_mime = $3 WHERE id = $4`,
            [String(image_url), img ? img.data : null, img ? img.mime : null, dup[0].id]
          );
          return res.json({ success: true, deduped: true, image_added: !!img, id: String(dup[0].id) });
        }
        return res.json({ success: true, deduped: true, id: String(dup[0].id) });
      }
    }

    const img = image_url ? await fetchImage(image_url) : null;
    const { rows } = await query(
      `INSERT INTO reviews (guild_id, display_name, product_id, rating, body, source, external_id, discord_id, approved,
                            image_url, image_data, image_mime)
       VALUES ($1,$2,$3,$4,$5,'discord',$6,$7,true,$8,$9,$10) RETURNING ${REVIEW_COLS}`,
      [GUILD_ID, display_name, product_id || null, r, body || null,
       external_id ? String(external_id) : null, discord_id || null,
       image_url ? String(image_url) : null, img ? img.data : null, img ? img.mime : null]
    );
    res.json({
      success: true,
      image_stored: !!img,
      review: { ...rows[0], id: String(rows[0].id), image: imageSrc(req, rows[0]) },
    });
  } catch (err) {
    console.error('[Reviews] Bot create error:', err);
    res.status(500).json({ error: 'Failed to sync review' });
  }
});

module.exports = router;
