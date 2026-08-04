// One-off: apply migrations/discord_signup.sql and report the resulting shape.
//   railway run node backend/_apply_discord_signup_migration.js
//
// Run this BEFORE deploying the backend that goes with it. Without it every
// Discord signup faults on web_users.email NOT NULL, and that reaches the
// customer as "Discord login failed" with the real reason only in the logs.
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'discord_signup.sql'), 'utf8');
  await pool.query(sql);
  console.log('migration applied');

  const { rows: cols } = await pool.query(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'web_users' AND column_name IN ('email','password_hash')
      ORDER BY column_name`);
  console.log('\nweb_users:');
  for (const r of cols) {
    console.log(`  ${r.column_name.padEnd(14)} ${r.is_nullable === 'NO' ? 'NOT NULL' : 'NULL ok'}`);
  }

  // The whole point. An account created from a Discord identity has no address
  // and must not be handed a synthesised one.
  const em = cols.find(c => c.column_name === 'email');
  if (!em || em.is_nullable !== 'YES') {
    console.error('\nemail is still NOT NULL — every Discord signup would raise 23502');
    process.exit(1);
  }

  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'orders'
       AND indexname IN ('idx_orders_guild_discord','idx_orders_guild_email_lower')
     ORDER BY indexname`);
  console.log('\nclaim indexes:', idx.map(r => r.indexname).join(', ') || 'MISSING');
  if (idx.length !== 2) process.exit(1);

  // What the item is actually about: paid orders sitting on nobody's account.
  const { rows: [n] } = await pool.query(
    `SELECT count(*)::int AS unowned,
            count(*) FILTER (WHERE email IS NULL AND discord_id IS NOT NULL)::int AS by_discord_only,
            count(*) FILTER (WHERE email IS NULL AND discord_id IS NULL)::int AS unprovable
       FROM orders
      WHERE guild_id = $1 AND web_user_id IS NULL AND status IN ('paid','delivered')`,
    [process.env.GUILD_ID]);
  console.log(`\npaid orders on no account: ${n.unowned}`);
  console.log(`  claimable by Discord for the first time: ${n.by_discord_only}`);
  if (n.unprovable) {
    console.log(`  ⚠ no email AND no discord_id: ${n.unprovable} — nobody can prove these;`);
    console.log(`    staff must attach them by hand.`);
  }

  const { rows: [a] } = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE email IS NULL)::int AS addressless
       FROM web_users WHERE guild_id = $1`, [process.env.GUILD_ID]);
  console.log(`\naccounts: ${a.total}   with no email: ${a.addressless}`);

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
