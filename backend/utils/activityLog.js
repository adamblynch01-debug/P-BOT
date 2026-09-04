'use strict';

const db = require('../db');

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

async function logActivity({ guildId, userId, eventType, req, metadata } = {}) {
  const type = clean(eventType, 80);
  if (!type) return;
  try {
    await db.query(
      `INSERT INTO user_activity
         (guild_id, user_id, event_type, ip_address, user_agent, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [clean(guildId || process.env.GUILD_ID, 80) || 'unknown', Number(userId) || null, type,
        clean(req?.ip || req?.headers?.['x-forwarded-for'] || '', 64) || null,
        clean(req?.headers?.['user-agent'] || '', 500) || null,
        JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {})]
    );
  } catch (error) {
    // Activity logging must never make an otherwise valid login fail while a
    // rollout is waiting for the migration to be applied.
    if (error.code !== '42P01' && error.code !== '42703') console.warn('[Activity] log failed:', error.message);
  }
}

module.exports = { logActivity };
