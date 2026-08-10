// A local flag must not outlive the thing it mirrors.
//
// The bug this pins, reported verbatim: "BLITZ AND ONTOP PRIVATE EXTERNAL ARE
// SHOWING IN WEBSITE ADMIN PANEL. BUT NOT IN THE ACTUAL WEBSITE."
//
// Neither product was hidden, deleted, out of stock or filtered by status.
// GET /api/products returned both — it filters `hidden = false` itself, and
// both rows are `hidden = false`. The admin grid showed both, because
// isProductHidden() consults _gxAdminProducts (the database) first. What hid
// them was `ghostCheatHidden`, a localStorage map in ONE browser, holding the
// leftovers of a 👁 Hide from days earlier. gtHideCheat writes that key before
// it calls the backend, and nothing in the un-hide path — not a re-import, not
// a PATCH, not a deploy — can reach into a browser to clear it.
//
// Two separate faults, both fixed and both pinned below:
//
//   1. The map was applied to the PUBLIC storefront. Hiding a product hid it
//      from whoever clicked the button and from nobody else. It must only
//      apply to the hardcoded fallback catalog, which is the one case where
//      there is no server answer to defer to.
//   2. The key survived a successful backend write. It is now deleted on
//      success, and gxVisibleCheats prunes any it finds for a product the
//      server is publishing — so an existing ghost self-heals on the next page
//      view rather than waiting for someone to clear site data.
//
// Runs the REAL functions lifted out of index.html. A re-typed copy would keep
// passing after the page changed, which is the failure mode this whole
// directory exists to avoid.
//
//   node test_storefront_hidden.js
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const STOREFRONT = process.env.STOREFRONT_HTML ||
  'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG/index.html';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok    ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); failed++; }
}

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

// The smallest world gxVisibleCheats needs: a localStorage that actually
// persists between calls (pruning is a WRITE, and a stub that swallowed it
// would make the self-heal check pass for the wrong reason) and a
// backendCatalog flag standing in for "the server answered".
function makeSandbox(stored, serverAnswered) {
  let raw = JSON.stringify(stored);
  const sandbox = {
    backendCatalog: serverAnswered ? { 'Call of Duty: Warzone': {} } : null,
    localStorage: {
      getItem: k => (k === 'ghostCheatHidden' ? raw : null),
      setItem: (k, v) => { if (k === 'ghostCheatHidden') raw = v; },
    },
    get stored() { return JSON.parse(raw); },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(html, 'gxVisibleCheats'), sandbox);
  return sandbox;
}

const COD = 'Call of Duty: Warzone';
const CHEATS = [
  { name: 'BLITZ EXTERNAL' },
  { name: 'ONTOP Private External' },
  { name: 'Orion External Bo7' },
];
const GHOSTS = {
  'Call of Duty: Warzone||BLITZ EXTERNAL': true,
  'Call of Duty: Warzone||ONTOP Private External': true,
};
const names = list => list.map(c => c.name);

console.log('\nthe reported bug');

check('a stale local flag cannot hide a product the server is publishing', () => {
  const s = makeSandbox(GHOSTS, true);
  const shown = s.gxVisibleCheats(COD, CHEATS);
  assert.deepStrictEqual(names(shown),
    ['BLITZ EXTERNAL', 'ONTOP Private External', 'Orion External Bo7'],
    'the storefront is still subtracting from the catalog the server filtered');
});

check('and the flag is pruned, so it cannot come back when the backend blinks', () => {
  // Without this, the ghost returns the first time /api/products is slow or
  // down and the hardcoded fallback catalog takes over — a bug that reappears
  // once a month and looks new every time.
  const s = makeSandbox(GHOSTS, true);
  s.gxVisibleCheats(COD, CHEATS);
  assert.deepStrictEqual(s.stored, {}, 'ghostCheatHidden still holds the dead keys');
});

check('an unrelated game\'s keys are left alone', () => {
  // Pruning is per product actually rendered. A blanket clear would silently
  // un-hide products in games this call never looked at.
  const s = makeSandbox(Object.assign({ 'Rust||Ghost Pro': true }, GHOSTS), true);
  s.gxVisibleCheats(COD, CHEATS);
  assert.deepStrictEqual(s.stored, { 'Rust||Ghost Pro': true });
});

console.log('\nthe offline fallback still has no other answer');

check('with no backend catalog, the local map is the only hide state there is', () => {
  const s = makeSandbox(GHOSTS, false);
  assert.deepStrictEqual(names(s.gxVisibleCheats(COD, CHEATS)), ['Orion External Bo7']);
});

check('and nothing is pruned in that mode', () => {
  const s = makeSandbox(GHOSTS, false);
  s.gxVisibleCheats(COD, CHEATS);
  assert.deepStrictEqual(s.stored, GHOSTS, 'the fallback threw away its own hide state');
});

console.log('\ndegenerate inputs');

check('a corrupt ghostCheatHidden does not empty the shop', () => {
  // JSON.parse throwing here used to take the whole modal with it. Failing
  // OPEN is right: the server already said what is publishable.
  const s = makeSandbox({}, false);
  s.localStorage.getItem = () => '{not json';
  assert.deepStrictEqual(names(s.gxVisibleCheats(COD, CHEATS)), names(CHEATS));
});

check('an empty or missing cheat list is not an error', () => {
  const s = makeSandbox(GHOSTS, true);
  // Length, not deepStrictEqual: an array the sandbox built is a different
  // realm's Array and would fail a strict comparison for a reason that has
  // nothing to do with the storefront.
  assert.strictEqual(s.gxVisibleCheats(COD, []).length, 0);
  assert.strictEqual(s.gxVisibleCheats(COD, undefined).length, 0);
});

console.log('\nno call site kept its own copy of the rule');

check('both storefront render paths go through gxVisibleCheats', () => {
  // The tabbed modal (GTA V) and the flat/CoD modal each carried their own
  // inline copy of the filter. Two copies of a visibility rule is how the
  // panel and the shop window came to disagree in the first place — so the
  // check is scoped to openModal and asks that NO copy remains there, rather
  // than counting occurrences file-wide (a count is a number somebody bumps).
  const src = extractFn(html, 'openModal');
  assert.ok(!/ghostCheatHidden/.test(src),
    'openModal reads the local hide map directly again');
  const calls = (src.match(/gxVisibleCheats\(/g) || []).length;
  assert.strictEqual(calls, 2, `openModal has ${calls} gxVisibleCheats call(s); the tabbed and the flat path each need one`);
});

check('gtHideCheat drops the local key once the backend has taken the change', () => {
  const src = extractFn(html, 'gtHideCheat');
  assert.ok(/if \(ok\)[^\n]*delete hm\[key\]/.test(src),
    'the local flag survives a successful write — this is the bug, again');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
