// Post-turn-up read: did the round trip land the row it was supposed to, and
// only that row? A sign-in that LOOKS right in the UI and quietly created a
// second account would present identically until the balance went missing.
const { pool } = require('./db');
(async () => {
  const { rows } = await pool.query(
    `SELECT id, username, email, google_email, password_hash IS NULL AS passwordless,
            totp_enabled, email_2fa_enabled, discord_verified, created_at
       FROM web_users WHERE guild_id = $1 ORDER BY id`, [process.env.GUILD_ID]);
  console.log(`${rows.length} accounts\n`);
  for (const r of rows) {
    console.log(`  #${r.id} ${String(r.username).padEnd(16)} ${String(r.email || '-').padEnd(28)}` +
      ` google=${r.google_email || '—'}` +
      `${r.passwordless ? '  [no password]' : ''}` +
      `  2fa:${[r.totp_enabled && 'totp', r.email_2fa_enabled && 'email', r.discord_verified && 'discord'].filter(Boolean).join('+') || 'none'}`);
  }
  // The whole point of matching on sub is that one Google identity maps to one
  // account. Two rows sharing an address means the email leg ran twice.
  const { rows: dupes } = await pool.query(
    `SELECT lower(email) AS e, count(*)::int AS n FROM web_users
      WHERE guild_id = $1 AND email IS NOT NULL GROUP BY 1 HAVING count(*) > 1`, [process.env.GUILD_ID]);
  console.log(dupes.length ? '\nDUPLICATE EMAILS: ' + JSON.stringify(dupes)
                           : '\nno duplicate emails — the link matched an existing account rather than creating one');
  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
