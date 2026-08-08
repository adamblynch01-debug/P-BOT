// ─── Quoting one order in a currency the payment method can actually move ────
//
// The shop prices in euro (utils/money.js). PayPal takes euro; Cash App does
// not, and no amount of configuration makes it — it settles USD in the US and
// GBP in the UK. That left Cash App reported as `state:'currency'`: not off, not
// misconfigured, impossible. Correct, and a dead method.
//
// This module is the third option. The order is still PRICED in euro — that is
// the number in `total_cents`, the number on the receipt, the number the books
// are kept in — but a method that cannot carry euro is handed a SETTLEMENT
// amount in a currency it can, converted at a rate that is fetched once and
// LOCKED onto the order.
//
// ─── Why the rate is locked, not looked up again later ───────────────────────
//
// This is the same discipline as the crypto quote in utils/cryptoUtils.js, and
// for the same reason. A customer is shown "send $21.60" and pays forty minutes
// later. If the confirming side re-derives the expected dollars from today's
// rate, a move of half a percent turns a correct payment into `underpaid`, an
// alert, and a support ticket — for a customer who sent exactly what the screen
// told them to. The number they were SHOWN is the number they get judged
// against, so it has to be written down at the moment it is shown.
//
// ─── Why no API key ─────────────────────────────────────────────────────────
//
// frankfurter.app republishes the European Central Bank's daily reference rates
// and needs no key. That matters beyond convenience: the pay screen lives in
// `index.html`, which is public and hand-uploaded, so any key the storefront
// would need is a key anybody can read. Same rule that keeps UNSPLASH_ACCESS_KEY
// and the two supplier keys server-side. As it stands the storefront asks for
// nothing — the converted figure arrives already computed on `payment_info`,
// because the browser must never be the thing that decides what a customer owes.
//
// ─── Failure is null, never a guess ─────────────────────────────────────────
//
// No rate means no quote means the order is refused (routes/orders.js). A stale
// cached rate would be defensible for minutes and indefensible for a day, and
// there is no way from inside this file to tell which one you are holding, so
// the cache has a hard TTL and expiry is simply "no rate". A refused Cash App
// checkout is visible and recoverable; a wrong conversion is neither.
'use strict';

const axios = require('axios');
const { CURRENCY } = require('./money');

// The ECB's daily reference set, which is what frankfurter republishes. Used to
// answer "could this pair be quoted at all" WITHOUT a network call, because
// utils/paymentAddress.js has to answer that question synchronously — every
// caller of methodStates() is sync, and making them async to ask about a rate
// would reach into the panel, the bot and the checkout guard alike.
//
// A pair not on this list is not convertible, and Cash App goes back to
// reporting `currency` with its old reason. That branch stays reachable on
// purpose: if this shop ever prices in something the ECB does not publish, the
// honest answer is that the method is impossible again, not that we will make a
// rate up.
const ECB_CURRENCIES = new Set([
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD',
  'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD',
  'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
]);

// For printing an amount we did not price. money.js owns the SHOP's symbol and
// deliberately knows only one; this table is for the other side of a conversion.
const SETTLE_SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', CHF: 'CHF ' };

function settleSymbol(code) {
  return SETTLE_SYMBOLS[String(code || '').toUpperCase()] || '';
}

/** Can this pair be quoted at all? Synchronous — no network, no cache. */
function canQuote(from, to) {
  const a = String(from || '').toUpperCase();
  const b = String(to || '').toUpperCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return ECB_CURRENCIES.has(a) && ECB_CURRENCIES.has(b);
}

// A short TTL, not a long one. The ECB publishes once a working day, so a longer
// cache would still be "correct" by their clock — but the risk is not staleness
// against the ECB, it is a quote locked onto a customer's order hours after the
// process last reached the internet. Five minutes keeps the checkout path off
// the network for a burst of orders without ever putting a number on a pay
// screen that nobody has checked today.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // "EUR>USD" -> { rate, at }

// Injectable purely so the tests can drive the failure paths — a harness that
// had to reach api.frankfurter.app to check "what happens when the rate is
// unavailable" would be testing the network, and would pass for the wrong
// reason on a machine that is offline.
let fetchImpl = async (from, to) => {
  const { data } = await axios.get(
    `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { timeout: 8000 }
  );
  return data && data.rates ? data.rates[to] : null;
};

function _setFetch(fn) { fetchImpl = fn; }
function _clearCache() { cache.clear(); }

/**
 * One unit of `from` expressed in `to`, or null.
 *
 * Null covers every unhappy case — unsupported pair, timeout, malformed body,
 * a zero or negative number — because callers have exactly one correct response
 * to all of them and it is "do not quote this order".
 */
async function getRate(from, to, now = Date.now()) {
  const a = String(from || '').toUpperCase();
  const b = String(to || '').toUpperCase();
  if (!canQuote(a, b)) return null;
  if (a === b) return 1;

  const key = `${a}>${b}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.rate;

  try {
    const rate = Number(await fetchImpl(a, b));
    if (!Number.isFinite(rate) || rate <= 0) {
      console.error(`[FX] ${key} — provider returned no usable rate`);
      return null;
    }
    cache.set(key, { rate, at: now });
    return rate;
  } catch (err) {
    console.error(`[FX] ${key} rate fetch failed:`, err.message);
    return null;
  }
}

/**
 * The settlement quote that gets locked onto an order, or null.
 *
 * ── Rounding goes UP, always ──
 * `Math.ceil` to the cent, never `toFixed`. A euro total that converts to
 * $21.6049 must be quoted as $21.61, not $21.60: the customer sends exactly what
 * the screen says, and a half-cent rounded DOWN arrives as a payment that is
 * short by less than the tolerance today and short by more than it the moment
 * anyone widens the tolerance or the total gets bigger. Rounding up costs the
 * customer under a cent and can never manufacture an underpaid order out of a
 * correct payment.
 */
async function quoteSettlement(amount, to, from = CURRENCY, now = Date.now()) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  const target = String(to || '').toUpperCase();
  const source = String(from || '').toUpperCase();

  const rate = await getRate(source, target, now);
  if (rate === null) return null;

  return {
    settle_currency: target,
    settle_amount: Math.ceil(value * rate * 100) / 100,
    settle_symbol: settleSymbol(target),
    fx_rate: rate,
    fx_from: source,
    fx_source: source === target ? 'identity' : 'ecb/frankfurter',
    fx_quoted_at: new Date(now).toISOString(),
  };
}

/**
 * What a settled payment in the settlement currency is worth in the SHOP's
 * currency, at the rate that was locked onto that order.
 *
 * Needed because `orders.amount_received_cents` is a euro column. Writing a
 * dollar figure into it would be a units error of the exact kind
 * amount_received_unit exists to prevent — and it would be self-consistent
 * enough that nothing downstream could notice: $21.61 recorded as €21.61 makes
 * a correct payment look like a €1.60 overpayment forever.
 */
function backToShopCurrency(settledAmount, lockedRate) {
  const amt = Number(settledAmount);
  const rate = Number(lockedRate);
  if (!Number.isFinite(amt) || !Number.isFinite(rate) || rate <= 0) return null;
  return amt / rate;
}

module.exports = {
  canQuote, getRate, quoteSettlement, backToShopCurrency,
  settleSymbol, ECB_CURRENCIES, TTL_MS,
  _setFetch, _clearCache,
};
