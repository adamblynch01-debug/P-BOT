// Regression cover for the two defects fixed on 2026-08-06:
//
//   1. There was no way to turn a payment method OFF. Availability was derived
//      purely from whether the address parsed, so "closed on purpose" and
//      "misconfigured" were the same state and the only lever was to delete the
//      address and retype it later.
//
//   2. The pay screen's PayPal QR encoded
//      `https://www.paypal.com/paypalme/<PAYPAL_EMAIL>`. PayPal.Me takes a
//      HANDLE, never an email address, so every PayPal QR this store has ever
//      printed scanned perfectly and led to a dead page.
//
//   node test_payment_switches.js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

const P = require('./utils/paymentAddress');

// A fully working store, so every failure below is caused by the one thing the
// test changes rather than by an unrelated blank variable.
const LIVE = {
  CASHAPP_CASHTAG: '$uhservices',
  PAYPAL_EMAIL: 'shop@uhservices.xyz',
  BTC_XPUB: 'xpub6CUGRUo',
  LTC_XPUB: 'Ltub2abc',
};
const env = (over) => Object.assign({}, LIVE, over || {});

console.log('\nthe kill switch closes a method without touching its address');

check('with nothing switched off, all four are payable', () => {
  assert.deepStrictEqual(P.payableMethods(env()),
    { cashapp: true, paypal: true, btc: true, ltc: true });
});

check('PAYMENT_METHODS_OFF closes exactly the named method', () => {
  const m = P.payableMethods(env({ PAYMENT_METHODS_OFF: 'paypal' }));
  assert.strictEqual(m.paypal, false, 'paypal should be closed');
  assert.strictEqual(m.cashapp, true, 'cashapp must be untouched');
  assert.strictEqual(m.btc, true);
  assert.strictEqual(m.ltc, true);
});

check('several methods can be closed at once', () => {
  const m = P.payableMethods(env({ PAYMENT_METHODS_OFF: 'btc,ltc' }));
  assert.strictEqual(m.btc, false);
  assert.strictEqual(m.ltc, false);
  assert.strictEqual(m.cashapp, true);
});

// The whole point of the feature. Blanking the address was the old "off
// switch", and it meant coming back meant retyping a cashtag from memory.
check('switching a method off leaves its address intact', () => {
  const e = env({ PAYMENT_METHODS_OFF: 'cashapp' });
  assert.strictEqual(P.payableMethods(e).cashapp, false);
  assert.strictEqual(e.CASHAPP_CASHTAG, '$uhservices', 'the address must survive');
  // ...and turning it back on needs nothing else.
  delete e.PAYMENT_METHODS_OFF;
  assert.strictEqual(P.payableMethods(e).cashapp, true);
});

check('whitespace and case in the stored list are tolerated', () => {
  const m = P.payableMethods(env({ PAYMENT_METHODS_OFF: ' PayPal , BTC ' }));
  assert.strictEqual(m.paypal, false);
  assert.strictEqual(m.btc, false);
});

check('an empty PAYMENT_METHODS_OFF closes nothing', () => {
  assert.deepStrictEqual(P.payableMethods(env({ PAYMENT_METHODS_OFF: '' })),
    { cashapp: true, paypal: true, btc: true, ltc: true });
});

console.log('\n"switched off" and "misconfigured" are told apart');

// These two read identically at checkout and want opposite reactions from
// whoever is looking at the admin screen: one is a decision, the other is a
// fault to go and fix.
check('a closed method reports state "off"', () => {
  const s = P.methodStates(env({ PAYMENT_METHODS_OFF: 'paypal' })).paypal;
  assert.strictEqual(s.available, false);
  assert.strictEqual(s.state, 'off');
  assert.match(s.reason, /staff/i);
});

check('a method with no address reports state "unconfigured"', () => {
  const s = P.methodStates(env({ LTC_XPUB: '' })).ltc;
  assert.strictEqual(s.available, false);
  assert.strictEqual(s.state, 'unconfigured');
  assert.match(s.reason, /LTC_XPUB/);
});

check('a placeholder cashtag is unconfigured, not off', () => {
  const s = P.methodStates(env({ CASHAPP_CASHTAG: ' your $cashtag' })).cashapp;
  assert.strictEqual(s.state, 'unconfigured');
});

// If both are true, "off" must win. Reporting the address fault instead would
// make turning the method back on later look like it silently failed.
check('off beats unconfigured when both apply', () => {
  const s = P.methodStates(env({ PAYMENT_METHODS_OFF: 'ltc', LTC_XPUB: '' })).ltc;
  assert.strictEqual(s.state, 'off');
});

check('a working method reports state "on" with no reason', () => {
  const s = P.methodStates(env()).cashapp;
  assert.strictEqual(s.available, true);
  assert.strictEqual(s.state, 'on');
  assert.strictEqual(s.reason, null);
});

console.log('\ntoggleMethod builds the stored list');

check('turning one off adds it', () => {
  assert.strictEqual(P.toggleMethod('paypal', false, env()), 'paypal');
});
check('turning one on removes it and keeps the others', () => {
  assert.strictEqual(P.toggleMethod('btc', true, env({ PAYMENT_METHODS_OFF: 'btc,ltc' })), 'ltc');
});
check('the list is de-duplicated and order-stable', () => {
  assert.strictEqual(P.toggleMethod('ltc', false, env({ PAYMENT_METHODS_OFF: 'ltc,paypal,ltc' })), 'paypal,ltc');
});
// A typo that quietly no-ops would read as "the switch does not work" — and
// the moment you reach for this is the moment something is already wrong.
check('an unknown method throws instead of silently doing nothing', () => {
  assert.throws(() => P.toggleMethod('payapl', false, env()), /Unknown payment method/);
});

console.log('\nthe PayPal QR points somewhere that exists');

// The bug itself. An email address is not a PayPal.Me handle, so the old
// `paypalme/${payment_info.email}` URL could never resolve.
check('an email address is NOT accepted as a PayPal.Me handle', () => {
  assert.strictEqual(P.normalisePaypalMe('shop@uhservices.xyz'), null);
});
check('no handle configured means no link at all', () => {
  assert.strictEqual(P.paypalMeLink('', 10), null);
  assert.strictEqual(P.paypalMeLink(undefined, 10), null);
  assert.strictEqual(P.paypalMeLink('shop@uhservices.xyz', 10), null);
});
check('a bare handle is accepted', () => {
  assert.strictEqual(P.normalisePaypalMe('uhservices'), 'uhservices');
});
check('the four shapes an owner might paste all reduce to the handle', () => {
  for (const v of ['uhservices', '@uhservices', 'paypal.me/uhservices',
                   'https://www.paypal.me/uhservices/',
                   'https://www.paypal.com/paypalme/uhservices']) {
    assert.strictEqual(P.normalisePaypalMe(v), 'uhservices', `failed on ${JSON.stringify(v)}`);
  }
});
check('a handle with a space is refused', () => {
  assert.strictEqual(P.normalisePaypalMe('uh services'), null);
});
// Two decimal places, always. PayPal.Me reads the amount out of the path, and
// a mistyped total is an underpaid order somebody settles by hand.
check('the amount is carried in the link, to the cent', () => {
  assert.strictEqual(P.paypalMeLink('uhservices', 1.1),
    'https://www.paypal.com/paypalme/uhservices/1.10');
  assert.strictEqual(P.paypalMeLink('uhservices', 12),
    'https://www.paypal.com/paypalme/uhservices/12.00');
});
check('a missing or nonsense amount still yields a usable link', () => {
  assert.strictEqual(P.paypalMeLink('uhservices'), 'https://www.paypal.com/paypalme/uhservices');
  assert.strictEqual(P.paypalMeLink('uhservices', 0), 'https://www.paypal.com/paypalme/uhservices');
  assert.strictEqual(P.paypalMeLink('uhservices', NaN), 'https://www.paypal.com/paypalme/uhservices');
});
// Set-but-unusable is the failure class that started this whole audit: the
// owner believes it is configured, and it silently is not.
check('a PAYPAL_ME that cannot be parsed is reported at startup', () => {
  const probs = P.addressProblems(env({ PAYPAL_ME: 'not a handle!' }));
  assert.ok(probs.some(p => /PAYPAL_ME/.test(p)), 'startup check stayed silent');
});
check('an unset PAYPAL_ME is not a problem — PayPal still works by email', () => {
  assert.deepStrictEqual(P.addressProblems(env()), []);
});

console.log('\nthe order route refuses a closed method (fails closed)');

const ordersSrc = fs.readFileSync(path.join(__dirname, 'routes', 'orders.js'), 'utf8');

// Hiding a button is decoration. A stale browser tab, a bookmarked request or
// anyone with curl must still be refused.
check('createOrderPriced consults methodStates, not just the address', () => {
  const fn = ordersSrc.slice(ordersSrc.indexOf('async function createOrderPriced'));
  assert.ok(/methodStates\(\)\[payment_method\]/.test(fn.slice(0, 3000)),
    'the guard does not read the switch');
  assert.ok(/statusCode = 503/.test(fn.slice(0, 3000)));
});

// BTC and LTC had NO guard at all: with no xpub, generateCryptoAddress returns
// null and the buyer got a pay screen with an empty address on it — the same
// silent failure the cashapp/paypal guard was written to prevent, sitting one
// branch away the whole time.
check('the guard covers crypto too, not just cashapp and paypal', () => {
  const fn = ordersSrc.slice(ordersSrc.indexOf('async function createOrderPriced'), ordersSrc.indexOf('const subtotalCents'));
  assert.ok(!/payment_method === 'cashapp' && !isPayableCashtag/.test(fn),
    'still using the two-method guard');
  assert.ok(/state && !state\.available/.test(fn), 'no all-method availability check');
});

check('the pay screen link is built by the SERVER, not the browser', () => {
  assert.ok(/pay_link: paypalMeLink\(process\.env\.PAYPAL_ME, total\)/.test(ordersSrc),
    'payment_info carries no server-built pay_link');
});

console.log('\nthe storefront hides a closed method instead of erroring after the click');

const SITE = 'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG/index.html';
if (fs.existsSync(SITE)) {
  const site = fs.readFileSync(SITE, 'utf8');
  const render = site.slice(site.indexOf('function renderPayMethods'), site.indexOf('window.selectPayMethod'));

  check('the four tiles are no longer hardcoded', () => {
    assert.ok(!/\.concat\(\['cashapp', 'paypal', 'btc', 'ltc'\]\)/.test(render),
      'renderPayMethods still concatenates all four unconditionally');
    assert.ok(/filter\(methodAvailable\)/.test(render), 'availability is not filtered');
  });

  // The QR is the reported bug. An email address in a paypalme/ path resolves
  // to a "page not found" — it scanned fine and went nowhere.
  check('the PayPal QR no longer encodes the email address', () => {
    assert.ok(!/paypalme\/\$\{payment_info\.email\}/.test(site),
      'the QR is still built from PAYPAL_EMAIL — that URL cannot resolve');
  });
  check('the PayPal QR uses the server-supplied link', () => {
    assert.ok(/payment_method === 'paypal'\s+&& payment_info\.pay_link\) qrData = payment_info\.pay_link/.test(site),
      'qrData for paypal is not payment_info.pay_link');
  });
  check('no handle configured means no QR is rendered', () => {
    // qrData stays null, and the template already guards on it.
    assert.ok(/\$\{qrData \? `<div class="pay-qr">/.test(site), 'the QR is not conditional on qrData');
  });
  check('a selection that disappears is cleared, not submitted', () => {
    assert.ok(/!methods\.includes\(paySelectedMethod\)/.test(render),
      'a method closed mid-checkout could still be sent to /api/orders/create');
  });
  check('every method closed shows a message, not an empty box', () => {
    assert.ok(/if \(!methods\.length\)/.test(render));
  });
  // Cached forever, it would keep offering a method closed hours ago.
  check('the config is re-read each time the overlay opens', () => {
    const load = site.slice(site.indexOf('async function loadPayConfig'), site.indexOf('function feeForMethod'));
    assert.ok(!/if \(payConfig\) return;/.test(load), 'loadPayConfig still caches for the life of the tab');
  });
} else {
  console.log('  SKIP  storefront not found at the expected path');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
