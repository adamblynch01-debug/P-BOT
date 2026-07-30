// ─── Coupon codes ─────────────────────────────────────────────────────────
// A code the customer types at checkout that is only live between two
// timestamps. Everything that decides money lives here, and both /api/orders
// routes call it — the browser may render a discount but never computes one,
// for the same reason repriceItems exists: `price` flows into the wallet debit.
//
// Two entry points, deliberately separate:
//   preview()  read-only. Backs /quote and the "insufficient balance?" check.
//   reserve()  atomic. Consumes a use. Only /create calls it.
// A single validate-then-consume function would have to be called twice on the
// create path (once to size the balance check, once to charge) and would burn
// two uses.
'use strict';

const { query, withTransaction } = require('../db');

const GUILD_ID = process.env.GUILD_ID;

// Codes are typed by hand off a banner or a Discord post, so they are matched
// case-insensitively by upper-casing on the way in and on the way out to the
// unique index. Anything outside this shape cannot exist in the table, so a
// junk code is rejected without a round trip.
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

function normalizeCode(raw) {
  if (raw == null) return null;
  const code = String(raw).trim().toUpperCase();
  if (!code) return null;
  return CODE_RE.test(code) ? code : false; // false = present but malformed
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// What a coupon takes off a given eligible subtotal, in integer cents.
//
// Clamped to the eligible subtotal, so a $50-off code on a $20 cart takes $20
// and not $50 — an unclamped fixed discount would drive the total negative,
// and a negative total on the balance path is a wallet CREDIT.
function discountFor(coupon, eligibleCents) {
  if (eligibleCents <= 0) return 0;
  const raw = coupon.kind === 'fixed'
    ? Number(coupon.amount_off_cents) || 0
    // Basis points keep this in integers, matching the reseller discount in
    // routes/orders.js rather than inventing a second rounding rule.
    : Math.round((eligibleCents * Math.round((Number(coupon.percent_off) || 0) * 100)) / 10000);
  return Math.max(0, Math.min(eligibleCents, raw));
}

// Everything except the usage caps — the part that is identical for a preview
// and for the locked re-check inside reserve().
function windowError(coupon, now) {
  if (!coupon.active) return 'That coupon code is not valid.';
  if (coupon.starts_at && new Date(coupon.starts_at) > now) {
    return `That coupon is not active until ${new Date(coupon.starts_at).toUTCString()}.`;
  }
  // Half-open: expires_at is the first instant the code is dead.
  if (coupon.expires_at && new Date(coupon.expires_at) <= now) {
    return 'That coupon has expired.';
  }
  return null;
}

function amountError(coupon, eligibleCents) {
  const min = Number(coupon.min_subtotal_cents) || 0;
  if (min > 0 && eligibleCents < min) {
    return `That coupon needs an eligible subtotal of at least ${money(min)}.`;
  }
  // Reached when a cart is entirely custom payments / legacy slugs: there is
  // nothing the coupon is allowed to discount. Saying "no eligible items" is
  // the honest message; silently applying $0 would look like the code failed.
  if (eligibleCents <= 0) {
    return 'That coupon does not apply to anything in this cart.';
  }
  return null;
}

async function loadCoupon(code, exec) {
  const run = exec || query;
  const { rows } = await run(
    'SELECT * FROM coupons WHERE guild_id = $1 AND code = $2',
    [GUILD_ID, code]
  );
  return rows[0] || null;
}

function publicView(coupon, discountCents) {
  return {
    code: coupon.code,
    description: coupon.description || null,
    kind: coupon.kind,
    percent_off: coupon.kind === 'percent' ? Number(coupon.percent_off) : null,
    amount_off: coupon.kind === 'fixed' ? Number(coupon.amount_off_cents) / 100 : null,
    expires_at: coupon.expires_at || null,
    discount: discountCents / 100,
  };
}

// ─── preview ──────────────────────────────────────────────────────────────
// Read-only. Returns { coupon, discountCents } or { error }. `error` is a
// message meant to be shown to the customer verbatim, so it must never leak
// whether an unknown code merely lapsed or never existed.
async function previewCoupon({ code: rawCode, eligibleCents, web_user_id }) {
  const code = normalizeCode(rawCode);
  if (code === null) return { coupon: null, discountCents: 0 };
  if (code === false) return { error: 'That coupon code is not valid.' };

  let coupon;
  try {
    coupon = await loadCoupon(code);
  } catch (err) {
    // The table is created by a migration that has to be run by hand. If it is
    // missing, a checkout must NOT die — it just prices without the coupon,
    // and the operator gets a loud log instead of a customer getting a 500.
    console.error('[Coupons] lookup failed:', err.message);
    return { error: 'Coupon codes are temporarily unavailable.' };
  }
  if (!coupon) return { error: 'That coupon code is not valid.' };

  const now = new Date();
  const werr = windowError(coupon, now);
  if (werr) return { error: werr };

  if (coupon.max_uses != null && Number(coupon.uses) >= Number(coupon.max_uses)) {
    return { error: 'That coupon has been fully redeemed.' };
  }

  if (coupon.max_uses_per_user != null) {
    // A per-user cap is unenforceable against a guest checkout — there is no
    // stable identity to count against, so an anonymous buyer could replay a
    // one-per-customer code forever. Require the session instead of pretending.
    if (!web_user_id) return { error: 'Log in to use that coupon code.' };
    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND web_user_id = $2',
      [coupon.id, web_user_id]
    );
    if (rows[0].n >= Number(coupon.max_uses_per_user)) {
      return { error: 'You have already used that coupon code.' };
    }
  }

  const aerr = amountError(coupon, eligibleCents);
  if (aerr) return { error: aerr };

  return { coupon, discountCents: discountFor(coupon, eligibleCents) };
}

// ─── reserve ──────────────────────────────────────────────────────────────
// Consumes one use, atomically, and writes the audit row. Returns
// { coupon, discountCents, redemptionId } or { error }.
//
// The whole check runs under SELECT … FOR UPDATE on the coupon row, which
// serialises every redemption of that one code. Without it, two checkouts that
// both read `uses = 9` against `max_uses = 10` would both pass and both charge
// a discounted total — and the per-user cap, which is a COUNT and cannot be
// folded into a conditional UPDATE, would be racy for any cap above 1.
// Contention is per coupon, and a coupon redemption is not a hot path.
async function reserveCoupon({ code: rawCode, eligibleCents, web_user_id }) {
  const code = normalizeCode(rawCode);
  if (code === null) return { coupon: null, discountCents: 0 };
  if (code === false) return { error: 'That coupon code is not valid.' };

  try {
    return await withTransaction(async (exec) => {
      const { rows: locked } = await exec(
        'SELECT * FROM coupons WHERE guild_id = $1 AND code = $2 FOR UPDATE',
        [GUILD_ID, code]
      );
      const coupon = locked[0];
      if (!coupon) return { error: 'That coupon code is not valid.' };

      const now = new Date();
      const werr = windowError(coupon, now);
      if (werr) return { error: werr };
      if (coupon.max_uses != null && Number(coupon.uses) >= Number(coupon.max_uses)) {
        return { error: 'That coupon has been fully redeemed.' };
      }
      if (coupon.max_uses_per_user != null) {
        if (!web_user_id) return { error: 'Log in to use that coupon code.' };
        const { rows: mine } = await exec(
          'SELECT COUNT(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND web_user_id = $2',
          [coupon.id, web_user_id]
        );
        if (mine[0].n >= Number(coupon.max_uses_per_user)) {
          return { error: 'You have already used that coupon code.' };
        }
      }
      const aerr = amountError(coupon, eligibleCents);
      if (aerr) return { error: aerr };

      const discountCents = discountFor(coupon, eligibleCents);

      // The guard is repeated in the UPDATE even though the row is locked: it
      // costs nothing and it is the thing that would still hold if this ever
      // ran outside the transaction.
      const { rows: bumped } = await exec(
        `UPDATE coupons SET uses = uses + 1, updated_at = now()
          WHERE id = $1 AND (max_uses IS NULL OR uses < max_uses)
          RETURNING uses`,
        [coupon.id]
      );
      if (!bumped.length) return { error: 'That coupon has been fully redeemed.' };

      const { rows: red } = await exec(
        `INSERT INTO coupon_redemptions (coupon_id, guild_id, web_user_id, code, discount_cents)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [coupon.id, GUILD_ID, web_user_id || null, coupon.code, discountCents]
      );

      return { coupon, discountCents, redemptionId: red[0].id };
    });
  } catch (err) {
    console.error('[Coupons] reserve failed:', err.message);
    return { error: 'Coupon codes are temporarily unavailable.' };
  }
}

// Stamp the order id on a reservation once the order row exists. Non-fatal:
// the use is already consumed and the order already carries its own
// coupon_code snapshot, so a failure here costs an audit link, not money.
async function attachRedemptionOrder(redemptionId, orderId) {
  if (!redemptionId) return;
  try {
    await query('UPDATE coupon_redemptions SET order_id = $1 WHERE id = $2', [orderId, redemptionId]);
  } catch (err) {
    console.error('[Coupons] could not link redemption to order:', err.message);
  }
}

// Give the use back when the order it was reserved for never happened.
// Without this, a checkout that failed after the reservation (a note-retry
// exhaustion, an insufficient balance) would permanently eat one use of a
// limited coupon that the customer never actually received.
async function releaseCoupon(redemptionId, couponId) {
  if (!redemptionId) return;
  try {
    await withTransaction(async (exec) => {
      const { rows } = await exec('DELETE FROM coupon_redemptions WHERE id = $1 RETURNING coupon_id', [redemptionId]);
      if (!rows.length) return; // already released — do not decrement twice
      await exec(
        'UPDATE coupons SET uses = GREATEST(0, uses - 1), updated_at = now() WHERE id = $1',
        [couponId || rows[0].coupon_id]
      );
    });
  } catch (err) {
    console.error('[Coupons] release failed (a use may be stranded):', err.message);
  }
}

module.exports = {
  normalizeCode,
  discountFor,
  previewCoupon,
  reserveCoupon,
  attachRedemptionOrder,
  releaseCoupon,
  publicView,
  CODE_RE,
};
