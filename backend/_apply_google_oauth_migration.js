// One-off: apply migrations/google_oauth.sql and report the resulting shape.
//   railway run node backend/_apply_google_oauth_migration.js
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  // A duplicate google_id would make CREATE UNIQUE INDEX raise with a message
  // that names the index and not the rows, so look first.
  const { rows: dupes } = await pool.query(
    `SELECT google_id, count(*)::int AS n FROM web_users
      WHERE google_id IS NOT NULL GROUP BY google_id HAVING count(*) > 1`
  ).catch(() => ({ rows: [] }));   // column may not exist yet — that is the normal case
  if (dupes.length) {
    console.error('duplicate google_id values already present:', dupes);
    process.exit(1);
  }

  const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'google_oauth.sql'), 'utf8');
  await pool.query(sql);
  console.log('migration applied');

  const { rows: cols } = await pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'web_users' AND column_name IN ('google_id','google_email','password_hash')
      ORDER BY column_name`);
  console.log('\nweb_users:');
  for (const r of cols) {
    console.log(`  ${r.column_name.padEnd(14)} ${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ' NULL ok'}`);
  }

  // password_hash MUST be nullable now: an account created by pressing SIGN UP
  // WITH GOOGLE has no password and must not be given a fake unusable hash.
  const pw = cols.find(c => c.column_name === 'password_hash');
  if (!pw || pw.is_nullable !== 'YES') {
    console.error('\npassword_hash is still NOT NULL — every Google signup would raise 23502');
    process.exit(1);
  }

  const { rows: idx } = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'web_users' AND indexname = 'uniq_web_users_google'`);
  console.log('\nindex:', idx.length ? idx[0].indexdef : 'MISSING');
  if (!idx.length) process.exit(1);

  const { rows: n } = await pool.query(
    `SELECT count(*)::int AS accounts,
            count(*) FILTER (WHERE google_id IS NOT NULL)::int AS with_google,
            count(*) FILTER (WHERE password_hash IS NULL)::int AS passwordless
       FROM web_users WHERE guild_id = $1`, [process.env.GUILD_ID]);
  console.log(`\naccounts: ${n[0].accounts}   linked to Google: ${n[0].with_google}   passwordless: ${n[0].passwordless}`);

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
