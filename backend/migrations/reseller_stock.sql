-- ─── Batch 11: a real key pool for the reseller keygen ──────────────────
-- Until now `resellerGenKeys` minted Math.random() strings in the browser. A
-- reseller paid real wallet money for text that no redemption path anywhere
-- would ever honour, and keygen could never sell out.
--
-- This gives the reseller channel its OWN inventory, deliberately separate
-- from `product_stock`: retail stock and reseller stock are different pools,
-- so a reseller keygen can never drain the keys the storefront is selling.
-- Same shape as product_stock (keyed by tier_id, claim-by-marking-used) so the
-- claim query and the admin restock UI behave identically.
--
-- Run this in Supabase (Session pooler) BEFORE the P-BOT push, else
-- /api/reseller/purchase 500s on the missing table.

CREATE TABLE IF NOT EXISTS reseller_stock (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  tier_id     BIGINT NOT NULL,
  value       TEXT NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  used_at     TIMESTAMPTZ,
  order_id    BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The claim path always filters (guild_id, tier_id, used=false) and takes the
-- lowest id, so index exactly that.
CREATE INDEX IF NOT EXISTS reseller_stock_avail_idx
  ON reseller_stock (guild_id, tier_id, used, id);
