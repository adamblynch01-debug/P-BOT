const axios = require('axios');
const { supabase } = require('../db');
const { notifyBot } = require('./botNotify');

async function deliver(order) {
  try {
    const items = JSON.parse(order.items);
    const deliveredGoods = [];

    for (const item of items) {
      const { data: product } = await supabase
        .from('products').select('*').eq('id', item.id).single();

      if (!product) {
        console.error(`[Delivery] Product ${item.id} not found`);
        deliveredGoods.push({ product: item.name, items: ['PRODUCT_NOT_FOUND'] });
        continue;
      }

      if (product.delivery_type === 'auto' && product.stock_type !== 'manual') {
        const claimed = [];
        for (let i = 0; i < (item.qty || 1); i++) {
          try {
            const res = await axios.post(
              `http://localhost:${process.env.PORT || 3000}/api/stock/claim`,
              { secret: process.env.API_SECRET, product_id: item.id, order_id: order.id }
            );
            claimed.push(res.data.success ? res.data.value : 'OUT_OF_STOCK');
          } catch {
            claimed.push('OUT_OF_STOCK');
          }
        }
        deliveredGoods.push({ product: product.name, items: claimed });
      } else {
        deliveredGoods.push({ product: product.name, items: ['MANUAL_DELIVERY_REQUIRED'] });
      }
    }

    await supabase.from('orders').update({
      status: 'delivered',
      delivered: true,
      delivered_at: new Date().toISOString(),
      delivered_goods: JSON.stringify(deliveredGoods),
    }).eq('id', order.id);

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
