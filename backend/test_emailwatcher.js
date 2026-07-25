// Batch 13 — emailWatcher sender-verification + amount-validation tests.
// Loads the real module and exercises processEmail() end to end with a stubbed
// DB + axios, so the assertions cover the shipped code paths rather than a copy.

const path = require('path');
const Module = require('module');

const BACKEND = __dirname;
process.env.GUILD_ID = 'g1';
process.env.API_SECRET = 'secret';
process.env.PORT = '3000';

// ─── stub db + axios before the watcher requires them ───
let ORDERS = [];
const CONFIRMS = [];
const UPDATES = [];

require.cache[require.resolve(path.join(BACKEND, 'db.js'))] = {
  id: 'db', filename: 'db', loaded: true,
  exports: {
    query: async (sql, params) => {
      if (/UPDATE orders SET status = 'underpaid'/.test(sql)) {
        UPDATES.push({ sql, params });
        return { rows: [] };
      }
      if (/FROM orders/.test(sql)) {
        const [, note, method] = params;
        return { rows: ORDERS.filter(o => o.payment_note === note && o.payment_method === method) };
      }
      return { rows: [] };
    },
  },
};

require.cache[require.resolve('axios', { paths: [BACKEND] })] = {
  id: 'axios', filename: 'axios', loaded: true,
  exports: { post: async (url, body) => { CONFIRMS.push({ url, body }); return { data: {} }; } },
};

const watcher = require(path.join(BACKEND, 'watchers', 'emailWatcher.js'));
const { processEmail } = watcher.__test__;

// ─── helpers ───
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const gmailAuth = (d) =>
  `Authentication-Results: mx.google.com; dkim=pass header.i=@${d}; spf=pass; dmarc=pass header.from=${d}`;

function email({ auth, subject, text }) {
  return {
    subject,
    text,
    headerLines: auth ? [{ key: 'authentication-results', line: auth }] : [],
  };
}

function reset(orders) {
  ORDERS = orders || [];
  CONFIRMS.length = 0;
  UPDATES.length = 0;
}

const paypalBody = (amount, note) =>
  `Hello,\n\nYou received $${amount} USD\n\nNote from Buyer\n${note}\n\nThanks`;

const ORDER = { id: 42, payment_note: 'ghostwave1234', payment_method: 'paypal', total_cents: 1999 };

(async () => {
  console.log('\n=== emailWatcher: sender verification ===');

  // 1. The original exploit: no auth header at all, subject-only trigger.
  reset([ORDER]);
  await processEmail(email({ subject: 'sent you a payment', text: paypalBody('19.99', 'ghostwave1234') }));
  check('forged mail with NO Authentication-Results is ignored', CONFIRMS.length === 0);

  // 2. Attacker supplies their own Authentication-Results header.
  reset([ORDER]);
  await processEmail(email({
    auth: 'Authentication-Results: evil.example.com; dmarc=pass header.from=paypal.com',
    subject: 'sent you', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('self-asserted auth header (not mx.google.com) is ignored', CONFIRMS.length === 0);

  // 3. DMARC pass, but from an unrelated domain.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('attacker.com'), subject: 'sent you', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('DMARC pass from a non-provider domain is ignored', CONFIRMS.length === 0);

  // 4. Lookalike domain must not satisfy the paypal.com suffix check.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('notpaypal.com'), subject: 'sent you', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('lookalike domain "notpaypal.com" is rejected', CONFIRMS.length === 0);

  // 5. dmarc=fail must not pass even on the right domain.
  reset([ORDER]);
  await processEmail(email({
    auth: 'Authentication-Results: mx.google.com; dkim=fail; spf=fail; dmarc=fail header.from=paypal.com',
    subject: 'sent you', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('dmarc=fail on paypal.com is rejected', CONFIRMS.length === 0);

  // 6. The genuine article.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'You received a payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('real DMARC-passing paypal.com mail confirms the order', CONFIRMS.length === 1);

  // 7. Subdomain of an allowed provider.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('e.paypal.com'), subject: 'You received a payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('subdomain e.paypal.com is accepted', CONFIRMS.length === 1);

  console.log('\n=== emailWatcher: amount validation ===');

  // 8. The fail-open: no dollar figure in the body.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment',
    text: 'Hello,\n\nYou got paid!\n\nNote from Buyer\nghostwave1234\n',
  }));
  check('missing amount does NOT confirm (was fail-open)', CONFIRMS.length === 0);

  // 9. Underpayment.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('0.01', 'ghostwave1234'),
  }));
  check('$0.01 against a $19.99 order is rejected', CONFIRMS.length === 0);
  check('underpaid order is flagged for review', UPDATES.length === 1);

  // 10. The old +/-$1.00 window let $19.00 through on a $19.99 order.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.00', 'ghostwave1234'),
  }));
  check('$19.00 against $19.99 is rejected (old tolerance allowed it)', CONFIRMS.length === 0);

  // 11. Exact payment.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('exact amount confirms', CONFIRMS.length === 1);

  // 12. Overpayment is accepted, not bounced.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('25.00', 'ghostwave1234'),
  }));
  check('overpayment confirms', CONFIRMS.length === 1);

  // 13. Unknown note matches no order.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.99', 'zzzznope9999'),
  }));
  check('unknown note confirms nothing', CONFIRMS.length === 0);

  // 14. The removed findNoteInText fallback scanned every pending order.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment',
    text: 'Payment of $19.99 USD\n\nghostwave1234 aaaa1111 bbbb2222 cccc3333\n',
  }));
  check('note sprayed in the body without the "Note from" marker is ignored', CONFIRMS.length === 0);

  // 15. Cash App happy path.
  reset([{ ...ORDER, payment_method: 'cashapp' }]);
  await processEmail(email({
    auth: gmailAuth('cash.app'), subject: 'payment',
    text: 'You received $19.99\n\nNote: ghostwave1234\n',
  }));
  check('Cash App exact payment confirms', CONFIRMS.length === 1);

  // 16. Cash App underpay.
  reset([{ ...ORDER, payment_method: 'cashapp' }]);
  await processEmail(email({
    auth: gmailAuth('cash.app'), subject: 'payment',
    text: 'You received $1.00\n\nNote: ghostwave1234\n',
  }));
  check('Cash App underpayment is rejected', CONFIRMS.length === 0);

  // 17. Cross-method: a cashapp order must not settle from a PayPal mail.
  reset([{ ...ORDER, payment_method: 'cashapp' }]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('paypal mail cannot confirm a cashapp order', CONFIRMS.length === 0);

  console.log('\n=== noteGenerator entropy ===');
  const { generateNote } = require(path.join(BACKEND, 'utils', 'noteGenerator.js'));
  const notes = new Set();
  for (let i = 0; i < 2000; i++) notes.add(generateNote());
  check('2000 notes yield >1900 distinct values', notes.size > 1900);
  check('note shape is letters + 4 digits', /^[a-z]{4,12}\d{4}$/.test(generateNote()));
  const src = require('fs').readFileSync(path.join(BACKEND, 'utils', 'noteGenerator.js'), 'utf8');
  check('noteGenerator no longer uses Math.random', !/Math\.random/.test(src));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
