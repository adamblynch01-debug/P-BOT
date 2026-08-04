-- ─── Real profile pictures on reviews ────────────────────────────────────────
-- Round 29 item 4: "when posting a review it shows their actual profile image,
-- either from the site or from user discord".
--
-- GET /api/reviews returned no avatar of any kind, so every vouch on the
-- storefront was drawn with the same placeholder. Three separate pictures could
-- have filled it and none of them were being kept:
--
--   1. the picture the account uploaded          — already stored, in
--                                                  web_user_avatars, and served
--                                                  by GET /api/auth/avatar/:id
--   2. their Discord picture                     — the OAuth callback read
--                                                  me.data.avatar and THREW IT
--                                                  AWAY; there was no column
--   3. their Google picture                      — likewise, the id_token
--                                                  carries `picture` and it was
--                                                  discarded
--
-- This adds (2) and (3). Both are stored as the identifier Discord/Google hand
-- out, not as fetched bytes:
--
--   * A Discord AVATAR url is unsigned and stable
--     (cdn.discordapp.com/avatars/<user id>/<hash>.png). That is the opposite
--     of a Discord ATTACHMENT url, which is signed and dies within a day — and
--     is exactly why routes/reviews.js downloads vouch SCREENSHOTS but should
--     not download avatars. Copying an avatar would mean it silently goes stale
--     the moment the member changes their picture, with nothing to invalidate
--     it, and would put ~200 more BYTEA rows behind a public list endpoint.
--   * The Google `picture` claim is a full https URL, stored as given.
--
-- reviews.avatar_hash is the third column and the reason this is not just two
-- ALTERs on web_users: a vouch synced out of the #vouches channel usually
-- belongs to someone who has NEVER logged into the site. There is no web_users
-- row to read a hash off, so the bot sends the hash it can already see on the
-- Discord message author, and it is kept on the review itself.
--
--   psql "$DATABASE_URL" -f backend/migrations/review_avatars.sql
--   -- or: railway run node backend/_apply_review_avatars_migration.js

-- The Discord avatar HASH, not a url. Discord's own cdn path is rebuilt from
-- (discord_id, hash) at render time, so a member who changes their picture only
-- invalidates this one string and not a cached copy of the bytes.
-- Nullable and unset for every existing row: absence means "we have never seen
-- one", which is correctly indistinguishable from "they have no picture" — both
-- fall through to the next source.
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS discord_avatar TEXT;

-- Google's `picture` claim, a full https URL. Stored verbatim.
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS google_avatar TEXT;

-- For a reviewer with no site account. Set by POST /api/reviews/bot from the
-- Discord message author at vouch time.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS avatar_hash TEXT;

-- GET /api/reviews resolves the author by web_user_id first and falls back to
-- discord_id, for the very common case of a vouch left in Discord by someone
-- who later made a site account. Without this index that fallback is a
-- sequential scan of web_users per review row, 200 times per page load.
CREATE INDEX IF NOT EXISTS idx_web_users_guild_discord
  ON web_users (guild_id, discord_id) WHERE discord_id IS NOT NULL;
