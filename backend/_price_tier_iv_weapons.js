// ONE-OFF: give TIER IV WEAPONS (product #19) a price, and with it real tiers.
//
// Its 9 weapons were dropdown options priced "TBD". A dropdown option is not a
// product_tiers row, so none of them could hold stock, none could be priced by
// the server at checkout, and the admin panel's SYNC ALL had nothing to sync
// them to — which is what "2 tiers that will not sync" was. Tiers were NOT
// created at $0 in the previous round on purpose: a $0 tier is a free checkout.
// The operator has now priced them at $0.99.
//
// Three writes, one transaction:
//   1. one product_tiers row per weapon, 99 cents, in dropdown order
//   2. the dropdown JSON's "TBD" prices → "$0.99", so the storefront and the
//      tier agree on the number the customer is shown
//   3. 100 placeholder keys per new tier, matching every other tier in the
//      catalogue, plus a stock_log row each
//
// It writes to the database rather than through POST /api/stock/set, so the
// #restocks announcement path is never reached — 9 embeds for an
// administrative fill is the flood restockNotify.js exists to prevent.
//
//   railway run node _price_tier_iv_weapons.js            # dry run
//   railway run node _price_tier_iv_weapons.js --apply
'use strict';

const { query, withTransaction } = require('./db');

const GUILD_ID = process.env.GUILD_ID;
const PRODUCT_NAME = 'TIER IV WEAPONS';
const PRICE_CENTS = 99;
const PRICE_LABEL = '$0.99';
const PLACEHOLDER = 'OPEN-TICKET-IN-DISCORD-OPEN-TICKET-IN-DISCORD';
const COPIES = 100;
const APPLY = process.argv.includes('--apply');

(async () => {
  if (!GUILD_ID) throw new Error('GUILD_ID is not set.');

  const { rows: prods } = await query(
    `SELECT id, game_name, name, dropdown FROM products
      WHERE guild_id = $1 AND name = $2`,
    [GUILD_ID, PRODUCT_NAME]
  );
  if (prods.length !== 1) throw new Error(`expected exactly 1 "${PRODUCT_NAME}", found ${prods.length}`);
  const product = prods[0];

  const options = (product.dropdown && product.dropdown.options) || [];
  if (!options.length) throw new Error('the product has no dropdown options to price.');

  const { rows: existing } = await query(
    `SELECT id, label, price_cents FROM product_tiers
      WHERE guild_id = $1 AND product_id = $2 ORDER BY sort_order, id`,
    [GUILD_ID, product.id]
  );
  const haveLabels = new Set(existing.map(t => t.label));
  const toCreate = options.map(o => o.name).filter(n => !haveLabels.has(n));

  console.log(`product #${product.id}  ${product.game_name} / ${product.name}`);
  console.log(`dropdown options: ${options.length}  (${options.map(o => `${o.name} ${o.price}`).join(', ')})`);
  console.log(`existing tiers:   ${existing.length}`);
  console.log(`tiers to create:  ${toCreate.length} @ ${PRICE_LABEL} → ${toCreate.join(', ') || '(none)'}`);
  console.log(`stock to write:   ${toCreate.length * COPIES} rows (${COPIES} x placeholder per new tier)`);
  console.log(`dropdown prices:  ${options.filter(o => o.price !== PRICE_LABEL).length} option(s) change to ${PRICE_LABEL}`);

  if (!APPLY) { console.log('\nDRY RUN — nothing changed. Re-run with --apply.'); process.exit(0); }
  if (!toCreate.length && options.every(o => o.price === PRICE_LABEL)) {
    console.log('Nothing to do.'); process.exit(0);
  }

  const created = [];
  await withTransaction(async (exec) => {
    for (let i = 0; i < options.length; i++) {
      const label = options[i].name;
      if (haveLabels.has(label)) continue;
      const { rows } = await exec(
        `INSERT INTO product_tiers (product_id, guild_id, label, price_cents, period, stock_type, delivery_type, sort_order)
         VALUES ($1,$2,$3,$4,NULL,'auto','auto',$5) RETURNING id, label`,
        [product.id, GUILD_ID, label, PRICE_CENTS, i + 1]
      );
      created.push(rows[0]);
    }

    // The dropdown is what the storefront renders. Leaving it on "TBD" while
    // the tier says 99 cents is the two-sources-of-truth split that this whole
    // round has been unwinding.
    const nextDropdown = Object.assign({}, product.dropdown, {
      options: options.map(o => ({ ...o, price: PRICE_LABEL })),
    });
    await exec(
      `UPDATE products SET dropdown = $3, updated_at = now()
        WHERE guild_id = $1 AND id = $2`,
      [GUILD_ID, product.id, JSON.stringify(nextDropdown)]
    );

    if (created.length) {
      const ids = created.map(t => t.id);
      await exec(
        `INSERT INTO product_stock (guild_id, tier_id, value)
         SELECT $1, t.id, $2 FROM unnest($3::bigint[]) AS t(id), generate_series(1, $4) AS g`,
        [GUILD_ID, PLACEHOLDER, ids, COPIES]
      );
      await exec(
        `INSERT INTO stock_log (guild_id, tier_id, product_name, action, delta, count_before, count_after, source, actor)
         SELECT $1, x.tier_id, x.product_name, 'set', $2, 0, $2, 'tier iv weapons pricing', 'script'
           FROM unnest($3::bigint[], $4::text[]) AS x(tier_id, product_name)`,
        [GUILD_ID, COPIES, ids, created.map(t => `${PRODUCT_NAME} (${t.label})`)]
      );
    }
  });

  const { rows: after } = await query(
    `SELECT t.id, t.label, t.price_cents, t.sort_order,
            (SELECT COUNT(*)::int FROM product_stock s
              WHERE s.guild_id = $1 AND s.tier_id = t.id AND s.used = false) AS n
       FROM product_tiers t WHERE t.guild_id = $1 AND t.product_id = $2
      ORDER BY t.sort_order, t.id`,
    [GUILD_ID, product.id]
  );
  console.log(`\nAPPLIED. ${created.length} tier(s) created.`);
  for (const t of after) console.log(`  #${t.id}  ${t.label}  ${(t.price_cents / 100).toFixed(2)}  ${t.n} in stock`);
  if (after.some(t => t.n !== COPIES) || after.length !== options.length) {
    console.error('!! tier count or stock does not match the dropdown — investigate.');
    process.exit(1);
  }
  console.log('every weapon is priced and stocked ✓');
  process.exit(0);
})().catch(e => { console.error('PRICING FAILED:', e.message); process.exit(1); });
