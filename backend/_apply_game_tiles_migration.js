// One-off: apply migrations/game_tiles.sql and report the resulting shape.
//   railway run node backend/_apply_game_tiles_migration.js
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'game_tiles.sql'), 'utf8');
  await pool.query(sql);
  console.log('migration applied');

  for (const t of ['game_tiles', 'game_tile_images']) {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t]);
    console.log(`\n${t}:`);
    for (const r of rows) console.log(`  ${r.column_name.padEnd(14)} ${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}`);
  }

  // The upsert in routes/gameTiles.js is ON CONFLICT (guild_id, game_name) —
  // without that constraint every PATCH would raise "no unique or exclusion
  // constraint matching the ON CONFLICT specification" rather than upserting.
  const { rows: uq } = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'game_tiles'::regclass AND contype IN ('u', 'p')`);
  console.log('\nconstraints:', uq.map(r => r.def).join(' | '));

  // How many games the storefront actually groups by, so the tile editor's
  // dropdown has something known to compare against.
  const { rows: g } = await pool.query(
    `SELECT count(DISTINCT game_name)::int AS games FROM products WHERE guild_id = $1`,
    [process.env.GUILD_ID]);
  const { rows: t } = await pool.query('SELECT count(*)::int AS tiles FROM game_tiles');
  console.log(`\ngames in catalog: ${g[0].games}   tile override rows: ${t[0].tiles}`);

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
