// Password hashing (Node's built-in scrypt — no native module, unlike bcrypt)
// and web_sessions-backed bearer tokens for the storefront's real accounts.
'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const { safeCompare } = require('./rateLimit');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Shared-secret gate for the bot and the watchers.
//
// Every call site used to spell this as `req.body.secret === process.env.API_SECRET`,
// which is `undefined === undefined` — TRUE — whenever the variable is missing
// from the environment. A single bad deploy or a rotation that deletes before
// it re-adds therefore opened stock claiming, order confirmation, wallet
// credit and catalog writes to anonymous callers. routes/config.js and
// routes/auth.js were fixed individually; this helper exists so no route can
// get it wrong again. Returns false when the secret is unset, and compares in
// constant time.
function botAuthorized(req) {
  const expected = process.env.API_SECRET;
  if (!expected) return false;
  const given = (req.body && req.body.secret) || (req.query && req.query.secret);
  if (!given) return false;
  return safeCompare(given, expected);
}

// True when API_SECRET is missing entirely, so a route can answer 503 (server
// misconfigured) instead of 401 (your secret is wrong) — the two are very
// different for whoever is debugging a deploy.
function botAuthUnavailable() {
  return !process.env.API_SECRET;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function createSession(webUserId, guildId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO web_sessions (token, web_user_id, guild_id, created_at, expires_at)
     VALUES ($1,$2,$3, now(), $4)`,
    [token, webUserId, guildId, expiresAt]
  );
  return token;
}

async function getSessionUser(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.*, b.balance_cents
     FROM web_sessions s
     JOIN web_users u ON u.id = s.web_user_id
     LEFT JOIN balances b ON b.web_user_id = u.id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return rows[0] || null;
}

// Session token from the Authorization header, or the request body.
//
// A `?token=` query fallback used to be accepted too. A 30-day session token
// in a URL ends up in proxy access logs, browser history and the Referer
// header sent to any third-party asset on the page — so an admin token could
// leak without anyone doing anything wrong. Nothing in the frontend or the bot
// ever sent it that way (both use the Bearer header), so the fallback was pure
// exposure and is gone.
function bearerToken(req) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer (.+)$/i);
  return m ? m[1] : (req.body && req.body.token) || null;
}

// Attaches req.user if a valid session token is present; never blocks the
// request. Use requireAuth/requireAdmin below to actually enforce login.
async function attachUser(req, res, next) {
  try {
    req.user = await getSessionUser(bearerToken(req));
  } catch {
    req.user = null;
  }
  next();
}

async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await getSessionUser(bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    if (!['admin', 'staff'].includes(user.role)) return res.status(403).json({ error: 'Admin only' });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

// ─── Discord link gate ───────────────────────────────────────────────────────
// Every part of this store that happens AFTER the money — delivery, support,
// replacements, disputes, the vouch — happens in Discord. An order placed by an
// account with no verified Discord id therefore has no reachable owner: the
// goods land in a web account nobody can be pinged about, and a refund request
// arrives with nothing to tie it to. Requiring the link before the purchase,
// rather than chasing it afterwards, is the only point where refusing is free.
//
// `discord_verified` is what matters, not `discord_id` alone. The id can be
// typed into a profile field by anyone; only the OAuth round-trip sets the flag
// (see routes/auth.js confirm-discord and the partial unique index in
// migrations/discord_link_unique.sql), so an unverified id is a claim, not a
// link.
function discordLinked(user) {
  return !!(user && user.discord_id && user.discord_verified);
}

// 403 + a machine-readable code, because the storefront has to tell this apart
// from every other refusal: it is the one error whose fix is a button (start
// the OAuth flow) rather than a message.
async function requireDiscordLinked(req, res, next) {
  if (discordLinked(req.user)) return next();
  return res.status(403).json({
    error: 'Link your Discord account before purchasing',
    code: 'discord_link_required',
  });
}

// Stricter gate for the routes that can hand out authority or move money:
// role changes, password resets, account deletion, wallet adjustment.
//
// requireAdmin deliberately accepts 'staff' so moderators can manage the
// catalog, stock and reviews. Applying that same gate to /admin/set-role made
// 'staff' equivalent to owner — a staff account could POST its own id with
// role 'admin', or demote the real owner, or reset the owner's password and
// take the account. Splitting the two means 'staff' is finally a real
// lower-privilege tier rather than one request away from full control.
async function requireOwnerAdmin(req, res, next) {
  try {
    const user = await getSessionUser(bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    if (user.role !== 'admin') return res.status(403).json({ error: 'Owner admin only' });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    username: row.username,
    email: row.email,
    // The column has always existed; nothing ever surfaced it, so the
    // storefront kept the chosen avatar in localStorage and lost it on any
    // other device.
    avatar: row.avatar || null,
    // Null unless the account uploaded a picture, so every consumer keeps the
    // emoji above as its fallback and nothing had to change to stay correct.
    // The ?v= is not decoration: GET /api/auth/avatar/:id is served
    // immutable-for-a-year, and this counter is the only reason that is safe.
    //
    // `> 0`, not `!= 0`: a deleted picture parks the counter on the negative
    // side to keep the high-water mark without claiming a picture still exists
    // (see migrations/user_avatars.sql). This is derived from the row rather
    // than from a lookup because publicUser() is handed rows by a dozen
    // different `SELECT u.*` and `RETURNING *` queries — anything it needs has
    // to already be on the row, or it goes null everywhere except one route.
    avatar_url: Number(row.avatar_version) > 0
      ? `/api/auth/avatar/${row.id}?v=${row.avatar_version}`
      : null,
    role: row.role,
    discord_id: row.discord_id,
    discord_verified: row.discord_verified,
    banned: row.banned,
    balance_cents: row.balance_cents != null ? Number(row.balance_cents) : 0,
    created_at: row.created_at,
  };
}

module.exports = {
  hashPassword, verifyPassword, createSession, getSessionUser, bearerToken,
  attachUser, requireAuth, requireAdmin, requireOwnerAdmin, publicUser,
  discordLinked, requireDiscordLinked,
  botAuthorized, botAuthUnavailable,
};
