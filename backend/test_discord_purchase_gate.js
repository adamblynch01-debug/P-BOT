// Two rules that only hold if every door enforces them:
//
//   1. Nothing can be bought by an account with no VERIFIED Discord link.
//      Delivery, support, replacements and disputes all happen in Discord, so
//      an order from an unlinked account has no reachable owner. There are
//      three doors into the money — /api/orders/create, /api/reseller/purchase
//      and /api/balance/topup/create — and a gate on two of three is not a
//      gate. `discord_id` alone is not enough: it is a profile field anyone can
//      type. Only `discord_verified`, set by the OAuth round-trip, counts.
//
//   2. A vouch left anywhere ends up in all three places — the website, the
//      #vouches channel, and the database that /importvouches can rebuild a
//      new server from. The bot's vouches.json lives on an ephemeral container
//      filesystem, so the `reviews` table is the durable copy, not the cache.
//
//   node test_discord_purchase_gate.js
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

// ─── Stubs ───────────────────────────────────────────────
let currentUser = null;          // what the session token resolves to
let REVIEWS = [];
let nextReviewId = 1;
const NOTIFIED = [];             // every notifyBot(event, data) call

const notifyPath = require.resolve('./utils/botNotify');
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { notifyBot: async (event, data) => { NOTIFIED.push({ event, data }); return { ok: true }; } },
};

const TIERS = { 1: { id: 1, price_cents: 4000, label: 'Month', product_name: 'Ghost Pro' } };

const dbPath = require.resolve('./db');
const exec = async (text, params) => {
  const t = text.replace(/\s+/g, ' ').trim();

  if (/FROM web_sessions s/.test(t)) {
    return { rows: currentUser ? [currentUser] : [] };
  }
  if (/FROM product_tiers t JOIN products p/.test(t)) {
    const ids = params[1] || [];
    return { rows: ids.map(id => TIERS[id]).filter(Boolean) };
  }

  // ── reviews ──
  // has_image is a computed column in the real query, so the stub carries the
  // bytes and derives it the same way the SQL does.
  const pub = r => ({ ...r, has_image: r.image_data != null });

  if (/INSERT INTO reviews/.test(t)) {
    const website = /'website'/.test(t);
    const row = website
      ? { id: nextReviewId++, guild_id: params[0], web_user_id: params[1], display_name: params[2],
          product_id: params[3], rating: params[4], body: params[5], source: 'website',
          discord_id: params[6], approved: params[7], external_id: null, created_at: new Date(),
          image_url: null, image_data: null, image_mime: null }
      : { id: nextReviewId++, guild_id: params[0], web_user_id: null, display_name: params[1],
          product_id: params[2], rating: params[3], body: params[4], source: 'discord',
          external_id: params[5], discord_id: params[6], approved: true, created_at: new Date(),
          image_url: params[7], image_data: params[8], image_mime: params[9] };
    REVIEWS.push(row);
    return { rows: [pub(row)] };
  }
  if (/SELECT id, image_url, \(image_data IS NOT NULL\) AS has_image FROM reviews/.test(t)) {
    const hit = REVIEWS.filter(r => r.source === 'discord' && String(r.external_id) === String(params[1]));
    return { rows: hit.map(r => ({ id: r.id, image_url: r.image_url, has_image: r.image_data != null })) };
  }
  if (/UPDATE reviews SET image_url/.test(t)) {
    const r = REVIEWS.find(x => String(x.id) === String(params[3]));
    if (r) { r.image_url = params[0]; r.image_data = params[1]; r.image_mime = params[2]; }
    return { rows: [] };
  }
  if (/SELECT image_data, image_mime, approved FROM reviews/.test(t)) {
    const r = REVIEWS.find(x => String(x.id) === String(params[0]) && x.image_data != null);
    return { rows: r ? [{ image_data: r.image_data, image_mime: r.image_mime, approved: r.approved }] : [] };
  }
  if (/UPDATE reviews SET approved/.test(t)) {
    const r = REVIEWS.find(x => String(x.id) === String(params[1]));
    // Mirrors `approved IS DISTINCT FROM $1` — no row back when nothing changed.
    if (!r || r.approved === params[0]) return { rows: [] };
    r.approved = params[0];
    return { rows: [pub(r)] };
  }
  if (/FROM reviews WHERE guild_id = \$1 AND approved = true/.test(t)) {
    return { rows: REVIEWS.filter(r => r.approved).map(pub) }; // public list
  }
  if (/FROM reviews WHERE guild_id = \$1 ORDER BY/.test(t)) {
    return { rows: REVIEWS.map(pub) };                         // admin/all
  }
  return { rows: [] };
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: exec, withTransaction: async (fn) => fn(exec), pool: {} },
};

process.env.GUILD_ID = 'test-guild';
process.env.API_SECRET = 'test-secret';
process.env.CASHAPP_FEE_PERCENT = '10';

const app = express();
app.use(express.json());
app.use('/api/orders', require('./routes/orders'));
app.use('/api/reseller', require('./routes/reseller'));
app.use('/api/balance', require('./routes/balance'));
app.use('/api/reviews', require('./routes/reviews'));
const server = http.createServer(app);

function call(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const post = (p, b, t) => call('POST', p, b, t);
const patch = (p, b, t) => call('PATCH', p, b, t);
const get = (p, t) => call('GET', p, null, t);

// The image endpoint answers bytes, not JSON, so it needs a raw reader.
function rawGet(path, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── A stand-in for Discord's CDN ────────────────────────
// The smallest valid PNG there is. Nothing here cares what the picture looks
// like, only that the exact bytes that went in come back out.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
let CDN_HITS = 0;
const cdn = http.createServer((req, res) => {
  CDN_HITS++;
  if (req.url.startsWith('/shot.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PNG);
  }
  if (req.url.startsWith('/page.html')) {
    // Not an image. Storing whatever a URL happens to return would let the
    // vouch pipeline cache arbitrary content on our own domain.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html>not a picture</html>');
  }
  res.writeHead(404).end();       // an expired attachment link
});
let CDN = '';

const LINKED = { id: 7, username: 'buyer', email: 'b@x.c', role: 'member', banned: false,
                 discord_id: '123456789', discord_verified: true, reseller_discount: 0 };
const UNVERIFIED = { ...LINKED, discord_verified: false };
const NO_ID = { ...LINKED, discord_id: null, discord_verified: true };

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

// A purchase attempt that never reaches the DB — we only care which gate answers.
// The third element is whatever else that door needs of the account, so the
// pass-through case tests the Discord gate rather than tripping over an
// unrelated refusal (the reseller door has its own role check behind this one).
const DOORS = [
  ['/api/orders/create',        { items: [{ id: '1', qty: 1 }], payment_method: 'cashapp', email: 'b@x.c' }, {}],
  ['/api/reseller/purchase',    { tier_id: 1, qty: 1 }, { role: 'reseller' }],
  ['/api/balance/topup/create', { amount: 25, payment_method: 'cashapp' }, {}],
];

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await new Promise(r => cdn.listen(0, '127.0.0.1', r));
  CDN = `http://127.0.0.1:${cdn.address().port}`;

  // ─────────────────────────────────────────────────────────
  section('every door into the money asks for the Discord link');

  for (const [path, body, extra] of DOORS) {
    currentUser = null;
    await check(`${path} refuses an anonymous caller`, async () => {
      const r = await post(path, body);
      assert.strictEqual(r.status, 401, JSON.stringify(r.body));
    });

    currentUser = UNVERIFIED;
    await check(`${path} refuses an UNVERIFIED discord_id`, async () => {
      const r = await post(path, body, 'tok');
      assert.strictEqual(r.status, 403, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, 'discord_link_required');
    });

    currentUser = NO_ID;
    await check(`${path} refuses a verified flag with no id behind it`, async () => {
      const r = await post(path, body, 'tok');
      assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    });

    currentUser = { ...LINKED, ...extra };
    await check(`${path} lets a linked account through the gate`, async () => {
      const r = await post(path, body, 'tok');
      assert.strictEqual(r.status === 401, false, 'a linked account was treated as logged out');
      assert.notStrictEqual(r.body.code, 'discord_link_required',
        `gate rejected a linked account: ${JSON.stringify(r.body)}`);
    });
  }

  await check('the refusal carries a code the storefront can act on', async () => {
    currentUser = UNVERIFIED;
    const r = await post('/api/orders/create', DOORS[0][1], 'tok');
    // The storefront shows a BUTTON for this one error, not a message, so it
    // has to be machine-distinguishable from every other 403.
    assert.strictEqual(r.body.code, 'discord_link_required');
    assert.ok(/discord/i.test(r.body.error || ''), r.body.error);
  });

  await check('the buyer identity comes from the session, not the request body', async () => {
    currentUser = LINKED;
    // Spoofing someone else's discord_id in the body must not change who the
    // order belongs to — that was how an order could be attributed to a
    // stranger (or to nobody) before the gate.
    const r = await post('/api/orders/create',
      { ...DOORS[0][1], discord_id: '999999999', web_user_id: 4242 }, 'tok');
    assert.ok(r.status !== 403, JSON.stringify(r.body));
  });

  await check('quoting a cart still works before you have linked', async () => {
    currentUser = UNVERIFIED;
    const r = await post('/api/orders/quote', { items: [{ id: '1', qty: 1 }], payment_method: 'cashapp' }, 'tok');
    // Browsing and pricing are not purchases. Blocking the quote too would
    // hide the price behind a login wall for no benefit.
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  // ─────────────────────────────────────────────────────────
  section('a website vouch reaches Discord and the durable store');

  REVIEWS = []; NOTIFIED.length = 0;
  currentUser = LINKED;
  await check('a linked buyer\'s vouch goes live immediately', async () => {
    const r = await post('/api/reviews', { rating: 5, body: 'fast delivery' }, 'tok');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.approved, true);
    assert.strictEqual(r.body.pending, false);
  });
  await check('...is stored approved, so /importvouches can rebuild it', () => {
    assert.strictEqual(REVIEWS.length, 1);
    assert.strictEqual(REVIEWS[0].approved, true);
    assert.strictEqual(REVIEWS[0].source, 'website');
    assert.strictEqual(REVIEWS[0].discord_id, '123456789');
  });
  await check('...and is pushed to the bot for the #vouches channel', () => {
    assert.strictEqual(NOTIFIED.length, 1);
    assert.strictEqual(NOTIFIED[0].event, 'web_review');
    assert.strictEqual(NOTIFIED[0].data.review.rating, 5);
    assert.strictEqual(NOTIFIED[0].data.review.discord_id, '123456789');
  });

  REVIEWS = []; NOTIFIED.length = 0;
  currentUser = UNVERIFIED;
  await check('an unlinked account\'s vouch waits for a human', async () => {
    const r = await post('/api/reviews', { rating: 5, body: 'trust me' }, 'tok');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.approved, false);
    assert.strictEqual(r.body.pending, true);
  });
  await check('...and nothing is posted to Discord until it is approved', () => {
    assert.strictEqual(NOTIFIED.length, 0);
    assert.strictEqual(REVIEWS[0].approved, false);
  });
  await check('approving it posts it exactly once', async () => {
    currentUser = { ...LINKED, role: 'admin' };
    const a = await patch(`/api/reviews/${REVIEWS[0].id}/approve`, { approved: true }, 'tok');
    assert.strictEqual(a.status, 200);
    assert.strictEqual(NOTIFIED.length, 1);
    // Toggling approve again is not a second vouch. The UPDATE only returns a
    // row on a real transition, which is what makes this idempotent.
    const again = await patch(`/api/reviews/${REVIEWS[0].id}/approve`, { approved: true }, 'tok');
    assert.strictEqual(again.body.unchanged, true);
    assert.strictEqual(NOTIFIED.length, 1);
  });
  await check('a rating outside 1-5 is refused', async () => {
    currentUser = LINKED;
    const r = await post('/api/reviews', { rating: 9, body: 'x' }, 'tok');
    assert.strictEqual(r.status, 400);
  });

  // ─────────────────────────────────────────────────────────
  section('a Discord vouch reaches the website and the durable store');

  REVIEWS = []; NOTIFIED.length = 0;
  currentUser = null;
  await check('the bot can push a vouch it collected in the server', async () => {
    const r = await post('/api/reviews/bot', {
      secret: 'test-secret', display_name: 'vexor', rating: 5,
      body: 'legit', discord_id: '555', external_id: 'msg-1',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(REVIEWS.length, 1);
    assert.strictEqual(REVIEWS[0].source, 'discord');
    // Staff already vouched for it by letting it stand in the server, so it
    // shows on the site straight away.
    assert.strictEqual(REVIEWS[0].approved, true);
  });
  await check('...and it shows up on the public storefront list', async () => {
    const r = await get('/api/reviews');
    assert.strictEqual(r.body.reviews.length, 1);
    assert.strictEqual(r.body.reviews[0].display_name, 'vexor');
  });
  await check('re-sending the same message id does not duplicate the vouch', async () => {
    const r = await post('/api/reviews/bot', {
      secret: 'test-secret', display_name: 'vexor', rating: 5,
      body: 'legit', discord_id: '555', external_id: 'msg-1',
    });
    assert.strictEqual(r.body.deduped, true);
    assert.strictEqual(REVIEWS.length, 1);
  });
  await check('a wrong secret cannot write a vouch', async () => {
    const r = await post('/api/reviews/bot', { secret: 'nope', display_name: 'x', rating: 5 });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(REVIEWS.length, 1);
  });
  // ─────────────────────────────────────────────────────────
  section('the screenshot travels with the vouch');

  REVIEWS = [];
  await check('a vouch posted with an image keeps its own copy of the bytes', async () => {
    const r = await post('/api/reviews/bot', {
      secret: 'test-secret', display_name: 'shooter', rating: 5, body: 'proof attached',
      discord_id: '777', external_id: 'msg-img', image_url: `${CDN}/shot.png`,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.image_stored, true);
    // Stored, not linked: Discord's attachment URLs are signed and expire, so
    // a saved link would show the picture today and 404 tomorrow.
    assert.ok(Buffer.isBuffer(REVIEWS[0].image_data));
    assert.strictEqual(REVIEWS[0].image_mime, 'image/png');
    assert.strictEqual(REVIEWS[0].image_url, `${CDN}/shot.png`);
  });
  await check('the storefront is pointed at our copy, not at Discord', async () => {
    const r = await get('/api/reviews');
    assert.ok(/\/api\/reviews\/\d+\/image$/.test(r.body.reviews[0].image || ''), r.body.reviews[0].image);
  });
  await check('and that URL actually serves the image', async () => {
    const raw = await rawGet(`/api/reviews/${REVIEWS[0].id}/image`);
    assert.strictEqual(raw.status, 200);
    assert.strictEqual(raw.headers['content-type'], 'image/png');
    assert.ok(raw.body.equals(PNG), 'served bytes differ from what was fetched');
  });

  REVIEWS = [];
  await check('a screenshot uploaded AFTER the vouch is backfilled onto it', async () => {
    // This is the normal case, not the edge case: the bot posts the vouch,
    // then waits up to a minute for the customer to drop a screenshot, then
    // calls back with the same external_id. If a duplicate were a plain no-op
    // the picture would never arrive.
    const first = await post('/api/reviews/bot', {
      secret: 'test-secret', display_name: 'late', rating: 5, body: 'pic coming',
      discord_id: '888', external_id: 'msg-late',
    });
    assert.strictEqual(first.body.image_stored, false);
    assert.strictEqual(REVIEWS[0].image_data, null);

    const second = await post('/api/reviews/bot', {
      secret: 'test-secret', display_name: 'late', rating: 5, body: 'pic coming',
      discord_id: '888', external_id: 'msg-late', image_url: `${CDN}/shot.png`,
    });
    assert.strictEqual(second.body.deduped, true);
    assert.strictEqual(second.body.image_added, true);
    assert.strictEqual(REVIEWS.length, 1, 'the backfill must not create a second vouch');
    assert.ok(Buffer.isBuffer(REVIEWS[0].image_data));
  });
  await check('a third call does not re-download what we already have', async () => {
    const before = CDN_HITS;
    const r = await post('/api/reviews/bot', {
      secret: 'test-secret', display_name: 'late', rating: 5,
      discord_id: '888', external_id: 'msg-late', image_url: `${CDN}/shot.png`,
    });
    assert.strictEqual(r.body.deduped, true);
    assert.strictEqual(r.body.image_added, undefined);
    assert.strictEqual(CDN_HITS, before, 'the image was fetched again for no reason');
  });

  REVIEWS = [];
  await check('a dead image link does not cost us the vouch', async () => {
    // The picture is worth having; the vouch is worth more. A CDN 404 or a
    // timeout must leave the text vouch standing.
    const r = await post('/api/reviews/bot', {
      secret: 'test-secret', display_name: 'gone', rating: 4, body: 'link rotted',
      discord_id: '999', external_id: 'msg-404', image_url: `${CDN}/missing.png`,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.image_stored, false);
    assert.strictEqual(REVIEWS.length, 1);
    // The address is kept so it can be retried rather than silently forgotten.
    assert.strictEqual(REVIEWS[0].image_url, `${CDN}/missing.png`);
  });
  await check('a link that is not an image is refused', async () => {
    REVIEWS = [];
    const r = await post('/api/reviews/bot', {
      secret: 'test-secret', display_name: 'sneaky', rating: 5, body: 'x',
      external_id: 'msg-html', image_url: `${CDN}/page.html`,
    });
    assert.strictEqual(r.body.image_stored, false);
    assert.strictEqual(REVIEWS[0].image_data, null);
  });
  await check('an unapproved vouch does not publish its screenshot', async () => {
    REVIEWS[0].image_data = PNG;
    REVIEWS[0].image_mime = 'image/png';
    REVIEWS[0].approved = false;
    currentUser = null;
    const raw = await rawGet(`/api/reviews/${REVIEWS[0].id}/image`);
    assert.strictEqual(raw.status, 404);
  });
  await check('...but staff reviewing the queue can see it', async () => {
    currentUser = { ...LINKED, role: 'staff' };
    const raw = await rawGet(`/api/reviews/${REVIEWS[0].id}/image`, 'tok');
    assert.strictEqual(raw.status, 200);
    currentUser = null;
  });

  REVIEWS = []; NOTIFIED.length = 0;
  await check('the export the bot re-imports from carries everything back', async () => {
    await post('/api/reviews/bot', {
      secret: 'test-secret', display_name: 'vexor', rating: 5,
      body: 'legit', discord_id: '555', external_id: 'msg-1',
    });
    // /importvouches source:website reads this. If it does not carry the
    // Discord id, a restored server cannot re-attribute a single vouch.
    const r = await get('/api/reviews/admin/all?secret=test-secret');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const v = r.body.reviews[0];
    assert.strictEqual(v.discord_id, '555');
    assert.strictEqual(v.rating, 5);
    assert.strictEqual(v.body, 'legit');
    assert.ok(v.created_at);
  });

  server.close();
  cdn.close();
  console.log(`\n${passed} passed, ${failed} failed`);
})();
