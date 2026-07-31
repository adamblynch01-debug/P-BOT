// Payment-path regression tests.
//
// Batch 13 covered sender verification and amount validation. Batch 14 adds the
// guards that closed the DKIM-replay hole, the non-final/foreign-currency
// rejections, message-level idempotency, and the money arithmetic.
//
// Loads the real modules with a stubbed DB + axios, so the assertions cover the
// shipped code paths rather than a copy of them.

const path = require('path');

const BACKEND = __dirname;
process.env.GUILD_ID = 'g1';
process.env.API_SECRET = 'secret';
process.env.PORT = '3000';
// Our own receiving identities. addressedToUs requires one of these to appear in
// the email, which is what makes a forwarded third-party receipt fail.
process.env.PAYPAL_EMAIL = 'store@ghost.example';
process.env.CASHAPP_CASHTAG = '$ghoststore';
// The mailbox itself. Deliberately NOT a merchant identity: every message Gmail
// accepts carries `Delivered-To: <GMAIL_USER>`, so treating it as proof of
// receipt would accept any forwarded receipt.
process.env.GMAIL_USER = 'ghoststore.mail@gmail.com';

// ─── stub db + axios before the watchers require them ───
let ORDERS = [];
const CONFIRMS = [];
const UPDATES = [];
const ALERTS = [];
const RELEASED = [];
let SEEN_MESSAGE_IDS = new Set();
let DEDUPE_BROKEN = false;

const dbStub = {
  query: async (sql, params) => {
    if (/INSERT INTO processed_emails/.test(sql)) {
      if (DEDUPE_BROKEN) throw new Error('dedupe store down');
      const id = params[0];
      if (SEEN_MESSAGE_IDS.has(id)) return { rows: [], rowCount: 0 };
      SEEN_MESSAGE_IDS.add(id);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE processed_emails/.test(sql)) return { rows: [], rowCount: 1 };
    // Claim release. Modelled for real, so "was this message left reprocessable?"
    // is an observable property of the run rather than a source assertion.
    if (/DELETE FROM processed_emails/.test(sql)) {
      SEEN_MESSAGE_IDS.delete(params[0]);
      RELEASED.push(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO ops_alerts/.test(sql)) return { rows: [], rowCount: 1 };
    if (/UPDATE orders SET status = 'underpaid'/.test(sql)) {
      UPDATES.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM orders/.test(sql)) {
      const [, note, method] = params;
      return { rows: ORDERS.filter(o => o.payment_note === note && o.payment_method === method) };
    }
    return { rows: [], rowCount: 0 };
  },
};

require.cache[require.resolve(path.join(BACKEND, 'db.js'))] = {
  id: 'db', filename: 'db', loaded: true, exports: dbStub,
};

require.cache[require.resolve('axios', { paths: [BACKEND] })] = {
  id: 'axios', filename: 'axios', loaded: true,
  exports: {
    post: async (url, body) => {
      if (/internal\//.test(url)) return { data: {} }; // botNotify
      CONFIRMS.push({ url, body });
      return { data: {} };
    },
    get: async () => ({ data: {} }),
  },
};

// Capture alerts at the source so every rejection path can be asserted on.
const alertsPath = require.resolve(path.join(BACKEND, 'utils', 'alerts.js'));
const realAlerts = require(alertsPath);
require.cache[alertsPath].exports = {
  ...realAlerts,
  raiseAlert: async (kind, message, opts) => { ALERTS.push({ kind, message, opts }); },
};

const watcher = require(path.join(BACKEND, 'watchers', 'emailWatcher.js'));
const {
  processEmail, addressedToUs, nonFinalReason, foreignCurrencyReason, parseAmount,
} = watcher.__test__;

// ─── helpers ───
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const gmailAuth = (d) =>
  `Authentication-Results: mx.google.com; dkim=pass header.i=@${d}; spf=pass; dmarc=pass header.from=${d}`;

let midCounter = 0;
function email({ auth, subject, text, messageId, to, deliveredTo }) {
  const headerLines = [];
  if (auth) headerLines.push({ key: 'authentication-results', line: auth });
  if (deliveredTo) headerLines.push({ key: 'delivered-to', line: `Delivered-To: ${deliveredTo}` });
  return {
    subject,
    text,
    messageId: messageId === null ? undefined : (messageId || `<mid-${++midCounter}@provider.test>`),
    to: to ? { text: to } : undefined,
    headerLines,
  };
}

function reset(orders) {
  ORDERS = orders || [];
  CONFIRMS.length = 0;
  UPDATES.length = 0;
  ALERTS.length = 0;
  RELEASED.length = 0;
  SEEN_MESSAGE_IDS = new Set();
  DEDUPE_BROKEN = false;
}

const alerted = (kind) => ALERTS.some(a => a.kind === kind);

// Genuine provider bodies now have to name our receiving account, exactly as a
// real one does ("You received a payment ... to store@ghost.example").
const paypalBody = (amount, note) =>
  `Hello store@ghost.example,\n\nYou received $${amount} USD\n\nNote from Buyer\n${note}\n\nThanks`;

const cashappBody = (amount, note) =>
  `You received $${amount} to $ghoststore\n\nNote: ${note}\n`;

const ORDER = { id: 42, payment_note: 'ghostwave1234', payment_method: 'paypal', total_cents: 1999, email: 'buyer@x.test' };
const CASH_ORDER = { ...ORDER, payment_method: 'cashapp' };

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

  // 6. dkim=pass WITHOUT dmarc=pass. The old code accepted this; DKIM alone does
  //    not require alignment with the From domain.
  reset([ORDER]);
  await processEmail(email({
    auth: 'Authentication-Results: mx.google.com; dkim=pass header.i=@paypal.com; spf=pass',
    subject: 'sent you', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('dkim=pass without dmarc=pass is rejected (fallback removed)', CONFIRMS.length === 0);

  // 7. The genuine article.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'You received a payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('real DMARC-passing paypal.com mail confirms the order', CONFIRMS.length === 1);

  // 8. Subdomain of an allowed provider.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('e.paypal.com'), subject: 'You received a payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('subdomain e.paypal.com is accepted', CONFIRMS.length === 1);

  // 9. Trailing-dot FQDN (a fully-qualified "paypal.com." in the header).
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com.'), subject: 'payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('trailing-dot FQDN "paypal.com." still matches', CONFIRMS.length === 1);

  console.log('\n=== DKIM replay: was the money paid to US? ===');

  // 10. THE HOLE Batch 13 left open. Everything here is genuine: real
  //     paypal.com DMARC pass, real "sent you $19.99", our note in the memo.
  //     The attacker paid their OWN second account and forwarded the raw
  //     message. DKIM signs headers and body, not the envelope recipient, so it
  //     verifies — but the receipt names the attacker's account, not ours.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'You received a payment',
    text: 'Hello attacker@evil.test,\n\nYou received $19.99 USD\n\nNote from Buyer\nghostwave1234\n\nThanks',
  }));
  check('forwarded genuine receipt for someone ELSE\'s account does not confirm', CONFIRMS.length === 0);

  // 11. Same, addressed to us — the control case proving #10 fails for the
  //     right reason and not because the fixture is malformed.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('same email naming OUR paypal address does confirm', CONFIRMS.length === 1);

  // 12. VERIFIED BYPASS #1. The To header is rewritten freely by whoever
  //     forwards the message — it is not signed and not the envelope recipient.
  //     Accepting it meant an attacker's genuine receipt, forwarded with
  //     `To: store@ghost.example`, confirmed the order. The body names nobody.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', to: 'store@ghost.example',
    text: 'Hello,\n\nYou received $19.99 USD\n\nNote from Buyer\nghostwave1234\n',
  }));
  check('an identity in the To header alone does NOT confirm', CONFIRMS.length === 0);

  // 12b. VERIFIED BYPASS #2. Gmail stamps Delivered-To: <GMAIL_USER> on every
  //      message it accepts, so a check that counted our mailbox address as a
  //      merchant identity passed for literally any delivered mail — including a
  //      forwarded third-party receipt. Probe before the fix: accepted? true.
  reset([CASH_ORDER]);
  await processEmail(email({
    auth: gmailAuth('cash.app'), subject: 'payment', deliveredTo: `<${process.env.GMAIL_USER}>`,
    text: 'You received $19.99 to $attackercashtag\n\nNote: ghostwave1234\n',
  }));
  check('Delivered-To our own mailbox is not proof of receipt', CONFIRMS.length === 0);

  // 12c. VERIFIED BYPASS #3. The payer writes the memo, and the memo is INSIDE
  //      the DKIM-signed body — so a two-line memo injects our address into
  //      genuinely signed content. Only the provider's own text, positionally
  //      above the memo marker, may be searched. Probe before the fix:
  //      accepted? true.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'You received a payment',
    text: 'Hello attacker@evil.test,\n\nYou received $19.99 USD\n\nNote from Buyer\nghostwave1234\nstore@ghost.example\n\nThanks',
  }));
  check('our address injected via the payer memo does NOT confirm', CONFIRMS.length === 0);

  // 13. Cash App equivalent — cashtag must appear.
  reset([CASH_ORDER]);
  await processEmail(email({
    auth: gmailAuth('cash.app'), subject: 'payment',
    text: 'You received $19.99 to $someoneelse\n\nNote: ghostwave1234\n',
  }));
  check('Cash App receipt naming a different cashtag does not confirm', CONFIRMS.length === 0);

  // 14. addressedToUs must fail closed when nothing is configured — an empty env
  //     var must never mean "accept anything".
  const savedPaypalEmail = process.env.PAYPAL_EMAIL;
  delete process.env.PAYPAL_EMAIL;
  const noIdentity = addressedToUs({ subject: '' }, 'You received $19.99', 'paypal');
  check('no configured merchant identity fails closed', noIdentity.ok === false);
  process.env.PAYPAL_EMAIL = savedPaypalEmail;

  console.log('\n=== non-final payments ===');

  // 15-20. An eCheck or pending payment reads almost identically to a cleared
  //        one but can bounce days after the key is handed over.
  const nonFinalCases = [
    ['pending', 'Your payment is pending'],
    ['eCheck', 'This payment was sent as an eCheck'],
    ['unclaimed', 'The payment is unclaimed'],
    ['refund', 'A refund was issued'],
    ['chargeback', 'A chargeback was opened'],
    ['money request', 'Buyer is requesting money from you'],
  ];
  for (const [label, phrase] of nonFinalCases) {
    reset([ORDER]);
    await processEmail(email({
      auth: gmailAuth('paypal.com'), subject: 'payment',
      text: `Hello store@ghost.example,\n\n${phrase}\n\nYou received $19.99 USD\n\nNote from Buyer\nghostwave1234\n`,
    }));
    check(`non-final "${label}" does not confirm`, CONFIRMS.length === 0);
  }

  // 21. And it tells someone, rather than dropping the mail silently.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment',
    text: `Hello store@ghost.example,\n\nThis payment is pending\n\nYou received $19.99 USD\n\nNote from Buyer\nghostwave1234\n`,
  }));
  check('non-final payment raises an alert', alerted('email_payment_not_final'));

  // 22. "will be available" (a hold) must not be treated as settled.
  check('nonFinalReason flags a funds hold', !!nonFinalReason({ subject: '' }, 'Funds will be available in 3 days'));

  // 23. A clean settled body must NOT trip any pattern.
  check('a clean settled receipt trips no non-final pattern',
    nonFinalReason({ subject: 'You received a payment' }, paypalBody('19.99', 'ghostwave1234')) === null);

  // 23b. VERIFIED BYPASS #4 — the opposite failure, and the one that would have
  //      stranded every real paying customer at launch. Genuine provider receipts
  //      carry boilerplate footers naming the Resolution Center, the refund
  //      policy, and when funds "will be available". Scanning the whole body
  //      rejected a fully settled payment. Probe before the fix:
  //      "matched non-final pattern /\bdispute[ds]?\b/i".
  const settledWithFooter =
    'Hello store@ghost.example,\n\nYou received $19.99 USD\n\nNote from Buyer\nghostwave1234\n\n' +
    'Questions? Visit the Resolution Center to open a dispute.\n' +
    'Refunds are subject to our refund policy. Funds will be available per your account terms.\n' +
    'Please do not reply to this email.\n' +
    'Copyright 1999-2026 PayPal, Inc. All rights reserved.\n';
  check('a settled receipt with a dispute/refund footer is NOT rejected',
    nonFinalReason({ subject: 'You received a payment' }, settledWithFooter) === null);

  // 23c. End to end: that same receipt must actually settle the order.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'You received a payment', text: settledWithFooter,
  }));
  check('a real receipt with legal boilerplate still confirms', CONFIRMS.length === 1);

  // 23d. The footer cut must not become a new bypass: a genuinely non-final
  //      status sits ABOVE the footer and still has to be caught.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment',
    text: 'Hello store@ghost.example,\n\nYour payment is pending\n\nYou received $19.99 USD\n\n' +
      'Note from Buyer\nghostwave1234\n\nQuestions? Visit the Resolution Center.\n',
  }));
  check('a pending status above the footer is still caught', CONFIRMS.length === 0);

  console.log('\n=== foreign currency ===');

  // 24. PayPal renders MXN with the same "$". $19.99 MXN is about one US dollar.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment',
    text: 'Hello store@ghost.example,\n\nYou received $19.99 MXN\n\nNote from Buyer\nghostwave1234\n',
  }));
  check('$19.99 MXN does not settle a $19.99 USD order', CONFIRMS.length === 0);
  check('foreign currency raises an alert', alerted('email_payment_foreign_currency'));

  check('CAD is flagged', !!foreignCurrencyReason('You received $19.99 CAD'));
  check('EUR is flagged', !!foreignCurrencyReason('You received $19.99 EUR'));
  check('plain USD is not flagged', foreignCurrencyReason('You received $19.99 USD') === null);

  console.log('\n=== message-level idempotency ===');

  // 25. PayPal sends more than one notification per payment, and a wider IMAP
  //     re-scan re-delivers old mail. The same Message-ID must settle once.
  reset([ORDER]);
  const dupe = email({
    auth: gmailAuth('paypal.com'), subject: 'payment',
    text: paypalBody('19.99', 'ghostwave1234'), messageId: '<same-id@paypal.com>',
  });
  await processEmail(dupe);
  await processEmail({ ...dupe });
  await processEmail({ ...dupe });
  check('the same Message-ID confirms exactly once', CONFIRMS.length === 1);

  // 26. The confirm POST carries the message id, so /confirm's unique index is a
  //     second line of defence behind the local dedupe table.
  check('confirm carries provider_txn_id', CONFIRMS[0].body.provider_txn_id === '<same-id@paypal.com>');

  // 27. No Message-ID means we cannot recognise the mail again. Refuse.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment',
    text: paypalBody('19.99', 'ghostwave1234'), messageId: null,
  }));
  check('email with no Message-ID is refused', CONFIRMS.length === 0);

  // 28. If the dedupe store is unreachable we cannot promise exactly-once, so
  //     decline and let the next scan retry rather than risk double delivery.
  reset([ORDER]);
  DEDUPE_BROKEN = true;
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('unreachable dedupe store declines rather than double-delivering', CONFIRMS.length === 0);
  DEDUPE_BROKEN = false;

  console.log('\n=== claim recoverability ===');

  // 28b. The Message-ID is claimed BEFORE the body is classified, so a classifier
  //      mistake would otherwise be permanent — the mail could never be
  //      reconsidered without a hand-written DELETE. Non-terminal rejections must
  //      hand the claim back.
  reset([ORDER]);
  const pendingMail = email({
    auth: gmailAuth('paypal.com'), subject: 'payment', messageId: '<recoverable@paypal.com>',
    text: 'Hello store@ghost.example,\n\nYour payment is pending\n\nYou received $19.99 USD\n\nNote from Buyer\nghostwave1234\n',
  });
  await processEmail(pendingMail);
  check('a non-final rejection releases its claim', RELEASED.includes('<recoverable@paypal.com>'));

  // 28c. And the release must be real: once the classifier is corrected (here,
  //      the same payment arriving settled under the same id) it settles.
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', messageId: '<recoverable@paypal.com>',
    text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('a released message can still be settled later', CONFIRMS.length === 1);

  // 28d. A foreign-currency rejection is the same shape — the amount may be a
  //      parser gap on our side, not a real mismatch.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', messageId: '<fx@paypal.com>',
    text: 'Hello store@ghost.example,\n\nYou received $19.99 MXN\n\nNote from Buyer\nghostwave1234\n',
  }));
  check('a foreign-currency rejection releases its claim', RELEASED.includes('<fx@paypal.com>'));

  // 28e. An unparseable note means the provider changed its format. Releasing
  //      lets the fix pick the payment up; recording would strand it.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', messageId: '<nonote@paypal.com>',
    text: 'Hello store@ghost.example,\n\nYou received $19.99 USD\n\nThanks',
  }));
  check('an unparseable PayPal note releases its claim', RELEASED.includes('<nonote@paypal.com>'));

  reset([CASH_ORDER]);
  await processEmail(email({
    auth: gmailAuth('cash.app'), subject: 'payment', messageId: '<nonote@cash.app>',
    text: 'You received $19.99 to $ghoststore\n',
  }));
  check('an unparseable Cash App note releases its claim', RELEASED.includes('<nonote@cash.app>'));

  // 28f. A SETTLED message must NOT be released — that is the claim doing its job.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', messageId: '<settled@paypal.com>',
    text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('a settled message keeps its claim', CONFIRMS.length === 1 && RELEASED.length === 0);

  console.log('\n=== emailWatcher: amount validation ===');

  // 29. The fail-open: no dollar figure in the body.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment',
    text: 'Hello store@ghost.example,\n\nYou got paid!\n\nNote from Buyer\nghostwave1234\n',
  }));
  check('missing amount does NOT confirm (was fail-open)', CONFIRMS.length === 0);
  check('missing amount raises an alert', alerted('email_payment_no_amount'));

  // 30. Underpayment.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('0.01', 'ghostwave1234'),
  }));
  check('$0.01 against a $19.99 order is rejected', CONFIRMS.length === 0);
  check('underpaid order is flagged for review', UPDATES.length === 1);
  check('underpaid raises an alert', alerted('order_underpaid'));
  check('underpaid records the native unit', /amount_received_unit = 'usd'/.test(UPDATES[0].sql));

  // 31. The old +/-$1.00 window let $19.00 through on a $19.99 order.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.00', 'ghostwave1234'),
  }));
  check('$19.00 against $19.99 is rejected (old tolerance allowed it)', CONFIRMS.length === 0);

  // 32. Exact payment.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('exact amount confirms', CONFIRMS.length === 1);

  // 33. Overpayment is accepted, not bounced — but flagged for a refund.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('25.00', 'ghostwave1234'),
  }));
  check('overpayment confirms', CONFIRMS.length === 1);
  check('overpayment raises an alert', alerted('order_overpaid'));

  // 34. Thousands separators. `.replace(/,/)` without the global flag stripped
  //     only the first, so "$1,234,567.89" parsed as 1234.
  check('thousands separators parse fully',
    parseAmount('You received $1,234,567.89 USD', [/you received \$([\d,]+\.?\d*)/i]) === 1234567.89);

  // 35. A payer controls their display name and the memo, so a free-floating
  //     figure must not outrank the provider's own receipt wording.
  check('free-floating dollar figure is not used as the amount',
    parseAmount('From: Big Spender $99999.99\n\nYou received $19.99 USD',
      [/you received \$([\d,]+\.?\d*)/i]) === 19.99);

  console.log('\n=== note matching ===');

  // 36. Unknown note matches no order.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.99', 'zzzznope9999'),
  }));
  check('unknown note confirms nothing', CONFIRMS.length === 0);
  check('unmatched payment raises an alert', alerted('email_payment_unmatched'));

  // 37. The removed findNoteInText fallback scanned every pending order.
  reset([ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment',
    text: 'store@ghost.example\n\nYou received $19.99 USD\n\nghostwave1234 aaaa1111 bbbb2222\n',
  }));
  check('note sprayed in the body without the "Note from" marker is ignored', CONFIRMS.length === 0);

  // 38. Cash App happy path.
  reset([CASH_ORDER]);
  await processEmail(email({
    auth: gmailAuth('cash.app'), subject: 'payment', text: cashappBody('19.99', 'ghostwave1234'),
  }));
  check('Cash App exact payment confirms', CONFIRMS.length === 1);

  // 39. Cash App underpay.
  reset([CASH_ORDER]);
  await processEmail(email({
    auth: gmailAuth('cash.app'), subject: 'payment', text: cashappBody('1.00', 'ghostwave1234'),
  }));
  check('Cash App underpayment is rejected', CONFIRMS.length === 0);

  // 40. Cross-method: a cashapp order must not settle from a PayPal mail.
  reset([CASH_ORDER]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('paypal mail cannot confirm a cashapp order', CONFIRMS.length === 0);

  // 41. An expired order is not matchable. The DB query carries
  //     `expires_at > now()`, so the stub returning no row is the real shape of
  //     an expired match — and it must alert, since money may have arrived.
  reset([]);
  await processEmail(email({
    auth: gmailAuth('paypal.com'), subject: 'payment', text: paypalBody('19.99', 'ghostwave1234'),
  }));
  check('no open order (expired/settled) confirms nothing', CONFIRMS.length === 0);
  check('no open order raises an alert so a paying customer is not lost', alerted('email_payment_unmatched'));

  console.log('\n=== crypto payment validation ===');
  const { verifyCryptoPayment } = require(path.join(BACKEND, 'utils', 'cryptoUtils.js'));

  const quoted = { payment_info: { expected_sats: 100000 } };
  check('1 satoshi does not pay a 100000-sat invoice', verifyCryptoPayment(quoted, 1).ok === false);
  check('exact satoshis pass', verifyCryptoPayment(quoted, 100000).ok === true);
  check('overpayment passes', verifyCryptoPayment(quoted, 120000).ok === true);
  check('within the 2% tolerance passes', verifyCryptoPayment(quoted, 98500).ok === true);
  check('just outside the tolerance fails', verifyCryptoPayment(quoted, 97000).ok === false);
  check('payment_info as a JSON string is parsed',
    verifyCryptoPayment({ payment_info: JSON.stringify({ expected_sats: 100000 }) }, 100000).ok === true);
  // Fails CLOSED: no quote means manual review, not free delivery.
  check('an order with NO locked quote fails closed', verifyCryptoPayment({ payment_info: {} }, 999999).ok === false);
  check('malformed payment_info fails closed', verifyCryptoPayment({ payment_info: 'not json' }, 999999).ok === false);
  check('zero satoshis fails', verifyCryptoPayment(quoted, 0).ok === false);

  // The fallback that discarded the private key is gone — coins sent to such an
  // address would have been unspendable forever.
  const cryptoSrc = require('fs').readFileSync(path.join(BACKEND, 'utils', 'cryptoUtils.js'), 'utf8');
  check('the key-discarding BlockCypher address fallback is gone',
    !/generateViaBlockCypher/.test(cryptoSrc));
  check('address derivation retries on a race instead of falling back',
    /deriveWithRetry/.test(cryptoSrc));

  console.log('\n=== money arithmetic ===');
  const { applyFee, nativeToUsdCents } = require(path.join(BACKEND, 'routes', 'orders.js')).__test__;

  // Integer basis points. The old float form undercharged whenever the product
  // landed a hair under the half-cent — systematically, never the other way.
  check('10% fee on $19.99 is $21.99', applyFee(1999, 'paypal').totalCents === 2199);
  check('5% crypto fee on $19.99 is $20.99', applyFee(1999, 'btc').totalCents === 2099);
  check('balance checkout takes no fee', applyFee(1999, 'balance').totalCents === 1999);
  check('balance checkout has no fee note', applyFee(1999, 'balance').fee_note === '');

  // A float-multiply of 0.29 * 1.10 is 0.31900000000000006 — this is exactly the
  // family of values where toFixed(2) rounded the wrong way.
  check('10% on $0.29 rounds to $0.32 (was $0.31)', applyFee(29, 'paypal').totalCents === 32);
  check('fee output is always an integer', Number.isInteger(applyFee(12345, 'cashapp').totalCents));

  // Satoshis are not cents. Writing 4,000,000 sats into amount_received_cents
  // claimed the customer had paid $40,000.00.
  const satOrder = { payment_info: { rate_usd: 50000 } };
  check('satoshis convert via the LOCKED rate', nativeToUsdCents(satOrder, 100000, 'btc').cents === 5000);
  check('satoshi conversion is labelled sats', nativeToUsdCents(satOrder, 100000, 'btc').unit === 'sats');
  // No locked rate means no defensible USD figure — record null, do not invent.
  check('no locked rate yields null cents, not a guess',
    nativeToUsdCents({ payment_info: {} }, 100000, 'btc').cents === null);
  check('no locked rate still records the sats unit',
    nativeToUsdCents({ payment_info: {} }, 100000, 'btc').unit === 'sats');
  check('dollar amounts convert straight to cents', nativeToUsdCents({}, 19.99, 'paypal').cents === 1999);
  check('a null amount yields null cents', nativeToUsdCents({}, null, 'paypal').cents === null);
  // payment_info arrives as a string from a TEXT column, an object from JSONB.
  check('a stringified payment_info still yields a rate',
    nativeToUsdCents({ payment_info: JSON.stringify({ rate_usd: 50000 }) }, 100000, 'btc').cents === 5000);

  console.log('\n=== ledger integrity (source assertions) ===');
  const balanceSrc = require('fs').readFileSync(path.join(BACKEND, 'routes', 'balance.js'), 'utf8');
  const resellerSrc = require('fs').readFileSync(path.join(BACKEND, 'routes', 'reseller.js'), 'utf8');
  const ordersSrc = require('fs').readFileSync(path.join(BACKEND, 'routes', 'orders.js'), 'utf8');
  const deliverySrc = require('fs').readFileSync(path.join(BACKEND, 'utils', 'delivery.js'), 'utf8');

  // GREATEST(0, …) clamped an over-large debit to zero while the ledger row
  // still recorded the full amount, so balance and history drifted silently.
  // Matched on the SET clause specifically, so the comments explaining the old
  // behaviour don't trip it.
  const clampedSet = /SET balance_cents = GREATEST\(0/;
  check('no balance clamp remains in a SET clause', !clampedSet.test(balanceSrc));
  check('no reseller clamp remains in a SET clause', !clampedSet.test(resellerSrc));
  check('balance debits are guarded in the WHERE clause', /balance_cents \+ \$1 >= 0/.test(balanceSrc));
  check('reseller debits are guarded in the WHERE clause', /balance_cents \+ \$1 >= 0/.test(resellerSrc));

  // The status transition IS the lock. Two confirmations arriving within one DB
  // round-trip both saw 'waiting' and both ran delivery.
  check('/confirm gates the write on the status it replaces',
    /WHERE id = \$5 AND status IN \('waiting', 'underpaid'\)/.test(ordersSrc));
  check('cancelled/expired orders are not confirmable',
    !/status != 'paid'/.test(ordersSrc));

  // The ledger row carries the uniqueness, so a duplicate top-up cannot mint
  // money even if it reaches delivery.
  check('top-up writes the ledger row before touching the balance',
    deliverySrc.indexOf('INSERT INTO transactions') < deliverySrc.indexOf('UPDATE balances SET balance_cents'));
  check('a duplicate top-up credit is caught and alerted', /duplicate_topup_credit/.test(deliverySrc));
  check('a failed delivery no longer emails OUT_OF_STOCK as the product',
    /needs_attention/.test(deliverySrc) && /FAILURE_MARKERS/.test(deliverySrc));

  // Reseller discount, same integer basis-point treatment as the fee.
  check('reseller discount uses integer basis points',
    /\(10000 - discountBp\) \/ 10000/.test(resellerSrc));

  console.log('\n=== email watcher resilience (source assertions) ===');
  const watcherSrc = require('fs').readFileSync(path.join(BACKEND, 'watchers', 'emailWatcher.js'), 'utf8');
  // A payment processor that switches itself off silently is worse than one that
  // is noisily broken.
  check('the watcher no longer gives up after N failures', !/MAX_FAILS/.test(watcherSrc));
  check('reconnect backoff is capped and unbounded in attempts', /BACKOFF_MS/.test(watcherSrc));
  check('a wedged-but-connected IDLE is detected', /email_watcher_silent/.test(watcherSrc));
  // Marking mail read was a destructive side effect on a shared mailbox, and the
  // UNSEEN filter meant a human glancing at their phone could hide a payment.
  check('mail is no longer marked \\Seen', !/addFlags/.test(watcherSrc));
  check('the search window is no longer UNSEEN-filtered', !/'UNSEEN'/.test(watcherSrc));
  check('TLS validation is not disabled', !/rejectUnauthorized:\s*false/.test(watcherSrc));
  // Overlapping scans must still be serialised — but the latch is no longer an
  // unconditional `if (scanning) return`. That version could wedge forever: the
  // flag survived a reconnect, so one fetch that never fired 'end' silently
  // stopped the watcher reading mail at all. It now force-releases a scan that
  // has held the latch past SCAN_STUCK_MS. The latch also moved off the module
  // onto the per-mailbox watcher object, so it is `w.scanning` now — one wedged
  // inbox must not be able to stop the other one scanning.
  check('overlapping scans are still serialised', /if \(w\.scanning\)/.test(watcherSrc));
  check('a wedged scan is force-released rather than blocking forever',
    /SCAN_STUCK_MS/.test(watcherSrc) && /w\.scanStartedAt/.test(watcherSrc));
  check('every latch release also clears the scan start time',
    /const endScan = \(\) => \{ w\.scanning = false; w\.scanStartedAt = null; \}/.test(watcherSrc));
  // A failed openBox must force a reconnect. Returning bare left the client
  // connected with no 'mail' listener attached — permanently deaf.
  check('a failed inbox open schedules a reconnect',
    /Failed to open inbox[\s\S]{0,320}scheduleReconnect\(w\)/.test(watcherSrc));

  console.log('\n=== noteGenerator entropy ===');
  const { generateNote } = require(path.join(BACKEND, 'utils', 'noteGenerator.js'));
  const notes = new Set();
  for (let i = 0; i < 2000; i++) notes.add(generateNote());
  check('2000 notes yield >1900 distinct values', notes.size > 1900);
  check('note shape is letters + 4 digits', /^[a-z]{4,12}\d{4}$/.test(generateNote()));
  const noteSrc = require('fs').readFileSync(path.join(BACKEND, 'utils', 'noteGenerator.js'), 'utf8');
  check('noteGenerator no longer uses Math.random', !/Math\.random/.test(noteSrc));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
