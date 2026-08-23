-- Migration: Add Unban Service Addon Product
-- Run this in Railway SQL editor

-- Step 1: Insert the product and get its ID
WITH new_product AS (
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
    (SELECT DISTINCT guild_id FROM products LIMIT 1),
    'Call of Duty: Warzone',
    'Unban Service Addon',
    'Professional Account Unban Service',
    'Get your banned account unbanned. Our team will work to restore your account access. Works with permanent spoofer purchases. Service typically completed within 24-48 hours.',
    'SERVICE',
    '24-48 hour turnaround',
    'PC',
    false,
    '[]'::jsonb,
    '{}'::jsonb,
    null,
    null,
    'undetected',
    false,
    (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM products WHERE guild_id = (SELECT DISTINCT guild_id FROM products LIMIT 1))
  ) RETURNING id
)
-- Step 2: Insert the pricing tier using the product ID from above
INSERT INTO product_tiers (
  product_id,
  guild_id,
  label,
  price_cents,
  period,
  stock_type,
  delivery_type,
  sort_order
)
SELECT
  new_product.id,
  (SELECT DISTINCT guild_id FROM products LIMIT 1),
  'Unban Service',
  4999,
  null,
  'manual',
  'manual',
  0
FROM new_product;

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
