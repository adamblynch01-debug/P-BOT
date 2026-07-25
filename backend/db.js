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

// Runs `fn` inside a single BEGIN/COMMIT on one pooled client.
//
// Every money path used to be a run of independent `query()` calls, which meant
// a crash, a thrown error, or a dropped connection partway through left the
// money half-moved: a wallet debited for an order still marked `waiting`, or a
// ledger credit with no matching balance. Railway restarts the container on
// every deploy, so "the process died mid-request" is a routine event, not a
// hypothetical.
//
// `fn` receives an executor with the same `(text, params)` shape as `query`, so
// helpers can take it as an optional argument and work either standalone or
// enlisted in a caller's transaction.
//
// Anything that is not a database write — sending keys, email, Discord
// notifications — must happen AFTER this resolves. Work done inside the
// callback is undone by a rollback; a delivered key is not.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exec = (text, params) => client.query(text, params);
    const result = await fn(exec, client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Rollback is best-effort: if the connection itself is what failed, this
    // throws too, and that error must not mask the real one.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
