const axios = require('axios');
const { query } = require('../db');

const GUILD_ID = process.env.GUILD_ID;

// ─── Public base URL ─────────────────────────────────────
// BACKEND_URL is set on Railway as a bare host — "captivating-happiness-…
// up.railway.app" with no scheme — because that is what the Railway dashboard
// shows you. Interpolated straight into a callback URL that produced
// "captivating-happiness-….up.railway.app/api/webhooks/crypto", which is not an
// absolute URL, so BlockCypher could never call back. The env var is fixed, but
// normalising here means the next person who pastes a bare host from a
// dashboard doesn't silently break the webhook again.
//
// Returns null when there is nothing usable, so callers can decline to register
// rather than register a hook that will never fire.
function publicBaseUrl() {
  const raw = (process.env.BACKEND_URL || '').trim();
  if (!raw) {
    return process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:3000';
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try { parsed = new URL(withScheme); } catch { return null; }
  if (!parsed.hostname) return null;
  return withScheme.replace(/\/+$/, ''); // no trailing slash — callers append one
}

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

  // Record what the address had already received BEFORE we hand it to a
  // customer. The xpub can belong to a wallet that is also used by hand, so an
  // address may carry history that has nothing to do with this order; without a
  // baseline the poller reads that history as payment. Throwing here (rather
  // than returning null) skips the retry loop and fails the whole derivation:
  // generateCryptoAddress catches it and the order gets no address, so nobody
  // can pay into one whose funds we could not attribute.
  const baseline = await fetchTotalReceived(coin, address);
  if (baseline === null) {
    throw new Error(`could not establish a chain baseline for ${coin.toUpperCase()} address`);
  }

  try {
    await query(
      `INSERT INTO crypto_addresses (guild_id, address, order_id, coin, address_index, baseline_received)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [GUILD_ID, address, order_id, coin.toUpperCase(), index, baseline]
    );
  } catch (err) {
    if (err && err.code === '23505') return null; // index or address raced — retry
    throw err;
  }
  if (baseline > 0) {
    console.warn(`[Crypto] ${coin.toUpperCase()} address #${index} has prior history (${baseline} received) — baselined`);
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

// ─── Address recycling ───────────────────────────────────
// Every checkout burns a derivation index whether or not the customer pays, and
// abandoned crypto carts are normal. Wallets only scan a fixed run of unused
// addresses ahead of the last one they have seen — around 20 — so a streak of
// unpaid orders pushes new addresses past the merchant wallet's horizon. The
// customer pays, the chain confirms, the bot delivers, and the coins land
// somewhere the wallet will not display until it is forced to rescan.
//
// Reusing the address of an order that died unpaid keeps the sequence dense.
// This is only safe because addresses are baselined: reuse used to mean
// inheriting whatever the address had received.
const RECYCLE_GRACE_HOURS = () => {
  const h = parseFloat(process.env.CRYPTO_RECYCLE_GRACE_HOURS);
  return Number.isFinite(h) && h >= 1 ? h : 24;
};

async function claimRecycledAddress(coin, order_id) {
  const { rows } = await query(
    `SELECT ca.id, ca.address, ca.address_index, ca.order_id, ca.baseline_received
       FROM crypto_addresses ca
       JOIN orders o ON o.id = ca.order_id
      WHERE ca.guild_id = $1 AND ca.coin = $2
        AND ca.baseline_received IS NOT NULL
        -- 'expired' belongs here, and its absence was a live regression the
        -- moment watchers/orderExpiry.js shipped. Before the sweeper, an
        -- abandoned crypto cart sat at 'waiting' forever and this query found
        -- it; now the sweeper moves it to 'expired' within minutes of its
        -- deadline, and without this line the one status that MEANS "unpaid
        -- and closed" was the one status that could never be recycled. Every
        -- abandoned cart would burn a derivation index permanently — which is
        -- precisely the gap-limit problem the block above exists to avoid.
        --
        -- Safe for the same reasons the other two are: the sweeper only writes
        -- 'expired' when both receipt columns are zero, the grace period below
        -- puts a day between the deadline and reuse, and the address is still
        -- checked against its baseline on-chain before anything is handed over.
        -- 'expired_paid' stays out — that one has money on it.
        AND o.status IN ('waiting','cancelled','expired')
        AND o.expires_at IS NOT NULL
        AND o.expires_at < now() - ($3 || ' hours')::interval
      ORDER BY ca.address_index ASC
      LIMIT 5`,
    [GUILD_ID, coin.toUpperCase(), String(RECYCLE_GRACE_HOURS())]
  );

  for (const cand of rows) {
    // A NULL baseline means we never established what this address had already
    // received, so "unchanged since issue" is not a question we can answer. The
    // WHERE clause above filters these out, but `Number(null)` is 0 and would
    // compare equal to a virgin address, so the guard is repeated here rather
    // than trusted to the query.
    const base = cand.baseline_received;
    if (base === null || base === undefined || base === '') continue;
    const baseNum = Number(base);
    if (!Number.isFinite(baseNum) || baseNum < 0) continue;

    const activity = await fetchAddressActivity(coin, cand.address);
    // Unreadable chain state is not "clean" — skip rather than guess.
    if (!activity) continue;
    // Anything at all happened here since we issued it: a late payment, or one
    // still in the mempool. Leave it alone; it belongs to the old order and
    // handing it to a new customer would misattribute the funds.
    if (Number(activity.total_received) !== baseNum) continue;
    if (activity.unconfirmed_balance > 0 || activity.unconfirmed_n_tx > 0) continue;

    // Compare-and-swap on the previous owner so two concurrent checkouts cannot
    // both claim the same recycled address.
    const { rowCount } = await query(
      `UPDATE crypto_addresses
          SET order_id = $1, baseline_received = $2, created_at = now()
        WHERE id = $3 AND order_id = $4`,
      [order_id, activity.total_received, cand.id, cand.order_id]
    );
    if (rowCount) {
      // Record the handover. Without this the address's history is erased on
      // rebind, so a late payment from the PREVIOUS customer silently resolves
      // to the new order — and if it covers the new quote, the new customer is
      // delivered for free while the one who actually paid gets nothing.
      // webhooks.js checks this history and refuses to auto-confirm a
      // settlement on a freshly-recycled address.
      await query(
        `UPDATE crypto_address_assignments SET released_at = now()
          WHERE guild_id = $1 AND address = $2 AND released_at IS NULL`,
        [GUILD_ID, cand.address]
      ).catch(err => console.error('[Crypto] Could not close address assignment:', err.message));
      await query(
        `INSERT INTO crypto_address_assignments (guild_id, address, coin, order_id, baseline_received)
         VALUES ($1,$2,$3,$4,$5)`,
        [GUILD_ID, cand.address, coin.toUpperCase(), String(order_id), activity.total_received]
      ).catch(err => console.error('[Crypto] Could not record address assignment:', err.message));

      console.log(`[Crypto] Recycled ${coin.toUpperCase()} address #${cand.address_index} from order ${cand.order_id} → ${order_id}`);
      return cand.address;
    }
  }
  return null;
}

async function generateCryptoAddress(coin, order_id) {
  try {
    if (coin !== 'btc' && coin !== 'ltc') return null;

    // Prefer an address left over from an order that expired unpaid, so the
    // index only advances for checkouts that actually consumed one.
    const recycled = await claimRecycledAddress(coin, order_id).catch((err) => {
      console.error('[Crypto] Recycle attempt failed:', err.message);
      return null;
    });
    if (recycled) return recycled;

    if (coin === 'btc') {
      return await deriveBTCAddress(order_id);
    }
    return await deriveLTCAddress(order_id);
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
    // Native SegWit (bc1q…, BIP84). This MUST match the script type the
    // merchant's wallet derives, not merely be "widely compatible": a wallet
    // only scans the address type it generates. The same pubkey rendered as
    // P2PKH is a different address, so legacy addresses here were invisible to
    // a SegWit wallet — the customer pays, BlockCypher confirms, the bot
    // delivers, and the funds sit at an address the merchant never watches.
    const { address } = bitcoin.payments.p2wpkh({
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
    // Native SegWit (ltc1q…) via the bech32 prefix above — same reasoning as BTC.
    const { address } = bitcoin.payments.p2wpkh({
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
    if (!publicBaseUrl()) {
      // A callback URL BlockCypher cannot parse means the hook is never
      // delivered, and the failure is invisible: registration itself may still
      // return 2xx. Polling covers us, so decline to register rather than
      // pretend a webhook exists.
      console.warn('[Crypto] BACKEND_URL is not a usable absolute URL — webhook not registered, using polling only');
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
    const backendUrl = publicBaseUrl();

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

// ─── Chain reads ─────────────────────────────────────────
// `total_received` is the right figure to build on: BlockCypher reports it
// confirmed-only (so the 1-confirmation guarantee is preserved) and it only
// ever grows, unlike `balance`, which drops when the merchant sweeps the
// address. Returns null when the value cannot be read — callers must treat that
// as "unknown", never as zero.
async function fetchAddressActivity(coin, address) {
  try {
    const chain = String(coin).toLowerCase() === 'btc' ? 'btc/main' : 'ltc/main';
    const token = process.env.BLOCKCYPHER_TOKEN;
    const { data } = await axios.get(
      `https://api.blockcypher.com/v1/${chain}/addrs/${address}/balance${token ? `?token=${token}` : ''}`,
      { timeout: 10000 }
    );
    const total = Number(data && data.total_received);
    if (!Number.isFinite(total) || total < 0) return null;
    return {
      total_received: total,
      // Unconfirmed activity matters for recycling: a payment broadcast but not
      // yet mined is invisible in total_received, and reassigning that address
      // to another order would credit the new order with the old customer's
      // money once it confirms.
      unconfirmed_balance: Number(data.unconfirmed_balance) || 0,
      unconfirmed_n_tx: Number(data.unconfirmed_n_tx) || 0,
    };
  } catch (err) {
    console.error('[Crypto] Address activity read error:', err.message);
    return null;
  }
}

async function fetchTotalReceived(coin, address) {
  const activity = await fetchAddressActivity(coin, address);
  return activity ? activity.total_received : null;
}

// ─── Payment validation ──────────────────────────────────

// How much arrived for THIS order, as opposed to how much the address holds.
//
// Confirming on absolute balance breaks in both directions on an address with a
// life outside this order: money already sitting there settles an order nobody
// paid for, and a sweep between payment and poll drops the balance to zero so a
// real payment is never seen. The delta in confirmed total_received since the
// address was issued is immune to both.
//
// Fails CLOSED — an unreadable total or a missing baseline returns ok:false, so
// the order waits for review instead of being handed out.
function receivedSinceBaseline(totalReceived, baseline) {
  // `Number(null)` and `Number('')` are 0, so these have to be rejected before
  // coercion. A NULL baseline is precisely the unattributable case the column
  // leaves NULL for — silently reading it as 0 would credit the order with the
  // address's entire history, which is the hole this function exists to close.
  const missing = (v) => v === null || v === undefined || v === '';
  if (missing(totalReceived)) {
    return { ok: false, reason: 'chain returned no usable total_received' };
  }
  const total = Number(totalReceived);
  if (!Number.isFinite(total) || total < 0) {
    return { ok: false, reason: 'chain returned no usable total_received' };
  }
  if (missing(baseline)) {
    return { ok: false, reason: 'address has no recorded baseline — cannot attribute funds to this order' };
  }
  const base = Number(baseline);
  if (!Number.isFinite(base) || base < 0) {
    return { ok: false, reason: 'address has no recorded baseline — cannot attribute funds to this order' };
  }
  if (total < base) {
    // total_received never decreases. If it has, the baseline is not comparable
    // to this reading (reorg, or a row baselined against a different address),
    // and the shortfall must not be read as a payment.
    return { ok: false, reason: `total_received ${total} is below the recorded baseline ${base}` };
  }
  return { ok: true, sats: total - base };
}


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
  fetchTotalReceived,
  fetchAddressActivity,
  receivedSinceBaseline,
  claimRecycledAddress,
};
