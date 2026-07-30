-- ─── crypto_address_assignments: who an address belonged to, and when ────
-- Crypto addresses are recycled after their order expires (the HD gap limit
-- makes unbounded derivation dangerous). Recycling rebinds the row to the new
-- order and re-baselines it — after which the address's history is gone.
--
-- That loses a real case: customer A's order expires, the address is recycled
-- onto customer B, and THEN A finally broadcasts payment to the address they
-- were originally given. The funds resolve to B's order, and if A's amount
-- covers B's quote, B is delivered for free while A gets nothing. The only
-- trace is a successful-looking confirmation.
--
-- This keeps the assignment history so a payment can be attributed to the
-- window it actually belongs to, and so a settlement on a recently-recycled
-- address can be flagged for a human instead of silently confirmed.
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend.

CREATE TABLE IF NOT EXISTS crypto_address_assignments (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  address     TEXT NOT NULL,
  coin        TEXT,
  order_id    TEXT,
  baseline_received NUMERIC,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_addr_assign_lookup
  ON crypto_address_assignments (guild_id, address, assigned_at DESC);
