const axios = require('axios');
const { supabase } = require('../db');

// ─── HD Address Derivation ───────────────────────────────
// Derives unique addresses from xPub for each order
// Safe — xPub is read-only, cannot spend funds

async function getNextAddressIndex(coin) {
  try {
    const { data, error } = await supabase
      .from('crypto_addresses')
      .select('address_index')
      .eq('coin', coin.toUpperCase())
      .order('address_index', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return 0;
    return (data.address_index || 0) + 1;
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
    const crypto = require('crypto');

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

    // Save to DB
    await supabase.from('crypto_addresses').insert({
      address,
      order_id,
      coin: 'BTC',
      address_index: index,
      created_at: new Date().toISOString(),
    });

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

    // Save to DB
    await supabase.from('crypto_addresses').insert({
      address,
      order_id,
      coin: 'LTC',
      address_index: index,
      created_at: new Date().toISOString(),
    });

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

    await supabase.from('crypto_addresses').insert({
      address,
      order_id,
      coin: coin.toUpperCase(),
      address_index: 0,
      created_at: new Date().toISOString(),
    });

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

    const chain = coin === 'btc' ? 'btc/main' : 'ltc/main';
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;

    await axios.post(
      `https://api.blockcypher.com/v1/${chain}/hooks?token=${token}`,
      {
        event: 'confirmed-tx',
        address,
        url: `${backendUrl}/api/webhooks/crypto?order_id=${order_id}`,
        confirmations: 1,
      }
    );
    console.log(`[Crypto] Webhook registered for ${address}`);
  } catch (err) {
    console.error('[Crypto] Webhook registration error:', err.message);
  }
}

module.exports = { generateCryptoAddress, registerWebhook };
