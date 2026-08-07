const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { requireAdmin, getSessionUser, bearerToken, botAuthorized } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

function isAuthorized(req) {
  return botAuthorized(req);
}

// Bot (secret) and admin panel (logged-in admin/staff session) both manage
// the catalog — same dual-gate pattern as routes/status.js.
async function isAuthorizedOrAdmin(req) {
  if (isAuthorized(req)) return true;
  const user = await getSessionUser(bearerToken(req));
  return !!(user && ['admin', 'staff'].includes(user.role));
}

// Deletion is the one thing 'staff' must not have.
//
// The staff panel is a VIEW of the admin panel with the destructive controls
// hidden — but a hidden button is not a permission, and the check above admits
// 'staff' so moderators can edit the catalog. That made DELETE /product/:id and
// DELETE /:id reachable by any staff account with devtools open, and neither is
// recoverable from the panel: the first drops a product row, the second drops a
// price tier along with whatever ordered against it.
//
// The bot keeps its API_SECRET path. That is the store's own automation running
// on a secret no person is handed, not a moderator.
async function isOwnerAdminOrBot(req) {
  if (isAuthorized(req)) return true;
  const user = await getSessionUser(bearerToken(req));
  return !!(user && user.role === 'admin');
}

// This API predates the unified schema's products/product_tiers split — the
// live site's checkout never calls it (it ships its own embedded catalog),
// so it's kept working but adapted minimally: a "product" here is really a
// priced tier (product_tiers row) joined with its parent product for context.

// Shared catalog projection so GET / (main) and GET /vault return the exact
// same shape; only the `vault` filter differs.
function mapCatalogRow(r) {
  return {
    id: r.id,
    product_id: r.product_id,
    tier_label: r.label,
    tier_period: r.period,
    name: r.label ? `${r.name} (${r.label})` : r.name,
    product_name: r.name,
    subtitle: r.subtitle,
    description: r.description || `${r.game_name}${r.label ? ' — ' + r.label : ''}`,
    price: r.price_cents != null ? r.price_cents / 100 : null,
    category: r.game_name,
    tag: r.tag,
    specs: r.specs,
    platforms: r.platforms,
    spoofer: r.spoofer,
    sections: r.sections,
    media: r.media,
    tab: r.tab,
    dropdown: r.dropdown,
    status: r.status,
    stock_type: r.stock_type,
    delivery_type: r.delivery_type,
    active: !r.hidden,
  };
}

const CATALOG_SELECT =
  `SELECT t.id, t.label, t.price_cents, t.period, t.stock_type, t.delivery_type, t.sort_order AS tier_sort,
          p.id AS product_id, p.name, p.game_name, p.subtitle, p.description,
          p.tag, p.specs, p.platforms, p.spoofer, p.sections, p.media,
          p.tab, p.dropdown, p.status, p.hidden
   FROM products p
   LEFT JOIN product_tiers t ON t.product_id = p.id
   WHERE p.guild_id = $1 AND p.hidden = false AND p.vault = $2
   ORDER BY p.sort_order DESC, t.sort_order ASC`;

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(CATALOG_SELECT, [GUILD_ID, false]);
    res.json(rows.map(mapCatalogRow));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// ─── GET /api/products/vault ─────────────────────────────
// Same shape as GET /, but the vault side of the catalog (vault = true).
// Public read (statuses/prices/stock aren't secret; purchase is still gated by
// a logged-in balance checkout).
router.get('/vault', async (req, res) => {
  try {
    const { rows } = await query(CATALOG_SELECT, [GUILD_ID, true]);
    res.json(rows.map(mapCatalogRow));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch vault products' });
  }
});

// ─── GET /api/products/admin/all ─────────────────────────
// Full catalog including hidden products, grouped with all their tiers —
// what the admin panel's product manager reads/writes against.
router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    const { rows: products } = await query(
      `SELECT * FROM products WHERE guild_id = $1 ORDER BY sort_order DESC, created_at DESC`,
      [GUILD_ID]
    );
    const { rows: tiers } = await query(
      `SELECT * FROM product_tiers WHERE guild_id = $1 ORDER BY sort_order ASC`,
      [GUILD_ID]
    );
    const byProduct = {};
    for (const t of tiers) {
      (byProduct[t.product_id] ||= []).push(t);
    }
    res.json({
      products: products.map(p => ({ ...p, tiers: byProduct[p.id] || [] })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin product list' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, p.name, p.game_name
       FROM product_tiers t JOIN products p ON p.id = t.product_id
       WHERE t.id = $1 AND t.guild_id = $2`,
      [req.params.id, GUILD_ID]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Product not found' });
    res.json({
      id: r.id,
      name: `${r.name} (${r.label})`,
      price: r.price_cents / 100,
      category: r.game_name,
      stock_type: r.stock_type,
      delivery_type: r.delivery_type,
    });
  } catch (err) {
    res.status(404).json({ error: 'Product not found' });
  }
});

// ─── POST /api/products/new ──────────────────────────────
// Creates a parent product row. sort_order defaults to current max + 1 so
// new products show at the TOP of the storefront (GET / orders DESC).
router.post('/new', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { game_name, name, subtitle, description, tag, specs, platforms, spoofer, sections, media, tab, dropdown, status, vault } = req.body;
    if (!game_name || !name) return res.status(400).json({ error: 'game_name and name are required' });

    const { rows: maxRows } = await query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM products WHERE guild_id = $1',
      [GUILD_ID]
    );
    const { rows } = await query(
      `INSERT INTO products (guild_id, game_name, name, subtitle, description, tag, specs, platforms, spoofer, sections, media, tab, dropdown, status, vault, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        GUILD_ID, game_name, name, subtitle || null, description || null, tag || null,
        specs || null, platforms || null, !!spoofer,
        JSON.stringify(sections || []), JSON.stringify(media || {}),
        tab || null, dropdown ? JSON.stringify(dropdown) : null,
        status || 'undetected', !!vault, maxRows[0].next,
      ]
    );
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    console.error('[Products] Create product error:', err);
    // A duplicate (guild, game_name, name[, vault]) is an admin-correctable
    // mistake, not a server fault — say so instead of a blank 500.
    if (err.code === '23505') {
      return res.status(409).json({
        error: `A product named "${req.body.name}" already exists under "${req.body.game_name}"` +
               (req.body.vault ? ' in the vault.' : '.'),
      });
    }
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// ─── PATCH /api/products/product/:id ─────────────────────
// Edits the parent product (hide/show, re-sort, rename, status, media, etc).
router.patch('/product/:id', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { game_name, name, subtitle, description, tag, specs, platforms, spoofer, sections, media, tab, dropdown, status, hidden, sort_order, vault } = req.body;
    // `tab` (subtab / game-title) must be clearable, not just settable. COALESCE
    // can never write NULL, so an admin moving a product back to "no subtab"
    // could never un-assign it. When the caller includes a `tab` key we honor it
    // verbatim (empty string → NULL); when the key is absent we keep the column.
    const tabProvided = Object.prototype.hasOwnProperty.call(req.body, 'tab');
    const tabValue = tab ? tab : null;
    const { rows } = await query(
      `UPDATE products SET
         game_name   = COALESCE($1, game_name),
         name        = COALESCE($2, name),
         subtitle    = COALESCE($3, subtitle),
         description = COALESCE($4, description),
         tag         = COALESCE($5, tag),
         specs       = COALESCE($6, specs),
         platforms   = COALESCE($7, platforms),
         spoofer     = COALESCE($8, spoofer),
         sections    = COALESCE($9, sections),
         media       = COALESCE($10, media),
         tab         = CASE WHEN $11 THEN $12 ELSE tab END,
         dropdown    = COALESCE($13, dropdown),
         status      = COALESCE($14, status),
         hidden      = COALESCE($15, hidden),
         sort_order  = COALESCE($16, sort_order),
         vault       = COALESCE($19, vault),
         updated_at  = now()
       WHERE id = $17 AND guild_id = $18
       RETURNING *`,
      [
        game_name || null, name || null, subtitle || null, description || null,
        tag || null, specs || null, platforms || null,
        spoofer != null ? !!spoofer : null,
        sections ? JSON.stringify(sections) : null,
        media ? JSON.stringify(media) : null,
        tabProvided, tabValue,
        dropdown ? JSON.stringify(dropdown) : null,
        status || null, hidden != null ? !!hidden : null, sort_order != null ? sort_order : null,
        req.params.id, GUILD_ID,
        vault != null ? !!vault : null,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    console.error('[Products] Update product error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// ─── DELETE /api/products/product/:id ────────────────────
// Owner admin (or the bot) only — see isOwnerAdminOrBot. Dropping a product
// takes its tiers with it.
router.delete('/product/:id', async (req, res) => {
  try {
    if (!(await isOwnerAdminOrBot(req))) return res.status(403).json({ error: 'Owner admin only' });
    await query('DELETE FROM products WHERE id = $1 AND guild_id = $2', [req.params.id, GUILD_ID]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ─── POST /api/products/reorder ──────────────────────────
// Reorders the products inside ONE game_name, from a list of ids in the order
// the admin dragged them into. First in the list renders first.
//
// It is a PERMUTATION, not a renumber, and that is the whole design:
// `products.sort_order` is **global across the guild, not per-category** — every
// product in every category draws from one number line, and POST /new hands out
// MAX+1. So writing 0..N-1 over one category would drop the whole category
// underneath every other one. Instead the values those rows already hold are
// collected, sorted descending (CATALOG_SELECT reads DESC), and dealt back out
// in the new order. The multiset of numbers is unchanged, so nothing outside
// this category can move — provable, rather than hoped for.
//
// ⚠ For a TABBED category the sub-tab bar is first-appearance order over this
// same sort, so the tab that opens by default is whichever tab owns the top
// product. Moving a FiveM product to the top of GTA V makes FiveM the default
// tab. That is what "put this first" means, but the panel warns before saving.
router.post('/reorder', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const gameName = String(req.body.game_name || '').trim();
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : null;
    if (!gameName) return res.status(400).json({ error: 'game_name is required' });
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
    if (ids.some(n => !Number.isFinite(n))) return res.status(400).json({ error: 'ids must all be numbers' });
    if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'ids contains a duplicate' });

    const out = await withTransaction(async (client) => {
      // Locked for the read: two admins dragging at once would otherwise each
      // compute a permutation of the values they saw and the second would write
      // a set of numbers that no longer matches the rows.
      const { rows } = await client.query(
        `SELECT id, sort_order FROM products
          WHERE guild_id = $1 AND game_name = $2
          FOR UPDATE`,
        [GUILD_ID, gameName]
      );
      // A partial list is how a category ends up scrambled — half permuted and
      // half where it was. Refuse it rather than guess what the admin meant.
      const have = new Set(rows.map(r => Number(r.id)));
      const missing = rows.filter(r => !ids.includes(Number(r.id))).map(r => Number(r.id));
      const foreign = ids.filter(id => !have.has(id));
      if (foreign.length) return { error: `Not in "${gameName}": ${foreign.join(', ')}` };
      if (missing.length) return { error: `Missing from the new order: ${missing.join(', ')}` };

      const slots = rows.map(r => Number(r.sort_order)).sort((a, b) => b - a);
      for (let i = 0; i < ids.length; i++) {
        await client.query(
          'UPDATE products SET sort_order = $1, updated_at = now() WHERE id = $2 AND guild_id = $3',
          [slots[i], ids[i], GUILD_ID]
        );
      }
      return { order: ids.map((id, i) => ({ id, sort_order: slots[i] })) };
    });

    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('[Products] Reorder error:', err);
    res.status(500).json({ error: 'Failed to save that order' });
  }
});

// ─── POST /api/products/tiers/reorder ────────────────────
// Same permutation rule one level down: the price buttons inside one product.
//
// Tier order reads ASC (CATALOG_SELECT ends `t.sort_order ASC`), so the slots
// are dealt ascending here — the opposite of the products above, and the reason
// the two are not one shared helper.
//
// Unlike products, tier sort_order is per-product in practice AND almost always
// all-zero: every tier created through the panel or an importer lands on 0,
// which is why an imported product renders Lifetime above Day. When the values
// collide like that a permutation cannot express anything, so this route
// renumbers 0..N-1 instead. Safe here precisely because the column is scoped to
// the parent product and nothing else reads it.
router.post('/tiers/reorder', async (req, res) => {
  try {
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const productId = Number(req.body.product_id);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : null;
    if (!Number.isFinite(productId)) return res.status(400).json({ error: 'product_id is required' });
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
    if (ids.some(n => !Number.isFinite(n))) return res.status(400).json({ error: 'ids must all be numbers' });
    if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'ids contains a duplicate' });

    const out = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM product_tiers
          WHERE guild_id = $1 AND product_id = $2
          FOR UPDATE`,
        [GUILD_ID, productId]
      );
      const have = new Set(rows.map(r => Number(r.id)));
      const foreign = ids.filter(id => !have.has(id));
      const missing = rows.filter(r => !ids.includes(Number(r.id))).map(r => Number(r.id));
      if (foreign.length) return { error: `Not tiers of product ${productId}: ${foreign.join(', ')}` };
      if (missing.length) return { error: `Missing from the new order: ${missing.join(', ')}` };

      for (let i = 0; i < ids.length; i++) {
        await client.query(
          'UPDATE product_tiers SET sort_order = $1 WHERE id = $2 AND guild_id = $3',
          [i, ids[i], GUILD_ID]
        );
      }
      return { order: ids.map((id, i) => ({ id, sort_order: i })) };
    });

    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('[Products] Tier reorder error:', err);
    res.status(500).json({ error: 'Failed to save that tier order' });
  }
});

// Creates a pricing tier under an existing product — create the parent
// product row (in the `products` table) first; this endpoint only manages
// tiers/pricing, matching what p-bot's flat model called a "product".
router.post('/', async (req, res) => {
  try {
    const { secret, product_id, name, price, period, stock_type, delivery_type, sort_order } = req.body;
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    // Explicit, or the next free slot under this product. It used to be the
    // column default — 0 for every tier — so the storefront's
    // `ORDER BY t.sort_order ASC` had nothing to order by and the price buttons
    // came out in whatever order Postgres felt like. Flagged 31 July.
    let order = sort_order != null && Number.isFinite(Number(sort_order)) ? Number(sort_order) : null;
    if (order == null) {
      const { rows: mx } = await query(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM product_tiers WHERE guild_id = $1 AND product_id = $2',
        [GUILD_ID, product_id]
      );
      order = Number(mx[0].next);
    }
    const { rows } = await query(
      `INSERT INTO product_tiers (product_id, guild_id, label, price_cents, period, stock_type, delivery_type, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [product_id, GUILD_ID, name, Math.round(parseFloat(price) * 100), period || null, stock_type || 'auto', delivery_type || 'auto', order]
    );
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    console.error('[Products] Create tier error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: `Tier "${req.body.name}" already exists on that product.` });
    }
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { secret, name, price, period, stock_type, delivery_type, sort_order } = req.body;
    if (!(await isAuthorizedOrAdmin(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { rows } = await query(
      `UPDATE product_tiers SET
         label = COALESCE($1, label),
         price_cents = COALESCE($2, price_cents),
         period = COALESCE($3, period),
         stock_type = COALESCE($4, stock_type),
         delivery_type = COALESCE($5, delivery_type),
         sort_order = COALESCE($8, sort_order)
       WHERE id = $6 AND guild_id = $7
       RETURNING *`,
      [
        name || null,
        price != null ? Math.round(parseFloat(price) * 100) : null,
        period || null,
        stock_type || null, delivery_type || null,
        req.params.id, GUILD_ID,
        // COALESCE, so omitting it keeps the row's order. A caller that only
        // means to reprice must not silently reshuffle the price buttons.
        sort_order != null && Number.isFinite(Number(sort_order)) ? Number(sort_order) : null,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// ─── DELETE /api/products/:id ────────────────────────────
// Deletes a single pricing tier (not the parent product). Owner admin or bot
// only — a tier is what orders reference.
router.delete('/:id', async (req, res) => {
  try {
    const { secret } = req.body;
    if (!(await isOwnerAdminOrBot(req))) return res.status(403).json({ error: 'Owner admin only' });
    await query('DELETE FROM product_tiers WHERE id = $1 AND guild_id = $2', [req.params.id, GUILD_ID]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete tier' });
  }
});

module.exports = router;
