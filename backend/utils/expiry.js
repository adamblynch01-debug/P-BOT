// How long an unpaid order stays payable, by method.
//
// Lifted out of routes/orders.js because a second reader appeared: the Discord
// bot's payment-methods panel tells buyers "pay within 3 hours", and a panel
// that states a window the sweeper does not honour is worse than one that says
// nothing. One definition, two readers — /api/config serves these to the bot so
// the number on the panel is the number the sweeper enforces.
//
// The reasoning behind the values, kept with them:
//
//   crypto — 180 minutes. The coin amount on the pay screen is quoted at the
//     rate when the order was placed, so the window is also how long the
//     customer holds a free option on the price. Long enough for a slow
//     confirmation, short enough that the option is not worth much.
//
//   cash — 60 minutes. Cash App and PayPal settle when a human or the email
//     watcher sees them, so a long window only means a longer queue of orders
//     nobody can act on.
//
//   anything else — 60 minutes. 'balance' settles inside the checkout request
//     and never reaches 'waiting' at all, so this is really the default for a
//     method added later: short, and therefore safe, because a method whose
//     window is too short fails loudly on the pay screen while one that is too
//     long goes back to hanging silently.
//
// Each is an env var: these are judgement calls, and changing one should not
// need a deploy. ORDER_EXPIRY_MINUTES keeps its old name and its old meaning so
// an override already set on Railway still does what whoever set it meant.
// Floored at 5 minutes, and that floor is a guard rather than a preference: a
// typo'd `ORDER_EXPIRY_MINUTES=0` would otherwise write a deadline already in
// the past and the sweeper would cancel every order the moment it was placed.
'use strict';

const envMinutes = (raw, dflt) => Math.max(5, parseInt(raw, 10) || dflt);

const ORDER_EXPIRY_MINUTES        = envMinutes(process.env.ORDER_EXPIRY_MINUTES, 60);
const ORDER_EXPIRY_MINUTES_CRYPTO = envMinutes(process.env.ORDER_EXPIRY_MINUTES_CRYPTO, 180);
const ORDER_EXPIRY_MINUTES_CASH   = envMinutes(process.env.ORDER_EXPIRY_MINUTES_CASH, ORDER_EXPIRY_MINUTES);

// Unknown methods fall through to ORDER_EXPIRY_MINUTES rather than to no
// deadline at all. A missing entry here must never mean "lives forever" — that
// is the exact bug this whole path exists to close.
function expiryMinutesFor(payment_method) {
  switch (payment_method) {
    case 'btc':
    case 'ltc':     return ORDER_EXPIRY_MINUTES_CRYPTO;
    case 'cashapp':
    case 'paypal':  return ORDER_EXPIRY_MINUTES_CASH;
    default:        return ORDER_EXPIRY_MINUTES;
  }
}

module.exports = {
  envMinutes,
  ORDER_EXPIRY_MINUTES,
  ORDER_EXPIRY_MINUTES_CRYPTO,
  ORDER_EXPIRY_MINUTES_CASH,
  expiryMinutesFor,
};
