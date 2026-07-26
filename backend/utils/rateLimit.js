const crypto = require('crypto');

// In-memory rate limiter.
//
// Deliberately NOT express-rate-limit: this backend runs at numReplicas 1 on
// Railway, so process-local counters ARE the complete picture and a dependency
// buys nothing. IF A SECOND REPLICA IS EVER ADDED this silently degrades to
// per-replica limits — an attacker gets `max * replicas` attempts — so move to
// a shared store (Redis, or a Postgres table) before scaling out. Same applies
// to a restart: counters reset, which is acceptable for a 24-char secret but
// would not be for a 6-digit code.
//
// Counters live in a Map keyed by client IP. Every limiter self-prunes on a
// timer so a spray of one-shot IPs can't grow the map without bound.

const MAX_TRACKED_KEYS = 50000;

// Behind Railway's proxy req.ip is only meaningful once `trust proxy` is set
// (see server.js). Without it every request looks like the same edge address
// and the per-IP limiter would behave as a global one — safe direction to fail,
// but it would lock out real users, so server.js sets it.
function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

/**
 * @param {object}  opts
 * @param {number}  opts.windowMs  Length of the counting window.
 * @param {number}  opts.max       Allowed requests per IP per window.
 * @param {number} [opts.globalMax] Optional ceiling across ALL IPs in the same
 *   window. Per-IP limits alone do nothing against a botnet rotating addresses,
 *   which matters for endpoints that are pure guess-oracles (panel/vault
 *   unlock). Leave unset for endpoints where a shared ceiling would let one
 *   abuser deny service to everyone (login/signup).
 * @param {string} [opts.name]     Label used in the 429 log line.
 */
function rateLimit({ windowMs, max, globalMax, name = 'endpoint' }) {
  const hits = new Map(); // ip -> { count, resetAt }
  let global = { count: 0, resetAt: 0 };

  // .unref() so this timer never keeps the process alive on shutdown.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 60000));
  if (typeof sweep.unref === 'function') sweep.unref();

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = clientKey(req);

    // Hard backstop: if the map is somehow saturated between sweeps, drop the
    // expired entries immediately rather than growing further.
    if (hits.size >= MAX_TRACKED_KEYS) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (globalMax) {
      if (global.resetAt <= now) global = { count: 0, resetAt: now + windowMs };
      global.count += 1;
    }

    const overIp = entry.count > max;
    const overGlobal = !!globalMax && global.count > globalMax;

    if (overIp || overGlobal) {
      const resetAt = overGlobal ? global.resetAt : entry.resetAt;
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      console.warn(
        `[RateLimit] ${name}: blocked ${overGlobal ? 'GLOBAL' : key} ` +
        `(${overGlobal ? global.count : entry.count} in window), retry in ${retryAfter}s`
      );
      return res.status(429).json({
        error: 'Too many attempts. Please wait and try again.',
        retry_after: retryAfter,
      });
    }

    return next();
  };
}

/**
 * Constant-time string compare.
 *
 * crypto.timingSafeEqual throws when the buffers differ in length, and passing
 * raw input straight to it would also leak the secret's length through timing.
 * Hashing both sides to a fixed 32 bytes first sidesteps both problems: the
 * comparison is always over equal-length buffers and reveals nothing about the
 * length or content of either operand.
 */
function safeCompare(a, b) {
  if (a == null || b == null) return false;
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { rateLimit, safeCompare };
