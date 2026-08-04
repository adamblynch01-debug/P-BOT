-- ─── An account you can have without an email address ───────────────────────
-- Round 29 item 6: "If user has not made an account and no email found. Have it
-- register with their discord account then. So they can redeem. So order can be
-- looked up by user also!!"
--
-- Two dead ends produced that:
--
--   1. SIGN IN WITH DISCORD on the storefront could only LOG IN. The callback
--      looked for an already-linked row and, finding none, returned a decoy
--      pending_id that never verifies — so a customer with no account pressed
--      the button, was told to check their DMs, and waited for a DM that was
--      never sent. It never created anything.
--
--   2. The claim panel and /claim-customer both demanded an email. An order
--      delivered by staff through /manual-order-delivery can have NO address on
--      it at all (routes/orders.js POST /manual takes `email` as optional and
--      falls back to the account's, of which there may be none) — so the buyer
--      had nothing to type into a required field, and the order they had paid
--      for was unclaimable. The bot already accepted the Discord account named
--      ON the order as proof; the form just never let anyone get that far.
--
-- Fixing either one means creating a web_users row from a Discord identity, and
-- such a row has no email.
--
-- WHY email BECOMES NULLABLE.
--
-- Exactly the argument google_oauth.sql made for password_hash: an account
-- created from a Discord identity has no address and must not be given a fake
-- one. A synthesised placeholder (`<snowflake>@discord.local`) would be indexed
-- by UNIQUE (guild_id, email), would be offered back to the customer as "your
-- email" on the account page, would be handed to the receipt mailer, and would
-- read to every later query as an address that simply does not receive. NULL
-- says the true thing: there is no address on this account yet.
--
-- UNIQUE (guild_id, email) is unaffected — Postgres treats NULLs as distinct in
-- a unique index, so any number of accounts may hold no address.
--
-- What already copes, and why nothing needs a backfill:
--   * login by email finds no row for a NULL, which is correct — this account
--     signs in through Discord.
--   * sendOrderConfirmation() and sendLoginCode() both return false early on a
--     missing recipient rather than throwing.
--   * publicUser() passes `email` straight through; the storefront already
--     renders a null there (a Google signup can carry a null password_hash and
--     the same page handles it).
--   * email 2FA enrolment reads `user.email_2fa_enabled && user.email`, so an
--     addressless account simply has no email factor to offer.
-- Adding an address later is the ordinary profile edit.
ALTER TABLE web_users ALTER COLUMN email DROP NOT NULL;

-- ─── The two sweeps a claim performs ────────────────────────────────────────
-- Proving one invoice belongs to a Discord user proves the same thing about
-- every OTHER unowned order carrying that identity, and attaching them is the
-- whole of "so order can be looked up by user also" — one claim, and their
-- history appears under the account instead of one invoice doing.
--
-- Both sweeps are `WHERE guild_id = … AND web_user_id IS NULL AND <identity>`,
-- run interactively while a customer waits on a Discord reply, so neither
-- should be a sequential scan of the orders table.
CREATE INDEX IF NOT EXISTS idx_orders_guild_discord
  ON orders (guild_id, discord_id) WHERE discord_id IS NOT NULL;

-- lower(), because an address is matched case-insensitively everywhere it is
-- matched at all — a plain index on `email` would not be usable by that
-- comparison and would sit there being maintained for nothing.
CREATE INDEX IF NOT EXISTS idx_orders_guild_email_lower
  ON orders (guild_id, lower(email)) WHERE email IS NOT NULL;

--   psql "$DATABASE_URL" -f backend/migrations/discord_signup.sql
--   -- or: railway run node backend/_apply_discord_signup_migration.js
--
-- Run BEFORE deploying this backend: without it every Discord signup fails on
-- the NOT NULL, which reaches the customer as "Discord login failed" with the
-- real reason only in the logs.
