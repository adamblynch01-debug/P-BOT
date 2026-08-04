-- ─── Custom profile pictures ─────────────────────────────────────────────────
-- web_users.avatar is TEXT holding a single emoji, and PATCH /api/auth/profile
-- caps it at 8 characters — deliberately, because that column is rendered
-- straight into the page. So an uploaded picture cannot live there, and this
-- migration does NOT widen it: the emoji stays as the fallback for every
-- account that never uploads one, and for the moment an upload is deleted.
--
-- The bytes go in their own table rather than in a new web_users column
-- because getSessionUser() does `SELECT u.*` on every authenticated request.
-- A BYTEA column on web_users would mean every API call in the product drags
-- the user's profile picture out of Postgres and throws it away.
--
-- web_users.avatar_version is the cheap half that DOES belong on the row: it
-- is an int, so `SELECT u.*` stays free, and it carries two facts at once —
--   0  = never uploaded a picture, use the emoji
--   >0 = there is one, and this number is the cache buster in its URL
--   <0 = there was one and it was deleted; the magnitude is the high-water
--        mark, so the next upload gets a version no cache has ever seen.
-- GET /api/auth/avatar/:id is served immutable-for-a-year, which is only safe
-- because the ?v= in the URL changes the moment the bytes do. Without the
-- version an account that changed its picture would show the old one until
-- the browser cache expired.
--
-- The sign is doing real work and is not a flourish. publicUser() is fed rows
-- from a dozen different `SELECT u.*` and `RETURNING *` queries, so anything
-- it needs has to already be on the row — an EXISTS against this table would
-- be correct in /me and silently null everywhere else. And resetting to 0 on
-- delete is the one thing that must not happen: the counter would restart at
-- 1 on the next upload, and a browser still holding ?v=1 from the FIRST
-- picture would serve that one back out of cache forever.
--
--   psql "$DATABASE_URL" -f backend/migrations/user_avatars.sql

ALTER TABLE web_users
  ADD COLUMN IF NOT EXISTS avatar_version INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS web_user_avatars (
  web_user_id BIGINT PRIMARY KEY REFERENCES web_users(id) ON DELETE CASCADE,
  data        BYTEA       NOT NULL,
  mime        TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
