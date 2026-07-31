// The customer-facing order reference.
//
// See migrations/order_invoice_no.sql for why orders.id stopped being the
// number we print. In short: it is sequential, so it leaks volume and hands a
// role-claim attempt half of its credential pair.
//
// Requirements this shape is built around:
//   - typed and read aloud by a human, into a Discord command
//   - short enough to fit a receipt line and a chat message
//   - not confusable: 0/O and 1/I/L are absent from the alphabet entirely
//   - random over a space large enough that guessing is pointless
'use strict';

const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // 32 symbols
const GROUP = 4;
const GROUPS = 2;                                       // 32^8 ≈ 1.1e12

// randomInt, not `% 32` over a byte: 256 is a multiple of 32 so a modulo would
// happen to be uniform here, but that is an accident of the alphabet length and
// would silently skew the moment a symbol is added or removed.
function invoiceNo() {
  const parts = [];
  for (let g = 0; g < GROUPS; g++) {
    let part = '';
    for (let i = 0; i < GROUP; i++) part += ALPHABET[crypto.randomInt(ALPHABET.length)];
    parts.push(part);
  }
  return parts.join('-');
}

// Accepts what a customer actually types — lower case, spaces, a missing or
// extra dash — and nothing else. The confusable characters are deliberately
// NOT mapped onto a guess: 0, O, 1, I and L cannot appear in a real invoice
// number, so a string containing one is a typo we have no honest way to
// resolve, and silently "correcting" it would mean claiming a role against
// somebody else's order.
function normalizeInvoiceNo(input) {
  if (input == null) return null;
  const raw = String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== GROUP * GROUPS) return null;
  if ([...raw].some(c => !ALPHABET.includes(c))) return null;
  return raw.slice(0, GROUP) + '-' + raw.slice(GROUP);
}

function looksLikeInvoiceNo(input) {
  return normalizeInvoiceNo(input) !== null;
}

module.exports = { invoiceNo, normalizeInvoiceNo, looksLikeInvoiceNo, ALPHABET };
