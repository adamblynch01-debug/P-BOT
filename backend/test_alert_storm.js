// Regression tests for the alert storm seen in production on 2026-07-26:
// `email_watcher_silent` fired every ~20 minutes for a full day, every one
// carrying "failCount: 0" — i.e. the watcher had never actually failed. Two
// separate defects produced it, and a third sent those alerts to the wrong
// Discord channel.
//
//   node test_alert_storm.js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

// ─── Stub the DB so raiseAlert can be exercised offline ──
let alertRows = [];
let notified = [];
const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (text, params) => {
      const t = text.replace(/\s+/g, ' ').trim();
      if (/SELECT id FROM ops_alerts/.test(t)) {
        const [kind, , orderId] = [params[0], params[1], params[2]];
        const hit = alertRows.find(r =>
          r.kind === kind &&
          String(r.order_id) === String(orderId) &&
          !r.acknowledged_at);
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (/INSERT INTO ops_alerts/.test(t)) {
        alertRows.push({
          id: alertRows.length + 1, guild_id: params[0], kind: params[1],
          severity: params[2], message: params[3], order_id: params[5],
          acknowledged_at: null,
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
    withTransaction: async (fn) => fn(async () => ({ rows: [] })),
    pool: {},
  },
};
const notifyPath = require.resolve('./utils/botNotify');
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { notifyBot: async (event, data) => { notified.push({ event, data }); return { ok: true }; } },
};

process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';
const { raiseAlert } = require('./utils/alerts');

(async () => {
  console.log('\nalert dedupe (the storm)');

  alertRows = []; notified = [];
  for (let i = 0; i < 20; i++) {
    await raiseAlert('email_watcher_silent', 'no IMAP activity', { severity: 'error' });
  }
  check('20 identical alerts produce ONE row', () => assert.strictEqual(alertRows.length, 1));
  check('20 identical alerts produce ONE Discord ping', () => assert.strictEqual(notified.length, 1));

  // A different problem must still get through.
  await raiseAlert('delivery_incomplete', 'order 5 paid but unfulfilled', { severity: 'error', order_id: 5 });
  check('a DIFFERENT alert kind is not suppressed', () => assert.strictEqual(alertRows.length, 2));

  // Same kind, different order = genuinely different problem.
  await raiseAlert('delivery_incomplete', 'order 6 paid but unfulfilled', { severity: 'error', order_id: 6 });
  check('same kind on a different order is not suppressed', () => assert.strictEqual(alertRows.length, 3));

  // Repeat of an order-scoped alert is suppressed.
  await raiseAlert('delivery_incomplete', 'order 6 again', { severity: 'error', order_id: 6 });
  check('a repeat for the SAME order is suppressed', () => assert.strictEqual(alertRows.length, 3));

  // Acknowledging re-arms it: the next occurrence is new information.
  alertRows.find(r => String(r.order_id) === '6').acknowledged_at = new Date();
  await raiseAlert('delivery_incomplete', 'order 6 recurred', { severity: 'error', order_id: 6 });
  check('after acknowledgement the same alert can fire again', () => assert.strictEqual(alertRows.length, 4));

  // ─── The false positive itself ────────────────────────
  console.log('\nemail watcher liveness is probed, not assumed');

  const src = fs.readFileSync(path.join(__dirname, 'watchers', 'emailWatcher.js'), 'utf8');
  check('the heartbeat actively probes the connection', () => {
    assert.ok(/probeConnection/.test(src), 'no probeConnection');
    assert.ok(/imapClient\.status\(/.test(src), 'probe does not query the mailbox');
  });
  check('a successful probe clears the alarm', () => {
    assert.ok(/const healthy = await probeConnection\(\)[\s\S]{0,200}deadAlertSent = false/.test(src));
  });
  check('the probe cannot hang the heartbeat forever', () => {
    assert.ok(/setTimeout\(\(\) => done\(false\), \d+\)/.test(src));
  });
  check('an idle mailbox alone no longer triggers the alert', () => {
    // The old code alerted purely on elapsed time since the last inbound mail.
    // There must now be a health gate ahead of that comparison.
    const heartbeat = src.slice(src.indexOf('function startHeartbeat'), src.indexOf('function probeConnection'));
    assert.ok(/if \(healthy\)/.test(heartbeat), 'no health gate before the silence check');
  });

  // ─── Channel misrouting ───────────────────────────────
  console.log('\norder/alert traffic does not fall back to the anti-scam channel');

  const botEvents = 'C:/Users/VENOM-NODE/Downloads/SUPERBOT-main/modules/internalEvents.js';
  if (fs.existsSync(botEvents)) {
    const bot = fs.readFileSync(botEvents, 'utf8');
    const chains = bot.slice(bot.indexOf('const ordersChannel'), bot.indexOf('async function dmOwner'));
    check('LOG_CHANNEL_ID is not an order/alert fallback', () => {
      assert.ok(!/LOG_CHANNEL_ID/.test(chains),
        'LOG_CHANNEL_ID (the anti-scam moderation log) is still in the fallback chain');
    });
    check('ORDER_LOG_CHANNEL_ID is read from the environment', () => {
      assert.ok(/process\.env\.ORDER_LOG_CHANNEL_ID/.test(bot));
    });
    check('alerts get their own channel ahead of the order log', () => {
      const alertChain = bot.slice(bot.indexOf('const alertsChannel'), bot.indexOf('async function dmOwner'));
      const alertsIdx = alertChain.indexOf('ALERTS_CHANNEL_ID');
      const orderIdx = alertChain.indexOf('getLogChannelId');
      assert.ok(alertsIdx >= 0, 'ALERTS_CHANNEL_ID is not consulted');
      assert.ok(alertsIdx < orderIdx, 'the order log is checked before the alerts channel');
    });
  } else {
    console.log('  SKIP  bot repo not found at the expected path');
  }

  // ─── Railway is the only source for the order log channel ──
  // The owner sets ORDER_LOG_CHANNEL_ID directly in Railway. A `config` table
  // row for it would override the env var at boot — the same trap that made
  // three PANEL_PASSWORD rotations silently fail.
  console.log('\nORDER_LOG_CHANNEL_ID cannot be overridden from the database');

  const cfgSrc = fs.readFileSync(path.join(__dirname, 'routes', 'config.js'), 'utf8');
  check('the backend refuses to store ORDER_LOG_CHANNEL_ID', () => {
    const m = cfgSrc.match(/const ENV_ONLY_KEYS = \[([^\]]*)\]/);
    assert.ok(m, 'ENV_ONLY_KEYS not found');
    assert.ok(/ORDER_LOG_CHANNEL_ID/.test(m[1]), 'ORDER_LOG_CHANNEL_ID is not env-only');
  });
  check('env-only keys are also skipped when loading config from the DB', () => {
    assert.ok(/ENV_ONLY_KEYS\.includes\(row\.key\)/.test(cfgSrc),
      'loadConfigFromDB does not skip env-only keys');
  });
  if (fs.existsSync('C:/Users/VENOM-NODE/Downloads/SUPERBOT-main/index.js')) {
    const botIdx = fs.readFileSync('C:/Users/VENOM-NODE/Downloads/SUPERBOT-main/index.js', 'utf8');
    check('/config set no longer offers logchan', () => {
      assert.ok(!/\{ name: '.*Order Log Channel ID', value: 'logchan' \}/.test(botIdx),
        'logchan is still selectable in /config set');
      assert.ok(!/logchan:\s*\{ key: 'ORDER_LOG_CHANNEL_ID'/.test(botIdx),
        'logchan still maps to a writable config key');
    });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
})();
