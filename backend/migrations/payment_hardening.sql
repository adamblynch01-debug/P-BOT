-- Payment-path hardening (Batch 14). Idempotent — safe to re-run.
--
-- Run this in the Supabase SQL editor BEFORE deploying the matching code.
-- Two things here are load-bearing rather than cosmetic:
--   * processed_emails is what stops one payment email from settling an order
--     twice; without it the watcher's replay protection is only advisory.
--   * the partial unique index on transactions is the backstop that turns a
--     double wallet credit into a loud error instead of free money.

-- ─── 1. Email idempotency ────────────────────────────────
-- One row per message the watcher has already acted on. The watcher inserts
-- BEFORE parsing and skips on conflict, so a message is considered exactly
-- once even if IMAP hands it to us repeatedly (reconnect, re-scan, or a human
-- marking it unread).
CREATE TABLE IF NOT EXISTS processed_emails (
  message_id   TEXT PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject      TEXT,
  outcome      TEXT,
  order_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_processed_emails_received
  ON processed_emails(received_at DESC);

-- ─── 2. Operational alerts ───────────────────────────────
-- A durable record of anything a human needs to look at. The Discord ping is
-- best-effort and swallows its own failures, so the row is the real alert and
-- the ping is only the convenience.
CREATE TABLE IF NOT EXISTS ops_alerts (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT,
  kind          TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'warn',
  message       TEXT NOT NULL,
  context       JSONB,
  order_id      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ops_alerts_open
  ON ops_alerts(created_at DESC) WHERE acknowledged_at IS NULL;

-- ─── 3. Wallet double-credit backstop ────────────────────
-- An order may produce at most one credit and one debit. Partial, because
-- admin adjustments legitimately carry no order_id.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_transactions_order_kind
  ON transactions(order_id, kind) WHERE order_id IS NOT NULL;

-- One wallet row per user. balance.js already assumes this; nothing enforced it,
-- so a duplicate row would make `rows[0]` arbitrary and hide money.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_balances_web_user
  ON balances(web_user_id);

-- ─── 4. Non-negative balances ────────────────────────────
-- NOT VALID so an existing negative row does not block the migration; it still
-- applies to every future write. Check for pre-existing violations with:
--   SELECT web_user_id, balance_cents FROM balances WHERE balance_cents < 0;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'balances_non_negative'
  ) THEN
    ALTER TABLE balances
      ADD CONSTRAINT balances_non_negative CHECK (balance_cents >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reseller_balances_non_negative'
  ) THEN
    ALTER TABLE reseller_balances
      ADD CONSTRAINT reseller_balances_non_negative CHECK (balance_cents >= 0) NOT VALID;
  END IF;
END $$;

-- ─── 5. Honest money columns on orders ───────────────────
-- amount_received_cents was storing dollars for cashapp/paypal, satoshis for
-- btc/ltc, and cents from the underpaid path — three units in one column, so
-- any SUM over it was meaningless. It now holds USD cents only, and the raw
-- provider figure lives beside it with its unit named.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_received_native NUMERIC(24,8);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_received_unit TEXT;

-- Idempotency for provider events: at most one order per provider reference.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_txn_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_provider_txn
  ON orders(payment_method, provider_txn_id) WHERE provider_txn_id IS NOT NULL;

-- A note must not be reusable across two open orders, or one payment email
-- could match the wrong one.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_open_note
  ON orders(guild_id, payment_note) WHERE status = 'waiting';

-- ─── 6. Crypto address derivation ────────────────────────
-- The derivation retry loop distinguishes "this index was taken, derive the
-- next one" from a real error by catching 23505 (unique_violation). That only
-- works if the uniqueness it relies on actually exists: without it two
-- concurrent checkouts derive the SAME address for different orders, and the
-- second order's payment is credited to the first.
--
-- The repo's legacy schema declares crypto_addresses with only
-- (id, address, order_id, coin, created_at) — no guild_id, no address_index.
-- Inserting those columns against such a table raises 42703 (undefined_column),
-- which is NOT 23505, so it is rethrown, generateCryptoAddress returns null, and
-- the order is created with no payment address at all.
ALTER TABLE crypto_addresses ADD COLUMN IF NOT EXISTS guild_id TEXT;
ALTER TABLE crypto_addresses ADD COLUMN IF NOT EXISTS address_index INTEGER;

-- One address per derivation index per coin. This is the constraint the retry
-- loop is built around.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crypto_addr_index
  ON crypto_addresses(guild_id, coin, address_index)
  WHERE address_index IS NOT NULL;

-- ─── 7. New order statuses ───────────────────────────────
-- The code now writes two statuses that did not exist before:
--   'needs_attention' — paid but could not be fulfilled (out of stock, unknown
--                       product). Deliberately NOT 'delivered', so the customer
--                       is not emailed a box reading OUT_OF_STOCK as if it were
--                       the product they bought.
--   'expired_paid'    — crypto arrived after the order's 24h window closed. The
--                       money is real but the quote is stale, so it is held for
--                       review instead of auto-delivering at an old price.
--
-- If orders.status carries a CHECK constraint enumerating the old values, both
-- writes will be rejected. The status UPDATEs are wrapped in .catch() so nothing
-- crashes — which means the failure would be SILENT and an order would sit in
-- the wrong state. Run this to find out whether such a constraint exists:
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'orders'::regclass AND contype = 'c';
--
-- If it returns a row mentioning status, extend it to include the two values
-- above (drop and re-add with the full list). If it returns nothing, status is a
-- plain TEXT column and there is nothing to do.
