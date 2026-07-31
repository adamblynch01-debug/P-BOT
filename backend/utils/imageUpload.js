// Turning a customer-supplied data URL into bytes we are willing to store and
// later serve back with a Content-Type header.
//
// The header is the reason this is careful. GET /api/reviews/:id/image replays
// image_mime straight into Content-Type, so whatever is accepted here is what
// browsers will be told the bytes are. A caller that says `image/png` and
// sends HTML would otherwise get a stored, cached, same-origin XSS out of a
// review form. The declared type is therefore never trusted on its own: the
// bytes have to start with the signature of the type they claim.
'use strict';

// Raster formats only, and no SVG. SVG is a document — it can carry <script>
// and is executed when opened directly — so it has no business being served
// from our own origin as a user upload.
const SIGNATURES = [
  { mime: 'image/png', test: b => b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' },
  { mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: b => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  {
    mime: 'image/webp',
    test: b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
];

// Aliases browsers and phones actually send. The value stored is always the
// canonical mime from the signature table, never the caller's spelling.
const ALIASES = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png' };

const DATA_URL = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i;

// Returns { data, mime } or { error } — never throws, because every caller is
// answering an HTTP request and wants the reason, not a stack trace.
function decodeImageDataUrl(input, maxBytes) {
  if (input == null || input === '') return { data: null, mime: null };
  if (typeof input !== 'string') return { error: 'image must be a data URL string' };

  const m = DATA_URL.exec(input.trim());
  if (!m) return { error: 'image must be a base64 data URL' };

  const declared = ALIASES[m[1].toLowerCase()] || m[1].toLowerCase();
  if (!SIGNATURES.some(s => s.mime === declared)) {
    return { error: `unsupported image type ${declared} — png, jpeg, gif or webp only` };
  }

  // Check the encoded length BEFORE decoding: base64 is 4 chars per 3 bytes, so
  // the size is known without allocating the buffer. Decoding first would mean
  // a rejected 50MB upload still costs 50MB of heap to reject.
  const b64 = m[2].replace(/\s+/g, '');
  const approxBytes = Math.floor((b64.length * 3) / 4);
  if (approxBytes > maxBytes) {
    return { error: `image is too large (max ${Math.floor(maxBytes / 1024)}KB)` };
  }

  let data;
  try { data = Buffer.from(b64, 'base64'); } catch { return { error: 'image is not valid base64' }; }
  if (!data.length) return { error: 'image is empty' };
  if (data.length > maxBytes) return { error: `image is too large (max ${Math.floor(maxBytes / 1024)}KB)` };

  // Buffer.from ignores anything that is not a base64 character rather than
  // failing, so a body of pure junk decodes to a short garbage buffer instead
  // of an error. The signature check below is what actually catches that.
  const sig = SIGNATURES.find(s => s.test(data));
  if (!sig) return { error: 'that file is not a png, jpeg, gif or webp image' };
  if (sig.mime !== declared) {
    return { error: `image says it is ${declared} but the file is ${sig.mime}` };
  }

  return { data, mime: sig.mime };
}

module.exports = { decodeImageDataUrl, SIGNATURES };
