// One-off: apply migrations/generator_access_v2.sql and verify the widened ids.
// Run from the backend deployment with its DATABASE_URL loaded.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { pool } = require('./db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'generator_access_v2.sql'), 'utf8');
  await pool.query(sql);
  const { rows } = await pool.query(`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_name IN ('generator_stock', 'generator_subscriptions', 'generator_credits', 'generator_logs')
       AND column_name IN ('claimed_by', 'user_id')
     ORDER BY table_name, column_name
  `);
  console.log(JSON.stringify(rows));
  await pool.end();
})().catch(async (err) => {
  console.error('FAILED:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
