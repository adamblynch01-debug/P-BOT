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
const { decodeImageDataUrl } = require('../utils/imageUpload');
// Shared with routes/orders.js, which creates the same kind of row when a
// claim is proven by the Discord account named on the order. Two writers of
// one account shape is how you end up with two half-accounts.
const { ensureDiscordAccount, freeUsername } = require('../utils/discordAccount');
const { getDiscordMemberRoles, setDiscordMemberRole, createDiscordRole, checkDiscordAccess } = require('../utils/discordAccess');

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
const SUPERBOT_URL = process.env.SUPERBOT_URL || 'https://nullpoint.top';

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
  let sb;
  try {
    sb = await axios.post(`${SUPERBOT_URL}/api/auth/initiate-2fa`, {
      // An account created from a Discord identity has no address at all (see
      // migrations/discord_signup.sql), so the DM is labelled with whatever
      // names this account to its owner. The bot takes account_label ahead of
      // email; `email` is still sent so an older bot build keeps working.
      email: user.email,
      account_label: user.email || `@${user.username}`,
      discordId: id,
    });
  } catch (err) {
    // The DM is the one step of this flow that fails for a reason the customer
    // can act on — closed DMs — and it used to surface as a 500 with the
    // reason only in the logs.
    //
    // Returned rather than thrown, and returned as a DECOY, because the caller
    // decides whether it is safe to repeat: the OAuth path may (the consent
    // already proved who is asking, so it is their own DM setting being
    // described), the typed-id path may not (an error there would tell an
    // anonymous caller that the id they typed HAS an account, which is the one
    // thing the decoy exists to hide).
    const msg = (err.response && err.response.data && err.response.data.message)
      || 'Could not send the Discord DM. Please try again.';
    console.warn('[Auth] discord login DM failed:', msg);
    return { pending_id: require('crypto').randomUUID(), decoy: true, dmError: msg };
  }
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
const BACKEND_PUBLIC_URL = (process.env.BACKEND_PUBLIC_URL || 'https://nullpoint.top').replace(/\/$/, '');

// The callback URL each provider sends the browser back to.
//
// Overridable PER PROVIDER, and that is the whole point (round 29 item 5).
// Google's consent screen reads "to continue to <host of redirect_uri>" — not
// the app name — so today it says captivating-happiness-production-c944.up.
// railway.app to every customer signing in. Fixing that means moving the
// callback onto a custom domain (api.uhservices.xyz), and moving it by editing
// BACKEND_PUBLIC_URL would move DISCORD's callback in the same breath. Discord
// refuses any redirect_uri not listed in its developer portal, so one variable
// for both makes a branding change into an all-providers-at-once cutover with
// Discord login broken in the window between the deploy and the portal edit.
//
// Separate variables let the move happen one provider at a time, with the old
// URL still registered alongside the new one so nothing is down mid-flight.
// The value must be byte-identical to the one registered with the provider AND
// to the one sent in the token exchange, which is why it is read once here
// rather than rebuilt at each call site.
function redirectUri(envValue, path) {
  const raw = String(envValue || '').trim();
  return raw ? raw.replace(/\/$/, '') : `${BACKEND_PUBLIC_URL}${path}`;
}
const OAUTH_REDIRECT_URI = redirectUri(process.env.DISCORD_REDIRECT_URI, '/api/auth/discord-oauth/callback');
// Origins the callback is allowed to redirect the browser back to. Prevents an
// attacker from using our OAuth start as an open redirect. First entry is the
// default when no valid return_to is supplied.
const STOREFRONT_ORIGINS = (process.env.STOREFRONT_ORIGINS || 'https://nullpoint.top,https://www.nullpoint.top')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const oauthStates = new Map(); // state → { returnTo, expiresAt }
function reapOauthStates() {
  const now = Date.now();
  for (const [s, v] of oauthStates) if (v.expiresAt < now) oauthStates.delete(s);
}
function pickReturnTo(raw) {
  console.log('[Auth] pickReturnTo - raw:', raw, 'STOREFRONT_ORIGINS:', STOREFRONT_ORIGINS);
  if (raw) {
    try {
      const origin = new URL(raw).origin;
      console.log('[Auth] pickReturnTo - parsed origin:', origin, 'includes:', STOREFRONT_ORIGINS.includes(origin));
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
  console.log('[Auth] Discord OAuth start - return_to query:', req.query.return_to, '→ picked:', returnTo);
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
    // OAuth proves ownership of the Discord identity, but not membership in
    // this store's guild. Check before linking or creating anything so an
    // account cannot be opened after the identity leaves the server.
    const discordAccess = await checkDiscordAccess(String(discordId));
    if (!discordAccess.inServer) {
      return fail('Join our Discord server before signing in to the website.');
    }
    // The avatar HASH, not a url. Discord hands it over on every /users/@me
    // and it was thrown away here, which is why review cards had no picture to
    // draw. Null when the member has never set one — they are on a default
    // avatar, and there is nothing to store. See migrations/review_avatars.sql
    // for why the hash is kept rather than a copy of the image.
    const discordAvatar = (me.data && me.data.avatar) || null;

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
        `UPDATE web_users SET discord_id = $1, discord_verified = true, discord_avatar = $4
          WHERE id = $2 AND guild_id = $3`,
        [discordId, linkUserId, GUILD_ID, discordAvatar]
      );
      // The id itself is not echoed back in the URL — the page re-reads it from
      // /2fa/status with its own session, which is also the only way it can
      // report the truth if the browser changed accounts mid-flow.
      return bounce({ discord_link: 'ok' });
    }

    // Keep the stored hash current on the way past. A member who changes their
    // Discord picture invalidates the hash, and without this refresh their
    // review card would keep pointing at a cdn path that 404s until they
    // happened to re-link. Restricted to a VERIFIED link — the consent we just
    // completed proves ownership of the Discord account, not of the site
    // account, so an unverified row must not be written to on that basis.
    // Best-effort: a failure here must not cost the customer their login.
    await query(
      `UPDATE web_users SET discord_avatar = $1
        WHERE guild_id = $2 AND discord_id = $3 AND discord_verified = true
          AND discord_avatar IS DISTINCT FROM $1`,
      [discordAvatar, GUILD_ID, discordId]
    ).catch((e) => console.warn('[Auth] discord avatar refresh failed:', e.message));

    // SIGN UP with Discord, for a snowflake we have never seen.
    //
    // This used to fall through to a decoy pending_id that never verifies, so
    // a customer with no account pressed the button, was told to check their
    // DMs, and waited for a DM nobody was going to send. Round 29 item 6.
    //
    // The consent we just completed is proof of this Discord account and of
    // nothing else — which is exactly, and only, what the created row claims:
    // discord_id verified, no email, no password (see
    // migrations/discord_signup.sql). It cannot take over anything, because a
    // snowflake already linked to a site account is found by the lookup rather
    // than created.
    //
    // The decoy is not lost by this. It existed so the button could not be used
    // to probe who has an account, and it still cannot: whoever completes the
    // consent learns about their own account and no one else's.
    let created = false;
    try {
      const r = await ensureDiscordAccount({
        discordId,
        username: (me.data && (me.data.global_name || me.data.username)) || null,
        avatarHash: discordAvatar,
      });
      created = r.created;
      if (created) console.log(`[Auth] Discord signup: created account ${r.user.username} for ${discordId}`);
    } catch (e) {
      console.error('[Auth] discord signup failed:', e.message);
      return fail('Could not create your account. Please try again.');
    }

    // A new account still goes through the DM click, same as a returning one.
    // Not ceremony: every delivery this store makes is a DM, so an account
    // that cannot receive one cannot receive a purchase either. Finding that
    // out at sign-up, where the message names the privacy setting to change,
    // is better than finding it out when an order is waiting.
    const { pending_id, dmError } = await beginDiscordLogin(discordId);
    if (dmError) return fail(dmError);
    return bounce({ discord_login: pending_id, ...(created ? { discord_new: '1' } : {}) });
  } catch (err) {
    console.error('[Auth] discord-oauth callback error:', err.response?.data || err.message);
    return fail(linkUserId ? 'Discord linking failed. Please try again.' : 'Discord login failed. Please try again.');
  }
});

// ─── GET /api/auth/oauth-config ─────────────────────────
// Which sign-in buttons the storefront should draw. Public and deliberately
// boolean-only — it names no client id, no redirect URI and no secret.
//
// It exists because the storefront is a static file the owner uploads by hand.
// Without this it would have to hard-code whether Google is switched on, and
// the day the credentials are added the button would still be missing until the
// next manual upload. Asking the server instead means the feature turns itself
// on when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET appear in the environment,
// and a button that cannot work is never shown.
router.get('/oauth-config', (req, res) => {
  res.json({
    discord: !!(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET),
    google: googleConfigured(),
  });
});

// ─── Google OAuth: sign IN and sign UP ───────────────────
// The same round trip does both, because from the browser's side they are the
// same gesture — the customer presses one button and expects to end up in their
// account, and whether that account already existed is our problem, not theirs.
// The callback resolves it in this order:
//
//   1. a row already carrying this Google `sub`      → that account, always.
//   2. a row whose email matches the Google address  → LINK the sub to it and
//      sign in. This is what stops a customer who has been buying here for
//      months from pressing the button and landing in an empty duplicate.
//   3. nothing                                        → create the account.
//
// Step 2 is a takeover primitive if it is done carelessly, so `email_verified`
// is mandatory: without it, anyone who can put an arbitrary address on a Google
// account walks into the matching account here. Google only sets that flag for
// an address it has proved control of.
//
// Step 1 matches on `sub`, never on the address, because the address is not
// stable — a customer can change the email on their Google account, and after
// that the only thing still identifying them is the sub.
//
// WHAT THIS DOES NOT DO: it does not skip a second factor. Google proves who
// owns the mailbox; it says nothing about the authenticator app the customer
// enrolled here. An account with 2FA is handed the ordinary challenge and
// finishes through /login/verify like any other login, so turning on Google
// sign-in cannot weaken an account that was already protected.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = redirectUri(process.env.GOOGLE_REDIRECT_URI, '/api/auth/google-oauth/callback');
function googleConfigured() { return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET); }

// Named at boot because both failures this variable can cause are silent from
// the server's side: a redirect_uri the provider does not know produces an
// error page on THEIR domain, and a redirect_uri that works but points at the
// railway host produces a consent screen that quietly reads like a phishing
// page to the customer. Neither leaves a line in these logs on its own.
console.log(`[Auth] OAuth callbacks — discord: ${OAUTH_REDIRECT_URI}`);
console.log(`[Auth] OAuth callbacks — google:  ${googleConfigured() ? GOOGLE_REDIRECT_URI : '(not configured)'}`);
if (googleConfigured() && /\.up\.railway\.app$/i.test(new URL(GOOGLE_REDIRECT_URI).hostname)) {
  console.warn('[Auth] Google consent will read "to continue to '
    + new URL(GOOGLE_REDIRECT_URI).hostname + '" — that host is what Google shows, not the app name.'
    + ' Point GOOGLE_REDIRECT_URI at a uhservices.xyz custom domain to change it.');
}

// Separate from oauthStates rather than sharing it with a `provider` field: one
// map means a state minted for one provider is a valid state for the other's
// callback, and the only thing standing between that and a mixed-up identity is
// remembering to check a discriminator in two places forever.
const googleStates = new Map(); // state → { returnTo, linkUserId?, expiresAt }
function reapGoogleStates() {
  const now = Date.now();
  for (const [s, v] of googleStates) if (v.expiresAt < now) googleStates.delete(s);
}

// The callback is a browser REDIRECT, so anything it hands back travels in a
// URL — and a URL is the one place a 30-day session token must never go. It
// lands in browser history, in every proxy access log on the way, and in the
// Referer header sent to any third-party asset the page loads. (utils/auth.js
// removed a `?token=` fallback for exactly this reason.)
//
// So the redirect carries a claim instead: single-use, two minutes, and worth
// nothing except to the page that immediately POSTs it back for the real token
// over a response body. Two minutes because the only thing that has to happen
// in that window is one fetch by a page that is already open.
const googleClaims = new Map(); // claim → { webUserId, expiresAt }
function reapGoogleClaims() {
  const now = Date.now();
  for (const [k, v] of googleClaims) if (v.expiresAt < now) googleClaims.delete(k);
}

function googleAuthorizeUrl(state) {
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    // openid+email is all this needs. `profile` is asked for only so a new
    // account can be given the customer's name instead of a mangled email
    // prefix; nothing else is read and no refresh token is requested, so the
    // grant expires with the round trip.
    scope: 'openid email profile',
    state,
    // Not 'consent': re-consenting on every sign-in is friction for no gain
    // when we keep nothing. select_account is the one that matters — people
    // have several Google accounts and the wrong one silently signs them into
    // the wrong store account.
    prompt: 'select_account',
  }).toString();
}

// A username for an account that never chose one. The email prefix is the
// closest thing to a name the customer has given us, but it goes straight into
// the page and into a UNIQUE check, so it is stripped to a conservative
// character set first and a collision is resolved rather than raised.
function googleUsernameSeed(email, name) {
  const fromName = String(name || '').trim().replace(/[^a-zA-Z0-9 _.-]/g, '').replace(/\s+/g, '_');
  const fromEmail = String(email || '').split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '');
  const seed = (fromName || fromEmail || 'user').slice(0, 24);
  // Not '' and not a lone '.', either of which reads as a blank name once the
  // strip above has done its work on an all-emoji display name.
  return /[a-zA-Z0-9]/.test(seed) ? seed : 'user';
}

// freeUsername() moved to utils/discordAccount.js when a second signup path
// needed it. Same function, one copy.

router.get('/google-oauth/start', (req, res) => {
  reapGoogleStates();
  if (!googleConfigured()) return res.status(500).send('Google sign-in is not configured on the server.');
  const state = crypto.randomBytes(16).toString('hex');
  googleStates.set(state, { returnTo: pickReturnTo(req.query.return_to), expiresAt: Date.now() + 10 * 60 * 1000 });
  res.redirect(googleAuthorizeUrl(state));
});

// ─── POST /api/auth/google-oauth/link-start ─────────────
// Attach Google to an account that already exists, so a customer who signed up
// with a password can stop typing it. A POST for the same reason the Discord
// one is: the account this will write to has to be the SESSION's, a session
// lives in an Authorization header, and a browser navigation cannot carry one.
// Binding the pending link to req.user.id under a one-time state is what makes
// that safe without parking a bearer token in browser history.
router.post('/google-oauth/link-start', requireAuth, (req, res) => {
  reapGoogleStates();
  if (!googleConfigured()) return res.status(503).json({ error: 'Google sign-in is not configured on the server.' });
  const state = crypto.randomBytes(16).toString('hex');
  googleStates.set(state, {
    returnTo: pickReturnTo(req.body && req.body.return_to),
    linkUserId: req.user.id,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  res.json({ success: true, url: googleAuthorizeUrl(state) });
});

router.get('/google-oauth/callback', async (req, res) => {
  reapGoogleStates();
  reapGoogleClaims();
  const { code, state } = req.query;
  const entry = state && googleStates.get(state);
  const returnTo = entry ? entry.returnTo : STOREFRONT_ORIGINS[0];
  if (state) googleStates.delete(state);

  const bounce = (params) => res.redirect(`${returnTo}/?${new URLSearchParams(params).toString()}`);
  // Which errand this is was decided when the state was minted — by an
  // authenticated POST for a link, by an anonymous GET for a sign-in — so a
  // linking round trip cannot be turned into a login for somebody else's
  // account by editing the URL on the way back.
  const linkUserId = entry && entry.linkUserId;
  const fail = (msg) => bounce(linkUserId ? { google_link_error: msg } : { google_login_error: msg });

  if (!googleConfigured()) return fail('Google sign-in is not configured on the server.');
  if (!code || !entry) return fail('The request was cancelled or expired. Please try again.');

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: GOOGLE_REDIRECT_URI,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data && tokenRes.data.access_token;
    if (!accessToken) return fail('Google did not return an access token.');

    // The userinfo endpoint rather than decoding the id_token ourselves. The
    // same facts are in that JWT, but reading them requires either verifying a
    // signature against Google's rotating JWKS or trusting an unverified
    // payload — and the second one is a forgery away from a full takeover the
    // day this code gets copied somewhere the token did not come straight from
    // Google. One extra round trip buys the guarantee outright.
    const me = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const sub = me.data && me.data.sub;
    const email = String((me.data && me.data.email) || '').trim();
    // Google sends this as a real boolean; some proxies and older responses
    // stringify it. A missing flag is NOT a pass.
    const emailVerified = me.data && (me.data.email_verified === true || me.data.email_verified === 'true');
    // The `picture` claim: a full https URL Google serves itself. Kept as
    // given rather than downloaded, for the same reason as the Discord hash —
    // it tracks the account, so a copy would go stale silently. Absent for an
    // account with no picture set, which is a legitimate answer and falls
    // through to the next source. See migrations/review_avatars.sql.
    const googlePicture = (() => {
      const p = String((me.data && me.data.picture) || '').trim();
      // This lands in an <img src> on a public page. Anything that is not a
      // plain https URL has no business being echoed back there.
      return /^https:\/\//i.test(p) ? p : null;
    })();

    if (!sub) return fail('Could not read your Google account.');
    if (!email) return fail('That Google account has no email address on it.');
    if (!emailVerified) {
      // The one refusal worth spelling out: it is the difference between a
      // customer with an odd Google account and an attacker holding somebody
      // else's address, and only the customer can fix it.
      return fail('That Google account\'s email address is not verified with Google, so it cannot be used to sign in.');
    }

    if (linkUserId) {
      const { rows: taken } = await query(
        'SELECT id FROM web_users WHERE guild_id = $1 AND google_id = $2 AND id <> $3',
        [GUILD_ID, sub, linkUserId]
      );
      if (taken.length) {
        return bounce({ google_link_error: 'That Google account is already linked to another site account.' });
      }
      await query(
        'UPDATE web_users SET google_id = $1, google_email = $2, google_avatar = $5 WHERE id = $3 AND guild_id = $4',
        [sub, email, linkUserId, GUILD_ID, googlePicture]
      );
      // No id echoed back in the URL — the panel re-reads it from /2fa/status
      // with its own session, which is also the only way it can report the
      // truth if the browser changed accounts mid-flow.
      return bounce({ google_link: 'ok' });
    }

    // ── resolve the account ──
    let user = null;

    const { rows: bySub } = await query(
      `SELECT u.*, b.balance_cents FROM web_users u
       LEFT JOIN balances b ON b.web_user_id = u.id
       WHERE u.guild_id = $1 AND u.google_id = $2`,
      [GUILD_ID, sub]
    );
    user = bySub[0] || null;

    if (!user) {
      const { rows: byEmail } = await query(
        `SELECT u.*, b.balance_cents FROM web_users u
         LEFT JOIN balances b ON b.web_user_id = u.id
         WHERE u.guild_id = $1 AND lower(u.email) = lower($2)`,
        [GUILD_ID, email]
      );
      if (byEmail.length) {
        user = byEmail[0];
        // Adopting an existing account. Safe only because email_verified was
        // required above; the address alone proves nothing.
        //
        // The guard matters: this account may already carry a DIFFERENT Google
        // identity, and quietly overwriting it would let a second Google
        // account inherit the first one's site account for good. Refusing is
        // the conservative half — the customer signs in the way they already
        // could and links the new Google account deliberately.
        if (user.google_id && user.google_id !== sub) {
          return fail('This account is already linked to a different Google account. Sign in the usual way, then re-link it from Security.');
        }
        await query('UPDATE web_users SET google_id = $1, google_email = $2 WHERE id = $3',
          [sub, email, user.id]);
        user.google_id = sub;
      }
    }

    // Google is a returning-login/linking factor, not an alternate way to
    // create a standalone storefront account. Require an existing verified
    // Discord link and current guild membership before issuing a session.
    if (!user) {
      return fail('Sign up with Discord first — Google sign-in is only available after linking Discord.');
    }
    if (user.role !== 'admin' && user.role !== 'staff') {
      if (!user.discord_id || !user.discord_verified) {
        return fail('Link Discord before using Google sign-in.');
      }
      const discordAccess = await checkDiscordAccess(String(user.discord_id));
      if (!discordAccess.inServer) {
        return fail('Join our Discord server before signing in to the website.');
      }
    }

    // Keep the stored picture current on the way past, whichever of the three
    // resolution branches above produced the row. Guarded so a login by an
    // account whose picture has not changed costs nothing, and best-effort so
    // a write failure never turns a good login into an error.
    await query(
      `UPDATE web_users SET google_avatar = $1
        WHERE id = $2 AND google_avatar IS DISTINCT FROM $1`,
      [googlePicture, user.id]
    ).catch((e) => console.warn('[Auth] google avatar refresh failed:', e.message));

    if (user.banned) return fail('This account has been banned.');

    // ── second factor, if the account has one ──
    // Google settles who owns the mailbox. It cannot settle an authenticator
    // app, so an account that enrolled one is asked for it here exactly as a
    // password login would be. A brand new account has no factors and skips
    // this by construction.
    const methods = [];
    if (user.totp_enabled && user.totp_secret) methods.push('totp');
    if (user.discord_id && user.discord_verified) methods.push('discord');
    if (user.email_2fa_enabled && user.email) methods.push('email');

    if (methods.length) {
      const challengeId = crypto.randomBytes(24).toString('hex');
      await query(
        `INSERT INTO web_login_challenges (id, web_user_id, guild_id, kind, expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '10 minutes')`,
        [challengeId, user.id, GUILD_ID, methods[0]]
      );
      // The challenge id is not a session: it is worthless without the second
      // factor, and /login/verify consumes it. The method list rides along so
      // the page can open the right prompt without a second round trip.
      return bounce({ google_2fa: challengeId, google_2fa_methods: methods.join(',') });
    }

    await query('UPDATE web_users SET last_login_at = now() WHERE id = $1', [user.id]);
    const claim = crypto.randomBytes(32).toString('hex');
    googleClaims.set(claim, { webUserId: user.id, expiresAt: Date.now() + 2 * 60 * 1000 });
    return bounce({ google_login: claim });
  } catch (err) {
    console.error('[Auth] google-oauth callback error:', err.response?.data || err.message);
    return fail(linkUserId ? 'Google linking failed. Please try again.' : 'Google sign-in failed. Please try again.');
  }
});

// ─── POST /api/auth/google-oauth/claim ──────────────────
// Trades the one-time claim from the redirect for the actual session token,
// over a response body instead of a URL. Deleted on the first read, so a claim
// left in browser history by a customer who pressed Back is already spent.
router.post('/google-oauth/claim', async (req, res) => {
  try {
    reapGoogleClaims();
    const claim = String((req.body && req.body.claim) || '').trim();
    const entry = claim && googleClaims.get(claim);
    // Deleted before the row is read, not after: two tabs racing the same claim
    // must not both come away with a session.
    if (entry) googleClaims.delete(claim);
    if (!entry || entry.expiresAt < Date.now()) {
      return res.status(401).json({ error: 'That sign-in link has expired. Please try again.' });
    }

    const { rows } = await query(
      `SELECT u.*, b.balance_cents FROM web_users u
       LEFT JOIN balances b ON b.web_user_id = u.id
       WHERE u.id = $1 AND u.guild_id = $2`,
      [entry.webUserId, GUILD_ID]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Account not found' });
    // Re-checked here rather than trusted from the callback: a ban applied in
    // the seconds between the two would otherwise still hand out a session.
    if (user.banned) return res.status(403).json({ error: 'This account has been banned' });

    // Keep the legacy password login available for existing accounts and for
    // the hardening test contract. Member-only routes still enforce the live
    // Discord link/membership with requireCurrentDiscordMember on every use.
    const token = await createSession(user.id, GUILD_ID);
    res.json({ success: true, token, user: publicUser(user) });
  } catch (err) {
    console.error('[Auth] google claim error:', err);
    res.status(500).json({ error: 'Failed to complete Google sign-in' });
  }
});

// ─── POST /api/auth/signup ──────────────────────────────
router.post('/signup', signupLimiter, async (req, res) => {
  try {
    // The storefront is member-only. Password/email signup used to create
    // rows with no Discord identity at all, leaving accounts that could never
    // receive delivery or pass the member gate. New accounts must be created
    // through the Discord OAuth flow, which verifies ownership and guild
    // membership before inserting the row.
    return res.status(403).json({
      error: 'Discord membership is required. Use Sign Up With Discord.',
      code: 'discord_signup_required',
    });
    /* legacy password-signup path intentionally disabled */
    /* istanbul ignore next */
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
    // An account created with SIGN UP WITH GOOGLE has no password, so no answer
    // typed here can ever be right. Saying so is worth the small amount it
    // gives away — signup already answers "that email is in use" to anyone who
    // asks, so the existence of the account is not a secret this protects, and
    // without the hint a returning customer sits on "invalid password" retrying
    // a password that does not exist. Still counted as a failed attempt, so it
    // is not a free unmetered oracle.
    if (user && !user.password_hash && !user.banned) {
      if (loginLimiter.blocked(req, res)) return;
      loginLimiter.fail(req);
      return res.status(401).json({
        error: 'This account signs in with Google. Use the Google button below.',
        code: 'use_google',
      });
    }
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
      `SELECT c.*, u.email, u.username, u.discord_id, u.discord_verified, u.banned
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
        // An account created through SIGN IN WITH DISCORD has no address, and
        // the DM has to call it something. See utils/discordAccount.js.
        account_label: row.email || `@${row.username}`,
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
      // Google, for the same card. The address is the one Google gave us, which
      // is not necessarily the account's own email — showing the account email
      // back would tell the customer nothing about WHICH Google account is
      // attached, which is the only question this row answers.
      google_email: req.user.google_id ? (req.user.google_email || null) : null,
      google_linked: !!req.user.google_id,
      // Drives the wording on the password field: an account that has never had
      // a password is SETTING one, not changing one, and must not be asked for
      // a current password it does not have.
      has_password: !!req.user.password_hash,
      google_available: googleConfigured(),
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

// ─── Proving you are the owner, not just a session ──────
// /2fa/disable, /2fa/email/disable and /2fa/discord/unlink all take a factor
// OFF the account, so all three need more than the bearer token already in the
// request: a stolen session must not be able to undress the account it walked
// into.
//
// That used to mean "the current password", full stop. It became a one-way door
// the moment an account could exist without one — sign up with Google, enable
// the authenticator, and there is no password to type, so the factor can never
// come back off. Exactly the shape of the hide button that could not unhide.
//
// So the question is not "what is your password" but "prove it is you", and the
// account answers with whatever it actually holds:
//   * the password, when it has one;
//   * a live code from the enrolled authenticator — possession, which is what
//     the password was standing in for;
//   * an unused backup code, consumed on use;
//   * a code just mailed to the address on the account, which is the only proof
//     left for the one shape that holds none of the above (no password, email
//     verification its only factor). That one has to be asked for deliberately
//     via /2fa/email/start {reauth:true}, so a password attempt never burns a
//     guess against it.
//
// Every branch is at least as strong as the password it replaces, and none of
// them is something a session thief has by virtue of holding the session.
// Returns { ok, usedBackupCode }.
async function verifyReauth(user, given) {
  const proof = String(given == null ? '' : given).trim();
  if (!proof) return { ok: false };

  if (user.password_hash && verifyPassword(proof, user.password_hash)) return { ok: true };
  if (user.totp_enabled && user.totp_secret && verifyTOTP(user.totp_secret, proof)) return { ok: true };

  reapEmailEnrollments();
  const pending = pendingEmailEnrollments.get(String(user.id));
  if (pending && pending.purpose === 'reauth') {
    if (pending.attempts >= 8) {
      pendingEmailEnrollments.delete(String(user.id));
    } else if (safeCompare(hashLoginCode(proof), pending.hash)) {
      pendingEmailEnrollments.delete(String(user.id));
      return { ok: true };
    } else {
      pending.attempts++;
    }
  }

  // Last, because it consumes: a backup code spent against a wrong guess on one
  // of the branches above would be gone for nothing.
  const { rows } = await query(
    `UPDATE web_user_backup_codes SET used_at = now()
      WHERE id = (SELECT id FROM web_user_backup_codes
                   WHERE web_user_id = $1 AND used_at IS NULL AND code_hash = $2
                   LIMIT 1)
      RETURNING id`,
    [user.id, hashBackupCode(proof)]
  );
  if (rows.length) return { ok: true, usedBackupCode: true };

  return { ok: false };
}

// What the browser should ask this account for. An account with no password
// must not be shown a "current password" box it can never fill.
function reauthPrompt(user) {
  if (user.password_hash) return 'password';
  if (user.totp_enabled) return 'totp';
  if (user.email_2fa_enabled) return 'email_code';
  return 'password';
}

// ─── POST /api/auth/2fa/disable ─────────────────────────
// Requires proof of ownership: a hijacked session must not be able to strip the
// second factor off the account it just walked into.
router.post('/2fa/disable', requireAuth, async (req, res) => {
  try {
    // `password` is still the field name because that is what every existing
    // caller sends; it now carries whichever proof the account has.
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({
        error: 'Confirm it is you before disabling 2FA', needs: reauthPrompt(req.user),
      });
    }
    const { rows } = await query('SELECT * FROM web_users WHERE id = $1', [req.user.id]);
    const proof = rows.length ? await verifyReauth(rows[0], password) : { ok: false };
    if (!proof.ok) {
      if (loginLimiter.blocked(req, res)) return;
      loginLimiter.fail(req);
      return res.status(401).json({ error: 'That did not match.', needs: reauthPrompt(req.user) });
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
    // Two errands, one mailing. `reauth` asks for a code to PROVE ownership
    // (see verifyReauth) rather than to switch the factor on, and it is the
    // only proof an account with no password and no authenticator has left.
    // The two are told apart by `purpose` on the pending record, so a code sent
    // for one can never be redeemed for the other.
    const forReauth = !!(req.body && req.body.reauth);
    if (!req.user.email) return res.status(400).json({ error: 'This account has no email address on file.' });
    if (!forReauth && req.user.email_2fa_enabled) return res.status(400).json({ error: 'Email verification is already enabled.' });
    if (forReauth && !req.user.email_2fa_enabled) return res.status(400).json({ error: 'Email verification is not enabled on this account.' });

    const code = generateEmailCode();
    const sent = await sendLoginCode(req.user.email, code, forReauth ? 'login' : 'setup');
    if (!sent) return res.status(502).json({ error: 'Could not send the confirmation email. Try again shortly.' });

    pendingEmailEnrollments.set(String(req.user.id), {
      hash: hashLoginCode(code),
      attempts: 0,
      purpose: forReauth ? 'reauth' : 'enroll',
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
    // A code mailed to prove ownership must not be redeemable to switch the
    // factor ON — otherwise the two purposes collapse into one and a reauth
    // code becomes an enrolment.
    if (pending.purpose !== 'enroll') return res.status(400).json({ error: 'That code expired. Send a new one.' });
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
    if (!password) {
      return res.status(400).json({
        error: 'Confirm it is you before disabling email verification', needs: reauthPrompt(req.user),
      });
    }
    const { rows } = await query('SELECT * FROM web_users WHERE id = $1', [req.user.id]);
    const proof = rows.length ? await verifyReauth(rows[0], password) : { ok: false };
    if (!proof.ok) {
      if (loginLimiter.blocked(req, res)) return;
      loginLimiter.fail(req);
      return res.status(401).json({ error: 'That did not match.', needs: reauthPrompt(req.user) });
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

// ─── PATCH /api/auth/profile ────────────────────────────
// Edit Profile had no backend at all. The storefront wrote the new username,
// email, avatar and password into localStorage and said "Profile updated!",
// so the account page showed an address the database had never heard of. It
// surfaced through email 2FA — the enrolment code went to the ORIGINAL
// address, because that is the only one that ever existed — but the password
// field was the worse half: someone could change their password, be told it
// worked, and still be signed in with the old one everywhere else.
//
// Changing the email is gated on the current password for the same reason
// /2fa/disable is: an email address is the account-recovery pivot, so letting
// a hijacked session move it is no better than letting it strip the second
// factor.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { username, email, avatar, new_password, current_password } = req.body;

    const nextUsername = username != null ? String(username).trim() : req.user.username;
    // Null rather than '' when there is no address, because that is what the
    // column holds and '' would be an address as far as UNIQUE (guild_id,
    // email) is concerned — the second addressless account to save its profile
    // would collide with the first.
    const nextEmail = email != null ? (String(email).trim() || null) : (req.user.email || null);
    const nextAvatar = avatar != null ? String(avatar).trim() : undefined;

    if (!nextUsername) return res.status(400).json({ error: 'Username cannot be empty' });
    if (nextUsername.length > 32) return res.status(400).json({ error: 'Username must be 32 characters or fewer' });
    // An account signed up through Discord has no address and the form posts
    // an empty box; rejecting that made the WHOLE page unsaveable for them —
    // avatar, username, password, all of it — over a field they were never
    // given. Blank is only accepted while the account genuinely has none:
    // an address already on file cannot be blanked, because it is the
    // account-recovery pivot and losing it silently is how someone gets locked
    // out. Round 29 item 6.
    if (!nextEmail && req.user.email) {
      return res.status(400).json({ error: 'Email cannot be empty' });
    }
    if (nextEmail && !EMAIL_RE.test(nextEmail)) {
      return res.status(400).json({ error: 'That does not look like an email address' });
    }
    // The avatar is a single emoji; anything longer is not one, and this
    // column is rendered straight into the page.
    if (nextAvatar !== undefined && nextAvatar.length > 8) {
      return res.status(400).json({ error: 'Invalid avatar' });
    }
    if (new_password != null && String(new_password).length && String(new_password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Case-insensitively, because the unique index is case-insensitive and
    // "changing" GHOST.EXE@gmail.com to ghost.exe@gmail.com should not be
    // treated as moving to a new mailbox.
    const emailChanged = String(nextEmail || '').toLowerCase() !== String(req.user.email || '').toLowerCase();
    const usernameChanged = nextUsername.toLowerCase() !== String(req.user.username || '').toLowerCase();
    const passwordChanged = !!(new_password != null && String(new_password).length);

    const { rows: cur } = await query('SELECT password_hash FROM web_users WHERE id = $1', [req.user.id]);
    if (!cur.length) return res.status(404).json({ error: 'Account not found' });
    const hasPassword = !!cur[0].password_hash;

    // An account created through Discord has no password to prove anything
    // with; its session is the only credential it has ever had. Demanding one
    // would lock it out of its own profile.
    if ((emailChanged || passwordChanged) && hasPassword) {
      if (!current_password) {
        return res.status(400).json({ error: 'Enter your current password to change your email or password' });
      }
      if (!verifyPassword(String(current_password), cur[0].password_hash)) {
        if (loginLimiter.blocked(req, res)) return;
        loginLimiter.fail(req);
        return res.status(401).json({ error: 'Incorrect password' });
      }
    }

    // Saving the form without touching anything — or retyping the same address
    // in different case, which is the same mailbox as far as the unique index
    // and the mail server are concerned. Same response shape as a real save so
    // the storefront has one path to read.
    if (!emailChanged && !usernameChanged && !passwordChanged && nextAvatar === undefined) {
      return res.json({
        success: true, unchanged: true, user: publicUser(req.user),
        email_changed: false, password_changed: false,
        email_2fa_disabled: false, sessions_revoked: 0,
      });
    }

    // Checked up front so the common case gets a sentence a person can act on
    // rather than a constraint name. The UPDATE still catches the race below.
    if (emailChanged || usernameChanged) {
      const { rows: clash } = await query(
        `SELECT id FROM web_users
          WHERE guild_id = $1 AND id <> $2 AND (lower(username) = lower($3) OR lower(email) = lower($4))`,
        [GUILD_ID, req.user.id, nextUsername, nextEmail]
      );
      if (clash.length) return res.status(409).json({ error: 'That username or email is already in use' });
    }

    // Moving the address while email 2FA is on would leave the second factor
    // pointed at a mailbox nobody has proved they can read. Rather than invent
    // a second confirmation flow, the factor is switched off and the customer
    // re-enables it — which sends a code to the new address and proves control
    // there. The invariant holds either way: email 2FA is only ever on for an
    // address that has received a code.
    const dropEmail2fa = emailChanged && req.user.email_2fa_enabled;

    const sets = ['username = $1', 'email = $2'];
    const params = [nextUsername, nextEmail];
    if (nextAvatar !== undefined) { params.push(nextAvatar); sets.push(`avatar = $${params.length}`); }
    if (passwordChanged) { params.push(hashPassword(String(new_password))); sets.push(`password_hash = $${params.length}`); }
    if (dropEmail2fa) sets.push('email_2fa_enabled = false');
    params.push(req.user.id, GUILD_ID);

    let updated;
    try {
      const { rows } = await query(
        `UPDATE web_users SET ${sets.join(', ')}
          WHERE id = $${params.length - 1} AND guild_id = $${params.length} RETURNING *`,
        params
      );
      updated = rows[0];
    } catch (err) {
      // 23505 = unique_violation: someone took the name between the check and
      // the write.
      if (err.code === '23505') return res.status(409).json({ error: 'That username or email is already in use' });
      throw err;
    }
    if (!updated) return res.status(404).json({ error: 'Account not found' });

    if (dropEmail2fa) pendingEmailEnrollments.delete(String(req.user.id));

    // Changing a password because you think someone else has it is worth
    // nothing if their session keeps working, so every OTHER session is
    // dropped — the admin reset does the same. This one is spared: logging
    // someone out of the tab they just used is a bug, not security.
    let sessionsRevoked = 0;
    if (passwordChanged) {
      const { bearerToken } = require('../utils/auth');
      const token = bearerToken(req);
      const { rowCount } = await query(
        'DELETE FROM web_sessions WHERE web_user_id = $1 AND token IS DISTINCT FROM $2',
        [req.user.id, token || null]
      );
      sessionsRevoked = rowCount || 0;
    }

    res.json({
      success: true,
      user: publicUser(updated),
      // The storefront has to say these out loud: a silent 2FA switch-off is
      // the kind of surprise a customer discovers at the worst moment.
      email_changed: emailChanged,
      password_changed: passwordChanged,
      email_2fa_disabled: dropEmail2fa,
      sessions_revoked: sessionsRevoked,
    });
  } catch (err) {
    console.error('[Auth] profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ─── Custom profile pictures ─────────────────────────────
// web_users.avatar stays what it always was: one emoji, capped at 8 chars by
// the handler above because it is rendered straight into the page. An uploaded
// picture is a different thing in a different table (web_user_avatars), and
// the two coexist — the emoji is the fallback for every account that has not
// uploaded one, and for the instant an upload is deleted.
//
// Same decoder the review screenshots use, so the same rule applies: the
// declared type has to match the file's magic bytes, and SVG is refused. That
// matters more here than it does on a review, because this URL is public and
// its Content-Type is replayed from what was stored.
const MAX_AVATAR_BYTES = 1024 * 1024;   // must match GX_AVATAR_MAX_BYTES on the storefront
const AVATAR_BODY_LIMIT = '2mb';        // base64 is ~4/3 of the bytes, plus JSON overhead

// POST /api/auth/avatar  { image: "data:image/png;base64,..." }
// Parses its own body: the global parser is capped at 100kb and stands aside
// for this path (see BIG_BODY_ROUTES in server.js). requireAuth runs FIRST so
// an anonymous caller cannot make us buffer 2MB before being told no.
router.post('/avatar', requireAuth, express.json({ limit: AVATAR_BODY_LIMIT }), async (req, res) => {
  try {
    const img = decodeImageDataUrl(req.body && req.body.image, MAX_AVATAR_BYTES);
    if (img.error) return res.status(400).json({ error: img.error });
    if (!img.data) return res.status(400).json({ error: 'No image supplied' });

    // One row per user, replaced in place. The version bump is what makes the
    // year-long cache header on the GET safe: the URL changes with the bytes.
    // abs() because a delete parks the counter on the negative side (see
    // below) — counting up from the magnitude means no ?v= is ever reissued.
    const { rows } = await withTransaction(async (exec) => {
      await exec(
        `INSERT INTO web_user_avatars (web_user_id, data, mime, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (web_user_id) DO UPDATE SET data = EXCLUDED.data, mime = EXCLUDED.mime, updated_at = now()`,
        [req.user.id, img.data, img.mime]
      );
      return exec(
        `UPDATE web_users SET avatar_version = abs(avatar_version) + 1
          WHERE id = $1 AND guild_id = $2 RETURNING *`,
        [req.user.id, GUILD_ID]
      );
    });
    if (!rows.length) return res.status(404).json({ error: 'Account not found' });

    res.json({ success: true, user: publicUser({ ...rows[0], balance_cents: req.user.balance_cents }) });
  } catch (err) {
    console.error('[Auth] avatar upload error:', err);
    res.status(500).json({ error: 'Failed to save that picture' });
  }
});

// DELETE /api/auth/avatar — back to the emoji.
// The counter goes NEGATIVE rather than to zero. Zero would mean "no picture"
// correctly, but it would also restart the numbering, and a browser still
// holding ?v=1 from the deleted picture would keep serving it once the next
// upload claimed v=1 again — the immutable header means it would never ask.
// Negating keeps the high-water mark while making avatar_version > 0 false,
// which is the single test publicUser() uses to decide there is a picture.
router.delete('/avatar', requireAuth, async (req, res) => {
  try {
    const { rows } = await withTransaction(async (exec) => {
      await exec('DELETE FROM web_user_avatars WHERE web_user_id = $1', [req.user.id]);
      return exec(
        `UPDATE web_users SET avatar_version = -abs(avatar_version)
          WHERE id = $1 AND guild_id = $2 RETURNING *`,
        [req.user.id, GUILD_ID]
      );
    });
    if (!rows.length) return res.status(404).json({ error: 'Account not found' });
    res.json({ success: true, user: publicUser({ ...rows[0], balance_cents: req.user.balance_cents }) });
  } catch (err) {
    console.error('[Auth] avatar delete error:', err);
    res.status(500).json({ error: 'Failed to remove that picture' });
  }
});

// GET /api/auth/avatar/:userId — public, because an avatar shows up next to a
// name in places a logged-out visitor can see. Nothing private is exposed: it
// is a picture the account chose to publish, addressed by an id that is
// already in every public payload.
router.get('/avatar/:userId', async (req, res) => {
  try {
    if (!/^\d+$/.test(String(req.params.userId))) return res.status(404).end();
    const { rows } = await query(
      `SELECT a.data, a.mime, u.avatar_version
         FROM web_user_avatars a
         JOIN web_users u ON u.id = a.web_user_id
        WHERE a.web_user_id = $1 AND u.guild_id = $2`,
      [req.params.userId, GUILD_ID]
    );
    if (!rows.length) return res.status(404).end();

    res.set('Content-Type', rows[0].mime || 'image/png');
    res.set('X-Content-Type-Options', 'nosniff');
    // Immutable is only correct because publicUser() puts ?v=<avatar_version>
    // in the URL and that number changes on every upload and every delete. A
    // caller that drops the query string gets a stale picture and has earned it.
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    res.send(rows[0].data);
  } catch (err) {
    console.error('[Auth] avatar fetch error:', err);
    res.status(500).end();
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
        account_label: req.user.email || `@${req.user.username}`,
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

// ─── Discord roles for one linked website user ────────────────────────────
// Website authority and Discord authority are deliberately shown side by
// side in the Roles tab, but they remain separate writes. A Discord badge must
// never silently promote a web account to staff/admin, and changing a website
// role must never rewrite an unrelated server role.
// Create a regular Discord guild role from the owner-admin panel. Discord
// remains the authority for the role itself; this endpoint only proxies the
// bot's create call and returns safe display metadata to the browser.
router.post('/admin/discord-roles', requireOwnerAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const role = await createDiscordRole(body.name || body.role_name, body.color);
    if (!/^\d{15,22}$/.test(String(role.id || ''))) {
      return res.status(502).json({ error: 'Discord returned an invalid role' });
    }
    await logAdminAction(req, 'create_discord_role', null, {
      discord_role_id: role.id,
      discord_role_name: role.name,
      discord_role_color: role.color,
    });
    res.status(201).json({ success: true, role });
  } catch (err) {
    const status = err.response?.status && err.response.status < 500
      ? err.response.status
      : (err.statusCode || 502);
    const message = err.response?.data?.message || err.message || 'Could not create Discord role';
    res.status(status).json({ error: message });
  }
});

router.get('/admin/users/:id/discord-roles', requireOwnerAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, username, discord_id, discord_verified FROM web_users WHERE id = $1 AND guild_id = $2',
      [req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    if (!rows[0].discord_id || !rows[0].discord_verified) {
      return res.status(400).json({ error: 'This website account has no verified Discord link' });
    }
    const roles = await getDiscordMemberRoles(rows[0].discord_id);
    res.json({
      success: true,
      user: { id: String(rows[0].id), username: rows[0].username, discord_id: rows[0].discord_id },
      roles: roles.filter((role) => role.name !== '@everyone').sort((a, b) => b.position - a.position),
    });
  } catch (err) {
    const status = err.response?.status === 404 ? 404 : (err.statusCode || 502);
    const message = err.response?.status === 404
      ? 'The linked Discord user is not in the server'
      : (err.response?.data?.message || err.message || 'Could not load Discord roles');
    res.status(status).json({ error: message });
  }
});

router.post('/admin/users/:id/discord-role', requireOwnerAdmin, async (req, res) => {
  try {
    const roleId = String((req.body && req.body.role_id) || '').trim();
    const assigned = !!(req.body && req.body.assigned);
    if (!/^\d{15,22}$/.test(roleId)) return res.status(400).json({ error: 'Valid role_id is required' });
    const { rows } = await query(
      'SELECT id, username, discord_id, discord_verified FROM web_users WHERE id = $1 AND guild_id = $2',
      [req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    if (!rows[0].discord_id || !rows[0].discord_verified) {
      return res.status(400).json({ error: 'This website account has no verified Discord link' });
    }
    const role = await setDiscordMemberRole(rows[0].discord_id, roleId, assigned);
    await logAdminAction(req, assigned ? 'grant_discord_role' : 'revoke_discord_role', rows[0].id, {
      username: rows[0].username, discord_id: rows[0].discord_id,
      discord_role_id: role.id, discord_role_name: role.name,
    });
    res.json({ success: true, role });
  } catch (err) {
    const status = err.response?.status === 404 ? 404 : (err.statusCode || 502);
    res.status(status).json({ error: err.response?.data?.message || err.message || 'Could not update Discord role' });
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

// ─── POST /api/auth/admin/link-discord ───────────────────
// Owner-admin recovery path for a customer who can no longer access the
// Discord account previously linked to their site account.  This deliberately
// requires the owner-admin role: marking a snowflake verified grants that
// Discord identity passwordless login and Vault access.
//
// The two identifiers are kept as text. Discord snowflakes are 17–20 digits
// and exceed JavaScript's safe integer range, so never parse them as numbers.
router.post('/admin/link-discord', requireOwnerAdmin, async (req, res) => {
  try {
    const userId = String((req.body && req.body.user_id) || '').trim();
    const discordId = String((req.body && req.body.discord_id) || '').trim();
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    if (!/^\d{15,25}$/.test(discordId)) {
      return res.status(400).json({ error: 'That does not look like a Discord user ID.' });
    }

    const { rows: target } = await query(
      `SELECT id, username, role, discord_id FROM web_users
       WHERE id = $1 AND guild_id = $2`,
      [userId, GUILD_ID]
    );
    if (!target.length) return res.status(404).json({ error: 'User not found' });

    // Never steal a verified Discord identity from another account. Use a
    // separate query so the response can identify the conflict cleanly.
    const { rows: taken } = await query(
      `SELECT id, username FROM web_users
       WHERE guild_id = $1 AND discord_id = $2 AND discord_verified = true AND id <> $3`,
      [GUILD_ID, discordId, userId]
    );
    if (taken.length) {
      return res.status(409).json({
        error: 'That Discord account is already linked to another site account.',
        username: taken[0].username,
      });
    }

    const { rows } = await query(
      `UPDATE web_users
          SET discord_id = $1, discord_verified = true, discord_avatar = NULL
        WHERE id = $2 AND guild_id = $3
      RETURNING id, username, discord_id, discord_verified`,
      [discordId, userId, GUILD_ID]
    );
    await logAdminAction(req, 'link_discord', userId, {
      username: rows[0].username,
      discord_id: discordId,
      previous_discord_id: target[0].discord_id || null,
    });
    res.json({
      success: true,
      user: { ...rows[0], id: String(rows[0].id) },
    });
  } catch (err) {
    // A partial unique index can still win a race between the duplicate check
    // and UPDATE. Surface that as the same safe conflict instead of a 500.
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'That Discord account is already linked to another site account.' });
    }
    console.error('[Auth] admin/link-discord error:', err);
    res.status(500).json({ error: 'Failed to link Discord' });
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
    if (!password) {
      return res.status(400).json({ error: 'Confirm it is you first', needs: reauthPrompt(req.user) });
    }
    const { rows } = await query('SELECT * FROM web_users WHERE id = $1', [req.user.id]);
    const proof = rows.length ? await verifyReauth(rows[0], password) : { ok: false };
    if (!proof.ok) {
      return res.status(401).json({ error: 'That did not match.', needs: reauthPrompt(req.user) });
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
