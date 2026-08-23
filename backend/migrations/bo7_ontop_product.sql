-- Migration: Add CALL OF DUTY BO7: ONTOP PRIVATE EXTERNAL (SLOTTED)
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
    'Call of Duty: Black Ops 7',
    'ONTOP PRIVATE EXTERNAL',
    'SLOTTED - Limited Access',
    'Premium private external cheat for Call of Duty: Black Ops 7. Limited slots available. Monthly subscription includes full ESP, aimbot, and exclusive features.',
    'EXTERNAL',
    'SLOTTED | EXTERNAL | PRIVATE',
    ARRAY['PC'],
    false,
    '[{"title":"ESP","features":["Box ESP","Health ESP","Name ESP","Distance ESP","Weapon ESP"]},{"title":"Aimbot","features":["Smooth Aim","FOV Circle","Target Lock","Visibility Check"]},{"title":"Misc","features":["No Recoil","No Spread","Radar","Crosshair"]}]'::jsonb,
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
  '1 Month',
  4999,
  'month',
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
  p.tag,
  t.label AS tier_label,
  t.price_cents / 100.0 AS price_dollars,
  t.period,
  t.stock_type,
  t.delivery_type
FROM products p
LEFT JOIN product_tiers t ON t.product_id = p.id
WHERE p.name = 'ONTOP PRIVATE EXTERNAL';
