-- ─── orders.source — where an order came from ───────────────────────────────
-- Round 28. Two things needed this and neither could be answered from the row:
--
--   1. The operator wants the order-log embed to say SOURCE: WEBSITE the way
--      the vouch embed already does, so a Discord-side order and a storefront
--      order stop looking identical in #order-log.
--   2. /manual-order-delivery creates orders that were never paid for through
--      the site at all — a key handed over in a ticket, an off-platform payment
--      settled by hand. Those must be tellable from a real checkout by
--      something better than "it has no payment_method", which is also true of
--      a checkout that was abandoned before payment was chosen.
--
-- `reviews.source` already exists and carries exactly this meaning ('website' /
-- 'discord'), so the column name, type and default deliberately match it rather
-- than inventing a second vocabulary for the same idea.
--
-- Backfill: every existing row predates manual delivery and was created by the
-- storefront checkout, so the DEFAULT is correct for all of them and NOT NULL
-- is safe to apply immediately.
--
-- Run this in the Supabase SQL editor (Session pooler) BEFORE deploying the
-- round-28 backend.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'website';

-- Free text rather than an enum: a CHECK constraint here would mean a deploy
-- that introduces a new source (a reseller panel, a Telegram bridge) fails at
-- INSERT time in production rather than at review time. The three values in use
-- today are 'website', 'discord' and 'manual'.
CREATE INDEX IF NOT EXISTS idx_orders_source ON orders (guild_id, source, created_at DESC);
