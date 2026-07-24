-- ─── vault flag on products ─────────────────────────────────────────
-- Batch 2 of the storefront work migrates the "Vault" (accounts/services/
-- streaming/etc.) off its localStorage island and onto the SAME
-- products/product_tiers/product_stock/orders/delivery pipeline the main
-- catalog already uses. A single boolean discriminator keeps vault items in
-- the same tables (so checkout, key-claiming, and delivery are reused
-- verbatim) while letting every read filter them in or out:
--
--   main storefront GET /api/products      → WHERE vault = false
--   vault storefront GET /api/products/vault→ WHERE vault = true
--   main status page GET /api/status       → WHERE vault = false
--   vault status/bot GET /api/status/vault → WHERE vault = true
--
-- Defaults false so every existing product stays on the main storefront and
-- nothing moves until an admin (or the vault seed) explicitly flags it.
--
-- Run this in the Supabase SQL editor (Session pooler) BEFORE deploying the
-- Batch 2 backend, then paste the result into Documents/sql results.txt.

ALTER TABLE products ADD COLUMN IF NOT EXISTS vault BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_vault ON products (guild_id, vault, hidden);
