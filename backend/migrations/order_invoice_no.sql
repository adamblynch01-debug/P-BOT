-- ─── orders.invoice_no: the number a customer reads out ───────────────────
-- Orders were identified to customers by orders.id, a BIGSERIAL. Two problems
-- with printing that on a receipt:
--
--   1. It leaks the shop's volume. "#7" tells a buyer this is the seventh order
--      ever placed, and it tells a competitor the same thing every time anyone
--      screenshots a confirmation.
--   2. It is guessable. /claim-customer in the bot grants the Customer role to
--      whoever supplies an order id plus the matching email; a sequential id is
--      one of the two halves of that pair handed over for free.
--
-- public_ref is NOT the answer. It is a 32-hex capability that authorises the
-- unauthenticated order poll, so printing it would mean printing a credential
-- (and nobody types 32 hex characters into a Discord command anyway).
--
-- So: a separate, short, random, unique reference. Eight characters from a
-- 32-symbol alphabet with 0/O/1/I removed, grouped as XXXX-XXXX so it survives
-- being read aloud or retyped. 32^8 ≈ 1.1e12 — collisions are handled by a
-- unique index and an insert retry rather than by hoping.
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_no TEXT;

-- Backfill row by row. A single UPDATE with a random-producing subquery is not
-- safe here: the planner is free to evaluate an uncorrelated subquery once and
-- reuse the result, which would give every historical order the SAME invoice
-- number and then fail the unique index below.
DO $$
DECLARE
  r        RECORD;
  cand     TEXT;
  attempts INT;
BEGIN
  FOR r IN SELECT id FROM orders WHERE invoice_no IS NULL LOOP
    attempts := 0;
    LOOP
      SELECT string_agg(
               substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
                      1 + floor(random() * 32)::int, 1), '')
        INTO cand
        FROM generate_series(1, 8);
      cand := substr(cand, 1, 4) || '-' || substr(cand, 5, 4);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM orders WHERE invoice_no = cand);
      attempts := attempts + 1;
      IF attempts > 50 THEN
        RAISE EXCEPTION 'could not allocate an invoice number for order %', r.id;
      END IF;
    END LOOP;
    UPDATE orders SET invoice_no = cand WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_invoice_no
  ON orders (invoice_no) WHERE invoice_no IS NOT NULL;

-- ─── order_items.tier_label: which duration each line was bought for ───────
-- order_items exists specifically to hold the per-line breakdown, and it had
-- nowhere to put the term: checkout wrote the collapsed "Ancient (Day)" into
-- product_name and left the duration to be recovered by string surgery. That is
-- why every receipt could only ever list bare product names.
--
-- The INSERT that writes this is deliberately non-fatal (items_snapshot is the
-- source of truth for an order), so a missing column here does not break
-- checkout — it just silently drops the breakdown, which is exactly the kind of
-- failure nobody notices until a customer asks what they bought.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tier_label TEXT;
