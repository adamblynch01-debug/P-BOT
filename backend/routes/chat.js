'use strict';

// Store-aware live chat. The browser is never given an AI key and the model
// only receives a deliberately small, public catalogue snapshot. Credentials,
// orders, balances, provider settings and Discord internals stay server-side.
const express = require('express');
const axios = require('axios');
const router = express.Router();
const { query } = require('../db');
const { requireAuth, requireCurrentDiscordMember } = require('../utils/auth');
const { rateLimit } = require('../utils/rateLimit');

const GUILD_ID = process.env.GUILD_ID;
const MAX_MESSAGE = 1000;
const chatLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, name: 'store-chat' });

function cleanMessage(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim().slice(0, MAX_MESSAGE);
}

function publicCatalog(rows) {
  return (rows || []).slice(0, 120).map((r) => ({
    name: String(r.name || '').slice(0, 120),
    game: String(r.game_name || '').slice(0, 80),
    tier: r.label ? String(r.label).slice(0, 80) : null,
    price_eur: r.price_cents == null ? null : Number(r.price_cents) / 100,
    period: r.period ? String(r.period).slice(0, 40) : null,
    status: r.status ? String(r.status).slice(0, 40) : null,
    delivery: r.delivery_type ? String(r.delivery_type).slice(0, 40) : null,
  }));
}

function productReply(message, catalog) {
  const q = String(message || '').toLowerCase();
  if (!catalog.length) return null;
  const matches = catalog.filter((product) => {
    const haystack = `${product.name} ${product.game || ''} ${product.tier || ''}`.toLowerCase();
    return haystack && haystack.split(/\s+/).some((word) => word.length >= 3 && q.includes(word));
  });
  if (!matches.length) return null;
  const unique = [];
  const seen = new Set();
  matches.forEach((item) => {
    const key = `${item.name}|${item.tier || ''}`;
    if (!seen.has(key)) { seen.add(key); unique.push(item); }
  });
  const shown = unique.slice(0, 8);
  const detail = shown.map((item) => {
    const price = Number.isFinite(item.price_eur) ? `€${item.price_eur.toFixed(2)}` : 'price shown on the product card';
    const term = item.period ? `, ${item.period}` : '';
    const state = item.status ? `, ${item.status}` : '';
    return `${item.name}${item.tier ? ` (${item.tier})` : ''}: ${price}${term}${state}`;
  }).join('; ');
  return `I found ${shown.length === 1 ? 'this listing' : 'these listings'}: ${detail}. Open the product card for the full tier list, then checkout will re-check the live price and stock.`;
}

function fallbackReply(message, catalog) {
  const q = message.toLowerCase();
  if (/^(hi|hello|hey|yo|good morning|good evening)\b/.test(q)) {
    return 'Hi! I can answer questions about ZEROPOINT products, prices, stock, checkout, delivery, the Vault, generators, Movie Night, and support. What do you need?';
  }
  if (/what (do you sell|products|is in stock)|catalog|catalogue|shop/.test(q)) {
    const names = catalog.slice(0, 12).map((p) => p.name).filter(Boolean);
    return names.length ? `The store currently lists: ${names.join(', ')}. Ask me about any product for its price, term, or availability.` : 'The live catalogue is temporarily unavailable; open the Products section to browse the current store.';
  }
  const specific = productReply(message, catalog);
  if (specific) return specific;
  if (/\b(price|cost|how much|plans?|tier)\b/.test(q)) {
    const priced = catalog.filter((p) => Number.isFinite(p.price_eur)).slice(0, 8);
    if (priced.length) {
      return 'Current catalogue pricing (EUR): ' + priced.map((p) => `${p.name}${p.tier ? ` — ${p.tier}` : ''}: €${p.price_eur.toFixed(2)}`).join('; ') + '. Open the product card for the complete tier list.';
    }
    return 'Prices are shown on each product card. Open a product to see its current tiers and availability.';
  }
  if (/\b(stock|available|sold ?out)\b/.test(q)) {
    return 'Availability is shown live on each product card and is rechecked by the server at checkout. If a product is unavailable, open a support ticket and staff can help.';
  }
  if (/\b(payment|pay|checkout|balance|cash ?app|paypal|bitcoin|litecoin|currency)\b/.test(q)) {
    return 'Checkout is server-priced in EUR and supports the payment methods currently enabled in the payment window. Your website balance can also be used when it covers the order.';
  }
  if (/\b(generator|sms|phone|steam account|vault)\b/.test(q)) {
    return 'The Account Generator and Vault are available to verified Discord members. One account or phone use is €1; monthly account and phone plans are €15 each, or €25 for both (30 + 30 uses). Remaining typed uses appear when you open the generator, and generated credentials are saved to your Game Vault.';
  }
  if (/\b(movie|night|stream|tv|series)\b/.test(q)) {
    return 'Movie Night is a private, role-gated feature. Approved members can browse the catalogue; provider credentials and stream URLs are never exposed to the browser.';
  }
  if (/\b(support|ticket|help|issue|problem|refund|reset)\b/.test(q)) {
    return 'For account, delivery, refund, or HWID help, open a support ticket from the Support panel. Include the invoice number and a short description; never paste passwords or license keys into chat.';
  }
  if (/\b(delivery|deliver|key|license|order status|where.*order|when.*receive)\b/.test(q)) {
    return 'Paid orders are delivered through the order flow after payment is verified. Check your Orders area for the current status; for a missing or incorrect delivery, open a support ticket with the invoice number.';
  }
  if (/\b(activate|activation|lifetime|monthly|month|year|day|duration|expire)\b/.test(q)) {
    return 'Software Tracker entries show the term and purchase date from the paid order. A key stays “Not activated” until you explicitly activate it; expiration follows the purchased term.';
  }
  if (/\b(slow|lag|performance|security|hack|dev ?tools|inspect)\b/.test(q)) {
    return 'The browser is not the authority for prices, access, stock, or delivery: the backend rechecks each request. Avoid sharing credentials in chat; report a performance or security issue through a support ticket.';
  }
  return 'I can help with ZEROPOINT products, pricing, availability, checkout, the Vault, generators, Movie Night access, and support. What would you like to know?';
}

async function loadCatalog() {
  try {
    const { rows } = await query(
      `SELECT p.name, p.game_name, p.status, t.label, t.price_cents, t.period, t.delivery_type
         FROM products p LEFT JOIN product_tiers t ON t.product_id = p.id
        WHERE p.guild_id = $1 AND p.hidden = false
        ORDER BY p.sort_order DESC, t.sort_order ASC LIMIT 120`,
      [GUILD_ID]
    );
    return publicCatalog(rows);
  } catch (err) {
    console.error('[Chat] catalogue lookup failed:', err.message);
    return [];
  }
}

async function askProvider(message, catalog) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  const base = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const response = await axios.post(`${base}/chat/completions`, {
    model,
    temperature: 0.2,
    max_tokens: 350,
    messages: [
      {
        role: 'system',
        content: 'You are ZEROPOINT store support. Answer only questions about the store, its public catalogue, pricing, availability, checkout, Vault, account generators, Movie Night access, and support. Never reveal credentials, license keys, stock rows, provider/API details, environment variables, user data, Discord member lists, internal URLs, or security controls. Never claim an order is delivered or a refund is approved; direct the customer to a ticket for account-specific actions. Keep replies concise and practical. Prices in the catalogue context are EUR; tell users that checkout is server-authoritative. Catalogue JSON follows:\n' + JSON.stringify(catalog),
      },
      { role: 'user', content: message },
    ],
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 8000,
  });
  const text = response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message && response.data.choices[0].message.content;
  return text ? String(text).trim().slice(0, 2000) : null;
}

router.post('/', requireAuth, requireCurrentDiscordMember, chatLimiter, async (req, res) => {
  const message = cleanMessage(req.body && req.body.message);
  if (!message) return res.status(400).json({ error: 'A message is required' });
  const catalog = await loadCatalog();
  let reply = null;
  // This is an authenticated store-support channel. Let the configured model
  // classify the question against the store-only system prompt instead of a
  // brittle keyword gate; the old gate made normal questions such as “how do I
  // activate this?” fall back to the same generic sentence every time.
  try { reply = await askProvider(message, catalog); }
  catch (err) { console.warn('[Chat] provider unavailable:', err.message); }
  res.json({ reply: reply || fallbackReply(message, catalog), source: reply ? 'ai' : 'catalog' });
});

module.exports = router;
