// The storefront half of SIGN IN WITH GOOGLE.
//
// The backend suite (test_google_oauth.js) proves the redirect never carries a
// session token. That guarantee is only worth as much as the page that catches
// it, and this page has no build step and no runner — the only other way to
// find a bug in it is for the owner to upload, look, and report.
//
// So the functions are lifted straight out of index.html by brace matching (no
// copy — a copy would drift and then test itself) and driven against jsdom.
//
// What it protects:
//   * every google_* param is stripped from the URL, on EVERY branch. A claim
//     left in the address bar survives into history and the next Referer.
//   * a ?google_2fa= return opens the second-factor prompt and does NOT try to
//     trade it for a session — the whole point of that branch is that Google
//     did not finish the job.
//   * a claim is POSTed, never GET'd, and exactly once.
//   * the buttons stay hidden until GET /oauth-config says google:true, and a
//     backend that cannot be reached hides them rather than showing a button
//     that only errors.
//   * a passwordless account is never asked for a password.
//
//   npm install --no-save jsdom && node backend/test_storefront_google.js
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const STOREFRONT = process.env.STOREFRONT_HTML ||
  'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG/index.html';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// Same extractor as test_storefront_tiles.js: one top-level `function name(`
// through its matching brace, taking a leading `async` with it.
function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found in ${path.basename(STOREFRONT)}`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const html = fs.readFileSync(STOREFRONT, 'utf8');
const SRC = ['gxLoadOAuthConfig', 'startGoogleOAuth', 'handleGoogleOAuthReturn', 'reauthPromptText']
  .map(n => extractFn(html, n)).join('\n');

// A miniature of the auth modal: the two places a Google button is drawn.
const MARKUP = `<!DOCTYPE html><body>
  <div class="auth-form active" id="authForm-login">
    <button class="auth-btn gx-google-btn" id="googleLoginBtn" style="display:none;">SIGN IN WITH GOOGLE</button>
  </div>
  <div class="auth-form" id="authForm-signup">
    <div id="googleSignupWrap" style="display:none;"><button class="auth-btn gx-google-btn">SIGN UP WITH GOOGLE</button></div>
  </div>
  <button class="profile-nav-btn">Security</button>
</body>`;

// One page load. `search` is what the backend bounced us back with.
function load(search, opts) {
  opts = opts || {};
  const dom = new JSDOM(MARKUP, { url: 'https://uhservices.xyz/' + (search || '') });
  const calls = {
    alerts: [], toasts: [], sections: [], profileSections: [], panelMsgs: [],
    fetches: [], twofa: [], finalized: [], navigated: null,
  };
  const ctx = vm.createContext({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    console,
    URLSearchParams: dom.window.URLSearchParams,
    Array, Object, JSON, String, Number, Boolean, Math, Promise, Error, setTimeout, clearTimeout,
    PAYMENT_BACKEND: 'https://backend.invalid',
    ghostAuthToken: 'sess-token',
    alert: (m) => calls.alerts.push(m),
    showAuthToast: (m) => calls.toasts.push(m),
    openSection: (s) => calls.sections.push(s),
    switchProfileSection: (s) => calls.profileSections.push(s),
    secGoogleMsgAfterRender: (t, c) => calls.panelMsgs.push({ t, c }),
    start2FAMethod: (m) => calls.twofa.push(m),
    mergeCurrentUserFromBackend: (u) => Object.assign({}, u),
    finalizeLogin: (u) => calls.finalized.push(u),
    fetch: async (url, init) => {
      calls.fetches.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
      if (/oauth-config/.test(url)) {
        if (opts.configFails) throw new Error('backend unreachable');
        return { ok: true, json: async () => opts.config || { discord: true, google: true } };
      }
      if (/google-oauth\/claim/.test(url)) {
        if (opts.claimFails) return { ok: false, json: async () => ({ error: 'That sign-in link has expired. Please try again.' }) };
        return { ok: true, json: async () => ({ success: true, token: 'real-session-token', user: { id: '9', username: 'newcomer', email: 'newcomer@gmail.com' } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  // The two module-level 2FA globals the return handler writes into, and the
  // status the reauth prompt reads.
  vm.runInContext('var _2fa_challengeId = null; var _2fa_challengeMethods = []; var _gxOAuthConfig = null; var _gxSecStatus = null;\n' + SRC, ctx);
  return { dom, ctx, calls, search: () => dom.window.location.search };
}

// Both error branches show their message on a 100ms timer (the modal has to
// finish opening first), so anything shorter than that reads as "no alert".
const settle = () => new Promise(r => setTimeout(r, 200));

// vm boundaries: an array built inside the context has that context's
// Array.prototype, which deepStrictEqual counts as a different type.
const plain = (v) => JSON.parse(JSON.stringify(v));

(async () => {
  console.log('\n── extraction ──');
  await check('the Google layer exists in index.html and lifts cleanly', () => {
    assert.ok(SRC.length > 1500, 'suspiciously small extraction');
    const { ctx } = load('');
    assert.strictEqual(typeof ctx.handleGoogleOAuthReturn, 'function');
    assert.strictEqual(typeof ctx.gxLoadOAuthConfig, 'function');
  });

  console.log('\n── the buttons are inert until the backend says otherwise ──');
  await check('google:true reveals both buttons', async () => {
    const { ctx, dom } = load('');
    await vm.runInContext('gxLoadOAuthConfig()', ctx);
    assert.notStrictEqual(dom.window.document.getElementById('googleLoginBtn').style.display, 'none');
    assert.strictEqual(dom.window.document.getElementById('googleSignupWrap').style.display, 'block');
  });

  await check('google:false leaves them hidden', async () => {
    const { ctx, dom } = load('', { config: { discord: true, google: false } });
    await vm.runInContext('gxLoadOAuthConfig()', ctx);
    assert.strictEqual(dom.window.document.getElementById('googleLoginBtn').style.display, 'none',
      'a button that is always drawn sits there erroring until the owner sets the env vars');
    assert.strictEqual(dom.window.document.getElementById('googleSignupWrap').style.display, 'none');
  });

  await check('an unreachable backend hides them too', async () => {
    const { ctx, dom } = load('', { configFails: true });
    await vm.runInContext('gxLoadOAuthConfig()', ctx);
    assert.strictEqual(dom.window.document.getElementById('googleLoginBtn').style.display, 'none',
      'failing open would offer a sign-in method that cannot work');
  });

  await check('the start URL carries a return_to and no credentials', () => {
    // jsdom's location.href is not configurable and assigning it is "not
    // implemented", so this one branch runs against a plain stand-in.
    const loc = { origin: 'https://uhservices.xyz', pathname: '/', href: '' };
    const ctx = vm.createContext({
      location: loc, window: { location: loc },
      PAYMENT_BACKEND: 'https://backend.invalid',
      ghostAuthToken: 'sess-token', encodeURIComponent,
    });
    vm.runInContext(extractFn(html, 'startGoogleOAuth') + '\nstartGoogleOAuth()', ctx);
    const went = loc.href;
    assert.ok(went.startsWith('https://backend.invalid/api/auth/google-oauth/start?'), 'got ' + went);
    assert.strictEqual(new URL(went).searchParams.get('return_to'), 'https://uhservices.xyz/');
    assert.ok(!went.includes('sess-token'), 'the session token went to Google in a query string');
  });

  console.log('\n── a clean page is left alone ──');
  await check('no google params means no fetch, no alert, no history rewrite', async () => {
    const { ctx, calls, search } = load('?tab=store');
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await settle();
    assert.strictEqual(calls.fetches.length, 0);
    assert.strictEqual(calls.alerts.length, 0);
    assert.strictEqual(search(), '?tab=store', 'an unrelated query string was rewritten');
  });

  console.log('\n── the claim ──');
  await check('a claim is POSTed once and traded for a session', async () => {
    const { ctx, calls } = load('?google_login=' + 'a'.repeat(64));
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await settle();
    const posts = calls.fetches.filter(f => /google-oauth\/claim/.test(f.url));
    assert.strictEqual(posts.length, 1, `${posts.length} claim requests`);
    assert.strictEqual(posts[0].method, 'POST',
      'a GET would put the claim in the backend access log the redirect was designed to keep it out of');
    assert.strictEqual(JSON.parse(posts[0].body).claim, 'a'.repeat(64));
    assert.strictEqual(calls.finalized.length, 1, 'the session was never handed to finalizeLogin');
    assert.strictEqual(calls.finalized[0]._authToken, 'real-session-token');
  });

  await check('the claim is stripped from the URL BEFORE it is spent', async () => {
    const { ctx, search } = load('?google_login=' + 'b'.repeat(64) + '&google_new=1');
    const p = vm.runInContext('handleGoogleOAuthReturn()', ctx);
    // Not awaited yet: the strip must not be waiting on a network round trip
    // that can hang or fail.
    assert.ok(!search().includes('b'.repeat(64)),
      'the claim is still in the address bar while the request is in flight: ' + search());
    await p; await settle();
    assert.strictEqual(search(), '', 'got ' + search());
  });

  await check('an unrelated query string survives the strip', async () => {
    const { ctx, search } = load('?ref=twitter&google_login=' + 'c'.repeat(64));
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await settle();
    assert.strictEqual(search(), '?ref=twitter', 'got ' + search());
  });

  await check('a new account is told it has no password', async () => {
    const { ctx, calls } = load('?google_login=' + 'd'.repeat(64) + '&google_new=1');
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await new Promise(r => setTimeout(r, 1600));
    assert.ok(calls.toasts.some(t => /password/i.test(t)),
      'they find out the next time they try to type one');
  });

  await check('a returning account is not told that', async () => {
    const { ctx, calls } = load('?google_login=' + 'e'.repeat(64));
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await new Promise(r => setTimeout(r, 1600));
    assert.ok(!calls.toasts.some(t => /set a password/i.test(t)));
  });

  await check('an expired claim shows the reason and mints no session', async () => {
    const { ctx, calls, search } = load('?google_login=' + 'f'.repeat(64), { claimFails: true });
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await settle();
    assert.strictEqual(calls.finalized.length, 0, 'logged in on a failed claim');
    assert.ok(calls.alerts.some(a => /expired/i.test(a)), 'got ' + JSON.stringify(calls.alerts));
    assert.strictEqual(search(), '', 'the dead claim was left in the URL');
  });

  console.log('\n── the second factor is not skipped ──');
  await check('a 2FA return opens the prompt and does NOT claim', async () => {
    const { ctx, calls, search } = load('?google_2fa=chal123&google_2fa_methods=totp,email');
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await settle();
    assert.strictEqual(calls.fetches.filter(f => /claim/.test(f.url)).length, 0,
      'the challenge id was traded as if it were a session — that IS the 2FA bypass');
    assert.strictEqual(calls.finalized.length, 0, 'a session was created before the second factor');
    assert.deepStrictEqual(calls.twofa, ['totp']);
    assert.strictEqual(vm.runInContext('_2fa_challengeId', ctx), 'chal123');
    assert.deepStrictEqual(plain(vm.runInContext('_2fa_challengeMethods', ctx)), ['totp', 'email'],
      'the modal offers the other methods off this list');
    assert.strictEqual(search(), '', 'the challenge id was left in the URL');
  });

  await check('the preference order is authenticator, then Discord, then email', async () => {
    const a = load('?google_2fa=c1&google_2fa_methods=discord,email');
    await vm.runInContext('handleGoogleOAuthReturn()', a.ctx); await settle();
    assert.deepStrictEqual(a.calls.twofa, ['discord']);
    const b = load('?google_2fa=c2&google_2fa_methods=email');
    await vm.runInContext('handleGoogleOAuthReturn()', b.ctx); await settle();
    assert.deepStrictEqual(b.calls.twofa, ['email']);
  });

  await check('a 2FA return with no method list still opens something', async () => {
    const { ctx, calls } = load('?google_2fa=c3');
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await settle();
    assert.strictEqual(calls.twofa.length, 1, 'the login would dead-end with no prompt at all');
  });

  console.log('\n── errors and the link round-trip ──');
  await check('a login error is shown and the param cleared', async () => {
    const { ctx, calls, search } = load('?google_login_error=' + encodeURIComponent('That Google account\'s email address is not verified with Google, so it cannot be used to sign in.'));
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await settle();
    assert.ok(calls.alerts.some(a => /not verified/.test(a)), 'got ' + JSON.stringify(calls.alerts));
    assert.strictEqual(calls.sections[0], 'auth', 'the modal has to be open to read the error against');
    assert.strictEqual(search(), '');
  });

  await check('a link return lands back on Security, not the home page', async () => {
    const { ctx, calls, search } = load('?google_link=ok');
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await new Promise(r => setTimeout(r, 450));
    assert.deepStrictEqual(calls.sections, ['profile']);
    assert.deepStrictEqual(calls.profileSections, ['security']);
    assert.ok(calls.panelMsgs.some(m => /linked/i.test(m.t)), 'no confirmation was shown');
    assert.strictEqual(calls.finalized.length, 0, 'a link round-trip must not mint a session');
    assert.strictEqual(search(), '');
  });

  await check('a link error is shown in the panel, in red', async () => {
    const { ctx, calls } = load('?google_link_error=' + encodeURIComponent('That Google account is already linked to another site account.'));
    await vm.runInContext('handleGoogleOAuthReturn()', ctx);
    await new Promise(r => setTimeout(r, 450));
    const m = calls.panelMsgs[0];
    assert.ok(m && /already linked/.test(m.t), 'got ' + JSON.stringify(calls.panelMsgs));
    assert.strictEqual(m.c, '#ef4444');
  });

  console.log('\n── a passwordless account is never asked for a password ──');
  await check('the prompt follows what the account actually has', () => {
    const { ctx } = load('');
    const ask = (status) => {
      vm.runInContext('_gxSecStatus = ' + JSON.stringify(status), ctx);
      return vm.runInContext('reauthPromptText("confirm")', ctx);
    };
    assert.match(ask({ has_password: true, enabled: true }), /password/i);
    assert.match(ask({ has_password: false, enabled: true }), /authenticator/i,
      'a Google-only account cannot supply a password — this is the box that made 2FA a one-way door');
    assert.match(ask({ has_password: false, enabled: false, email_2fa_enabled: true }), /emailed/i);
    assert.match(ask(null), /password/i, 'no status read yet: the old behaviour is the safe default');
  });

  console.log('\n── the page and the backend agree on the param names ──');
  await check('every param the backend bounces is handled here', () => {
    const routes = fs.readFileSync(path.join(__dirname, 'routes', 'auth.js'), 'utf8');
    const block = routes.slice(routes.indexOf("router.get('/google-oauth/callback'"),
                               routes.indexOf("router.post('/google-oauth/claim'"));
    const emitted = new Set((block.match(/google_[a-z0-9_]+(?=:)/g) || []));
    emitted.add('google_2fa_methods');
    const handler = extractFn(html, 'handleGoogleOAuthReturn');
    for (const p of emitted) {
      assert.ok(handler.includes(p), `the backend sends ?${p}= and the page never reads it`);
    }
    assert.ok(emitted.size >= 5, `only found ${emitted.size} params — the slice missed the callback`);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
