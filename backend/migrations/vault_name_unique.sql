-- Vault and main catalogs are SEPARATE product sets that legitimately reuse
-- names. `products` shipped with UNIQUE (guild_id, game_name, name), so
-- creating the vault's "Services / ACCOUNT RECOVERY" collided with the main
-- store's existing product of the same name and the INSERT was rejected —
-- which is why ⬆ SYNC TO BACKEND reported "Pushed 0, failed 1".
--
-- The `vault` column is the discriminator between the two catalogs, so it
-- belongs in the uniqueness key. Duplicate names WITHIN one catalog are still
-- rejected.

BEGIN;

-- Drop whatever the constraint ended up named (Postgres auto-names differ
-- between a table created by schema_web.sql and one built by a later ALTER).
DO $$
DECLARE
  c TEXT;
BEGIN
  SELECT con.conname INTO c
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'products'
    AND con.contype = 'u'
    AND (
      SELECT array_agg(att.attname::text ORDER BY att.attname)
      FROM unnest(con.conkey) AS k(attnum)
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
    ) = ARRAY['game_name','guild_id','name']
  LIMIT 1;

  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE products
  ADD CONSTRAINT products_guild_game_name_vault_key
  UNIQUE (guild_id, game_name, name, vault);

COMMIT;
