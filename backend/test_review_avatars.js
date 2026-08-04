// Round 29 item 4: "HAVE IT SO WHE POSTING REVIEW IT SHOWS THEIR ACTUAL
// PROFILE IMAGE. EITHER FROM THE SITE OR FROM USER DISCORD."
//
// A reviewer can have up to three pictures and the store has a preference
// between them. The order is decided ONCE, in routes/reviews.js reviewAvatar():
//
//     uploaded here  >  their Discord  >  their Google  >  nothing
//
// The storefront must not re-derive it. If both ends rank the sources, they
// agree right up until one of them changes and then they disagree silently —
// so this file asserts the backend picks, and that the card only renders what
// it was handed.
//
// Both halves are driven off ONE table of cases, and both are extracted from
// the real files rather than copied: a copy drifts, and then it tests itself.
//
//   node backend/test_review_avatars.js          (static + rendering)
//   railway run node backend/test_review_avatars.js --live   (adds the prod check)
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const SITE = process.env.STOREFRONT_DIR
  || 'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG';
const BACKEND = 'https://uhservices.example.invalid';   // stands in for PAYMENT_BACKEND

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// Brace-match a `function name(...) {...}` out of a source file. The storefront
// has no build step and no module boundary, so this is the only way to get the
// REAL function under test instead of a second copy of it.
function extractFn(src, name, file) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found in ${file}`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const htmlSrc = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
const revSrc  = fs.readFileSync(path.join(__dirname, 'routes', 'reviews.js'), 'utf8');

// ── the backend's chooser ────────────────────────────────────────────────
const beCtx = vm.createContext({ String, Number, RegExp, encodeURIComponent });
vm.runInContext(extractFn(revSrc, 'reviewAvatar', 'routes/reviews.js'), beCtx);
const reviewAvatar = beCtx.reviewAvatar;

// ── the storefront's renderer ────────────────────────────────────────────
const feCtx = vm.createContext({ String, Number, Math, Date, RegExp, Array, Object,
  JSON, PAYMENT_BACKEND: BACKEND });
vm.runInContext(extractFn(htmlSrc, 'escapeHtml', 'index.html'), feCtx);
vm.runInContext(extractFn(htmlSrc, 'reviewCardHtml', 'index.html'), feCtx);
vm.runInContext(extractFn(htmlSrc, 'reviewAvatarFallback', 'index.html'), feCtx);
const reviewCardHtml = feCtx.reviewCardHtml;

// What the card actually drew in the hexagon, with the surrounding markup gone.
function avatarBox(html) {
  const m = /<div class="author-avatar([^"]*)">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(m, 'the card has no .author-avatar box at all');
  return { cls: m[1].trim(), inner: m[2].trim() };
}

// ── the cases, one row shape, run through both ends ──────────────────────
const CASES = [
  {
    what: 'a picture uploaded here wins over everything else',
    row: { web_user_id: 7, avatar_version: 3, u_discord_avatar: 'dhash', u_discord_id: '111',
           google_avatar: 'https://lh3.googleusercontent.com/x', avatar: '👻', display_name: 'GHOST.EXE420' },
    want: '/api/auth/avatar/7?v=3',
  },
  {
    what: 'a deleted upload (negated version) falls through to Discord',
    // avatar_version is NEGATED on delete rather than zeroed, so the high-water
    // mark survives. `> 0` is what makes that read as "no picture".
    row: { web_user_id: 7, avatar_version: -3, u_discord_avatar: 'dhash', u_discord_id: '111',
           avatar: '👻', display_name: 'GHOST.EXE420' },
    want: 'https://cdn.discordapp.com/avatars/111/dhash.png?size=64',
  },
  {
    what: 'a reviewer with no site account uses the hash stored on the review',
    row: { web_user_id: null, avatar_hash: 'rhash', discord_id: '222', display_name: 'heinous0420' },
    want: 'https://cdn.discordapp.com/avatars/222/rhash.png?size=64',
  },
  {
    what: 'the account hash beats the one frozen on the review',
    // The review's hash is whatever the member looked like the day they posted.
    // The account's is refreshed on every sign-in, so it is the fresher of the two.
    row: { web_user_id: 9, avatar_version: 0, u_discord_avatar: 'new', u_discord_id: '333',
           avatar_hash: 'old', discord_id: '333', display_name: 'notafridge.007' },
    want: 'https://cdn.discordapp.com/avatars/333/new.png?size=64',
  },
  {
    what: 'an animated avatar hash is still asked for as .png',
    row: { web_user_id: null, avatar_hash: 'a_beef', discord_id: '444', display_name: 'anim' },
    want: 'https://cdn.discordapp.com/avatars/444/a_beef.png?size=64',
  },
  {
    what: 'a hash with no id to pair it with is unusable, so Google is next',
    row: { web_user_id: null, avatar_hash: 'orphan', discord_id: null,
           google_avatar: 'https://lh3.googleusercontent.com/y', display_name: 'g' },
    want: 'https://lh3.googleusercontent.com/y',
  },
  {
    what: 'a non-https google_avatar is refused rather than rendered',
    row: { web_user_id: 5, avatar_version: 0, google_avatar: 'http://evil.example/x', avatar: '🙂', display_name: 'plain' },
    want: null,
  },
  {
    what: 'nothing at all',
    row: { web_user_id: null, display_name: 'Anonymous' },
    want: null,
  },
];

(function () {
  console.log('\n── the backend picks the picture (routes/reviews.js reviewAvatar) ──');
  for (const c of CASES) {
    check(c.what, () => assert.strictEqual(reviewAvatar(c.row), c.want));
  }

  console.log('\n── the card renders what it was handed (index.html reviewCardHtml) ──');
  for (const c of CASES) {
    // This is the shape GET /api/reviews really emits — the chooser's answer in
    // `avatar`, the emoji alongside it in `avatar_emoji`.
    const r = { id: '1', rating: 5, body: 'good', display_name: c.row.display_name,
                avatar: c.want, avatar_emoji: c.row.avatar || null };
    check(c.what, () => {
      const box = avatarBox(reviewCardHtml(r));
      if (c.want) {
        assert.match(box.inner, /^<img /, 'a resolved picture was not drawn as an <img>');
        const src = /src="([^"]+)"/.exec(box.inner)[1];
        // Our own uploads come back site-relative; this page is not served by
        // the API, so a bare '/api/...' src would hit uhservices.xyz and 404.
        const want = /^https?:\/\//i.test(c.want) ? c.want : BACKEND + c.want;
        assert.strictEqual(src, want.replace(/&/g, '&amp;'));
      } else if (c.row.avatar) {
        assert.strictEqual(box.inner, c.row.avatar, 'no picture and an emoji → the emoji');
        assert.strictEqual(box.cls, 'is-emoji', 'the frame is not resized for an emoji');
      } else {
        assert.strictEqual(box.inner, c.row.display_name.slice(0, 2).toUpperCase(),
          'no picture and no emoji → the initials, as before this feature existed');
        assert.strictEqual(box.cls, '', 'initials do not want the emoji sizing');
      }
    });
  }

  console.log('\n── the fallbacks, which is where this actually gets used ──');

  check('a 404ing picture steps down to the emoji', () => {
    const attrs = { 'data-emoji': '👻', 'data-initials': 'GH' };
    const box = { classList: { add(c) { box._cls = c; } }, textContent: null };
    feCtx.reviewAvatarFallback({ parentNode: box, getAttribute: (k) => attrs[k] });
    assert.strictEqual(box.textContent, '👻');
    assert.strictEqual(box._cls, 'is-emoji');
  });

  check('and steps down again to the initials when there is no emoji', () => {
    const attrs = { 'data-emoji': '', 'data-initials': 'HE' };
    const box = { classList: { add(c) { box._cls = c; } }, textContent: null };
    feCtx.reviewAvatarFallback({ parentNode: box, getAttribute: (k) => attrs[k] });
    assert.strictEqual(box.textContent, 'HE');
    assert.strictEqual(box._cls, undefined, 'initials must not get the emoji sizing');
  });

  check('the fallback writes textContent, never innerHTML', () => {
    // Both the emoji and the initials are cut from a user-controlled display
    // name. innerHTML here would be stored XSS on the public storefront.
    const src = extractFn(htmlSrc, 'reviewAvatarFallback', 'index.html');
    assert.ok(src.includes('textContent'), 'reviewAvatarFallback does not use textContent');
    assert.ok(!src.includes('innerHTML'), 'reviewAvatarFallback uses innerHTML');
  });

  console.log('\n── the two ends do not both rank the sources ──');

  check('the storefront never builds a Discord cdn url itself', () => {
    // Comments stripped first: the note above reviewCardHtml explains the
    // precedence and names all three sources, which is exactly the thing this
    // check is looking for in the CODE.
    const card = extractFn(htmlSrc, 'reviewCardHtml', 'index.html')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/cdn\.discordapp\.com/.test(card),
      'reviewCardHtml builds an avatar url — the precedence now lives in two places');
    assert.ok(!/google/i.test(card),
      'reviewCardHtml knows about Google avatars — it should only know about `avatar`');
  });

  check('GET /api/reviews sends the emoji alongside the picture', () => {
    // Not redundant with `avatar`: an avatar url can 404 in the browser and the
    // card needs something to fall back to without a round trip.
    assert.match(revSrc, /avatar: reviewAvatar\(r\)/, 'the list endpoint does not send `avatar`');
    assert.match(revSrc, /avatar_emoji: r\.avatar \|\| null/, 'the list endpoint does not send `avatar_emoji`');
  });

  check('the author join cannot duplicate a review row', () => {
    // A plain LEFT JOIN on (web_user_id OR discord_id) fans out to one row per
    // matching account. LATERAL … LIMIT 1 is what stops a vouch appearing twice.
    assert.match(revSrc, /LEFT JOIN LATERAL/, 'the author join is not LATERAL');
    assert.match(revSrc, /ORDER BY \(w\.id = r\.web_user_id\) DESC NULLS LAST\s*\n\s*LIMIT 1/,
      'the LATERAL subquery does not pin one account, account-match first');
  });

  check('both OAuth callbacks persist the picture they are handed', () => {
    const auth = fs.readFileSync(path.join(__dirname, 'routes', 'auth.js'), 'utf8');
    assert.match(auth, /discord_avatar/, 'the Discord callback still throws me.data.avatar away');
    assert.match(auth, /google_avatar/, 'the Google callback still throws the `picture` claim away');
    // Best-effort on purpose: a refresh that throws must not break a login.
    assert.match(auth, /discord_avatar IS DISTINCT FROM/,
      'the Discord avatar refresh is not guarded — it writes on every single login');
  });

  check('the bot sends the author hash with a synced vouch', () => {
    // The only source for a reviewer who has never logged into the site, which
    // is most of #vouches.
    const bot = process.env.SUPERBOT_DIR || 'C:/Users/VENOM-NODE/Downloads/SUPERBOT-main';
    const src = fs.readFileSync(path.join(bot, 'index.js'), 'utf8');
    assert.match(src, /avatarHash: interaction\.user\.avatar/, 'the vouch entry drops the author avatar');
    assert.match(src, /avatar_hash: entry\.avatarHash/, 'syncVouchToWebsite omits avatar_hash');
    assert.match(revSrc, /avatar_hash \? String\(avatar_hash\) : null/,
      'POST /api/reviews/bot does not store avatar_hash on insert');
    // The screenshot arrives in a SECOND call with the same external_id, and it
    // carries the hash too — which is the only way a row that predates this
    // column ever gets one. Nothing walks the table.
    assert.match(revSrc, /UPDATE reviews SET avatar_hash = \$1/,
      'the dedupe branch does not backfill avatar_hash');
  });

  const live = process.argv.includes('--live');
  const done = () => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  };

  if (!live) { console.log('\n(skipping the prod check — pass --live under `railway run`)'); return done(); }

  console.log('\n── against the live list endpoint ──');
  const { query, pool } = require('./db');
  query(
    `SELECT r.id, r.display_name, r.discord_id, r.avatar_hash,
            u.id AS web_user_id, u.avatar, u.avatar_version,
            u.discord_avatar AS u_discord_avatar, u.discord_id AS u_discord_id, u.google_avatar
       FROM reviews r
       LEFT JOIN LATERAL (
         SELECT w.* FROM web_users w
          WHERE w.guild_id = r.guild_id
            AND (w.id = r.web_user_id
                 OR (r.web_user_id IS NULL AND r.discord_id IS NOT NULL AND w.discord_id = r.discord_id))
          ORDER BY (w.id = r.web_user_id) DESC NULLS LAST
          LIMIT 1
       ) u ON true
      WHERE r.guild_id = $1 AND r.approved = true
      ORDER BY r.created_at DESC LIMIT 200`,
    [process.env.GUILD_ID]
  ).then(({ rows }) => {
    check('the real query returns one row per review', () => {
      const ids = rows.map(r => String(r.id));
      assert.strictEqual(new Set(ids).size, ids.length, 'the join duplicated a review');
    });
    check('every live row resolves to a picture or an explicit nothing', () => {
      for (const r of rows) {
        const a = reviewAvatar(r);
        assert.ok(a === null || /^(https:\/\/|\/api\/)/.test(a),
          `review ${r.id} resolved to something that is not a usable src: ${a}`);
      }
      const withPic = rows.filter(r => reviewAvatar(r)).length;
      console.log(`        ${withPic}/${rows.length} approved reviews now show a real picture`);
    });
    return pool.end();
  }).then(done, (e) => { console.log(`  FAIL  live check\n        ${e.message}`); failed++; done(); });
})();
