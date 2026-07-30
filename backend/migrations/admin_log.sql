-- ─── admin_log: audit trail for privileged account actions ──────────
-- stock_log already covers inventory movement. Nothing recorded who changed a
-- ROLE, banned or deleted an account, reset someone's password, or adjusted a
-- wallet — the only trace of a balance change was a transactions row with a
-- caller-supplied description and no actor. After the fact there was no way to
-- answer "who promoted this account to admin", which is exactly the question a
-- compromised-staff-account incident turns on.
--
-- actor_web_user_id : NULL when the caller authenticated with API_SECRET
-- actor_username    : denormalised so the log survives the account's deletion
-- action            : set_role | ban | unban | delete_user | reset_password
--                     | balance_adjust | reseller_adjust | reseller_role
--                     | reseller_suspend
-- detail            : action-specific payload (new role, amount_cents, reason)
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend. The logging
-- helper swallows its own errors, so a missing table degrades to an unlogged
-- action rather than a failed one — but then the audit trail silently does not
-- exist, which is the thing this file is for. Apply it.

CREATE TABLE IF NOT EXISTS admin_log (
  id                 BIGSERIAL PRIMARY KEY,
  guild_id           TEXT NOT NULL,
  actor_web_user_id  BIGINT,
  actor_username     TEXT NOT NULL,
  action             TEXT NOT NULL,
  target_web_user_id BIGINT,
  detail             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_log_recent
  ON admin_log (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_log_target
  ON admin_log (target_web_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_log_actor
  ON admin_log (actor_web_user_id, created_at DESC);
