const crypto = require('crypto');

// In-memory rate limiting.
//
// Deliberately NOT express-rate-limit: this backend runs at numReplicas 1 on
// Railway, so process-local counters ARE the complete picture and a dependency
// buys nothing. IF A SECOND REPLICA IS EVER ADDED this silently degrades to
// per-replica limits — an attacker gets `max * replicas` attempts — so move to
// a shared store (Redis, or a Postgres table) before scaling out. Same applies
// to a restart: counters reset, which is acceptable for a 24-char secret but
// would not be for a 6-digit code.
//
// Two flavours are exported:
//
//   rateLimit()        — middleware that counts EVERY request. For endpoints
//                        where the request itself is the cost (signup creates a
//                        row, discord-login sends a real DM).
//
//   failureLimiter()   — for anything guarding a secret. The route verifies
//                        FIRST and only consults the limiter on the failure
//                        path, so a correct secret is never rate limited. That
//                        ordering is the point: /panel-unlock needs a global
//                        ceiling (a per-IP limit does nothing against rotating
//                        addresses), and any global ceiling checked before
//                        verification lets anyone on the internet lock staff
//                        out of the admin panel by spamming wrong guesses.
//                        Letting a correct secret through leaks nothing — the
//                        response already tells the caller whether it was right.

const MAX_TRACKED_KEYS = 50000;

// Behind Railway's proxy req.ip is only meaningful once `trust proxy` is set
// (see server.js). Without it every request looks like the same edge address
// and a per-IP limiter would behave as a global one — safe direction to fail,
// but it would lock out real users, so server.js sets it.
function clientKey(req) {
  return String((req && req.ip) || (req && req.socket && req.socket.remoteAddress) || 'unknown');
}

/**
 * Shared counter core.
 *
 * @param {number}  windowMs   Length of the counting window.
 * @param {number}  max        Allowed attempts per IP per window.
 * @param {number} [globalMax] Optional ceiling across ALL IPs in the same
 *   window. Per-IP limits alone do nothing against an attacker rotating
 *   addresses, which matters for endpoints that are pure guess-oracles. Only
 *   safe to set on a failure-counted limiter — on an every-request limiter a
 *   global ceiling lets one abuser deny service to everybody.
 */
function createCounter({ windowMs, max, globalMax, name = 'endpoint' }) {
  const hits = new Map(); // ip -> { count, resetAt }
  let global = { count: 0, resetAt: 0 };

  // .unref() so this timer never keeps the process alive on shutdown.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 60000));
  if (typeof sweep.unref === 'function') sweep.unref();

  function state(req, now) {
    const key = clientKey(req);
    const entry = hits.get(key);
    const ipCount = entry && entry.resetAt > now ? entry.count : 0;
    const globalCount = globalMax && global.resetAt > now ? global.count : 0;
    const overIp = ipCount >= max;
    const overGlobal = !!globalMax && globalCount >= globalMax;
    const resetAt = overGlobal ? global.resetAt : (entry ? entry.resetAt : now);
    return {
      key,
      blocked: overIp || overGlobal,
      overGlobal,
      count: overGlobal ? globalCount : ipCount,
      retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  function record(req, now) {
    const key = clientKey(req);
    // Hard backstop: if the map is saturated between sweeps, drop expired
    // entries immediately rather than growing further.
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
  }

  function reject(res, s) {
    res.set('Retry-After', String(s.retryAfter));
    console.warn(
      `[RateLimit] ${name}: blocked ${s.overGlobal ? 'GLOBAL' : s.key} ` +
      `(${s.count} in window), retry in ${s.retryAfter}s`
    );
    return res.status(429).json({
      error: 'Too many attempts. Please wait and try again.',
      retry_after: s.retryAfter,
    });
  }

  return { state, record, reject, _hits: hits };
}

/** Middleware that counts every request that reaches it. */
function rateLimit(opts) {
  const c = createCounter(opts);
  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    // Check before recording, so exactly `max` requests get through per window.
    const s = c.state(req, now);
    if (s.blocked) return c.reject(res, s);
    c.record(req, now);
    return next();
  };
}

/**
 * Failure-counted limiter for routes guarding a secret.
 *
 * Verify FIRST, then limit only the failures — never the other way round:
 *
 *   const ok = safeCompare(given, expected);
 *   if (ok) return res.json({ ok: true });     // correct secrets always pass
 *   if (guard.blocked(req, res)) return;       // sends the 429 itself
 *   guard.fail(req);
 *   return res.json({ ok: false });
 */
function failureLimiter(opts) {
  const c = createCounter(opts);
  return {
    blocked(req, res) {
      const s = c.state(req, Date.now());
      if (!s.blocked) return false;
      c.reject(res, s);
      return true;
    },
    fail(req) {
      c.record(req, Date.now());
    },
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

module.exports = { rateLimit, failureLimiter, safeCompare };
