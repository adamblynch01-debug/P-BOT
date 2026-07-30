-- ─── ops_alerts: record WHO acknowledged an alert ───────────────────
-- ops_alerts was write-only: raiseAlert() inserted rows and nothing ever read
-- them back, so a `delivery_incomplete` alert — a customer who paid and got
-- nothing, with their confirmation email deliberately suppressed — sat in a
-- table no human could reach. routes/alerts.js is the read path; this column
-- is what lets "I've handled this" mean something other than a deleted row.
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend.

ALTER TABLE ops_alerts ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;
