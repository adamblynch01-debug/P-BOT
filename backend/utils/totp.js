'use strict';

// TOTP (RFC 6238) verification, server-side.
//
// The browser used to own this end to end: it generated the secret, stored it
// in localStorage, and decided for itself whether the typed code was right.
// A check the attacker controls is not a check. The secret now lives in
// web_users.totp_secret and only this module ever compares a code.

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0, val = 0, out = '';
  for (let i = 0; i < bytes.length; i++) {
    val = (val << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const s = String(str || '').toUpperCase().replace(/=+$/, '');
  let bits = 0, val = 0;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const idx = B32.indexOf(s[i]);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[19] & 0xf;
  const num = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
  return String(num).padStart(6, '0');
}

// ±1 step of clock skew, same tolerance the old browser code allowed.
// Compared in constant time so the response cannot be timed digit by digit.
function verifyTOTP(secret, token) {
  const given = String(token || '').trim();
  if (!secret || !/^\d{6}$/.test(given)) return false;
  const base = Math.floor(Date.now() / 1000 / 30);
  let ok = false;
  for (const step of [-1, 0, 1]) {
    const expect = codeAt(secret, base + step);
    const a = crypto.createHash('sha256').update(expect).digest();
    const b = crypto.createHash('sha256').update(given).digest();
    if (crypto.timingSafeEqual(a, b)) ok = true;   // no early return: keep the
  }                                                 // loop's timing uniform
  return ok;
}

// Generate the current RFC 6238 code for a supplied account secret.  This is
// intentionally separate from verifyTOTP: generator customers are asking for
// the code belonging to an account they already own, not trying to enrol a
// factor on their website account.  The caller must still authenticate, while
// the secret is used only in memory and is never persisted or logged.
function generateTOTP(secret) {
  const normalized = String(secret || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z2-7]+=*$/.test(normalized)) {
    throw new Error('Invalid TOTP secret format');
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  return {
    code: codeAt(normalized, counter),
    remaining: 30 - (Math.floor(Date.now() / 1000) % 30),
    period: 30,
  };
}

function generateBackupCodes(n = 8) {
  return Array.from({ length: n }, () => crypto.randomBytes(4).toString('hex').toUpperCase());
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(String(code || '').trim().toUpperCase(), 'utf8').digest('hex');
}

function otpauthUrl(secret, account, issuer) {
  const iss = encodeURIComponent(issuer || 'GHOST.EXE');
  const acc = encodeURIComponent(account || 'user');
  return `otpauth://totp/${iss}:${acc}?secret=${secret}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
  generateSecret, verifyTOTP, generateTOTP, generateBackupCodes, hashBackupCode, otpauthUrl,
};
