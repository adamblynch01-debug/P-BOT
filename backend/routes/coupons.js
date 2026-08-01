// ─── /api/coupons ─────────────────────────────────────────────────────────
// Admin CRUD for time-limited discount codes. There is deliberately NO public
// route here: the storefront checks a code by re-quoting the cart through
// POST /api/orders/quote, which is the same authority that will charge for it.
// A standalone "is this code good?" endpoint would be a second opinion on
// money, and the two would eventually disagree.
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAdmin, requireOwnerAdmin } = require('../utils/auth');
const { CODE_RE } = require('../utils/coupons');

const GUILD_ID = process.env.GUILD_ID;

// Turns a datetime-local value ("2026-08-01T17:00") or an ISO string into a
// Date. Returns undefined for "leave this bound open" and null for garbage, so
// a typo cannot silently become "starts now, never expires".
function parseWhen(v) {
  if (v == null || String(v).trim() === '') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function intOrNull(v, { min = 1, max = 2147483647 } = {}) {
  if (v == null || String(v).trim() === '') return undefined;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function view(r) {
  return {
    id: String(r.id),
    code: r.code,
    description: r.description || '',
    kind: r.kind,
    percent_off: r.percent_off != null ? Number(r.percent_off) : null,
    amount_off: r.amount_off_cents != null ? Number(r.amount_off_cents) / 100 : null,
    starts_at: r.starts_at,
    expires_at: r.expires_at,
    max_uses: r.max_uses != null ? Number(r.max_uses) : null,
    max_uses_per_user: r.max_uses_per_user != null ? Number(r.max_uses_per_user) : null,
    min_subtotal: (Number(r.min_subtotal_cents) || 0) / 100,
    uses: Number(r.uses) || 0,
    active: !!r.active,
    created_by: r.created_by || null,
    created_at: r.created_at,
    // Computed here so the panel does not re-implement the window rule that
    // utils/coupons.js enforces. Same half-open [starts_at, expires_at).
    live: !!r.active
      && (!r.starts_at || new Date(r.starts_at) <= new Date())
      && (!r.expires_at || new Date(r.expires_at) > new Date())
      && (r.max_uses == null || Number(r.uses) < Number(r.max_uses)),
  };
}

// ─── GET /api/coupons/admin/list ──────────────────────────
router.get('/admin/list', requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM coupons WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 500',
      [GUILD_ID]
    );
    res.json({ coupons: rows.map(view) });
  } catch (err) {
    console.error('[Coupons] list error:', err);
    res.status(500).json({ error: 'Failed to load coupons. Has the coupons migration been run?' });
  }
});

// ─── POST /api/coupons/admin/save ─────────────────────────
// Creates when `id` is absent, updates when present. Every field is validated
// here as well as by the table's CHECK constraints — the constraints are the
// backstop, but a 23514 reaches the admin as an opaque 500, and the person
// setting up a sale deserves to be told which field is wrong.
router.post('/admin/save', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const id = b.id ? String(b.id) : null;

    const code = String(b.code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      return res.status(400).json({
        error: 'Code must be 2–32 characters: letters, numbers, dashes or underscores.',
      });
    }

    const kind = b.kind === 'fixed' ? 'fixed' : 'percent';
    let percent_off = null;
    let amount_off_cents = null;
    if (kind === 'percent') {
      percent_off = parseInt(b.percent_off, 10);
      if (!Number.isInteger(percent_off) || percent_off < 1 || percent_off > 90) {
        return res.status(400).json({ error: 'Percent off must be between 1 and 90.' });
      }
    } else {
      const amt = Number(b.amount_off);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: 'Amount off must be greater than $0.' });
      }
      amount_off_cents = Math.round(amt * 100);
    }

    const starts_at = parseWhen(b.starts_at);
    const expires_at = parseWhen(b.expires_at);
    if (starts_at === null || expires_at === null) {
      return res.status(400).json({ error: 'Start and end must be valid dates (or left blank).' });
    }
    if (starts_at && expires_at && expires_at <= starts_at) {
      return res.status(400).json({ error: 'The end of the window must be after its start.' });
    }
    // An already-lapsed window is almost always a typo in the year, and it
    // produces a coupon that is dead the moment it is created — say so now
    // rather than after the sale is announced.
    if (expires_at && expires_at <= new Date() && !id) {
      return res.status(400).json({ error: 'That end date is already in the past.' });
    }

    const max_uses = intOrNull(b.max_uses);
    const max_uses_per_user = intOrNull(b.max_uses_per_user);
    if (max_uses === null || max_uses_per_user === null) {
      return res.status(400).json({ error: 'Usage limits must be whole numbers of 1 or more (or left blank).' });
    }

    const minSub = b.min_subtotal == null || String(b.min_subtotal).trim() === '' ? 0 : Number(b.min_subtotal);
    if (!Number.isFinite(minSub) || minSub < 0) {
      return res.status(400).json({ error: 'Minimum subtotal must be $0 or more.' });
    }

    const params = [
      GUILD_ID, code, String(b.description || '').slice(0, 200) || null, kind,
      percent_off, amount_off_cents,
      starts_at === undefined ? null : starts_at,
      expires_at === undefined ? null : expires_at,
      max_uses === undefined ? null : max_uses,
      max_uses_per_user === undefined ? null : max_uses_per_user,
      Math.round(minSub * 100),
      b.active === false ? false : true,
    ];

    let rows;
    if (id) {
      // `uses` is never written here. Editing a coupon must not reset the
      // counter that its own max_uses is checked against, or extending a sale
      // would quietly hand out a second batch of redemptions.
      ({ rows } = await query(
        `UPDATE coupons SET code = $2, description = $3, kind = $4, percent_off = $5,
                amount_off_cents = $6, starts_at = $7, expires_at = $8, max_uses = $9,
                max_uses_per_user = $10, min_subtotal_cents = $11, active = $12, updated_at = now()
          WHERE id = $13 AND guild_id = $1 RETURNING *`,
        [...params, id]
      ));
      if (!rows.length) return res.status(404).json({ error: 'Coupon not found' });
    } else {
      ({ rows } = await query(
        `INSERT INTO coupons (guild_id, code, description, kind, percent_off, amount_off_cents,
                              starts_at, expires_at, max_uses, max_uses_per_user,
                              min_subtotal_cents, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [...params, (req.user && req.user.username) || 'admin']
      ));
    }

    res.json({ success: true, coupon: view(rows[0]) });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'A coupon with that code already exists.' });
    }
    console.error('[Coupons] save error:', err);
    res.status(500).json({ error: 'Failed to save coupon' });
  }
});

// ─── POST /api/coupons/admin/delete ───────────────────────
// Deleting drops the redemption rows with it (ON DELETE CASCADE), which is why
// the panel offers "deactivate" as the softer option: an order keeps its own
// coupon_code snapshot either way, but the audit trail only survives if the
// coupon does.
//
// requireOwnerAdmin, not requireAdmin — requireAdmin admits role 'staff', and
// staff are explicitly edit/hide only. Deactivating stays on requireAdmin,
// because that is the reversible half.
router.post('/admin/delete', requireOwnerAdmin, async (req, res) => {
  try {
    const id = req.body && req.body.id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { rowCount } = await query('DELETE FROM coupons WHERE id = $1 AND guild_id = $2', [id, GUILD_ID]);
    if (!rowCount) return res.status(404).json({ error: 'Coupon not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Coupons] delete error:', err);
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
});

// ─── GET /api/coupons/admin/redemptions?id= ───────────────
router.get('/admin/redemptions', requireAdmin, async (req, res) => {
  try {
    const id = req.query.id ? String(req.query.id) : null;
    const { rows } = await query(
      `SELECT r.id, r.code, r.order_id, r.web_user_id, r.discount_cents, r.created_at, u.username
         FROM coupon_redemptions r
         LEFT JOIN web_users u ON u.id = r.web_user_id
        WHERE r.guild_id = $1 AND ($2::bigint IS NULL OR r.coupon_id = $2)
        ORDER BY r.created_at DESC LIMIT 300`,
      [GUILD_ID, id]
    );
    res.json({
      redemptions: rows.map(r => ({
        id: String(r.id),
        code: r.code,
        order_id: r.order_id != null ? String(r.order_id) : null,
        username: r.username || null,
        discount: (Number(r.discount_cents) || 0) / 100,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[Coupons] redemptions error:', err);
    res.status(500).json({ error: 'Failed to load redemptions' });
  }
});

module.exports = router;
