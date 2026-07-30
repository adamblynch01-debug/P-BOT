-- ─── One verified Discord account per site account ──────────────────
-- POST /api/auth/confirm-discord used to write `discord_verified = true` for
-- whatever discord_id the browser put in the request body, with no check that
-- the caller controlled that account. So two rows could carry the same
-- snowflake — and several admin paths resolve a target with
-- `WHERE guild_id = $1 AND discord_id = $2` and then take rows[0] with no
-- multi-match guard (balance adjust, admin adjust, reseller resolve). Postgres
-- returns those rows in unspecified order, so a credit could land in the wrong
-- wallet.
--
-- The route is fixed (linking now requires a SUPERBOT-confirmed DM click) and
-- the resolvers now refuse an ambiguous match. This index is the backstop that
-- makes the duplicate impossible in the first place.
--
-- Partial on discord_verified so unverified/placeholder rows and NULLs are
-- unaffected.
--
-- If this fails with "could not create unique index", there are already
-- duplicates in production. Find them first:
--
--   SELECT discord_id, COUNT(*), array_agg(id) FROM web_users
--    WHERE discord_id IS NOT NULL AND discord_verified
--    GROUP BY discord_id HAVING COUNT(*) > 1;
--
-- and clear discord_id on the rows that should not own it before re-running.
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_web_users_discord
  ON web_users (guild_id, discord_id)
  WHERE discord_id IS NOT NULL AND discord_verified;
