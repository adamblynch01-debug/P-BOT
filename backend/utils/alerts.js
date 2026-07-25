const { query } = require('../db');
const { notifyBot } = require('./botNotify');

const GUILD_ID = process.env.GUILD_ID;

// Records something a human needs to look at.
//
// notifyBot swallows its own failures by design (the bot may be restarting), so
// a Discord ping alone means an alert raised at the wrong moment is simply
// gone. The row is therefore the alert and the ping is the convenience — which
// matters most for the cases nobody is watching for: a paid order that could
// not be fulfilled, or a watcher that has stopped accepting payments.
async function raiseAlert(kind, message, { severity = 'warn', context = null, order_id = null } = {}) {
  console.error(`[Alert:${severity}] ${kind} — ${message}`);

  await query(
    `INSERT INTO ops_alerts (guild_id, kind, severity, message, context, order_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [GUILD_ID, kind, severity, message, context ? JSON.stringify(context) : null,
     order_id != null ? String(order_id) : null]
  ).catch(err => console.error('[Alert] Could not persist alert:', err.message));

  await notifyBot('ops_alert', { kind, severity, message, context, order_id: order_id != null ? String(order_id) : null });
}

module.exports = { raiseAlert };
