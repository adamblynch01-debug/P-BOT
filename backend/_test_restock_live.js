// Fire one REAL restock announcement through the production path and print what
// the bot did with it. Reads nothing, writes nothing — it queues an
// announcement for tiers that already exist and lets restockNotify batch, query
// and post it, so it exercises the batching, the embed payload, the internal
// HTTP hop and the channel resolution in one go.
//
// Use it after moving #restocks or changing RESTOCK_CHANNEL_ID: the bot answers
// {posted:true, embeds:N} on success and {posted:false, reason:...} otherwise,
// which is the difference between "it worked" and "it was silently dropped".
//
//   railway run node _test_restock_live.js 439 446 447
'use strict';

// Patch BEFORE restockNotify is loaded — it destructures notifyBot at require
// time, so a later reassignment on the cache would never be seen.
const botNotifyPath = require.resolve('./utils/botNotify');
const real = require('./utils/botNotify').notifyBot;
require.cache[botNotifyPath].exports.notifyBot = async (event, data) => {
  console.log('→ notifyBot', event, '| products:',
    data.products.map(p => `${p.product_name} (+${p.total_added})`).join(', '));
  const r = await real(event, data);
  console.log('← bot replied:', JSON.stringify(r));
  return r;
};

const { queueRestock, __test__ } = require('./utils/restockNotify');

const ids = process.argv.slice(2).filter(a => /^\d+$/.test(a));
if (!ids.length) { console.error('usage: node _test_restock_live.js <tierId> [tierId...]'); process.exit(1); }

console.log('BOT_INTERNAL_URL:', process.env.BOT_INTERNAL_URL || '(unset)');
console.log('queueing tiers  :', ids.join(', '));
for (const id of ids) queueRestock({ tierId: id, added: 100 });

(async () => {
  await __test__.flush();
  console.log('flushed. pending left:', __test__.pending.size);
  process.exit(0);
})();
