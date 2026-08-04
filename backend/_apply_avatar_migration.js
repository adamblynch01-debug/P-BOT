// One-off: apply migrations/user_avatars.sql and report the resulting shape.
//   railway run node backend/_apply_avatar_migration.js
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'user_avatars.sql'), 'utf8');
  await pool.query(sql);
  console.log('migration applied');

  const col = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'web_users' AND column_name = 'avatar_version'`
  );
  console.log('web_users.avatar_version:', col.rows);

  const tbl = await pool.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_name = 'web_user_avatars' ORDER BY ordinal_position`
  );
  console.log('web_user_avatars:', tbl.rows);

  const n = await pool.query('SELECT count(*)::int AS users, count(*) FILTER (WHERE avatar_version > 0)::int AS with_pic FROM web_users');
  console.log('accounts:', n.rows[0]);

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
