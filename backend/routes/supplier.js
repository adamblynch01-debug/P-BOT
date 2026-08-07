// ─── Supplier links: view, edit, remove, toggle ──────────────────────────────
// The admin surface for the upstream reseller. Everything the panel needs is
// here, because the requirement was explicit: options for the API + a toggle to
// turn them off + view, edit, remove, ALL from the website admin panel.
//
// Two rules hold throughout, and both are load-bearing:
//
//   1. NO ROUTE HERE EVER RETURNS THE API KEY, or anything derived from it.
//      `key_configured: true/false` is the whole of what the panel is told.
//      Everything that could carry it — an axios error message, a stored
//      last_error, an upstream body — goes through supplier.redact() first.
//      The key spends money; a panel that leaks it into a browser is a panel
//      that leaks it into every browser extension and screenshot.
//
//   2. THERE IS NO "TEST THIS LINK" BUTTON, and there must never be. Their
//      deliver endpoint charges the balance and consumes inventory on the GET.
//      A test button is a purchase button with a misleading label. See
//      migrations/supplier_links.sql.
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAdmin, requireOwnerAdmin } = require('../utils/auth');
const supplier = require('../utils/supplier');

const GUILD_ID = process.env.GUILD_ID;

// Reading and editing the mapping is a catalog edit, so requireAdmin (which
// accepts 'staff'). Throwing the global switch is not — see /kill.
const canEdit = requireAdmin;

function publicLink(row) {
  return {
    id: Number(row.id),
    tier_id: Number(row.tier_id),
    supplier: row.supplier,
    supplier_product_id: row.supplier_product_id,
    label: row.label || null,
    cost_cents: row.cost_cents != null ? Number(row.cost_cents) : null,
    enabled: !!row.enabled,
    qty_per_unit: Number(row.qty_per_unit || 1),
    last_ok_at: row.last_ok_at || null,
    // Already redacted on the way in; redacted again on the way out because a
    // row could have been written by hand or by an older build.
    last_error: row.last_error ? supplier.redact(row.last_error) : null,
    last_error_at: row.last_error_at || null,
    // Joined, so the panel can show "Call of Duty: Warzone → Ancient → Day"
    // instead of a bare tier id nobody can identify.
    game_name: row.game_name || null,
    product_name: row.product_name || null,
    tier_label: row.tier_label || null,
    tier_price_cents: row.tier_price_cents != null ? Number(row.tier_price_cents) : null,
  };
}

const LINK_SELECT = `
  SELECT sl.*, p.game_name, p.name AS product_name,
         t.label AS tier_label, t.price_cents AS tier_price_cents
    FROM supplier_links sl
    LEFT JOIN product_tiers t ON t.id = sl.tier_id
    LEFT JOIN products p ON p.id = t.product_id
   WHERE sl.guild_id = $1`;

// A missing table is not an error to the panel — it is "the migration has not
// been run yet", which the panel says out loud rather than showing a 500.
function isMissingTable(err) { return err && err.code === '42P01'; }

// ─── GET /api/supplier/links ─────────────────────────────
// The list, plus the global state the header renders. One call, because the
// panel needs both to draw anything honest: a list of enabled links above a
// header that does not say the switch is off is a lie.
router.get('/links', canEdit, async (req, res) => {
  try {
    const { rows } = await query(LINK_SELECT + ' ORDER BY p.game_name ASC, p.name ASC, t.sort_order ASC', [GUILD_ID]);
    res.json({
      links: rows.map(publicLink),
      // Whether it is SET, never what it is. Per supplier, because with two of
      // them one missing key does not mean "nothing can be bought" — it means
      // that supplier's links are bypassed and the other's are not, and the
      // panel has to be able to say which.
      suppliers: supplier.providerSummary(),
      key_configured: supplier.hasApiKey(),
      supplier_off: supplier.supplierGloballyOff(),
      migrated: true,
    });
  } catch (err) {
    if (isMissingTable(err)) {
      return res.json({
        links: [], suppliers: supplier.providerSummary(), key_configured: supplier.hasApiKey(),
        supplier_off: supplier.supplierGloballyOff(), migrated: false,
        notice: 'Run backend/migrations/supplier_links.sql — the supplier tables do not exist yet.',
      });
    }
    console.error('[Supplier] list error:', supplier.redact(err.message));
    res.status(500).json({ error: 'Failed to load supplier links' });
  }
});

// ─── POST /api/supplier/links ────────────────────────────
// Create or update by tier_id. Upsert rather than create-then-fail: the panel's
// add form and its edit form are the same form, and a UNIQUE violation on a
// second mapping of the same tier is not information the admin can act on.
router.post('/links', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const tierId = parseInt(b.tier_id, 10);
    if (!Number.isFinite(tierId)) return res.status(400).json({ error: 'tier_id is required' });

    const pid = String(b.supplier_product_id == null ? '' : b.supplier_product_id).trim();
    // The one field where a typo sells the wrong product at the wrong price to
    // a paying customer, and there is no way to test it without buying one. So
    // it is refused empty rather than stored as ''.
    if (!pid) return res.status(400).json({ error: "The supplier's product id is required" });

    // The tier has to exist and be ours. Without this an admin could map a tier
    // id from another guild and the delivery path would honour it.
    const { rows: tierRows } = await query(
      'SELECT id FROM product_tiers WHERE id = $1 AND guild_id = $2', [tierId, GUILD_ID]);
    if (!tierRows.length) return res.status(404).json({ error: 'That pricing tier does not exist' });

    const cost = b.cost_cents != null && b.cost_cents !== ''
      ? Math.round(Number(b.cost_cents))
      : (b.cost != null && b.cost !== '' ? Math.round(parseFloat(b.cost) * 100) : null);
    if (cost != null && !Number.isFinite(cost)) return res.status(400).json({ error: 'Cost must be a number' });

    const qty = b.qty_per_unit != null && b.qty_per_unit !== '' ? parseInt(b.qty_per_unit, 10) : 1;
    if (!Number.isFinite(qty) || qty < 1) return res.status(400).json({ error: 'Units per purchase must be 1 or more' });

    // Refused rather than stored, because an unrecognised supplier name is a
    // link that will never buy anything and will never say why: linkForTier
    // silently drops it back to local stock, which looks exactly like a working
    // shop until the day the local pool runs dry.
    const supName = String(b.supplier || supplier.DEFAULT_SUPPLIER).trim().toLowerCase();
    if (!supplier.providerFor(supName)) {
      return res.status(400).json({
        error: `Unknown supplier "${supName}". This build can buy from: ${supplier.providerNames().join(', ')}.`,
      });
    }

    const { rows } = await query(
      `INSERT INTO supplier_links
         (guild_id, tier_id, supplier, supplier_product_id, label, cost_cents, enabled, qty_per_unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tier_id) DO UPDATE SET
         supplier = EXCLUDED.supplier,
         supplier_product_id = EXCLUDED.supplier_product_id,
         label = EXCLUDED.label,
         cost_cents = EXCLUDED.cost_cents,
         enabled = EXCLUDED.enabled,
         qty_per_unit = EXCLUDED.qty_per_unit,
         updated_at = now()
       RETURNING id`,
      [GUILD_ID, tierId, supName, pid,
       b.label ? String(b.label).slice(0, 200) : null, cost,
       b.enabled === undefined ? true : !!b.enabled, qty]
    );

    const { rows: full } = await query(LINK_SELECT + ' AND sl.id = $2', [GUILD_ID, rows[0].id]);
    console.log(`[Supplier] link for tier ${tierId} → ${supName} product ${pid} saved by ${req.user.username || req.user.id}`);
    res.json({ success: true, link: publicLink(full[0]) });
  } catch (err) {
    if (isMissingTable(err)) return res.status(503).json({ error: 'Run backend/migrations/supplier_links.sql first' });
    console.error('[Supplier] save error:', supplier.redact(err.message));
    res.status(500).json({ error: 'Failed to save that supplier link' });
  }
});

// ─── PATCH /api/supplier/links/:id ───────────────────────
// Partial edit. Every field is COALESCEd onto itself, so a caller changing the
// cost cannot silently re-point the link at a different upstream product.
router.patch('/links/:id', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const pid = b.supplier_product_id != null ? String(b.supplier_product_id).trim() : null;
    if (b.supplier_product_id != null && !pid) {
      return res.status(400).json({ error: "The supplier's product id cannot be blank" });
    }
    const cost = b.cost_cents != null && b.cost_cents !== '' ? Math.round(Number(b.cost_cents)) : null;
    const qty = b.qty_per_unit != null && b.qty_per_unit !== '' ? parseInt(b.qty_per_unit, 10) : null;
    if (qty != null && (!Number.isFinite(qty) || qty < 1)) {
      return res.status(400).json({ error: 'Units per purchase must be 1 or more' });
    }

    // Moving a link between suppliers is a real edit and has to be possible —
    // the same cheat is often listed by both. Validated to the same list as
    // POST, and COALESCEd like everything else so an unrelated edit cannot
    // re-point it.
    let supName = null;
    if (b.supplier != null && String(b.supplier).trim() !== '') {
      supName = String(b.supplier).trim().toLowerCase();
      if (!supplier.providerFor(supName)) {
        return res.status(400).json({
          error: `Unknown supplier "${supName}". This build can buy from: ${supplier.providerNames().join(', ')}.`,
        });
      }
    }

    const { rows } = await query(
      `UPDATE supplier_links SET
         supplier_product_id = COALESCE($1, supplier_product_id),
         label               = COALESCE($2, label),
         cost_cents          = COALESCE($3, cost_cents),
         enabled             = COALESCE($4, enabled),
         qty_per_unit        = COALESCE($5, qty_per_unit),
         supplier            = COALESCE($8, supplier),
         updated_at = now()
       WHERE id = $6 AND guild_id = $7
       RETURNING id`,
      [pid, b.label != null ? String(b.label).slice(0, 200) : null,
       cost != null && Number.isFinite(cost) ? cost : null,
       b.enabled === undefined ? null : !!b.enabled, qty,
       req.params.id, GUILD_ID, supName]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such supplier link' });

    const { rows: full } = await query(LINK_SELECT + ' AND sl.id = $2', [GUILD_ID, rows[0].id]);
    res.json({ success: true, link: publicLink(full[0]) });
  } catch (err) {
    if (isMissingTable(err)) return res.status(503).json({ error: 'Run backend/migrations/supplier_links.sql first' });
    console.error('[Supplier] patch error:', supplier.redact(err.message));
    res.status(500).json({ error: 'Failed to update that supplier link' });
  }
});

// ─── POST /api/supplier/links/:id/toggle ─────────────────
// The per-link switch, and the reason this integration is safe to run at all:
// off falls that tier straight back to our own key pool, so a drained balance
// or a supplier having a bad day is a shop that keeps selling rather than a
// queue of failed deliveries.
router.post('/links/:id/toggle', canEdit, async (req, res) => {
  try {
    const want = req.body && req.body.enabled !== undefined ? !!req.body.enabled : null;
    const { rows } = await query(
      // NOT NULL column, so `COALESCE($1, NOT enabled)` reads as "set it to
      // what I said, or flip it if I said nothing" — the panel sends a value,
      // a quick curl during an incident does not have to.
      `UPDATE supplier_links SET enabled = COALESCE($1, NOT enabled), updated_at = now()
        WHERE id = $2 AND guild_id = $3 RETURNING id, enabled`,
      [want, req.params.id, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such supplier link' });
    console.log(`[Supplier] link ${rows[0].id} switched ${rows[0].enabled ? 'ON' : 'OFF'} by ${req.user.username || req.user.id}`);
    res.json({ success: true, id: Number(rows[0].id), enabled: !!rows[0].enabled });
  } catch (err) {
    if (isMissingTable(err)) return res.status(503).json({ error: 'Run backend/migrations/supplier_links.sql first' });
    console.error('[Supplier] toggle error:', supplier.redact(err.message));
    res.status(500).json({ error: 'Failed to switch that link' });
  }
});

// ─── DELETE /api/supplier/links/:id ──────────────────────
// Removes the MAPPING only. It does not touch the tier, its keys or its orders,
// and it does not touch supplier_deliveries — those rows are the only record
// that money was spent upstream and must outlive the link that spent it.
router.delete('/links/:id', canEdit, async (req, res) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM supplier_links WHERE id = $1 AND guild_id = $2', [req.params.id, GUILD_ID]);
    // Not a 404 on zero rows: "this tier no longer buys from the supplier" is
    // the outcome asked for, and it is already true.
    res.json({ success: true, removed: rowCount });
  } catch (err) {
    if (isMissingTable(err)) return res.status(503).json({ error: 'Run backend/migrations/supplier_links.sql first' });
    console.error('[Supplier] delete error:', supplier.redact(err.message));
    res.status(500).json({ error: 'Failed to remove that supplier link' });
  }
});

// ─── POST /api/supplier/kill ─────────────────────────────
// The global switch. requireOwnerAdmin, NOT requireAdmin — requireAdmin accepts
// 'staff', and this decides whether the business spends money on every sale.
// Same split as the payment kill switch for the same reason: staff arrange the
// shelves, owners stop the spending.
//
// Stored on the `config` table (no migration) so it survives a restart via the
// boot loader, exactly like PAYMENT_METHODS_OFF.
router.post('/kill', requireOwnerAdmin, async (req, res) => {
  try {
    const off = !!(req.body && req.body.off);
    const value = off ? '1' : '';
    await query(
      `INSERT INTO config (guild_id, key, value, updated_at) VALUES ($1,'SUPPLIER_OFF',$2, now())
       ON CONFLICT (guild_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [GUILD_ID, value]
    );
    process.env.SUPPLIER_OFF = value;
    console.log(`[Supplier] GLOBAL supplier buying switched ${off ? 'OFF' : 'ON'} by ${req.user.username || req.user.id}`);
    res.json({
      success: true, supplier_off: supplier.supplierGloballyOff(),
      note: off
        ? 'Every supplier link is now bypassed. Those tiers sell from local stock.'
        : 'Supplier links are live again — enabled links will buy upstream on the next sale.',
    });
  } catch (err) {
    console.error('[Supplier] kill switch error:', supplier.redact(err.message));
    res.status(500).json({ error: 'Failed to change the supplier switch' });
  }
});

// ─── GET /api/supplier/deliveries ────────────────────────
// The log. This is the ONLY record that a charge happened — their API has no
// history endpoint — so it is what a lost key is re-issued from and what their
// invoice is reconciled against.
//
// ?order_id= for one order, ?status=pending for the incident query: everything
// we may have been charged for and never got an answer about.
router.get('/deliveries', canEdit, async (req, res) => {
  try {
    const where = ['guild_id = $1'];
    const params = [GUILD_ID];
    if (req.query.order_id) { params.push(String(req.query.order_id)); where.push(`order_id = $${params.length}`); }
    if (req.query.status)   { params.push(String(req.query.status));   where.push(`status = $${params.length}`); }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const { rows } = await query(
      `SELECT * FROM supplier_deliveries WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT ${limit}`, params);

    res.json({
      deliveries: rows.map(r => ({
        id: Number(r.id), order_id: r.order_id, tier_id: r.tier_id != null ? Number(r.tier_id) : null,
        // Which upstream was charged. With two of them, a log line that does not
        // say is a log line nobody can reconcile against an invoice.
        supplier: r.supplier || null,
        supplier_product_id: r.supplier_product_id, qty: Number(r.qty || 1),
        status: r.status, buyer_ref: r.buyer_ref,
        // The keys themselves. Deliberately included: re-issuing a lost key is
        // the reason this table exists, and this route is admin-gated.
        response_lines: r.response_lines || null,
        error_text: r.error_text ? supplier.redact(r.error_text) : null,
        cost_cents: r.cost_cents != null ? Number(r.cost_cents) : null,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    if (isMissingTable(err)) return res.json({ deliveries: [], migrated: false });
    console.error('[Supplier] deliveries error:', supplier.redact(err.message));
    res.status(500).json({ error: 'Failed to load the supplier delivery log' });
  }
});

module.exports = router;
