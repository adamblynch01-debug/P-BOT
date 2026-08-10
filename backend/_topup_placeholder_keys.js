// Top a tier's key pool up to N UNUSED placeholder rows.
//   railway run node _topup_placeholder_keys.js 448,449,450,451          (dry run)
//   railway run node _topup_placeholder_keys.js 448,449,450,451 --apply
//
// Tops UP, never adds blindly: it counts the free rows already there and
// inserts only the difference, so running it twice does not put 200 keys on a
// tier. That matters because the panel's badge is a stock figure the owner
// reads as truth.
//
// The value is the same placeholder every other tier carries —
// OPEN-TICKET-IN-DISCORD — which is the settled convention here: a tier with no
// pool renders SOLD OUT and cannot be bought at all, while a pool of
// placeholders sells and tells the customer where to go. For a
// SUPPLIER-MAPPED tier this pool is never touched while the link is on; it is
// the fallback the toggle falls back TO, which is the whole point of the
// toggle.
'use strict';

const { query, pool } = require('./db');

const PLACEHOLDER = 'OPEN-TICKET-IN-DISCORD-OPEN-TICKET-IN-DISCORD';
const TARGET = 100;
const APPLY = process.argv.includes('--apply');
const ids = String(process.argv[2] || '').split(',').map(s => Number(s.trim())).filter(Boolean);

(async () => {
  if (!process.env.GUILD_ID) { console.error('FAILED: GUILD_ID is not set'); process.exit(1); }
  if (!ids.length) { console.error('FAILED: pass tier ids, e.g. 448,449,450,451'); process.exit(1); }

  const { rows } = await query(
    `SELECT t.id, t.label, p.name AS product,
            COUNT(s.id) FILTER (WHERE s.used = false) AS free
       FROM product_tiers t
       JOIN products p ON p.id = t.product_id
       LEFT JOIN product_stock s ON s.tier_id = t.id
      WHERE t.id = ANY($1::bigint[]) AND p.guild_id = $2
      GROUP BY t.id, t.label, p.name
      ORDER BY t.id`,
    [ids, process.env.GUILD_ID]
  );

  const missing = ids.filter(i => !rows.some(r => Number(r.id) === i));
  if (missing.length) { console.error('FAILED: no such tier in this guild: ' + missing.join(', ')); process.exit(1); }

  let work = 0;
  for (const r of rows) {
    const need = Math.max(0, TARGET - Number(r.free));
    work += need;
    console.log(`  tier ${String(r.id).padStart(4)}  ${String(r.product).padEnd(22)} ${String(r.label).padEnd(10)} free=${String(r.free).padStart(4)}  +${need}`);
  }
  if (!work) { console.log('\nEvery tier already holds ' + TARGET + ' unused keys. Nothing to do.'); await pool.end(); return; }
  if (!APPLY) { console.log(`\nDry run — ${work} row(s) would be inserted. Re-run with --apply.`); await pool.end(); return; }

  let inserted = 0;
  for (const r of rows) {
    const need = Math.max(0, TARGET - Number(r.free));
    if (!need) continue;
    const { rowCount } = await query(
      `INSERT INTO product_stock (guild_id, tier_id, value, used)
       SELECT $1, $2, $3, false FROM generate_series(1, $4)`,
      [process.env.GUILD_ID, r.id, PLACEHOLDER, need]
    );
    inserted += rowCount;
    console.log(`  tier ${r.id}: +${rowCount}`);
  }
  console.log(`\nInserted ${inserted} placeholder key(s).`);
  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
