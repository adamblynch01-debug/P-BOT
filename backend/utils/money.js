// ─── The shop's currency, in one place ───────────────────────────────────────
//
// The store priced in US dollars from the day it was written, and "USD" was
// never a value anywhere — it was the ABSENCE of a decision. A `$` was typed
// into ~90 template literals across the backend and ~150 across index.html, the
// crypto quote asked CoinGecko for `vs_currencies=usd`, and the one column that
// names a unit (`orders.amount_received_unit`) had `'usd'` hardcoded at four
// sites. Nothing declared the currency, so nothing could be changed in one edit.
//
// This module is that declaration. Anything that prints money, parses money, or
// records what unit a figure is in reads it from here.
//
// ─── Why the symbol alone was never the job ──────────────────────────────────
//
// Three things in this codebase depend on the currency and contain no `$` at
// all, so a find-and-replace would have left every one of them silently wrong:
//
//   1. utils/cryptoUtils.js asked CoinGecko for a USD rate. A EUR cart quoted
//      against a USD rate is out by the EUR/USD spread — and because the rate is
//      LOCKED onto the order, verifyCryptoPayment then confirms the wrong number
//      of satoshis as correct. Wrong, and self-consistently wrong.
//   2. utils/paymentAddress.js builds a PayPal.Me link whose bare `/12.34`
//      suffix charges in the RECIPIENT ACCOUNT's currency. A euro store with a
//      dollar-denominated PayPal account bills dollars while quoting euro.
//   3. watchers/emailWatcher.js listed EUR as a foreign currency to REJECT.
//
// ─── Decimal separator: we print a DOT, and read either ──────────────────────
//
// Most euro locales write €1.234,56. We print €1234.56 — dot decimal, no
// thousands separator — because every parse site in this codebase is a
// `parseFloat` after stripping non-digits, and `parseFloat('1.234,56')` is
// 1.234. Printing comma decimals would mean a 1000x underread anywhere a
// rendered price is read back, which index.html does in ten places.
//
// That choice is ours to make on the way OUT. On the way IN it is not: PayPal
// formats its receipts by the payer's locale, so parseMoneyText() below has to
// accept both. That asymmetry is the whole reason this file has a parser in it.
'use strict';

const CURRENCY = 'EUR';
const SYMBOL = '€';

/** Dollars/euro (a float) → "€7.99". */
function money(amount) {
  return SYMBOL + (Number(amount) || 0).toFixed(2);
}

/** Integer cents → "€7.99". The form most of the backend needs. */
function moneyCents(cents) {
  return SYMBOL + ((Number(cents) || 0) / 100).toFixed(2);
}

// Every currency symbol a payment provider might put in front of a number.
// Used both to strip them when parsing and — in the email watcher — as evidence
// that a receipt is NOT in our currency.
const FOREIGN_SYMBOLS = /[$£¥₹₽₩]/;

/**
 * Reads a money figure out of provider text, in either separator convention.
 *
 * "1,234.56" and "1.234,56" are the SAME AMOUNT written by two locales, and
 * neither is tagged. The old parser did `.replace(/,/g,'')` — correct for the
 * first, and for the second it produced 1.234.56, which parseFloat truncates to
 * 1.234. A €1,234.56 payment recorded as €1.23 is not a parse failure that
 * anybody notices; it writes `status='underpaid'` on a fully-paid order and
 * files an alert saying the customer short-changed us by 99.9%.
 *
 * The rule, which needs no locale flag:
 *
 *   • Both separators present → the LAST one is the decimal point, because no
 *     convention puts a grouping separator after the decimal one.
 *   • One separator, 1-2 digits after it → decimal ("19.99", "19,99").
 *   • One separator, exactly 3 digits after it → GROUPING ("1,100" = 1100).
 *     A currency amount is never written to three decimal places, so this is
 *     the only reading that can be meant.
 *   • One separator, 4+ digits after it → decimal, since no grouping is that
 *     wide. (Not a real receipt; it just must not silently return garbage.)
 *
 * Returns null rather than NaN when there is no number, so callers keep using
 * Number.isFinite() as the "did we read an amount" test — and the email
 * watcher's refuse-to-confirm-without-an-amount guard keeps working.
 */
function parseMoneyText(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const digits = s.replace(/[^\d.,]/g, '');
  if (!/\d/.test(digits)) return null;

  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  let normalised;

  if (lastDot > -1 && lastComma > -1) {
    const dec = Math.max(lastDot, lastComma);
    normalised = digits.slice(0, dec).replace(/[.,]/g, '') + '.' + digits.slice(dec + 1).replace(/[.,]/g, '');
  } else if (lastDot > -1 || lastComma > -1) {
    const dec = Math.max(lastDot, lastComma);
    const after = digits.slice(dec + 1);
    const before = digits.slice(0, dec);
    // A single separator appearing more than once is grouping by definition
    // ("1,234,567"), so only a lone one can be a decimal point.
    const lone = (digits.match(/[.,]/g) || []).length === 1;
    normalised = (lone && after.length !== 3)
      ? before.replace(/[.,]/g, '') + '.' + after
      : digits.replace(/[.,]/g, '');
  } else {
    normalised = digits;
  }

  const value = parseFloat(normalised);
  return Number.isFinite(value) ? value : null;
}

module.exports = { CURRENCY, SYMBOL, money, moneyCents, parseMoneyText, FOREIGN_SYMBOLS };
