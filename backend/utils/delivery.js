const axios = require('axios');
const { query } = require('../db');
const { notifyBot } = require('./botNotify');

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

async function deliver(order) {
  try {
    const items = Array.isArray(order.items_snapshot)
      ? order.items_snapshot
      : JSON.parse(order.items_snapshot || '[]');
    const deliveredGoods = [];

    for (const item of items) {
      if (item.id === 'balance-topup') {
        if (order.web_user_id) {
          await query(
            `UPDATE balances SET balance_cents = balance_cents + $1, updated_at = now() WHERE web_user_id = $2`,
            [Math.round((item.price || 0) * 100), order.web_user_id]
          );
          await query(
            `INSERT INTO transactions (guild_id, web_user_id, kind, amount_cents, description, order_id)
             VALUES ($1,$2,'credit',$3,$4,$5)`,
            [GUILD_ID, order.web_user_id, Math.round((item.price || 0) * 100), `Balance top-up (order #${order.id})`, order.id]
          );
          deliveredGoods.push({ product: 'Balance Top-Up', items: [`+$${(item.price || 0).toFixed(2)} credited`] });
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

    await query(
      `UPDATE orders SET status = 'delivered', delivered_at = now(), delivered_goods = $1 WHERE id = $2`,
      [JSON.stringify(deliveredGoods), order.id]
    );

    await notifyBot('deliver_goods', {
      order_id: order.id,
      email: order.email,
      discord_id: order.discord_id,
      goods: deliveredGoods,
    });

    console.log(`[Delivery] Order ${order.id} delivered`);
  } catch (err) {
    console.error('[Delivery] Error:', err.message);
  }
}

module.exports = { deliver };
