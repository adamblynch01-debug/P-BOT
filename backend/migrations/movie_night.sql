-- Movie Night is deliberately separate from the IPTV bot's local SQLite data.
-- Postgres holds access policy and the durable, staff-visible audit log; Luminary
-- holds the playlist, provider credentials, and the actual stream URLs.

BEGIN;

CREATE TABLE IF NOT EXISTS movie_night_settings (
  singleton        BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled          BOOLEAN NOT NULL DEFAULT false,
  allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by       INTEGER REFERENCES web_users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO movie_night_settings (singleton, enabled, allowed_role_ids)
VALUES (true, false, '[]'::jsonb)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS movie_night_playback_log (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES web_users(id) ON DELETE SET NULL,
  discord_id      TEXT,
  channel_id      INTEGER,
  title           TEXT NOT NULL,
  group_title     TEXT,
  action          TEXT NOT NULL DEFAULT 'play',
  status          TEXT NOT NULL,
  detail          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_movie_night_log_created
  ON movie_night_playback_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_movie_night_log_user_created
  ON movie_night_playback_log (user_id, created_at DESC);

COMMIT;
