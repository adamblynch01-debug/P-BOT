// Round 38 — the placeholder cashtag that was live.
//
// Found by reading GET /api/config on production on 2026-08-06:
//
//   payment_methods: {"cashapp":true, ...}
//   cashapp_cashtag: " your $cashtag"
//
// Every gate in the codebase asked "is the variable non-empty", and that string
// is non-empty. So Cash App was advertised at checkout and the pay screen was
// handed a cashtag that does not exist — an order the buyer cannot pay, which
// then expires looking exactly like a buyer who changed their mind.
//
//   node backend/test_payment_address.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('./utils/paymentAddress');

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};
const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');

console.log('\nwhat counts as an address somebody can send money to');

check('THE string that was on production is refused', () => {
  assert.strictEqual(P.isPayableCashtag(' your $cashtag'), false);
});

check('a real cashtag is accepted, with or without the whitespace of a paste', () => {
  assert.strictEqual(P.isPayableCashtag('$uhservices'), true);
  assert.strictEqual(P.isPayableCashtag('  $UH_Pay99  '), true);
});

check('near-misses are refused rather than published', () => {
  for (const bad of ['', '   ', 'uhservices', '$', '$has space', '$toolong' + 'x'.repeat(20),
                     '$bad-dash', 'your $cashtag', '$café', null, undefined, 0]) {
    assert.strictEqual(P.isPayableCashtag(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

check('a syntactically valid but obviously copied-from-the-docs value is refused', () => {
  // `$cashtag` and `$YourCashtag` both pass the regex. Neither is an account.
  assert.strictEqual(P.isPayableCashtag('$cashtag'), false);
  assert.strictEqual(P.isPayableCashtag('$YOURCASHTAG'), false);
  assert.strictEqual(P.isPayableCashtag('$your_cashtag'), false);
  assert.strictEqual(P.isPayableEmail('your@paypal.com'), false);
});

check('the PayPal address on production is fine and stays fine', () => {
  assert.strictEqual(P.isPayableEmail('someone@gmail.com'), true);
  assert.strictEqual(P.isPayableEmail('not an email'), false);
  assert.strictEqual(P.isPayableEmail(''), false);
});

console.log('\na method that cannot be paid is not offered');

check('payableMethods turns Cash App off for the live value', () => {
  const m = P.payableMethods({ CASHAPP_CASHTAG: ' your $cashtag', PAYPAL_EMAIL: 'a@b.co', BTC_XPUB: 'xpub' });
  assert.deepStrictEqual(m, { cashapp: false, paypal: true, btc: true, ltc: false });
});

check('and back on the moment a real one is set', () => {
  const m = P.payableMethods({ CASHAPP_CASHTAG: '$uhservices' });
  assert.strictEqual(m.cashapp, true);
});

check('the problem is explained, naming the variable and the value', () => {
  const [line] = P.addressProblems({ CASHAPP_CASHTAG: ' your $cashtag' });
  assert.ok(/CASHAPP_CASHTAG/.test(line), line);
  assert.ok(/your \$cashtag/.test(line), 'the actual value is not quoted back, so the typo is invisible');
  assert.deepStrictEqual(P.addressProblems({ CASHAPP_CASHTAG: '$uhservices' }), []);
  // An UNSET variable is a different complaint, made by the startup check.
  assert.deepStrictEqual(P.addressProblems({}), []);
});

console.log('\nand the three places that used to trust a non-empty string');

check('GET /api/config no longer reports a placeholder as a method or an address', () => {
  const s = src('routes/config.js');
  assert.ok(!/cashapp: !!process\.env\.CASHAPP_CASHTAG/.test(s), 'the non-empty test is still there');
  assert.ok(/payment_methods: payableMethods\(\)/.test(s));
  assert.ok(/isPayableCashtag\(process\.env\.CASHAPP_CASHTAG\) \?/.test(s),
    'the placeholder is still served as cashapp_cashtag for a caller to print');
});

check('POST /api/config/update refuses to SAVE one', () => {
  // This is the door it came in through, with a success message.
  const s = src('routes/config.js');
  assert.ok(/'CASHAPP_CASHTAG' && String\(value \|\| ''\)\.trim\(\) && !isPayableCashtag\(value\)/.test(s));
  assert.ok(/'PAYPAL_EMAIL' && String\(value \|\| ''\)\.trim\(\) && !isPayableEmail\(value\)/.test(s));
});

check('an order is refused before the row is written, not after', () => {
  const s = src('routes/orders.js');
  const fn = s.slice(s.indexOf('async function createOrderPriced'), s.indexOf('const subtotalCents = subtotalCentsOf(items)'));
  assert.ok(/isPayableCashtag\(process\.env\.CASHAPP_CASHTAG\)/.test(fn),
    'a Cash App order is still created against a placeholder');
  assert.ok(/isPayableEmail\(process\.env\.PAYPAL_EMAIL\)/.test(fn));
  assert.ok(/statusCode = 503/.test(fn), 'the buyer gets a 500 they cannot act on');
});

check('the placeholder FALLBACKS are gone from the pay screen', () => {
  // `|| '$YOUR_CASHTAG'` only ever fired on an empty variable, so it never
  // caught the real case — and leaving it in is a second way to publish an
  // address nobody owns.
  const s = src('routes/orders.js');
  assert.ok(!/\$YOUR_CASHTAG/.test(s), 'the cashtag fallback is still there');
  assert.ok(!/your@paypal\.com/.test(s), 'the paypal fallback is still there');
});

check('both routes that create an order pass the refusal through', () => {
  assert.ok(/statusCode === 503/.test(src('routes/orders.js')), '/api/orders/create swallows it into a 500');
  assert.ok(/statusCode === 503/.test(src('routes/balance.js')), 'a top-up swallows it into a 500');
});

check('the startup check complains about SET-but-unusable, not only about missing', () => {
  const s = src('server.js');
  assert.ok(/addressProblems\(\)/.test(s), 'boot is still silent about a placeholder');
  assert.ok(/!addressProblems\(\)\.length/.test(s), 'it would still print "Environment check passed"');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
