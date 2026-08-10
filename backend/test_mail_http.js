// Outbound mail over an HTTPS provider API.
//
// The reason this path exists at all: the production host blocks outbound
// SMTP. 587 and 465 both time out from inside the container while IMAP on 993
// to the same Google servers connects fine, so email 2FA codes could never be
// sent. These tests cover the selection rules and the exact request each
// provider is handed, because a malformed body is answered with a 200-plus-
// error by one of them and a customer waiting forever for a code by us.
'use strict';

const path = require('path');
const http = require('http');
const assert = require('assert');

const BACKEND = __dirname;
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('backend', 'utils'))) delete require.cache[k];
  }
  return require(path.join(BACKEND, 'utils', 'mailHttp.js'));
}
function setEnv(vars) {
  for (const k of Object.keys(process.env)) {
    if (/^(RESEND|BREVO|MAIL_FROM|SMTP_|GMAIL_|UHSERVICES_|PAYPAL_|CASHAPP_|MAIL_PROVIDER)/.test(k)) delete process.env[k];
  }
  Object.assign(process.env, vars);
}

// A stand-in for the provider: records exactly what arrived and replies with
// whatever the test asks for. A real socket, so axios' own serialisation and
// header handling are part of what is being tested rather than assumed.
let LAST = null;
let REPLY = { status: 200, body: { id: 'msg_1' } };
const api = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { body = raw; }
    LAST = { url: req.url, method: req.method, headers: req.headers, body };
    res.writeHead(REPLY.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(REPLY.body));
  });
});

// Point a provider at the stub by rewriting its endpoint in place.
function redirect(mod, label, base) {
  const p = mod.__test__.PROVIDERS.find(x => x.label === label);
  const original = p.send;
  p.send = (key, msg) => {
    const axios = require('axios');
    const post = axios.post;
    axios.post = (url, data, cfg) => post(base + new URL(url).pathname, data, cfg);
    return original(key, msg).finally(() => { axios.post = post; });
  };
}

async function run() {
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${api.address().port}`;

  console.log('\n=== which provider, and whether one is configured at all ===');
  {
    setEnv({});
    const m = fresh();
    check('no key means no HTTP mailer, so SMTP is still tried', () =>
      assert.strictEqual(m.httpMailer('a@b.c'), null));
  }
  {
    setEnv({ BREVO_API_KEY: 'k', MAIL_FROM: 'Ghost <no-reply@uhservices.xyz>' });
    const m = fresh();
    check('a Brevo key alone selects Brevo', () =>
      assert.strictEqual(m.httpMailer().label, 'brevo'));
  }
  {
    setEnv({ RESEND_API_KEY: 'k1', BREVO_API_KEY: 'k2', MAIL_FROM: 'a@b.c' });
    const m = fresh();
    check('Resend wins when both keys are set', () =>
      assert.strictEqual(m.httpMailer().label, 'resend'));
  }
  {
    setEnv({ RESEND_API_KEY: 'k' });
    const m = fresh();
    check('a key with no sender address is refused, not half-configured', () =>
      assert.strictEqual(m.httpMailer(), null));
  }
  {
    setEnv({ RESEND_API_KEY: 'k' });
    const m = fresh();
    check('the SMTP account\'s From is inherited when MAIL_FROM is unset', () =>
      assert.strictEqual(m.httpMailer('store@uhservices.xyz').from, 'store@uhservices.xyz'));
  }
  {
    setEnv({ RESEND_API_KEY: 'k', SMTP_FROM: 'legacy@uhservices.xyz' });
    const m = fresh();
    check('an existing SMTP_FROM is honoured, so no second variable is needed', () =>
      assert.strictEqual(m.httpMailer().from, 'legacy@uhservices.xyz'));
  }

  console.log('\n=== the request Resend is actually handed ===');
  {
    setEnv({ RESEND_API_KEY: 'secret-key', MAIL_FROM: 'Ghost Store <no-reply@uhservices.xyz>' });
    const m = fresh();
    redirect(m, 'resend', base);
    REPLY = { status: 200, body: { id: 'msg_abc' } };
    await checkAsync('sends the message and returns the provider id', async () => {
      const id = await m.httpMailer().sendMail({
        to: 'buyer@example.com', subject: '123456 is your code', html: '<b>123456</b>',
      });
      assert.strictEqual(id, 'msg_abc');
    });
    check('posts to the emails endpoint', () => assert.strictEqual(LAST.url, '/emails'));
    check('authenticates with a bearer token', () =>
      assert.strictEqual(LAST.headers.authorization, 'Bearer secret-key'));
    check('recipients are a list, as the API requires', () =>
      assert.deepStrictEqual(LAST.body.to, ['buyer@example.com']));
    check('the display name rides along in the From header', () =>
      assert.strictEqual(LAST.body.from, 'Ghost Store <no-reply@uhservices.xyz>'));
    check('subject and html survive the trip intact', () =>
      assert.ok(LAST.body.subject === '123456 is your code' && LAST.body.html === '<b>123456</b>'));

    // A caller that names its own From — the order confirmation does — must
    // not be overridden by the configured default.
    await checkAsync('a caller-supplied From is not overwritten', async () => {
      await m.httpMailer().sendMail({ from: 'Other <other@uhservices.xyz>', to: 'b@x.c', subject: 's', html: 'h' });
      assert.strictEqual(LAST.body.from, 'Other <other@uhservices.xyz>');
    });
  }

  console.log('\n=== the request Brevo is actually handed ===');
  {
    setEnv({ BREVO_API_KEY: 'brevo-key', MAIL_FROM: 'Ghost Store <no-reply@uhservices.xyz>' });
    const m = fresh();
    redirect(m, 'brevo', base);
    REPLY = { status: 201, body: { messageId: '<abc@brevo>' } };
    await checkAsync('sends and returns the message id', async () => {
      const id = await m.httpMailer().sendMail({ to: 'buyer@example.com', subject: 's', html: 'h' });
      assert.strictEqual(id, '<abc@brevo>');
    });
    check('posts to the v3 transactional endpoint', () =>
      assert.strictEqual(LAST.url, '/v3/smtp/email'));
    check('authenticates with the api-key header, not a bearer', () =>
      assert.ok(LAST.headers['api-key'] === 'brevo-key' && !LAST.headers.authorization));
    // Brevo rejects a From header string; it wants the parts separately.
    check('the From is split into name and email', () =>
      assert.deepStrictEqual(LAST.body.sender, { name: 'Ghost Store', email: 'no-reply@uhservices.xyz' }));
    check('recipients are objects, not bare strings', () =>
      assert.deepStrictEqual(LAST.body.to, [{ email: 'buyer@example.com' }]));
    check('the body is htmlContent, which is what Brevo reads', () =>
      assert.ok(LAST.body.htmlContent === 'h' && LAST.body.html === undefined));

    await checkAsync('a bare address with no display name sends no empty name', async () => {
      setEnv({ BREVO_API_KEY: 'brevo-key', MAIL_FROM: 'no-reply@uhservices.xyz' });
      const m2 = fresh();
      redirect(m2, 'brevo', base);
      await m2.httpMailer().sendMail({ to: 'b@x.c', subject: 's', html: 'h' });
      assert.deepStrictEqual(LAST.body.sender, { email: 'no-reply@uhservices.xyz' });
    });
  }

  console.log('\n=== a rejection must not read as a delivery ===');
  {
    setEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'a@uhservices.xyz' });
    const m = fresh();
    redirect(m, 'resend', base);
    // The trap: a 200 whose body carries an error. Domain not verified is the
    // one that will actually happen on the first real send.
    REPLY = { status: 200, body: { error: { message: 'The uhservices.xyz domain is not verified' } } };
    await checkAsync('a 200 carrying an error still throws', async () => {
      await assert.rejects(
        () => m.httpMailer().sendMail({ to: 'b@x.c', subject: 's', html: 'h' }),
        /not verified/);
    });
    REPLY = { status: 401, body: { message: 'invalid api key' } };
    await checkAsync('an HTTP failure throws rather than reporting success', async () => {
      await assert.rejects(() => m.httpMailer().sendMail({ to: 'b@x.c', subject: 's', html: 'h' }));
    });
    REPLY = { status: 200, body: { id: 'ok' } };
  }

  console.log('\n=== the From header utils/email.js actually builds ===');
  {
    // The bug this covers reached a live send: MAIL_FROM is naturally written
    // with a display name, and email.js wrapped it in a second one, producing
    // `Ghost Store <Ghost Store <addr>>`. Resend answered 422 and the code
    // never arrived. Order confirmations were building the same header.
    setEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'Ghost Store <no-reply@uhservices.xyz>', STORE_NAME: 'Ghost Store' });
    const m = fresh();
    redirect(m, 'resend', base);
    const { sendLoginCode, sendOrderConfirmation } = require(path.join(BACKEND, 'utils', 'email.js'));

    await checkAsync('a MAIL_FROM that already has a display name is not wrapped again', async () => {
      assert.strictEqual(await sendLoginCode('b@x.c', '123456', 'setup'), true);
      assert.strictEqual(LAST.body.from, 'Ghost Store <no-reply@uhservices.xyz>');
    });
    await checkAsync('order confirmations build the same header, not a nested one', async () => {
      await sendOrderConfirmation({ id: 'o1', email: 'b@x.c', total_cents: 100, payment_method: 'cashapp' }, []);
      assert.strictEqual(LAST.body.from, 'Ghost Store <no-reply@uhservices.xyz>');
    });
  }
  {
    setEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'no-reply@uhservices.xyz', STORE_NAME: 'Ghost Store' });
    const m = fresh();
    redirect(m, 'resend', base);
    const { sendLoginCode } = require(path.join(BACKEND, 'utils', 'email.js'));
    await checkAsync('a bare MAIL_FROM still gets the store name attached', async () => {
      await sendLoginCode('b@x.c', '123456', 'setup');
      assert.strictEqual(LAST.body.from, 'Ghost Store <no-reply@uhservices.xyz>');
    });
  }
  {
    // axios reduces a rejection to "Request failed with status code 422" and
    // hides the reason in the body. That cost a debugging round.
    setEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'a@uhservices.xyz' });
    const m = fresh();
    redirect(m, 'resend', base);
    REPLY = { status: 403, body: { message: 'The uhservices.xyz domain is not verified' } };
    await checkAsync('the provider\'s own explanation reaches the log, not just a status code', async () => {
      await assert.rejects(
        () => m.httpMailer().sendMail({ to: 'b@x.c', subject: 's', html: 'h' }),
        /HTTP 403.*domain is not verified/);
    });
    REPLY = { status: 200, body: { id: 'ok' } };
  }

  console.log('\n=== the store name the customer reads ===');
  {
    // The confirmation that prompted this carried THREE names: it came from
    // "Ghost Store", called itself "ONTOP SHOP" in the body, and was for a store
    // the buyer knows on Discord as ONTOP. A From that disagrees with the
    // content reads as phishing to a person and as a spam signal to a filter.
    // utils/email.js used to default to 'Ghost Store' while /health and
    // routes/config.js defaulted to 'ONTOP Shop', so an unset STORE_NAME made
    // the answer depend on which file you asked.
    setEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'ONTOP Shop <no-reply@ontop.uhservices.xyz>' });
    // setEnv only clears the mail variables; the point of this block is what
    // happens with NO store name configured at all.
    delete process.env.STORE_NAME;
    const m = fresh();
    redirect(m, 'resend', base);
    const { sendOrderConfirmation } = require(path.join(BACKEND, 'utils', 'email.js'));
    await checkAsync('with STORE_NAME unset, the body name matches /health\'s fallback', async () => {
      await sendOrderConfirmation({ id: 'o9', email: 'b@x.c', total_cents: 100, payment_method: 'balance' }, []);
      assert.ok(LAST.body.html.includes('ONTOP SHOP'), 'header carries the shared fallback');
      assert.ok(!/Ghost Store/.test(LAST.body.html), 'the old second default is gone');
    });
    check('and the From the customer sees is the same name', () =>
      assert.strictEqual(LAST.body.from, 'ONTOP Shop <no-reply@ontop.uhservices.xyz>'));
  }

  console.log('\n=== what the receipt actually tells the customer ===');
  {
    // The complaint that prompted this: a five-line order confirmed as a list
    // of five bare product names. No duration, no quantity, no unit price, no
    // date, and an order id of "#10" that says how many orders the shop has
    // ever taken.
    setEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'ONTOP Shop <user@example.com>' });
    process.env.DISCORD_INVITE_URL = 'https://discord.gg/example';
    const m = fresh();
    redirect(m, 'resend', base);
    const { sendOrderConfirmation } = require(path.join(BACKEND, 'utils', 'email.js'));

    const order = {
      id: 10,
      invoice_no: 'K7QM-3XR9',
      email: 'b@x.c',
      payment_method: 'cashapp',
      subtotal_cents: 2000,
      coupon_code: 'SAVE10',
      coupon_discount_cents: 200,
      total_cents: 1980,
      paid_at: '2026-07-31T12:54:00.000Z',
      items_snapshot: [
        { id: '11', product_name: 'Ancient', tier_label: 'Day', qty: 4, price: 2.50 },
        { id: '12', product_name: "HEAVEN'S BLINDSPOT", tier_label: 'Month', qty: 1, price: 10.00 },
      ],
    };
    const goods = [
      { product: 'Ancient', tier_label: 'Day', qty: 4, unit_price: 2.5, items: ['K-1', 'K-2', 'K-3', 'K-4'] },
      { product: "HEAVEN'S BLINDSPOT", tier_label: 'Month', qty: 1, unit_price: 10, items: ['K-5'] },
    ];

    await checkAsync('every line names its product, its term, its count and its unit price', async () => {
      assert.strictEqual(await sendOrderConfirmation(order, goods), true);
      const h = LAST.body.html;
      assert.ok(h.includes('Ancient'), 'product name');
      assert.ok(h.includes('Day') && h.includes('Month'), 'subscription term');
      assert.ok(/>4</.test(h), 'quantity');
      assert.ok(h.includes('€2.50'), 'unit price');
      assert.ok(h.includes('€10.00'), 'line total for the 4× line');
    });
    check('the apostrophe in a product name is escaped, not rendered as markup', () =>
      assert.ok(LAST.body.html.includes('HEAVEN&#39;S BLINDSPOT')));
    check('the order carries a date', () =>
      assert.ok(/Jul 31, 2026.*UTC/.test(LAST.body.html)));
    check('the printed reference is the invoice number, not the sequential id', () =>
      assert.ok(LAST.body.html.includes('K7QM-3XR9') && !/#10/.test(LAST.body.html)));
    check('the subject line carries it too', () =>
      assert.ok(LAST.body.subject.includes('K7QM-3XR9')));
    check('subtotal, coupon, fee and total are all shown', () => {
      const h = LAST.body.html;
      assert.ok(h.includes('€20.00'), 'subtotal');
      assert.ok(h.includes('-€2.00'), 'coupon line');
      assert.ok(h.includes('€1.80'), 'the cashapp fee, as the gap between the two');
      assert.ok(h.includes('€19.80'), 'total');
    });
    check('there is a Discord button, pointing at the configured invite', () =>
      assert.ok(/<a href="https:\/\/discord\.gg\/example"[^>]*>Join our Discord<\/a>/.test(LAST.body.html)));
    check('and it says what to bring to claim the customer role', () =>
      assert.ok(/Claim your customer role/.test(LAST.body.html)));

    await checkAsync('an order with no invoice number still shows something usable', async () => {
      await sendOrderConfirmation({ ...order, invoice_no: null }, goods);
      assert.ok(LAST.body.html.includes('#10'));
    });
    // A pre-existing order predates the split columns: its duration is inside
    // the collapsed name and there is nothing to put in the term column.
    await checkAsync('a legacy items_snapshot without split columns still renders', async () => {
      await sendOrderConfirmation(
        { ...order, items_snapshot: [{ id: 'x', name: 'Ancient (Day)', qty: 1, price: 5 }] }, goods);
      assert.ok(LAST.body.html.includes('Ancient (Day)'));
    });
    await checkAsync('a JSON string items_snapshot is parsed, not printed', async () => {
      await sendOrderConfirmation({ ...order, items_snapshot: JSON.stringify(order.items_snapshot) }, goods);
      assert.ok(LAST.body.html.includes('€2.50') && !LAST.body.html.includes('items_snapshot'));
    });
    delete process.env.DISCORD_INVITE_URL;
  }

  console.log('\n=== address parsing ===');
  {
    const m = fresh();
    check('a quoted display name is unquoted', () =>
      assert.deepStrictEqual(m.splitAddress('"Ghost Store" <a@b.c>'), { name: 'Ghost Store', email: 'a@b.c' }));
    check('a bare address has no name', () =>
      assert.deepStrictEqual(m.splitAddress('a@b.c'), { name: null, email: 'a@b.c' }));
    check('surrounding whitespace is not sent to the provider', () =>
      assert.deepStrictEqual(m.splitAddress('  Ghost <  a@b.c  >  '), { name: 'Ghost', email: 'a@b.c' }));
    check('a comma-separated list becomes several recipients', () =>
      assert.deepStrictEqual(m.recipients('a@b.c, d@e.f'), ['a@b.c', 'd@e.f']));
  }

  api.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
