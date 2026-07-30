-- ─── coupons: a discount code that is only live for a time period ─────────
-- There was no discount mechanism at all except reseller_discount, which is a
-- permanent property of an account. This adds a code the customer types at
-- checkout, valid between starts_at and expires_at.
--
-- The window is the whole point of the feature, so BOTH bounds are nullable and
-- both are checked as half-open [starts_at, expires_at): a coupon with no
-- starts_at is live immediately, one with no expires_at never lapses, and
-- "expires at 5pm" means the 5pm second is already too late. Storing
-- TIMESTAMPTZ (not TIMESTAMP) matters — the admin sets the window from a
-- browser in their own zone and the check runs on a UTC server.
--
-- `uses` is a counter on the row rather than a COUNT(*) over redemptions
-- because the max_uses guard has to be atomic: the reservation is a conditional
-- UPDATE (`... AND (max_uses IS NULL OR uses < max_uses) RETURNING *`), which
-- is the same trick the wallet debit in routes/orders.js uses. A COUNT would
-- have to be read first, and two concurrent checkouts would both pass it.
-- coupon_redemptions is therefore the audit trail, not the authority.
--
-- Run in Supabase (Session pooler) BEFORE deploying this backend, else
-- /api/coupons and any checkout carrying a code 500 on the missing table.

CREATE TABLE IF NOT EXISTS coupons (
  id                 BIGSERIAL PRIMARY KEY,
  guild_id           TEXT NOT NULL,
  code               TEXT NOT NULL,          -- stored UPPERCASE; matching is exact
  description        TEXT,
  kind               TEXT NOT NULL DEFAULT 'percent',  -- 'percent' | 'fixed'
  percent_off        INT,                    -- 1..90 when kind = 'percent'
  amount_off_cents   BIGINT,                 -- > 0 when kind = 'fixed'
  starts_at          TIMESTAMPTZ,            -- NULL = live now
  expires_at         TIMESTAMPTZ,            -- NULL = never lapses
  max_uses           INT,                    -- NULL = unlimited
  max_uses_per_user  INT,                    -- NULL = unlimited (requires login when set)
  min_subtotal_cents BIGINT NOT NULL DEFAULT 0,
  uses               INT NOT NULL DEFAULT 0,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One code per guild. Codes are upper-cased before every read and write, so a
-- plain unique index is enough and stays usable as a lookup index — a
-- functional index on upper(code) would not be used by the equality probe
-- unless every call site remembered to write upper(code) too.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_coupons_code
  ON coupons (guild_id, code);

CREATE INDEX IF NOT EXISTS idx_coupons_active
  ON coupons (guild_id, active, expires_at);

-- Shape guards. A percent of 0 is not a discount and a percent of 100 makes an
-- order free, which is indistinguishable from a pricing bug; a fixed amount is
-- clamped to the eligible subtotal in code, so the total can never go negative
-- even if someone writes a $500 coupon.
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_kind_ck;
ALTER TABLE coupons ADD CONSTRAINT coupons_kind_ck
  CHECK (kind IN ('percent', 'fixed'));

ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_value_ck;
ALTER TABLE coupons ADD CONSTRAINT coupons_value_ck CHECK (
  (kind = 'percent' AND percent_off IS NOT NULL AND percent_off BETWEEN 1 AND 90)
  OR
  (kind = 'fixed' AND amount_off_cents IS NOT NULL AND amount_off_cents > 0)
);

ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_window_ck;
ALTER TABLE coupons ADD CONSTRAINT coupons_window_ck
  CHECK (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at);

ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_uses_ck;
ALTER TABLE coupons ADD CONSTRAINT coupons_uses_ck
  CHECK (uses >= 0 AND (max_uses IS NULL OR max_uses > 0));

-- Audit trail: who redeemed what, and how much it actually took off. Kept even
-- if the coupon is later deleted? No — ON DELETE CASCADE, because a deleted
-- coupon's per-user cap has nothing left to enforce and the order row keeps its
-- own coupon_code/coupon_discount_cents snapshot for the receipt.
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id             BIGSERIAL PRIMARY KEY,
  coupon_id      BIGINT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  guild_id       TEXT NOT NULL,
  order_id       BIGINT,
  web_user_id    BIGINT,
  code           TEXT NOT NULL,
  discount_cents BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user
  ON coupon_redemptions (coupon_id, web_user_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_order
  ON coupon_redemptions (order_id);

-- One redemption per order. The reservation happens before the order row
-- exists (the order id is stamped on afterwards), so a retry that re-ran the
-- reservation for an order already discounted would double-count the use.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_coupon_redemption_order
  ON coupon_redemptions (order_id) WHERE order_id IS NOT NULL;

-- The order keeps its own snapshot so a receipt still reads correctly after the
-- coupon is edited or deleted. subtotal_cents stays the GROSS subtotal and
-- total_cents is what was charged; the discount is the difference (plus fee).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_discount_cents BIGINT NOT NULL DEFAULT 0;
