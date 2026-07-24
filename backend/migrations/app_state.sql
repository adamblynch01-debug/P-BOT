-- ─── app_state: generic server-side key/value store ─────────────────
-- Backs the storefront data that previously lived only in localStorage
-- (hide-flags, custom catalog display, tickets, downloads, Vault/Reseller
-- subsystems, per-user carts/history, etc.) so the backend is the source of
-- truth and localStorage is only an offline cache.
--
-- scope    : 'global' (site-wide, admin-authored) or 'user' (per-account)
-- owner_id : web_users.id for scope='user'; '' for scope='global'
-- key      : the original localStorage key name (e.g. 'ghostInventory')
-- value    : arbitrary JSON payload
--
-- Run this in the Supabase SQL editor (Session pooler), then paste the
-- result into Documents/sql results.txt.

CREATE TABLE IF NOT EXISTS app_state (
  guild_id   TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'global',   -- 'global' | 'user'
  owner_id   TEXT NOT NULL DEFAULT '',         -- web_users.id for scope='user'
  key        TEXT NOT NULL,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, scope, owner_id, key)
);

CREATE INDEX IF NOT EXISTS idx_app_state_lookup ON app_state (guild_id, scope, key);
