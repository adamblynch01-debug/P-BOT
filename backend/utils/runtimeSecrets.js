// Small authenticated-encryption wrapper for credentials that an owner may
// rotate from the admin panel. The encryption key is derived from API_SECRET,
// which is already required for the backend's server-to-server trust. Values
// are never returned to a browser and are unreadable without that secret.
const crypto = require('crypto');

function keyMaterial() {
  const secret = process.env.API_SECRET;
  return secret ? crypto.createHash('sha256').update(String(secret), 'utf8').digest() : null;
}

function encryptRuntimeSecret(value) {
  const key = keyMaterial();
  if (!key) throw new Error('API_SECRET is required to encrypt runtime credentials');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptRuntimeSecret(value) {
  if (typeof value !== 'string' || !value.startsWith('v1:')) return null;
  const key = keyMaterial();
  if (!key) return null;
  const parts = value.split(':');
  if (parts.length !== 4) return null;
  try {
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const ciphertext = Buffer.from(parts[3], 'hex');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

module.exports = { encryptRuntimeSecret, decryptRuntimeSecret };
