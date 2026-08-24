// ─── CODLABS (SellAuth) Supplier Integration ─────────────────────────────────
// Purchases keys/accounts from CODLABS reseller API
// Docs: https://sellauth.mintlify.site/resellers/overview

const axios = require('axios');

const API_KEY = process.env.CODLABS_API_KEY;
const BASE_URL = 'https://api.sellauth.com';

// Cache products for 5 minutes to reduce API calls
let productCache = { data: null, expiresAt: 0 };
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Fetch available products from CODLABS
 * @returns {Promise<Array>} List of products with variants, pricing, and stock
 */
async function fetchProducts() {
  if (!API_KEY) {
    console.error('[CODLABS] API key not configured');
    return [];
  }

  // Return cached data if still valid
  if (productCache.data && productCache.expiresAt > Date.now()) {
    return productCache.data;
  }

  try {
    const response = await axios.get(`${BASE_URL}/v1/reseller/products`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      params: {
        perPage: 100, // Get all products
      },
      timeout: 10000,
    });

    const products = response.data.data || [];

    // Cache the result
    productCache = {
      data: products,
      expiresAt: Date.now() + CACHE_TTL,
    };

    console.log(`[CODLABS] Fetched ${products.length} products`);
    return products;

  } catch (error) {
    console.error('[CODLABS] Failed to fetch products:', error.response?.data || error.message);
    // Return stale cache if available
    return productCache.data || [];
  }
}

/**
 * Get reseller balance and tier info
 * @returns {Promise<Object>} Balance, currency, tier, stats
 */
async function getBalance() {
  if (!API_KEY) {
    throw new Error('CODLABS API key not configured');
  }

  try {
    const response = await axios.get(`${BASE_URL}/v1/reseller/balance`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    return response.data;

  } catch (error) {
    console.error('[CODLABS] Failed to fetch balance:', error.response?.data || error.message);
    throw new Error('Failed to fetch CODLABS balance');
  }
}

/**
 * Purchase a product variant
 * @param {number} productId - CODLABS product ID
 * @param {number} variantId - CODLABS variant ID
 * @param {number} quantity - Number of keys to purchase
 * @param {string} idempotencyKey - Unique key to prevent duplicate charges
 * @returns {Promise<Object>} Invoice with delivered keys/accounts
 */
async function purchase(productId, variantId, quantity = 1, idempotencyKey = null) {
  if (!API_KEY) {
    throw new Error('CODLABS API key not configured');
  }

  try {
    const headers = {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    };

    // Add idempotency key if provided (prevents duplicate charges on retry)
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const response = await axios.post(
      `${BASE_URL}/v1/reseller/invoices`,
      {
        items: [
          {
            product_id: productId,
            variant_id: variantId,
            quantity: quantity,
          },
        ],
      },
      {
        headers,
        timeout: 30000, // 30s timeout for purchase
      }
    );

    const invoice = response.data;

    console.log(`[CODLABS] Purchase successful - Invoice ${invoice.id}, Total: $${invoice.total_usd}`);

    return {
      success: true,
      invoiceId: invoice.id,
      uniqueId: invoice.unique_id,
      status: invoice.status,
      totalUsd: invoice.total_usd,
      items: invoice.items.map(item => ({
        productId: item.product_id,
        productName: item.product_name,
        variantId: item.variant_id,
        variantName: item.variant_name,
        quantity: item.quantity,
        delivered: item.delivered || [],
        status: item.status,
      })),
    };

  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;

    if (status === 402) {
      // Insufficient balance
      console.error('[CODLABS] Insufficient balance:', data?.message);
      throw new Error('Insufficient CODLABS balance');
    } else if (status === 409) {
      // Duplicate idempotency key still processing
      console.error('[CODLABS] Request still processing:', data?.message);
      throw new Error('Purchase request still processing, retry shortly');
    } else {
      console.error('[CODLABS] Purchase failed:', data || error.message);
      throw new Error('Failed to purchase from CODLABS');
    }
  }
}

/**
 * Get invoice details by ID or unique_id
 * @param {string|number} invoiceId - Invoice ID or unique_id
 * @returns {Promise<Object>} Invoice with delivery details
 */
async function getInvoice(invoiceId) {
  if (!API_KEY) {
    throw new Error('CODLABS API key not configured');
  }

  try {
    const response = await axios.get(`${BASE_URL}/v1/reseller/invoices/${invoiceId}`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    return response.data;

  } catch (error) {
    if (error.response?.status === 404) {
      console.error('[CODLABS] Invoice not found:', invoiceId);
      throw new Error('Invoice not found');
    }
    console.error('[CODLABS] Failed to fetch invoice:', error.response?.data || error.message);
    throw new Error('Failed to fetch CODLABS invoice');
  }
}

/**
 * Map CODLABS product to our inventory format
 * @param {Object} product - CODLABS product object
 * @param {Object} variant - CODLABS variant object
 * @returns {Object} Mapped product data
 */
function mapProduct(product, variant) {
  return {
    supplier: 'codlabs',
    externalId: `${product.id}:${variant.id}`,
    productId: product.id,
    variantId: variant.id,
    name: product.name,
    variantName: variant.name,
    price: variant.reseller_price,
    currency: product.currency,
    stock: variant.stock,
    deliveryType: variant.deliverables_type, // 'serials', 'dynamic', etc.
    requiresFulfillment: product.requires_fulfillment,
    discountPercentage: variant.discount_percentage,
  };
}

module.exports = {
  fetchProducts,
  getBalance,
  purchase,
  getInvoice,
  mapProduct,
};
