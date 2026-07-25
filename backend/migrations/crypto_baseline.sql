-- ─────────────────────────────────────────────────────────
-- Crypto address baselining
--
-- The poller used to confirm an order on the address's ABSOLUTE confirmed
-- balance. That is only correct if every address is freshly derived and used
-- exactly once. It is not: BTC_XPUB/LTC_XPUB point at a wallet that is also
-- used by hand, so a derived address can already hold coins, and the merchant
-- can sweep an address between the payment landing and the next poll.
--
-- Two concrete failures that caused:
--   1. Address already holds funds when the order is created  → the order
--      confirms immediately on the merchant's own money. Free goods.
--   2. Merchant sweeps the address before the 2-minute poll    → balance reads
--      zero and a genuine payment is never detected. Customer paid, no delivery.
--
-- Both are fixed by storing what the address had received at issue time and
-- comparing against confirmed `total_received` (monotonic) rather than
-- `balance`. See receivedSinceBaseline in backend/utils/cryptoUtils.js.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────

BEGIN;

-- Nullable on purpose. NULL means "issued before baselining existed, so funds
-- at this address cannot be attributed to the order" and the watcher refuses to
-- auto-confirm it — that is the fail-closed direction. A DEFAULT 0 would
-- silently re-introduce failure #1 for any pre-existing row.
ALTER TABLE crypto_addresses ADD COLUMN IF NOT EXISTS baseline_received BIGINT;

-- Satoshis/litoshis received; never negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'crypto_addresses'::regclass
      AND conname = 'crypto_addresses_baseline_nonneg'
  ) THEN
    ALTER TABLE crypto_addresses
      ADD CONSTRAINT crypto_addresses_baseline_nonneg
      CHECK (baseline_received IS NULL OR baseline_received >= 0);
  END IF;
END $$;

COMMENT ON COLUMN crypto_addresses.baseline_received IS
  'Confirmed total_received at the moment this address was issued to an order. Payment for the order = current total_received - this. NULL = unattributable, do not auto-confirm.';

COMMIT;
