// One-off: close every order still sitting at 'waiting'.
//   railway run node _close_waiting_orders.js          (dry run — shows, changes nothing)
//   railway run node _close_waiting_orders.js --apply  (writes)
//
// Run AFTER deploying watchers/orderExpiry.js, or the backlog it clears comes
// straight back from the next unpaid checkout.
//
// These are the orders that accumulated while `expires_at` was written and
// never read: three of them at the time of writing, the oldest from July 23 and
// all long past even the old 24-hour deadline. Neither payment watcher will
// ever settle them (both filter on `expires_at > now()`), so they are dead — but
// they still list in `/manual-order-delivery pending` as though staff could do
// something about them.
//
// Same guards as the sweeper, and for the same reason: an order that has seen
// money is not swept, whatever its status says. Anything still inside its
// deadline is reported and skipped rather than closed early — closing an order
// a customer is at that moment paying for is the one outcome worth being
// careful about.
'use strict';

const { query, pool } = require('./db');
const { moneyCents } = require('./utils/money');

const GUILD_ID = process.env.GUILD_ID;
const APPLY = process.argv.includes('--apply');

const money = moneyCents;
const when = d => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '—');

(async () => {
  if (!GUILD_ID) { console.error('FAILED: GUILD_ID is not set'); process.exit(1); }

  const { rows: all } = await query(
    `SELECT id, invoice_no, status, payment_method, total_cents, created_at, expires_at,
            amount_received_cents, amount_received_native, email, discord_id
       FROM orders
      WHERE guild_id = $1 AND status = 'waiting'
      ORDER BY created_at`,
    [GUILD_ID]
  );

  if (!all.length) { console.log('Nothing is at status waiting. Nothing to do.'); await pool.end(); return; }

  const paid = all.filter(o => (Number(o.amount_received_cents) || 0) !== 0
                            || (Number(o.amount_received_native) || 0) !== 0);
  const live = all.filter(o => !paid.includes(o) && o.expires_at && new Date(o.expires_at) > new Date());
  const dead = all.filter(o => !paid.includes(o) && !live.includes(o));

  console.log(`${all.length} order(s) at 'waiting':\n`);
  const show = (label, list) => {
    if (!list.length) return;
    console.log(`  ${label}`);
    for (const o of list) {
      console.log(`    ${(o.invoice_no || '#' + o.id).padEnd(12)} ${money(o.total_cents).padStart(8)}` +
        ` ${String(o.payment_method || '').padEnd(8)} placed ${when(o.created_at)}  deadline ${when(o.expires_at)}` +
        `  ${o.discord_id ? 'dc:' + o.discord_id : (o.email || 'no contact')}`);
    }
    console.log('');
  };
  show('WILL BE CLOSED — past deadline, no money received:', dead);
  show('LEFT ALONE — money received, needs a human:', paid);
  show('LEFT ALONE — still inside its deadline:', live);

  if (!dead.length) { console.log('Nothing to close.'); await pool.end(); return; }
  if (!APPLY) {
    console.log(`Dry run. Re-run with --apply to close the ${dead.length} above.`);
    await pool.end();
    return;
  }

  // Re-checked in the WHERE clause rather than closing by id alone: this script
  // is slow enough to read that a payment could land between the SELECT above
  // and the UPDATE below, and that payment must win.
  const { rows: closed } = await query(
    `UPDATE orders
        SET status = 'expired'
      WHERE guild_id = $1
        AND id = ANY($2::bigint[])
        AND status = 'waiting'
        AND expires_at < now()
        AND COALESCE(amount_received_cents, 0) = 0
        AND COALESCE(amount_received_native, 0) = 0
      RETURNING id, invoice_no`,
    [GUILD_ID, dead.map(o => o.id)]
  );

  console.log(`Closed ${closed.length}: ${closed.map(o => o.invoice_no || '#' + o.id).join(', ')}`);
  if (closed.length !== dead.length) {
    console.log(`(${dead.length - closed.length} changed underneath this script and were left alone — re-run to see them.)`);
  }
  console.log("\nStatus is 'expired', not 'cancelled': /order forceconfirm still accepts these,");
  console.log('so a customer who turns up having paid late can still be settled by staff.');

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
