// ONE-OFF: announce the placeholder fill that #restocks never saw.
//
// The 100-key placeholder was written straight to the database by
// _fill_placeholder_stock.js and _price_tier_iv_weapons.js, deliberately
// bypassing POST /api/stock/set — 164 embeds landing at once was the flood
// restockNotify.js exists to prevent. The operator now wants them announced
// after all, one embed per product, so this replays them through the real
// announcer at a pace Discord will accept.
//
// It reads stock, it does not write it: `added` is each tier's CURRENT unused
// count, so a tier that has since sold keys announces what is actually on the
// shelf rather than the 100 that were poured in.
//
// Batched in fours because the bot renders <= MAX_INDIVIDUAL_EMBEDS (4)
// products as individual embeds and collapses anything larger into one summary
// line. Four per call is the largest batch that still gives every product its
// own embed. Vault products are routed by the bot to the vault restock channel
// on the `vault` flag restockNotify now sends.
//
//   railway run node _announce_placeholder_restocks.js              # dry run
//   railway run node _announce_placeholder_restocks.js --apply
//   railway run node _announce_placeholder_restocks.js --apply --store-only
'use strict';

const { query } = require('./db');

// flush() catches and swallows its own failures — an announcement that does not
// post must never break the write it is reporting on. That contract is right
// for production and useless for a script whose whole job is to report what
// posted, so intercept the reply on the way through. Patch BEFORE restockNotify
// is required: it destructures notifyBot at load time, so a later reassignment
// on the cache would never be seen.
const botNotifyPath = require.resolve('./utils/botNotify');
const realNotify = require('./utils/botNotify').notifyBot;
let lastReply = null;
require.cache[botNotifyPath].exports.notifyBot = async (event, data) => {
  lastReply = null;
  try {
    lastReply = await realNotify(event, data);
  } catch (e) {
    lastReply = { error: e.message };
    throw e;
  }
  return lastReply;
};

const { queueRestock, __test__ } = require('./utils/restockNotify');

const GUILD_ID = process.env.GUILD_ID;
const APPLY = process.argv.includes('--apply');
const STORE_ONLY = process.argv.includes('--store-only');
const VAULT_ONLY = process.argv.includes('--vault-only');
const CHUNK = 4;               // == the bot's MAX_INDIVIDUAL_EMBEDS
const PAUSE_MS = 3000;         // Discord tolerates ~5 messages / 5s per channel

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!GUILD_ID) throw new Error('GUILD_ID is not set.');

  const { rows } = await query(
    `SELECT p.id AS product_id, p.name AS product_name, p.game_name, p.vault, p.hidden,
            t.id AS tier_id, t.label,
            (SELECT COUNT(*)::int FROM product_stock ps
              WHERE ps.guild_id = t.guild_id AND ps.tier_id = t.id AND ps.used = false) AS available
       FROM product_tiers t
       JOIN products p ON p.id = t.product_id
      WHERE t.guild_id = $1
      ORDER BY p.vault, p.game_name, p.name, t.sort_order, t.id`,
    [GUILD_ID]
  );

  // Group into the unit the announcement is about. A product with no stock on
  // any tier is skipped rather than announced as a restock of nothing.
  const byProduct = new Map();
  for (const r of rows) {
    const k = String(r.product_id);
    if (!byProduct.has(k)) {
      byProduct.set(k, {
        id: k, name: `${r.game_name} — ${r.product_name}`,
        vault: !!r.vault, hidden: !!r.hidden, tiers: [], total: 0,
      });
    }
    const p = byProduct.get(k);
    if (r.available > 0) { p.tiers.push({ id: r.tier_id, label: r.label, n: r.available }); p.total += r.available; }
  }

  let products = [...byProduct.values()].filter(p => p.total > 0);
  const skippedHidden = products.filter(p => p.hidden).length;
  products = products.filter(p => !p.hidden);          // flush() drops these anyway
  if (STORE_ONLY) products = products.filter(p => !p.vault);
  if (VAULT_ONLY) products = products.filter(p => p.vault);

  const store = products.filter(p => !p.vault);
  const vault = products.filter(p => p.vault);
  const chunks = [];
  for (let i = 0; i < products.length; i += CHUNK) chunks.push(products.slice(i, i + CHUNK));

  console.log(`products to announce : ${products.length}  (${store.length} storefront, ${vault.length} vault)`);
  console.log(`tiers                : ${products.reduce((s, p) => s + p.tiers.length, 0)}`);
  console.log(`keys reported        : ${products.reduce((s, p) => s + p.total, 0)}`);
  console.log(`hidden, skipped      : ${skippedHidden}`);
  console.log(`batches of ${CHUNK}         : ${chunks.length}  → ~${Math.round(chunks.length * PAUSE_MS / 1000)}s of pacing`);
  console.log(`storefront → RESTOCK_CHANNEL_ID       ${process.env.RESTOCK_CHANNEL_ID || '(unset, bot falls back)'}`);
  console.log(`vault      → VAULT_RESTOCK_CHANNEL_ID ${process.env.VAULT_RESTOCK_CHANNEL_ID || '(unset, bot falls back)'}`);

  if (!APPLY) {
    console.log('\nfirst 10 products:');
    for (const p of products.slice(0, 10)) {
      console.log(`  ${p.vault ? 'VAULT' : 'STORE'}  ${p.name}  (+${p.total} over ${p.tiers.length} tier(s))`);
    }
    console.log('\nDRY RUN — nothing posted. Re-run with --apply.');
    process.exit(0);
  }
  if (!products.length) { console.log('Nothing to announce.'); process.exit(0); }

  let ok = 0, failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i];
    for (const p of batch) for (const t of p.tiers) queueRestock({ tierId: t.id, added: t.n });
    // Flush by hand instead of waiting out the 6s debounce window: the batch is
    // already exactly the size we want, and letting the timer coalesce the next
    // loop's queue into this one would produce the summary embed we are
    // deliberately avoiding.
    lastReply = null;
    await __test__.flush();
    const tag = `[${String(i + 1).padStart(2)}/${chunks.length}]`;
    const names = batch.map(p => p.name).join(' | ');
    // "posted" only if the BOT said so. flush() resolving proves the request
    // was made, not that a message exists.
    const posted = !!(lastReply && lastReply.posted);
    if (posted) {
      ok += batch.length;
      const bits = [];
      if (lastReply.store) bits.push(`store ${lastReply.store.embeds || 0}`);
      if (lastReply.vault) bits.push(`vault ${lastReply.vault.embeds || 0}`);
      // Older bot builds answer {posted, embeds} with no per-catalogue split.
      if (!bits.length && lastReply.embeds != null) bits.push(`${lastReply.embeds} embed(s)`);
      console.log(`${tag} ✓ ${bits.join(', ')}  ${names}`);
    } else {
      failed += batch.length;
      console.error(`${tag} ✗ ${JSON.stringify(lastReply)}  ${names}`);
    }
    if (i < chunks.length - 1) await sleep(PAUSE_MS);
  }

  console.log(`\nDONE. ${ok} product(s) announced, ${failed} failed, ${__test__.pending.size} left pending.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ANNOUNCE FAILED:', e.message); process.exit(1); });
