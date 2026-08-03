// Announce restocks in the Discord #restocks channel.
//
// Two things make this different from the other notifyBot callers, and both
// come from the same fact: stock is written a TIER at a time, but a restock is
// something a customer understands at the PRODUCT level.
//
//   1. It batches. The admin panel's "SYNC ALL STOCK TO BACKEND" fires one
//      POST /api/stock/set per tier — 178 of them in a row — and a naive
//      per-request announcement would carpet the channel with 178 embeds for
//      what the operator experienced as one button press. Events are collected
//      for a short window and flushed together, so one press produces one
//      message.
//   2. It never blocks or throws into the write it is reporting on. Restocking
//      must succeed even if Discord, the bot, or this whole module is down —
//      same rule as logStockChange. Callers do not await it.
//
// Suppression: callers pass `announce: false` for bulk/administrative fills
// (seeding placeholder keys across the entire catalog) where an announcement
// would be noise rather than news.
'use strict';

const { query } = require('../db');
const { notifyBot } = require('./botNotify');

const GUILD_ID = process.env.GUILD_ID;

// The window is deliberately longer than a single HTTP round-trip and shorter
// than a person's patience. Sync-all's requests arrive back to back, so each
// one extends the window (see below) and they coalesce into one flush.
const WINDOW_MS = Number(process.env.RESTOCK_BATCH_MS) || 6000;
// A ceiling on how long extending can defer the flush, so a slow drip of
// restocks cannot postpone the announcement indefinitely.
const MAX_WAIT_MS = Number(process.env.RESTOCK_BATCH_MAX_MS) || 30000;

// tier_id → total keys added since the last flush.
const pending = new Map();
let timer = null;
let firstQueuedAt = 0;

function storeUrl() {
  const raw = process.env.STORE_URL
    || (process.env.STOREFRONT_ORIGINS || '').split(',')[0]
    || 'https://uhservices.xyz';
  return String(raw).trim().replace(/\/+$/, '');
}

// Pull an image only if the product actually has one. `media` is a free-form
// JSON blob that usually holds a video (youtube/vimeo/streamable ids) — those
// are not embeddable as an image, so anything that is not an http(s) URL under
// a known image key is skipped rather than guessed at.
function imageFrom(media) {
  if (!media || typeof media !== 'object') return null;
  for (const k of ['image', 'screenshot', 'banner', 'thumbnail', 'cover']) {
    const v = media[k];
    if (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim())) return v.trim();
  }
  return null;
}

function money(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return 'TBD';
  return '$' + (n / 100).toFixed(2);
}

/**
 * Record that `added` keys landed on `tierId`. Fire-and-forget: returns
 * immediately, never rejects.
 */
function queueRestock({ tierId, added, announce = true }) {
  if (!announce) return;
  const n = Number(added);
  if (!Number.isFinite(n) || n <= 0) return;
  const key = String(tierId);
  if (!key || key === 'undefined' || key === 'null') return;

  if (!pending.size) firstQueuedAt = Date.now();
  pending.set(key, (pending.get(key) || 0) + n);

  // Extend the window on each new event so a burst flushes once, but never
  // past MAX_WAIT_MS from the first event in the batch.
  if (timer) clearTimeout(timer);
  const elapsed = Date.now() - firstQueuedAt;
  const wait = Math.max(0, Math.min(WINDOW_MS, MAX_WAIT_MS - elapsed));
  timer = setTimeout(() => { flush().catch(() => {}); }, wait);
  if (typeof timer.unref === 'function') timer.unref();
}

async function flush() {
  timer = null;
  if (!pending.size) return;
  const batch = new Map(pending);
  pending.clear();
  firstQueuedAt = 0;

  try {
    const tierIds = [...batch.keys()];

    // One round-trip for everything the embed needs: which product each
    // restocked tier belongs to, that product's FULL tier list (the embed
    // shows every variant and its price, not just the restocked one), and the
    // live unused count per tier.
    const { rows } = await query(
      `SELECT p.id AS product_id, p.name AS product_name, p.game_name, p.media, p.hidden, p.vault,
              t.id AS tier_id, t.label, t.price_cents, t.sort_order,
              (SELECT COUNT(*)::int FROM product_stock ps
                WHERE ps.guild_id = t.guild_id AND ps.tier_id = t.id AND ps.used = false) AS available
         FROM product_tiers t
         JOIN products p ON p.id = t.product_id
        WHERE t.guild_id = $1
          AND p.id IN (SELECT product_id FROM product_tiers
                        WHERE guild_id = $1 AND id = ANY($2::bigint[]))
        ORDER BY p.name ASC, t.sort_order ASC, t.id ASC`,
      [GUILD_ID, tierIds]
    );
    if (!rows.length) return;

    const byProduct = new Map();
    for (const r of rows) {
      const pid = String(r.product_id);
      if (!byProduct.has(pid)) {
        byProduct.set(pid, {
          product_id: pid,
          product_name: r.product_name,
          game_name: r.game_name,
          // A hidden product is not on the storefront, so announcing it would
          // point customers at something they cannot buy.
          hidden: !!r.hidden,
          // Which catalogue sells it. The vault is a separate storefront in a
          // separate part of the Discord, so the bot routes on this rather than
          // announcing every restock to one channel and pointing half of them
          // at a page that does not carry the product.
          vault: !!r.vault,
          image_url: imageFrom(r.media),
          variants: [],
          restocked: [],
          total_added: 0,
        });
      }
      const p = byProduct.get(pid);
      p.variants.push({ label: r.label || '—', price: money(r.price_cents) });
      const added = batch.get(String(r.tier_id));
      if (added) {
        p.restocked.push({ label: r.label || '—', added, available: r.available });
        p.total_added += added;
      }
    }

    const products = [...byProduct.values()].filter(p => !p.hidden && p.total_added > 0);
    if (!products.length) return;

    await notifyBot('restock', {
      guild_id: GUILD_ID,
      store_url: storeUrl(),
      products,
      total_products: products.length,
      total_added: products.reduce((s, p) => s + p.total_added, 0),
    });
  } catch (err) {
    // Same contract as logStockChange: an announcement failure is logged and
    // swallowed. The stock is already in the database either way.
    console.error('[Restock] announcement failed (stock still saved):', err.message);
  }
}

module.exports = { queueRestock, __test__: { flush, pending, imageFrom, money, storeUrl } };
