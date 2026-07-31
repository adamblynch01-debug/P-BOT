// The Discord invite, resolved once for everything the server sends out.
//
// The storefront already reads this from app_state under the global key
// `ghostDiscordInvite`, which is what the admin panel's "Discord Invite" field
// writes. The receipt needs the same URL, and hardcoding a second copy here is
// exactly the failure round 11 fixed for the store name: the admin changes the
// invite, the site follows, and the emails keep pointing at a dead link
// forever with nothing to indicate they disagree.
//
// Order of authority: the environment (an operator override that does not need
// the panel), then the panel's own value, then the known invite as a last
// resort so a receipt never renders a button that goes nowhere.
'use strict';

const { query } = require('../db');

const GUILD_ID = process.env.GUILD_ID;
const FALLBACK = 'https://discord.gg/uhservices';
const TTL_MS = 5 * 60 * 1000;

let cached = null;
let cachedAt = 0;

function normalize(url) {
  const v = String(url || '').trim();
  if (!v) return null;
  // A panel value saved as "discord.gg/x" is what a person naturally types; an
  // href without a scheme is resolved relative to the current page, which in an
  // email client means nowhere.
  const withScheme = /^https?:\/\//i.test(v) ? v : 'https://' + v.replace(/^\/+/, '');
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function discordInvite() {
  const fromEnv = normalize(process.env.DISCORD_INVITE_URL);
  if (fromEnv) return fromEnv;

  if (cached && Date.now() - cachedAt < TTL_MS) return cached;

  let value = null;
  try {
    const { rows } = await query(
      `SELECT value FROM app_state
        WHERE guild_id = $1 AND scope = 'global' AND owner_id = '' AND key = 'ghostDiscordInvite'`,
      [GUILD_ID]
    );
    // The column holds whatever the panel put there — a bare JSON string for
    // this key, but an object for others, so anything that is not a string is
    // not an invite.
    const raw = rows.length ? rows[0].value : null;
    value = typeof raw === 'string' ? raw : null;
  } catch (err) {
    console.warn('[Links] Could not read the Discord invite from app_state:', err.message);
  }

  cached = normalize(value) || FALLBACK;
  cachedAt = Date.now();
  return cached;
}

module.exports = { discordInvite, __test__: { normalize, FALLBACK } };
