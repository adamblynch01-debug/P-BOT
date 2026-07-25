const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth, requireAdmin, getSessionUser, bearerToken } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// Matches the panel's own qty cap. Bounded server-side too, so a crafted
// request can't insert a million-key order row.
const MAX_KEYGEN_QTY = 50;

// Bot (secret) and admin panel (logged-in admin/staff session) both manage
// reseller wallets — same dual-gate pattern as routes/stock.js.
async function isAuthorizedOrAdmin(req) {
  if (req.body && req.body.secret === process.env.API_SECRET) return true;
  const user = await getSessionUser(bearerToken(req));
  return !!(user && ['admin', 'staff'].includes(user.role));
}

// Ensure a reseller_balances row exists (accounts may predate this table),
// then return the current cents. Never throws on a missing row.
async function ensureResellerWallet(webUserId) {
  const { rows } = await query('SELECT balance_cents FROM reseller_balances WHERE web_user_id = $1', [webUserId]);
  if (rows.length) return Number(rows[0].balance_cents);
  await query('INSERT INTO reseller_balances (web_user_id, guild_id, balance_cents) VALUES ($1,$2,0)', [webUserId, GUILD_ID]);
  return 0;
}

// Resolve a web_users id from user_id | username | discord_id.
async function resolveUserId({ user_id, username, discord_id }) {
  if (user_id) {
    const { rows } = await query('SELECT id FROM web_users WHERE guild_id = $1 AND id = $2', [GUILD_ID, user_id]);
    return rows.length ? rows[0].id : null;
  }
  if (username) {
    const { rows } = await query('SELECT id FROM web_users WHERE guild_id = $1 AND lower(username) = lower($2)', [GUILD_ID, username]);
    return rows.length ? rows[0].id : null;
  }
  if (discord_id) {
    const { rows } = await query('SELECT id FROM web_users WHERE guild_id = $1 AND discord_id = $2', [GUILD_ID, discord_id]);
    return rows.length ? rows[0].id : null;
  }
  return null;
}

// ─── GET /api/reseller/mine ──────────────────────────────
// The logged-in reseller's own wallet, ledger, and keygen-order history.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const cents = await ensureResellerWallet(req.user.id);
    const { rows: tx } = await query(
      `SELECT kind, amount_cents, description, created_at
       FROM reseller_transactions WHERE web_user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    const { rows: orders } = await query(
      `SELECT id, product, tier, qty, unit_cents, total_cents, keys, created_at
       FROM reseller_orders WHERE web_user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({
      balance_cents: cents,
      balance: cents / 100,
      role: req.user.reseller_role || null,
      discount: req.user.reseller_discount || 0,
      suspended: !!req.user.reseller_suspended,
      transactions: tx.map(r => ({
        kind: r.kind, amount: r.amount_cents / 100, description: r.description, created_at: r.created_at,
      })),
      orders: orders.map(r => ({
        id: String(r.id), product: r.product, tier: r.tier, qty: r.qty,
        unit: r.unit_cents != null ? r.unit_cents / 100 : null,
        total: r.total_cents != null ? r.total_cents / 100 : null,
        keys: Array.isArray(r.keys) ? r.keys : [], created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[Reseller] mine error:', err);
    res.status(500).json({ error: 'Failed to fetch reseller account' });
  }
});

// ─── GET /api/reseller/list ──────────────────────────────
// Admin roster of every reseller (role-flagged web_users) with wallet balance
// and keygen counts. Replaces the localStorage getRsUserList() merge.
router.get('/list', requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.username, u.email, u.role, u.discord_id, u.discord_verified,
              u.banned, u.created_at, u.reseller_role, u.reseller_discount, u.reseller_suspended,
              COALESCE(rb.balance_cents, 0) AS balance_cents,
              (SELECT COUNT(*)::int FROM reseller_orders o WHERE o.web_user_id = u.id) AS order_count,
              (SELECT COALESCE(SUM(qty),0)::int FROM reseller_orders o WHERE o.web_user_id = u.id) AS keys_gen
       FROM web_users u
       LEFT JOIN reseller_balances rb ON rb.web_user_id = u.id
       WHERE u.guild_id = $1 AND (u.role = 'reseller' OR u.reseller_role IS NOT NULL)
       ORDER BY u.created_at DESC`,
      [GUILD_ID]
    );
    res.json({
      resellers: rows.map(r => ({
        id: String(r.id), username: r.username, email: r.email, role: r.role,
        discord_id: r.discord_id, discord_verified: r.discord_verified, banned: r.banned,
        created_at: r.created_at, reseller_role: r.reseller_role,
        discount: r.reseller_discount || 0, suspended: !!r.reseller_suspended,
        balance: Number(r.balance_cents) / 100, order_count: r.order_count, keys_gen: r.keys_gen,
      })),
    });
  } catch (err) {
    console.error('[Reseller] list error:', err);
    res.status(500).json({ error: 'Failed to fetch resellers' });
  }
});

// ─── GET /api/reseller/orders?user_id=|username= ─────────
// Admin drill-down: one reseller's keygen-order history + ledger. Backs the
// admin roster's per-user "orders" expander (was getRsOrders localStorage).
router.get('/orders', requireAdmin, async (req, res) => {
  try {
    const webUserId = await resolveUserId({
      user_id: req.query.user_id, username: req.query.username, discord_id: req.query.discord_id,
    });
    if (!webUserId) return res.status(404).json({ error: 'User not found' });
    const { rows: orders } = await query(
      `SELECT id, product, tier, qty, unit_cents, total_cents, keys, created_at
       FROM reseller_orders WHERE web_user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [webUserId]
    );
    const { rows: tx } = await query(
      `SELECT kind, amount_cents, description, created_at
       FROM reseller_transactions WHERE web_user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [webUserId]
    );
    res.json({
      orders: orders.map(r => ({
        id: String(r.id), product: r.product, tier: r.tier, qty: r.qty,
        unit: r.unit_cents != null ? r.unit_cents / 100 : null,
        total: r.total_cents != null ? r.total_cents / 100 : null,
        keys: Array.isArray(r.keys) ? r.keys : [], created_at: r.created_at,
      })),
      transactions: tx.map(r => ({
        kind: r.kind, amount: r.amount_cents / 100, description: r.description, created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[Reseller] orders error:', err);
    res.status(500).json({ error: 'Failed to fetch reseller orders' });
  }
});

// ─── POST /api/reseller/adjust ───────────────────────────
// Admin credit/debit of a reseller's wallet (the panel's MANAGE RESELLER
// BALANCE). Debits floored at 0. Logs a reseller_transactions row.
router.post('/adjust', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { user_id, username, discord_id, amount_cents, description } = req.body;
    if (!amount_cents || !Number.isInteger(amount_cents)) {
      return res.status(400).json({ error: 'amount_cents must be a non-zero integer (negative to debit)' });
    }
    const webUserId = await resolveUserId({ user_id, username, discord_id });
    if (!webUserId) return res.status(404).json({ error: 'User not found' });

    await ensureResellerWallet(webUserId);
    const { rows } = await query(
      `UPDATE reseller_balances SET balance_cents = GREATEST(0, balance_cents + $1), updated_at = now()
       WHERE web_user_id = $2 RETURNING balance_cents`,
      [amount_cents, webUserId]
    );
    await query(
      `INSERT INTO reseller_transactions (guild_id, web_user_id, kind, amount_cents, description)
       VALUES ($1,$2,$3,$4,$5)`,
      [GUILD_ID, webUserId, amount_cents >= 0 ? 'credit' : 'debit', Math.abs(amount_cents), description || 'Admin adjustment']
    );
    res.json({ success: true, balance_cents: Number(rows[0].balance_cents), balance: Number(rows[0].balance_cents) / 100 });
  } catch (err) {
    console.error('[Reseller] adjust error:', err);
    res.status(500).json({ error: 'Failed to adjust reseller balance' });
  }
});

// ─── POST /api/reseller/purchase ─────────────────────────
// The reseller keygen-buy: debit the reseller wallet by the discounted total,
// record a reseller_orders row with the generated keys, and log the debit.
// Server-authoritative: role, discount, list price, and balance ALL come from
// the DB. tier_id identifies what is being bought; any client-sent price is
// ignored, because the browser's tier <option> value is the price itself and a
// reseller could edit it in devtools to mint keys for a cent.
router.post('/purchase', requireAuth, async (req, res) => {
  try {
    // A wallet debit must never be available to a non-reseller. requireAuth
    // only proves "logged in", so gate on the role the admin actually granted.
    const isReseller = req.user.role === 'reseller' || !!req.user.reseller_role;
    if (!isReseller) return res.status(403).json({ error: 'Not a reseller account' });
    if (req.user.reseller_suspended) return res.status(403).json({ error: 'Reseller account suspended' });

    const { product, tier, tier_id, qty, keys } = req.body;
    const q = parseInt(qty, 10);
    if (!Number.isInteger(q) || q < 1 || q > MAX_KEYGEN_QTY) {
      return res.status(400).json({ error: `qty must be between 1 and ${MAX_KEYGEN_QTY}` });
    }
    if (!Array.isArray(keys) || keys.length !== q) {
      return res.status(400).json({ error: 'keys[] must be provided and match qty' });
    }
    if (!keys.every(k => typeof k === 'string' && k.trim() && k.length <= 128)) {
      return res.status(400).json({ error: 'keys[] must be non-empty strings' });
    }

    // Price comes from product_tiers, never from the request.
    const { rows: tierRows } = await query(
      `SELECT t.id, t.label, t.price_cents, p.name AS product_name
       FROM product_tiers t JOIN products p ON p.id = t.product_id
       WHERE t.id = $1 AND t.guild_id = $2`,
      [tier_id, GUILD_ID]
    );
    if (!tierRows.length) return res.status(400).json({ error: 'Unknown tier_id' });
    const tierRow = tierRows[0];
    const listCents = Number(tierRow.price_cents) || 0;
    if (listCents <= 0) return res.status(400).json({ error: 'Tier has no price set' });

    const discount = Math.max(0, Math.min(99, Number(req.user.reseller_discount) || 0));
    const unitCents = Math.round(listCents * (1 - discount / 100));
    const totalCents = unitCents * q;

    const bal = await ensureResellerWallet(req.user.id);
    if (bal < totalCents) return res.status(400).json({ error: 'Insufficient reseller balance' });

    // Debit and re-check the balance in ONE statement. A plain
    // `balance_cents - $1` lets two concurrent keygens each pass the read above
    // and drive the wallet negative; the WHERE clause makes the guard atomic.
    const { rows } = await query(
      `UPDATE reseller_balances SET balance_cents = balance_cents - $1, updated_at = now()
       WHERE web_user_id = $2 AND balance_cents >= $1 RETURNING balance_cents`,
      [totalCents, req.user.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'Insufficient reseller balance' });

    const productName = tierRow.product_name || product || 'Item';
    const tierLabel = tierRow.label || tier || null;
    const { rows: ord } = await query(
      `INSERT INTO reseller_orders (guild_id, web_user_id, product, tier, qty, unit_cents, total_cents, keys)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [GUILD_ID, req.user.id, productName, tierLabel, q, unitCents, totalCents, JSON.stringify(keys)]
    );
    await query(
      `INSERT INTO reseller_transactions (guild_id, web_user_id, kind, amount_cents, description)
       VALUES ($1,$2,'debit',$3,$4)`,
      [GUILD_ID, req.user.id, totalCents, `Key Gen: ${productName}${tierLabel ? ' (' + tierLabel + ')' : ''} × ${q}`]
    );
    res.json({
      success: true, order_id: String(ord[0].id),
      unit: unitCents / 100, total: totalCents / 100, discount,
      balance_cents: Number(rows[0].balance_cents), balance: Number(rows[0].balance_cents) / 100,
    });
  } catch (err) {
    console.error('[Reseller] purchase error:', err);
    res.status(500).json({ error: 'Failed to complete reseller purchase' });
  }
});

// ─── POST /api/reseller/role ─────────────────────────────
// Admin assigns/revokes a reseller role + snapshots its discount onto the
// web_users row. Pass role:null to revoke. discount is the role's % (0-99).
router.post('/role', requireAdmin, async (req, res) => {
  try {
    const { user_id, username, role, discount } = req.body;
    const webUserId = await resolveUserId({ user_id, username });
    if (!webUserId) return res.status(404).json({ error: 'User not found' });
    const disc = Math.max(0, Math.min(99, parseInt(discount, 10) || 0));
    const roleName = role ? String(role) : null;
    await query(
      `UPDATE web_users SET reseller_role = $1, reseller_discount = $2,
              role = CASE WHEN $1 IS NULL AND role = 'reseller' THEN 'member'
                          WHEN $1 IS NOT NULL THEN 'reseller' ELSE role END
       WHERE id = $3 AND guild_id = $4`,
      [roleName, roleName ? disc : 0, webUserId, GUILD_ID]
    );
    if (roleName) await ensureResellerWallet(webUserId);
    res.json({ success: true });
  } catch (err) {
    console.error('[Reseller] role error:', err);
    res.status(500).json({ error: 'Failed to update reseller role' });
  }
});

// ─── POST /api/reseller/suspend ──────────────────────────
// Admin toggles a reseller's suspended flag.
router.post('/suspend', requireAdmin, async (req, res) => {
  try {
    const { user_id, username, suspended } = req.body;
    const webUserId = await resolveUserId({ user_id, username });
    if (!webUserId) return res.status(404).json({ error: 'User not found' });
    await query('UPDATE web_users SET reseller_suspended = $1 WHERE id = $2 AND guild_id = $3',
      [!!suspended, webUserId, GUILD_ID]);
    res.json({ success: true, suspended: !!suspended });
  } catch (err) {
    console.error('[Reseller] suspend error:', err);
    res.status(500).json({ error: 'Failed to update suspend state' });
  }
});

module.exports = router;
