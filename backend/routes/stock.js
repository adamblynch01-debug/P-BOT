const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { getSessionUser, bearerToken, botAuthorized, botAuthUnavailable } = require('../utils/auth');
const { queueRestock } = require('../utils/restockNotify');
const GUILD_ID = process.env.GUILD_ID;

// Bot (secret) and admin panel (logged-in admin/staff session) both manage
// stock — same dual-gate pattern as routes/products.js. The static site can
// never hold API_SECRET, so its stock writes authenticate with the admin's
// session token instead.
async function isAuthorizedOrAdmin(req) {
  if (botAuthorized(req)) return true;
  const user = await getSessionUser(bearerToken(req));
  return !!(user && ['admin', 'staff'].includes(user.role));
}

// Who made this stock change — a named admin, or the bot when it authed with
// the shared secret.
async function stockActor(req) {
  if (botAuthorized(req)) return 'bot';
  const user = await getSessionUser(bearerToken(req));
  return (user && user.username) || 'unknown';
}

async function unusedCount(tierId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM product_stock WHERE guild_id = $1 AND tier_id = $2 AND used = false',
    [GUILD_ID, tierId]
  );
  return rows[0].n;
}

// Record a stock change. Never allowed to break the write it's auditing — a
// logging failure is logged and swallowed so restocking still succeeds.
async function logStockChange({ tierId, action, before, after, source, actor }) {
  try {
    const { rows } = await query(
      'SELECT p.name, t.label FROM product_tiers t JOIN products p ON p.id = t.product_id WHERE t.id = $1 AND t.guild_id = $2',
      [tierId, GUILD_ID]
    );
    const label = rows[0]
      ? (rows[0].label ? `${rows[0].name} (${rows[0].label})` : rows[0].name)
      : null;
    await query(
      `INSERT INTO stock_log (guild_id, tier_id, product_name, action, delta, count_before, count_after, source, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [GUILD_ID, tierId, label, action, after - before, before, after, source || null, actor || null]
    );
  } catch (err) {
    console.error('[Stock] log write failed (stock change still applied):', err.message);
  }
}

// ─── GET /api/stock/bulk?ids=1,2,3 ───────────────────────
// One round-trip stock lookup for the whole catalog, so the storefront can
// badge every tier without firing a request per card. Returns a map keyed by
// tier_id → available count (only tiers that HAVE unused rows appear; callers
// treat a missing id as 0). MUST be declared before '/:product_id' or Express
// routes "bulk" into the catch-all param.
router.get('/bulk', async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isInteger(n));
    if (!ids.length) return res.json({ stock: {} });
    const { rows } = await query(
      `SELECT tier_id, COUNT(*)::int AS n FROM product_stock
       WHERE guild_id = $1 AND used = false AND tier_id = ANY($2::int[])
       GROUP BY tier_id`,
      [GUILD_ID, ids]
    );
    const stock = {};
    for (const r of rows) stock[r.tier_id] = r.n;
    res.json({ stock });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bulk stock' });
  }
});

// ─── GET /api/stock/log ──────────────────────────────────
// Admin-only restock history. ?tier_id= narrows to one tier; ?limit= caps
// rows (default 100, max 500). Backs the panel's RESTOCK LOG view. MUST be
// declared before '/:product_id' or Express routes "log" into the catch-all.
router.get('/log', async (req, res) => {
  try {
    const user = await getSessionUser(bearerToken(req));
    if (!user || !['admin', 'staff'].includes(user.role)) return res.status(401).json({ error: 'Unauthorized' });
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const tierId = req.query.tier_id ? parseInt(req.query.tier_id, 10) : null;
    const { rows } = await query(
      `SELECT id, tier_id, product_name, action, delta, count_before, count_after, source, actor, created_at
       FROM stock_log
       WHERE guild_id = $1 AND ($2::bigint IS NULL OR tier_id = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [GUILD_ID, tierId, limit]
    );
    res.json({
      entries: rows.map(r => ({
        id: String(r.id), tier_id: r.tier_id != null ? String(r.tier_id) : null,
        product_name: r.product_name, action: r.action, delta: r.delta,
        count_before: r.count_before, count_after: r.count_after,
        source: r.source, actor: r.actor, created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[Stock] log read error:', err);
    res.status(500).json({ error: 'Failed to fetch stock log' });
  }
});

// Public: the storefront shows a stock badge on every card, so the count is not
// secret. It IS numeric though — `tier_id` is a BIGINT, and passing 'abc' made
// Postgres raise 22P02, which the catch turned into a 500. Anyone could drive
// unlimited 500s and error-log noise with a trivial loop. Validate the shape and
// answer 400 instead.
router.get('/:product_id', async (req, res) => {
  try {
    const id = String(req.params.product_id);
    if (!/^\d{1,19}$/.test(id)) {
      return res.status(400).json({ error: 'product_id must be a numeric tier id' });
    }
    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM product_stock WHERE guild_id = $1 AND tier_id = $2 AND used = false',
      [GUILD_ID, id]
    );
    res.json({ product_id: id, available: rows[0].n });
  } catch (err) {
    console.error('[Stock] count error:', err);
    res.status(500).json({ error: 'Failed to fetch stock' });
  }
});

// Caps so one request cannot insert an unbounded number of rows. `items` was
// used untyped and unbounded: a non-array crashed the loop, and 500k lines
// would have been inserted one statement at a time.
const MAX_STOCK_ITEMS = 10000;
const MAX_STOCK_VALUE_LEN = 512;

// Shared cleaner. Dedupes, because two identical rows for one tier means the
// same credential can be claimed and sold twice.
//
// `allowDuplicates` opts OUT of that, and is ONLY correct when the value is not
// a credential — a placeholder like OPEN-TICKET-IN-DISCORD that tells the buyer
// to open a ticket carries no secret, so handing the identical string to a
// hundred buyers is the intended behaviour rather than a double-sale. Under
// dedupe a hundred identical lines silently became one row, which is what made
// every manually-fulfilled product read LOW STOCK. Callers must ask for it
// explicitly; the default stays safe.
function cleanStockItems(items, allowDuplicates) {
  if (!Array.isArray(items)) return { error: 'items[] must be an array' };
  if (items.length > MAX_STOCK_ITEMS) return { error: `Too many items (max ${MAX_STOCK_ITEMS})` };
  const trimmed = items.map(v => String(v == null ? '' : v).trim())
                       .filter(v => v !== '' && v.length <= MAX_STOCK_VALUE_LEN);
  return { clean: allowDuplicates ? trimmed : Array.from(new Set(trimmed)) };
}

// Values already SOLD for this tier. Re-inserting one of these as unused is how
// a credential that has been delivered to a paying customer gets sold a second
// time — the vault path did exactly that, because the browser's mirror still
// held every key it had ever pasted, including the ones since claimed.
async function soldValues(tierId) {
  const { rows } = await query(
    'SELECT value FROM product_stock WHERE guild_id = $1 AND tier_id = $2 AND used = true',
    [GUILD_ID, tierId]
  );
  return new Set(rows.map(r => r.value));
}

router.post('/add', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { product_id, items, source, allow_duplicates, announce } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });

    const { clean, error } = cleanStockItems(items, allow_duplicates);
    if (error) return res.status(400).json({ error });

    // Same reasoning as the dedupe opt-out: a non-credential placeholder must
    // stay re-addable after the first one sells, or the tier can never be
    // restocked with it again.
    const sold = allow_duplicates ? new Set() : await soldValues(product_id);
    const toInsert = clean.filter(v => !sold.has(v));
    const skipped = clean.length - toInsert.length;

    const before = await unusedCount(product_id);
    if (toInsert.length) {
      await query(
        `INSERT INTO product_stock (guild_id, tier_id, value)
         SELECT $1, $2, v FROM unnest($3::text[]) AS v`,
        [GUILD_ID, product_id, toInsert]
      );
    }
    await logStockChange({
      tierId: product_id, action: 'add', before, after: before + toInsert.length,
      source, actor: await stockActor(req),
    });
    // Not awaited — the announcement batches on a timer and must never delay
    // or fail the restock it is reporting.
    queueRestock({ tierId: product_id, added: toInsert.length, announce: announce !== false });
    res.json({ success: true, added: toInsert.length, skipped_already_sold: skipped });
  } catch (err) {
    console.error('[Stock] add error:', err);
    res.status(500).json({ error: 'Failed to add stock' });
  }
});

// ─── POST /api/stock/set ─────────────────────────────────
// Replace the UNUSED stock for a tier with exactly `items` (used/claimed keys
// are preserved for order history). Lets the admin panel's "SAVE STOCK"
// textarea be the source of truth for available keys without holding secrets.
router.post('/set', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { product_id, items, source, allow_duplicates, announce } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });

    const { clean, error } = cleanStockItems(items, allow_duplicates);
    if (error) return res.status(400).json({ error });

    // Anti-resurrection. The vault admin panel posts the browser's whole mirror
    // of a tier, which still contains every key it ever held — including the
    // ones sold since. Without this filter a routine SAVE re-listed delivered
    // credentials as available, and the stock_log just read like a restock.
    // Bypassed only for explicit non-credential placeholders (see cleanStockItems).
    const sold = allow_duplicates ? new Set() : await soldValues(product_id);
    const toInsert = clean.filter(v => !sold.has(v));
    const skipped = clean.length - toInsert.length;
    if (skipped) {
      console.warn(`[Stock] set on tier ${product_id}: ignored ${skipped} already-sold key(s)`);
    }

    const before = await unusedCount(product_id);

    // One transaction. The DELETE used to commit on its own, so a failure
    // partway through the insert loop wiped the tier and left it partly
    // stocked, with the caller getting a 500 that said nothing about which.
    await withTransaction(async (exec) => {
      await exec('DELETE FROM product_stock WHERE guild_id = $1 AND tier_id = $2 AND used = false', [GUILD_ID, product_id]);
      if (toInsert.length) {
        await exec(
          `INSERT INTO product_stock (guild_id, tier_id, value)
           SELECT $1, $2, v FROM unnest($3::text[]) AS v`,
          [GUILD_ID, product_id, toInsert]
        );
      }
    });

    // A 'set' to zero is a deliberate wipe — log it as such so the history
    // distinguishes "cleared the tier" from "replaced the keys".
    if (before !== toInsert.length || toInsert.length === 0) {
      await logStockChange({
        tierId: product_id, action: toInsert.length === 0 ? 'clear' : 'set',
        before, after: toInsert.length, source, actor: await stockActor(req),
      });
    }
    // A 'set' is only a restock when it leaves MORE stock than it found. The
    // panel re-posts a tier's whole key list on every save, so announcing an
    // unchanged (or reduced) save would advertise a restock that never
    // happened — and 'clear' would advertise a wipe as good news.
    queueRestock({
      tierId: product_id, added: toInsert.length - before,
      announce: announce !== false,
    });
    res.json({ success: true, count: toInsert.length, skipped_already_sold: skipped });
  } catch (err) {
    console.error('[Stock] set error:', err);
    res.status(500).json({ error: 'Failed to set stock' });
  }
});

// ─── POST /api/stock/issue ───────────────────────────────
// Hand a key to a customer manually (the vault KEYGEN tab), marking it used in
// the SAME atomic claim the automatic delivery path uses.
//
// The vault keygen used to pull keys out of the browser's localStorage mirror
// and never tell the server. The row stayed used=false, so the next checkout
// for that tier claimed the very same credential and sold it again — two
// paying customers holding one account, with no trace in stock_log.
router.post('/issue', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { product_id, qty, note } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });
    const n = parseInt(qty, 10) || 1;
    if (n < 1 || n > 100) return res.status(400).json({ error: 'qty must be between 1 and 100' });

    const before = await unusedCount(product_id);
    const { rows } = await query(
      `UPDATE product_stock SET used = true, used_at = now()
       WHERE id IN (
         SELECT id FROM product_stock
         WHERE guild_id = $1 AND tier_id = $2 AND used = false
         ORDER BY id ASC LIMIT $3 FOR UPDATE SKIP LOCKED
       )
       RETURNING value`,
      [GUILD_ID, product_id, n]
    );
    if (!rows.length) return res.status(404).json({ error: 'Out of stock for that tier' });

    const actor = await stockActor(req);
    await logStockChange({
      tierId: product_id, action: 'issue', before, after: before - rows.length,
      source: note ? `manual: ${String(note).slice(0, 120)}` : 'manual issue', actor,
    });

    res.json({ success: true, issued: rows.length, items: rows.map(r => r.value) });
  } catch (err) {
    console.error('[Stock] issue error:', err);
    res.status(500).json({ error: 'Failed to issue stock' });
  }
});


// ─── GET /api/stock/list/:product_id ─────────────────────
// Admin-only readback of the UNUSED keys for a tier, so the panel's stock
// textarea can prefill with what's actually deliverable server-side.
router.get('/list/:product_id', async (req, res) => {
  try {
    const user = await getSessionUser(bearerToken(req));
    if (!user || !['admin', 'staff'].includes(user.role)) return res.status(401).json({ error: 'Unauthorized' });
    const { rows } = await query(
      'SELECT value FROM product_stock WHERE guild_id = $1 AND tier_id = $2 AND used = false ORDER BY id ASC',
      [GUILD_ID, req.params.product_id]
    );
    res.json({ product_id: req.params.product_id, items: rows.map(r => r.value) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list stock' });
  }
});

router.post('/claim', async (req, res) => {
  try {
    const { product_id, order_id } = req.body;
    if (botAuthUnavailable()) return res.status(503).json({ error: 'Server not configured' });
    if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

    // Atomic claim: lock+skip so concurrent deliveries can't hand out the
    // same key twice (mirrors the pattern SUPERBOT's own index.js already
    // uses for key issuance).
    const { rows } = await query(
      `UPDATE product_stock SET used = true, used_at = now(), order_id = $1
       WHERE id = (
         SELECT id FROM product_stock
         WHERE guild_id = $2 AND tier_id = $3 AND used = false
         ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING value`,
      [order_id, GUILD_ID, product_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Out of stock' });
    res.json({ success: true, value: rows[0].value });
  } catch (err) {
    res.status(500).json({ error: 'Failed to claim stock' });
  }
});

module.exports = router;
