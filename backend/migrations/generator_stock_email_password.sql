-- The shared stock migration originally deployed to some environments before
-- the fourth credential column was added. Keep this migration idempotent so
-- website/admin imports can use the same canonical fields everywhere.
BEGIN;
ALTER TABLE stock ADD COLUMN IF NOT EXISTS email_password TEXT;
COMMIT;
