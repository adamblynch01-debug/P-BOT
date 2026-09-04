-- Multiple IPTV connection methods with per-playlist concurrency limits.
-- Credentials and private playlist URLs are encrypted by the application.
BEGIN;

CREATE TABLE IF NOT EXISTS movie_night_playlists (
  id              BIGSERIAL PRIMARY KEY,
  guild_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  method          TEXT NOT NULL CHECK (method IN ('m3u', 'xtream')),
  playlist_url_enc TEXT,
  host_url_enc    TEXT,
  username_enc    TEXT,
  password_enc    TEXT,
  max_users       INTEGER NOT NULL DEFAULT 1 CHECK (max_users BETWEEN 1 AND 1000),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  live_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  movie_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  series_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_movie_night_playlists_guild
  ON movie_night_playlists (guild_id, enabled, sort_order, id);

CREATE TABLE IF NOT EXISTS movie_night_watch_sessions (
  id              BIGSERIAL PRIMARY KEY,
  playlist_id     BIGINT REFERENCES movie_night_playlists(id) ON DELETE SET NULL,
  user_id         BIGINT REFERENCES web_users(id) ON DELETE SET NULL,
  discord_id      TEXT,
  channel_id      BIGINT,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'expired')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_movie_night_sessions_active
  ON movie_night_watch_sessions (playlist_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_movie_night_sessions_user
  ON movie_night_watch_sessions (user_id, status, last_seen_at DESC);

COMMIT;
