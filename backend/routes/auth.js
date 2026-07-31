const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const {
  hashPassword, verifyPassword, createSession, requireAuth, requireAdmin,
  requireOwnerAdmin, publicUser,
} = require('../utils/auth');
const { rateLimit, failureLimiter, safeCompare } = require('../utils/rateLimit');
const { logAdminAction } = require('../utils/adminLog');
const {
  generateSecret, verifyTOTP, generateBackupCodes, hashBackupCode, otpauthUrl,
} = require('../utils/totp');
const { sendLoginCode } = require('../utils/email');

const GUILD_ID = process.env.GUILD_ID;

// ─── Rate limiters ───────────────────────────────────────
// Before this the backend had no limiting anywhere, so /panel-unlock and
// /vault-unlock were unauthenticated, unlimited-attempt oracles returning a
// clean boolean.
//
// Anything guarding a secret counts FAILED attempts only (failureLimiter), so
// a burst of wrong guesses can never lock out the person who knows the right
// answer. That distinction matters most on the unlock gates: they carry a
// global ceiling — necessary because a per-IP limit does nothing against an
// attacker rotating addresses — and if that ceiling counted every request,
// anyone on the internet could keep staff out of the admin panel for 15
// minutes at a time by spamming it. Letting a correct password through even
// while the limiter is hot leaks nothing, because the response already tells
// the caller whether the guess was right.
const unlockLimiter = failureLimiter({ windowMs: 15 * 60 * 1000, max: 10, globalMax: 100, name: 'unlock' });
// No globalMax on login: a shared ceiling would let one abuser lock every real
// customer out of the store.
const loginLimiter = failureLimiter({ windowMs: 15 * 60 * 1000, max: 20, name: 'login' });
// API_SECRET-gated admin routes. The secret is 32 random bytes so this is not
// the thing standing between an attacker and the account, but an unlimited
// 401-oracle is still free reconnaissance. Only 401s count, so the bot can call
// these as often as it legitimately needs to.
const secretLimiter = failureLimiter({ windowMs: 15 * 60 * 1000, max: 30, globalMax: 300, name: 'secret-gated' });

// These two count EVERY request, because the request itself is the cost rather
// than the guess: signup writes a row, and discord-login/initiate makes
// SUPERBOT send a real DM — unlimited, that is a spam amplifier pointed at a
// customer's inbox. Neither takes a globalMax, for the same reason login
// doesn't.
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: 'signup' });
const discordLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, name: 'discord-login' });
// Same reasoning again for the email second factor: each call sends a real
// message to a real inbox, so the request is the cost. Tighter than the Discord
// one because a mail provider will start treating us as a spammer long before
// Discord does.
const emailCodeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, name: 'email-2fa-code' });

// The emailed second factor is stored the same way a backup code is: hashed,
// never in the clear, in web_login_challenges.ref. A 6-digit code is only
// 1,000,000 wide, but the challenge already caps attempts at 8 and expires in
// ten minutes, so the hash is about what a leaked database row would give an
// attacker, not about brute force.
function hashLoginCode(code) {
  return crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');
}
// Rejection sampling rather than % 1000000, which would make the low 576576
// codes very slightly more likely than the rest.
function generateEmailCode() {
  for (;;) {
    const n = crypto.randomBytes(4).readUInt32BE(0);
    if (n < 4294000000) return String(n % 1000000).padStart(6, '0');
  }
}

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

// ─── POST /api/auth/discord-oauth/link-start ────────────
// The same consent screen, used to LINK rather than to log in: the customer is
// already signed in and wants their Discord attached without going to look up
// their own snowflake.
//
// It is a POST, not a link, because the account it will write to has to be the
// session's — and a session lives in an Authorization header, which a browser
// navigation cannot carry. So the page asks here first, we bind the pending
// link to req.user.id under a one-time state, and only then hand back a URL for
// the browser to walk to. The alternative — putting the session token in the
// start URL — parks a 30-day bearer in browser history and our access logs.
router.post('/discord-oauth/link-start', requireAuth, discordLoginLimiter, (req, res) => {
  reapOauthStates();
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Discord OAuth is not configured on the server.' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  const returnTo = pickReturnTo(req.body && req.body.return_to);
  oauthStates.set(state, { returnTo, linkUserId: req.user.id, expiresAt: Date.now() + 10 * 60 * 1000 });
  const url = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'consent',
  }).toString();
  res.json({ success: true, url });
});

router.get('/discord-oauth/callback', async (req, res) => {
  reapOauthStates();
  const { code, state } = req.query;
  const entry = state && oauthStates.get(state);
  const returnTo = entry ? entry.returnTo : STOREFRONT_ORIGINS[0];
  if (state) oauthStates.delete(state);

  const bounce = (params) => res.redirect(`${returnTo}/?${new URLSearchParams(params).toString()}`);
  // One callback, two errands. Which one this is was decided when the state was
  // minted — by an authenticated POST for a link, by an anonymous GET for a
  // login — so a linking round-trip can never be turned into a login for
  // somebody else's account by editing the URL on the way back.
  const linkUserId = entry && entry.linkUserId;
  const fail = (msg) => bounce(linkUserId ? { discord_link_error: msg } : { discord_login_error: msg });

  if (!code || !entry) {
    return fail('The request was cancelled or expired. Please try again.');
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
    if (!accessToken) return fail('Discord did not return an access token.');

    const me = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const discordId = me.data && me.data.id;
    if (!discordId) return fail('Could not read your Discord account.');

    if (linkUserId) {
      // Consent on Discord's own domain IS the proof of ownership — stronger
      // than the typed-id path, which needs a DM click precisely because the id
      // is just a number anyone can copy. So no SUPERBOT round-trip here.
      const { rows: taken } = await query(
        `SELECT id FROM web_users
          WHERE guild_id = $1 AND discord_id = $2 AND discord_verified = true AND id <> $3`,
        [GUILD_ID, discordId, linkUserId]
      );
      if (taken.length) {
        return bounce({ discord_link_error: 'That Discord account is already linked to another site account.' });
      }
      await query(
        `UPDATE web_users SET discord_id = $1, discord_verified = true WHERE id = $2 AND guild_id = $3`,
        [discordId, linkUserId, GUILD_ID]
      );
      // The id itself is not echoed back in the URL — the page re-reads it from
      // /2fa/status with its own session, which is also the only way it can
      // report the truth if the browser changed accounts mid-flow.
      return bounce({ discord_link: 'ok' });
    }

    const { pending_id, decoy } = await beginDiscordLogin(discordId);
    // A verified linked account gets the DM; a decoy (no linked account) still
    // returns a pending_id that will simply never verify. Either way the page
    // shows "check your DMs", so this can't be used to probe who has an account.
    return bounce({ discord_login: pending_id, ...(decoy ? { discord_login_hint: 'no_account' } : {}) });
  } catch (err) {
    console.error('[Auth] discord-oauth callback error:', err.response?.data || err.message);
    return fail(linkUserId ? 'Discord linking failed. Please try again.' : 'Discord login failed. Please try again.');
  }
});

// ─── POST /api/auth/signup ──────────────────────────────
router.post('/signup', signupLimiter, async (req, res) => {
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
// Password check ONLY. If the account has a second factor, this returns a
// challenge and NO token — the session is minted by /login/verify.
//
// It used to return the 30-day bearer here unconditionally, with the TOTP
// prompt and the Discord DM running afterwards in page JavaScript. Anyone
// holding just the password could therefore skip both with a single curl, and
// in the browser, wiping the localStorage record that held the `twofa` object
// skipped the prompt too.
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
    // Credentials are checked before the limiter, so a customer with the right
    // password gets in even if someone has been guessing against their account
    // from the same address. Only wrong guesses are counted.
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      if (loginLimiter.blocked(req, res)) return;
      loginLimiter.fail(req);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (user.banned) return res.status(403).json({ error: 'This account has been banned' });

    const methods = [];
    if (user.totp_enabled && user.totp_secret) methods.push('totp');
    if (user.discord_id && user.discord_verified) methods.push('discord');
    // Email goes last: methods[0] seeds the challenge row's `kind`, and an
    // inbox round-trip is the slowest of the three, so it should not be the
    // default for an account that also has an authenticator. Each method's own
    // route rewrites `kind` when the browser picks it.
    if (user.email_2fa_enabled && user.email) methods.push('email');

    if (methods.length) {
      const challengeId = crypto.randomBytes(24).toString('hex');
      await query(
        `INSERT INTO web_login_challenges (id, web_user_id, guild_id, kind, expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '10 minutes')`,
        [challengeId, user.id, GUILD_ID, methods[0]]
      );
      // Deliberately no token, and no account detail beyond what the caller
      // already proved they know.
      return res.json({
        success: true,
        requires_2fa: true,
        challenge_id: challengeId,
        methods,
        discord_id: methods.includes('discord') ? user.discord_id : null,
        email: user.email,
      });
    }

    await query('UPDATE web_users SET last_login_at = now() WHERE id = $1', [user.id]);

    const token = await createSession(user.id, GUILD_ID);
    res.json({ success: true, requires_2fa: false, token, user: publicUser(user) });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

// ─── POST /api/auth/login/discord-challenge ─────────────
// Starts the Discord leg of a 2FA login: the BACKEND asks SUPERBOT to DM the
// account's linked Discord user, and records the bot's session id against the
// challenge row. The browser never supplies the Discord id and never gets to
// say whether the DM was clicked — it only polls.
router.post('/login/discord-challenge', async (req, res) => {
  try {
    const { challenge_id } = req.body;
    if (!challenge_id) return res.status(400).json({ error: 'challenge_id is required' });

    const { rows } = await query(
      `SELECT c.*, u.email, u.discord_id, u.discord_verified, u.banned
         FROM web_login_challenges c JOIN web_users u ON u.id = c.web_user_id
        WHERE c.id = $1 AND c.guild_id = $2 AND c.consumed_at IS NULL AND c.expires_at > now()`,
      [challenge_id, GUILD_ID]
    );
    const row = rows[0];
    if (!row) return res.status(401).json({ error: 'This login request has expired. Please log in again.' });
    if (row.banned) return res.status(403).json({ error: 'This account has been banned' });
    if (!row.discord_id || !row.discord_verified) {
      return res.status(400).json({ error: 'No verified Discord account is linked to this login.' });
    }

    let sbSessionId = null;
    try {
      const sb = await axios.post(`${SUPERBOT_URL}/api/auth/initiate-2fa`, {
        email: row.email,
        discordId: row.discord_id,
      });
      sbSessionId = sb.data && sb.data.userId;
    } catch (e) {
      const msg = (e.response && e.response.data && e.response.data.message) || null;
      console.error('[Auth] discord-challenge initiate failed:', msg || e.message);
      return res.status(502).json({ error: msg || 'Could not reach the Discord verification service.' });
    }
    if (!sbSessionId) return res.status(502).json({ error: 'Verification service did not start a session.' });

    await query('UPDATE web_login_challenges SET ref = $1, kind = $2 WHERE id = $3',
      [sbSessionId, 'discord', challenge_id]);

    res.json({ success: true, sent: true });
  } catch (err) {
    console.error('[Auth] discord-challenge error:', err);
    res.status(500).json({ error: 'Failed to start Discord verification' });
  }
});

// ─── POST /api/auth/login/email-challenge ───────────────
// Email leg of a 2FA login: mail a 6-digit code to the address ON THE ACCOUNT.
// The browser supplies only the challenge id — it never names the recipient, so
// this cannot be pointed at an inbox of the caller's choosing.
router.post('/login/email-challenge', emailCodeLimiter, async (req, res) => {
  try {
    const { challenge_id } = req.body;
    if (!challenge_id) return res.status(400).json({ error: 'challenge_id is required' });

    const { rows } = await query(
      `SELECT c.id, c.web_user_id, u.email, u.email_2fa_enabled, u.banned
         FROM web_login_challenges c JOIN web_users u ON u.id = c.web_user_id
        WHERE c.id = $1 AND c.guild_id = $2 AND c.consumed_at IS NULL AND c.expires_at > now()`,
      [challenge_id, GUILD_ID]
    );
    const row = rows[0];
    if (!row) return res.status(401).json({ error: 'This login request has expired. Please log in again.' });
    if (row.banned) return res.status(403).json({ error: 'This account has been banned' });
    if (!row.email_2fa_enabled || !row.email) {
      return res.status(400).json({ error: 'Email verification is not enabled on this account.' });
    }

    const code = generateEmailCode();
    // Written BEFORE the send. The other order loses the code entirely if the
    // UPDATE fails after a mail the customer is already holding.
    await query('UPDATE web_login_challenges SET ref = $1, kind = $2 WHERE id = $3',
      [hashLoginCode(code), 'email', challenge_id]);

    const sent = await sendLoginCode(row.email, code, 'login');
    if (!sent) {
      // Don't leave the browser waiting on a code that was never posted.
      return res.status(502).json({ error: 'Could not send the verification email. Please try another method.' });
    }
    res.json({ success: true, sent: true, email: maskEmail(row.email) });
  } catch (err) {
    console.error('[Auth] email-challenge error:', err);
    res.status(500).json({ error: 'Failed to send the verification email' });
  }
});

// a***@example.com — enough for the customer to recognise the inbox, not enough
// to hand the whole address to someone who only had the password.
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return s;
  const name = s.slice(0, at);
  const head = name.slice(0, 1);
  return head + '*'.repeat(Math.max(1, name.length - 1)) + s.slice(at);
}

// ─── POST /api/auth/login/verify ────────────────────────
// Second factor. The ONLY place a session is minted for a 2FA account.
//
// Accepts either a TOTP code, a single-use backup code, or — for the Discord
// path — the SUPERBOT verification id, which is confirmed by asking the bot
// directly rather than trusting the browser's word that the DM was clicked.
router.post('/login/verify', async (req, res) => {
  try {
    const { challenge_id, code } = req.body;
    if (!challenge_id) return res.status(400).json({ error: 'challenge_id is required' });

    const { rows: cRows } = await query(
      `SELECT * FROM web_login_challenges
        WHERE id = $1 AND guild_id = $2 AND consumed_at IS NULL AND expires_at > now()`,
      [challenge_id, GUILD_ID]
    );
    const challenge = cRows[0];
    if (!challenge) return res.status(401).json({ error: 'This login request has expired. Please log in again.' });

    // Bound the guesses per challenge. A 6-digit code is a 1,000,000 space but
    // the challenge lives ten minutes, which is plenty of requests.
    if (challenge.attempts >= 8) {
      await query('UPDATE web_login_challenges SET consumed_at = now() WHERE id = $1', [challenge_id]);
      return res.status(429).json({ error: 'Too many incorrect codes. Please log in again.' });
    }

    const { rows: uRows } = await query(
      `SELECT u.*, b.balance_cents FROM web_users u
       LEFT JOIN balances b ON b.web_user_id = u.id
       WHERE u.id = $1 AND u.guild_id = $2`,
      [challenge.web_user_id, GUILD_ID]
    );
    const user = uRows[0];
    if (!user) return res.status(401).json({ error: 'Account not found' });
    if (user.banned) return res.status(403).json({ error: 'This account has been banned' });

    let verified = false;
    let usedBackupCode = false;

    if (!code && challenge.ref && challenge.kind !== 'email') {
      // Discord leg: ask SUPERBOT whether the DM button was actually clicked.
      // `kind` is checked because both legs park their state in `ref`, and an
      // email hash handed to SUPERBOT as a session id is a pointless round-trip.
      // The reference came from OUR record of the challenge, not the browser.
      try {
        const sb = await axios.post(`${SUPERBOT_URL}/api/auth/verify-token`, { userId: challenge.ref });
        verified = !!(sb.data && sb.data.verified);
      } catch (e) {
        return res.json({ verified: false, pending: true });
      }
      // Still waiting on the user to click — not a failed attempt, so do not
      // burn one of the eight tries on it.
      if (!verified) return res.json({ verified: false, pending: true });
    } else if (code && challenge.kind === 'email' && challenge.ref &&
               safeCompare(hashLoginCode(String(code).trim()), challenge.ref)) {
      // Emailed code. Checked before TOTP because when kind is 'email' that is
      // what the customer was asked for; a TOTP code still works below, since an
      // account can hold both and the person may reach for the app instead.
      verified = true;
    } else if (code && user.totp_enabled && user.totp_secret && verifyTOTP(user.totp_secret, code)) {
      verified = true;
    } else if (code) {
      // Single-use backup code, matched against stored hashes.
      const { rows: bc } = await query(
        `UPDATE web_user_backup_codes SET used_at = now()
          WHERE id = (SELECT id FROM web_user_backup_codes
                       WHERE web_user_id = $1 AND used_at IS NULL AND code_hash = $2
                       LIMIT 1)
          RETURNING id`,
        [user.id, hashBackupCode(code)]
      );
      if (bc.length) { verified = true; usedBackupCode = true; }
    }

    if (!verified) {
      await query('UPDATE web_login_challenges SET attempts = attempts + 1 WHERE id = $1', [challenge_id]);
      return res.status(401).json({ error: 'That code is not valid.' });
    }

    await query('UPDATE web_login_challenges SET consumed_at = now() WHERE id = $1', [challenge_id]);
    await query('UPDATE web_users SET last_login_at = now() WHERE id = $1', [user.id]);

    const token = await createSession(user.id, GUILD_ID);
    res.json({ success: true, token, user: publicUser(user), used_backup_code: usedBackupCode });
  } catch (err) {
    console.error('[Auth] login/verify error:', err);
    res.status(500).json({ error: 'Failed to verify' });
  }
});

// ─── 2FA enrollment ─────────────────────────────────────
// Enrollment used to happen entirely in the browser: it generated the secret,
// verified the first code itself, and wrote secret + plaintext backup codes
// into the localStorage `ghostUsers` record. Anyone with devtools could read
// the secret, and clearing the record silently disabled the second factor.
// The secret is now issued here, held pending until a real code proves the
// authenticator app has it, and only then written to web_users.

// Pending enrollments, in memory: web_user_id → { secret, codes, expiresAt }.
// Never persisted until confirmed, so an abandoned setup leaves nothing behind.
const pendingEnrollments = new Map();
function reapEnrollments() {
  const now = Date.now();
  for (const [k, v] of pendingEnrollments) if (v.expiresAt < now) pendingEnrollments.delete(k);
}

// ─── GET /api/auth/2fa/status ───────────────────────────
router.get('/2fa/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT (SELECT COUNT(*)::int FROM web_user_backup_codes
                WHERE web_user_id = $1 AND used_at IS NULL) AS codes_left`,
      [req.user.id]
    );
    res.json({
      enabled: !!req.user.totp_enabled,
      discord_available: !!(req.user.discord_id && req.user.discord_verified),
      backup_codes_remaining: rows[0] ? rows[0].codes_left : 0,
      // The security panel used to draw its "✅ LINKED" badge and its Discord id
      // field from the localStorage copy of the account, which is whatever the
      // browser last wrote there — it showed LINKED for an id the server had
      // never verified. These two come from the session's own row.
      email_2fa_enabled: !!req.user.email_2fa_enabled,
      email: req.user.email || null,
      discord_id: (req.user.discord_id && req.user.discord_verified) ? req.user.discord_id : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read 2FA status' });
  }
});

// ─── POST /api/auth/2fa/setup ───────────────────────────
// Issues a secret + backup codes. Nothing is active until /2fa/confirm.
router.post('/2fa/setup', requireAuth, async (req, res) => {
  try {
    reapEnrollments();
    if (req.user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled. Disable it first.' });
    const secret = generateSecret();
    const codes = generateBackupCodes(8);
    pendingEnrollments.set(String(req.user.id), { secret, codes, expiresAt: Date.now() + 15 * 60 * 1000 });
    res.json({
      secret,
      otpauth_url: otpauthUrl(secret, req.user.email || req.user.username, process.env.STORE_NAME || 'GHOST.EXE'),
      // Shown once, at enrollment. Only hashes are stored.
      backup_codes: codes,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start 2FA setup' });
  }
});

// ─── POST /api/auth/2fa/confirm ─────────────────────────
router.post('/2fa/confirm', requireAuth, async (req, res) => {
  try {
    reapEnrollments();
    const pending = pendingEnrollments.get(String(req.user.id));
    if (!pending) return res.status(400).json({ error: 'Start setup again — this enrollment expired.' });
    if (!verifyTOTP(pending.secret, req.body && req.body.code)) {
      return res.status(400).json({ error: 'That code is not valid. Check your authenticator app and try again.' });
    }

    await withTransaction(async (exec) => {
      await exec('UPDATE web_users SET totp_secret = $1, totp_enabled = true WHERE id = $2 AND guild_id = $3',
        [pending.secret, req.user.id, GUILD_ID]);
      await exec('DELETE FROM web_user_backup_codes WHERE web_user_id = $1', [req.user.id]);
      for (const c of pending.codes) {
        await exec('INSERT INTO web_user_backup_codes (web_user_id, guild_id, code_hash) VALUES ($1,$2,$3)',
          [req.user.id, GUILD_ID, hashBackupCode(c)]);
      }
    });

    pendingEnrollments.delete(String(req.user.id));
    res.json({ success: true, enabled: true });
  } catch (err) {
    console.error('[Auth] 2fa/confirm error:', err);
    res.status(500).json({ error: 'Failed to enable 2FA' });
  }
});

// ─── POST /api/auth/2fa/disable ─────────────────────────
// Requires the current password: a hijacked session must not be able to strip
// the second factor off the account it just walked into.
router.post('/2fa/disable', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Your password is required to disable 2FA' });
    const { rows } = await query('SELECT password_hash FROM web_users WHERE id = $1', [req.user.id]);
    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
      if (loginLimiter.blocked(req, res)) return;
      loginLimiter.fail(req);
      return res.status(401).json({ error: 'Incorrect password' });
    }
    await withTransaction(async (exec) => {
      await exec('UPDATE web_users SET totp_secret = NULL, totp_enabled = false WHERE id = $1', [req.user.id]);
      await exec('DELETE FROM web_user_backup_codes WHERE web_user_id = $1', [req.user.id]);
    });
    res.json({ success: true, enabled: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

// ─── Email second factor: enrolment ─────────────────────
// Turning this on is a two-step check for one reason: the address on the
// account has never been proved to reach anybody. Signup takes an email and
// writes it, and the order confirmation is best-effort, so a typo sits there
// unnoticed. Flipping the flag on an unreachable address would lock the account
// out at the next login. So enabling means: we send a code, and it comes back.
//
// Pending email enrolments, in memory: web_user_id → { hash, expiresAt }.
const pendingEmailEnrollments = new Map();
function reapEmailEnrollments() {
  const now = Date.now();
  for (const [k, v] of pendingEmailEnrollments) if (v.expiresAt < now) pendingEmailEnrollments.delete(k);
}

// ─── POST /api/auth/2fa/email/start ─────────────────────
router.post('/2fa/email/start', requireAuth, emailCodeLimiter, async (req, res) => {
  try {
    reapEmailEnrollments();
    if (!req.user.email) return res.status(400).json({ error: 'This account has no email address on file.' });
    if (req.user.email_2fa_enabled) return res.status(400).json({ error: 'Email verification is already enabled.' });

    const code = generateEmailCode();
    const sent = await sendLoginCode(req.user.email, code, 'setup');
    if (!sent) return res.status(502).json({ error: 'Could not send the confirmation email. Try again shortly.' });

    pendingEmailEnrollments.set(String(req.user.id), {
      hash: hashLoginCode(code),
      attempts: 0,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    res.json({ success: true, sent: true, email: maskEmail(req.user.email) });
  } catch (err) {
    console.error('[Auth] 2fa/email/start error:', err);
    res.status(500).json({ error: 'Failed to start email verification' });
  }
});

// ─── POST /api/auth/2fa/email/confirm ───────────────────
router.post('/2fa/email/confirm', requireAuth, async (req, res) => {
  try {
    reapEmailEnrollments();
    const pending = pendingEmailEnrollments.get(String(req.user.id));
    if (!pending) return res.status(400).json({ error: 'That code expired. Send a new one.' });
    // Same eight-guess ceiling the login challenge uses; without it this is an
    // unlimited oracle on a six-digit code.
    if (pending.attempts >= 8) {
      pendingEmailEnrollments.delete(String(req.user.id));
      return res.status(429).json({ error: 'Too many incorrect codes. Send a new one.' });
    }
    const code = String((req.body && req.body.code) || '').trim();
    if (!safeCompare(hashLoginCode(code), pending.hash)) {
      pending.attempts++;
      return res.status(400).json({ error: 'That code is not valid.' });
    }
    pendingEmailEnrollments.delete(String(req.user.id));
    await query('UPDATE web_users SET email_2fa_enabled = true WHERE id = $1 AND guild_id = $2',
      [req.user.id, GUILD_ID]);
    res.json({ success: true, email_2fa_enabled: true });
  } catch (err) {
    console.error('[Auth] 2fa/email/confirm error:', err);
    res.status(500).json({ error: 'Failed to enable email verification' });
  }
});

// ─── POST /api/auth/2fa/email/disable ───────────────────
// Password-gated for the same reason /2fa/disable is: a stolen session must not
// be able to take the second factor off the account it is sitting in.
router.post('/2fa/email/disable', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Your password is required to disable email verification' });
    const { rows } = await query('SELECT password_hash FROM web_users WHERE id = $1', [req.user.id]);
    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
      if (loginLimiter.blocked(req, res)) return;
      loginLimiter.fail(req);
      return res.status(401).json({ error: 'Incorrect password' });
    }
    await query('UPDATE web_users SET email_2fa_enabled = false WHERE id = $1 AND guild_id = $2',
      [req.user.id, GUILD_ID]);
    pendingEmailEnrollments.delete(String(req.user.id));
    res.json({ success: true, email_2fa_enabled: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disable email verification' });
  }
});

// ─── POST /api/auth/2fa/backup-codes ────────────────────
// Regenerate. Returns the new codes once; the old ones stop working.
router.post('/2fa/backup-codes', requireAuth, async (req, res) => {
  try {
    if (!req.user.totp_enabled) return res.status(400).json({ error: '2FA is not enabled on this account' });
    const codes = generateBackupCodes(8);
    await withTransaction(async (exec) => {
      await exec('DELETE FROM web_user_backup_codes WHERE web_user_id = $1', [req.user.id]);
      for (const c of codes) {
        await exec('INSERT INTO web_user_backup_codes (web_user_id, guild_id, code_hash) VALUES ($1,$2,$3)',
          [req.user.id, GUILD_ID, hashBackupCode(c)]);
      }
    });
    res.json({ success: true, backup_codes: codes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to regenerate backup codes' });
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

// ─── Discord account linking ────────────────────────────
// This used to be ONE route, POST /api/auth/confirm-discord, which took a
// discord_id straight from the request body and wrote
// `discord_verified = true`. Its own comment claimed SUPERBOT's verify-token
// flow had already confirmed the id — but the backend never called SUPERBOT.
// The browser made the trust decision and the server just recorded it, so
// `curl -H 'Authorization: Bearer <any new signup>' -d '{"discord_id":"<owner
// snowflake>"}'` claimed the owner's Discord identity outright. That poisons
// every admin lookup keyed by discord_id (balance adjust, reseller resolve)
// and the passwordless-login path.
//
// Now it is two steps and the backend owns both. The browser never supplies
// the id at confirm time — it only carries an opaque pending_id.

// discord link pending: pending_id -> { webUserId, discordId, sbRef, expiresAt }
const discordLinkPending = new Map();
function reapDiscordLinks() {
  const now = Date.now();
  for (const [k, v] of discordLinkPending) if (v.expiresAt < now) discordLinkPending.delete(k);
}

// ─── POST /api/auth/link-discord/start ──────────────────
// Asks SUPERBOT to DM the claimed Discord account an Authenticate button.
// Only the real owner of that account can click it.
router.post('/link-discord/start', requireAuth, discordLoginLimiter, async (req, res) => {
  try {
    reapDiscordLinks();
    const discordId = String((req.body && req.body.discord_id) || '').trim();
    if (!/^\d{15,25}$/.test(discordId)) {
      return res.status(400).json({ error: 'That does not look like a Discord user ID.' });
    }

    // Refuse a snowflake already verified on another account, rather than
    // creating the duplicate that makes admin lookups ambiguous.
    const { rows: taken } = await query(
      `SELECT id FROM web_users
        WHERE guild_id = $1 AND discord_id = $2 AND discord_verified = true AND id <> $3`,
      [GUILD_ID, discordId, req.user.id]
    );
    if (taken.length) {
      return res.status(409).json({ error: 'That Discord account is already linked to another site account.' });
    }

    let sbRef = null;
    try {
      const sb = await axios.post(`${SUPERBOT_URL}/api/auth/initiate-2fa`, {
        email: req.user.email,
        discordId,
      });
      sbRef = sb.data && sb.data.userId;
    } catch (e) {
      const msg = (e.response && e.response.data && e.response.data.message) || null;
      return res.status(502).json({ error: msg || 'Could not send the Discord verification DM.' });
    }
    if (!sbRef) return res.status(502).json({ error: 'Verification service did not start a session.' });

    const pendingId = crypto.randomBytes(24).toString('hex');
    discordLinkPending.set(pendingId, {
      webUserId: req.user.id,
      discordId,
      sbRef,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    res.json({ success: true, pending_id: pendingId });
  } catch (err) {
    console.error('[Auth] link-discord/start error:', err);
    res.status(500).json({ error: 'Failed to start Discord linking' });
  }
});

// ─── POST /api/auth/confirm-discord ─────────────────────
// Takes ONLY the opaque pending_id. The Discord id comes from our own record
// of the pending link, and the link is written only after SUPERBOT confirms
// the DM button was actually clicked.
router.post('/confirm-discord', requireAuth, async (req, res) => {
  try {
    reapDiscordLinks();
    const pendingId = String((req.body && req.body.pending_id) || '');
    if (!pendingId) return res.status(400).json({ error: 'pending_id is required' });

    const pending = discordLinkPending.get(pendingId);
    // Bound to the session that started it, so one user cannot finish
    // another's pending link.
    if (!pending || String(pending.webUserId) !== String(req.user.id)) {
      return res.status(400).json({ error: 'That linking request expired. Please start again.' });
    }

    let verified = false;
    try {
      const sb = await axios.post(`${SUPERBOT_URL}/api/auth/verify-token`, { userId: pending.sbRef });
      verified = !!(sb.data && sb.data.verified);
    } catch (e) {
      return res.json({ verified: false, pending: true });
    }
    if (!verified) return res.json({ verified: false, pending: true });

    discordLinkPending.delete(pendingId);

    // Re-check at write time: another account could have linked this snowflake
    // during the ten minutes the DM was outstanding.
    const { rows: taken } = await query(
      `SELECT id FROM web_users
        WHERE guild_id = $1 AND discord_id = $2 AND discord_verified = true AND id <> $3`,
      [GUILD_ID, pending.discordId, req.user.id]
    );
    if (taken.length) {
      return res.status(409).json({ error: 'That Discord account is already linked to another site account.' });
    }

    await query(
      `UPDATE web_users SET discord_id = $1, discord_verified = true WHERE id = $2`,
      [pending.discordId, req.user.id]
    );
    res.json({ success: true, verified: true, discord_id: pending.discordId });
  } catch (err) {
    console.error('[Auth] confirm-discord error:', err);
    res.status(500).json({ error: 'Failed to link Discord' });
  }
});

// ─── POST /api/auth/set-role ─────────────────────────────
// Admin bootstrap / role management — gated by the same API_SECRET used
// everywhere else in this backend rather than requireAdmin, so the very
// first admin can be promoted with no existing admin account yet. This is what
// the bot's /web-promote calls.
//
// Accepts THREE ways of naming the target, because the bot offers all three:
//   username    — website username (also matches email, see below)
//   email       — website email
//   discord_id  — the linked Discord account, so staff can just pick a member
//                 out of the Discord picker instead of knowing their site login
//
// `username` matches username OR email. The bot's option has always been
// described as "Website username or email" but the SQL only ever compared
// username, so an email silently 404'd. Fixed here rather than in the bot so
// the panel and any other caller get it too.
//
// discord_id is compared as TEXT and never parsed as a number: 19-digit
// snowflakes exceed Number.MAX_SAFE_INTEGER and parseInt() would round them to
// a different, non-existent id.
router.post('/set-role', async (req, res) => {
  try {
    const { secret, username, email, discord_id, role } = req.body;
    if (!process.env.API_SECRET) return res.status(503).json({ error: 'Server not configured' });
    // Only wrong secrets are counted, so the bot is never throttled.
    if (!safeCompare(secret, process.env.API_SECRET)) {
      if (secretLimiter.blocked(req, res)) return;
      secretLimiter.fail(req);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!['member', 'staff', 'admin', 'reseller'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const ident = username != null ? String(username).trim() : '';
    const mail = email != null ? String(email).trim() : '';
    const did = discord_id != null ? String(discord_id).trim() : '';
    if (!ident && !mail && !did) {
      return res.status(400).json({ error: 'username, email, or discord_id is required' });
    }

    // Look the row up first so a miss can say WHICH identifier missed. A blind
    // UPDATE ... RETURNING can only report the generic "User not found", which
    // is what made the email case so confusing to diagnose.
    const { rows: found } = await query(
      `SELECT id, username, email, discord_id, discord_verified, role FROM web_users
       WHERE guild_id = $1
         AND ( ($2 <> '' AND (lower(username) = lower($2) OR lower(email) = lower($2)))
            OR ($3 <> '' AND lower(email) = lower($3))
            OR ($4 <> '' AND discord_id = $4) )`,
      [GUILD_ID, ident, mail, did]
    );

    if (!found.length) {
      return res.status(404).json({
        error: did && !ident && !mail
          ? 'No website account is linked to that Discord user. They need to sign up and link Discord first.'
          : 'User not found',
      });
    }
    if (found.length > 1) {
      // Different identifiers resolving to different people — refuse rather
      // than promote an arbitrary one of them.
      return res.status(409).json({
        error: 'That matched more than one account. Use a single, more specific identifier.',
        matched: found.map(r => r.username),
      });
    }

    const target = found[0];
    const { rows } = await query(
      `UPDATE web_users SET role = $1 WHERE id = $2 AND guild_id = $3 RETURNING id, username, email, role`,
      [role, target.id, GUILD_ID]
    );

    // No session invalidation needed on demotion: requireAdmin re-reads the
    // role from web_users on every request (see utils/auth.js), so a demoted
    // admin loses panel access on their very next call without logging out.

    await logAdminAction(req, 'set_role', target.id, {
      role, previous_role: target.role, username: rows[0].username, via: 'api_secret',
    });

    res.json({
      success: true,
      user: { ...rows[0], id: String(rows[0].id) },
      previous_role: target.role,
      discord_linked: !!target.discord_id && target.discord_verified === true,
    });
  } catch (err) {
    console.error('[Auth] set-role error:', err);
    res.status(500).json({ error: 'Failed to set role' });
  }
});

// ─── POST /api/auth/ban ──────────────────────────────────
router.post('/ban', async (req, res) => {
  try {
    const { secret, username, banned } = req.body;
    if (!process.env.API_SECRET) return res.status(503).json({ error: 'Server not configured' });
    if (!safeCompare(secret, process.env.API_SECRET)) {
      if (secretLimiter.blocked(req, res)) return;
      secretLimiter.fail(req);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { rows } = await query(
      `UPDATE web_users SET banned = $1 WHERE guild_id = $2 AND lower(username) = lower($3) RETURNING id, username, banned`,
      [!!banned, GUILD_ID, username]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await logAdminAction(req, banned ? 'ban' : 'unban', rows[0].id, { username: rows[0].username, via: 'api_secret' });
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ban state' });
  }
});

// ─── GET /api/auth/staff-context ─────────────────────────
// Authoritative answer to "may this session open the staff panel, and as
// what". The staff panel used to decide this entirely in the browser: it read
// a ghostUsers record out of localStorage, checked a PLAINTEXT password field
// on it, and unlocked the Tickets / Users / Ban Log tabs without a single
// request leaving the page — so anyone could inject a record with a staffRole
// in devtools and walk straight in. The role now comes from web_users on the
// server, per request, over the session token.
router.get('/staff-context', requireAdmin, async (req, res) => {
  res.json({
    ok: true,
    username: req.user.username,
    role: req.user.role,
    is_owner_admin: req.user.role === 'admin',
  });
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
router.post('/admin/reset-password', requireOwnerAdmin, async (req, res) => {
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
    await logAdminAction(req, 'reset_password', user_id, { username: rows[0].username });
    res.json({ success: true, user: { id: String(rows[0].id), username: rows[0].username } });
  } catch (err) {
    console.error('[Auth] Admin reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── POST /api/auth/admin/set-role ───────────────────────
// Session-gated (admin) counterpart to the secret-gated /set-role above, by
// user id, so the panel can promote/demote without the API_SECRET.
router.post('/admin/set-role', requireOwnerAdmin, async (req, res) => {
  try {
    const { user_id, role } = req.body;
    if (!['member', 'staff', 'admin', 'reseller'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    // No self-edit: an owner cannot demote themselves into a lockout, and this
    // also closes the self-promotion path if the gate above is ever loosened.
    if (String(user_id) === String(req.user.id)) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    const { rows } = await query(
      `UPDATE web_users SET role = $1 WHERE id = $2 AND guild_id = $3 RETURNING id, username, role`,
      [role, user_id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await logAdminAction(req, 'set_role', user_id, { role, username: rows[0].username });
    res.json({ success: true, user: { ...rows[0], id: String(rows[0].id) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set role' });
  }
});

// ─── POST /api/auth/admin/ban ────────────────────────────
router.post('/admin/ban', requireAdmin, async (req, res) => {
  try {
    const { user_id, banned } = req.body;
    // Staff may ban members, but not an owner admin — otherwise a staff
    // account can lock the owner out of their own store.
    const { rows: targetRows } = await query(
      'SELECT role FROM web_users WHERE id = $1 AND guild_id = $2',
      [user_id, GUILD_ID]
    );
    if (!targetRows.length) return res.status(404).json({ error: 'User not found' });
    if (targetRows[0].role === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an owner admin can ban an admin account' });
    }
    const { rows } = await query(
      `UPDATE web_users SET banned = $1 WHERE id = $2 AND guild_id = $3 RETURNING id, username, banned`,
      [!!banned, user_id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    if (banned) await query('DELETE FROM web_sessions WHERE web_user_id = $1', [user_id]);
    await logAdminAction(req, banned ? 'ban' : 'unban', user_id, { username: rows[0].username });
    res.json({ success: true, user: { ...rows[0], id: String(rows[0].id) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ban state' });
  }
});

// ─── POST /api/auth/vault-unlock ─────────────────────────
// Gate for the hidden vault's master password.
//
// The Railway env var is the ONLY source of truth. VAULT_PASSWORD used to sit
// in config.js's allowed_keys, which meant a `config` table row overwrote the
// env var at boot — so rotating in Railway looked like it worked and silently
// did nothing. Both password keys were removed from allowed_keys and their rows
// deleted; change the value in Railway, redeploy, done.
//
// No hardcoded fallback — if VAULT_PASSWORD is unset the vault cannot be
// opened. Returns only a boolean and never echoes the value; the compare is
// constant-time so response timing doesn't leak how much of a guess matched.
router.post('/vault-unlock', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password is required' });
    const configured = process.env.VAULT_PASSWORD;
    if (!configured) return res.json({ ok: false });
    // Verify before consulting the limiter — see /panel-unlock below.
    if (safeCompare(password, configured)) return res.json({ ok: true });
    if (unlockLimiter.blocked(req, res)) return;
    unlockLimiter.fail(req);
    res.json({ ok: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify vault password' });
  }
});

// ─── POST /api/auth/panel-unlock ─────────────────────────
// Gate for the admin panel's static unlock code. Same contract as
// /vault-unlock above: PANEL_PASSWORD comes from the Railway env var and
// nowhere else, no fallback, boolean-only response, constant-time compare.
// Public by necessity — there is no session yet, this IS the gate — so the
// rate limiter is the only thing bounding guesses.
router.post('/panel-unlock', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password is required' });
    const configured = process.env.PANEL_PASSWORD;
    if (!configured) return res.json({ ok: false });
    // Verify BEFORE the limiter so a correct password is never rate limited.
    // The limiter has a global ceiling, and checking it first would mean any
    // stranger could lock staff out of the panel with a burst of wrong guesses.
    if (safeCompare(password, configured)) return res.json({ ok: true });
    if (unlockLimiter.blocked(req, res)) return;
    unlockLimiter.fail(req);
    res.json({ ok: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify panel password' });
  }
});

// ─── DELETE /api/auth/admin/user/:id ─────────────────────
router.delete('/admin/user/:id', requireOwnerAdmin, async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    const { rows } = await query(
      `DELETE FROM web_users WHERE id = $1 AND guild_id = $2 RETURNING id, username`,
      [req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await logAdminAction(req, 'delete_user', req.params.id, { username: rows[0].username });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ─── POST /api/auth/admin/unlink-discord ─────────────────
// A snowflake can only be verified on ONE account — the OAuth callback and the
// DM handshake both refuse a duplicate rather than stealing it. That is the
// right default (otherwise anyone who links first owns the identity), but it
// leaves the owner stuck when the id is sitting on an account they no longer
// use: every re-link attempt just answers "already linked to another site
// account" with nowhere to go. This is that way out.
//
// requireAdmin, not requireOwnerAdmin: unlinking removes an authentication
// path, it does not grant one, so it is the same blast radius as a ban.
router.post('/admin/unlink-discord', requireAdmin, async (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    const { rows: target } = await query(
      'SELECT id, username, role, discord_id FROM web_users WHERE id = $1 AND guild_id = $2',
      [user_id, GUILD_ID]
    );
    if (!target.length) return res.status(404).json({ error: 'User not found' });
    // Same rule the ban route uses: staff must not be able to strip a factor
    // off the owner's account and lock them out of their own store.
    if (target[0].role === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an owner admin can unlink an admin account' });
    }
    await query(
      'UPDATE web_users SET discord_id = NULL, discord_verified = false WHERE id = $1 AND guild_id = $2',
      [user_id, GUILD_ID]
    );
    await logAdminAction(req, 'unlink_discord', user_id,
      { username: target[0].username, had_discord: !!target[0].discord_id });
    res.json({ success: true, user_id: String(user_id) });
  } catch (err) {
    console.error('[Auth] admin/unlink-discord error:', err);
    res.status(500).json({ error: 'Failed to unlink Discord' });
  }
});

// ─── POST /api/auth/2fa/discord/unlink ───────────────────
// The self-service half. Password-gated for the same reason /2fa/disable is: a
// hijacked session must not be able to strip a factor off the account it walked
// into. An account whose ONLY second factor is Discord keeps it — dropping the
// link there would quietly downgrade the account to a password alone.
router.post('/2fa/discord/unlink', requireAuth, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password is required' });
    const { rows } = await query('SELECT password_hash FROM web_users WHERE id = $1', [req.user.id]);
    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    if (req.user.discord_verified && !req.user.totp_enabled && !req.user.email_2fa_enabled) {
      return res.status(400).json({
        error: 'Discord is the only second factor on this account. Enable the authenticator app or email verification first.',
      });
    }
    await query(
      'UPDATE web_users SET discord_id = NULL, discord_verified = false WHERE id = $1 AND guild_id = $2',
      [req.user.id, GUILD_ID]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Auth] 2fa/discord/unlink error:', err);
    res.status(500).json({ error: 'Failed to unlink Discord' });
  }
});

// ─── POST /api/auth/discord-login/initiate ───────────────
// Passwordless "Login with Discord" from the storefront login page. Given a
// Discord User ID (or username), we look up the matching web_users row, then
// ask SUPERBOT to DM that account an Authenticate button. We hand the browser
// back only an opaque pending_id — never the account's email or user id — so
// the page can poll for completion without learning anything about the target.
router.post('/discord-login/initiate', discordLoginLimiter, async (req, res) => {
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
