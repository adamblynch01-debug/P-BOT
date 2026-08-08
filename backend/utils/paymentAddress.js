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

const { CURRENCY } = require('./money');

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

// The four methods, in the order they are shown at checkout. Anything that
// needs to iterate every method reads this rather than writing its own list —
// the reseller-status bug taught us what happens when an exhaustive list is
// spelled out in five places and a sixth is added later.
const ALL_METHODS = ['cashapp', 'paypal', 'btc', 'ltc'];

// ─── Methods that cannot take the shop's currency ────────────────────────────
//
// Cash App settles in USD in the US and GBP in the UK. There is no euro Cash
// App, and no amount of configuration makes one — so with the shop priced in
// euro (utils/money.js) this method is not "off" and not "misconfigured", it is
// impossible.
//
// It is NOT deleted, for the reason this whole file exists: this codebase has
// three ways for a payment method to be unavailable and they want opposite
// responses from whoever is looking. `off` means somebody chose it and can
// un-choose it. `unconfigured` means something is broken and wants fixing.
// Deleting Cash App would have made it a fourth thing — absent — which reads
// from the panel as "it used to be here and now it isn't", i.e. as a bug. This
// state says why, the panel prints the reason, and the method comes back on its
// own if the shop's currency ever changes again.
//
// Note the `$` in CASHTAG_RE above is a Cash App HANDLE SIGIL, not a currency
// symbol. A blanket `$`→`€` sweep would have rewritten it to /^€.../, failing
// every real cashtag and switching Cash App off with the reason "CASHAPP_CASHTAG
// is not a usable cashtag" — the right outcome for entirely the wrong reason,
// and unrecoverable by anyone who believed the message.
const METHOD_CURRENCIES = {
  cashapp: ['USD', 'GBP'],
  paypal: null,  // multi-currency; the amount carries its ISO code in the link
  btc: null,     // quoted from a live fiat rate, so any currency works
  ltc: null,
};

function currencyUnsupported(method, currency = CURRENCY) {
  const allowed = METHOD_CURRENCIES[method];
  return Array.isArray(allowed) && !allowed.includes(currency);
}

/**
 * Methods the owner has deliberately switched OFF, as a Set.
 *
 * This is the piece that did not exist until now: availability used to be
 * derived ONLY from whether the address parsed, so "off" and "misconfigured"
 * were the same state, and the only way to close a method was to delete its
 * address and type it back in later. Now the address stays put and this list
 * decides.
 *
 * Stored as a comma-separated string because it rides the existing `config`
 * table, which is TEXT — one key, four flags, no migration.
 */
function disabledMethods(env = process.env) {
  return new Set(
    String(env.PAYMENT_METHODS_OFF || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => ALL_METHODS.includes(s))
  );
}

function isPayableCashtag(value) {
  const v = clean(value);
  return CASHTAG_RE.test(v) && !PLACEHOLDERS.has(v.toLowerCase());
}

// ─── PayPal.Me ───────────────────────────────────────────────────────────────
//
// The pay screen has always built its PayPal QR out of the EMAIL ADDRESS:
//
//     https://www.paypal.com/paypalme/<PAYPAL_EMAIL>
//
// That is not a PayPal.Me link. PayPal.Me takes a handle — the name you picked
// at paypal.me/… — and an email address is not one, so the URL behind every
// PayPal QR this store has ever printed resolves to a "page not found". It
// scanned perfectly; it just led nowhere, which is why it read as "QR not
// working" rather than as an outage. Cash App's equivalent has always worked
// because `https://cash.app/$tag` genuinely IS the address format.
//
// A PayPal.Me handle is 1-20 letters and digits. The owner will reasonably
// paste any of `handle`, `@handle`, `paypal.me/handle`, or the full https URL,
// so all four are accepted and reduced to the bare handle.
const PAYPALME_RE = /^[A-Za-z0-9]{1,20}$/;

function normalisePaypalMe(value) {
  let v = clean(value);
  if (!v) return null;
  v = v.replace(/^https?:\/\//i, '')
       .replace(/^www\./i, '')
       .replace(/^paypal\.me\//i, '')
       .replace(/^paypal\.com\/paypalme\//i, '')
       .replace(/^@/, '')
       .replace(/\/+$/, '')
       .trim();
  if (!PAYPALME_RE.test(v)) return null;
  if (PLACEHOLDERS.has(v.toLowerCase())) return null;
  return v;
}

/**
 * The link a PayPal QR should actually encode. PayPal.Me accepts the amount in
 * the path, so scanning this opens PayPal with the total already filled in —
 * one fewer number for the buyer to mistype, and a mistyped total is an
 * underpaid order somebody has to settle by hand.
 *
 * Returns null when no handle is configured, and the caller must then render
 * NO QR at all. A QR that leads to a dead page is worse than no QR: it looks
 * like the store is broken, and the buyer has no reason to read the address
 * printed underneath it.
 */
// ── THE CURRENCY GOES IN THE PATH, and it is not optional ────────────────────
// PayPal.Me reads `/12.34` as "12.34 of whatever currency this account is
// denominated in". That was invisible while the shop priced in dollars and the
// account was a dollar account — the two agreed by accident, and nothing in this
// function ever mentioned a currency, so a `$`-to-`€` sweep would not have
// touched it.
//
// With the shop on euro that silence becomes a real charge in the wrong
// currency: the site quotes €12.34, PayPal collects 12.34 USD, and the receipt
// that comes back then trips the watcher's foreign-currency guard on the way in,
// so the order does not even auto-confirm. Two failures, one omission.
//
// PayPal.Me accepts a 3-letter ISO code appended to the amount — `/12.34EUR` —
// and honours it whatever the account's default is.
function paypalMeLink(value, amount) {
  const handle = normalisePaypalMe(value);
  if (!handle) return null;
  const amt = Number(amount);
  const suffix = Number.isFinite(amt) && amt > 0 ? `/${amt.toFixed(2)}${CURRENCY}` : '';
  return `https://www.paypal.com/paypalme/${handle}${suffix}`;
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
  const off = disabledMethods(env);
  const ok = (m, configured) => !currencyUnsupported(m) && !off.has(m) && configured;
  return {
    cashapp: ok('cashapp', isPayableCashtag(env.CASHAPP_CASHTAG)),
    paypal: ok('paypal', isPayableEmail(env.PAYPAL_EMAIL)),
    btc: ok('btc', !!env.BTC_XPUB),
    ltc: ok('ltc', !!env.LTC_XPUB),
  };
}

/**
 * Per-method state with the REASON, for the admin panel, the bot's
 * `/config methods` and the 503 a refused order gets back.
 *
 * The reason matters more than the boolean. "PayPal is unavailable" reads the
 * same whether the owner turned it off on purpose or the address is a typo,
 * and those two want opposite responses from whoever is looking. `off` means
 * somebody chose this; `unconfigured` means something is broken.
 */
function methodStates(env = process.env) {
  const off = disabledMethods(env);
  const configured = {
    cashapp: isPayableCashtag(env.CASHAPP_CASHTAG),
    paypal: isPayableEmail(env.PAYPAL_EMAIL),
    btc: !!env.BTC_XPUB,
    ltc: !!env.LTC_XPUB,
  };
  const missing = {
    cashapp: 'CASHAPP_CASHTAG is not a usable cashtag',
    paypal: 'PAYPAL_EMAIL is not a usable email address',
    btc: 'BTC_XPUB is not set',
    ltc: 'LTC_XPUB is not set',
  };
  const out = {};
  for (const m of ALL_METHODS) {
    // Currency first, ahead of even the off-switch. This is the one state
    // nobody can act on: flipping the toggle will not help, fixing the address
    // will not help, and a panel that offered either as the remedy would be
    // sending staff to do something that cannot work.
    if (currencyUnsupported(m)) {
      out[m] = {
        available: false,
        state: 'currency',
        reason: `${m === 'cashapp' ? 'Cash App' : m} cannot take ${CURRENCY} — it settles in `
          + `${METHOD_CURRENCIES[m].join(' or ')} only, and this shop prices in ${CURRENCY}`,
      };
    }
    // Reported ahead of the address check on purpose. A method the owner has
    // switched off should say so even if its address is ALSO broken, or
    // turning it back on later looks like it silently failed.
    else if (off.has(m)) out[m] = { available: false, state: 'off', reason: 'Switched off by staff' };
    else if (!configured[m]) out[m] = { available: false, state: 'unconfigured', reason: missing[m] };
    else out[m] = { available: true, state: 'on', reason: null };
  }
  return out;
}

/**
 * The `PAYMENT_METHODS_OFF` string that results from flipping one method,
 * normalised and de-duplicated. Returned rather than written so the caller
 * decides where it goes — the panel and the bot both POST it to
 * /api/config/update, and neither should be assembling this by hand.
 *
 * Throws on an unknown method rather than silently dropping it: a typo that
 * quietly no-ops would read as "the switch does not work".
 */
function toggleMethod(method, enabled, env = process.env) {
  const m = String(method || '').trim().toLowerCase();
  if (!ALL_METHODS.includes(m)) {
    throw new Error(`Unknown payment method "${method}" — expected one of ${ALL_METHODS.join(', ')}`);
  }
  const off = disabledMethods(env);
  if (enabled) off.delete(m); else off.add(m);
  // Sorted so the stored value is stable: the same set of switches always
  // produces the same string, and a config-row diff means a real change.
  return ALL_METHODS.filter(x => off.has(x)).join(',');
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
  // Set-but-unusable, the same failure class as the two above. An unset
  // PAYPAL_ME is fine — PayPal still works, it just shows no QR — but a
  // handle that does not parse would silently fall back to no QR while the
  // owner believes they configured one.
  if (clean(env.PAYPAL_ME) && !normalisePaypalMe(env.PAYPAL_ME)) {
    out.push(`PAYPAL_ME is set to ${JSON.stringify(clean(env.PAYPAL_ME))}, which is not a PayPal.Me handle `
      + '(1-20 letters or digits, e.g. uhservices). The PayPal QR stays hidden until it is.');
  }
  return out;
}

module.exports = {
  isPayableCashtag, isPayableEmail, payableMethods, addressProblems,
  disabledMethods, methodStates, toggleMethod, ALL_METHODS,
  normalisePaypalMe, paypalMeLink,
  currencyUnsupported, METHOD_CURRENCIES,
  CASHTAG_RE, EMAIL_RE, PAYPALME_RE,
};
