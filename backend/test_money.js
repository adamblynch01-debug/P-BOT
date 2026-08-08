// ─── the shop's currency, pinned ──────────────────────────────────────────────
//
// The euro switch touched ~90 template literals in this backend, ~150 in
// index.html, the CoinGecko rate, the PayPal.Me suffix, the email watcher's
// foreign-currency guard and one SQL column. Almost all of that is now DERIVED
// from utils/money.js, which is the right shape — but derived assertions only
// prove the codebase is CONSISTENT. Flip SYMBOL to '$' and every other test in
// this directory still passes, because everything would print dollars together.
//
// This file is the one place that pins the value, and the one place that checks
// the things which are NOT derivable:
//
//   • index.html is hand-uploaded and is not `require`-able. Nothing in the
//     deploy makes its GX_CURRENCY follow the backend's, so it is read as text.
//   • `amount_received_unit` is a SQL string literal. It records what unit a
//     figure is in, and a row saying 'usd' next to a euro amount is a lie that
//     survives every later reading of that row.
//   • The email watcher's foreign-currency list is defined by what it EXCLUDES.
//     Deleting EUR from it is not the same as adding USD to it, and only the
//     second one closes the hole the first one opens.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CURRENCY, SYMBOL, money, moneyCents, parseMoneyText, FOREIGN_SYMBOLS } = require('./utils/money');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}

const STOREFRONT = process.env.STOREFRONT_HTML ||
  'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG/index.html';

console.log('\nthe declaration');

check('the shop sells in euro — changing this means changing SUPERBOT modules/money.js too', () => {
  assert.strictEqual(CURRENCY, 'EUR');
  assert.strictEqual(SYMBOL, '€');
});

check('rendering is symbol-first, two decimals, and never "€NaN"', () => {
  assert.strictEqual(money(7.99), '€7.99');
  assert.strictEqual(moneyCents(2599), '€25.99');
  assert.strictEqual(money(undefined), '€0.00');
  assert.strictEqual(moneyCents(null), '€0.00');
});

check('our own symbol is not in the foreign-symbol set', () => {
  // If it were, the email watcher would reject every receipt we quote.
  assert.ok(!FOREIGN_SYMBOLS.test(SYMBOL), `${SYMBOL} counted as foreign`);
  assert.ok(FOREIGN_SYMBOLS.test('$') && FOREIGN_SYMBOLS.test('£'));
});

console.log('\nreading an amount out of a provider receipt');

check('a euro-locale decimal comma is not a thousands separator', () => {
  // The old `.replace(/,/g,'')` read "1.234,56" as 1.234 — a 1000x UNDERread,
  // which does not fail loudly. It writes status='underpaid' onto a fully paid
  // order and files an alert accusing the customer of short-changing us.
  assert.strictEqual(parseMoneyText('19,99'), 19.99);
  assert.strictEqual(parseMoneyText('1.234,56'), 1234.56);
  assert.strictEqual(parseMoneyText('1,234.56'), 1234.56);
});

check('and a real thousands separator still is one', () => {
  assert.strictEqual(parseMoneyText('1,100'), 1100);
  assert.strictEqual(parseMoneyText('1.100'), 1100);
});

check('no number is null, not 0 — a receipt with no amount must not read as paid', () => {
  assert.strictEqual(parseMoneyText('thanks for your payment'), null);
  assert.strictEqual(parseMoneyText(''), null);
  assert.strictEqual(parseMoneyText('0.00'), 0);
});

console.log('\nthe guard is defined by what it excludes');

check('EUR is not treated as a foreign currency, and USD and GBP are', () => {
  // Deleting EUR from the list is half the job. The other half is that the
  // symbol PayPal prints for a dollar receipt is shared with CAD, AUD, MXN and
  // SGD, so a store that stops rejecting "$" stops being able to tell a US
  // dollar receipt from four other currencies.
  const { FOREIGN_CURRENCY } = require('./watchers/emailWatcher').__test__;
  assert.ok(!FOREIGN_CURRENCY.test('You received 19,99 EUR'), 'EUR rejected as foreign');
  assert.ok(FOREIGN_CURRENCY.test('You received $19.99 USD'), 'USD accepted as ours');
  assert.ok(FOREIGN_CURRENCY.test('You received £19.99 GBP'), 'GBP accepted as ours');
});

check('a Cash App handle is a sigil, not a currency', () => {
  // "You received €19.99 to $ghoststore" — every Cash App receipt names a
  // cashtag, and a symbol scan that did not drop them would reject every Cash
  // App payment with a reason quoting a "$" the customer never sent.
  const { foreignCurrencyReason } = require('./watchers/emailWatcher').__test__;
  assert.strictEqual(foreignCurrencyReason('You received €19.99 to $ghoststore'), null);
  assert.ok(foreignCurrencyReason('You received $19.99 to $ghoststore'),
    'a real dollar amount alongside a cashtag must still be caught');
});

console.log('\nthe currency-dependent things that contain no symbol at all');

check('the crypto quote asks CoinGecko for the shop currency', () => {
  // A euro cart quoted against a dollar rate is out by the EUR/USD spread, and
  // because the rate is LOCKED onto the order, verification then confirms the
  // wrong number of satoshis as correct — wrong, and self-consistently wrong.
  const src = fs.readFileSync(path.join(__dirname, 'utils/cryptoUtils.js'), 'utf8');
  assert.ok(/vs_currencies=\$\{VS_CURRENCY\}/.test(src), 'the rate URL hardcodes a currency');
  assert.ok(/const VS_CURRENCY = CURRENCY\.toLowerCase\(\)/.test(src), 'VS_CURRENCY is not derived');
  assert.ok(/data\[id\]\[VS_CURRENCY\]/.test(src), 'the response is read under a hardcoded key');
});

check('the PayPal.Me link names the currency it wants collected', () => {
  // A bare /12.34 charges in the RECIPIENT ACCOUNT's currency, so a euro store
  // with a dollar-denominated PayPal account bills dollars while quoting euro —
  // and the link WORKS, which is why nobody would notice.
  const { paypalMeLink } = require('./utils/paymentAddress');
  const link = paypalMeLink('uhservices', 12.34);
  assert.ok(link.endsWith(`/12.34${CURRENCY}`), link);
});

check('a fiat amount received is recorded in the shop currency, never usd', () => {
  const unit = CURRENCY.toLowerCase();
  const offenders = [];
  for (const rel of ['watchers/emailWatcher.js', 'routes/orders.js', 'routes/webhooks.js', 'watchers/cryptoWatcher.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    src.split('\n').forEach((line, i) => {
      const m = /amount_received_unit\s*=\s*'([a-z]+)'/.exec(line);
      // 'sats' is the crypto rows' genuine native unit and is not fiat.
      if (m && m[1] !== 'sats' && m[1] !== unit) offenders.push(`${rel}:${i + 1}  ${m[1]}`);
    });
  }
  assert.strictEqual(offenders.length, 0, 'wrong unit recorded:\n        ' + offenders.join('\n        '));
});

console.log('\nthe storefront is hand-uploaded, so nothing but this checks it');

check('index.html declares the same currency the backend does', () => {
  const html = fs.readFileSync(STOREFRONT, 'utf8');
  const cur = /var GX_CURRENCY = '([^']+)'/.exec(html);
  const sym = /var GX_SYMBOL = '([^']+)'/.exec(html);
  assert.ok(cur && sym, 'GX_CURRENCY / GX_SYMBOL not found — has the page been rewritten?');
  assert.strictEqual(cur[1], CURRENCY, 'the page and the backend disagree on the currency');
  assert.strictEqual(sym[1], SYMBOL, 'the page and the backend disagree on the symbol');
});

check('no page price is read back with parseFloat after stripping punctuation', () => {
  // The silent killer. Stripping `[^0-9.]` off "€1.234,56" leaves 1.234.56;
  // stripping a symbol BY NAME leaves "€" in place and parseFloat returns NaN,
  // which `isNaN ? 0` then adds to the cart at zero — a bug that reads to the
  // customer as a discount rather than a fault.
  const html = fs.readFileSync(STOREFRONT, 'utf8');
  const offenders = [];
  html.split('\n').forEach((line, i) => {
    // A comment QUOTING the old form is the record of why it was removed; it is
    // not a call site. Matching it would make the check cry wolf, and a check
    // that cries wolf gets deleted the first time somebody is in a hurry.
    if (/^\s*(\/\/|\*|<!--)/.test(line)) return;
    if (/parseFloat\s*\([^)]*\.replace\s*\(/.test(line)) offenders.push(`${i + 1}  ${line.trim().slice(0, 90)}`);
  });
  assert.strictEqual(offenders.length, 0, 'raw price parses left behind:\n        ' + offenders.join('\n        '));
});

check('nothing in the backend renders money with a hardcoded symbol', () => {
  // A grep, not a call. No behavioural test can see a NEW site added later.
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js') || e.name.startsWith('test_')) continue;
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (/\$\$\{[^}]*toFixed\(2\)/.test(line) || /'\$'\s*\+/.test(line)) {
          offenders.push(`${path.relative(__dirname, full)}:${i + 1}  ${line.trim().slice(0, 80)}`);
        }
      });
    }
  };
  walk(__dirname);
  assert.strictEqual(offenders.length, 0, 'dollar renders left behind:\n        ' + offenders.join('\n        '));
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
