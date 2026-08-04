-- ─── Editable game tiles ─────────────────────────────────────────────────────
-- There has never been a `games` table. A "game" in this product is three
-- unrelated things that happen to share a string:
--   * products.game_name          — the grouping key the catalog is built on
--   * a hand-written .game-banner  in the storefront's index.html
--   * an entry in the STEAM_APP_IDS map in that same file, for the artwork
-- which is why ADMIN → INVENTORY → GAME TILES → ✏ Edit could only ever open the
-- ADD PRODUCT form: there was nothing else for it to open. A tile had no row.
--
-- This table is that row. It holds ONLY the overrides — a game with no row here
-- renders exactly as the static file already renders it, so this is additive
-- and nothing has to be backfilled.
--
-- game_name is the KEY and is deliberately not editable. display_name is what
-- the storefront paints. Splitting them is the whole point: products.game_name,
-- ghostGameHidden, the modal's openModal() argument and the reseller pricing
-- table all look games up by that string, and this codebase has already been
-- bitten twice by a rename that moved a display string out from under a lookup
-- key (product_status is keyed by name, not id). An admin who wants a tile to
-- read "Call of Duty: BO7" gets exactly that, and nothing downstream notices.
--
-- The artwork follows the same split as user avatars, for the same reason: the
-- bytes go in a side table and the row carries only an int. GET /api/game-tiles
-- is public and returns EVERY tile on every storefront load — a BYTEA here
-- would put ~35 banners through that response.
--
--   psql "$DATABASE_URL" -f backend/migrations/game_tiles.sql

CREATE TABLE IF NOT EXISTS game_tiles (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  game_name     TEXT NOT NULL,
  display_name  TEXT,
  subtitle      TEXT,
  -- An explicit URL beats the Steam id, which beats the static file's own <img>.
  image_url     TEXT,
  steam_app_id  INT,
  -- 0 = no uploaded banner. >0 = there is one, and it is the ?v= cache buster.
  -- <0 = there was one and it was deleted; magnitude kept as the high-water
  -- mark so a re-upload can never reissue a ?v= a browser has already pinned.
  -- Same scheme as web_users.avatar_version — see migrations/user_avatars.sql.
  image_version INT NOT NULL DEFAULT 0,
  badge         TEXT,                       -- 'hot' | 'new' | NULL
  hidden        BOOLEAN NOT NULL DEFAULT false,
  -- NULL means "sort alphabetically like everything else". A number pins the
  -- tile ahead of the alphabetical block, low first.
  sort_order    INT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, game_name)
);

CREATE TABLE IF NOT EXISTS game_tile_images (
  game_tile_id BIGINT PRIMARY KEY REFERENCES game_tiles(id) ON DELETE CASCADE,
  data         BYTEA       NOT NULL,
  mime         TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
