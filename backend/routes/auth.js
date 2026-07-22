const express = require('express');
const router = express.Router();
const { query } = require('../db');
const {
  hashPassword, verifyPassword, createSession, requireAuth, requireAdmin, publicUser,
} = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// ─── POST /api/auth/signup ──────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const { rows: existing } = await query(
      `SELECT id FROM web_users WHERE guild_id = $1 AND (lower(username) = lower($2) OR lower(email) = lower($3))`,
      [GUILD_ID, username, email]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'Username or email already in use' });
    }

    const password_hash = hashPassword(password);
    const { rows } = await query(
      `INSERT INTO web_users (guild_id, username, email, password_hash, last_login_at)
       VALUES ($1,$2,$3,$4, now()) RETURNING *`,
      [GUILD_ID, username, email, password_hash]
    );
    const user = rows[0];
    await query(
      `INSERT INTO balances (web_user_id, guild_id, balance_cents) VALUES ($1,$2,0)`,
      [user.id, GUILD_ID]
    );

    const token = await createSession(user.id, GUILD_ID);
    res.json({ success: true, token, user: publicUser({ ...user, balance_cents: 0 }) });
  } catch (err) {
    console.error('[Auth] Signup error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// ─── POST /api/auth/login ───────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const { rows } = await query(
      `SELECT u.*, b.balance_cents FROM web_users u
       LEFT JOIN balances b ON b.web_user_id = u.id
       WHERE u.guild_id = $1 AND (lower(u.username) = lower($2) OR lower(u.email) = lower($2))`,
      [GUILD_ID, username]
    );
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (user.banned) return res.status(403).json({ error: 'This account has been banned' });

    await query('UPDATE web_users SET last_login_at = now() WHERE id = $1', [user.id]);

    const token = await createSession(user.id, GUILD_ID);
    res.json({ success: true, token, user: publicUser(user) });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

// ─── GET /api/auth/me ────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ─── POST /api/auth/logout ───────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const { bearerToken } = require('../utils/auth');
    const token = bearerToken(req);
    if (token) await query('DELETE FROM web_sessions WHERE token = $1', [token]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log out' });
  }
});

// ─── POST /api/auth/confirm-discord ─────────────────────
// Called by the website once SUPERBOT's existing /api/auth/verify-token
// flow reports verified:true for this discord_id, so we don't duplicate
// that 2FA challenge/session machinery here — just persist the outcome.
router.post('/confirm-discord', requireAuth, async (req, res) => {
  try {
    const { discord_id } = req.body;
    if (!discord_id) return res.status(400).json({ error: 'discord_id is required' });
    await query(
      `UPDATE web_users SET discord_id = $1, discord_verified = true WHERE id = $2`,
      [discord_id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to link Discord' });
  }
});

// ─── POST /api/auth/set-role ─────────────────────────────
// Admin bootstrap / role management — gated by the same API_SECRET used
// everywhere else in this backend rather than requireAdmin, so the very
// first admin can be promoted with no existing admin account yet.
router.post('/set-role', async (req, res) => {
  try {
    const { secret, username, role } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!['member', 'staff', 'admin', 'reseller'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const { rows } = await query(
      `UPDATE web_users SET role = $1 WHERE guild_id = $2 AND lower(username) = lower($3) RETURNING id, username, role`,
      [role, GUILD_ID, username]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set role' });
  }
});

// ─── POST /api/auth/ban ──────────────────────────────────
router.post('/ban', async (req, res) => {
  try {
    const { secret, username, banned } = req.body;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    const { rows } = await query(
      `UPDATE web_users SET banned = $1 WHERE guild_id = $2 AND lower(username) = lower($3) RETURNING id, username, banned`,
      [!!banned, GUILD_ID, username]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ban state' });
  }
});

// ─── GET /api/auth/admin/users ───────────────────────────
// Admin panel user list — reads the real web_users table (replaces the old
// localStorage `ghostUsers`). Passwords are scrypt-hashed and NEVER returned;
// "view login" is no longer possible by design, so the panel shows metadata
// and offers a reset instead.
router.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.username, u.email, u.role, u.discord_id, u.discord_verified,
              u.banned, u.created_at, u.last_login_at, COALESCE(b.balance_cents, 0) AS balance_cents
       FROM web_users u
       LEFT JOIN balances b ON b.web_user_id = u.id
       WHERE u.guild_id = $1
       ORDER BY u.created_at DESC`,
      [GUILD_ID]
    );
    res.json({
      users: rows.map(r => ({
        id: String(r.id),
        username: r.username,
        email: r.email,
        role: r.role,
        discord_id: r.discord_id,
        discord_verified: r.discord_verified,
        banned: r.banned,
        created_at: r.created_at,
        last_login_at: r.last_login_at,
        balance: Number(r.balance_cents) / 100,
      })),
    });
  } catch (err) {
    console.error('[Auth] Admin users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── POST /api/auth/admin/reset-password ─────────────────
// Admin sets a new password for a user by id. Hashes it, and invalidates all
// of that user's sessions so the old credentials stop working immediately.
router.post('/admin/reset-password', requireAdmin, async (req, res) => {
  try {
    const { user_id, new_password } = req.body;
    if (!user_id || !new_password) return res.status(400).json({ error: 'user_id and new_password are required' });
    if (String(new_password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const password_hash = hashPassword(String(new_password));
    const { rows } = await query(
      `UPDATE web_users SET password_hash = $1 WHERE id = $2 AND guild_id = $3 RETURNING id, username`,
      [password_hash, user_id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await query('DELETE FROM web_sessions WHERE web_user_id = $1', [user_id]);
    res.json({ success: true, user: { id: String(rows[0].id), username: rows[0].username } });
  } catch (err) {
    console.error('[Auth] Admin reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── POST /api/auth/admin/set-role ───────────────────────
// Session-gated (admin) counterpart to the secret-gated /set-role above, by
// user id, so the panel can promote/demote without the API_SECRET.
router.post('/admin/set-role', requireAdmin, async (req, res) => {
  try {
    const { user_id, role } = req.body;
    if (!['member', 'staff', 'admin', 'reseller'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const { rows } = await query(
      `UPDATE web_users SET role = $1 WHERE id = $2 AND guild_id = $3 RETURNING id, username, role`,
      [role, user_id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: { ...rows[0], id: String(rows[0].id) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set role' });
  }
});

// ─── POST /api/auth/admin/ban ────────────────────────────
router.post('/admin/ban', requireAdmin, async (req, res) => {
  try {
    const { user_id, banned } = req.body;
    const { rows } = await query(
      `UPDATE web_users SET banned = $1 WHERE id = $2 AND guild_id = $3 RETURNING id, username, banned`,
      [!!banned, user_id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    if (banned) await query('DELETE FROM web_sessions WHERE web_user_id = $1', [user_id]);
    res.json({ success: true, user: { ...rows[0], id: String(rows[0].id) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ban state' });
  }
});

// ─── DELETE /api/auth/admin/user/:id ─────────────────────
router.delete('/admin/user/:id', requireAdmin, async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    const { rows } = await query(
      `DELETE FROM web_users WHERE id = $1 AND guild_id = $2 RETURNING id`,
      [req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
