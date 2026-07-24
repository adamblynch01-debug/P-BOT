-- ─── Batch 3: reseller wallet + ledger onto the backend ──────────────────
-- The reseller panel's MONEY was the last thing still living only in the
-- browser (resellerBalance inside ghostUsers, plus per-user ghostRsTx_* /
-- ghostRsOrders_* localStorage keys). A reseller could edit their own balance
-- in devtools. This moves the wallet, ledger, and keygen-order history to the
-- backend, keyed to web_users (whose role column already supports 'reseller').
--
-- Kept in app_state KV (already bridged, admin-authored config, not money):
--   ghostResellerRoles (name→discount), ghostResellerInventory (admin stock).
--
-- Run this in Supabase (Session pooler) BEFORE the P-BOT push, else the new
-- /api/reseller routes 500 on the missing tables. No FK constraints on
-- web_user_id (mirrors the cautious pattern used for `balances`, which was
-- created directly in Supabase without a guaranteed unique on web_user_id).

-- Reseller wallet — SEPARATE from the customer `balances` table.
CREATE TABLE IF NOT EXISTS reseller_balances (
  web_user_id  BIGINT PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reseller money ledger (credits/debits). amount_cents is always a positive
-- magnitude; `kind` says whether it added or removed funds.
CREATE TABLE IF NOT EXISTS reseller_transactions (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  web_user_id  BIGINT NOT NULL,
  kind         TEXT NOT NULL,          -- 'credit' | 'debit'
  amount_cents BIGINT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reseller_tx_user
  ON reseller_transactions (web_user_id, created_at DESC);

-- Reseller keygen orders — the audit of keys a reseller generated/purchased.
CREATE TABLE IF NOT EXISTS reseller_orders (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  web_user_id  BIGINT NOT NULL,
  product      TEXT,
  tier         TEXT,
  qty          INT NOT NULL DEFAULT 1,
  unit_cents   BIGINT,
  total_cents  BIGINT,
  keys         JSONB,                  -- the generated keys, as a string[]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reseller_orders_user
  ON reseller_orders (web_user_id, created_at DESC);

-- Reseller role + discount snapshot on the web_users record. The role→discount
-- map itself stays authored in app_state (ghostResellerRoles); we snapshot the
-- assigned role's discount here so purchase pricing can be validated
-- server-side without parsing KV JSON on every call.
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS reseller_role TEXT;
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS reseller_discount INT NOT NULL DEFAULT 0;
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS reseller_suspended BOOLEAN NOT NULL DEFAULT false;
