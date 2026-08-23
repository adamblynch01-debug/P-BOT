-- Migration: Add Unban Service Addon Product
-- Run this in Railway: railway run psql < backend/migrations/unban_service_addon.sql

-- Insert the product
INSERT INTO products (
  guild_id,
  game_name,
  name,
  subtitle,
  description,
  tag,
  specs,
  platforms,
  spoofer,
  sections,
  media,
  tab,
  dropdown,
  status,
  vault,
  sort_order
) VALUES (
  (SELECT DISTINCT guild_id FROM products LIMIT 1),  -- Use existing guild_id
  'Call of Duty: Warzone',  -- Change if needed
  'Unban Service Addon',
  'Professional Account Unban Service',
  'Get your banned account unbanned. Our team will work to restore your account access. Works with permanent spoofer purchases. Service typically completed within 24-48 hours.',
  'SERVICE',
  '24-48 hour turnaround',
  'PC',
  false,  -- Not a spoofer, it's a service
  '[]'::jsonb,  -- Empty sections
  '{}'::jsonb,  -- Empty media
  null,  -- No tab
  null,  -- No dropdown
  'undetected',
  false,  -- Not vault, regular shop
  (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM products WHERE guild_id = (SELECT DISTINCT guild_id FROM products LIMIT 1))
) RETURNING id AS product_id \gset

-- Insert the pricing tier
INSERT INTO product_tiers (
  product_id,
  guild_id,
  label,
  price_cents,
  period,
  stock_type,
  delivery_type,
  sort_order
) VALUES (
  :product_id,
  (SELECT DISTINCT guild_id FROM products LIMIT 1),
  'Unban Service',
  4999,  -- $49.99 in cents
  null,  -- One-time service, no period
  'manual',  -- Manual delivery
  'manual',
  0
);

-- Verify the product was created
SELECT
  p.id,
  p.name,
  p.game_name,
  p.subtitle,
  t.label AS tier_label,
  t.price_cents / 100.0 AS price_dollars,
  t.stock_type,
  t.delivery_type
FROM products p
LEFT JOIN product_tiers t ON t.product_id = p.id
WHERE p.name = 'Unban Service Addon';
