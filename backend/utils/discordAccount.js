// Getting a site account out of a Discord identity.
//
// Two callers, and they must produce the same row or the customer ends up with
// two half-accounts:
//
//   routes/auth.js    SIGN IN WITH DISCORD, when the consent names a snowflake
//                     we have never seen
//   routes/orders.js  a claim proven by the Discord account ON the order, for a
//                     buyer who has never visited the site
//
// See migrations/discord_signup.sql for why the row carries no email and no
// password. Neither is a gap to be filled with a placeholder — Discord is the
// credential, and both columns say so by being NULL.
'use strict';

const crypto = require('crypto');
const { query, withTransaction } = require('../db');

const GUILD_ID = process.env.GUILD_ID;

// A username that is not already taken. First try is the bare seed; after that
// a suffix, and the last few attempts use randomness rather than a counter,
// because a counter walks straight into whatever another request is claiming at
// the same moment.
async function freeUsername(seed) {
  for (let i = 0; i < 25; i++) {
    const candidate = i === 0 ? seed
      : i < 20 ? `${seed}${i + 1}`
      : `${seed}_${crypto.randomBytes(3).toString('hex')}`;
    const { rows } = await query(
      'SELECT 1 FROM web_users WHERE guild_id = $1 AND lower(username) = lower($2)',
      [GUILD_ID, candidate]
    );
    if (!rows.length) return candidate;
  }
  return `user_${crypto.randomBytes(6).toString('hex')}`;
}

// Discord names are far more permissive than ours — spaces, emoji, and the
// whole of Unicode. Strip to what a username here may hold and fall back to
// something sayable rather than to '' or a lone '.', either of which is what an
// all-emoji display name reduces to.
function discordUsernameSeed(name) {
  const s = String(name || '').trim()
    .replace(/[^a-zA-Z0-9 _.-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 24);
  return /[a-zA-Z0-9]/.test(s) ? s : 'member';
}

// The account for a Discord user, creating it if there is none.
//
// `discordId` must already be PROVEN — an OAuth consent, or the id written on
// an order by staff. This function does not verify anything; it writes
// discord_verified = true on the strength of the caller having done so, which
// is the same contract POST /api/auth/confirm-discord works under.
//
// Returns { user, created }. `user` carries balance_cents like every other
// account lookup, so callers can hand it straight to publicUser().
async function ensureDiscordAccount({ discordId, username, avatarHash }) {
  const id = String(discordId).trim();
  if (!id) throw new Error('ensureDiscordAccount: no discord id');

  const find = async () => {
    const { rows } = await query(
      `SELECT u.*, b.balance_cents FROM web_users u
       LEFT JOIN balances b ON b.web_user_id = u.id
       WHERE u.guild_id = $1 AND u.discord_id = $2 AND u.discord_verified = true`,
      [GUILD_ID, id]
    );
    return rows[0] || null;
  };

  const existing = await find();
  if (existing) return { user: existing, created: false };

  const name = await freeUsername(discordUsernameSeed(username));
  try {
    const user = await withTransaction(async (exec) => {
      const { rows } = await exec(
        `INSERT INTO web_users (guild_id, username, discord_id, discord_verified, discord_avatar, last_login_at)
         VALUES ($1,$2,$3,true,$4, now()) RETURNING *`,
        [GUILD_ID, name, id, avatarHash || null]
      );
      // Every other account gets a wallet row at signup; one created here
      // without it would fault the first time it was credited.
      await exec('INSERT INTO balances (web_user_id, guild_id, balance_cents) VALUES ($1,$2,0)',
        [rows[0].id, GUILD_ID]);
      return { ...rows[0], balance_cents: 0 };
    });
    return { user, created: true };
  } catch (err) {
    // 23505 = another request created it in the milliseconds since the lookup
    // above, or took the username. uniq_web_users_discord is the index that
    // makes the first case impossible to get wrong; whoever won, the row they
    // made is the right one to use.
    if (err.code !== '23505') throw err;
    const again = await find();
    if (!again) throw err;
    return { user: again, created: false };
  }
}

module.exports = { ensureDiscordAccount, freeUsername, discordUsernameSeed };
