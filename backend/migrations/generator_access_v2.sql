-- Generator access v2: €1 shared single-use credits and a 30-use/30-day
-- GEN MEMBER plan. Usage reservations are recorded in generator_logs, so the
-- account field must stay nullable until a provider actually returns stock.

BEGIN;

ALTER TABLE generator_logs ALTER COLUMN account_email DROP NOT NULL;

-- web_users uses BIGINT ids. The original generator tables used INTEGER,
-- which works only until a Discord-linked account id crosses the 32-bit range.
-- Widen the foreign-key-shaped columns before the first paid generation.
ALTER TABLE generator_stock ALTER COLUMN claimed_by TYPE BIGINT USING claimed_by::bigint;
ALTER TABLE generator_subscriptions ALTER COLUMN user_id TYPE BIGINT USING user_id::bigint;
ALTER TABLE generator_credits ALTER COLUMN user_id TYPE BIGINT USING user_id::bigint;
ALTER TABLE generator_logs ALTER COLUMN user_id TYPE BIGINT USING user_id::bigint;

-- Older production copies of sms_orders predate these lifecycle fields even
-- though the current generator routes already use them.
ALTER TABLE sms_orders ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sms_orders ADD COLUMN IF NOT EXISTS cancelled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sms_orders ADD COLUMN IF NOT EXISTS channel_id TEXT;

CREATE INDEX IF NOT EXISTS idx_generator_logs_entitlement_usage
  ON generator_logs(user_id, created_at, status);

CREATE INDEX IF NOT EXISTS idx_generator_subscriptions_active
  ON generator_subscriptions(user_id, active, expires_at);

CREATE INDEX IF NOT EXISTS idx_generator_credits_available
  ON generator_credits(user_id, used, created_at);

COMMIT;
