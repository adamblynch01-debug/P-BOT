const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../utils/auth');

const GUILD_ID = process.env.GUILD_ID;

// ─── Entitlement-checked downloads ──────────────────────────────────
// The download link table lived in app_state under a 'public' ACL, so
//
//   curl https://<backend>/api/state/global/ghostDownloads
//
// returned the direct file URL for every product — including vault-exclusive
// ones — to anyone, with no account and no purchase. The client then read that
// table straight out of localStorage and opened the URL, so there was no point
// at which anything checked whether the visitor had actually bought it.
//
// The link table is admin-only now, and this route is the only way to reach a
// URL: it hands one back only if the caller has a delivered order for that
// product.
//
// NOTE: the URLs themselves are still whatever the admin pasted in. If those
// are public CDN links, anyone given one can reshare it — this closes the
// "anyone can enumerate every link" hole, not the "a customer can forward a
// link" one. Signed, expiring URLs from the storage provider are the fix for
// the latter, and that needs the storage side configured first.

async function linkTable(key) {
  const { rows } = await query(
    `SELECT value FROM app_state
      WHERE guild_id = $1 AND scope = 'global' AND owner_id = '' AND key = $2`,
    [GUILD_ID, key]
  );
  const v = rows.length ? rows[0].value : null;
  return v && typeof v === 'object' ? v : {};
}

// Does this account have a delivered order containing `name`?
// Matched against the order's own snapshot, which is what the customer
// actually bought, rather than anything the client claims.
async function hasEntitlement(webUserId, name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return false;

  const { rows } = await query(
    `SELECT items_snapshot, delivered_goods FROM orders
      WHERE guild_id = $1 AND web_user_id = $2 AND status IN ('delivered','paid')
      ORDER BY created_at DESC LIMIT 200`,
    [GUILD_ID, webUserId]
  );

  for (const r of rows) {
    const items = Array.isArray(r.items_snapshot) ? r.items_snapshot : [];
    for (const it of items) {
      const n = String((it && it.name) || '').toLowerCase();
      // The product name is the download key; a tier suffix like
      // "Ghost Pro (1 Month)" must still match the "Ghost Pro" download.
      if (n === target || n.startsWith(target + ' (') || n.includes(target)) return true;
    }
    const goods = Array.isArray(r.delivered_goods) ? r.delivered_goods : [];
    for (const g of goods) {
      const n = String((g && g.product) || '').toLowerCase();
      if (n === target || n.startsWith(target + ' (') || n.includes(target)) return true;
    }
  }
  return false;
}

// ─── GET /api/downloads/:name ───────────────────────────
router.get('/:name', requireAuth, async (req, res) => {
  try {
    const name = String(req.params.name || '');
    const isAdmin = ['admin', 'staff'].includes(req.user.role);

    if (!isAdmin && !(await hasEntitlement(req.user.id, name))) {
      // 403 rather than 404: the product list is public, so hiding existence
      // buys nothing, and a clear message avoids a support ticket.
      return res.status(403).json({ error: 'You do not have a completed order for this product.' });
    }

    const main = await linkTable('ghostDownloads');
    const vault = await linkTable('ghostVaultDownloads');
    const entry = main[name] || vault[name] || null;
    if (!entry || !entry.link) {
      return res.status(404).json({ error: 'No download has been published for this product yet.' });
    }

    res.json({
      name,
      url: entry.link,
      version: entry.version || null,
      updated: entry.updated || null,
      instructions: entry.instructions || null,
    });
  } catch (err) {
    console.error('[Downloads] error:', err);
    res.status(500).json({ error: 'Failed to fetch download' });
  }
});

// ─── GET /api/downloads ─────────────────────────────────
// What this account may download. Metadata only — no URLs, so the list can be
// rendered without handing out every link.
router.get('/', requireAuth, async (req, res) => {
  try {
    const isAdmin = ['admin', 'staff'].includes(req.user.role);
    const main = await linkTable('ghostDownloads');
    const vault = await linkTable('ghostVaultDownloads');
    const all = { ...main, ...vault };

    const out = [];
    for (const [name, entry] of Object.entries(all)) {
      if (!entry || !entry.link) continue;
      if (!isAdmin && !(await hasEntitlement(req.user.id, name))) continue;
      out.push({
        name,
        version: entry.version || null,
        updated: entry.updated || null,
        instructions: entry.instructions || null,
      });
    }
    res.json({ downloads: out });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list downloads' });
  }
});

module.exports = router;
