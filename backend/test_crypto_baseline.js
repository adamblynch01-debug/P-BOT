// Crypto address-baselining regression tests.
//
// The poller used to confirm on an address's absolute confirmed balance, which
// is only sound when every address is freshly derived and used once. The xpub
// belongs to a wallet that is also used by hand, so an address can arrive with
// history, and the merchant can sweep it mid-order. These tests pin the delta
// arithmetic and the fail-closed paths around it.
//
// Loads the real module with a stubbed DB + axios so the assertions cover the
// shipped code, not a copy of it.

const path = require('path');

const BACKEND = __dirname;
process.env.GUILD_ID = 'g1';
process.env.BLOCKCYPHER_TOKEN = 'bc-test-token';
process.env.BTC_XPUB =
  'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';

// ─── stubs ───────────────────────────────────────────────
const INSERTS = [];
let NEXT_INDEX_ROWS = [];
let INSERT_ERROR = null;

const dbStub = {
  query: async (sql, params) => {
    if (/SELECT address_index FROM crypto_addresses/.test(sql)) {
      return { rows: NEXT_INDEX_ROWS, rowCount: NEXT_INDEX_ROWS.length };
    }
    if (/INSERT INTO crypto_addresses/.test(sql)) {
      if (INSERT_ERROR) { const e = INSERT_ERROR; INSERT_ERROR = null; throw e; }
      INSERTS.push(params);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};

require.cache[require.resolve(path.join(BACKEND, 'db.js'))] = {
  id: 'db', filename: 'db', loaded: true, exports: dbStub,
};

// Chain reads are scripted per test so "what does the code do when the API is
// down / returns junk / reports history" is directly expressible.
let CHAIN = { total_received: 0 };
let CHAIN_THROWS = false;
const CHAIN_CALLS = [];

require.cache[require.resolve('axios', { paths: [BACKEND] })] = {
  id: 'axios', filename: 'axios', loaded: true,
  exports: {
    get: async (url) => {
      CHAIN_CALLS.push(url);
      if (CHAIN_THROWS) throw new Error('blockcypher unreachable');
      return { data: CHAIN };
    },
    post: async () => ({ data: {} }),
  },
};

const {
  receivedSinceBaseline,
  fetchTotalReceived,
  generateCryptoAddress,
  verifyCryptoPayment,
} = require(path.join(BACKEND, 'utils', 'cryptoUtils.js'));

// ─── harness ─────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}
function reset() {
  INSERTS.length = 0; CHAIN_CALLS.length = 0;
  NEXT_INDEX_ROWS = []; INSERT_ERROR = null;
  CHAIN = { total_received: 0 }; CHAIN_THROWS = false;
}

(async () => {
  console.log('\n── receivedSinceBaseline ──');

  {
    const r = receivedSinceBaseline(150000, 0);
    ok(r.ok && r.sats === 150000, 'fresh address: full total_received counts');
  }
  {
    // The free-goods case. Address already held 95,336 sats when issued.
    const r = receivedSinceBaseline(95336, 95336);
    ok(r.ok && r.sats === 0, 'pre-existing history alone yields zero credit');
  }
  {
    const r = receivedSinceBaseline(95336 + 200000, 95336);
    ok(r.ok && r.sats === 200000, 'only funds received after issue are credited');
  }
  {
    // Regression for the swept-address case: balance would read 0 here, but
    // total_received still reflects the payment.
    const r = receivedSinceBaseline(300000, 100000);
    ok(r.ok && r.sats === 200000, 'a sweep does not erase a detected payment');
  }
  {
    const r = receivedSinceBaseline(150000, null);
    ok(!r.ok && /baseline/.test(r.reason), 'missing baseline fails closed');
  }
  {
    const r = receivedSinceBaseline(150000, undefined);
    ok(!r.ok, 'undefined baseline fails closed');
  }
  {
    const r = receivedSinceBaseline(undefined, 0);
    ok(!r.ok && /total_received/.test(r.reason), 'unreadable total fails closed');
  }
  {
    const r = receivedSinceBaseline('not-a-number', 0);
    ok(!r.ok, 'non-numeric total fails closed');
  }
  {
    const r = receivedSinceBaseline(50000, 100000);
    ok(!r.ok && /below the recorded baseline/.test(r.reason),
      'total below baseline is refused, not treated as payment');
  }
  {
    const r = receivedSinceBaseline(-5, 0);
    ok(!r.ok, 'negative total fails closed');
  }

  console.log('\n── baseline is applied to the locked quote ──');

  {
    // End-to-end arithmetic: an address with history must NOT satisfy the quote
    // on that history alone.
    const order = { payment_info: { expected_sats: 100000 } };
    const dirty = receivedSinceBaseline(120000, 120000);
    ok(dirty.ok && !verifyCryptoPayment(order, dirty.sats).ok,
      'order with a used address is not confirmed by prior history');

    const paid = receivedSinceBaseline(120000 + 100000, 120000);
    ok(paid.ok && verifyCryptoPayment(order, paid.sats).ok,
      'the same order confirms once real funds arrive');
  }

  console.log('\n── fetchTotalReceived ──');

  reset();
  CHAIN = { total_received: 95336, balance: 0 };
  ok(await fetchTotalReceived('btc', 'bc1qtest') === 95336,
    'reads total_received, not balance');

  reset();
  CHAIN = { total_received: 95336, balance: 0 };
  await fetchTotalReceived('ltc', 'ltc1qtest');
  ok(/ltc\/main/.test(CHAIN_CALLS[0]), 'ltc uses the ltc chain');

  reset();
  CHAIN_THROWS = true;
  ok(await fetchTotalReceived('btc', 'bc1qtest') === null,
    'chain error returns null, never 0');

  reset();
  CHAIN = {};
  ok(await fetchTotalReceived('btc', 'bc1qtest') === null,
    'missing total_received returns null, never 0');

  console.log('\n── address issue captures a baseline ──');

  reset();
  CHAIN = { total_received: 0 };
  {
    const addr = await generateCryptoAddress('btc', 'order-1');
    ok(typeof addr === 'string' && addr.startsWith('bc1q'),
      'derives a native SegWit address');
    ok(INSERTS.length === 1 && INSERTS[0][5] === 0,
      'fresh address is stored with baseline 0');
  }

  reset();
  CHAIN = { total_received: 95336 };
  {
    await generateCryptoAddress('btc', 'order-2');
    ok(INSERTS.length === 1 && INSERTS[0][5] === 95336,
      'used address is stored with its prior receipts as the baseline');
  }

  reset();
  CHAIN_THROWS = true;
  {
    // Fail closed: no baseline means we cannot tell payment from history, so
    // the order must not get an address at all.
    const addr = await generateCryptoAddress('btc', 'order-3');
    ok(addr === null, 'unreadable baseline yields no address');
    ok(INSERTS.length === 0, 'and nothing is written to crypto_addresses');
  }

  reset();
  CHAIN = { total_received: 0 };
  NEXT_INDEX_ROWS = [{ address_index: 7 }];
  {
    await generateCryptoAddress('btc', 'order-4');
    ok(INSERTS.length === 1 && INSERTS[0][4] === 8,
      'derivation index continues from the highest issued');
  }

  reset();
  CHAIN = { total_received: 0 };
  {
    // A raced index must still retry, and the retry must baseline too.
    const e = new Error('duplicate'); e.code = '23505';
    INSERT_ERROR = e;
    const addr = await generateCryptoAddress('btc', 'order-5');
    ok(typeof addr === 'string', 'a raced index retries to a fresh address');
    ok(INSERTS.length === 1 && INSERTS[0][5] === 0,
      'the retried address is baselined as well');
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
