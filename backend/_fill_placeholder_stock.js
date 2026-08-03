// ONE-OFF: put 100 placeholder keys on every tier in the catalog.
//
// The operator sells most of these products by hand, so the "key" is not a
// credential at all — it is the string OPEN-TICKET-IN-DISCORD…, which tells the
// buyer to open a ticket. Until every tier carries a supply of it the storefront
// renders SOLD OUT / LOW STOCK on products that are perfectly available, and
// checkout refuses to sell them.
//
// Three things this must NOT do:
//   • touch used = true rows — they are the order history, and deleting one
//     erases what a paying customer was handed.
//   • fire 422 Discord restock announcements. It writes to the database
//     directly rather than through POST /api/stock/set, so the announcement
//     path (utils/restockNotify.js) is never reached.
//   • leave ghostInventory holding a stale copy of every tier. The admin panel
//     now reads its textareas from product_stock, and a browser mirror that
//     still lists the old keys is exactly what used to overwrite live stock on
//     the next save. Entries that match a real tier are pruned; local-only
//     products keep theirs.
//
//   railway run node _fill_placeholder_stock.js            # dry run, changes nothing
//   railway run node _fill_placeholder_stock.js --apply    # do it
'use strict';

const { query, withTransaction } = require('./db');

const GUILD_ID = process.env.GUILD_ID;
const PLACEHOLDER = 'OPEN-TICKET-IN-DISCORD-OPEN-TICKET-IN-DISCORD';
const COPIES = 100;
const APPLY = process.argv.includes('--apply');

(async () => {
  if (!GUILD_ID) throw new Error('GUILD_ID is not set — refusing to run against an unknown guild.');

  const { rows: tiers } = await query(
    `SELECT t.id, t.label, p.name AS product_name, p.game_name,
            (SELECT COUNT(*)::int FROM product_stock ps
              WHERE ps.guild_id = t.guild_id AND ps.tier_id = t.id AND ps.used = false) AS unused,
            (SELECT COUNT(*)::int FROM product_stock ps
              WHERE ps.guild_id = t.guild_id AND ps.tier_id = t.id AND ps.used = true)  AS sold
       FROM product_tiers t
       JOIN products p ON p.id = t.product_id
      WHERE t.guild_id = $1
      ORDER BY p.game_name, p.name, t.sort_order, t.id`,
    [GUILD_ID]
  );

  const unusedNow = tiers.reduce((s, t) => s + t.unused, 0);
  const soldNow = tiers.reduce((s, t) => s + t.sold, 0);

  console.log(`tiers: ${tiers.length}`);
  console.log(`unused rows to be REPLACED: ${unusedNow}`);
  console.log(`sold rows to be PRESERVED:  ${soldNow}`);
  console.log(`rows to be written:         ${tiers.length * COPIES}  (${COPIES} × "${PLACEHOLDER}")`);

  // ── ghostInventory prune plan ────────────────────────────
  // The panel builds its inventory key as `${game_name}||${product_name}||${tier_label}`,
  // straight from these same columns, so the match is exact rather than fuzzy.
  const tierKeys = new Set(tiers.map(t => `${t.game_name}||${t.product_name}||${t.label}`));
  const { rows: stateRows } = await query(
    `SELECT value FROM app_state
      WHERE guild_id = $1 AND scope = 'global' AND owner_id = '' AND key = 'ghostInventory'`,
    [GUILD_ID]
  );
  const inv = (stateRows[0] && typeof stateRows[0].value === 'object' && stateRows[0].value) || {};
  const invKeys = Object.keys(inv);
  const prunable = invKeys.filter(k => tierKeys.has(k));
  const keptInv = {};
  for (const k of invKeys) if (!tierKeys.has(k)) keptInv[k] = inv[k];
  const invBytes = Buffer.byteLength(JSON.stringify(inv), 'utf8');
  const keptBytes = Buffer.byteLength(JSON.stringify(keptInv), 'utf8');
  console.log(`\nghostInventory: ${invKeys.length} key(s), ${(invBytes / 1024).toFixed(1)}KB`);
  console.log(`  ${prunable.length} match a real tier and will be pruned (the server holds those now)`);
  console.log(`  ${invKeys.length - prunable.length} are local-only and stay → ${(keptBytes / 1024).toFixed(1)}KB`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was changed. Re-run with --apply to execute.');
    process.exit(0);
  }

  const values = Array(COPIES).fill(PLACEHOLDER);
  let done = 0;

  await withTransaction(async (exec) => {
    // Set-based: one DELETE and one INSERT for the whole catalogue rather than
    // 422 round-trips, and all of it atomic — a failure halfway cannot leave
    // half the store wiped and the other half stocked.
    await exec(
      `DELETE FROM product_stock ps
        USING product_tiers t
        WHERE ps.guild_id = $1 AND ps.used = false AND t.id = ps.tier_id AND t.guild_id = $1`,
      [GUILD_ID]
    );
    await exec(
      `INSERT INTO product_stock (guild_id, tier_id, value)
       SELECT $1, t.id, $2
         FROM product_tiers t, generate_series(1, $3) AS g
        WHERE t.guild_id = $1`,
      [GUILD_ID, PLACEHOLDER, COPIES]
    );

    // Audit trail, one row per tier, matching what routes/stock.js writes for a
    // 'set'. A catalogue-wide change with no entries in stock_log would read as
    // if the stock had appeared on its own.
    await exec(
      `INSERT INTO stock_log (guild_id, tier_id, product_name, action, delta, count_before, count_after, source, actor)
       SELECT $1, x.tier_id, x.product_name, 'set', $2 - x.before, x.before, $2,
              'bulk placeholder fill', 'script'
         FROM unnest($3::bigint[], $4::text[], $5::int[]) AS x(tier_id, product_name, before)`,
      [
        GUILD_ID, COPIES,
        tiers.map(t => t.id),
        tiers.map(t => (t.label ? `${t.product_name} (${t.label})` : t.product_name)),
        tiers.map(t => t.unused),
      ]
    );

    if (prunable.length) {
      await exec(
        `INSERT INTO app_state (guild_id, scope, owner_id, key, value, updated_at)
         VALUES ($1,'global','','ghostInventory',$2, now())
         ON CONFLICT (guild_id, scope, owner_id, key)
         DO UPDATE SET value = $2, updated_at = now()`,
        [GUILD_ID, JSON.stringify(keptInv)]
      );
    }
    done = tiers.length;
  });

  const { rows: after } = await query(
    `SELECT COUNT(*) FILTER (WHERE used = false)::int AS unused,
            COUNT(*) FILTER (WHERE used = true)::int  AS sold,
            COUNT(DISTINCT tier_id)::int              AS tiers
       FROM product_stock WHERE guild_id = $1`,
    [GUILD_ID]
  );
  console.log(`\nAPPLIED to ${done} tier(s).`);
  console.log('product_stock now:', after[0]);
  if (after[0].sold !== soldNow) {
    console.error(`!! sold rows changed ${soldNow} -> ${after[0].sold} — order history was touched, investigate.`);
    process.exit(1);
  }
  console.log('sold rows preserved ✓');
  process.exit(0);
})().catch(e => { console.error('FILL FAILED:', e.message); process.exit(1); });
