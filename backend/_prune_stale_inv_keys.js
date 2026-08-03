// ONE-OFF: drop ghostInventory keys that name a product by a name it no longer has.
//
// `VERSE — PERM SPOOFER` was renamed to `VERSE — PERMANENT SPOOFER` in an
// earlier round. The rename updated products and product_status; it could not
// update the admin panel's browser mirror, whose keys are literally
// `game||product||tier` strings. So two entries kept pointing at a product name
// that no longer exists, the panel could not resolve them to a tier, and every
// SYNC ALL run ended with "this product exists only locally" for a product that
// is right there in the catalogue with stock on both its tiers.
//
// They are DELETED rather than renamed: product_stock already holds those
// tiers' keys, and the panel now reads its textareas from the server, so a
// renamed mirror would be a second copy of something already authoritative
// elsewhere — which is the whole class of bug this round removed.
//
//   railway run node _prune_stale_inv_keys.js            # dry run
//   railway run node _prune_stale_inv_keys.js --apply
'use strict';

const { query } = require('./db');

const GUILD_ID = process.env.GUILD_ID;
const APPLY = process.argv.includes('--apply');

// game||product||tier → why it is safe to drop.
const STALE = {
  'HWID Spoofer||VERSE — PERM SPOOFER||Lifetime':
    'renamed to "VERSE — PERMANENT SPOOFER"; backend tier #53 holds this stock',
  'HWID Spoofer||VERSE — PERM SPOOFER||One Time':
    'renamed to "VERSE — PERMANENT SPOOFER"; backend tier #52 holds this stock',
};

(async () => {
  if (!GUILD_ID) throw new Error('GUILD_ID is not set.');

  const { rows } = await query(
    `SELECT value FROM app_state
      WHERE guild_id = $1 AND scope = 'global' AND owner_id = '' AND key = 'ghostInventory'`,
    [GUILD_ID]
  );
  const inv = (rows[0] && typeof rows[0].value === 'object' && rows[0].value) || {};

  // Only drop a stale key once its replacement is provably stocked — otherwise
  // this deletes the only record of those keys.
  const { rows: verse } = await query(
    `SELECT t.id, t.label,
            (SELECT COUNT(*)::int FROM product_stock s
              WHERE s.guild_id = $1 AND s.tier_id = t.id AND s.used = false) AS n
       FROM product_tiers t JOIN products p ON p.id = t.product_id
      WHERE t.guild_id = $1 AND p.name = 'VERSE — PERMANENT SPOOFER'`,
    [GUILD_ID]
  );
  console.log('replacement tiers:', verse.map(v => `#${v.id} ${v.label} (${v.n} in stock)`).join(', ') || '(none)');
  if (verse.length < 2 || verse.some(v => v.n === 0)) {
    console.error('!! the renamed product is not fully stocked — refusing to drop the old keys.');
    process.exit(1);
  }

  const present = Object.keys(STALE).filter(k => k in inv);
  const missing = Object.keys(STALE).filter(k => !(k in inv));
  for (const k of present) console.log(`  drop  ${k}  — ${STALE[k]}`);
  for (const k of missing) console.log(`  gone  ${k}  (already absent)`);
  console.log(`\nghostInventory: ${Object.keys(inv).length} key(s) → ${Object.keys(inv).length - present.length}`);

  if (!present.length) { console.log('Nothing to do.'); process.exit(0); }
  if (!APPLY) { console.log('\nDRY RUN — re-run with --apply.'); process.exit(0); }

  const next = {};
  for (const k of Object.keys(inv)) if (!(k in STALE)) next[k] = inv[k];
  await query(
    `INSERT INTO app_state (guild_id, scope, owner_id, key, value, updated_at)
     VALUES ($1,'global','','ghostInventory',$2, now())
     ON CONFLICT (guild_id, scope, owner_id, key)
     DO UPDATE SET value = $2, updated_at = now()`,
    [GUILD_ID, JSON.stringify(next)]
  );
  console.log('APPLIED. Remaining keys:', Object.keys(next));
  process.exit(0);
})().catch(e => { console.error('PRUNE FAILED:', e.message); process.exit(1); });
