// Clean URLs and per-product deep links on the storefront.
//
// Round 29 item 3: clicking "H8ED Private External (BO7)" in the footer "bugs
// out instead of showing actual product". Two separate faults sat behind that
// one sentence and this file guards both, because neither can be seen from the
// backend and the storefront has no build step:
//
//   1. THE MODAL PAINTED BEHIND THE PAGE. `section { position:relative;
//      z-index:1 }` makes every <section> a stacking context, and #gameModal
//      lived inside <section id="products">. Its z-index:1000 therefore only
//      ranked it against that section's own children — #features, #reviews,
//      .cta-section and <footer> are later siblings at the same level and
//      painted straight over it. Opening from a game card hid the symptom (the
//      footer is far below the viewport); opening from a footer link did not.
//      The fix is positional, so the test is positional: #gameModal must be a
//      direct child of <body>. Nothing else can express "not trapped".
//
//   2. THE LINK OPENED THE GAME, NOT THE PRODUCT. Now every product has
//      /p/<slug>. The slug is derived from the product NAME at runtime, so the
//      hand-written footer hrefs are the one place it can drift — and the
//      labels are not the names ("H8ED Mobile (BO7)" is really "H8ED MOBILE"
//      in the tab "BO7"). The last check resolves the footer hrefs against the
//      LIVE catalog, so a rename breaks the test instead of the link.
//
//   node backend/test_storefront_routes.js            (offline checks)
//   railway run node backend/test_storefront_routes.js  (adds the live catalog check)
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const DIR = process.env.STOREFRONT_DIR ||
  'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG';
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const redirects = fs.readFileSync(path.join(DIR, '_redirects'), 'utf8');

let passed = 0, failed = 0, skipped = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) {
    if (e && e.skip) { console.log(`  SKIP  ${name}\n        ${e.message}`); skipped++; return; }
    console.log(`  FAIL  ${name}\n        ${e.message}`); failed++;
  }
}
const skip = (m) => { const e = new Error(m); e.skip = true; throw e; };

// `window.gxSlug = function (s) { … }` — extractFn in the sibling suites keys
// off `function name(`, which this assignment form does not match.
function extractAssignedFn(src, name) {
  const start = src.indexOf(`window.${name} = function`);
  assert.ok(start > -1, `window.${name} not found in index.html`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const ctx = vm.createContext({ window: {}, String, Number });
vm.runInContext(extractAssignedFn(html, 'gxSlug'), ctx);
const gxSlug = ctx.window.gxSlug;

// The <footer> only. Scanning the whole file also picks up the /p/ URLs quoted
// in the CSS and router comments, which are prose and not links.
function footerLinks() {
  const foot = html.slice(html.indexOf('<footer>'), html.indexOf('</footer>'));
  return (foot.match(/href="\/p\/([^"]+)"/g) || []).map(s => /\/p\/([^"]+)/.exec(s)[1]);
}

(async () => {
  console.log('\n── the modal is not trapped in a stacking context ──');

  await check('#gameModal is a direct child of <body>', () => {
    const at = html.indexOf('id="gameModal"');
    assert.ok(at > -1, 'the modal is gone entirely');
    // Walk the section tags before it. Any section still open at this point is
    // a stacking context the modal cannot escape. HTML comments are stripped
    // first — the note sitting on the modal talks about the bug it documents,
    // and a <section> quoted in prose is not an open element.
    const before = html.slice(0, at).replace(/<!--[\s\S]*?-->/g, '');
    const tags = before.match(/<section\b|<\/section>/g) || [];
    const open = tags.reduce((n, t) => n + (t === '</section>' ? -1 : 1), 0);
    assert.strictEqual(open, 0,
      `#gameModal is nested ${open} section(s) deep — section{position:relative;z-index:1} ` +
      `makes each one a stacking context, so the footer paints over the modal`);
  });

  await check('it is the last thing before </body>, after the footer', () => {
    assert.ok(html.indexOf('id="gameModal"') > html.indexOf('</footer>'),
      'the modal must come after the footer in document order too — same-z-index ' +
      'siblings are painted in tree order, so an earlier one still loses');
  });

  await check('the rule that caused it is still there (so the comment stays true)', () => {
    assert.match(html, /\n\s*section\s*\{[^}]*position:\s*relative[^}]*z-index:\s*1\s*;/,
      'if section{} lost its z-index the comment on #gameModal is now misleading');
  });

  console.log('\n── slugs ──');

  await check('gxSlug is stable, lowercase and punctuation-free', () => {
    assert.strictEqual(gxSlug('H8ED Private External'), 'h8ed-private-external');
    assert.strictEqual(gxSlug('H8ED MOBILE'), 'h8ed-mobile');
    assert.strictEqual(gxSlug('H8ED RANK TEMPORARY SPOOFER'), 'h8ed-rank-temporary-spoofer');
    assert.strictEqual(gxSlug('VERSE — PERMANENT SPOOFER'), 'verse-permanent-spoofer',
      'the em dash is not an ascii hyphen and must not survive into a URL');
    assert.strictEqual(gxSlug('Dark & Darker'), 'dark-and-darker',
      '& in a path is legal but reads as a query separator to humans');
    assert.strictEqual(gxSlug('  spaced  out  '), 'spaced-out', 'leading/trailing dashes');
    assert.strictEqual(gxSlug(null), '');
  });

  await check('both cheat renderers stamp data-cheat-slug', () => {
    // openModal has an inline renderer for flat games and calls buildCheatHTML
    // for tabbed ones. A deep link into a tabbed game silently fails to scroll
    // if only one of them is stamped.
    const blocks = html.match(/<div class="cheat-block"[^`]*?>/g) || [];
    const emitters = (html.match(/`<div class="cheat-block"/g) || []).length;
    assert.strictEqual(emitters, 2, `expected 2 cheat-block renderers, found ${emitters}`);
    const stamped = (html.match(/`<div class="cheat-block" data-cheat-slug=/g) || []).length;
    assert.strictEqual(stamped, 2,
      'one renderer does not stamp the slug — deep links into it open the modal and never scroll');
  });

  console.log('\n── every routed path is rewritten at the edge ──');

  await check('_redirects covers every path the router knows', () => {
    const routes = /var ROUTES = \{([\s\S]*?)\};/.exec(html);
    assert.ok(routes, 'ROUTES table not found');
    const paths = (routes[1].match(/'(\/[a-z]+)'/g) || []).map(s => s.slice(1, -1));
    assert.ok(paths.length >= 6, `only found ${paths.length} routes`);
    for (const p of paths) {
      assert.ok(new RegExp(`^${p}\\s+/\\s+200\\s*$`, 'm').test(redirects),
        `${p} is routed in the page but has no "${p}  /  200" line in _redirects — ` +
        `a refresh or a shared link 404s at the edge before the router runs`);
    }
    assert.ok(/^\/p\/\*\s+\/\s+200\s*$/m.test(redirects),
      '/p/* is missing — every product link 404s on a direct hit');
  });

  await check('the three paths the owner asked for by name exist', () => {
    for (const p of ['/support', '/account', '/cart']) {
      assert.ok(html.includes(`'${p}'`), `${p} is not in ROUTES`);
    }
  });

  await check('the rewrite target is / and not /index.html', () => {
    // Rules only — the file's header comment explains this trap by naming it.
    const rules = redirects.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    assert.ok(!rules.some(l => /\/index\.html/.test(l)),
      'Workers html_handling turns a /index.html rewrite into a 307 that strips the path');
  });

  console.log('\n── the footer links resolve to real products ──');

  await check('every footer product href matches its own onclick slug', () => {
    const lis = html.match(/<a href="\/p\/([^"]+)" onclick="return gxProductLink\(event,'([^']+)'\)"/g) || [];
    assert.ok(lis.length >= 3, `found ${lis.length} product links, expected 3`);
    for (const li of lis) {
      const m = /href="\/p\/([^"]+)".*'([^']+)'/.exec(li);
      assert.strictEqual(m[1], m[2],
        `href says /p/${m[1]} but the click opens ${m[2]} — copy-link and click disagree`);
      assert.strictEqual(m[1], gxSlug(m[1]), `${m[1]} is not a well-formed slug`);
    }
  });

  await check('every footer product slug exists in the LIVE catalog', async () => {
    let pool;
    try { ({ pool } = require('./db')); } catch (e) { skip('backend/db not loadable'); }
    if (!process.env.DATABASE_URL && !process.env.PGHOST) {
      skip('no DATABASE_URL — run under `railway run` to check the footer against prod');
    }
    const { rows } = await pool.query(
      `SELECT name FROM products WHERE hidden = false AND guild_id = $1`, [process.env.GUILD_ID]);
    await pool.end();
    const known = new Set(rows.map(r => gxSlug(r.name)));
    assert.ok(known.size > 20, `only ${known.size} products came back — wrong guild?`);
    const linked = footerLinks();
    for (const s of linked) {
      assert.ok(known.has(s),
        `the footer links /p/${s} and no live product slugs to that — the label is not ` +
        `the name (e.g. "H8ED Mobile (BO7)" is really "H8ED MOBILE" on the BO7 tab)`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed ? 1 : 0);
})();
