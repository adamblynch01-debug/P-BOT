-- Web tickets ↔ Discord bridge (2026-07-31)
--
-- A ticket opened on the website was invisible in Discord. routes/tickets.js
-- did call notifyBot('new_ticket', …), but the bot had no /internal/new_ticket
-- route, so every one of those fell through to the catch-all handler and came
-- back {ok:true, handled:false} — a 200, logged once, and nobody pinged. Staff
-- only ever saw a web ticket if they happened to open the admin panel.
--
-- The bridge posts the ticket into the ticket-log channel with Reply/Close
-- buttons, so it can be worked from Discord. That needs somewhere to remember
-- WHERE it was posted, otherwise the customer's later replies have no message
-- to attach to and each one would start a fresh, contextless post.
ALTER TABLE web_tickets ADD COLUMN IF NOT EXISTS discord_channel_id TEXT;
ALTER TABLE web_tickets ADD COLUMN IF NOT EXISTS discord_message_id TEXT;

-- A HWID reset submitted on the site wrote web_hwid_requests and nothing else,
-- so it was not a ticket: it never appeared under "Your Tickets", there was no
-- thread to answer in, and the only way to see one was the admin panel's HWID
-- list. It now opens a real ticket tagged 'HWID Reset' as well, and this is the
-- link between the two rows — the ticket carries the conversation, the request
-- row keeps the license key and the approve/deny state.
ALTER TABLE web_tickets ADD COLUMN IF NOT EXISTS hwid_request_id BIGINT;
CREATE INDEX IF NOT EXISTS web_tickets_hwid_request_idx
  ON web_tickets (hwid_request_id) WHERE hwid_request_id IS NOT NULL;
