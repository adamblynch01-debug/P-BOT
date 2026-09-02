// ─── Dump the full CODLABS (SellAuth) catalog to a txt file ─────────────────
// Read-only: GET /v1/reseller/products never charges anything, unlike the
// Flask suppliers' /deliver endpoint. Safe to run any time.
//
//   node list_codlabs_products.js
//
// Needs CODLABS_API_KEY in the environment (Railway has it; locally, put it
// in backend/.env or pass it inline: CODLABS_API_KEY=xxx node list_codlabs_products.js).
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const API_KEY = process.env.CODLABS_API_KEY;
const BASE_URL = process.env.CODLABS_API_BASE || 'https://api.sellauth.com';

if (!API_KEY) {
  console.error('CODLABS_API_KEY is not set. Export it or add it to backend/.env first.');
  process.exit(1);
}

// SellAuth paginates (Laravel-style: data/current_page/last_page). We don't
// know the real page count until the first response, so walk pages until the
// API says there are no more, rather than trusting perPage=100 to be enough.
async function fetchAllProducts() {
  const all = [];
  let page = 1;
  for (;;) {
    const res = await axios.get(`${BASE_URL}/v1/reseller/products`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      params: { perPage: 100, page },
      timeout: 15000,
    });

    const body = res.data;
    const pageItems = Array.isArray(body) ? body : (body.data || []);
    all.push(...pageItems);

    const lastPage = body.last_page || body.meta?.last_page;
    if (!lastPage || page >= lastPage || !pageItems.length) break;
    page += 1;
  }
  return all;
}

function fmtMoney(v, currency) {
  if (v == null) return 'n/a';
  return `${Number(v).toFixed(2)} ${currency || ''}`.trim();
}

async function main() {
  console.log('[CODLABS] Fetching full product catalog...');
  const products = await fetchAllProducts();
  console.log(`[CODLABS] Got ${products.length} product(s)`);

  const lines = [];
  lines.push(`CODLABS (SellAuth) product catalog — ${new Date().toISOString()}`);
  lines.push(`${products.length} product(s)`);
  lines.push('='.repeat(80));

  for (const p of products) {
    lines.push('');
    lines.push(`PRODUCT #${p.id} — ${p.name}`);
    if (p.category) lines.push(`  category: ${p.category}`);
    lines.push(`  currency: ${p.currency || 'n/a'}`);
    lines.push(`  requires_fulfillment: ${!!p.requires_fulfillment}`);

    const variants = p.variants || [];
    if (!variants.length) {
      lines.push('  (no variants returned)');
      continue;
    }
    for (const v of variants) {
      lines.push(
        `  - variant #${v.id} "${v.name}" | price: ${fmtMoney(v.reseller_price, p.currency)} | ` +
        `stock: ${v.stock ?? 'n/a'} | type: ${v.deliverables_type || 'n/a'} | ` +
        `discount: ${v.discount_percentage ?? 0}% ` +
        `| supplier_product_id for supplier_links: ${p.id}:${v.id}`
      );
    }
  }

  const outPath = path.join(__dirname, 'codlabs_catalog.txt');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`[CODLABS] Wrote catalog to ${outPath}`);
}

main().catch(err => {
  console.error('[CODLABS] Failed to fetch catalog:', err.response?.data || err.message);
  process.exit(1);
});
