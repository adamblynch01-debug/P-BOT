-- ─── H8ED Shop Database Schema ────────────────────────────
-- Run this in your Supabase SQL Editor

-- Products table
CREATE TABLE IF NOT EXISTS products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  category TEXT DEFAULT 'general',
  stock_type TEXT DEFAULT 'key',     -- key | account | manual
  delivery_type TEXT DEFAULT 'auto', -- auto | manual
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Stock table (keys, accounts, etc.)
CREATE TABLE IF NOT EXISTS stock (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID REFERENCES products(id),
  value TEXT NOT NULL,               -- the key/account string
  used BOOLEAN DEFAULT false,
  order_id UUID,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  used_at TIMESTAMPTZ
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  discord_id TEXT,
  items JSONB NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  fee_note TEXT,
  payment_method TEXT NOT NULL,      -- cashapp | paypal | btc | ltc
  payment_note TEXT,                 -- the random note for email matching
  crypto_address TEXT,
  status TEXT DEFAULT 'pending',     -- pending | paid | delivered | expired
  delivered BOOLEAN DEFAULT false,
  delivered_goods JSONB,
  amount_received DECIMAL(20,8),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

-- Crypto addresses table
CREATE TABLE IF NOT EXISTS crypto_addresses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  address TEXT UNIQUE NOT NULL,
  order_id UUID REFERENCES orders(id),
  coin TEXT NOT NULL,                -- BTC | LTC
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Config table (for bot /config set commands)
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_note ON orders(payment_note);
CREATE INDEX IF NOT EXISTS idx_stock_product_used ON stock(product_id, used);
CREATE INDEX IF NOT EXISTS idx_crypto_address ON crypto_addresses(address);

-- ─── Row Level Security (RLS) ──────────────────────────
-- Enable RLS on all tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE crypto_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE config ENABLE ROW LEVEL SECURITY;

-- Allow backend service key full access (already default)
-- Public can only read active products
CREATE POLICY "Public read active products"
  ON products FOR SELECT
  USING (active = true);

-- Orders: customers can read their own by email (optional)
CREATE POLICY "Service key full access orders"
  ON orders FOR ALL
  USING (true);

CREATE POLICY "Service key full access stock"
  ON stock FOR ALL
  USING (true);

CREATE POLICY "Service key full access config"
  ON config FOR ALL
  USING (true);
