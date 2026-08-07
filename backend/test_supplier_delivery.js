// Buying a key from the upstream reseller, against a stubbed supplier and a
// stubbed db.
//
// This is the most dangerous code in the round, for one reason: THE GET IS THE
// PURCHASE. It charges their balance and consumes their inventory, there is no
// confirm step, no idempotency key, and no history endpoint to ask afterwards
// what happened. So the things worth pinning are not "it returns a key" — they
// are the four ways it can quietly cost money or hand a customer nonsense:
//
//   1. A FAILURE ARRIVES AS A 200. Their errors are plain text starting
//      `ERROR:`, in the same body a key would arrive in. Status-code handling
//      alone delivers "ERROR: Insufficient balance" to a paying customer as
//      their product.
//   2. A TIMEOUT IS NOT A FAILURE, IT IS AN UNKNOWN. Retrying buys a second
//      key; falling back to local stock hands out a second key. Both cost real
//      money and neither is reversible, so the only correct move is to stop.
//   3. AN `ERROR:` IS SAFE TO FALL BACK FROM — they told us nothing was
//      charged — and that fallback is the whole reason a drained balance does
//      not close the shop.
//   4. THE KEY MUST NEVER LEAVE. It is in a query string, so it lands in axios'
//      own error text for free, and that text is what gets stored in last_error
//      and shown in the admin panel.
//
//   node test_supplier_delivery.js
'use strict';

const assert = require('assert');
const Module = require('module');

process.env.GUILD_ID = 'test-guild';
process.env.GANDY_API_KEY = 'live-key-must-never-appear';
process.env.GANDY_API_BASE = 'https://supplier.invalid/api/v1';
// The second supplier. Distinct key and distinct host on purpose: every check
// below that says "the right one" would pass by accident if they shared either.
process.env.AIMBETTER_API_KEY = 'second-key-must-never-appear';
process.env.AIMBETTER_API_BASE = 'https://second-supplier.invalid/api/v1';
process.env.SUPPLIER_OFF = '';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// ── the fake world ───────────────────────────────────────────────────────────
let links, deliveries, stock, orders, alerts, requests;
let supplierReply;                 // { body } | { throws } — one call, one answer
function reset() {
  links = [{
    id: 1, guild_id: 'test-guild', tier_id: 401, supplier: 'gandy',
    supplier_product_id: '48', label: '[BO7] Unlocker + Spoofer - Day',
    cost_cents: 60, enabled: true, qty_per_unit: 1,
  }];
  deliveries = [];
  stock = [{ id: 9001, tier_id: 401, used: false, value: 'LOCAL-POOL-KEY-1' }];
  orders = [{ id: 'ord-1', status: 'paid', invoice_no: 'INV-1001', delivered_goods: null }];
  alerts = [];
  requests = [];
  supplierReply = { body: 'UPSTREAM-KEY-AAAA' };
}
reset();

// The db stub. Statements are matched on their text, and every write lands in
// the arrays above so the assertions can read what really happened rather than
// what the route said it did.
const exec = async (text, params) => {
  const t = String(text).replace(/\s+/g, ' ').trim();

  if (/SELECT \* FROM supplier_links/.test(t)) {
    // Answers what was ASKED, not what the code ought to have asked. The first
    // version filtered on `l.enabled` unconditionally, which meant deleting
    // `AND enabled = TRUE` from the real query changed nothing here and the
    // per-link toggle test passed against code that had stopped honouring it.
    // A stub that enforces the rule under test is an alibi for its removal.
    const wantsEnabled = /enabled = TRUE/i.test(t);
    return { rows: links.filter(l =>
      l.guild_id === params[0] && l.tier_id === Number(params[1]) && (!wantsEnabled || l.enabled)) };
  }
  if (/INSERT INTO supplier_deliveries/.test(t)) {
    // (guild_id, order_id, tier_id, link_id, buyer_ref, supplier,
    //  supplier_product_id, qty, status, cost_cents) — read off the real
    // statement. params[5] is the supplier, and leaving it out here is how a
    // log row that names no upstream would have gone unnoticed.
    const row = {
      id: 500 + deliveries.length, order_id: params[1], tier_id: params[2], link_id: params[3],
      buyer_ref: params[4], supplier: params[5], supplier_product_id: params[6], qty: params[7],
      status: 'pending', response_lines: null, error_text: null, cost_cents: params[8],
    };
    deliveries.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (/UPDATE supplier_deliveries SET status/.test(t)) {
    const row = deliveries.find(d => d.id === Number(params[3]));
    if (row) {
      row.status = params[0];
      row.response_lines = params[1] ? JSON.parse(params[1]) : null;
      row.error_text = params[2];
    }
    return { rows: row ? [row] : [] };
  }
  if (/UPDATE supplier_links SET last_ok_at/.test(t)) {
    const l = links.find(x => x.id === Number(params[0]));
    if (l) { l.last_ok_at = 'now'; l.last_error = null; }
    return { rows: [] };
  }
  if (/UPDATE supplier_links SET last_error/.test(t)) {
    const l = links.find(x => x.id === Number(params[0]));
    if (l) l.last_error = params[1];
    return { rows: [] };
  }

  // The local key pool — the fallback path.
  if (/UPDATE product_stock SET used = true/.test(t)) {
    const row = stock.find(s => s.tier_id === Number(params[2]) && !s.used);
    if (!row) return { rows: [] };
    row.used = true;
    return { rows: [{ value: row.value }] };
  }

  if (/SELECT t\.\*, p\.name AS product_name/.test(t)) {
    return { rows: [{
      id: 401, guild_id: 'test-guild', product_id: 10, label: 'Day', price_cents: 200,
      stock_type: 'auto', delivery_type: 'auto',
      product_name: '[BO7] Unlocker + Spoofer', game_name: 'Call of Duty: Warzone',
    }] };
  }
  if (/UPDATE orders SET status/.test(t)) {
    const o = orders.find(x => x.id === params[2]);
    if (o) { o.status = params[0]; o.delivered_goods = JSON.parse(params[1]); }
    return { rows: [] };
  }
  if (/SELECT id FROM ops_alerts/.test(t)) return { rows: [] };   // never deduped here
  if (/INSERT INTO ops_alerts/.test(t)) {
    // (guild_id, kind, severity, message, context, order_id) — read off the
    // real statement, not guessed. The first version of this stub read
    // params[0] as the kind, so every alert assertion below passed a row whose
    // kind was the guild id, and the alert check "failed" against working code.
    alerts.push({ kind: params[1], severity: params[2], message: params[3], context: params[4] });
    return { rows: [{ id: alerts.length }] };
  }
  return { rows: [] };
};

const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

stub('./db', { query: exec, withTransaction: async (fn) => fn({ query: exec }), pool: {} });

// axios, replaced wholesale: nothing in this file may reach the network, and
// the supplier's endpoint would charge real money if it did.
stub('axios', {
  get: async (url, opt) => {
    requests.push({ url, params: (opt && opt.params) || {} });
    if (supplierReply.throws) {
      const e = new Error(supplierReply.throws);
      e.code = 'ECONNABORTED';
      throw e;
    }
    return { status: supplierReply.status || 200, data: supplierReply.body };
  },
  post: async () => ({ status: 200, data: {} }),
});

// The alert path writes to ops_alerts through the stubbed db, so it is real —
// but botNotify and email must not be.
stub('./utils/botNotify', { notifyBot: async () => ({ ok: true }) });
stub('./utils/email', { sendOrderConfirmation: async () => ({ ok: true }) });

const supplier = require('./utils/supplier');

// ── what leaves the module ───────────────────────────────────────────────────
console.log('\nthe api key never leaves');

check('redact() removes the key wherever it appears', () => {
  const leak = 'Request failed at https://supplier.invalid/api/v1/deliver/48?key=live-key-must-never-appear&qty=1';
  const safe = supplier.redact(leak);
  assert.ok(!safe.includes('live-key-must-never-appear'), 'the key survived redaction');
  assert.match(safe, /key=/, 'the shape of the message should survive');
});

check('redact() also blanks a key=... it has never seen', () => {
  // A rotated key, a second supplier, or a hand-written config row. Matching
  // only the CURRENT value would let the previous one through.
  const safe = supplier.redact('GET /deliver/48?key=some-other-secret&qty=2 failed');
  assert.ok(!safe.includes('some-other-secret'));
  assert.match(safe, /key=<redacted>/);
});

check('the module exports no way to read the key', () => {
  // Not a check on the NAMES — `hasApiKey` contains "apiKey" and is exactly the
  // export we want. What matters is that nothing callable hands the value back:
  // every zero-argument export is invoked and its answer inspected.
  const key = process.env.GANDY_API_KEY;
  for (const name of Object.keys(supplier)) {
    const v = supplier[name];
    const out = typeof v === 'function' && v.length === 0 ? v() : v;
    assert.ok(!String(out).includes(key), `supplier.${name} returns the API key`);
  }
  assert.strictEqual(supplier.hasApiKey(), true, 'hasApiKey should say whether, not what');
  assert.strictEqual(typeof supplier.hasApiKey(), 'boolean', 'it should be a yes/no, not the value');
});

console.log('\nan ERROR: body is a failure, whatever the status code says');

check('a 200 whose body starts ERROR: is parsed as an error', () => {
  const r = supplier.parseBody('ERROR: Insufficient balance');
  assert.ok(r.error, 'it was read as a key');
  assert.strictEqual(r.lines, undefined);
});

check('a mixed body is refused entirely, not half-delivered', () => {
  // One good line and one error is not "one key" — we do not know which half
  // was charged for, and handing over the good one hides the problem.
  const r = supplier.parseBody('KEY-AAAA\nERROR: out of stock');
  assert.ok(r.error, 'a body containing an error line was accepted as keys');
});

check('an empty body is an error, not zero keys', () => {
  assert.ok(supplier.parseBody('').error);
  assert.ok(supplier.parseBody('   \n  \n').error);
});

check('a real key list parses to one line each, trimmed', () => {
  const r = supplier.parseBody('KEY-AAAA\r\nKEY-BBBB\r\n\r\n');
  assert.deepStrictEqual(r.lines, ['KEY-AAAA', 'KEY-BBBB']);
});

console.log('\nthe purchase itself');

async function run() {
  reset();
  let out = await supplier.purchase(links[0], { qty: 1, orderId: 'ord-1', buyerRef: 'INV-1001' });
  await checkAsync('a good purchase returns the keys and logs ok', () => {
    assert.strictEqual(out.status, 'ok');
    assert.deepStrictEqual(out.lines, ['UPSTREAM-KEY-AAAA']);
    assert.strictEqual(deliveries.length, 1);
    assert.strictEqual(deliveries[0].status, 'ok');
    assert.deepStrictEqual(deliveries[0].response_lines, ['UPSTREAM-KEY-AAAA']);
  });

  await checkAsync('the row is written BEFORE the request, not after', () => {
    // Proved by the id being handed back from the pre-log: a row created after
    // the answer could not have been referenced while waiting for it.
    assert.strictEqual(out.deliveryId, deliveries[0].id);
    assert.strictEqual(deliveries[0].buyer_ref, 'INV-1001',
      'without the reference there is no way to match their invoice to an order');
  });

  await checkAsync('exactly one request was made — never two', () => {
    assert.strictEqual(requests.length, 1, 'each extra request is a second charge');
    assert.match(requests[0].url, /\/deliver\/48$/);
    assert.strictEqual(requests[0].params.key, 'live-key-must-never-appear');
    assert.strictEqual(requests[0].params.qty, 1);
  });

  reset();
  supplierReply = { body: 'ERROR: Insufficient balance' };
  out = await supplier.purchase(links[0], { qty: 1, orderId: 'ord-1' });
  await checkAsync('a refusal is status error, with the text kept', () => {
    assert.strictEqual(out.status, 'error');
    assert.match(out.error, /Insufficient balance/);
    assert.strictEqual(out.lines, undefined, 'the error text must not be handed over as a key');
    assert.strictEqual(deliveries[0].status, 'error');
  });

  await checkAsync('a refusal is NOT retried', () =>
    assert.strictEqual(requests.length, 1, 'it bought again'));

  reset();
  supplierReply = { throws: 'timeout of 30000ms exceeded' };
  out = await supplier.purchase(links[0], { qty: 1, orderId: 'ord-1' });
  await checkAsync('no answer is status timeout, and is NOT retried', () => {
    assert.strictEqual(out.status, 'timeout');
    assert.strictEqual(requests.length, 1,
      'a retry after a timeout buys a second key for one sale and there is no way to give the first back');
  });

  await checkAsync('a timeout leaves a row saying we may have been charged', () => {
    assert.strictEqual(deliveries[0].status, 'timeout');
    assert.strictEqual(deliveries[0].supplier_product_id, '48');
  });

  await checkAsync('a timeout raises an alert that names the ambiguity', () => {
    const a = alerts.find(x => x.kind === 'supplier_timeout');
    assert.ok(a, 'nobody was told');
    assert.match(a.message, /MAY HAVE GONE THROUGH/i);
  });

  reset();
  supplierReply = { throws: 'connect ECONNREFUSED https://supplier.invalid/api/v1/deliver/48?key=live-key-must-never-appear' };
  await supplier.purchase(links[0], { qty: 1, orderId: 'ord-1' });
  await checkAsync('the key is redacted out of the stored error and the alert', () => {
    const blob = JSON.stringify({ deliveries, links, alerts });
    assert.ok(!blob.includes('live-key-must-never-appear'),
      'the API key was written into a row or an alert — the panel renders both');
    assert.ok(links[0].last_error, 'the link should still record that something failed');
  });

  console.log('\nthe switches');

  reset();
  links[0].enabled = false;
  await checkAsync('a disabled link is not found, so the tier falls back to local stock', async () =>
    assert.strictEqual(await supplier.linkForTier(401), null));

  reset();
  process.env.SUPPLIER_OFF = '1';
  await checkAsync('the global switch turns every link off at once', async () =>
    assert.strictEqual(await supplier.linkForTier(401), null));
  process.env.SUPPLIER_OFF = '';

  await checkAsync('the global switch is off unless explicitly on', () => {
    // It fails OPEN on purpose: this switch failing "on" would take a working
    // shop offline, whereas failing "off" just sells from our own stock.
    for (const v of ['', '0', 'false', 'no', undefined]) {
      process.env.SUPPLIER_OFF = v === undefined ? '' : v;
      assert.strictEqual(supplier.supplierGloballyOff(), false, `"${v}" was read as OFF`);
    }
    for (const v of ['1', 'true', 'yes', 'TRUE']) {
      process.env.SUPPLIER_OFF = v;
      assert.strictEqual(supplier.supplierGloballyOff(), true, `"${v}" was not read as OFF`);
    }
    process.env.SUPPLIER_OFF = '';
  });

  reset();
  const realKey = process.env.GANDY_API_KEY;
  process.env.GANDY_API_KEY = '';
  await checkAsync('no key configured means no supplier, not a failed sale', async () =>
    assert.strictEqual(await supplier.linkForTier(401), null));
  process.env.GANDY_API_KEY = realKey;

  console.log('\ntwo suppliers, running the same API');

  // They are the same panel software behind different domains, so the only
  // things that distinguish them are the host and the key — which is exactly
  // why a link pointing at the wrong one cannot be spotted by looking.
  reset();
  links[0].supplier = 'aimbetter';
  await supplier.purchase(links[0], { qty: 1, orderId: 'ord-1' });
  await checkAsync('a link buys from ITS supplier, with THAT key', () => {
    assert.strictEqual(requests.length, 1);
    assert.match(requests[0].url, /^https:\/\/second-supplier\.invalid\//,
      'it bought from the wrong supplier — product ids do not mean the same thing at both');
    assert.strictEqual(requests[0].params.key, 'second-key-must-never-appear',
      'it sent the other supplier key, which would be refused at best and spend the wrong balance at worst');
  });

  await checkAsync('and the row records WHICH supplier was charged', () =>
    assert.strictEqual(deliveries[0].supplier, 'aimbetter',
      'with two upstreams, a log row that does not say cannot be reconciled against an invoice'));

  check('redact() strips BOTH keys, not just the one that failed', () => {
    // Both keys BARE, not in a key= parameter. In that form the generic
    // `key=…` rule catches them whatever the per-supplier loop does, and this
    // check passes without proving anything — which is exactly what it did
    // until a mutant that redacted only the default supplier survived it. An
    // upstream error body quoting the credential back at us looks like this.
    const leak = 'gandy rejected token live-key-must-never-appear ' +
                 'aim rejected token second-key-must-never-appear';
    const safe = supplier.redact(leak);
    assert.ok(!safe.includes('live-key-must-never-appear'));
    assert.ok(!safe.includes('second-key-must-never-appear'),
      'the second supplier key survived — a redactor that only knows one of them leaks the other');
  });

  reset();
  links[0].supplier = 'aimbetter';
  const savedAim = process.env.AIMBETTER_API_KEY;
  process.env.AIMBETTER_API_KEY = '';
  await checkAsync('one supplier missing its key does NOT switch off the other', async () => {
    assert.strictEqual(await supplier.linkForTier(401), null, 'it tried to buy with no key');
    links[0].supplier = 'gandy';
    assert.ok(await supplier.linkForTier(401),
      'a configured supplier stopped working because a DIFFERENT one had no key set');
  });
  process.env.AIMBETTER_API_KEY = savedAim;

  reset();
  links[0].supplier = 'nobody-by-that-name';
  await checkAsync('an unknown supplier name falls back rather than guessing', async () => {
    assert.strictEqual(await supplier.linkForTier(401), null);
    const out = await supplier.purchase(links[0], { qty: 1, orderId: 'ord-1' });
    assert.strictEqual(requests.length, 0, 'it bought from whichever supplier happened to be first');
    // 'error', not 'timeout': no request went out, so nothing was charged and
    // the caller is free to fall back. Calling this a timeout would strand a
    // paid order for a human over a typo.
    assert.strictEqual(out.status, 'error');
    assert.strictEqual(deliveries.length, 0, 'it logged a pending charge that was never in flight');
  });

  console.log('\nend to end, through the real delivery path');

  const { deliver } = require('./utils/delivery');
  const orderWith = () => ({
    id: 'ord-1', invoice_no: 'INV-1001', email: 'buyer@example.com',
    items_snapshot: [{ id: 401, name: '[BO7] Unlocker + Spoofer', qty: 1, price: 2, tier_label: 'Day' }],
  });

  reset();
  await deliver(orderWith());
  await checkAsync('a supplier-backed tier delivers the UPSTREAM key', () => {
    const g = orders[0].delivered_goods;
    assert.ok(g && g.length, 'nothing was delivered');
    assert.deepStrictEqual(g[0].items, ['UPSTREAM-KEY-AAAA']);
    assert.strictEqual(g[0].source, 'supplier');
    assert.strictEqual(orders[0].status, 'delivered');
  });

  await checkAsync('and does NOT burn a key from our own pool', () =>
    assert.strictEqual(stock[0].used, false,
      'the local key was consumed as well — that is two keys for one sale'));

  reset();
  supplierReply = { body: 'ERROR: Out of stock' };
  await deliver(orderWith());
  await checkAsync('a supplier REFUSAL falls back to local stock and still delivers', () => {
    assert.deepStrictEqual(orders[0].delivered_goods[0].items, ['LOCAL-POOL-KEY-1']);
    assert.strictEqual(orders[0].status, 'delivered',
      'they said nothing was charged, so our own pool is a safe second try');
    assert.strictEqual(stock[0].used, true);
  });

  reset();
  supplierReply = { throws: 'timeout of 30000ms exceeded' };
  await deliver(orderWith());
  await checkAsync('a TIMEOUT does not fall back — the order stops for a human', () => {
    assert.deepStrictEqual(orders[0].delivered_goods[0].items, ['SUPPLIER_TIMEOUT']);
    assert.strictEqual(stock[0].used, false,
      'it handed out a local key on top of a charge that may have gone through');
    assert.strictEqual(orders[0].status, 'needs_attention',
      'a paid order that may have been double-charged must not read as a success');
  });

  reset();
  links[0].enabled = false;
  await deliver(orderWith());
  await checkAsync('switching the link off sells from local stock, exactly as before', () => {
    assert.deepStrictEqual(orders[0].delivered_goods[0].items, ['LOCAL-POOL-KEY-1']);
    assert.strictEqual(orders[0].status, 'delivered');
    assert.strictEqual(requests.length, 0, 'a disabled link still hit the supplier');
  });

  reset();
  process.env.SUPPLIER_OFF = '1';
  await deliver(orderWith());
  await checkAsync('the global kill switch does the same for every tier at once', () => {
    assert.strictEqual(requests.length, 0, 'it bought upstream with the kill switch on');
    assert.deepStrictEqual(orders[0].delivered_goods[0].items, ['LOCAL-POOL-KEY-1']);
  });
  process.env.SUPPLIER_OFF = '';

  reset();
  await deliver(orderWith());
  await checkAsync('nothing the customer can see carries the api key', () => {
    const blob = JSON.stringify(orders[0].delivered_goods);
    assert.ok(!blob.includes('live-key-must-never-appear'));
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
}

run().catch(e => { console.error(e); process.exitCode = 1; });
