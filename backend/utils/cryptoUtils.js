const axios = require('axios');
const { query } = require('../db');

const GUILD_ID = process.env.GUILD_ID;

// ─── HD Address Derivation ───────────────────────────────
// Derives unique addresses from xPub for each order
// Safe — xPub is read-only, cannot spend funds

async function getNextAddressIndex(coin) {
  try {
    const { rows } = await query(
      `SELECT address_index FROM crypto_addresses
       WHERE guild_id = $1 AND coin = $2
       ORDER BY address_index DESC LIMIT 1`,
      [GUILD_ID, coin.toUpperCase()]
    );
    if (!rows.length) return 0;
    return (rows[0].address_index || 0) + 1;
  } catch {
    return 0;
  }
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

  try {
    const HDKey = require('hdkey');
    const bitcoin = require('bitcoinjs-lib');

    const index = await getNextAddressIndex('btc');

    // Derive child key at m/0/index (external chain)
    const hdkey = HDKey.fromExtendedKey(xpub);
    const child = hdkey.derive(`m/0/${index}`);
    const pubkey = child.publicKey;

    // Generate P2PKH address (legacy) — compatible with most wallets
    const { address } = bitcoin.payments.p2pkh({
      pubkey,
      network: bitcoin.networks.bitcoin,
    });

    await query(
      `INSERT INTO crypto_addresses (guild_id, address, order_id, coin, address_index) VALUES ($1,$2,$3,'BTC',$4)`,
      [GUILD_ID, address, order_id, index]
    );

    console.log(`[Crypto] Derived BTC address #${index}: ${address}`);
    return address;
  } catch (err) {
    console.error('[Crypto] BTC derivation error:', err.message);
    // Fallback to BlockCypher if xpub derivation fails
    return await generateViaBlockCypher('btc', order_id);
  }
}

async function deriveLTCAddress(order_id) {
  const xpub = process.env.LTC_XPUB;
  if (!xpub) {
    console.warn('[Crypto] LTC_XPUB not set');
    return null;
  }

  try {
    const HDKey = require('hdkey');
    const bitcoin = require('bitcoinjs-lib');

    const index = await getNextAddressIndex('ltc');

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

    const child = hdkey.derive(`m/0/${index}`);
    const pubkey = child.publicKey;

    const { address } = bitcoin.payments.p2pkh({
      pubkey,
      network: litecoin,
    });

    await query(
      `INSERT INTO crypto_addresses (guild_id, address, order_id, coin, address_index) VALUES ($1,$2,$3,'LTC',$4)`,
      [GUILD_ID, address, order_id, index]
    );

    console.log(`[Crypto] Derived LTC address #${index}: ${address}`);
    return address;
  } catch (err) {
    console.error('[Crypto] LTC derivation error:', err.message);
    return await generateViaBlockCypher('ltc', order_id);
  }
}

// ─── Fallback: BlockCypher address generation ────────────
async function generateViaBlockCypher(coin, order_id) {
  try {
    const token = process.env.BLOCKCYPHER_TOKEN;
    if (!token) return null;

    const chain = coin === 'btc' ? 'btc/main' : 'ltc/main';
    const response = await axios.post(
      `https://api.blockcypher.com/v1/${chain}/addrs?token=${token}`
    );
    const address = response.data.address;

    await query(
      `INSERT INTO crypto_addresses (guild_id, address, order_id, coin, address_index) VALUES ($1,$2,$3,$4,0)`,
      [GUILD_ID, address, order_id, coin.toUpperCase()]
    );

    console.log(`[Crypto] BlockCypher fallback address: ${address}`);
    return address;
  } catch (err) {
    console.error('[Crypto] BlockCypher fallback error:', err.message);
    return null;
  }
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
