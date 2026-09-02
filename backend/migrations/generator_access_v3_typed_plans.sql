-- Generator access v3: separate account and phone entitlements.
-- Existing credits/subscriptions remain usable as the historic shared
-- "combined" allowance.  Apply after generator_access_v2.sql.

BEGIN;

ALTER TABLE generator_credits
  ADD COLUMN IF NOT EXISTS credit_type TEXT NOT NULL DEFAULT 'combined';

ALTER TABLE generator_subscriptions
  ADD COLUMN IF NOT EXISTS plan_type TEXT NOT NULL DEFAULT 'combined';

ALTER TABLE generator_credits
  DROP CONSTRAINT IF EXISTS generator_credits_credit_type_check;
ALTER TABLE generator_credits
  ADD CONSTRAINT generator_credits_credit_type_check
  CHECK (credit_type IN ('account', 'phone', 'combined'));

ALTER TABLE generator_subscriptions
  DROP CONSTRAINT IF EXISTS generator_subscriptions_plan_type_check;
ALTER TABLE generator_subscriptions
  ADD CONSTRAINT generator_subscriptions_plan_type_check
  CHECK (plan_type IN ('account', 'phone', 'both', 'combined'));

CREATE INDEX IF NOT EXISTS idx_generator_credits_typed_available
  ON generator_credits(user_id, credit_type, used, created_at);

COMMIT;
