'use strict';

// Audit trail for privileged account actions — see migrations/admin_log.sql.
//
// Deliberately best-effort: a logging failure must never turn a successful ban
// into a 500 for the admin who just performed it. It logs loudly to the
// console when the insert fails so a missing table surfaces in the Railway log
// rather than passing as "no admin actions happened".

const { query } = require('../db');

const GUILD_ID = process.env.GUILD_ID;

async function logAdminAction(req, action, targetWebUserId, detail) {
  try {
    const actor = req && req.user;
    await query(
      `INSERT INTO admin_log (guild_id, actor_web_user_id, actor_username, action, target_web_user_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        GUILD_ID,
        actor && actor.id ? actor.id : null,
        (actor && actor.username) || 'bot',
        action,
        targetWebUserId != null ? String(targetWebUserId) : null,
        JSON.stringify(detail || {}),
      ]
    );
  } catch (err) {
    console.error(`[AdminLog] FAILED to record ${action}:`, err.message);
  }
}

module.exports = { logAdminAction };
