const axios = require('axios');
const { query } = require('../db');
const { notifyBot } = require('./botNotify');
const { raiseAlert } = require('./alerts');
const { sendOrderConfirmation } = require('./email');

const GUILD_ID = process.env.GUILD_ID;

// Unlike the old flat `products` table (UUID id, matched 1:1 to checkout's
// item.id), the unified schema's product_tiers uses BIGINT ids and checkout
// still sends synthetic slugs like "GameName-CheatName-Tier" — those will
// never match. Postgres throws on a non-numeric literal compared to BIGINT
// (Supabase's query builder used to just return no rows instead), so this
// lookup must swallow that error itself rather than letting it bubble up to
// deliver()'s outer catch, or a single bad id would abort the whole order
// and it would never reach 'delivered'.
async function lookupTier(tierId) {
  try {
    const { rows } = await query(
      `SELECT t.*, p.name AS product_name
       FROM product_tiers t JOIN products p ON p.id = t.product_id
       WHERE t.id = $1 AND t.guild_id = $2`,
      [tierId, GUILD_ID]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

// Markers pushed into deliveredGoods when there is nothing real to hand over.
// These used to be written straight into the customer's confirmation email as
// though they were the product — the buyer received a box reading
// "OUT_OF_STOCK" and the order was marked 'delivered' like any success.
const FAILURE_MARKERS = new Set([
  'OUT_OF_STOCK', 'PRODUCT_NOT_FOUND', 'MANUAL_DELIVERY_REQUIRED', 'NO_ACCOUNT_LINKED',
]);

function collectFailures(deliveredGoods) {
  const failures = [];
  for (const entry of deliveredGoods) {
    for (const value of entry.items || []) {
      if (FAILURE_MARKERS.has(value)) failures.push({ product: entry.product, marker: value });
    }
  }
  return failures;
}

async function deliver(order) {
  try {
    const items = Array.isArray(order.items_snapshot)
      ? order.items_snapshot
      : JSON.parse(order.items_snapshot || '[]');
    const deliveredGoods = [];

    for (const item of items) {
      if (item.id === 'balance-topup') {
        if (order.web_user_id) {
          const credit = Math.round((item.price || 0) * 100);
          // The ledger row goes FIRST and carries the uniqueness. uniq_
          // transactions_order_kind means a second credit for this order raises
          // 23505 instead of silently topping the wallet up again, so a
          // duplicate delivery can no longer mint money even if it gets this
          // far. The balance UPDATE only runs once the row is ours.
          try {
            await query(
              `INSERT INTO transactions (guild_id, web_user_id, kind, amount_cents, description, order_id)
               VALUES ($1,$2,'credit',$3,$4,$5)`,
              [GUILD_ID, order.web_user_id, credit, `Balance top-up (order #${order.id})`, order.id]
            );
          } catch (err) {
            if (err && err.code === '23505') {
              await raiseAlert('duplicate_topup_credit',
                `Order ${order.id} tried to credit the wallet twice — blocked`,
                { severity: 'error', order_id: order.id, context: { credit_cents: credit } });
              deliveredGoods.push({ product: 'Balance Top-Up', items: ['ALREADY_CREDITED'] });
              continue;
            }
            throw err;
          }

          const { rowCount } = await query(
            `UPDATE balances SET balance_cents = balance_cents + $1, updated_at = now() WHERE web_user_id = $2`,
            [credit, order.web_user_id]
          );
          if (!rowCount) {
            // A ledger row now exists with no matching money. Say so loudly —
            // this silently no-opped before, which is the shape of a balance
            // that disagrees with its own transaction history.
            await raiseAlert('topup_credit_lost',
              `Order ${order.id} logged a $${(credit / 100).toFixed(2)} credit but no balances row was updated`,
              { severity: 'error', order_id: order.id, context: { web_user_id: order.web_user_id, credit_cents: credit } });
            deliveredGoods.push({ product: 'Balance Top-Up', items: ['CREDIT_FAILED'] });
            continue;
          }
          deliveredGoods.push({ product: 'Balance Top-Up', items: [`+$${(credit / 100).toFixed(2)} credited`] });
        } else {
          deliveredGoods.push({ product: 'Balance Top-Up', items: ['NO_ACCOUNT_LINKED'] });
        }
        continue;
      }

      // Donation / custom-amount: a user-set payment with no catalog product
      // behind it (custom orders negotiated with staff, or tips). Record it
      // cleanly and let the bot notify staff for manual fulfillment instead of
      // running it through tier lookup (which would log PRODUCT_NOT_FOUND).
      if (item.id === 'donation' || item.id === 'custom-amount') {
        deliveredGoods.push({
          product: item.name || 'Custom Payment',
          items: [`$${(item.price || 0).toFixed(2)} received — manual fulfillment`],
        });
        continue;
      }

      const tier = await lookupTier(item.id);

      if (!tier) {
        console.error(`[Delivery] Product ${item.id} not found`);
        deliveredGoods.push({ product: item.name, items: ['PRODUCT_NOT_FOUND'] });
        continue;
      }

      if (tier.delivery_type === 'auto' && tier.stock_type !== 'manual') {
        const claimed = [];
        for (let i = 0; i < (item.qty || 1); i++) {
          try {
            const res = await axios.post(
              `http://localhost:${process.env.PORT || 3000}/api/stock/claim`,
              { secret: process.env.API_SECRET, product_id: tier.id, order_id: order.id }
            );
            claimed.push(res.data.success ? res.data.value : 'OUT_OF_STOCK');
          } catch {
            claimed.push('OUT_OF_STOCK');
          }
        }
        deliveredGoods.push({ product: tier.product_name, items: claimed });
      } else {
        deliveredGoods.push({ product: tier.product_name, items: ['MANUAL_DELIVERY_REQUIRED'] });
      }
    }

    // A paid order that could not be fulfilled must not look like a success.
    // It stays out of 'delivered', the customer is not emailed a box reading
    // OUT_OF_STOCK as their product, and someone is told.
    const failures = collectFailures(deliveredGoods);
    const finalStatus = failures.length ? 'needs_attention' : 'delivered';

    // Keys have already been claimed from stock by this point, so losing this
    // write means real inventory was handed out with no record of what or to
    // whom. 'needs_attention' is a status this database has never seen; if a
    // CHECK constraint rejects it the whole order would otherwise fall into the
    // outer catch with delivered_goods never persisted. Retry once with a status
    // that certainly exists, keeping the goods.
    try {
      await query(
        `UPDATE orders SET status = $1, delivered_at = now(), delivered_goods = $2 WHERE id = $3`,
        [finalStatus, JSON.stringify(deliveredGoods), order.id]
      );
    } catch (statusErr) {
      console.error(`[Delivery] Could not set status ${finalStatus}:`, statusErr.message);
      await query(
        `UPDATE orders SET delivered_at = now(), delivered_goods = $1 WHERE id = $2`,
        [JSON.stringify(deliveredGoods), order.id]
      ).catch(() => {});
      await raiseAlert('delivery_status_write_failed',
        `Order ${order.id} was fulfilled but its status could not be set to '${finalStatus}': ${statusErr.message}`,
        { severity: 'error', order_id: order.id, context: { attempted_status: finalStatus } }).catch(() => {});
    }

    await notifyBot('deliver_goods', {
      order_id: order.id,
      email: order.email,
      discord_id: order.discord_id,
      goods: deliveredGoods,
      needs_attention: failures.length > 0,
    });

    if (failures.length) {
      await raiseAlert('delivery_incomplete',
        `Order ${order.id} is PAID but could not be fulfilled: ${failures.map(f => `${f.product}=${f.marker}`).join(', ')}`,
        { severity: 'error', order_id: order.id, context: { failures, email: order.email, discord_id: order.discord_id } });
      console.error(`[Delivery] Order ${order.id} needs attention — customer email suppressed`);
      return;
    }

    // Email confirmation — best-effort, never blocks the delivered state.
    await sendOrderConfirmation(order, deliveredGoods).catch(e =>
      console.error('[Delivery] Email notify failed:', e.message)
    );

    console.log(`[Delivery] Order ${order.id} delivered`);
  } catch (err) {
    // The order is already 'paid' at this point, so a throw here leaves a
    // customer who has paid and received nothing, with no trace. That was
    // console-only.
    console.error('[Delivery] Error:', err.message);
    await raiseAlert('delivery_failed',
      `Order ${order.id} is PAID but delivery threw: ${err.message}`,
      { severity: 'error', order_id: order.id, context: { email: order.email, discord_id: order.discord_id } }
    ).catch(() => {});
  }
}

module.exports = { deliver };
