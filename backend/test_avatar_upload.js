// A customer uploading their own profile picture.
//
// The emoji in web_users.avatar is capped at 8 characters because it is
// rendered straight into the page, so an uploaded picture cannot live in that
// column. It lives in web_user_avatars, and the two coexist: the emoji is the
// fallback for every account that never uploads one.
//
// Three things are worth protecting here.
//
//  1. The upload works at all. It travels as a base64 data URL inside JSON,
//     which is larger than express.json()'s default 100kb ceiling, so a route
//     that is not in BIG_BODY_ROUTES turns every upload into a 413.
//
//  2. What comes back out of GET /api/auth/avatar/:id is served with a
//     Content-Type we chose from the file's own bytes. That header is replayed
//     from the database, and unlike a review screenshot this URL is public, so
//     a caller who could store `image/png` next to a chunk of HTML would have
//     a stored XSS on any page that shows an avatar.
//
//  3. avatar_version moves on every upload AND every delete. The GET is served
//     immutable-for-a-year, and that counter in the ?v= is the only thing that
//     makes it safe — a version that stood still would leave a customer
//     looking at the picture they just replaced until the browser cache aged
//     out. It is bumped rather than reset on delete, so an old cached URL
//     cannot start resolving again if a new picture is uploaded later.
//
// Runs against the real database, because the parts that can break are the
// body-parser exemption, the guild scoping and the transaction — none of which
// a mocked pool would exercise. It creates one throwaway account and removes
// it, and the schema check will tell you if the migration has not been run.
//
//   railway run node backend/test_avatar_upload.js
'use strict';

const assert = require('assert');
const http = require('http');

process.env.SKIP_BACKGROUND = process.env.SKIP_BACKGROUND || '1';

// Checked BEFORE ./db and ./server are loaded, because without them this file
// dies inside server.js's startup check complaining that CASHAPP_CASHTAG is
// missing. That reads like a payment fault, it is nothing of the kind, and it
// is why these checks spent several rounds written off as "known failures"
// while covering nothing. A test that cannot be run must say so in the one
// sentence that gets it running.
if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  test_avatar_upload — this one talks to the real database.');
  console.log('        Run it with:  railway run node backend/test_avatar_upload.js\n');
  process.exit(0);
}

const { pool } = require('./db');
const { decodeImageDataUrl } = require('./utils/imageUpload');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// Real signatures. The decoder reads these, not the declared type.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 9)]);
const url = (mime, buf) => `data:${mime};base64,` + buf.toString('base64');

(async () => {
  console.log('\n── schema ──');
  await check('web_users.avatar_version exists, NOT NULL, defaults to 0', async () => {
    const { rows } = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'web_users' AND column_name = 'avatar_version'`);
    assert.strictEqual(rows.length, 1, 'column missing — run migrations/user_avatars.sql');
    assert.strictEqual(rows[0].data_type, 'integer');
    assert.strictEqual(rows[0].is_nullable, 'NO');
    assert.match(String(rows[0].column_default), /0/);
  });

  await check('web_user_avatars cascades from web_users', async () => {
    const { rows } = await pool.query(
      `SELECT rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
        WHERE tc.table_name = 'web_user_avatars'`);
    assert.ok(rows.length, 'no FK on web_user_avatars');
    assert.strictEqual(rows[0].delete_rule, 'CASCADE',
      'a deleted account must not leave its picture behind');
  });

  console.log('\n── decoder (same one the review screenshots use) ──');
  await check('a PNG declared as PNG is accepted', () => {
    const r = decodeImageDataUrl(url('image/png', PNG), 1024 * 1024);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.mime, 'image/png');
  });
  await check('HTML declared as image/png is refused', () => {
    const r = decodeImageDataUrl(url('image/png', Buffer.from('<html><script>alert(1)</script>')), 1024 * 1024);
    assert.ok(r.error, 'stored HTML would be replayed with a Content-Type we chose');
  });
  await check('SVG is refused outright', () => {
    const r = decodeImageDataUrl(url('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 1024 * 1024);
    assert.ok(r.error, 'SVG is a document that can carry script');
  });
  await check('over the cap is refused before decoding', () => {
    const r = decodeImageDataUrl(url('image/png', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)])), 1024 * 1024);
    assert.ok(r.error);
  });

  // ── live routes ────────────────────────────────────────
  const app = require('./server');
  const server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const stamp = Date.now();
  const creds = {
    username: `_avtest_${stamp}`,
    email: `_avtest_${stamp}@example.invalid`,
    password: 'avatar-test-password-123',
  };
  let token = null, userId = null;

  const api = async (path, opts = {}) => {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(base + path, Object.assign({}, opts, { headers }));
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body };
  };

  try {
    console.log('\n── live routes ──');
    await check('throwaway account created', async () => {
      const r = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify(creds) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      token = r.body.token;
      userId = r.body.user.id;
      assert.ok(token && userId);
    });

    await check('a fresh account has avatar_url null — the emoji still applies', async () => {
      const r = await api('/api/auth/me');
      assert.strictEqual(r.body.user.avatar_url, null);
    });

    await check('anonymous upload is refused', async () => {
      const saved = token; token = null;
      const r = await api('/api/auth/avatar', { method: 'POST', body: JSON.stringify({ image: url('image/png', PNG) }) });
      token = saved;
      assert.strictEqual(r.status, 401, 'requireAuth must run before the body is buffered');
    });

    let firstUrl = null;
    await check('upload succeeds and returns a versioned avatar_url', async () => {
      const r = await api('/api/auth/avatar', { method: 'POST', body: JSON.stringify({ image: url('image/png', PNG) }) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      firstUrl = r.body.user.avatar_url;
      assert.match(firstUrl, new RegExp(`^/api/auth/avatar/${userId}\\?v=1$`), firstUrl);
    });

    await check('a 300KB body gets through — the 100kb global parser stood aside', async () => {
      const big = Buffer.concat([JPEG, Buffer.alloc(300 * 1024, 3)]);
      const r = await api('/api/auth/avatar', { method: 'POST', body: JSON.stringify({ image: url('image/jpeg', big) }) });
      assert.strictEqual(r.status, 200, `413 here means BIG_BODY_ROUTES is missing this path (${r.status})`);
      assert.match(r.body.user.avatar_url, /\?v=2$/, 'version must move with the bytes');
    });

    await check('over the 1MB cap is a 400, not a 413 or a 500', async () => {
      const huge = Buffer.concat([PNG, Buffer.alloc(1200 * 1024, 5)]);
      const r = await api('/api/auth/avatar', { method: 'POST', body: JSON.stringify({ image: url('image/png', huge) }) });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body).slice(0, 120));
    });

    await check('HTML declared as an image is refused by the route', async () => {
      const r = await api('/api/auth/avatar', { method: 'POST', body: JSON.stringify({ image: url('image/png', Buffer.from('<script>alert(1)</script>')) }) });
      assert.strictEqual(r.status, 400);
    });

    await check('GET serves the stored bytes, publicly, with nosniff', async () => {
      const saved = token; token = null;   // an <img> carries no bearer token
      const r = await api(`/api/auth/avatar/${userId}?v=2`);
      token = saved;
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('content-type'), 'image/jpeg');
      assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(r.body.length > 300 * 1024, `got ${r.body.length} bytes`);
    });

    await check('the ?v= URL is the only one cached for a year', async () => {
      const a = await api(`/api/auth/avatar/${userId}?v=2`);
      const b = await api(`/api/auth/avatar/${userId}`);
      assert.match(a.headers.get('cache-control'), /immutable/);
      assert.doesNotMatch(b.headers.get('cache-control'), /immutable/,
        'a versionless URL must not be pinned — its bytes can change');
    });

    await check('an account with no picture 404s rather than 500s', async () => {
      const r = await api('/api/auth/avatar/999999999');
      assert.strictEqual(r.status, 404);
    });
    await check('a non-numeric id 404s without reaching the query', async () => {
      const r = await api('/api/auth/avatar/not-an-id');
      assert.strictEqual(r.status, 404);
    });

    await check('delete restores the emoji and keeps the high-water mark', async () => {
      const r = await api('/api/auth/avatar', { method: 'DELETE' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.user.avatar_url, null, 'avatar_url must go null so callers fall back');
      const { rows } = await pool.query('SELECT avatar_version FROM web_users WHERE id = $1', [userId]);
      assert.strictEqual(rows[0].avatar_version, -2,
        'negative, not zero: zero restarts the numbering, and a browser holding ' +
        'the immutable ?v=1 from the deleted picture would serve it back forever');
      const gone = await api(`/api/auth/avatar/${userId}?v=2`);
      assert.strictEqual(gone.status, 404, 'the bytes must actually be gone');
    });

    await check('re-uploading after a delete never reissues a spent ?v=', async () => {
      const r = await api('/api/auth/avatar', { method: 'POST', body: JSON.stringify({ image: url('image/png', PNG) }) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.user.avatar_url, /\?v=3$/,
        'counting up from |−2| — a reset would have handed out v=1 a second time');
    });

    await check('the emoji column was never touched by any of this', async () => {
      const { rows } = await pool.query('SELECT avatar FROM web_users WHERE id = $1', [userId]);
      assert.ok(rows[0].avatar == null || rows[0].avatar.length <= 8,
        'the 8-char cap on web_users.avatar is load-bearing — it is rendered into the page');
    });
  } finally {
    if (userId) {
      // ON DELETE CASCADE takes web_user_avatars and the session with it.
      await pool.query('DELETE FROM web_users WHERE id = $1', [userId]).catch(() => {});
    }
    server.close();
    await pool.end().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS FAILED:', e); process.exit(1); });
