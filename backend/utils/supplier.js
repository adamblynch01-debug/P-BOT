// ─── Buying a key from the upstream reseller ─────────────────────────────────
// See migrations/supplier_links.sql for the schema and the full contract. The
// two facts that shape every line of this file:
//
//   1. THE GET IS THE PURCHASE. It charges the balance and consumes their
//      inventory. So: no health check, no probe, no retry, ever.
//   2. A FAILURE COMES BACK AS A 200. Their errors are plain text starting
//      `ERROR:`, in the same body a key would arrive in. Status-code-only
//      handling would deliver the string "ERROR: Insufficient balance" to a
//      paying customer as their product.
//
// The three outcomes, and why they are three and not two:
//
//   ok      — lines returned. Charged, delivered, logged.
//   error   — they said ERROR:. They tell us nothing was charged and nothing
//             consumed, so this MAY safely fall back to our own key pool.
//   timeout — no answer, or the socket died. AMBIGUOUS: the charge may have
//             gone through and the key may be sitting in their system unread.
//             This must NOT retry (two keys for one sale) and must NOT fall
//             back (two keys for one sale). It raises an alert and the order
//             goes to needs_attention for a human to settle against their
//             invoice.
//
// Collapsing `timeout` into `error` is the single most expensive mistake
// available here, which is why they are separate markers all the way out.
'use strict';

const axios = require('axios');
const { query } = require('../db');
const { raiseAlert } = require('./alerts');

const GUILD_ID = process.env.GUILD_ID;

// ─── who we can buy from ─────────────────────────────────────────────────────
// Two suppliers, and they are running THE SAME PANEL SOFTWARE — same Flask API,
// same two endpoints, same "one value per line" body, same `ERROR:` prefix, word
// for word the same guide. So a second supplier is a base URL and its own key,
// not a second integration, and everything below is written once.
//
// What is NOT shared is the product numbering. Product 48 at one of them is a
// completely different item from product 48 at the other, so `supplier` on a
// link is load-bearing: pointing a link at the wrong one sells the wrong product
// at the wrong price, and the first evidence of that is a customer holding
// somebody else's key. There is no way to check it short of buying one.
//
// Each key is its own env var and neither may live in `config` — see
// ENV_ONLY_KEYS in routes/config.js.
const PROVIDERS = {
  gandy: {
    label: 'Gandy Reseller',
    base: process.env.GANDY_API_BASE || 'https://gandyreseller.uk/api/v1',
    keyEnv: 'GANDY_API_KEY',
  },
  aimbetter: {
    label: 'AimBetter',
    base: process.env.AIMBETTER_API_BASE || 'https://aimbetter.site/api/v1',
    keyEnv: 'AIMBETTER_API_KEY',
  },
};
const DEFAULT_SUPPLIER = 'gandy';

function providerNames() { return Object.keys(PROVIDERS); }
// Unknown names resolve to null rather than to the default. A link saved with a
// typo'd supplier must fall back to our own key pool, not quietly buy from
// whichever one happens to be first in the list.
function providerFor(name) {
  return PROVIDERS[String(name || DEFAULT_SUPPLIER).trim().toLowerCase()] || null;
}

// Generous, because a slow answer is still an answer and a timeout is the one
// outcome we cannot recover from. Better to wait than to give up on a purchase
// that succeeded.
const TIMEOUT_MS = Number(process.env.SUPPLIER_TIMEOUT_MS || process.env.GANDY_TIMEOUT_MS || 30000);

// The markers that reach delivery.js. Both are registered in FAILURE_MARKERS
// there, so a supplier failure suppresses the customer's confirmation email and
// raises an alert exactly like an out-of-stock does — no new machinery.
const SUPPLIER_ERROR = 'SUPPLIER_ERROR';
const SUPPLIER_TIMEOUT = 'SUPPLIER_TIMEOUT';

function apiKey(name) {
  const p = providerFor(name);
  return p ? String(process.env[p.keyEnv] || '').trim() : '';
}
// With a name: is THAT supplier usable. Without one: is ANY of them usable —
// which is what the panel header asks when it decides whether to shout that
// nothing can be bought at all.
function hasApiKey(name) {
  if (name === undefined || name === null || name === '') {
    return providerNames().some(n => !!apiKey(n));
  }
  return !!apiKey(name);
}

// Everything that leaves this module — logs, alerts, API responses, the panel —
// goes through this. The key is in a query string, so it lands in axios' own
// error messages ("Request failed... at https://.../deliver/48?key=abcd") for
// free, and those messages are exactly what gets stored in last_error and shown
// in the admin panel.
//
// EVERY supplier's key is stripped, not just the one that failed. A redactor
// that only knows about the supplier it was called for is a redactor that leaks
// the other one's key the first time an error message quotes a URL.
function redact(text) {
  let s = String(text == null ? '' : text);
  for (const n of providerNames()) {
    const k = apiKey(n);
    if (k) s = s.split(k).join(`<${PROVIDERS[n].keyEnv}>`);
  }
  return s.replace(/([?&]key=)[^&\s]+/gi, '$1<redacted>');
}

// Their success body is keys, one per line. Their failure body is one line
// starting `ERROR:`. Nothing distinguishes the two except that prefix, so it is
// checked on EVERY line, not just the first: a partial answer that mixes a key
// and an error must not be handed over as two keys.
function parseBody(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r/g, '');
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const bad = lines.find(l => /^error\b|^error:/i.test(l));
  if (bad) return { error: bad };
  if (!lines.length) return { error: 'The supplier returned an empty response' };
  return { lines };
}

// The global kill switch, same shape and same loader as PAYMENT_METHODS_OFF: a
// `config` row that boot copies into process.env, so no migration and it
// survives a restart.
//
// The KEY names the state and the VALUE is a boolean — SUPPLIER_OFF=1 means
// every link is off. Unset, empty, '0' and 'false' all mean links are honoured,
// which is the only safe default: this switch failing ON would take a working
// shop offline, whereas failing OFF just means we sell from our own stock.
function supplierGloballyOff() {
  const v = String(process.env.SUPPLIER_OFF || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// The link for one tier, or null. `enabled = false` and the global switch both
// return null, which is what makes turning either off fall the tier straight
// back to the local key pool rather than failing the sale.
//
// The key check is PER LINK, deliberately. With two suppliers, "is a key set"
// is no longer one question: a link pointing at a supplier whose key is unset
// must fall back to local stock, while links pointing at the configured one keep
// working. A single global check would have one missing key silently switch off
// the supplier that is working fine.
//
// Split out of linkForTier() because a SECOND caller now needs the identical
// question answered: the storefront's stock badge. A tier bought upstream has
// no local keys and never will, so counting product_stock rows told a customer
// SOLD OUT about a product that sells perfectly well. Two copies of this rule
// would drift, and the drift is invisible — one copy would gate the buy button
// while the other happily charged the supplier.
//
// An unknown supplier name (a typo, or a row left by a build that knew a
// provider this one does not) resolves to no provider, so it falls back to the
// local pool. Fail closed towards the thing that still delivers.
function linkIsLive(link) {
  if (!link || !link.enabled) return false;
  if (supplierGloballyOff()) return false;
  return !!providerFor(link.supplier) && hasApiKey(link.supplier);
}

async function linkForTier(tierId) {
  if (supplierGloballyOff()) return null;
  try {
    const { rows } = await query(
      'SELECT * FROM supplier_links WHERE guild_id = $1 AND tier_id = $2 AND enabled = TRUE',
      [GUILD_ID, tierId]
    );
    const link = rows[0] || null;
    if (!linkIsLive(link)) return null;
    return link;
  } catch (err) {
    // The table may not exist yet on an instance that has not run the
    // migration. That must not break delivery — it means "no supplier links",
    // which is the state the shop ran in for its whole life until now.
    if (err.code !== '42P01') console.error('[Supplier] link lookup failed:', redact(err.message));
    return null;
  }
}

// The same question asked about many tiers at once, for the storefront's one
// bulk stock call. Returns a Set of tier ids that will be bought upstream —
// never a count, because there is no endpoint that reports their stock and
// inventing a number would be a lie a customer could hit.
//
// Every rejection reason is linkIsLive()'s, so a link that stops delivering
// stops badging as available in the same breath.
async function liveLinkTierIds(tierIds) {
  const ids = (tierIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length || supplierGloballyOff()) return new Set();
  try {
    const { rows } = await query(
      `SELECT tier_id, supplier, enabled FROM supplier_links
       WHERE guild_id = $1 AND enabled = TRUE AND tier_id = ANY($2::int[])`,
      [GUILD_ID, ids]
    );
    return new Set(rows.filter(linkIsLive).map(r => Number(r.tier_id)));
  } catch (err) {
    // Same reasoning as linkForTier: no table means no links, which is a shop
    // that sells from its own pool. A stock badge must never be the thing that
    // takes the storefront down.
    if (err.code !== '42P01') console.error('[Supplier] bulk link lookup failed:', redact(err.message));
    return new Set();
  }
}

// Admin display only: which tiers have ANY supplier link row at all, regardless
// of whether that link is currently live (enabled flag or API key status).
//
// The admin PRODUCT KEYS tab shows ∞ to mean "this tier is mapped to an upstream
// supplier — no local keys needed." That is a property of the ROW, not of the
// current runtime state. A link that is temporarily disabled still means the
// mapping exists, and showing OUT OF STOCK instead of ∞ just confuses the admin
// into thinking the product is broken.
//
// The live status (enabled AND keyed) remains liveLinkTierIds()'s job. The two
// are deliberately separate so neither can hide the other's answer.
async function anyLinkTierIds(tierIds) {
  const ids = (tierIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return new Set();
  try {
    const { rows } = await query(
      `SELECT DISTINCT tier_id FROM supplier_links WHERE guild_id = $1 AND tier_id = ANY($2::int[])`,
      [GUILD_ID, ids]
    );
    return new Set(rows.map(r => Number(r.tier_id)));
  } catch (err) {
    if (err.code !== '42P01') console.error('[Supplier] any-link lookup failed:', redact(err.message));
    return new Set();
  }
}

// ─── the purchase ────────────────────────────────────────────────────────────
// Returns { status: 'ok'|'error'|'timeout', lines?, error?, deliveryId }.
// Never throws: a throw here would land in deliver()'s outer catch and abort an
// order that has already been paid for.
async function purchase(link, { qty = 1, orderId = null, buyerRef = null } = {}) {
  const units = Math.max(1, Number(qty) || 1) * Math.max(1, Number(link.qty_per_unit) || 1);
  const supplierName = String(link.supplier || DEFAULT_SUPPLIER).trim().toLowerCase();
  const provider = providerFor(supplierName);

  // Nowhere to send it. Returned as an `error`, which is the one failure the
  // caller is allowed to fall back from — and correctly so: no request went
  // out, so nothing was charged. Checked BEFORE the pre-log, because a
  // 'pending' row means "a charge may be in flight" and this one never is.
  if (!provider || !apiKey(supplierName)) {
    const why = !provider
      ? `Unknown supplier "${supplierName}" — this build knows ${providerNames().join(', ')}.`
      : `No API key is set for ${provider.label} (${provider.keyEnv} on Railway).`;
    console.error(`[Supplier] not buying ${link.supplier_product_id}: ${why}`);
    return { status: 'error', error: why, deliveryId: null };
  }

  // Logged BEFORE the request. If this process dies mid-call the row stays
  // 'pending', which reads as "we may have been charged and never found out" —
  // the true state. A table written only on success would show nothing at all.
  let deliveryId = null;
  try {
    const { rows } = await query(
      `INSERT INTO supplier_deliveries
         (guild_id, order_id, tier_id, link_id, buyer_ref, supplier, supplier_product_id, qty, status, cost_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING id`,
      [GUILD_ID, orderId, link.tier_id, link.id, buyerRef, supplierName,
       link.supplier_product_id, units, link.cost_cents != null ? Number(link.cost_cents) * units : null]
    );
    deliveryId = rows[0].id;
  } catch (err) {
    // Not fatal on its own, but it means a charge is about to happen with no
    // record of it. Say so loudly rather than proceeding quietly.
    console.error('[Supplier] could not pre-log the delivery:', redact(err.message));
    await raiseAlert('supplier_log_failed',
      `Could not write supplier_deliveries before buying ${link.supplier_product_id}. ` +
      'The purchase is going ahead with no local record of it.',
      { severity: 'error', order_id: orderId }).catch(() => {});
  }

  const finish = async (status, patch) => {
    if (deliveryId) {
      await query(
        `UPDATE supplier_deliveries SET status = $1, response_lines = $2, error_text = $3, updated_at = now()
         WHERE id = $4`,
        [status, patch.lines ? JSON.stringify(patch.lines) : null, patch.error ? redact(patch.error) : null, deliveryId]
      ).catch(e => console.error('[Supplier] could not update the delivery row:', redact(e.message)));
    }
    // The link's own last-result columns, so the panel can show a supplier that
    // has started refusing without anyone reading the delivery log.
    await query(
      status === 'ok'
        ? 'UPDATE supplier_links SET last_ok_at = now(), last_error = NULL, updated_at = now() WHERE id = $1'
        : 'UPDATE supplier_links SET last_error = $2, last_error_at = now(), updated_at = now() WHERE id = $1',
      status === 'ok' ? [link.id] : [link.id, redact(patch.error || status)]
    ).catch(() => {});
    return { status, deliveryId, ...patch };
  };

  const url = `${provider.base}/deliver/${encodeURIComponent(link.supplier_product_id)}`;
  let res;
  try {
    res = await axios.get(url, {
      params: Object.assign(
        { key: apiKey(supplierName), qty: units },
        buyerRef ? { buyerRef } : {}
      ),
      timeout: TIMEOUT_MS,
      // We want the body on a 4xx/5xx too — their error text is more useful
      // than the status code, and axios would otherwise throw it away into an
      // exception message that reads "Request failed with status code 400".
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(d) => d],
    });
  } catch (err) {
    // No answer. This is the ambiguous case and it is treated as such: no
    // retry, no fallback, a human settles it.
    const msg = redact(err.message || 'no response');
    console.error(`[Supplier:${supplierName}] NO ANSWER for product ${link.supplier_product_id} on order ${orderId}: ${msg}`);
    await raiseAlert('supplier_timeout',
      // Names the supplier, because with more than one upstream "check their
      // panel" is not an instruction anybody can follow.
      `${provider.label} did not answer while buying ${link.label || link.supplier_product_id} ` +
      `for order ${orderId || '(none)'}. THE CHARGE MAY HAVE GONE THROUGH — this was not retried ` +
      'and did not fall back to local stock, because either would risk handing out two keys for one sale. ' +
      `Check the ${provider.label} panel against supplier_deliveries id ${deliveryId || '(unlogged)'}.`,
      { severity: 'error', order_id: orderId }).catch(() => {});
    return finish('timeout', { error: msg });
  }

  const parsed = parseBody(res.data);

  if (parsed.error) {
    // They answered and said no. Nothing was charged and nothing consumed, so
    // the caller is free to fall back to our own pool.
    const msg = redact(parsed.error);
    console.error(`[Supplier:${supplierName}] refused product ${link.supplier_product_id} (HTTP ${res.status}): ${msg}`);
    return finish('error', { error: msg });
  }

  // Fewer keys than asked for is a partial purchase, not a success: they have
  // charged for what they sent and the customer is a key short. Hand over what
  // arrived — it is real and it is paid for — but say so.
  if (parsed.lines.length < units) {
    await raiseAlert('supplier_short_delivery',
      `${provider.label} returned ${parsed.lines.length} value(s) for ${units} asked for on ` +
      `${link.label || link.supplier_product_id} (order ${orderId || '(none)'}). The rest was not delivered.`,
      { severity: 'warn', order_id: orderId }).catch(() => {});
  }

  return finish('ok', { lines: parsed.lines });
}

// What the panel is told about each supplier: its name, a readable label, which
// Railway variable holds its key, and WHETHER that key is set. Never the key,
// and never the base URL's key-bearing form.
function providerSummary() {
  return providerNames().map(n => ({
    name: n,
    label: PROVIDERS[n].label,
    key_env: PROVIDERS[n].keyEnv,
    key_configured: !!apiKey(n),
    host: (() => { try { return new URL(PROVIDERS[n].base).host; } catch (e) { return null; } })(),
  }));
}

module.exports = {
  SUPPLIER_ERROR, SUPPLIER_TIMEOUT, DEFAULT_SUPPLIER,
  hasApiKey, redact, parseBody, supplierGloballyOff,
  providerNames, providerFor, providerSummary,
  linkIsLive, linkForTier, liveLinkTierIds, anyLinkTierIds, purchase,
};
