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

// This check has now been rewritten twice, and the history is the point.
// Originally: "back on the moment a real cashtag is set" — true. Then the shop
// moved to euro, Cash App settles USD/GBP only, and it became "a real cashtag
// no longer brings it back — nothing does". Now there is a bridge: the order is
// priced in euro and the buyer is asked for the dollar equivalent at a locked
// rate, so a real cashtag DOES bring it back, and the two halves that came
// apart have gone back together for a different reason than the first time.
check('a real cashtag brings Cash App back, on the dollar bridge', () => {
  assert.strictEqual(P.isPayableCashtag('$uhservices'), true, 'a valid cashtag stopped parsing');
  const m = P.payableMethods({ CASHAPP_CASHTAG: '$uhservices' });
  assert.strictEqual(m.cashapp, true, 'a configured, unswitched-off Cash App was not offered');
});

check('the raw currency fact is unchanged — only the workaround is new', () => {
  // currencyUnsupported was NOT relaxed to make this work. It still says what
  // is true of the method; currencyBridged is a separate question about whether
  // we have a way around it. Collapsing the two would leave the pay screen with
  // no reason to tell the buyer they are sending dollars.
  assert.strictEqual(P.currencyUnsupported('cashapp'), true);
  assert.strictEqual(P.currencyBridged('cashapp'), true);
  const s = P.methodStates({ CASHAPP_CASHTAG: '$uhservices', PAYPAL_EMAIL: 'a@b.co' });
  assert.strictEqual(s.cashapp.state, 'on', JSON.stringify(s.cashapp));
  assert.strictEqual(s.cashapp.settle_currency, 'USD');
  assert.ok(/EUR/.test(s.cashapp.note), 'the note does not name the shop currency: ' + s.cashapp.note);
  assert.ok(/USD/.test(s.cashapp.note), 'the note does not say what it will collect: ' + s.cashapp.note);
  // And the methods that can take any currency are untouched by all this — no
  // note, because there is nothing to explain.
  assert.strictEqual(s.paypal.state, 'on');
  assert.strictEqual(s.paypal.settle_currency, undefined);
});

check('currency, off and unconfigured are three states, reported in that order', () => {
  // The `currency` state is unreachable for every method this shop has, now
  // that the dollar gap is bridged. It is exercised through the currency
  // parameter rather than deleted: a shop priced in something the ECB does not
  // publish gets it back, and it is the one state an operator cannot act on —
  // flipping the toggle will not help and fixing the cashtag will not help.
  const s = P.methodStates(
    { CASHAPP_CASHTAG: '$uhservices', PAYMENT_METHODS_OFF: 'cashapp,paypal', PAYPAL_EMAIL: 'a@b.co' },
    'XBT');
  assert.strictEqual(s.cashapp.state, 'currency', JSON.stringify(s.cashapp));
  assert.ok(/XBT/.test(s.cashapp.reason), 'the reason does not name the shop currency: ' + s.cashapp.reason);
  assert.ok(/USD|GBP/.test(s.cashapp.reason), 'the reason does not say what it CAN take: ' + s.cashapp.reason);
  assert.strictEqual(s.paypal.state, 'off', 'a deliberately-closed method must not read as broken');
  // Unactionable outranks the off-switch, and the off-switch outranks the
  // bridge. Cash App here is BOTH switched off and unquotable, and reports the
  // one nobody can do anything about.
  assert.strictEqual(P.payableMethods({ CASHAPP_CASHTAG: '$uhservices' }, 'XBT').cashapp, false);
});

check('a currency block is a property of the METHOD, not a hardcoded Cash App rule', () => {
  assert.strictEqual(P.currencyUnsupported('cashapp', 'USD'), false, 'Cash App would not come back in a dollar shop');
  assert.strictEqual(P.currencyUnsupported('cashapp', 'GBP'), false);
  assert.strictEqual(P.currencyUnsupported('cashapp', 'EUR'), true);
  // Crypto is quoted from a live fiat rate and PayPal carries the ISO code in
  // the link, so neither is ever currency-blocked.
  for (const m of ['paypal', 'btc', 'ltc']) {
    assert.strictEqual(P.currencyUnsupported(m, 'EUR'), false, m + ' was blocked for the shop currency');
  }
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

// Repinned 2026-08-06. This used to assert the two literal calls
// `isPayableCashtag(process.env.CASHAPP_CASHTAG)` and `isPayableEmail(...)`
// inside createOrderPriced — the implementation, not the rule. The guard has
// since been generalised to methodStates(), which covers all FOUR methods
// (btc and ltc had no guard at all) and also honours the on/off switch, so the
// old assertions failed on a change that made the thing they protect stricter.
//
// What must stay true is the rule: an order for a method that cannot be paid
// is refused BEFORE the row is written, with a status the buyer can act on.
// So that is what this checks now — the behaviour through payableMethods, plus
// the one structural fact a source test can actually establish, which is that
// the refusal sits ahead of the pricing.
check('an order is refused before the row is written, not after', () => {
  const s = src('routes/orders.js');
  const fn = s.slice(s.indexOf('async function createOrderPriced'), s.indexOf('const subtotalCents = subtotalCentsOf(items)'));
  assert.ok(/methodStates\(\)\[payment_method\]/.test(fn),
    'the guard no longer consults the per-method state');
  assert.ok(/!state\.available/.test(fn), 'nothing refuses an unpayable method');
  assert.ok(/statusCode = 503/.test(fn), 'the buyer gets a 500 they cannot act on');

  // And the rule itself, exercised rather than pattern-matched: the placeholder
  // that started all this is still not payable, so the guard above still fires.
  const { methodStates } = require('./utils/paymentAddress');
  const st = methodStates({ CASHAPP_CASHTAG: ' your $cashtag', PAYPAL_EMAIL: 'your@paypal.com' });
  assert.strictEqual(st.cashapp.available, false, 'a placeholder cashtag is payable again');
  assert.strictEqual(st.paypal.available, false, 'a placeholder PayPal address is payable again');
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
