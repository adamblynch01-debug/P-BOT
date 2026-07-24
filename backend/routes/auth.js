const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query } = require('../db');
const {
  hashPassword, verifyPassword, createSession, requireAuth, requireAdmin, publicUser,
} = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// SUPERBOT (Discord 2FA server) base URL — same service the storefront's 2FA
// modal talks to, but here we call it server-to-server so the browser never
// mediates the trust decision.
const SUPERBOT_URL = process.env.SUPERBOT_URL || 'https://superbot-production-fcd7.up.railway.app';

// In-memory map for passwordless Discord login: the SUPERBOT verification
// session id (pending_id) → the web_user id we'll mint a token for once that
// DM is confirmed. Lives only in this process (Railway single instance). The
// browser is given pending_id but NEVER the user id or email, and can't forge
// a login because only the real Discord account owner can click Authenticate
// in the DM — that's what flips SUPERBOT's verify-token to verified.
const discordLoginPending = new Map();
function reapDiscordPending() {
  const now = Date.now();
  for (const [id, v] of discordLoginPending) if (v.expiresAt < now) discordLoginPending.delete(id);
}

// Shared by both login paths (typed Discord ID + OAuth callback): given a real,
// trusted Discord user id, look up the linked+verified web_users row and ask
// SUPERBOT to DM it an Authenticate button. Returns an opaque pending_id the
// browser can poll — never the account email/id. Returns { pending_id } on a
// decoy too (unknown/banned account) so nothing is enumerable; only a real
// linked account actually receives the DM.
async function beginDiscordLogin(discordId) {
  const id = String(discordId).trim();
  const { rows } = await query(
    `SELECT id, email, username, banned FROM web_users
     WHERE guild_id = $1 AND discord_id = $2 AND discord_verified = true`,
    [GUILD_ID, id]
  );
  const user = rows[0];
  if (!user || user.banned) {
    return { pending_id: require('crypto').randomUUID(), decoy: true };
  }
  const sb = await axios.post(`${SUPERBOT_URL}/api/auth/initiate-2fa`, {
    email: user.email,
    discordId: id,
  });
  const sbSessionId = sb.data && sb.data.userId;
  if (!sbSessionId) throw new Error('Verification service did not start a session.');
  discordLoginPending.set(sbSessionId, { webUserId: user.id, expiresAt: Date.now() + 10 * 60 * 1000 });
  return { pending_id: sbSessionId };
}

// ─── Discord OAuth login (passwordless, no typed ID) ─────
// The storefront is a static page (Cloudflare Pages at uhservices.xyz), so the
// OAuth client secret can't live there — the whole exchange happens here on
// the backend. Flow:
//   1. Browser → GET /discord-oauth/start?return_to=<origin>
//   2. We redirect to Discord's authorize page (scope=identify only).
//   3. Discord → GET /discord-oauth/callback?code&state
//   4. We swap the code for a token, read the REAL discord id from /users/@me
//      (the browser never gets to assert its own id), start the DM 2FA, then
//      bounce the browser back to the storefront with ?discord_login=<pending_id>
//      so the existing poll loop finishes the login on the DM click.
const OAUTH_CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BACKEND_PUBLIC_URL = (process.env.BACKEND_PUBLIC_URL || 'https://captivating-happiness-production-c944.up.railway.app').replace(/\/$/, '');
const OAUTH_REDIRECT_URI = `${BACKEND_PUBLIC_URL}/api/auth/discord-oauth/callback`;
// Origins the callback is allowed to redirect the browser back to. Prevents an
// attacker from using our OAuth start as an open redirect. First entry is the
// default when no valid return_to is supplied.
const STOREFRONT_ORIGINS = (process.env.STOREFRONT_ORIGINS || 'https://uhservices.xyz,https://www.uhservices.xyz')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const oauthStates = new Map(); // state → { returnTo, expiresAt }
function reapOauthStates() {
  const now = Date.now();
  for (const [s, v] of oauthStates) if (v.expiresAt < now) oauthStates.delete(s);
}
function pickReturnTo(raw) {
  if (raw) {
    try {
      const origin = new URL(raw).origin;
      if (STOREFRONT_ORIGINS.includes(origin)) return origin;
    } catch (_) { /* fall through to default */ }
  }
  return STOREFRONT_ORIGINS[0];
}

router.get('/discord-oauth/start', (req, res) => {
  reapOauthStates();
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    return res.status(500).send('Discord OAuth is not configured on the server.');
  }
  const state = require('crypto').randomBytes(16).toString('hex');
  const returnTo = pickReturnTo(req.query.return_to);
  oauthStates.set(state, { returnTo, expiresAt: Date.now() + 10 * 60 * 1000 });
  const url = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'consent',
  }).toString();
  res.redirect(url);
});

router.get('/discord-oauth/callback', async (req, res) => {
  reapOauthStates();
  const { code, state } = req.query;
  const entry = state && oauthStates.get(state);
  const returnTo = entry ? entry.returnTo : STOREFRONT_ORIGINS[0];
  if (state) oauthStates.delete(state);

  const bounce = (params) => res.redirect(`${returnTo}/?${new URLSearchParams(params).toString()}`);

  if (!code || !entry) {
    return bounce({ discord_login_error: 'Login was cancelled or the request expired. Please try again.' });
  }

  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: OAUTH_REDIRECT_URI,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data && tokenRes.data.access_token;
    if (!accessToken) return bounce({ discord_login_error: 'Discord did not return an access token.' });

    const me = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const discordId = me.data && me.data.id;
    if (!discordId) return bounce({ discord_login_error: 'Could not read your Discord account.' });

    const { pending_id, decoy } = await beginDiscordLogin(discordId);
    // A verified linked account gets the DM; a decoy (no linked account) still
    // returns a pending_id that will simply never verify. Either way the page
    // shows "check your DMs", so this can't be used to probe who has an account.
    return bounce({ discord_login: pending_id, ...(decoy ? { discord_login_hint: 'no_account' } : {}) });
  } catch (err) {
    console.error('[Auth] discord-oauth callback error:', err.response?.data || err.message);
    return bounce({ discord_login_error: 'Discord login failed. Please try again.' });
  }
});

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

// ─── POST /api/auth/vault-unlock ─────────────────────────
// Gate for the hidden vault's master password. Single source of truth is the
// VAULT_PASSWORD env var (rotatable via Railway or POST /api/config/update,
// which persists it to Supabase). No hardcoded fallback — if VAULT_PASSWORD is
// unset the vault cannot be opened. Returns only a boolean; never echoes the value.
router.post('/vault-unlock', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password is required' });
    const configured = process.env.VAULT_PASSWORD;
    if (!configured) return res.json({ ok: false });
    res.json({ ok: String(password) === String(configured) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify vault password' });
  }
});

// ─── POST /api/auth/panel-unlock ─────────────────────────
// Gate for the admin panel's static unlock code. Single source of truth is the
// PANEL_PASSWORD env var (rotatable via Railway or POST /api/config/update,
// which persists it to Supabase). No hardcoded fallback — if PANEL_PASSWORD is
// unset the panel cannot be unlocked. Returns only a boolean; never echoes the
// value. Public (no session yet — this IS the gate), constant-shape response.
router.post('/panel-unlock', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password is required' });
    const configured = process.env.PANEL_PASSWORD;
    if (!configured) return res.json({ ok: false });
    res.json({ ok: String(password) === String(configured) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify panel password' });
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

// ─── POST /api/auth/discord-login/initiate ───────────────
// Passwordless "Login with Discord" from the storefront login page. Given a
// Discord User ID (or username), we look up the matching web_users row, then
// ask SUPERBOT to DM that account an Authenticate button. We hand the browser
// back only an opaque pending_id — never the account's email or user id — so
// the page can poll for completion without learning anything about the target.
router.post('/discord-login/initiate', async (req, res) => {
  try {
    reapDiscordPending();
    const { discord_id } = req.body;
    if (!discord_id) return res.status(400).json({ error: 'discord_id is required' });

    let result;
    try {
      result = await beginDiscordLogin(discord_id);
    } catch (e) {
      return res.status(502).json({ error: 'Could not reach the Discord verification service. Try again.' });
    }
    // Uniform response whether or not the account exists (decoy pending_id),
    // so this endpoint can't enumerate which Discord IDs have accounts.
    res.json({ pending_id: result.pending_id, message: 'If that Discord account is linked, a verification DM has been sent.' });
  } catch (err) {
    console.error('[Auth] discord-login initiate error:', err);
    res.status(500).json({ error: 'Failed to start Discord login' });
  }
});

// ─── POST /api/auth/discord-login/poll ───────────────────
// The page polls this with the pending_id. We ask SUPERBOT whether that DM was
// clicked; only when it reports verified do we mint a real web_sessions token
// and return the public user. The browser proved nothing itself — the trust
// comes entirely from SUPERBOT confirming the Discord DM click.
router.post('/discord-login/poll', async (req, res) => {
  try {
    reapDiscordPending();
    const { pending_id } = req.body;
    if (!pending_id) return res.status(400).json({ error: 'pending_id is required' });

    const pending = discordLoginPending.get(pending_id);
    if (!pending) return res.json({ verified: false }); // unknown/expired/decoy id

    let verified = false;
    try {
      const sb = await axios.post(`${SUPERBOT_URL}/api/auth/verify-token`, { userId: pending_id });
      verified = !!(sb.data && sb.data.verified);
    } catch (e) {
      return res.json({ verified: false });
    }
    if (!verified) return res.json({ verified: false });

    // Confirmed — consume the pending entry and mint a session.
    discordLoginPending.delete(pending_id);
    const { rows } = await query(
      `SELECT u.*, b.balance_cents FROM web_users u
       LEFT JOIN balances b ON b.web_user_id = u.id
       WHERE u.id = $1 AND u.guild_id = $2`,
      [pending.webUserId, GUILD_ID]
    );
    const user = rows[0];
    if (!user || user.banned) return res.json({ verified: false });

    await query(`UPDATE web_users SET last_login_at = now() WHERE id = $1`, [user.id]);
    const token = await createSession(user.id, GUILD_ID);
    res.json({ verified: true, token, user: publicUser(user) });
  } catch (err) {
    console.error('[Auth] discord-login poll error:', err);
    res.status(500).json({ error: 'Failed to verify Discord login' });
  }
});

module.exports = router;
