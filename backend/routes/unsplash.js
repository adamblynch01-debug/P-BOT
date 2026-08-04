// ─── Unsplash search proxy ───────────────────────────────────────────────────
//
// The storefront's profile-picture picker searches Unsplash live. It could do
// that straight from the browser — Unsplash allows it and their own examples
// do it — but the storefront is a static file the owner uploads by hand, so
// the access key would be sitting in view-source on a public page. Anyone
// could lift it and spend the app's quota, and rotating it would mean
// re-uploading the site.
//
// So the key lives here, in an env var, and the browser talks to us.
//
// Three things this does that a direct fetch cannot:
//
//  1. **Caching.** A demo Unsplash app gets 50 requests an HOUR. Not fifty per
//     user — fifty. Two people typing "cyberpunk" is one upstream request, and
//     the default views (the chips in the picker) are answered from memory
//     almost always. Without this the feature breaks for everyone the moment a
//     handful of customers open the modal.
//
//  2. **A real answer when the quota is gone.** Unsplash returns 403 with a
//     rate-limit header, which as a bare proxy would surface as "failed to
//     load photos" — indistinguishable from being broken. We report it as what
//     it is, with the reset time.
//
//  3. **The download trigger.** Unsplash's API terms require that using a photo
//     pings its `download_location`. It is not optional and it is the usual
//     reason keys get revoked. The browser cannot be trusted to do it (ad
//     blockers eat third-party calls), so we do it server-side.
'use strict';

const express = require('express');
const axios = require('axios');
const { requireAuth } = require('../utils/auth');
const { rateLimit } = require('../utils/rateLimit');

const router = express.Router();

const UNSPLASH_API = 'https://api.unsplash.com';
const ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || '';
const PER_PAGE = 24;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 400;

// UTM parameters are required by the API terms on every link back to Unsplash.
// The value is the application name as registered with them.
const UTM = 'utm_source=uhservices&utm_medium=referral';

// ─── Cache ───────────────────────────────────────────────────────────────────
// Keyed on the exact query+page, because that is exactly what varies. Insertion
// ordered, oldest evicted first — a Map iterates in insertion order, so the
// first key is the oldest and no timestamp sort is needed.
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { cache.delete(key); return null; }
  // Refresh position so a popular query is not evicted by a burst of one-offs.
  cache.delete(key); cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ─── Quota ───────────────────────────────────────────────────────────────────
// Unsplash reports what is left on every response. Remembering it means we can
// answer "there is nothing left until 14:00" without spending a request to
// find that out — which would be the last one.
let quota = { remaining: null, limit: null, resetAt: null };

function noteQuota(headers) {
  const rem = headers && headers['x-ratelimit-remaining'];
  const lim = headers && headers['x-ratelimit-limit'];
  if (rem != null && rem !== '') quota.remaining = Number(rem);
  if (lim != null && lim !== '') quota.limit = Number(lim);
  // Unsplash's window is the clock hour; they send no reset header, so the top
  // of the next hour is the honest estimate rather than a made-up countdown.
  const now = new Date();
  quota.resetAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0).toISOString();
}

// Only the fields the picker renders. Unsplash's photo object is ~40 keys deep
// with EXIF and location on it; forwarding all of that would put a stranger's
// GPS coordinates through our API for no reason and make the response 20× the
// size it needs to be.
function slimPhoto(p) {
  const u = p.urls || {};
  const user = p.user || {};
  return {
    id: p.id,
    thumb: u.thumb,
    small: u.small,
    // What actually gets cropped into the avatar. `regular` is ~1080px wide —
    // plenty for a 512px square, and a fraction of `full`.
    full: u.regular,
    blurHash: p.blur_hash || null,
    color: p.color || null,
    width: p.width, height: p.height,
    alt: p.alt_description || p.description || '',
    author: {
      name: user.name || user.username || 'Unknown',
      username: user.username || '',
      // Attribution link, UTM-tagged as the terms require.
      link: user.username ? `https://unsplash.com/@${encodeURIComponent(user.username)}?${UTM}` : '',
    },
    link: p.links && p.links.html ? `${p.links.html}?${UTM}` : '',
  };
}

function notConfigured(res) {
  return res.status(503).json({
    error: 'Photo search is not configured on this server.',
    detail: 'UNSPLASH_ACCESS_KEY is not set.',
  });
}

// The limiter counts every request because every MISS costs one of fifty per
// hour. It sits above the cache deliberately: a client hammering the same
// query is cheap for us but is still a client that should slow down.
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, name: 'unsplash-search' });

// GET /api/unsplash/search?q=cyberpunk&page=2
//
// requireAuth, because this endpoint spends a shared, small, paid-for quota.
// Open to the world it is a free Unsplash proxy, and the fifty requests an hour
// would belong to whoever found it first rather than to customers.
router.get('/search', requireAuth, searchLimiter, async (req, res) => {
  if (!ACCESS_KEY) return notConfigured(res);

  const q = String(req.query.q || '').trim().slice(0, 80);
  const page = Math.min(20, Math.max(1, parseInt(req.query.page, 10) || 1));
  if (!q) return res.status(400).json({ error: 'A search term is required.' });

  // Case and spacing do not change the results, so they must not split the
  // cache: "Cyber Punk" and "cyberpunk " are the same upstream request.
  const key = `${q.toLowerCase().replace(/\s+/g, ' ')}::${page}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const r = await axios.get(`${UNSPLASH_API}/search/photos`, {
      params: {
        query: q, page, per_page: PER_PAGE,
        // Portraits and square-ish shots crop into a circular avatar without
        // losing the subject; a panorama does not.
        orientation: 'squarish',
        content_filter: 'high',
      },
      headers: { Authorization: `Client-ID ${ACCESS_KEY}`, 'Accept-Version': 'v1' },
      timeout: 12_000,
      validateStatus: () => true,
    });

    noteQuota(r.headers);

    if (r.status === 403) {
      return res.status(429).json({
        error: 'Photo search has used up its hourly allowance.',
        resetAt: quota.resetAt,
        quota,
      });
    }
    if (r.status === 401) {
      console.error('[Unsplash] 401 — the access key was rejected.');
      return res.status(502).json({ error: 'Photo search is misconfigured — the access key was rejected.' });
    }
    if (r.status >= 400 || !r.data) {
      return res.status(502).json({ error: 'Photo search is unavailable right now.' });
    }

    const results = (r.data.results || []).map(slimPhoto).filter(p => p.small && p.full);
    const payload = {
      query: q,
      page,
      totalPages: Math.min(20, r.data.total_pages || 0),
      total: r.data.total || 0,
      results,
      quota,
    };
    // An empty page is cached too. "No results for asdfgh" is a stable fact,
    // and re-asking upstream every time someone mistypes is how the hour's
    // allowance disappears.
    cacheSet(key, payload);
    res.json(payload);
  } catch (err) {
    console.error('[Unsplash] search failed:', err.message);
    res.status(502).json({ error: 'Photo search is unavailable right now.' });
  }
});

// POST /api/unsplash/used  { id }
//
// Required by the Unsplash API terms: when a photo is actually used, its
// download endpoint must be pinged. This is what credits the photographer, and
// skipping it is the most common reason an app's key is revoked.
//
// Fire-and-forget from the caller's point of view — it always answers 200,
// because a customer's avatar must not fail to save over a statistics ping.
router.post('/used', requireAuth, async (req, res) => {
  const id = String((req.body && req.body.id) || '').trim();
  res.json({ ok: true });
  if (!ACCESS_KEY || !id || !/^[A-Za-z0-9_-]{5,32}$/.test(id)) return;
  try {
    await axios.get(`${UNSPLASH_API}/photos/${encodeURIComponent(id)}/download`, {
      headers: { Authorization: `Client-ID ${ACCESS_KEY}`, 'Accept-Version': 'v1' },
      timeout: 8_000,
      validateStatus: () => true,
    });
  } catch (err) {
    console.warn('[Unsplash] download ping failed for', id, '-', err.message);
  }
});

// GET /api/unsplash/status — is the feature on, and how much is left.
// The picker asks before it renders a search box, so a server without the key
// says so plainly instead of showing a box that always fails.
router.get('/status', (req, res) => {
  res.json({ configured: !!ACCESS_KEY, quota, cached: cache.size });
});

module.exports = router;
module.exports._internals = { slimPhoto, cacheGet, cacheSet, cache, noteQuota, quota };
