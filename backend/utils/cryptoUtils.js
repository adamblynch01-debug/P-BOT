const axios = require('axios');
const { query } = require('../db');

const GUILD_ID = process.env.GUILD_ID;

// ─── HD Address Derivation ───────────────────────────────
// Derives unique addresses from xPub for each order
// Safe — xPub is read-only, cannot spend funds

async function getNextAddressIndex(coin) {
  const { rows } = await query(
    `SELECT address_index FROM crypto_addresses
     WHERE guild_id = $1 AND coin = $2
     ORDER BY address_index DESC LIMIT 1`,
    [GUILD_ID, coin.toUpperCase()]
  );
  if (!rows.length) return 0;
  return (rows[0].address_index || 0) + 1;
}

// Derives an address and claims it in one attempt; returns null if the index was
// taken in the meantime so the caller can retry with a fresh one.
//
// `SELECT MAX(index)+1` is a read-then-write, so two concurrent crypto
// checkouts derive the SAME address and the second INSERT trips the UNIQUE on
// crypto_addresses. That used to throw into a fallback that generated an
// address whose private key we never keep — silently making any coins sent
// there unspendable forever. Retrying the derivation is the fix; the fallback
// is gone.
async function claimDerivedAddress(coin, order_id, deriveAt) {
  const index = await getNextAddressIndex(coin);
  const address = deriveAt(index);
  if (!address) return null;
  try {
    await query(
      `INSERT INTO crypto_addresses (guild_id, address, order_id, coin, address_index)
       VALUES ($1,$2,$3,$4,$5)`,
      [GUILD_ID, address, order_id, coin.toUpperCase(), index]
    );
  } catch (err) {
    if (err && err.code === '23505') return null; // index or address raced — retry
    throw err;
  }
  console.log(`[Crypto] Derived ${coin.toUpperCase()} address #${index}: ${address}`);
  return address;
}

async function deriveWithRetry(coin, order_id, deriveAt) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const address = await claimDerivedAddress(coin, order_id, deriveAt);
    if (address) return address;
  }
  console.error(`[Crypto] Could not claim a unique ${coin.toUpperCase()} address after 5 attempts`);
  return null;
}

async function generateCryptoAddress(coin, order_id) {
  try {
    if (coin === 'btc') {
      return await deriveBTCAddress(order_id);
    } else if (coin === 'ltc') {
      return await deriveLTCAddress(order_id);
    }
    return null;
  } catch (err) {
    // Returning null is the safe failure: createOrder leaves the order without
    // an address so nobody can pay into one we cannot spend from.
    console.error('[Crypto] Address generation error:', err.message);
    return null;
  }
}

async function deriveBTCAddress(order_id) {
  const xpub = process.env.BTC_XPUB;
  if (!xpub) {
    console.warn('[Crypto] BTC_XPUB not set');
    return null;
  }

  const HDKey = require('hdkey');
  const bitcoin = require('bitcoinjs-lib');
  const hdkey = HDKey.fromExtendedKey(xpub);

  return deriveWithRetry('btc', order_id, (index) => {
    // Derive child key at m/0/index (external chain)
    const child = hdkey.derive(`m/0/${index}`);
    // Generate P2PKH address (legacy) — compatible with most wallets
    const { address } = bitcoin.payments.p2pkh({
      pubkey: child.publicKey,
      network: bitcoin.networks.bitcoin,
    });
    return address;
  });
}

async function deriveLTCAddress(order_id) {
  const xpub = process.env.LTC_XPUB;
  if (!xpub) {
    console.warn('[Crypto] LTC_XPUB not set');
    return null;
  }

  const HDKey = require('hdkey');
  const bitcoin = require('bitcoinjs-lib');

  // LTC network params
  const litecoin = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: {
      public: 0x019da462,  // Ltub
      private: 0x019d9cfe, // Ltpv
    },
    pubKeyHash: 0x30,  // L addresses
    scriptHash: 0x32,
    wif: 0xb0,
  };

  // Handle both Ltub and xpub format
  let hdkey;
  try {
    hdkey = HDKey.fromExtendedKey(xpub, litecoin.bip32);
  } catch {
    // Try with default BIP32 if Ltub parsing fails
    hdkey = HDKey.fromExtendedKey(xpub);
  }

  return deriveWithRetry('ltc', order_id, (index) => {
    const child = hdkey.derive(`m/0/${index}`);
    const { address } = bitcoin.payments.p2pkh({
      pubkey: child.publicKey,
      network: litecoin,
    });
    return address;
  });
}

// ─── Register BlockCypher webhook to watch address ───────
async function registerWebhook(coin, address, order_id) {
  try {
    const token = process.env.BLOCKCYPHER_TOKEN;
    if (!token) {
      console.warn('[Crypto] No BLOCKCYPHER_TOKEN — webhook not registered, using polling only');
      return;
    }
    // BlockCypher does not sign its callbacks, so the only thing separating a
    // real callback from a forged one is an unguessable URL. Without the secret
    // there is no way to tell them apart — so don't register at all rather than
    // stand up an endpoint that trusts anyone who finds it.
    const hookSecret = process.env.WEBHOOK_SECRET;
    if (!hookSecret) {
      console.warn('[Crypto] No WEBHOOK_SECRET — webhook not registered, using polling only');
      return;
    }

    const chain = coin === 'btc' ? 'btc/main' : 'ltc/main';
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;

    await axios.post(
      `https://api.blockcypher.com/v1/${chain}/hooks?token=${token}`,
      {
        event: 'confirmed-tx',
        address,
        url: `${backendUrl}/api/webhooks/crypto?token=${encodeURIComponent(hookSecret)}`,
        confirmations: 1,
      }
    );
    console.log(`[Crypto] Webhook registered for ${address}`);
  } catch (err) {
    console.error('[Crypto] Webhook registration error:', err.message);
  }
}

// ─── USD → coin rate ─────────────────────────────────────
// Checkout quotes crypto orders in DOLLARS (payment_info.amount is the USD
// total), but the chain reports satoshis. Without a rate the two are
// incomparable, which is why the payment amount went unvalidated for so long.
// The rate is locked at order time and stored on the order: that is the number
// the customer was actually quoted, so it — not today's price — is what the
// payment gets checked against.
const COIN_IDS = { btc: 'bitcoin', ltc: 'litecoin' };

async function getUsdRate(coin) {
  try {
    const id = COIN_IDS[String(coin).toLowerCase()];
    if (!id) return null;
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { timeout: 8000 }
    );
    const rate = data && data[id] && data[id].usd;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch (err) {
    console.error('[Crypto] Rate fetch error:', err.message);
    return null;
  }
}

// Returns { coin_amount, expected_sats, rate_usd } or null if the rate is
// unavailable. Null means "we cannot price this order" — callers must then
// refuse to auto-confirm rather than guessing.
async function quoteCrypto(coin, usdTotal) {
  const rate = await getUsdRate(coin);
  if (!rate) return null;
  const coinAmount = usdTotal / rate;
  return {
    coin_amount: Number(coinAmount.toFixed(8)),
    expected_sats: Math.round(coinAmount * 1e8),
    rate_usd: rate,
  };
}

// ─── Payment validation ──────────────────────────────────
// Underpayment tolerance covers rounding and wallet fee quirks only. It is NOT
// meant to absorb price movement — the quote is locked for the order's 24h
// window and that risk is the store's, not a reason to widen the gate.
function underpayTolerance() {
  const pct = parseFloat(process.env.CRYPTO_UNDERPAY_TOLERANCE_PERCENT);
  return Number.isFinite(pct) && pct >= 0 && pct <= 20 ? pct : 2;
}

// Fails CLOSED: an order with no locked quote returns ok:false, so a missing
// or malformed quote leaves the order waiting for manual review instead of
// being handed out for free.
function verifyCryptoPayment(order, receivedSats) {
  let info = order.payment_info;
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch { info = null; }
  }
  const expected = info && Number(info.expected_sats);
  if (!Number.isFinite(expected) || expected <= 0) {
    return { ok: false, reason: 'no locked crypto quote on this order — manual review required' };
  }
  if (!Number.isFinite(receivedSats) || receivedSats <= 0) {
    return { ok: false, reason: 'no satoshis received' };
  }
  const minimum = Math.floor(expected * (1 - underpayTolerance() / 100));
  if (receivedSats < minimum) {
    return {
      ok: false,
      reason: `underpaid — expected ~${expected} sats, received ${receivedSats}`,
      expected_sats: expected,
      received_sats: receivedSats,
    };
  }
  return { ok: true, expected_sats: expected, received_sats: receivedSats };
}

module.exports = {
  generateCryptoAddress,
  registerWebhook,
  getUsdRate,
  quoteCrypto,
  verifyCryptoPayment,
};
