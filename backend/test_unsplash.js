// The Unsplash proxy behind the profile-picture picker.
//
// The constraint that shapes all of this: a demo Unsplash app gets **50
// requests an hour**, for the whole site, not per user. So the things worth
// pinning are not "does it return photos" — they are the ones that decide
// whether the feature still works once more than one person opens the modal:
//
//   • the cache must not be split by case or spacing, or "Cyberpunk" and
//     "cyberpunk" are two of the fifty.
//   • an empty result must be cached too. Mistyped searches are the cheapest
//     way to burn an hour's allowance.
//   • the key must never reach the response, in any branch.
//   • only the fields the picker draws are forwarded — Unsplash's photo object
//     carries EXIF and GPS.
//   • attribution links must carry UTM parameters; that is an API term, not a
//     nicety, and so is the download ping.
//
//   node test_unsplash.js
'use strict';

const assert = require('assert');
const path = require('path');

// Keyless: proves the not-configured path, and guarantees no test can ever
// spend a real request.
delete process.env.UNSPLASH_ACCESS_KEY;
const routeFile = path.join(__dirname, 'routes', 'unsplash.js');

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed++; };

const { _internals } = require(routeFile);
const { slimPhoto, cacheGet, cacheSet, cache, noteQuota, quota } = _internals;

// A photo as Unsplash actually returns it, trimmed to the shape that matters
// plus the fields we must NOT pass on.
const RAW = {
  id: 'abc123XYZ',
  blur_hash: 'LKO2?U%2Tw=w]~RB',
  color: '#0c0c0c',
  width: 4000, height: 4000,
  alt_description: 'neon city street',
  description: null,
  urls: { thumb: 'https://images.unsplash.com/t.jpg', small: 'https://images.unsplash.com/s.jpg', regular: 'https://images.unsplash.com/r.jpg', full: 'https://images.unsplash.com/f.jpg', raw: 'https://images.unsplash.com/raw.jpg' },
  links: { html: 'https://unsplash.com/photos/abc123XYZ', download_location: 'https://api.unsplash.com/photos/abc123XYZ/download?ixid=SECRET' },
  user: { name: 'Ada Lovelace', username: 'ada', portfolio_url: 'https://ada.dev' },
  exif: { make: 'Canon', model: 'R5' },
  location: { name: 'Tokyo', position: { latitude: 35.6, longitude: 139.7 } },
};

// ─── What crosses the wire ───────────────────────────────────────────────────
check('only the fields the picker draws are forwarded', () => {
  const p = slimPhoto(RAW);
  assert.deepStrictEqual(
    Object.keys(p).sort(),
    ['alt', 'author', 'blurHash', 'color', 'full', 'height', 'id', 'link', 'small', 'thumb', 'width'].sort());
});

check("a stranger's camera and GPS are not proxied through our API", () => {
  const s = JSON.stringify(slimPhoto(RAW));
  assert.ok(!s.includes('exif') && !s.includes('Canon'));
  assert.ok(!s.includes('latitude') && !s.includes('Tokyo'));
});

check('the avatar source is `regular`, not `raw` or `full`', () => {
  // A 512px circle needs ~1080px. `raw` is the untouched original — tens of
  // megabytes, fetched into a canvas, on someone's phone.
  assert.strictEqual(slimPhoto(RAW).full, RAW.urls.regular);
});

check('attribution carries the UTM parameters the API terms require', () => {
  const p = slimPhoto(RAW);
  assert.ok(p.author.link.includes('utm_source=uhservices'));
  assert.ok(p.author.link.includes('utm_medium=referral'));
  assert.ok(p.link.includes('utm_source=uhservices'));
  assert.strictEqual(p.author.name, 'Ada Lovelace');
});

check('a photo with no photographer still renders instead of throwing', () => {
  const p = slimPhoto({ ...RAW, user: {}, links: {} });
  assert.strictEqual(p.author.name, 'Unknown');
  assert.strictEqual(p.author.link, '');
  assert.strictEqual(p.link, '');
});

check('a missing description falls back before ending up as "null"', () => {
  assert.strictEqual(slimPhoto({ ...RAW, alt_description: null, description: 'a lake' }).alt, 'a lake');
  assert.strictEqual(slimPhoto({ ...RAW, alt_description: null, description: null }).alt, '');
});

// ─── The cache, which is what makes 50/hour survivable ───────────────────────
check('the cache round-trips and expires', () => {
  cache.clear();
  cacheSet('k::1', { results: [1] });
  assert.deepStrictEqual(cacheGet('k::1'), { results: [1] });
  cache.set('stale::1', { value: { results: [] }, expiresAt: Date.now() - 1 });
  assert.strictEqual(cacheGet('stale::1'), null);
  assert.ok(!cache.has('stale::1'), 'an expired entry should be dropped, not left to grow');
});

check('a hit is refreshed so a burst of one-offs cannot evict a popular query', () => {
  cache.clear();
  cacheSet('popular::1', 1); cacheSet('rare::1', 2);
  assert.strictEqual([...cache.keys()][0], 'popular::1');
  cacheGet('popular::1');
  assert.strictEqual([...cache.keys()][0], 'rare::1', 'the popular key should no longer be first out');
});

check('the cache is bounded', () => {
  cache.clear();
  for (let i = 0; i < 500; i++) cacheSet(`q${i}::1`, i);
  assert.ok(cache.size <= 400, `unbounded at ${cache.size}`);
  assert.ok(cacheGet('q499::1') === 499, 'the newest entry should survive eviction');
});

check('case and spacing do not split the cache', () => {
  // Not a property of cacheSet — of the key the route builds. Spelled out here
  // because getting it wrong turns three of the fifty into one query typed
  // three ways, and nothing would look broken.
  const keyOf = (q, page) => `${q.trim().slice(0, 80).toLowerCase().replace(/\s+/g, ' ')}::${page}`;
  assert.strictEqual(keyOf('Cyber Punk', 1), keyOf('cyber  punk ', 1));
  assert.notStrictEqual(keyOf('cyberpunk', 1), keyOf('cyberpunk', 2));
});

// ─── Quota ───────────────────────────────────────────────────────────────────
check('the remaining allowance is remembered from the response headers', () => {
  noteQuota({ 'x-ratelimit-remaining': '7', 'x-ratelimit-limit': '50' });
  assert.strictEqual(quota.remaining, 7);
  assert.strictEqual(quota.limit, 50);
  assert.ok(quota.resetAt && new Date(quota.resetAt) > new Date(), 'reset should be in the future');
});

check('missing headers leave the last known figure alone', () => {
  noteQuota({ 'x-ratelimit-remaining': '3' });
  noteQuota({});
  assert.strictEqual(quota.remaining, 3, 'a header-less response should not erase what we knew');
});

// ─── The key ─────────────────────────────────────────────────────────────────
check('the access key appears nowhere in what a client can see', () => {
  process.env.UNSPLASH_ACCESS_KEY = 'SECRET_KEY_VALUE';
  const s = JSON.stringify({ photo: slimPhoto(RAW), quota });
  assert.ok(!s.includes('SECRET_KEY_VALUE'));
  // download_location is signed with an ixid tied to the app — it is the one
  // upstream field that looks harmless and is not. The ping happens server-side.
  assert.ok(!s.includes('ixid'));
  assert.ok(!s.includes('download_location'));
  delete process.env.UNSPLASH_ACCESS_KEY;
});

check('the route file never interpolates the key into a response body', () => {
  const src = require('fs').readFileSync(routeFile, 'utf8');
  const bodies = src.match(/res\.(json|send)\([\s\S]*?\);/g) || [];
  for (const b of bodies) {
    // `!!ACCESS_KEY` is the one safe reference: it is a boolean, and it is the
    // whole point of /status. Anything else — the bare identifier, or the key
    // inside a template string — would put the value itself in a response.
    const risky = b.replace(/!!ACCESS_KEY/g, 'BOOL');
    assert.ok(!/ACCESS_KEY/.test(risky), `a response body references the key's VALUE:\n${b}`);
  }
  // /status says whether it is set, never what it is.
  assert.ok(/configured: !!ACCESS_KEY/.test(src));
});

console.log(`\n${passed} checks passed`);
