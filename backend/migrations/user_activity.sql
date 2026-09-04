-- Security/operations feed for website visits, successful logins, new users,
-- and notable auth events. It deliberately stores metadata, never credentials.
BEGIN;

CREATE TABLE IF NOT EXISTS user_activity (
  id              BIGSERIAL PRIMARY KEY,
  guild_id        TEXT NOT NULL,
  user_id         BIGINT REFERENCES web_users(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  ip_address      INET,
  user_agent      TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_activity_recent
  ON user_activity (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_activity_user
  ON user_activity (user_id, created_at DESC);

COMMIT;
