// Password hashing (Node's built-in scrypt — no native module, unlike bcrypt)
// and web_sessions-backed bearer tokens for the storefront's real accounts.
'use strict';

const crypto = require('crypto');
const { query } = require('../db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer (.+)$/i);
  return m ? m[1] : (req.body && req.body.token) || (req.query && req.query.token) || null;
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

function publicUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    username: row.username,
    email: row.email,
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
  attachUser, requireAuth, requireAdmin, publicUser,
};
