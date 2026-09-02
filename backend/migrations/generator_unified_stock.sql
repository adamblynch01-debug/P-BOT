-- Use SUPERBOT's existing `stock` table as the one atomic account inventory
-- for Discord and the website.  Both consumers claim by deleting one row with
-- FOR UPDATE SKIP LOCKED, eliminating cross-platform duplicate delivery.

BEGIN;

ALTER TABLE stock ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE stock ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE stock ADD COLUMN IF NOT EXISTS password TEXT;
ALTER TABLE stock ADD COLUMN IF NOT EXISTS email_password TEXT;
ALTER TABLE stock ADD COLUMN IF NOT EXISTS extra TEXT;
ALTER TABLE stock ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'discord';
ALTER TABLE stock ADD COLUMN IF NOT EXISTS website_stock_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_website_stock_id
  ON stock(website_stock_id) WHERE website_stock_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_shared_claim
  ON stock(guild_id, type, id);

-- Bring across only still-available website inventory. The unique legacy id
-- makes this safely rerunnable and keeps claimed generator_stock rows as
-- historical audit records instead of reintroducing them into stock.
INSERT INTO stock (guild_id, type, account_data, email, username, password, email_password, extra, source, website_stock_id)
SELECT (SELECT guild_id FROM guilds ORDER BY guild_id ASC LIMIT 1), gs.type,
       CONCAT(gs.username, ':', gs.password, '|', gs.email,
              CASE WHEN gs.extra IS NULL OR gs.extra = '' THEN '' ELSE CONCAT(':', gs.extra) END),
       gs.email, gs.username, gs.password, NULL, gs.extra, 'website-migrated', gs.id
  FROM generator_stock gs
 WHERE gs.claimed = false
ON CONFLICT (website_stock_id) WHERE website_stock_id IS NOT NULL DO NOTHING;

COMMIT;
