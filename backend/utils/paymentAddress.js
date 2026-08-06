// ─── Is this actually an address somebody can send money to? ─────────────────
//
// Found live on 2026-08-06: `CASHAPP_CASHTAG` on production is the string
// " your $cashtag" — the placeholder out of whatever setup doc it was copied
// from, never replaced. Every check anywhere in this codebase asked only
// whether the variable was NON-EMPTY, and a placeholder is non-empty, so:
//
//   • GET /api/config answered `payment_methods.cashapp: true`, and the
//     storefront offered Cash App at checkout;
//   • POST /api/orders/create wrote `cashtag: " your $cashtag"` onto the pay
//     screen, because its `|| '$YOUR_CASHTAG'` fallback only catches an EMPTY
//     variable and this one is not empty;
//   • the startup check said nothing, for the same reason.
//
// So a real customer could pick Cash App, be shown an address that does not
// exist, and have the order sit unpaid until the sweeper expired it. Nothing
// logs that as a failure — it looks exactly like a buyer who changed their mind.
//
// A misconfigured payment method must fail CLOSED: not offered, and refused if
// somebody asks for it anyway. The bot's storefront panel already refuses to
// print this string (modules/storefrontPanels.js); this is the same rule on the
// side that takes the money.
'use strict';

// $ followed by a handle. Cash App allows letters, digits and underscores, 1-20
// of them. A leading space, a space anywhere, or the word "your" in front all
// fail — which is the whole point.
const CASHTAG_RE = /^\$[A-Za-z0-9_]{1,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Values that are syntactically fine but are obviously the example from a
// README rather than somebody's account.
const PLACEHOLDERS = new Set([
  '$yourcashtag', '$your_cashtag', '$cashtag', '$handle', '$username',
  'your@paypal.com', 'you@example.com', 'your@email.com', 'email@example.com',
]);

const clean = (s) => String(s == null ? '' : s).trim();

function isPayableCashtag(value) {
  const v = clean(value);
  return CASHTAG_RE.test(v) && !PLACEHOLDERS.has(v.toLowerCase());
}

function isPayableEmail(value) {
  const v = clean(value);
  return EMAIL_RE.test(v) && !PLACEHOLDERS.has(v.toLowerCase());
}

/**
 * Which methods can actually be paid, given the current environment.
 * Crypto is derived from an xpub, which the address generator validates on its
 * own, so those two keep the non-empty test.
 */
function payableMethods(env = process.env) {
  return {
    cashapp: isPayableCashtag(env.CASHAPP_CASHTAG),
    paypal: isPayableEmail(env.PAYPAL_EMAIL),
    btc: !!env.BTC_XPUB,
    ltc: !!env.LTC_XPUB,
  };
}

/**
 * A one-line explanation per method that is switched on but unusable, for the
 * startup log and for the admin panel. Never returns the value of a secret —
 * a cashtag and a PayPal address are published to buyers by design, so those
 * two are quoted back to make the typo obvious.
 */
function addressProblems(env = process.env) {
  const out = [];
  if (clean(env.CASHAPP_CASHTAG) && !isPayableCashtag(env.CASHAPP_CASHTAG)) {
    out.push(`CASHAPP_CASHTAG is set to ${JSON.stringify(clean(env.CASHAPP_CASHTAG))}, which is not a cashtag `
      + '($ followed by up to 20 letters, digits or underscores). Cash App is switched OFF until it is a real one.');
  }
  if (clean(env.PAYPAL_EMAIL) && !isPayableEmail(env.PAYPAL_EMAIL)) {
    out.push(`PAYPAL_EMAIL is set to ${JSON.stringify(clean(env.PAYPAL_EMAIL))}, which is not an email address. `
      + 'PayPal is switched OFF until it is.');
  }
  return out;
}

module.exports = {
  isPayableCashtag, isPayableEmail, payableMethods, addressProblems,
  CASHTAG_RE, EMAIL_RE,
};
