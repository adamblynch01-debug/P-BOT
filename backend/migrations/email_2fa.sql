-- ─── Email as a second factor ───────────────────────────────────────
-- The account already has two second factors (TOTP and the Discord DM), and
-- both of them can be lost in a way the customer cannot recover from on their
-- own: a wiped phone takes the authenticator with it, and the Discord leg needs
-- the member to still be in the guild with DMs open. Email is the one channel
-- this store already knows works for every account — it is where the order
-- confirmation goes.
--
-- Only a flag is needed. The code itself is never stored in the clear and never
-- lives in web_users: it is a sha256 hash written to the EXISTING
-- web_login_challenges.ref column (kind = 'email'), which already carries the
-- SUPERBOT session id for the Discord leg and has no CHECK constraint on kind.
-- So the challenge expiry, the attempt cap and the consumed_at single-use rule
-- all apply to the email code for free.
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend: the login
-- route reads this column on every login, so shipping the code first turns
-- every sign-in into a 500.

ALTER TABLE web_users ADD COLUMN IF NOT EXISTS email_2fa_enabled BOOLEAN NOT NULL DEFAULT false;
