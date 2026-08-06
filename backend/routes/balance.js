const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { requireAuth, requireAdmin, requireOwnerAdmin, requireDiscordLinked, publicUser, botAuthorized, botAuthUnavailable } = require('../utils/auth');
const { logAdminAction } = require('../utils/adminLog');

const GUILD_ID = process.env.GUILD_ID;

// Applies a signed delta to a wallet and logs it, or refuses.
//
// Both adjust routes used to write the ledger row unconditionally alongside a
// `GREATEST(0, balance_cents + $1)` update. When a debit exceeded the balance
// the wallet stopped at zero while the ledger recorded the full amount, so
// SUM(credits) - SUM(debits) permanently disagreed with balance_cents — the
// exact drift that makes a reconciliation report untrustworthy. Now the guard
// is in the UPDATE's own WHERE clause: either the whole delta applies and gets
// logged, or nothing happens and the caller gets an error.
// The sufficiency guard lives in the UPDATE's WHERE clause and is race-safe on
// its own: Postgres re-evaluates it after taking the row lock, so two
// concurrent debits cannot both pass. What it does NOT give is atomicity with
// the ledger INSERT that follows — a failure between the two left the wallet
// moved with nothing recording why, which is precisely the drift
// balance_audit.sql #5 exists to detect. Both statements now commit together or
// not at all.
async function applyBalanceDelta(webUserId, amountCents, description, kindLabel) {
  return withTransaction(async (exec) => {
    const { rows: balRows } = await exec('SELECT web_user_id FROM balances WHERE web_user_id = $1', [webUserId]);
    if (!balRows.length) {
      await exec('INSERT INTO balances (web_user_id, guild_id, balance_cents) VALUES ($1,$2,0)', [webUserId, GUILD_ID]);
    }

    const { rows } = await exec(
      `UPDATE balances SET balance_cents = balance_cents + $1, updated_at = now()
        WHERE web_user_id = $2 AND balance_cents + $1 >= 0
        RETURNING balance_cents`,
      [amountCents, webUserId]
    );
    if (!rows.length) {
      const err = new Error('Insufficient balance for that debit');
      err.statusCode = 400;
      throw err; // rolls back the balances row created above
    }

    await exec(
      `INSERT INTO transactions (guild_id, web_user_id, kind, amount_cents, description)
       VALUES ($1,$2,$3,$4,$5)`,
      [GUILD_ID, webUserId, amountCents >= 0 ? 'credit' : 'debit', Math.abs(amountCents), description || kindLabel]
    );

    return rows[0].balance_cents;
  });
}

// ─── GET /api/balance/mine ───────────────────────────────
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT kind, amount_cents, description, order_id, created_at
       FROM transactions WHERE web_user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({
      balance_cents: req.user.balance_cents || 0,
      balance: (req.user.balance_cents || 0) / 100,
      transactions: rows.map(r => ({
        kind: r.kind,
        amount: r.amount_cents / 100,
        description: r.description,
        order_id: r.order_id ? String(r.order_id) : null,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// ─── POST /api/balance/topup/create ─────────────────────
// Uses the same order pipeline as checkout (fees, crypto address, Discord
// notify) with a single synthetic "balance top-up" line item; delivery.js
// recognizes item.id === 'balance-topup' and credits the wallet instead of
// claiming stock once the order is confirmed paid.
router.post('/topup/create', requireAuth, requireDiscordLinked, async (req, res) => {
  try {
    const { amount, payment_method } = req.body;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!['cashapp', 'paypal', 'btc', 'ltc'].includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment method for top-up' });
    }

    const { createOrder } = require('./orders');
    const { order, payment_info, total, fee_note } = await createOrder({
      items: [{ id: 'balance-topup', name: 'Balance Top-Up', price: amt, qty: 1 }],
      email: req.user.email,
      discord_id: req.user.discord_id,
      payment_method,
      web_user_id: req.user.id,
    });

    res.json({
      success: true,
      order_id: String(order.id),
      payment_method,
      payment_info,
      total,
      fee_note,
      expires_at: order.expires_at,
    });
  } catch (err) {
    // createOrder refuses a method whose address is not payable (see
    // utils/paymentAddress.js). A top-up goes through the same path, so it
    // gets the same answer rather than a 500 the buyer cannot act on.
    if (err && err.statusCode === 503) return res.status(503).json({ error: err.message });
    console.error('[Balance] Topup create error:', err);
    res.status(500).json({ error: 'Failed to start top-up' });
  }
});

// ─── GET /api/balance/by-discord/:discordId ──────────────
// Used by SUPERBOT's /web-balance command.
router.get('/by-discord/:discordId', async (req, res) => {
  try {
    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { rows } = await query(
      `SELECT u.username, u.email, b.balance_cents FROM web_users u
       LEFT JOIN balances b ON b.web_user_id = u.id
       WHERE u.guild_id = $1 AND u.discord_id = $2`,
      [GUILD_ID, req.params.discordId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No linked account for that Discord user' });
    const r = rows[0];
    res.json({ username: r.username, email: r.email, balance_cents: r.balance_cents || 0, balance: (r.balance_cents || 0) / 100 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// ─── POST /api/balance/adjust ────────────────────────────
// Admin/bot-driven credit or debit, e.g. manual top-up confirmation or a
// refund. Gated by API_SECRET like the rest of this backend's internal ops.
router.post('/adjust', async (req, res) => {
  try {
    const { username, discord_id, amount_cents, description } = req.body;
    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (!amount_cents || !Number.isInteger(amount_cents)) {
      return res.status(400).json({ error: 'amount_cents must be a non-zero integer (negative to debit)' });
    }
    if (!username && !discord_id) return res.status(400).json({ error: 'username or discord_id is required' });

    const { rows: userRows } = await query(
      `SELECT id FROM web_users WHERE guild_id = $1 AND ${username ? 'lower(username) = lower($2)' : 'discord_id = $2'}`,
      [GUILD_ID, username || discord_id]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    // Refuse rather than pick one: nothing enforced uniqueness on discord_id,
    // so a second row could shadow the real account and quietly receive the
    // credit meant for it.
    if (userRows.length > 1) return res.status(409).json({ error: 'That identifier matches more than one account. Use user_id.' });
    const webUserId = userRows[0].id;

    const balanceCents = await applyBalanceDelta(webUserId, amount_cents, description, 'Manual adjustment');

    await logAdminAction(req, 'balance_adjust', webUserId, {
      amount_cents, description: description || null, balance_after_cents: balanceCents, via: 'api_secret',
    });

    res.json({ success: true, balance_cents: balanceCents, balance: balanceCents / 100 });
  } catch (err) {
    if (err && err.statusCode === 400) return res.status(400).json({ error: err.message });
    console.error('[Balance] Adjust error:', err);
    res.status(500).json({ error: 'Failed to adjust balance' });
  }
});

// ─── POST /api/balance/admin/adjust ──────────────────────
// Same as /adjust but gated by a logged-in admin/staff SESSION instead of the
// API_SECRET, so the website's admin panel can credit/debit a member's main
// site balance (the static site can never hold the secret). Looks the user up
// by web_users id, username, or discord_id; upserts the balances row so it
// works even for accounts that predate the signup balance seed.
router.post('/admin/adjust', requireOwnerAdmin, async (req, res) => {
  try {
    const { user_id, username, discord_id, amount_cents, description } = req.body;
    if (!amount_cents || !Number.isInteger(amount_cents)) {
      return res.status(400).json({ error: 'amount_cents must be a non-zero integer (negative to debit)' });
    }
    if (!user_id && !username && !discord_id) {
      return res.status(400).json({ error: 'user_id, username, or discord_id is required' });
    }

    let webUserId = user_id || null;
    if (!webUserId) {
      const { rows: userRows } = await query(
        `SELECT id FROM web_users WHERE guild_id = $1 AND ${username ? 'lower(username) = lower($2)' : 'discord_id = $2'}`,
        [GUILD_ID, username || discord_id]
      );
      if (!userRows.length) return res.status(404).json({ error: 'User not found' });
      if (userRows.length > 1) return res.status(409).json({ error: 'That identifier matches more than one account. Use user_id.' });
      webUserId = userRows[0].id;
    } else {
      const { rows: exists } = await query('SELECT id FROM web_users WHERE guild_id = $1 AND id = $2', [GUILD_ID, webUserId]);
      if (!exists.length) return res.status(404).json({ error: 'User not found' });
    }

    // Ensure a balances row exists (some accounts may predate the signup seed),
    // then apply the delta. A debit larger than the balance is refused outright
    // rather than clamped at zero — see applyBalanceDelta.
    const balanceCents = await applyBalanceDelta(webUserId, amount_cents, description, 'Admin adjustment');

    await logAdminAction(req, 'balance_adjust', webUserId, {
      amount_cents, description: description || null, balance_after_cents: balanceCents,
    });

    res.json({ success: true, balance_cents: balanceCents, balance: balanceCents / 100 });
  } catch (err) {
    if (err && err.statusCode === 400) return res.status(400).json({ error: err.message });
    console.error('[Balance] Admin adjust error:', err);
    res.status(500).json({ error: 'Failed to adjust balance' });
  }
});

module.exports = router;
