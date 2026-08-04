// One-off: apply migrations/review_avatars.sql and report the resulting shape.
//   railway run node backend/_apply_review_avatars_migration.js
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'review_avatars.sql'), 'utf8');
  await pool.query(sql);
  console.log('migration applied');

  const { rows: cols } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'web_users'  AND column_name IN ('discord_avatar','google_avatar'))
         OR (table_name = 'reviews'    AND column_name = 'avatar_hash')
      ORDER BY table_name, column_name`);
  for (const c of cols) console.log(`  ${c.table_name}.${c.column_name}`);
  if (cols.length !== 3) { console.error(`expected 3 columns, got ${cols.length}`); process.exit(1); }

  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_web_users_guild_discord'`);
  console.log('index:', idx.length ? idx[0].indexname : 'MISSING');
  if (!idx.length) process.exit(1);

  // How much of the storefront's review wall can actually show a face today.
  // Nothing is backfilled: a Discord hash only lands the next time that member
  // signs in with Discord, or the next time they leave a vouch.
  const { rows: n } = await pool.query(
    `SELECT count(*)::int AS reviews,
            count(*) FILTER (WHERE web_user_id IS NOT NULL)::int AS with_account,
            count(*) FILTER (WHERE discord_id IS NOT NULL)::int AS with_discord_id
       FROM reviews WHERE guild_id = $1 AND approved = true`, [process.env.GUILD_ID]);
  const { rows: u } = await pool.query(
    `SELECT count(*)::int AS accounts,
            count(*) FILTER (WHERE avatar_version > 0)::int AS uploaded,
            count(*) FILTER (WHERE discord_id IS NOT NULL)::int AS discord_linked
       FROM web_users WHERE guild_id = $1`, [process.env.GUILD_ID]);
  console.log(`\napproved reviews: ${n[0].reviews}  (site account: ${n[0].with_account}, discord id: ${n[0].with_discord_id})`);
  console.log(`accounts: ${u[0].accounts}  (uploaded a picture: ${u[0].uploaded}, discord linked: ${u[0].discord_linked})`);
  console.log('\nNothing is backfilled by design — a Discord hash arrives on the next');
  console.log('sign-in or the next vouch. Existing reviews keep the emoji/initial until then.');

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
