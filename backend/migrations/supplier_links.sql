-- ─── Supplier-backed delivery (gandyreseller.uk) ─────────────────────────────
-- Some tiers are not fulfilled from our own key pool at all: they are bought
-- from an upstream reseller at the moment the customer pays, and the key we
-- hand over is the one their API returns.
--
-- Read their contract before changing anything here, because it is unusual:
--
--   GET /api/v1/deliver/{product_id}?key={api_key}
--   "A successful purchase charges your account balance, consumes the matching
--    inventory, and returns delivered values as plain text, one per line."
--
-- THE GET *IS* THE PURCHASE. There is no reserve step, no confirm step, no
-- idempotency key, and no way to ask afterwards what happened. It also means:
--
--   * it can never be health-checked. A "does the link work?" button would buy
--     a key and charge the balance.
--   * it can never be blind-retried. A retry after a timeout buys a SECOND key
--     for one sale and there is no way to give the first one back.
--   * a 200 is not a success. A failure comes back as a 200 whose body starts
--     `ERROR:` — plain text, same as a key would be.
--
-- And there is NO stock, balance, history or HWID endpoint. Only deliver/{id}
-- and discount/{code}. So:
--
--   * supplier_deliveries below is the ONLY record that a charge ever happened.
--     It is not bookkeeping — it is the only way to re-issue a key a customer
--     lost, the only thing to reconcile their invoice against, and the only
--     evidence in a dispute. It is written BEFORE the request goes out, so a
--     process death mid-call still leaves a trace of a possible charge.
--   * a drained balance is undiscoverable until it fails mid-delivery of an
--     order that is already paid for. That is what `enabled` is for: switching
--     a link off drops that tier straight back to our own key pool, which is
--     the only thing that makes a drained balance survivable.
--
-- The API KEY IS NOT IN THIS SCHEMA and must never be. It lives in
-- GANDY_API_KEY on Railway. It is not in `config` (a row there beats the env
-- var at boot, and it is not something you change mid-incident), and it is not
-- in the storefront's index.html, which is public and hand-uploaded — a key
-- there lets anyone on the internet drain the balance.
--
--   psql "$DATABASE_URL" -f backend/migrations/supplier_links.sql

CREATE TABLE IF NOT EXISTS supplier_links (
  id                  BIGSERIAL PRIMARY KEY,
  guild_id            TEXT NOT NULL,
  -- One tier buys from at most one upstream product. UNIQUE, not just indexed:
  -- two links on one tier is a silent double-charge waiting for whichever the
  -- query happened to return first.
  tier_id             BIGINT NOT NULL REFERENCES product_tiers(id) ON DELETE CASCADE,
  -- Only 'gandy' today. Named rather than assumed so a second supplier is a new
  -- value here and a new branch in utils/supplier.js, not a schema change.
  supplier            TEXT NOT NULL DEFAULT 'gandy',
  -- Their {product_id}. TEXT, not INT: it goes straight into a URL path and
  -- there is no promise anywhere that it stays numeric.
  supplier_product_id TEXT NOT NULL,
  -- What their panel calls this item, copied down so the admin list is readable
  -- without opening their site. Purely a label — nothing keys off it.
  label               TEXT,
  -- What THEY charge US, in cents. Not the sale price. It has no effect on
  -- anything; it is here so the links table can be read as a margin sheet and
  -- so an invoice can be reconciled against supplier_deliveries.
  cost_cents          INT,
  -- The kill switch, per link. OFF falls this tier back to the local key pool,
  -- which is a working shop rather than a failed delivery.
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  -- Some upstream products deliver one unit per call, some deliver a bundle.
  -- Multiplied into the qty we ask for; 1 is the safe default.
  qty_per_unit        INT NOT NULL DEFAULT 1,
  -- Last outcome, for the panel's "last result" column. A supplier that has
  -- started refusing is otherwise invisible until a customer reports it.
  last_ok_at          TIMESTAMPTZ,
  last_error          TEXT,
  last_error_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tier_id)
);

CREATE INDEX IF NOT EXISTS supplier_links_guild_idx ON supplier_links (guild_id);

-- Every attempt, successful or not. Rows are INSERTed before the request is
-- made and UPDATEd after, so a row stuck at 'pending' means "we may have been
-- charged and we do not know" — which is exactly the state a human needs to
-- see, and the state a table written only on success would erase.
CREATE TABLE IF NOT EXISTS supplier_deliveries (
  id                  BIGSERIAL PRIMARY KEY,
  guild_id            TEXT NOT NULL,
  -- No FK to orders: this row must outlive anything that could remove the
  -- order, because the charge upstream is not reversible and the record of it
  -- must not be either.
  order_id            TEXT,
  tier_id             BIGINT,
  link_id             BIGINT,
  buyer_ref           TEXT,
  supplier            TEXT NOT NULL DEFAULT 'gandy',
  supplier_product_id TEXT,
  qty                 INT NOT NULL DEFAULT 1,
  --   pending  — sent, no answer yet. May or may not have been charged.
  --   ok       — keys returned and handed to the customer.
  --   error    — their API said ERROR:. Nothing charged, nothing consumed, so
  --              falling back to the local pool is safe.
  --   timeout  — no answer. AMBIGUOUS. Never retried, never fallen back to.
  status              TEXT NOT NULL DEFAULT 'pending',
  -- The keys themselves, one per element. This is the re-issue copy: if the
  -- customer loses the email there is nowhere else to get it from.
  response_lines      JSONB,
  error_text          TEXT,
  cost_cents          INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supplier_deliveries_order_idx ON supplier_deliveries (guild_id, order_id);
CREATE INDEX IF NOT EXISTS supplier_deliveries_created_idx ON supplier_deliveries (guild_id, created_at DESC);
-- The query a human runs during an incident: what is still unaccounted for.
CREATE INDEX IF NOT EXISTS supplier_deliveries_pending_idx
  ON supplier_deliveries (guild_id, status) WHERE status IN ('pending', 'timeout');
