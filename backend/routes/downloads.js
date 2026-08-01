const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth, botAuthorized, botAuthUnavailable } = require('../utils/auth');

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

// ─── Bot-authenticated link table ───────────────────────
//
// The Discord bot kept its OWN copy of the download links: a hardcoded list of
// 62 products in modules/downloads.js, overridden from download_urls.json next
// to the code. Two problems, both of which this closes.
//
//   1. It was a second source of truth. A link updated in the site's Downloads
//      Manager did not reach /downloads in Discord, and /setdownload did not
//      reach the site. Same product, two answers, and no way to tell which was
//      current.
//   2. That JSON file sits on the container filesystem, which Railway replaces
//      on every deploy. Unless DATA_DIR points at a mounted volume, every link
//      set with /setdownload was lost at the next push — "those links should be
//      stored aswell".
//
// Both sides now read and write the same app_state row the website already
// used, keyed by the catalog product NAME so the two vocabularies line up.
//
// The link table is admin-only over a session (see the note at the top of this
// file); these routes are the bot's equivalent, gated on API_SECRET rather than
// on a session it does not have.
function requireBot(req, res, next) {
  if (botAuthUnavailable()) {
    return res.status(503).json({ error: 'API_SECRET is not configured on the backend' });
  }
  if (!botAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function writeLinkTable(key, table) {
  await query(
    `INSERT INTO app_state (guild_id, scope, owner_id, key, value, updated_at)
     VALUES ($1,'global','',$2,$3, now())
     ON CONFLICT (guild_id, scope, owner_id, key)
     DO UPDATE SET value = $3, updated_at = now()`,
    [GUILD_ID, key, JSON.stringify(table)]
  );
}

// ─── GET /api/downloads/bot/all ─────────────────────────
// The whole table, links included — this is the bot, which already holds
// API_SECRET, and it needs the URLs to hand out in #downloads.
//
// Two segments, so it cannot collide with GET /:name above no matter which is
// registered first.
router.get('/bot/all', requireBot, async (req, res) => {
  try {
    const main = await linkTable('ghostDownloads');
    const vault = await linkTable('ghostVaultDownloads');

    const out = [];
    const push = (name, entry, isVault) => {
      if (!entry || typeof entry !== 'object') return;
      out.push({
        name,
        link: entry.link || '',
        version: entry.version || null,
        updated: entry.updated || null,
        instructions: entry.instructions || null,
        vault: !!isVault,
      });
    };
    for (const [name, entry] of Object.entries(main)) push(name, entry, false);
    // Vault entries are stored under a 'vault_' prefixed key by the admin
    // panel. The prefix is a storage detail, not part of the product name, so
    // it is stripped here rather than leaking into the Discord dropdown.
    for (const [key, entry] of Object.entries(vault)) {
      push(key.startsWith('vault_') ? key.slice(6) : key, entry, true);
    }
    res.json({ downloads: out });
  } catch (err) {
    console.error('[Downloads] bot list error:', err);
    res.status(500).json({ error: 'Failed to read download table' });
  }
});

// ─── POST /api/downloads/bot/set ────────────────────────
// /setdownload in Discord writes here, so the site sees the new link
// immediately and it survives the next deploy.
router.post('/bot/set', requireBot, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'A product name is required' });

    let link = String((req.body && req.body.link) || '').trim();
    // An empty link is how a link is REMOVED — the entry stays so the product
    // keeps its version/instructions, but /api/downloads/:name will 404 it,
    // which is the same thing the admin panel's blank field does.
    if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
    if (link && link.length > 2000) return res.status(400).json({ error: 'That link is too long' });

    const isVault = !!(req.body && req.body.vault);
    const key = isVault ? 'ghostVaultDownloads' : 'ghostDownloads';
    const storeKey = isVault ? `vault_${name}` : name;

    const table = await linkTable(key);
    const prev = (table[storeKey] && typeof table[storeKey] === 'object') ? table[storeKey] : {};

    table[storeKey] = {
      ...prev,
      link,
      // Only overwrite the fields the caller actually sent. /setdownload sets
      // the URL and nothing else, and blanking someone's carefully written
      // install instructions as a side effect is not what they asked for.
      version: req.body.version != null ? String(req.body.version).slice(0, 100) : (prev.version || 'v1.0.0'),
      instructions: req.body.instructions != null
        ? String(req.body.instructions).slice(0, 4000)
        : (prev.instructions || ''),
      updated: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    };

    await writeLinkTable(key, table);
    res.json({ success: true, name, vault: isVault, entry: table[storeKey] });
  } catch (err) {
    console.error('[Downloads] bot set error:', err);
    res.status(500).json({ error: 'Failed to save download link' });
  }
});

module.exports = router;
