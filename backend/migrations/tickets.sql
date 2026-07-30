-- ─── web_tickets, web_ticket_messages, web_hwid_requests ────────────────────────
-- Support tickets and HWID-reset requests were written to localStorage and
-- mirrored to app_state under the GLOBAL scope with an 'admin' ACL. A customer
-- filing a ticket is not an admin, so the mirroring POST returned 401 and the
-- frontend swallowed it — the ticket existed only in that one browser, the
-- customer saw a green "submitted" confirmation, and no staff member ever saw
-- it. Clearing browser data destroyed the only copy.
--
-- The app_state shape was also wrong even for admins: the whole ticket list was
-- ONE JSON blob, so two staff replying at once silently overwrote each other
-- (last writer wins on the entire array).
--
-- These are per-user records, so they get real tables with real ownership.
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend.

CREATE TABLE IF NOT EXISTS web_tickets (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  web_user_id  BIGINT REFERENCES web_users(id) ON DELETE SET NULL,
  -- Denormalised so a ticket stays answerable after an account is deleted, and
  -- so guest-era tickets keep a reply address.
  name         TEXT,
  email        TEXT,
  category     TEXT,
  priority     TEXT NOT NULL DEFAULT 'normal',
  subject      TEXT,
  status       TEXT NOT NULL DEFAULT 'open',   -- open | pending | closed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_owner  ON web_tickets (web_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_recent ON web_tickets (guild_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS web_ticket_messages (
  id             BIGSERIAL PRIMARY KEY,
  ticket_id      BIGINT NOT NULL REFERENCES web_tickets(id) ON DELETE CASCADE,
  author_user_id BIGINT,
  author_name    TEXT,
  role           TEXT NOT NULL,                -- 'client' | 'staff'
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_thread
  ON web_ticket_messages (ticket_id, created_at ASC);

CREATE TABLE IF NOT EXISTS web_hwid_requests (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  web_user_id  BIGINT REFERENCES web_users(id) ON DELETE SET NULL,
  username     TEXT,
  email        TEXT,
  product      TEXT,
  license_key  TEXT,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
  handled_by   TEXT,
  handled_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hwid_owner  ON web_hwid_requests (web_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hwid_recent ON web_hwid_requests (guild_id, status, created_at DESC);
