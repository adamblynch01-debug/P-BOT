-- ─── Sign in / sign up with Google ──────────────────────────────────────────
-- Three columns and one index. Everything else about the account is unchanged:
-- a Google sign-in resolves to an ordinary web_users row, with the same
-- sessions, the same 2FA and the same balance as one created with a password.
--
-- WHY google_id AND google_email.
--
-- `google_id` is Google's `sub` claim, which is the only stable identifier the
-- account has — it never changes, and it is what a returning customer is looked
-- up by. The email is NOT stable: a customer can change the address on their
-- Google account, and a Workspace admin can reassign one. So the address is
-- stored alongside for display and for support ("which Google account is this?")
-- and is never the thing a login matches on after the first link.
--
-- The FIRST link is the exception, and it has to be: someone who already has a
-- password account here and then presses SIGN IN WITH GOOGLE must land in their
-- own account rather than a duplicate. That match is by email, and it is only
-- safe because the route refuses any Google identity whose `email_verified` is
-- false — otherwise anyone able to set an arbitrary unverified address on a
-- Google account could take over an account here by pressing one button.
--
-- WHY password_hash BECOMES NULLABLE.
--
-- An account created by pressing SIGN UP WITH GOOGLE has no password and must
-- not be given a fake one: a random unusable hash would leave the account
-- looking, to every later query, exactly like an account whose password nobody
-- can remember. NULL says the thing that is true — there is no password on this
-- account, Google is how it gets in.
--
-- Nothing needs a backfill and nothing needs to change to keep working:
-- verifyPassword() already returns false for a null hash (it splits '' and
-- finds no salt), and PATCH /api/auth/profile already has an explicit branch for
-- "this account has no password to prove anything with" — written for a
-- hypothetical Discord-created account that never actually existed. It does now.
--
-- Setting a password later is the normal profile edit: /profile only demands the
-- current password when there IS one.
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend. Without it
-- every callback raises on a column that does not exist, which lands on the
-- customer as "Google sign-in failed" with the real reason only in the logs.

ALTER TABLE web_users ADD COLUMN IF NOT EXISTS google_id    TEXT;
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS google_email TEXT;

-- A password is no longer the only way to hold an account.
ALTER TABLE web_users ALTER COLUMN password_hash DROP NOT NULL;

-- The same backstop discord_link_unique.sql puts under discord_id, for the same
-- reason: several resolvers do `WHERE guild_id = $1 AND <id> = $2` and then take
-- rows[0] with no multi-match guard, and Postgres returns those rows in
-- unspecified order. One Google account, one site account — enforced here rather
-- than only in the route, so a future second write path cannot reintroduce it.
--
-- If this fails with "could not create unique index", there are already
-- duplicates. Find them with:
--
--   SELECT google_id, COUNT(*), array_agg(id) FROM web_users
--    WHERE google_id IS NOT NULL GROUP BY google_id HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_web_users_google
  ON web_users (guild_id, google_id)
  WHERE google_id IS NOT NULL;
