-- ─── Server-side two-factor authentication ──────────────────────────
-- 2FA was enforced ENTIRELY in the browser. POST /api/auth/login verified the
-- password and immediately returned a 30-day bearer token; the TOTP prompt and
-- the Discord DM were page JavaScript that ran *after* the token was already
-- in hand. So a plain curl with a stolen password skipped both — and in the
-- browser, clearing the localStorage shadow record (`ghostUsers`) removed the
-- `twofa` object and skipped the prompt too. The secret and the backup codes
-- also lived in that same localStorage record, in plaintext.
--
-- This makes the second factor a server state machine:
--   password OK + 2FA required  ->  challenge row, NO token
--   challenge verified          ->  session created, token returned
--
-- totp_secret is the base32 shared secret. Backup codes are stored as sha256
-- hashes, never in the clear, and are single-use.
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend.

ALTER TABLE web_users ADD COLUMN IF NOT EXISTS totp_secret  TEXT;
ALTER TABLE web_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- Single-use hashed backup codes, one row per code.
CREATE TABLE IF NOT EXISTS web_user_backup_codes (
  id           BIGSERIAL PRIMARY KEY,
  web_user_id  BIGINT NOT NULL,
  guild_id     TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backup_codes_user
  ON web_user_backup_codes (web_user_id) WHERE used_at IS NULL;

-- A login that has passed the password check but not yet the second factor.
-- Holds no session token: nothing here grants access on its own.
--
--   kind     : 'totp' | 'discord'
--   ref      : for the Discord path, SUPERBOT's pendingSessions id
--   attempts : bounded so a 6-digit TOTP cannot be brute-forced against one
--              challenge (1,000,000 space, but a challenge lives 10 minutes)
CREATE TABLE IF NOT EXISTS web_login_challenges (
  id           TEXT PRIMARY KEY,
  web_user_id  BIGINT NOT NULL,
  guild_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  ref          TEXT,
  attempts     INT NOT NULL DEFAULT 0,
  consumed_at  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_challenges_open
  ON web_login_challenges (web_user_id, expires_at) WHERE consumed_at IS NULL;
