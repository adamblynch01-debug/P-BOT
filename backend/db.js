// Postgres connection — points at the SAME database as SUPERBOT (the
// unified schema.sql + schema_web.sql). Replaces @supabase/supabase-js now
// that this backend and SUPERBOT share one Postgres instance.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected Postgres client error:', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
