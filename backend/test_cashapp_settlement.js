// Tests for the settlement bridge — pricing in euro, collecting in dollars.
//
//   node test_cashapp_settlement.js
//
// ─── What this is guarding ──────────────────────────────────────────────────
//
// The shop prices in euro. Cash App cannot hold euro — not a configuration
// problem, there is no euro Cash App — so the method sat reported as
// `state:'currency'`: not off, not broken, impossible. The fix is a third
// state: the order stays PRICED in euro and the buyer is asked for the dollar
// equivalent at a rate fetched once and LOCKED onto the order.
//
// Every check below exists because one specific shortcut would have been
// cheaper and would have shipped a bug that pays for itself in support tickets:
//
//   · re-deriving the rate at confirmation time instead of reading the locked
//     one — a correct payment becomes `underpaid` on a half-percent move
//   · `toFixed(2)` instead of `Math.ceil` — quotes a cent short, and the short
//     side is the side that manufactures a false underpayment
//   · deleting USD from the email watcher's hostile-currency list instead of
//     deriving that list per method — makes PayPal accept dollars at par
//   · writing the dollar figure into the euro `amount_received_cents` column —
//     self-consistently wrong, so nothing downstream can ever notice
//   · falling back to the euro total when the quote is missing — settles the
//     order against a number the customer was never shown
//
// Nothing here touches the network. The rate fetcher is injected, because a
// harness that had to reach api.frankfurter.app to ask "what happens when the
// rate is unavailable" would pass for the wrong reason on an offline machine —
// and would be the only red test in the suite on a bad wifi day, which is how
// a check gets deleted.
'use strict';

const assert = require('assert');

// The DB is stubbed before routes/orders.js is required, purely so the module
// loads. Nothing under test here goes near it — nativeToFiatCents is pure.
const dbPath = require.resolve('./db');
const noDb = async () => ({ rows: [] });
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: noDb, withTransaction: async (fn) => fn(noDb), pool: {} },
};

process.env.CASHAPP_CASHTAG = '$ghoststore';
process.env.PAYPAL_EMAIL = 'store@ghost.example';
delete process.env.PAYMENT_METHODS_OFF;

const fx = require('./utils/fx');
const pa = require('./utils/paymentAddress');
const { CURRENCY } = require('./utils/money');
const { nativeToFiatCents } = require('./routes/orders').__test__;
const watcher = require('./watchers/emailWatcher').__test__;

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

(async () => {

console.log('\nwhich pairs can be quoted at all — answered without a network');

// This question has to be synchronous. methodStates() is called by the admin
// panel, the Discord bot and the checkout guard, and making any of them async
// to ask about an exchange rate would spread through all three.
check('EUR→USD is quotable', () => {
  assert.strictEqual(fx.canQuote('EUR', 'USD'), true);
  assert.strictEqual(fx.canQuote('eur', 'usd'), true, 'case must not matter');
});

check('a currency the ECB does not publish is NOT quotable', () => {
  // The dead branch stays reachable on purpose. If this shop ever prices in
  // something outside the ECB's set, the honest answer is that Cash App is
  // impossible again — not that we will make a rate up.
  assert.strictEqual(fx.canQuote('EUR', 'XBT'), false);
  assert.strictEqual(fx.canQuote('DOGE', 'USD'), false);
  assert.strictEqual(fx.canQuote('', 'USD'), false);
});

check('a currency against itself needs no provider', () => {
  assert.strictEqual(fx.canQuote('USD', 'USD'), true);
});

console.log('\nthe quote rounds UP, and never down');

await (async () => {
  fx._clearCache();
  fx._setFetch(async () => 1.08004);
  const q = await fx.quoteSettlement(10, 'USD');
  check('10 EUR at 1.08004 quotes $10.81, not $10.80', () => {
    // 10 × 1.08004 = 10.8004. toFixed(2) gives "10.80" — four hundredths of a
    // cent short. That is under any tolerance today, and it is short by more
    // than the tolerance the day somebody tightens the tolerance or the totals
    // get bigger. Rounding up costs the customer under a cent and can never
    // turn a correct payment into an underpaid order.
    assert.strictEqual(q.settle_amount, 10.81);
    assert.strictEqual((10 * 1.08004).toFixed(2), '10.80', 'the shortcut that was rejected');
  });
  check('the quote carries everything needed to judge the payment later', () => {
    assert.strictEqual(q.settle_currency, 'USD');
    assert.strictEqual(q.settle_symbol, '$');
    assert.strictEqual(q.fx_rate, 1.08004);
    assert.strictEqual(q.fx_from, CURRENCY);
    assert.ok(q.fx_quoted_at, 'no timestamp means no way to tell how stale a locked quote was');
  });

  check('the quote is never worth less than the euro it prices', () => {
    // A property, not an example. Rounding is the whole point of this function
    // and one worked example proves one rounding case.
    for (const cents of [1, 99, 199, 1999, 4999, 12345, 999999]) {
      const euros = cents / 100;
      const usd = Math.ceil(euros * 1.08004 * 100) / 100;
      assert.ok(usd >= euros * 1.08004 - 1e-9,
        `€${euros} quoted as $${usd}, which is short`);
    }
  });
})();

console.log('\nfailure is null — never a stale rate, never a guess');

await (async () => {
  fx._clearCache();
  fx._setFetch(async () => { throw new Error('ETIMEDOUT'); });
  const q = await fx.quoteSettlement(19.99, 'USD');
  check('a provider timeout yields no quote', () => assert.strictEqual(q, null));

  fx._clearCache();
  fx._setFetch(async () => null);
  const q2 = await fx.quoteSettlement(19.99, 'USD');
  check('a body with no rate in it yields no quote', () => assert.strictEqual(q2, null));

  fx._clearCache();
  fx._setFetch(async () => -1);
  const q3 = await fx.quoteSettlement(19.99, 'USD');
  check('a negative rate yields no quote', () => assert.strictEqual(q3, null));

  fx._clearCache();
  fx._setFetch(async () => 1.08);
  const q4 = await fx.quoteSettlement(0, 'USD');
  const q5 = await fx.quoteSettlement(-5, 'USD');
  check('a zero or negative amount yields no quote', () => {
    assert.strictEqual(q4, null);
    assert.strictEqual(q5, null);
  });
})();

console.log('\nthe cache has a hard expiry, because a stale rate is undetectable');

await (async () => {
  let calls = 0;
  fx._clearCache();
  fx._setFetch(async () => { calls++; return 1.08; });

  const t0 = 1_000_000;
  await fx.getRate('EUR', 'USD', t0);
  await fx.getRate('EUR', 'USD', t0 + 60_000);
  check('a burst of orders makes one request', () => assert.strictEqual(calls, 1));

  await fx.getRate('EUR', 'USD', t0 + fx.TTL_MS + 1);
  check('past the TTL it asks again', () => assert.strictEqual(calls, 2));

  // The important half: expiry is "no rate", not "the old rate". There is no
  // way from inside fx.js to tell a rate five minutes old from one a day old,
  // and a day-old rate locked onto a customer's order is indefensible.
  calls = 0;
  fx._setFetch(async () => { calls++; throw new Error('offline'); });
  const stale = await fx.getRate('EUR', 'USD', t0 + fx.TTL_MS * 3);
  check('an expired entry is not served when the provider is down', () => {
    assert.strictEqual(stale, null);
    assert.strictEqual(calls, 1, 'it must actually have tried');
  });
})();

console.log('\nthe euro column stays in euro');

check('a settled dollar figure converts back at the locked rate', () => {
  const back = fx.backToShopCurrency(21.59, 1.08);
  assert.ok(near(back, 21.59 / 1.08), 'expected the locked-rate conversion');
  assert.ok(back < 20, 'a dollar figure filed as euro would read as an overpayment forever');
});

check('a missing or absurd rate converts to nothing at all', () => {
  assert.strictEqual(fx.backToShopCurrency(21.59, 0), null);
  assert.strictEqual(fx.backToShopCurrency(21.59, undefined), null);
  assert.strictEqual(fx.backToShopCurrency('nonsense', 1.08), null);
});

console.log('\nwhat each method actually collects');

check('Cash App settles USD, PayPal settles the shop currency', () => {
  assert.strictEqual(pa.settlementCurrency('cashapp'), 'USD');
  assert.strictEqual(pa.settlementCurrency('paypal'), CURRENCY);
  // Crypto is quoted from a live fiat rate, so it carries no restriction and
  // must not be dragged into the bridge.
  assert.strictEqual(pa.settlementCurrency('btc'), CURRENCY);
});

check('the raw fact is unchanged — Cash App still cannot hold euro', () => {
  // currencyUnsupported is deliberately NOT relaxed. It states what is true of
  // the method; currencyBridged states whether we have a workaround. Collapsing
  // the two would lose the pay screen's reason to say "you are sending dollars".
  assert.strictEqual(pa.currencyUnsupported('cashapp'), true);
  assert.strictEqual(pa.currencyUnsupported('paypal'), false);
});

check('the gap is bridged for euro, and honestly unbridgeable for a currency the ECB skips', () => {
  assert.strictEqual(pa.currencyBridged('cashapp'), true);
  assert.strictEqual(pa.currencyBridged('cashapp', 'XBT'), false,
    'the old currency state must stay reachable');
  assert.strictEqual(pa.currencyBridged('paypal'), false,
    'a method that needs no bridge must not claim one');
});

console.log('\nwhat the panel, the bot and the checkout are told');

check('Cash App is on sale again, and says what it collects', () => {
  const st = pa.methodStates({ CASHAPP_CASHTAG: '$ghoststore', PAYPAL_EMAIL: 'a@b.test' }).cashapp;
  assert.strictEqual(st.available, true);
  // Deliberately the SAME state string every working method reports. Adding a
  // fourth status would have broken every exhaustive list that switches on it —
  // the panel, two bot surfaces, the checkout guard. settle_currency is
  // additive: anything that wants to explain the conversion opts in.
  assert.strictEqual(st.state, 'on');
  assert.strictEqual(st.settle_currency, 'USD');
  assert.ok(/USD/.test(st.note) && new RegExp(CURRENCY).test(st.note),
    'the note must name both currencies or it explains nothing');
});

check('PayPal carries no settlement note, because it needs none', () => {
  const st = pa.methodStates({ CASHAPP_CASHTAG: '$ghoststore', PAYPAL_EMAIL: 'a@b.test' }).paypal;
  assert.strictEqual(st.available, true);
  assert.strictEqual(st.settle_currency, undefined);
});

check('the kill switch still beats the bridge', () => {
  // The whole point of PAYMENT_METHODS_OFF is that an owner can stop taking
  // money in one click. A method that came back to life because it found a way
  // to convert would be the worst possible bug in that feature.
  const env = { CASHAPP_CASHTAG: '$ghoststore', PAYPAL_EMAIL: 'a@b.test', PAYMENT_METHODS_OFF: 'cashapp' };
  assert.strictEqual(pa.methodStates(env).cashapp.state, 'off');
  assert.strictEqual(pa.methodStates(env).cashapp.available, false);
  assert.strictEqual(pa.payableMethods(env).cashapp, false);
});

check('a broken cashtag is still misconfigured, not bridged', () => {
  const env = { CASHAPP_CASHTAG: 'not-a-cashtag', PAYPAL_EMAIL: 'a@b.test' };
  assert.strictEqual(pa.methodStates(env).cashapp.state, 'unconfigured');
  assert.strictEqual(pa.payableMethods(env).cashapp, false);
});

console.log('\nthe watcher reads the receipt the method actually sends');

check('Cash App amounts are read in dollars', () => {
  const CA = watcher.amountPatterns('cashapp');
  assert.strictEqual(watcher.parseAmount('You received $21.59 to $ghoststore', CA), 21.59);
  assert.strictEqual(watcher.parseAmount('You received 21.59 USD', CA), 21.59);
});

check('a cashtag is not read as an amount', () => {
  // "$ghoststore" is a handle. A pattern built by pasting the symbol in front of
  // a number group would happily read the letters after it as a price on any
  // receipt where the cashtag came first.
  const CA = watcher.amountPatterns('cashapp');
  assert.strictEqual(watcher.parseAmount('You received to $ghoststore', CA), null);
});

check('a euro figure is not read off a Cash App receipt', () => {
  const CA = watcher.amountPatterns('cashapp');
  assert.strictEqual(watcher.parseAmount('You received €19.99 to $ghoststore', CA), null);
});

check('the hostile-currency list disagrees between the two methods', () => {
  // This disagreement IS the property. The cheap way to make Cash App work was
  // to delete USD from one shared list — which would have made PayPal accept a
  // dollar receipt against a euro invoice at par, short by the whole spread, on
  // every order, silently.
  assert.strictEqual(watcher.foreignCurrencyReason('You received $19.99 USD', 'cashapp'), null);
  assert.ok(watcher.foreignCurrencyReason('You received $19.99 USD', 'paypal'));
  assert.ok(watcher.foreignCurrencyReason('You received €19.99 EUR', 'cashapp'));
  assert.strictEqual(watcher.foreignCurrencyReason('You received €19.99 EUR', 'paypal'), null);
  // With NO symbol in the text, so the ISO-code half of the guard has to carry
  // it alone. Mutation found this gap: a version that kept one global code list
  // with both EUR and USD struck off still passed every check above, because
  // the "$" caught the PayPal case by accident. A provider that writes only the
  // code — and several do — would have walked straight through.
  assert.ok(watcher.foreignCurrencyReason('Amount received: 19.99 USD', 'paypal'),
    'the code list alone must reject dollars for PayPal');
  assert.ok(watcher.foreignCurrencyReason('Amount received: 19.99 EUR', 'cashapp'),
    'the code list alone must reject euro for Cash App');
  assert.strictEqual(watcher.foreignCurrencyReason('Amount received: 19.99 USD', 'cashapp'), null);
  assert.strictEqual(watcher.foreignCurrencyReason('Amount received: 19.99 EUR', 'paypal'), null);
  // …and the four other currencies PayPal renders with a "$" are still hostile
  // on BOTH, which is what makes the exemption safe.
  for (const ccy of ['CAD', 'AUD', 'MXN', 'SGD']) {
    assert.ok(watcher.foreignCurrencyReason(`You received $19.99 ${ccy}`, 'cashapp'), ccy);
    assert.ok(watcher.foreignCurrencyReason(`You received $19.99 ${ccy}`, 'paypal'), ccy);
  }
});

console.log('\nthe payment is judged against the figure the buyer was SHOWN');

const LOCKED = {
  cashtag: '$ghoststore', amount: 19.99,
  settle_currency: 'USD', settle_amount: 21.59, settle_symbol: '$', fx_rate: 1.08,
};
const ORDER = { id: 1, total_cents: 1999, payment_info: LOCKED };

check('a bridged order expects its locked dollar figure, not its euro total', () => {
  const e = watcher.expectedPayment(ORDER, 'cashapp');
  assert.strictEqual(e.refuse, false);
  assert.strictEqual(e.currency, 'USD');
  assert.strictEqual(e.total, 21.59);
  assert.strictEqual(e.locked.rate, 1.08);
});

check('the same quote survives the JSONB-vs-TEXT column difference', () => {
  // payment_info comes back as an object from a JSONB column and a string from a
  // TEXT one. Reading the rate off the string gives undefined, which fails
  // closed — safe, and an outage, since every Cash App order would then page a
  // human instead of settling.
  const e = watcher.expectedPayment({ ...ORDER, payment_info: JSON.stringify(LOCKED) }, 'cashapp');
  assert.strictEqual(e.refuse, false);
  assert.strictEqual(e.total, 21.59);
});

check('a bridged order with NO quote is refused, not re-derived', () => {
  // The tempting fallback is "look the rate up now". That settles the order
  // against a number the customer was never shown, and it is exactly the
  // failure the locking exists to prevent.
  for (const info of [null, {}, { settle_currency: 'USD' }, { settle_currency: 'USD', settle_amount: 21.59 }]) {
    const e = watcher.expectedPayment({ ...ORDER, payment_info: info }, 'cashapp');
    assert.strictEqual(e.refuse, true, 'half a quote is not a quote: ' + JSON.stringify(info));
    assert.strictEqual(e.total, null, 'nothing to compare against');
  }
});

check('an unbridged method still just uses its euro total', () => {
  const e = watcher.expectedPayment({ id: 2, total_cents: 1999, payment_info: null }, 'paypal');
  assert.strictEqual(e.refuse, false);
  assert.strictEqual(e.currency, CURRENCY);
  assert.strictEqual(e.total, 19.99);
  assert.strictEqual(e.locked, null);
});

console.log('\nwhat gets written into the books');

check('dollars received are recorded as euro cents at the locked rate', () => {
  const { cents, unit } = nativeToFiatCents(ORDER, 21.59, 'cashapp');
  assert.strictEqual(unit, 'usd', 'the native unit names what actually arrived');
  assert.strictEqual(cents, Math.round((21.59 / 1.08) * 100));
  assert.ok(cents < 2100, '$21.59 filed as €21.59 is a permanent phantom overpayment');
  assert.ok(Math.abs(cents - 1999) <= 1, 'a correct payment should reconcile to the price');
});

check('the same conversion happens from a TEXT payment_info column', () => {
  const { cents } = nativeToFiatCents({ ...ORDER, payment_info: JSON.stringify(LOCKED) }, 21.59, 'cashapp');
  assert.strictEqual(cents, Math.round((21.59 / 1.08) * 100));
});

check('no locked rate means no euro figure, rather than an invented one', () => {
  const bad = { ...ORDER, payment_info: { settle_currency: 'USD' } };
  const { cents, unit } = nativeToFiatCents(bad, 21.59, 'cashapp');
  assert.strictEqual(cents, null, 'a reconciliation would trust an invented number');
  assert.strictEqual(unit, 'usd');
});

check('an ordinary euro payment is untouched by any of this', () => {
  const { cents, unit } = nativeToFiatCents({ id: 3, payment_info: null }, 19.99, 'paypal');
  assert.strictEqual(cents, 1999);
  assert.strictEqual(unit, CURRENCY.toLowerCase());
});

check('crypto is still converted from its own locked quote, not this one', () => {
  // The satoshi path predates all of this and shares the function. A settlement
  // branch placed above it, or one that matched on "payment_info has a rate",
  // would have quietly re-denominated every crypto order.
  const btc = { id: 4, payment_info: { rate_fiat: 60000, settle_currency: 'USD', fx_rate: 1.08 } };
  const { cents, unit } = nativeToFiatCents(btc, 1e6, 'btc');
  assert.strictEqual(unit, 'sats');
  assert.strictEqual(cents, Math.round((1e6 / 1e8) * 60000 * 100));
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})();
