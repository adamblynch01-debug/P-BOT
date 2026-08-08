-- Round 45: product_updates — stores updates posted via the bot's /postupdate
-- command so the website's Updates page can display them. Run on Railway before
-- deploying the backend that mounts routes/updates.js.
--
--   railway run psql < backend/migrations/product_updates.sql

CREATE TABLE IF NOT EXISTS product_updates (
  id            SERIAL PRIMARY KEY,
  guild_id      TEXT        NOT NULL,
  update_type   TEXT        NOT NULL,   -- e.g. 'restock', 'new', 'maintenance', 'fix'
  product_name  TEXT        NOT NULL,
  title         TEXT,
  notes         TEXT,
  status_from   TEXT,
  status_to     TEXT,
  image_url     TEXT,
  posted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS product_updates_guild_time_idx
  ON product_updates (guild_id, posted_at DESC);
