-- ═══════════════════════════════════════════════════════════════════════════
-- GENERATOR SYSTEM DATABASE SCHEMA
-- Execute this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- Generator Stock Table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS generator_stock (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  email VARCHAR(255),
  username VARCHAR(255),
  password VARCHAR(255) NOT NULL,
  extra TEXT,
  claimed BOOLEAN DEFAULT false,
  claimed_by INTEGER,
  claimed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_generator_stock_type ON generator_stock(type);
CREATE INDEX idx_generator_stock_claimed ON generator_stock(claimed);

-- ─────────────────────────────────────────────────────────────────────────────
-- Generator Subscriptions Table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS generator_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_generator_subscriptions_user ON generator_subscriptions(user_id);
CREATE INDEX idx_generator_subscriptions_expires ON generator_subscriptions(expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Generator Credits Table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS generator_credits (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  used BOOLEAN DEFAULT false,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_generator_credits_user ON generator_credits(user_id);
CREATE INDEX idx_generator_credits_used ON generator_credits(used);

-- ─────────────────────────────────────────────────────────────────────────────
-- Generator Logs Table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS generator_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  type VARCHAR(50),
  account_email VARCHAR(255),
  status VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_generator_logs_user ON generator_logs(user_id);
CREATE INDEX idx_generator_logs_created ON generator_logs(created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- SMS Orders Table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_orders (
  id SERIAL PRIMARY KEY,
  order_id VARCHAR(255) NOT NULL UNIQUE,
  provider VARCHAR(20) NOT NULL,
  service_name VARCHAR(100),
  country VARCHAR(10),
  number VARCHAR(50),
  code VARCHAR(20),
  user_id INTEGER,
  completed BOOLEAN DEFAULT false,
  cancelled BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sms_orders_order_id ON sms_orders(order_id);
CREATE INDEX idx_sms_orders_user ON sms_orders(user_id);
CREATE INDEX idx_sms_orders_created ON sms_orders(created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sample Stock Data (for testing)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO generator_stock (type, email, username, password, extra, claimed) VALUES
('standard', 'test1@steam.com', 'test1', 'password123', NULL, false),
('standard', 'test2@steam.com', 'test2', 'password456', NULL, false),
('phone-verified', 'verified1@steam.com', 'verified1', 'pass123', 'Phone verified', false),
('activision', 'acti1@email.com', 'acti1', 'cod123', NULL, false),
('email-outlook', 'outlook1@outlook.com', 'outlook1', 'email123', NULL, false),
('5m-bundle', 'fivem1@email.com', 'fivem1', 'bundle123', '5M account bundle', false);

-- ═══════════════════════════════════════════════════════════════════════════
-- END OF SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════
