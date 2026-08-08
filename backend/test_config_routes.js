// The two routes the admin panel talks to, exercised over real HTTP.
//
// They exist because POST /api/config/update authenticates with API_SECRET,
// which is a SERVER credential — the panel runs in a browser and holds a
// session token, not the secret. That is why the panel had no payment section
// at all rather than merely an incomplete one.
//
//   node test_config_routes.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// Three roles, because the gate here is deliberately NOT the one the rest of
// the panel uses: requireAdmin accepts 'staff', and closing the store's
// payment methods is not a moderation action.
const USERS = [
  { id: 1, username: 'owner', email: 'o@x.com', role: 'admin', banned: false },
  { id: 2, username: 'mod',   email: 'm@x.com', role: 'staff', banned: false },
  { id: 3, username: 'buyer', email: 'b@x.com', role: 'user',  banned: false },
];
const TOKENS = { 'tok-owner': 1, 'tok-staff': 2, 'tok-user': 3 };

process.env.GUILD_ID = 'test-guild';
process.env.API_SECRET = 'test-secret';
process.env.CASHAPP_CASHTAG = '$uhservices';
process.env.PAYPAL_EMAIL = 'shop@uhservices.xyz';
process.env.BTC_XPUB = 'xpub6CUGRUo';
delete process.env.LTC_XPUB;          // one genuinely unconfigured method
delete process.env.PAYMENT_METHODS_OFF;
delete process.env.PAYPAL_ME;

// The `config` table, as an object. Writes land here so a test can assert what
// was PERSISTED rather than only what came back in the response.
const stored = {};
let currentToken = null;

const dbPath = require.resolve('./db');
const exec = async (text, params) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (/FROM web_sessions s/.test(t)) {
    const id = TOKENS[currentToken];
    const u = USERS.find(x => x.id === id);
    return { rows: u ? [{ ...u }] : [] };
  }
  if (/INSERT INTO config/i.test(t)) {
    // Two shapes reach here: the generic /update (guild, key, value) and the
    // switch routes, which name their key in the statement.
    const named = (t.match(/VALUES \(\$1,'([A-Z_]+)',\$2/) || [])[1];
    if (named) stored[named] = params[1];
    else stored[String(params[1]).toUpperCase()] = params[2];
    return { rows: [] };
  }
  if (/SELECT key, value FROM config/.test(t)) {
    return { rows: Object.entries(stored).map(([key, value]) => ({ key, value })) };
  }
  return { rows: [] };
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: exec, withTransaction: async (fn) => fn(exec), pool: {} },
};

const app = express();
app.use(express.json());
app.use('/api/config', require('./routes/config'));
const server = http.createServer(app);

function req(method, path, { token, body } = {}) {
  currentToken = token || null;
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

server.listen(0, '127.0.0.1', async () => {
  console.log('\nthe switch routes are gated on the OWNER, not on staff');

  let r = await req('GET', '/api/config/payment-methods');
  check('anonymous cannot read the switches', () => assert.strictEqual(r.status, 401));

  r = await req('GET', '/api/config/payment-methods', { token: 'tok-user' });
  check('a customer cannot read the switches', () => assert.strictEqual(r.status, 403));

  // The distinction that matters. Staff manage the catalogue, stock and
  // reviews; they do not decide whether the shop can take money.
  r = await req('POST', '/api/config/payment-methods',
    { token: 'tok-staff', body: { method: 'paypal', enabled: false } });
  check('STAFF cannot close a payment method', () => {
    assert.strictEqual(r.status, 403);
    assert.strictEqual(stored.PAYMENT_METHODS_OFF, undefined, 'it was written anyway');
  });

  r = await req('GET', '/api/config/payment-methods', { token: 'tok-owner' });
  check('the owner can read them', () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.payment_method_states.paypal.state, 'on');
    assert.strictEqual(r.body.payment_method_states.ltc.state, 'unconfigured');
    // The third state. Cash App settles in USD or GBP and the shop prices in
    // euro, so it is not off and not misconfigured — it is impossible, and the
    // panel has to say so or staff go looking for a switch that would not help.
    assert.strictEqual(r.body.payment_method_states.cashapp.state, 'currency');
  });

  console.log('\nturning a method off');

  r = await req('POST', '/api/config/payment-methods',
    { token: 'tok-owner', body: { method: 'paypal', enabled: false } });
  check('the owner can close PayPal', () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.payment_method_states.paypal.state, 'off');
    assert.strictEqual(r.body.payment_methods.paypal, false);
  });
  check('it is persisted, not just held in memory', () => {
    assert.strictEqual(stored.PAYMENT_METHODS_OFF, 'paypal');
  });
  // The whole point: reopening must not need the address retyped.
  check('the PayPal address is untouched', () => {
    assert.strictEqual(process.env.PAYPAL_EMAIL, 'shop@uhservices.xyz');
  });
  check('the other methods are unaffected', () => {
    assert.strictEqual(r.body.payment_methods.btc, true);
    assert.strictEqual(r.body.payment_methods.ltc, false, 'ltc has no xpub here');
    // Not 'unaffected by the switch' in the sense of 'true' — Cash App is shut
    // by the shop currency, and closing PayPal must not change that either way.
    assert.strictEqual(r.body.payment_methods.cashapp, false);
  });

  // The public route is what the storefront and the Discord panel read.
  r = await req('GET', '/api/config');
  check('GET /api/config now reports PayPal as unavailable', () => {
    assert.strictEqual(r.body.payment_methods.paypal, false);
    assert.strictEqual(r.body.payment_method_states.paypal.state, 'off');
  });
  // Closed, but the address is still published for anyone mid-payment.
  check('the public route still tells "off" apart from "misconfigured"', () => {
    assert.strictEqual(r.body.payment_method_states.ltc.state, 'unconfigured');
  });

  r = await req('POST', '/api/config/payment-methods',
    { token: 'tok-owner', body: { method: 'btc', enabled: false } });
  check('a second method can be closed without reopening the first', () => {
    assert.strictEqual(stored.PAYMENT_METHODS_OFF, 'paypal,btc');
    assert.strictEqual(r.body.payment_methods.paypal, false);
    assert.strictEqual(r.body.payment_methods.btc, false);
  });

  r = await req('POST', '/api/config/payment-methods',
    { token: 'tok-owner', body: { method: 'paypal', enabled: true } });
  check('reopening removes only that one', () => {
    assert.strictEqual(stored.PAYMENT_METHODS_OFF, 'btc');
    assert.strictEqual(r.body.payment_methods.paypal, true);
    assert.strictEqual(r.body.payment_methods.btc, false);
  });

  // A typo must be LOUD. Silently filtering it out would report success while
  // the method stayed on — during whatever incident made you want it off.
  r = await req('POST', '/api/config/payment-methods',
    { token: 'tok-owner', body: { method: 'payapl', enabled: false } });
  check('a misspelled method is rejected, not ignored', () => {
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /Unknown payment method/);
    assert.strictEqual(stored.PAYMENT_METHODS_OFF, 'btc', 'the stored list changed anyway');
  });

  console.log('\nthe PayPal.Me handle behind the QR');

  r = await req('POST', '/api/config/paypal-me',
    { token: 'tok-owner', body: { handle: 'https://paypal.me/uhservices' } });
  check('a pasted link is stored as the bare handle', () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.paypal_me, 'uhservices');
    assert.strictEqual(stored.PAYPAL_ME, 'uhservices');
  });

  // The original bug, refused at the door. An email address in a paypalme/
  // path resolves to a "page not found".
  r = await req('POST', '/api/config/paypal-me',
    { token: 'tok-owner', body: { handle: 'shop@uhservices.xyz' } });
  check('an email address is refused as a handle', () => {
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /PayPal\.Me handle/);
    assert.strictEqual(stored.PAYPAL_ME, 'uhservices', 'the good handle was overwritten');
  });

  r = await req('POST', '/api/config/paypal-me', { token: 'tok-owner', body: { handle: '' } });
  check('an empty value clears it — that is a deliberate "no QR"', () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.paypal_me, null);
    assert.strictEqual(stored.PAYPAL_ME, '');
  });

  r = await req('POST', '/api/config/paypal-me', { token: 'tok-staff', body: { handle: 'x' } });
  check('staff cannot change it either', () => assert.strictEqual(r.status, 403));

  console.log('\nthe generic /update route validates the two new keys');

  r = await req('POST', '/api/config/update',
    { body: { secret: 'test-secret', key: 'PAYMENT_METHODS_OFF', value: 'paypal,payapl' } });
  check('a typo in the list is rejected there too', () => {
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /Not a payment method: payapl/);
  });

  r = await req('POST', '/api/config/update',
    { body: { secret: 'test-secret', key: 'PAYMENT_METHODS_OFF', value: ' LTC , cashapp ' } });
  check('a valid list is normalised and de-duplicated on the way in', () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(stored.PAYMENT_METHODS_OFF, 'cashapp,ltc');
  });

  r = await req('POST', '/api/config/update',
    { body: { secret: 'test-secret', key: 'PAYPAL_ME', value: '@uhservices' } });
  check('the bot can set the handle through /update', () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(stored.PAYPAL_ME, 'uhservices');
  });

  r = await req('POST', '/api/config/update',
    { body: { secret: 'wrong', key: 'PAYMENT_METHODS_OFF', value: '' } });
  check('the shared secret is still required on /update', () => assert.strictEqual(r.status, 401));

  // The config-row trap: a DB row beats the Railway env var at boot. These two
  // keys are MEANT to work that way — closing a method must not need a
  // redeploy — so this pins that they load rather than being skipped.
  console.log('\nboth keys survive a restart');
  delete process.env.PAYMENT_METHODS_OFF;
  delete process.env.PAYPAL_ME;
  await require('./routes/config').loadConfigFromDB();
  check('PAYMENT_METHODS_OFF is restored from the DB at boot', () => {
    assert.strictEqual(process.env.PAYMENT_METHODS_OFF, 'cashapp,ltc');
  });
  check('PAYPAL_ME is restored from the DB at boot', () => {
    assert.strictEqual(process.env.PAYPAL_ME, 'uhservices');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
});
