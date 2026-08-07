// The SUPPLIER API tab in the admin panel, driven for real in a jsdom.
//
// index.html is public and hand-uploaded to a static host. Anyone can read it.
// That single fact decides most of what is worth asserting here:
//
//   * THE API KEY MUST NOT BE IN THIS FILE, and no code in it may ask for one.
//     A key here is a key anyone can spend, and the supplier's endpoint spends
//     money with a GET.
//   * THERE MUST BE NO "TEST THIS LINK" BUTTON. Their delivery call IS the
//     purchase — a test button is a purchase button with a friendlier label.
//   * "SWITCHED ON" AND "ACTUALLY BUYING" ARE DIFFERENT STATES. A link switched
//     on while the global kill switch is off is not buying anything, and a panel
//     that renders both as ON is lying to the person deciding whether the
//     incident is over.
//   * A TOGGLE SENDS THE VALUE IT MEANS, never a flip. Two admins on two stale
//     tabs both pressing "SWITCH OFF" would otherwise switch it back on.
//
//   npm install --no-save jsdom && node backend/test_supplier_panel.js
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('\nSKIP  test_supplier_panel — jsdom is not installed.');
  console.log('      npm install --no-save jsdom && node backend/test_supplier_panel.js\n');
  process.exit(0);
}

const STOREFRONT = process.env.STOREFRONT_HTML ||
  'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG/index.html';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// The real functions, lifted out of the real file. A re-implementation here
// would pass forever no matter what the page does.
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

// ── what the page contains, before anything is executed ──────────────────────
console.log('\nthe key is not in the file, and the file cannot ask for one');

check('no GANDY_API_KEY anywhere in the storefront', () => {
  assert.ok(!/GANDY_API_KEY\s*[:=]\s*['"][^'"]+['"]/.test(html),
    'a value is assigned to GANDY_API_KEY in a file the whole internet can read');
});

// Both halves of the tab: the markup an admin sees and the code behind it. The
// first version of these checks looked only at the JS, and a mutant that put a
// "TEST" button straight into the markup sailed through — the dangerous button
// is dangerous wherever it is written.
const PANEL_MARKUP = (() => {
  const a = html.indexOf('id="invPanel-supplier"');
  const b = html.indexOf('<!-- USERS TAB -->', a);
  assert.ok(a > -1 && b > a, 'the SUPPLIER API panel markup was not found');
  return html.slice(a, b);
})();
const PANEL_JS = (() => {
  const a = html.indexOf('var supState =');
  const b = html.indexOf('function supLoadDeliveries');
  assert.ok(a > -1 && b > a, 'the SUPPLIER API panel code was not found');
  return html.slice(a, html.indexOf('\n}', b) + 2);
})();
const PANEL = PANEL_MARKUP + '\n' + PANEL_JS;

check('the panel has no input for an API key', () => {
  // The temptation is real — "let me just paste it in the panel" — and it is
  // the one edit that would turn this page into a way to spend someone
  // else's money.
  assert.ok(!/id="sup(Api)?Key"/i.test(PANEL), 'there is an API key field on the panel');
  // The prose that NAMES the key (to say where it lives instead) is allowed;
  // anything else mentioning one is not.
  const prose = /GANDY_API_KEY on Railway|NO API KEY IS SET|no API key|a key here|key would be a key/gi;
  assert.ok(!/api[_ -]?key/i.test(PANEL.replace(prose, '')), 'the panel asks for an api key somewhere');
});

check('the panel never calls the supplier directly, and has no test button', () => {
  assert.ok(!/gandyreseller|\/deliver\//.test(PANEL),
    'the browser talks to the supplier itself — that needs the key in the page');
  // Their delivery call IS the purchase, so anything offering to "try" a link
  // is offering to spend money without saying so.
  //
  // Scoped to actual CONTROLS, not to any text containing "test": the panel
  // says out loud that there is no way to test a link without buying one, and
  // a check that cannot tell that sentence from a button is a check that will
  // be deleted the first time it cries wolf.
  const buttons = PANEL.match(/<button[\s\S]*?<\/button>/gi) || [];
  const offender = buttons.find(b => /test/i.test(b));
  assert.ok(!offender, 'there is a test button; a test against this API is a purchase: ' + String(offender).slice(0, 120));
  assert.ok(!/\bsup\w*[Tt]est\w*\s*\(/.test(PANEL), 'there is a test function behind the panel');
});

// ── the panel, executed ──────────────────────────────────────────────────────
// Lifted, not retyped — same rule as the functions. A copy of the state shape
// here would keep passing after the real one gained a field.
const SUP_STATE_LINE = (html.match(/^var supState = .*$/m) || [])[0];
assert.ok(SUP_STATE_LINE, 'supState declaration not found in index.html');

const SRC = [SUP_STATE_LINE].concat([
  'supEsc', 'supMoney', 'supWhen', 'supMsg',
  'supLoadAll', 'supRenderHeader', 'supToggleGlobal', 'supRenderLinks',
  'supFindLink', 'supViewLink', 'supToggleLink', 'supRemoveLink',
  'supProductsList', 'supFillGames', 'supCascadeGame', 'supCascadeProduct',
  'supResetForm', 'supEditLink', 'supSaveLink', 'supLoadDeliveries',
].map(n => extractFn(html, n))).join('\n');

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="supHeader"></div>
  <div id="supFormTitle"></div>
  <select id="supGame"></select><select id="supProduct"></select><select id="supTier"></select>
  <input id="supProductId"><input id="supCost"><input id="supQty"><input id="supLabel">
  <div id="supFormMsg"></div>
  <div id="supLinkList"></div>
  <select id="supDelivFilter"><option value="" selected></option></select>
  <div id="supDeliveryLog"></div>
</body></html>`, { url: 'https://uhservices.xyz/' });

const LIVE_KEY = 'live-key-must-never-reach-a-browser';

// Everything the panel talks to, recorded rather than performed.
const calls = [];        // { path, method, body }
const toasts = [];
const confirms = [];
const alerts = [];
let nextConfirm = true;
let linksReply;          // what GET /api/supplier/links answers with

const PRODUCTS = [{
  id: 10, game_name: 'Call of Duty: Warzone', name: '[BO7] Unlocker + Spoofer', hidden: false,
  tiers: [{ id: 401, label: 'Day', price_cents: 200, sort_order: 0 },
          { id: 402, label: 'Week', price_cents: 700, sort_order: 1 }],
}, {
  id: 11, game_name: 'ARC Raiders', name: 'ANC ARC Raiders', hidden: true,
  tiers: [{ id: 501, label: 'Day', price_cents: 500, sort_order: 0 }],
}];

const sandbox = {
  window: dom.window, document: dom.window.document, console,
  escapeHtmlPM: (s) => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  stockToast: (msg, good) => toasts.push({ msg, good }),
  confirm: (msg) => { confirms.push(msg); return nextConfirm; },
  alert: (msg) => alerts.push(msg),
  loadAdminProductIndex: async () => { dom.window._gxAdminProductList = PRODUCTS; },
  apiFetch: async (p, opts) => {
    opts = opts || {};
    calls.push({ path: p, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (p === '/api/supplier/links' && (opts.method || 'GET') === 'GET') return linksReply;
    if (p.indexOf('/api/supplier/deliveries') === 0) return { deliveries: DELIVERIES };
    if (p === '/api/supplier/kill') return { success: true, supplier_off: !!JSON.parse(opts.body).off, note: 'switched' };
    return { success: true };
  },
};
const DELIVERIES = [
  { id: 500, order_id: 'ord-1', supplier_product_id: '48', qty: 1, status: 'ok',
    buyer_ref: 'INV-1001', response_lines: ['UPSTREAM-KEY-AAAA'], error_text: null,
    cost_cents: 60, created_at: '2026-08-07T10:00:00Z' },
  { id: 501, order_id: 'ord-2', supplier_product_id: '48', qty: 1, status: 'timeout',
    buyer_ref: 'INV-1002', response_lines: null, error_text: 'timeout of 30000ms exceeded',
    cost_cents: 60, created_at: '2026-08-07T11:00:00Z' },
];
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);

const LINK = (over) => Object.assign({
  id: 1, tier_id: 401, supplier: 'gandy', supplier_product_id: '48',
  label: '[BO7] Unlocker + Spoofer - Day', cost_cents: 60, enabled: true, qty_per_unit: 1,
  last_ok_at: '2026-08-07T10:00:00Z', last_error: null, last_error_at: null,
  game_name: 'Call of Duty: Warzone', product_name: '[BO7] Unlocker + Spoofer',
  tier_label: 'Day', tier_price_cents: 200,
}, over || {});

const reply = (over) => Object.assign(
  { links: [LINK()], key_configured: true, supplier_off: false, migrated: true }, over || {});

const headerText = () => dom.window.document.getElementById('supHeader').textContent;
const listText = () => dom.window.document.getElementById('supLinkList').textContent;
const reset = () => { calls.length = 0; toasts.length = 0; confirms.length = 0; alerts.length = 0; nextConfirm = true; };

async function run() {
  console.log('\nthe header tells the truth about which of three states it is in');

  reset(); linksReply = reply();
  await sandbox.supLoadAll();
  await checkAsync('live: the switch offers to stop, and the link reads BUYING', () => {
    assert.match(headerText(), /SUPPLIER BUYING IS LIVE/);
    assert.ok(dom.window.document.getElementById('supHeader').innerHTML.includes('supToggleGlobal(true)'),
      'the button would switch it the wrong way');
    assert.match(listText(), /BUYING/);
  });

  reset(); linksReply = reply({ supplier_off: true });
  await sandbox.supLoadAll();
  await checkAsync('kill switch on: an ENABLED link says ON, BYPASSED — not ON', () => {
    assert.match(headerText(), /SUPPLIER BUYING IS OFF/);
    assert.match(listText(), /ON, BYPASSED/,
      'a link switched on during a kill-switch incident rendered as if it were buying');
  });

  reset(); linksReply = reply({ key_configured: false });
  await sandbox.supLoadAll();
  await checkAsync('no key configured is its OWN message, not "off"', () => {
    // "Off" and "broken" are one state to a customer and opposite states to
    // whoever is standing at this panel.
    assert.match(headerText(), /NO API KEY IS SET/);
    assert.match(headerText(), /Railway/, 'it should say where the key does live');
    assert.match(listText(), /ON, BYPASSED/, 'it claimed to be buying with no key set');
  });

  reset(); linksReply = reply({ migrated: false, links: [], notice: 'Run backend/migrations/supplier_links.sql' });
  await sandbox.supLoadAll();
  await checkAsync('a missing migration says so instead of showing an empty list', () => {
    assert.match(headerText(), /TABLES DO NOT EXIST YET/i);
    assert.match(headerText(), /supplier_links\.sql/);
  });

  console.log('\nthe switches');

  reset(); linksReply = reply();
  await sandbox.supLoadAll();
  reset();
  await sandbox.supToggleLink(1);
  await checkAsync('a per-link toggle sends the value it MEANS, not a flip', () => {
    const t = calls.find(c => /\/toggle$/.test(c.path));
    assert.ok(t, 'nothing was sent');
    assert.strictEqual(t.method, 'POST');
    assert.strictEqual(t.body.enabled, false,
      'it sent a flip — two stale tabs would switch it back on for each other');
  });

  await checkAsync('and then re-reads the list from the server', () =>
    assert.ok(calls.some(c => c.path === '/api/supplier/links' && c.method === 'GET'),
      'the panel repainted from what it hoped happened'));

  reset(); linksReply = reply();
  await sandbox.supLoadAll();
  reset(); nextConfirm = false;
  await sandbox.supToggleGlobal(true);
  await checkAsync('the global switch confirms before stopping the spending', () => {
    assert.strictEqual(calls.length, 0, 'it fired without asking');
    assert.match(confirms[0], /own key pool|Nothing is deleted/i,
      'the confirm should say what happens to the tiers, not just "are you sure"');
  });

  reset(); nextConfirm = true;
  await sandbox.supToggleGlobal(true);
  await checkAsync('confirmed, it posts off:true and repaints the header', () => {
    const k = calls.find(c => c.path === '/api/supplier/kill');
    assert.ok(k && k.body.off === true);
    assert.match(headerText(), /SUPPLIER BUYING IS OFF/);
  });

  console.log('\nremove');

  reset(); linksReply = reply();
  await sandbox.supLoadAll();
  reset(); nextConfirm = false;
  await sandbox.supRemoveLink(1);
  await checkAsync('remove confirms first, and names what it does NOT touch', () => {
    assert.ok(!calls.some(c => c.method === 'DELETE'), 'it deleted without asking');
    assert.match(confirms[0], /not its keys/i);
    assert.match(confirms[0], /already bought from them/i,
      'the purchase record is the only evidence a charge happened — say it survives');
  });

  reset(); nextConfirm = true;
  await sandbox.supRemoveLink(1);
  await checkAsync('confirmed, it DELETEs exactly that one link', () => {
    const d = calls.find(c => c.method === 'DELETE');
    assert.ok(d, 'nothing was deleted');
    assert.strictEqual(d.path, '/api/supplier/links/1');
  });

  console.log('\nthe form');

  reset(); linksReply = reply();
  await sandbox.supLoadAll();
  await checkAsync('the cascade offers every game, including a hidden product', () => {
    const games = Array.from(dom.window.document.getElementById('supGame').options).map(o => o.value);
    assert.deepStrictEqual(games, ['ARC Raiders', 'Call of Duty: Warzone']);
    dom.window.document.getElementById('supGame').value = 'ARC Raiders';
    sandbox.supCascadeGame();
    const prods = Array.from(dom.window.document.getElementById('supProduct').options).map(o => o.text);
    // Hiding a product from the storefront does not stop a direct link selling
    // its tiers, so a mapping for it is still a real mapping.
    assert.match(prods[0], /\(hidden\)/);
  });

  await checkAsync('an already-mapped tier is labelled as one', () => {
    dom.window.document.getElementById('supGame').value = 'Call of Duty: Warzone';
    sandbox.supCascadeGame(10);
    const tiers = Array.from(dom.window.document.getElementById('supTier').options).map(o => o.text);
    assert.match(tiers[0], /already mapped/, 'nothing warned that saving would overwrite');
    assert.ok(!/already mapped/.test(tiers[1]), 'an unmapped tier was marked as mapped');
  });

  reset();
  dom.window.document.getElementById('supProductId').value = '';
  await sandbox.supSaveLink();
  await checkAsync('a blank supplier product id is refused before it is sent', () => {
    assert.strictEqual(calls.length, 0, 'a mapping with no upstream id was posted');
    assert.match(dom.window.document.getElementById('supFormMsg').textContent, /product id is required/i);
  });

  reset();
  dom.window.document.getElementById('supProductId').value = '48';
  dom.window.document.getElementById('supCost').value = '$0.60';
  dom.window.document.getElementById('supQty').value = '1';
  await sandbox.supSaveLink();
  await checkAsync('a dollar cost is sent as cents, and the tier id comes from the cascade', () => {
    const p = calls.find(c => c.path === '/api/supplier/links' && c.method === 'POST');
    assert.ok(p, 'nothing was posted');
    assert.strictEqual(p.body.cost_cents, 60, 'the cost was sent in the wrong unit');
    assert.strictEqual(p.body.tier_id, 401);
    assert.strictEqual(p.body.supplier_product_id, '48');
  });

  reset(); linksReply = reply();
  await sandbox.supLoadAll();
  sandbox.supEditLink(1);
  await checkAsync('EDIT walks the cascade to the tier the mapping points at', () => {
    assert.strictEqual(dom.window.document.getElementById('supGame').value, 'Call of Duty: Warzone');
    assert.strictEqual(dom.window.document.getElementById('supTier').value, '401');
    assert.strictEqual(dom.window.document.getElementById('supProductId').value, '48');
    assert.strictEqual(dom.window.document.getElementById('supCost').value, '0.60');
  });

  console.log('\nwhat the numbers say');

  reset(); linksReply = reply({ links: [LINK({ cost_cents: 1200, tier_price_cents: 200 })] });
  await sandbox.supLoadAll();
  await checkAsync('a mapping that sells below cost says so in words', () =>
    assert.match(listText(), /YOU LOSE MONEY ON EVERY SALE/,
      'the usual sign of a mistyped product id is a cost that makes no sense for the tier'));

  reset(); linksReply = reply({ links: [LINK({ cost_cents: 60, qty_per_unit: 10, tier_price_cents: 200 })] });
  await sandbox.supLoadAll();
  await checkAsync('the margin counts EVERY key a sale buys, not one', () =>
    assert.match(listText(), /LOSE MONEY/,
      '10 keys at $0.60 against a $2.00 sale is a loss; a per-unit margin would call it profit'));

  reset(); linksReply = reply({ links: [LINK({ enabled: false })] });
  await sandbox.supLoadAll();
  await checkAsync('a switched-off link offers to switch ON', () => {
    assert.match(listText(), /OFF/);
    assert.ok(dom.window.document.getElementById('supLinkList').innerHTML.includes('SWITCH ON'));
  });

  console.log('\nthe purchase log');

  reset(); linksReply = reply();
  await sandbox.supLoadAll();
  // Awaited here rather than relying on supLoadAll: the page fires the log load
  // without waiting for it on purpose, so the links appear without blocking on
  // a second round trip.
  await sandbox.supLoadDeliveries();
  await checkAsync('an unanswered purchase is flagged as maybe-charged', () => {
    const log = dom.window.document.getElementById('supDeliveryLog').textContent;
    assert.match(log, /MAY HAVE BEEN CHARGED/,
      'a timeout rendered like any other failure — that row is the only trace of the money');
    assert.match(log, /UPSTREAM-KEY-AAAA/, 'the keys must be readable; re-issuing one is why the log exists');
  });

  await checkAsync('nothing the panel rendered contains an API key', () => {
    const blob = dom.window.document.body.innerHTML;
    assert.ok(!blob.includes(LIVE_KEY));
    assert.ok(!/[?&]key=[A-Za-z0-9_-]{8,}/.test(blob), 'a key= parameter with a real-looking value was rendered');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

run().catch(e => { console.error(e); process.exitCode = 1; });
