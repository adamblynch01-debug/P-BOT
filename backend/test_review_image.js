// A customer attaching a screenshot to a review.
//
// Two things are being protected here. The obvious one is that the upload
// works at all — it travels as a base64 data URL inside the review JSON, which
// is larger than express.json()'s default 100kb ceiling, so a body parser that
// is not exempted turns every upload into a 413.
//
// The one that matters more is that whatever comes back out of
// GET /api/reviews/:id/image is served with a Content-Type we chose from the
// file's own bytes. That header is replayed from the database, so a caller who
// can store `image/png` next to a chunk of HTML has a stored same-origin XSS
// on the storefront's review wall.
'use strict';

const path = require('path');
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

const { decodeImageDataUrl } = require(path.join(BACKEND, 'utils', 'imageUpload.js'));

const MAX = 4 * 1024 * 1024;
const url = (mime, buf) => `data:${mime};base64,` + buf.toString('base64');

// Real signatures, padded out so the length checks have something to chew on.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 7)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 1), Buffer.from('WEBP', 'latin1'), Buffer.alloc(64, 7),
]);

console.log('\n=== the formats a customer can actually attach ===');
check('a png is accepted and stored as image/png', () => {
  const r = decodeImageDataUrl(url('image/png', PNG), MAX);
  assert.strictEqual(r.mime, 'image/png');
  assert.ok(r.data.equals(PNG));
});
check('a jpeg is accepted', () =>
  assert.strictEqual(decodeImageDataUrl(url('image/jpeg', JPEG), MAX).mime, 'image/jpeg'));
check('image/jpg — what half the world writes — is normalised, not rejected', () =>
  assert.strictEqual(decodeImageDataUrl(url('image/jpg', JPEG), MAX).mime, 'image/jpeg'));
check('a gif is accepted', () =>
  assert.strictEqual(decodeImageDataUrl(url('image/gif', GIF), MAX).mime, 'image/gif'));
check('a webp is accepted — it is what a modern screenshot tool produces', () =>
  assert.strictEqual(decodeImageDataUrl(url('image/webp', WEBP), MAX).mime, 'image/webp'));
check('no image at all is not an error, it is an optional field', () => {
  assert.deepStrictEqual(decodeImageDataUrl(null, MAX), { data: null, mime: null });
  assert.deepStrictEqual(decodeImageDataUrl('', MAX), { data: null, mime: null });
});

console.log('\n=== the header is chosen from the bytes, never from the caller ===');
check('HTML labelled image/png is refused', () => {
  const html = Buffer.from('<script>fetch("/api/auth/me")</script>', 'utf8');
  const r = decodeImageDataUrl(url('image/png', html), MAX);
  assert.ok(/not a png/.test(r.error || ''), r.error);
  assert.strictEqual(r.data, undefined);
});
check('an SVG is refused outright — it is a document, not a picture', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
  const r = decodeImageDataUrl(url('image/svg+xml', svg), MAX);
  assert.ok(/unsupported image type/.test(r.error || ''), r.error);
});
check('a real jpeg claiming to be a png is refused rather than relabelled', () => {
  const r = decodeImageDataUrl(url('image/png', JPEG), MAX);
  assert.ok(/says it is image\/png but the file is image\/jpeg/.test(r.error || ''), r.error);
});
check('a bare base64 blob with no data: prefix is refused', () =>
  assert.ok(/base64 data URL/.test(decodeImageDataUrl(PNG.toString('base64'), MAX).error || '')));
check('a remote URL is not fetched on our behalf', () =>
  // The website upload path stores bytes the customer sent. Accepting a URL
  // here would make the API fetch attacker-chosen addresses — including
  // internal ones — on an authenticated request.
  assert.ok(/base64 data URL/.test(decodeImageDataUrl('https://example.com/x.png', MAX).error || '')));
check('junk that decodes to a short buffer is caught by the signature, not stored', () =>
  assert.ok(/not a png/.test(decodeImageDataUrl('data:image/png;base64,!!!!not base64!!!!', MAX).error || '')));
check('an empty payload is refused', () =>
  assert.ok(decodeImageDataUrl('data:image/png;base64,', MAX).error));
check('a non-string image field cannot crash the route', () => {
  assert.ok(decodeImageDataUrl({ evil: true }, MAX).error);
  assert.ok(decodeImageDataUrl(12345, MAX).error);
});

console.log('\n=== size ===');
check('an oversized upload is refused', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(MAX, 9)]);
  assert.ok(/too large/.test(decodeImageDataUrl(url('image/png', big), MAX).error || ''));
});
check('the limit is enforced on the encoded length, before the buffer is built', () => {
  // 4/3 of the limit in base64 characters, with a valid prefix — the point is
  // that this is rejected without ever allocating the decoded megabytes.
  const chars = 'A'.repeat(Math.ceil((MAX + 1024) * 4 / 3));
  const r = decodeImageDataUrl('data:image/png;base64,' + chars, MAX);
  assert.ok(/too large/.test(r.error || ''), r.error);
});
check('something just under the limit still gets through', () => {
  const ok = Buffer.concat([PNG, Buffer.alloc(MAX - 4096, 9)]);
  assert.strictEqual(decodeImageDataUrl(url('image/png', ok), MAX).mime, 'image/png');
});
check('whitespace inside the base64 payload does not change the verdict', () => {
  const b64 = PNG.toString('base64');
  const wrapped = b64.replace(/(.{8})/g, '$1\n');
  assert.strictEqual(decodeImageDataUrl('data:image/png;base64,' + wrapped, MAX).mime, 'image/png');
});

// ─────────────────────────────────────────────────────────────────────────────
// The route, against a stubbed database.
console.log('\n=== POST /api/reviews with a screenshot attached ===');

const express = require('express');
const http = require('http');

const ROWS = [];
let nextId = 1;
const NOTIFIED = [];

require.cache[require.resolve(path.join(BACKEND, 'db.js'))] = {
  id: 'db', filename: 'db', loaded: true,
  exports: {
    query: async (text, params) => {
      if (/INSERT INTO reviews/.test(text)) {
        const row = {
          id: nextId++, guild_id: params[0], web_user_id: params[1], display_name: params[2],
          product_id: params[3], rating: params[4], body: params[5], discord_id: params[6],
          approved: params[7], image_data: params[8], image_mime: params[9],
          source: 'website', image_url: null, created_at: new Date().toISOString(),
        };
        row.has_image = row.image_data != null;
        ROWS.push(row);
        return { rows: [row] };
      }
      if (/SELECT image_data/.test(text)) {
        const row = ROWS.find(x => String(x.id) === String(params[0]) && x.image_data != null);
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
    withTransaction: async (fn) => fn(async () => ({ rows: [], rowCount: 0 })),
  },
};

let SESSION = { id: 'u1', username: 'buyer', role: 'user', discord_id: '42', discord_verified: true };
require.cache[require.resolve(path.join(BACKEND, 'utils', 'auth.js'))] = {
  id: 'auth', filename: 'auth', loaded: true,
  exports: {
    requireAuth: (req, res, next) => (SESSION ? (req.user = SESSION, next()) : res.status(401).json({ error: 'Not logged in' })),
    requireAdmin: (req, res, next) => res.status(401).end(),
    getSessionUser: async () => SESSION,
    bearerToken: () => 'tok',
    botAuthorized: () => false,
    botAuthUnavailable: () => true,
    discordLinked: (u) => !!(u && u.discord_id && u.discord_verified),
  },
};
require.cache[require.resolve(path.join(BACKEND, 'utils', 'botNotify.js'))] = {
  id: 'botNotify', filename: 'botNotify', loaded: true,
  exports: { notifyBot: async (kind, payload) => { NOTIFIED.push({ kind, payload }); } },
};

process.env.GUILD_ID = 'g1';

const app = express();
// Mirrors server.js: the global parser stands aside for exactly this route.
const jsonParser = express.json();
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path.replace(/\/+$/, '') === '/api/reviews') return next();
  return jsonParser(req, res, next);
});
app.use('/api/reviews', require(path.join(BACKEND, 'routes', 'reviews.js')));

let base;
function post(body, headers) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(base + '/api/reviews', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, headers || {}),
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode, body: b }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
function get(p, headers) {
  return new Promise((resolve, reject) => {
    http.get(base + p, { headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function run() {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await checkAsync('a review with a screenshot is stored, live, in one request', async () => {
    const r = await post({ rating: 5, body: 'legit', image: url('image/png', PNG) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.image_stored, true);
    assert.strictEqual(r.body.approved, true);
    assert.ok(/\/api\/reviews\/1\/image$/.test(r.body.review.image), r.body.review.image);
  });
  await checkAsync('and the vouch posted to Discord carries the picture, not a blank embed', async () => {
    assert.strictEqual(NOTIFIED.length, 1);
    assert.strictEqual(NOTIFIED[0].kind, 'web_review');
    assert.ok(/\/api\/reviews\/1\/image$/.test(NOTIFIED[0].payload.review.image_url || ''));
  });
  await checkAsync('a review with no image still works exactly as before', async () => {
    const r = await post({ rating: 4, body: 'no pic' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.image_stored, false);
    assert.strictEqual(r.body.review.image, null);
  });

  await checkAsync('a body over the default 100kb ceiling is NOT a 413', async () => {
    // The regression this exists for: a global express.json() that does not
    // stand aside turns every real screenshot into "Payload Too Large", which
    // the storefront can only report as an unexplained failure.
    const big = Buffer.concat([PNG, Buffer.alloc(400 * 1024, 3)]);
    const r = await post({ rating: 5, body: 'big shot', image: url('image/png', big) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.image_stored, true);
  });

  await checkAsync('a disguised file is refused and NOTHING is written', async () => {
    const before = ROWS.length;
    const r = await post({ rating: 5, body: 'x', image: url('image/png', Buffer.from('<script>1</script>')) });
    assert.strictEqual(r.status, 400);
    assert.ok(/not a png/.test(r.body.error || ''), r.body.error);
    assert.strictEqual(ROWS.length, before, 'a rejected image must not leave a review behind');
  });

  await checkAsync('the stored image is served back with the type we derived', async () => {
    const r = await get('/api/reviews/1/image');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'image/png');
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.body.equals(PNG));
  });
  await checkAsync('an approved image is cacheable forever', async () => {
    const r = await get('/api/reviews/1/image');
    assert.ok(/immutable/.test(r.headers['cache-control'] || ''), r.headers['cache-control']);
  });

  await checkAsync('a queued review from an unlinked account is not public', async () => {
    SESSION = { id: 'u2', username: 'stranger', role: 'user' };   // no verified Discord
    const r = await post({ rating: 5, body: 'pending', image: url('image/jpeg', JPEG) });
    assert.strictEqual(r.body.approved, false);
    assert.strictEqual(r.body.pending, true);
    const id = r.body.review.id;
    // Its author can see their own upload...
    const own = await get(`/api/reviews/${id}/image`);
    assert.strictEqual(own.status, 200);
    assert.ok(/no-store/.test(own.headers['cache-control'] || ''),
      'an access-dependent response must never be publicly cacheable');
    // ...and nobody else can.
    SESSION = null;
    const anon = await get(`/api/reviews/${id}/image`);
    assert.strictEqual(anon.status, 404);
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
