// Transaction-boundary regression tests.
//
// The money paths were runs of independent query() calls, so a failure partway
// through left money half-moved: a wallet debited for an order still marked
// `waiting`, or a ledger credit with no matching balance. These tests pin the
// BEGIN/COMMIT/ROLLBACK behaviour of the helper and of the top-up path that
// uses it.
//
// Loads the real modules against a fake pg pool that records the exact
// statement sequence, so "did this roll back?" is observable rather than
// assumed.

const path = require('path');
const BACKEND = __dirname;

process.env.GUILD_ID = 'g1';

// ─── fake pg pool ────────────────────────────────────────
// Records every statement in order, across the whole run.
const SQL = [];
let RELEASED = 0;
let HANDLERS = [];
let ROLLBACK_THROWS = false;

function respond(sql, params) {
  for (const h of HANDLERS) {
    if (h.match.test(sql)) return h.fn(sql, params);
  }
  return { rows: [], rowCount: 0 };
}

const fakeClient = {
  query: async (sql, params) => {
    SQL.push(sql.trim().split('\n')[0].trim());
    if (/^ROLLBACK/.test(sql) && ROLLBACK_THROWS) throw new Error('connection is dead');
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    return respond(sql, params);
  },
  release: () => { RELEASED++; },
};

const poolStub = {
  connect: async () => fakeClient,
  query: async (sql, params) => {
    SQL.push(sql.trim().split('\n')[0].trim());
    return respond(sql, params);
  },
  on: () => {},
};

require.cache[require.resolve('pg', { paths: [BACKEND] })] = {
  id: 'pg', filename: 'pg', loaded: true,
  exports: { Pool: function () { return poolStub; } },
};

const { withTransaction } = require(path.join(BACKEND, 'db.js'));

// Alerts captured at the source.
const ALERTS = [];
const alertsPath = require.resolve(path.join(BACKEND, 'utils', 'alerts.js'));
const realAlerts = require(alertsPath);
require.cache[alertsPath].exports = {
  ...realAlerts,
  raiseAlert: async (kind, message, opts) => { ALERTS.push({ kind, message, opts }); },
};

// Delivery reaches out over the network on success; stub those so the tests
// exercise the DB boundary only.
require.cache[require.resolve('axios', { paths: [BACKEND] })] = {
  id: 'axios', filename: 'axios', loaded: true,
  exports: { get: async () => ({ data: {} }), post: async () => ({ data: {} }) },
};

const { deliver } = require(path.join(BACKEND, 'utils', 'delivery.js'));

// ─── harness ─────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}
function reset() {
  SQL.length = 0; ALERTS.length = 0; RELEASED = 0;
  HANDLERS = []; ROLLBACK_THROWS = false;
}
const saw = (re) => SQL.some(s => re.test(s));

(async () => {
  console.log('\n── withTransaction ──');

  reset();
  {
    const out = await withTransaction(async (exec) => {
      await exec('SELECT 1');
      return 'value';
    });
    ok(out === 'value', 'returns the callback value');
    ok(SQL[0] === 'BEGIN' && SQL[SQL.length - 1] === 'COMMIT',
      'wraps the work in BEGIN … COMMIT');
    ok(!saw(/^ROLLBACK/), 'does not roll back on success');
    ok(RELEASED === 1, 'releases the client');
  }

  reset();
  {
    let threw = null;
    try {
      await withTransaction(async (exec) => {
        await exec('UPDATE balances SET x = 1');
        throw new Error('boom');
      });
    } catch (e) { threw = e; }
    ok(threw && threw.message === 'boom', 'rethrows the callback error');
    ok(saw(/^ROLLBACK/) && !saw(/^COMMIT/), 'rolls back and never commits');
    ok(RELEASED === 1, 'releases the client on failure too');
  }

  reset();
  ROLLBACK_THROWS = true;
  {
    let threw = null;
    try {
      await withTransaction(async () => { throw new Error('original failure'); });
    } catch (e) { threw = e; }
    // A rollback that throws must not replace the error that caused it —
    // otherwise the logs report a dead connection instead of the real bug.
    ok(threw && threw.message === 'original failure',
      'a failing ROLLBACK does not mask the original error');
    ok(RELEASED === 1, 'client is still released when ROLLBACK throws');
  }

  reset();
  {
    // Statement errors (a constraint violation) must surface with their code
    // intact so callers can branch on 23505.
    HANDLERS = [{ match: /INSERT INTO transactions/, fn: () => {
      const e = new Error('duplicate key'); e.code = '23505'; throw e;
    } }];
    let threw = null;
    try {
      await withTransaction(async (exec) => { await exec('INSERT INTO transactions ...'); });
    } catch (e) { threw = e; }
    ok(threw && threw.code === '23505', 'preserves the postgres error code');
    ok(saw(/^ROLLBACK/), 'rolls back on a statement error');
  }

  console.log('\n── balance top-up is atomic ──');

  const topupOrder = () => ({
    id: 501, guild_id: 'g1', web_user_id: 77, email: 'a@b.c',
    items_snapshot: JSON.stringify([{ id: 'balance-topup', price: 25, qty: 1 }]),
  });

  reset();
  {
    HANDLERS = [
      { match: /INSERT INTO transactions/, fn: () => ({ rows: [], rowCount: 1 }) },
      { match: /UPDATE balances/, fn: () => ({ rows: [], rowCount: 1 }) },
    ];
    await deliver(topupOrder());
    ok(saw(/^BEGIN/) && saw(/^COMMIT/), 'a good top-up commits');
    ok(!saw(/^ROLLBACK/), 'and does not roll back');
    const order = SQL.filter(s => /^(BEGIN|INSERT INTO transactions|UPDATE balances|COMMIT)/.test(s));
    ok(/^BEGIN/.test(order[0]) && /INSERT INTO transactions/.test(order[1]) &&
       /UPDATE balances/.test(order[2]) && /^COMMIT/.test(order[3]),
      'ledger row is written before the balance moves, inside one transaction');
  }

  reset();
  {
    // No balances row for the user. Previously the credit row was already
    // committed by then, leaving a ledger entry with no money behind it.
    HANDLERS = [
      { match: /INSERT INTO transactions/, fn: () => ({ rows: [], rowCount: 1 }) },
      { match: /UPDATE balances/, fn: () => ({ rows: [], rowCount: 0 }) },
    ];
    await deliver(topupOrder());
    ok(saw(/^ROLLBACK/) && !saw(/^COMMIT/),
      'a missing wallet rolls the credit back instead of orphaning it');
    ok(ALERTS.some(a => a.kind === 'topup_credit_lost'), 'and raises topup_credit_lost');
  }

  reset();
  {
    // Duplicate delivery. The unique index is the guard; it must still be
    // recognised now that the INSERT runs inside a transaction.
    HANDLERS = [{ match: /INSERT INTO transactions/, fn: () => {
      const e = new Error('duplicate key value'); e.code = '23505'; throw e;
    } }];
    await deliver(topupOrder());
    ok(ALERTS.some(a => a.kind === 'duplicate_topup_credit'),
      'a second credit for the same order is still blocked');
    ok(saw(/^ROLLBACK/) && !saw(/^COMMIT/), 'and nothing is committed');
    ok(!saw(/UPDATE balances/), 'the balance is never touched on a duplicate');
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
