const { query, withTransaction } = require('../db');
const { notifyBot } = require('./botNotify');
const { raiseAlert } = require('./alerts');
const { sendOrderConfirmation } = require('./email');
const supplier = require('./supplier');

const GUILD_ID = process.env.GUILD_ID;

// Unlike the old flat `products` table (UUID id, matched 1:1 to checkout's
// item.id), the unified schema's product_tiers uses BIGINT ids and checkout
// still sends synthetic slugs like "GameName-CheatName-Tier" — those will
// never match. Postgres throws on a non-numeric literal compared to BIGINT
// (Supabase's query builder used to just return no rows instead), so this
// lookup must swallow that error itself rather than letting it bubble up to
// deliver()'s outer catch, or a single bad id would abort the whole order
// and it would never reach 'delivered'.
// game_name is joined in for the delivery DM, which used to read
// "PRODUCT — DURATION" with no indication of which game it was for. A buyer
// with three orders open could not tell them apart, and neither could staff
// reading the same line in the audit copy.
//
// COALESCE onto game_tiles.display_name, not products.game_name alone: round 28
// split the tile's LOOKUP KEY from what it PAINTS, and the customer picked the
// product off a tile showing display_name. Naming it anything else in the DM
// hands them a game they never saw. LEFT JOIN — most games have no tile row at
// all, and that is the normal case, not a missing one.
async function lookupTier(tierId) {
  try {
    const { rows } = await query(
      `SELECT t.*, p.name AS product_name,
              COALESCE(NULLIF(gt.display_name, ''), p.game_name) AS game_name
       FROM product_tiers t
       JOIN products p ON p.id = t.product_id
       LEFT JOIN game_tiles gt
              ON gt.game_name = p.game_name AND gt.guild_id = t.guild_id
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
  // Distinct from OUT_OF_STOCK on purpose: the claim itself errored, so the
  // key may well exist. Restocking is the wrong response — this needs a look.
  'CLAIM_ERROR',
  // The supplier did not answer. Registering it here is the whole integration
  // with the existing machinery: it suppresses the customer's confirmation
  // email, keeps the order out of 'delivered', and raises the alert — no new
  // code path. SUPPLIER_ERROR is deliberately NOT here: a refusal falls back to
  // local stock, so it never reaches deliveredGoods as a marker at all.
  'SUPPLIER_TIMEOUT',
]);

// What a receipt needs beyond "here is a box of keys": which subscription term
// was bought, how many, and at what unit price. delivered_goods is the only
// per-line record the confirmation email, the buyer's DM and the site's order
// screen all read, and it carried none of that — so a five-line order showed
// five product names and nothing else. items_snapshot has the numbers; this
// copies them onto the line they belong to.
function lineDetail(item) {
  return {
    tier_label: (item && item.tier_label) || null,
    qty: (item && item.qty) || 1,
    unit_price: item && Number.isFinite(Number(item.price)) ? Number(item.price) : null,
  };
}

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
          // Both statements are one transaction. Separately, a failure after
          // the INSERT left a credit row with no money behind it — a wallet
          // that disagrees with its own history, which is exactly what
          // balance_audit.sql #5 flags. Now the ledger row only survives if the
          // money actually moved.
          try {
            await withTransaction(async (exec) => {
              await exec(
                `INSERT INTO transactions (guild_id, web_user_id, kind, amount_cents, description, order_id)
                 VALUES ($1,$2,'credit',$3,$4,$5)`,
                [GUILD_ID, order.web_user_id, credit, `Balance top-up (order #${order.id})`, order.id]
              );
              const { rowCount } = await exec(
                `UPDATE balances SET balance_cents = balance_cents + $1, updated_at = now() WHERE web_user_id = $2`,
                [credit, order.web_user_id]
              );
              if (!rowCount) {
                const err = new Error('no balances row to credit');
                err.noWallet = true;
                throw err; // rolls the credit row back rather than orphaning it
              }
            });
          } catch (err) {
            if (err && err.code === '23505') {
              await raiseAlert('duplicate_topup_credit',
                `Order ${order.id} tried to credit the wallet twice — blocked`,
                { severity: 'error', order_id: order.id, context: { credit_cents: credit } });
              deliveredGoods.push({ product: 'Balance Top-Up', items: ['ALREADY_CREDITED'], ...lineDetail(item) });
              continue;
            }
            if (err && err.noWallet) {
              await raiseAlert('topup_credit_lost',
                `Order ${order.id} could not be credited $${(credit / 100).toFixed(2)} — no balances row for that user; the credit was rolled back`,
                { severity: 'error', order_id: order.id, context: { web_user_id: order.web_user_id, credit_cents: credit } });
              deliveredGoods.push({ product: 'Balance Top-Up', items: ['CREDIT_FAILED'], ...lineDetail(item) });
              continue;
            }
            throw err;
          }
          deliveredGoods.push({ product: 'Balance Top-Up', items: [`+$${(credit / 100).toFixed(2)} credited`], ...lineDetail(item) });
        } else {
          deliveredGoods.push({ product: 'Balance Top-Up', items: ['NO_ACCOUNT_LINKED'], ...lineDetail(item) });
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
          ...lineDetail(item),
        });
        continue;
      }

      const tier = await lookupTier(item.id);

      if (!tier) {
        console.error(`[Delivery] Product ${item.id} not found`);
        deliveredGoods.push({ product: item.name, items: ['PRODUCT_NOT_FOUND'], ...lineDetail(item) });
        continue;
      }

      if (tier.delivery_type === 'auto' && tier.stock_type !== 'manual') {
        const claimed = [];

        // ─── supplier-backed tiers ───────────────────────────────────────────
        // Some tiers are not fulfilled from our pool at all: the key is bought
        // upstream at this moment. Tried BEFORE the local claim so we do not
        // burn one of our own keys on a sale the supplier was going to cover.
        //
        // linkForTier() already returns null when the link is disabled, when
        // the global switch is on, or when GANDY_API_KEY is unset — so all
        // three of those fall through to the loop below and the shop sells from
        // its own stock exactly as it always has. That fallback IS the feature:
        // it is what makes a drained supplier balance survivable.
        const link = await supplier.linkForTier(tier.id);
        if (link) {
          const bought = await supplier.purchase(link, {
            qty: item.qty || 1,
            orderId: order.id,
            // Their only order-reference hook, and the one string that ties a
            // charge on their invoice to an order here — there is no history
            // endpoint to ask afterwards.
            //
            // invoice_no, deliberately NOT public_ref. public_ref is the
            // unguessable handle that lets its holder read the order without a
            // session (GET /api/orders/:id?ref=), so sending it to a third
            // party hands them that capability. invoice_no is the reference
            // already printed on the customer's receipt — public by design.
            buyerRef: order.invoice_no || String(order.id),
          });

          if (bought.status === 'ok') {
            deliveredGoods.push({
              product: tier.product_name, game: tier.game_name || null,
              items: bought.lines, ...lineDetail(item),
              tier_label: item.tier_label || tier.label || null,
              source: 'supplier',
            });
            continue;
          }

          if (bought.status === 'timeout') {
            // AMBIGUOUS. They may have charged us and issued a key we never
            // read. Falling back would hand out a second key for one sale and
            // there is no way to hand the first one back, so this line stops
            // here and a human settles it against their panel.
            deliveredGoods.push({
              product: tier.product_name, game: tier.game_name || null,
              items: [supplier.SUPPLIER_TIMEOUT], ...lineDetail(item),
              tier_label: item.tier_label || tier.label || null,
              source: 'supplier',
            });
            continue;
          }

          // status === 'error': they answered and refused, which means nothing
          // was charged and nothing consumed on their side. Our own pool is a
          // safe second try, and a customer served from local stock is a
          // customer served. Only if that is empty too does the order fail —
          // and it then fails as OUT_OF_STOCK, which is the truth.
          console.error(`[Delivery] supplier refused tier ${tier.id} on order ${order.id}; falling back to local stock`);
        }

        for (let i = 0; i < (item.qty || 1); i++) {
          // Claim straight from the DB.
          //
          // This used to POST to its OWN /api/stock/claim over
          // http://localhost — an HTTP round trip with no timeout, and a bare
          // `catch` that turned ANY failure into the string 'OUT_OF_STOCK'.
          // The customer had already paid at this point, so a SIGTERM during a
          // deploy, a saturated connection pool, or the loopback stalling all
          // produced the same outcome: a paid order marked needs_attention
          // reporting an out-of-stock item that was actually in stock. It also
          // depended on API_SECRET being set for the server to authenticate to
          // itself, which is a fail-open surface for no benefit.
          //
          // Same statement, same atomicity (FOR UPDATE SKIP LOCKED), no
          // network. A genuine DB error is now distinguishable from real
          // exhaustion instead of being flattened into it.
          try {
            const { rows } = await query(
              `UPDATE product_stock SET used = true, used_at = now(), order_id = $1
               WHERE id = (
                 SELECT id FROM product_stock
                 WHERE guild_id = $2 AND tier_id = $3 AND used = false
                 ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
               )
               RETURNING value`,
              [order.id, GUILD_ID, tier.id]
            );
            claimed.push(rows.length ? rows[0].value : 'OUT_OF_STOCK');
          } catch (claimErr) {
            // Distinct marker: this is an infrastructure failure, not empty
            // stock, and it needs a human rather than a restock.
            console.error(`[Delivery] Stock claim FAILED for tier ${tier.id} on order ${order.id}:`, claimErr.message);
            claimed.push('CLAIM_ERROR');
          }
        }
        deliveredGoods.push({ product: tier.product_name, game: tier.game_name || null, items: claimed, ...lineDetail(item), tier_label: item.tier_label || tier.label || null });
      } else {
        deliveredGoods.push({ product: tier.product_name, game: tier.game_name || null, items: ['MANUAL_DELIVERY_REQUIRED'], ...lineDetail(item), tier_label: item.tier_label || tier.label || null });
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

    // Not awaited: deliver() runs inside the customer's checkout request, and
    // this is a Discord round-trip that can burn the full 8s notify timeout.
    // The goods are already written to the order row above, and the storefront
    // reads them back from /api/orders/mine — so nothing the customer sees
    // depends on this resolving. Its result was never inspected either.
    notifyBot('deliver_goods', {
      order_id: order.id,
      // The reference the buyer is shown everywhere else. Without it the DM
      // that hands over the keys is the one place quoting an id the customer
      // cannot use for anything.
      invoice_no: order.invoice_no || null,
      email: order.email,
      discord_id: order.discord_id,
      goods: deliveredGoods,
      needs_attention: failures.length > 0,
      // So #order-log can say SOURCE: WEBSITE the way the vouch embed already
      // does. Defaulted here rather than trusted blank: every row that reaches
      // deliver() came through checkout, and a row written before the column
      // existed reads NULL.
      source: order.source || 'website',
    }).catch(() => {});

    if (failures.length) {
      await raiseAlert('delivery_incomplete',
        `Order ${order.id} is PAID but could not be fulfilled: ${failures.map(f => `${f.product}=${f.marker}`).join(', ')}`,
        { severity: 'error', order_id: order.id, context: { failures, email: order.email, discord_id: order.discord_id } });
      console.error(`[Delivery] Order ${order.id} needs attention — customer email suppressed`);
      return;
    }

    // Email confirmation — best-effort, never blocks the delivered state.
    // Also not awaited: SMTP is the slowest hop in this function and the
    // customer's checkout response was waiting on it.
    sendOrderConfirmation(order, deliveredGoods).catch(e =>
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
