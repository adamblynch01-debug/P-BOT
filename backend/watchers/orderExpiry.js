// ─── ORDER EXPIRY SWEEPER ─────────────────────────────────────────────────────
// Closes orders that were never paid.
//
// `orders.expires_at` has been written on every order since the beginning and
// nothing has ever read it except the two watchers, which use it to decide what
// they will NOT settle. So an unpaid order crossed its deadline and then simply
// stayed at 'waiting' — permanently unconfirmable by any automatic path, and
// permanently listed by `/manual-order-delivery pending` as though staff could
// still do something about it. The oldest one on this store was thirteen days
// old and still showing.
//
// That is the bug this closes: not "orders live too long", but "an order that
// is already dead does not say so". A pending list that fills with orders
// nobody will ever pay is a list staff stop reading.
//
// WHAT IT WILL NOT TOUCH, and why each one matters:
//   • anything that is not 'waiting' — 'underpaid' means money HAS arrived, and
//     cancelling it would write off a real payment. 'expired_paid' likewise.
//   • anything with a recorded receipt (amount_received_cents / _native), even
//     at status 'waiting'. Belt and braces on the line above: the two are
//     written by different paths and one could set an amount without having
//     moved the status yet.
//   • anything whose deadline has not passed.
// The UPDATE re-states every one of those in its WHERE clause rather than
// trusting the SELECT that found the row — between the two there is a window,
// and a payment landing inside it is exactly the case that must not be lost.
//
// WHY 'expired' AND NOT 'cancelled', when the ask was for orders to cancel
// themselves: 'cancelled' already means something else on this store. It is
// written by the catch in createOrder when a BALANCE checkout fails and its
// debit is rolled back — an order whose goods must never be handed over,
// because the wallet was never charged. An order that simply went unpaid is
// the opposite case: staff SHOULD be able to settle it if the customer turns
// up having paid late, and `/order forceconfirm` accepts 'expired' for exactly
// that reason. One word for both would have made those two indistinguishable
// at the only moment it matters. The customer is told "cancelled" either way.
'use strict';

const cron = require('node-cron');
const { query } = require('../db');
const { raiseAlert } = require('../utils/alerts');

const GUILD_ID = process.env.GUILD_ID;

// Every two minutes. The deadline itself is the promise (see
// expiryMinutesFor in routes/orders.js); this is only how soon after it we
// notice, and it matters more than it looks: the pay screen now counts down to
// that deadline, so the gap between the countdown hitting zero and the status
// changing is a window where the page says one thing and the order says
// another. Two minutes keeps it short. It is one indexed UPDATE that usually
// matches nothing — the same cadence the crypto poller already runs at.
const SCHEDULE = process.env.ORDER_EXPIRY_CRON || '*/2 * * * *';

// How many cancellations in one sweep stop looking like abandoned carts and
// start looking like a broken payment watcher. See the alert below.
const EXPIRY_BATCH_ALERT = Math.max(2, parseInt(process.env.ORDER_EXPIRY_BATCH_ALERT, 10) || 10);

function start() {
  if (!GUILD_ID) {
    console.warn('[OrderExpiry] No GUILD_ID — expiry sweep disabled');
    return;
  }
  cron.schedule(SCHEDULE, sweep);
  console.log(`[OrderExpiry] Started — sweeping unpaid orders on "${SCHEDULE}"`);
  // Once at boot as well. A deploy that lands an hour after the last sweep
  // should not leave a stale order listed until the next tick.
  sweep().catch(() => {});
}

async function sweep() {
  try {
    const { rows } = await query(
      `UPDATE orders
          SET status = 'expired'
        WHERE guild_id = $1
          AND status = 'waiting'
          AND expires_at IS NOT NULL
          AND expires_at < now()
          AND COALESCE(amount_received_cents, 0) = 0
          AND COALESCE(amount_received_native, 0) = 0
        RETURNING id, invoice_no, total_cents, payment_method, created_at, expires_at`,
      [GUILD_ID]
    );
    if (!rows.length) return;

    for (const o of rows) {
      // Says 'expired', not 'cancelled', because that is the status actually
      // written — a log line that spells a status differently from the column
      // is a log line nobody can grep.
      console.log(`[OrderExpiry] Expired ${o.invoice_no || '#' + o.id} — ` +
        `$${((o.total_cents || 0) / 100).toFixed(2)} ${o.payment_method}, ` +
        `unpaid since ${new Date(o.created_at).toISOString()}`);
    }

    // Deliberately no alert for the ordinary case. A customer abandoning a
    // cart is not an incident, and one Discord ping per abandoned cart is how
    // an alert channel gets muted — raiseAlert's own comments record that
    // happening here once already.
    //
    // A BATCH is different. Ten unpaid orders inside five minutes is not ten
    // people changing their minds; it is more likely the email watcher or the
    // crypto poller having stopped settling payments, in which case every one
    // of these was paid and has just been cancelled. That is worth a page.
    if (rows.length >= EXPIRY_BATCH_ALERT) {
      await raiseAlert('orders_expired_batch',
        `${rows.length} unpaid orders passed their deadline in a single sweep and were cancelled ` +
        `(${rows.map(o => o.invoice_no || `#${o.id}`).join(', ')}). ` +
        'Check that the email watcher and crypto poller are still settling payments.',
        { severity: 'error', context: { count: rows.length } }).catch(() => {});
    }
  } catch (err) {
    console.error('[OrderExpiry] Sweep error:', err.message);
  }
}

module.exports = { start, sweep };
