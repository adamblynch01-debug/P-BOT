const axios = require('axios');
const { supabase } = require('../db');
const { notifyBot } = require('./botNotify');

async function deliver(order) {
  try {
    const items = JSON.parse(order.items);
    const deliveredGoods = [];

    for (const item of items) {
      const product_id = item.id;

      // Get product info
      const { data: product } = await supabase
        .from('products')
        .select('*')
        .eq('id', product_id)
        .single();

      if (!product) {
        console.error(`[Delivery] Product ${product_id} not found`);
        continue;
      }

      if (product.delivery_type === 'auto' && product.stock_type !== 'manual') {
        // Claim stock items (one per qty)
        const claimed = [];
        for (let i = 0; i < (item.qty || 1); i++) {
          const res = await axios.post(
            `http://localhost:${process.env.PORT || 3000}/api/stock/claim`,
            {
              secret: process.env.API_SECRET,
              product_id,
              order_id: order.id,
            }
          );
          if (res.data.success) {
            claimed.push(res.data.value);
          } else {
            claimed.push('OUT_OF_STOCK');
          }
        }
        deliveredGoods.push({ product: product.name, items: claimed });
      } else {
        // Manual delivery — just flag it
        deliveredGoods.push({ product: product.name, items: ['MANUAL_DELIVERY_REQUIRED'] });
      }
    }

    // Mark order as delivered
    await supabase.from('orders').update({
      status: 'delivered',
      delivered: true,
      delivered_at: new Date().toISOString(),
      delivered_goods: JSON.stringify(deliveredGoods),
    }).eq('id', order.id);

    // Send goods to Discord bot for DM delivery
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
