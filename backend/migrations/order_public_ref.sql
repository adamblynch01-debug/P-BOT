-- ─── orders.public_ref: unguessable handle for the anonymous status poll ──
-- GET /api/orders/:id had no auth, no ownership check and no guild filter, and
-- orders.id is a BIGSERIAL — so anyone could walk 1,2,3… and read every
-- order's status, payment method, total and timestamps. That is an enumeration
-- of the entire order book from a browser address bar.
--
-- The route cannot simply be locked behind requireAuth: guest checkout is a
-- real flow, and the payment overlay polls this endpoint every 5 seconds with
-- no session. So the id stops being the credential and this random 32-hex ref
-- takes over: it is returned once, only to whoever created the order, and the
-- poll must present it. A logged-in owner (or an admin) can still read their
-- own order by id without one.
--
-- Backfilled for existing rows so nothing 404s after deploy. Run in Supabase
-- (Session pooler) BEFORE deploying this backend.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS public_ref TEXT;

UPDATE orders
   SET public_ref = encode(gen_random_bytes(16), 'hex')
 WHERE public_ref IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_public_ref
  ON orders (public_ref) WHERE public_ref IS NOT NULL;
