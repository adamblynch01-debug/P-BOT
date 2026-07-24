-- ─── stock_log: audit trail for every stock change ──────────────────
-- The admin panel's "SAVE STOCK" replaces a tier's unused keys wholesale
-- (POST /api/stock/set), so there was no record of WHEN keys were added or
-- how many — you could only ever see the current count. This logs every
-- restock so stock movement is auditable over time.
--
-- delta        : +N added, -N removed (set can do either)
-- count_after  : unused key count for that tier immediately after the write
-- source       : 'main' | 'vault' | 'reseller' — which panel wrote it
-- actor        : web_users.username, or 'bot' for API_SECRET callers
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend, else the
-- stock routes 500 on the missing table.

CREATE TABLE IF NOT EXISTS stock_log (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  tier_id      BIGINT,
  product_name TEXT,
  action       TEXT NOT NULL,          -- 'set' | 'add' | 'clear'
  delta        INT NOT NULL DEFAULT 0,
  count_before INT,
  count_after  INT,
  source       TEXT,                   -- 'main' | 'vault' | 'reseller'
  actor        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_log_recent
  ON stock_log (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_log_tier
  ON stock_log (tier_id, created_at DESC);
