BEGIN;

-- A provider can occasionally return the same number to two near-simultaneous
-- requests. Keep the oldest active reservation and mark later duplicates
-- cancelled before installing the constraint, then let PostgreSQL enforce the
-- invariant for all future requests (including concurrent transactions).
WITH ranked AS (
  SELECT ctid,
         row_number() OVER (PARTITION BY provider, number ORDER BY created_at, order_id) AS rn
    FROM sms_orders
   WHERE number IS NOT NULL AND COALESCE(cancelled, false) = false
)
UPDATE sms_orders s
   SET cancelled = true
 WHERE s.ctid IN (SELECT ctid FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sms_orders_active_number
  ON sms_orders (provider, number)
  WHERE number IS NOT NULL AND cancelled = false;

COMMIT;
