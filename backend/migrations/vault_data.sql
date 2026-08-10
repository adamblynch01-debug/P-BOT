-- ─── Vault data storage for the unified tracker ──────────────────────────────
-- This table stores user vault data (COD accounts, ARC accounts, software keys,
-- PC names, payment accounts, personal keys) for the VAULT PRO / unified tracker
-- interface that was previously using localStorage + Supabase vault_users/vault_data
-- tables. Now integrated with P-BOT's web_users.
--
-- The data column is JSONB containing:
--   {
--     "cod": [{ id, title, email, pass, created, ... }],
--     "arc": [{ id, title, email, pass, created, ... }],
--     "sw": [{ id, name, key, date, ... }],
--     "pk": [{ id, name, username, pass, created, ... }],
--     "personal_keys": [{ id, name, key, date, ... }]
--   }
--
-- Previously this lived in a separate Supabase table called vault_data with id as
-- the PK. Now it's keyed to web_users.id and scoped by guild_id.

CREATE TABLE IF NOT EXISTS vault_data (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, guild_id)
);

-- Index for fast lookup by user
CREATE INDEX IF NOT EXISTS idx_vault_data_user_guild
  ON vault_data(user_id, guild_id);

-- Index for admin queries (all vault data for a guild)
CREATE INDEX IF NOT EXISTS idx_vault_data_guild
  ON vault_data(guild_id, updated_at DESC);

-- The vault data is user-scoped, so RLS would gate on user_id = current_user_id,
-- but this backend uses session tokens + requireAuth middleware instead of
-- Supabase's built-in auth, so RLS is not needed here.

-- Run with:
--   railway run psql < backend/migrations/vault_data.sql
-- OR
--   psql "$DATABASE_URL" -f backend/migrations/vault_data.sql
