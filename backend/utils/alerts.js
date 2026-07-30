const { query } = require('../db');
const { notifyBot } = require('./botNotify');

const GUILD_ID = process.env.GUILD_ID;

// How long the same (kind, order) stays deduplicated. A recurring condition
// should produce ONE alert a human can act on, not one every heartbeat.
//
// This is not hypothetical: a false-positive `email_watcher_silent` fired every
// ~20 minutes for a day straight and buried the Discord channel. An alert that
// repeats forever trains everyone to ignore alerts, which is worse than not
// sending them.
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

// Records something a human needs to look at.
//
// notifyBot swallows its own failures by design (the bot may be restarting), so
// a Discord ping alone means an alert raised at the wrong moment is simply
// gone. The row is therefore the alert and the ping is the convenience — which
// matters most for the cases nobody is watching for: a paid order that could
// not be fulfilled, or a watcher that has stopped accepting payments.
async function raiseAlert(kind, message, { severity = 'warn', context = null, order_id = null } = {}) {
  console.error(`[Alert:${severity}] ${kind} — ${message}`);

  // Suppress a repeat of the same unresolved problem. Scoped by order where
  // there is one, so two different orders with the same fault both surface.
  // Acknowledging an alert clears the suppression: the next occurrence is new
  // information again.
  try {
    const { rows: recent } = await query(
      `SELECT id FROM ops_alerts
        WHERE kind = $1
          AND (guild_id = $2 OR guild_id IS NULL)
          AND (($3::text IS NULL AND order_id IS NULL) OR order_id = $3)
          AND acknowledged_at IS NULL
          AND created_at > now() - ($4 || ' milliseconds')::interval
        LIMIT 1`,
      [kind, GUILD_ID, order_id != null ? String(order_id) : null, String(DEDUPE_WINDOW_MS)]
    );
    if (recent.length) {
      console.warn(`[Alert] '${kind}' already open and unacknowledged — not re-notifying`);
      return;
    }
  } catch (err) {
    // A dedupe failure must not swallow the alert itself.
    console.error('[Alert] Dedupe check failed, sending anyway:', err.message);
  }

  await query(
    `INSERT INTO ops_alerts (guild_id, kind, severity, message, context, order_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [GUILD_ID, kind, severity, message, context ? JSON.stringify(context) : null,
     order_id != null ? String(order_id) : null]
  ).catch(err => console.error('[Alert] Could not persist alert:', err.message));

  await notifyBot('ops_alert', { kind, severity, message, context, order_id: order_id != null ? String(order_id) : null });
}

module.exports = { raiseAlert };
