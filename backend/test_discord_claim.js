// Round 29 item 6: "If user has not made an account and no email found. Have it
// register with their discord account then. So they can redeem. So order can be
// looked up by user also!!"
//
// Three things had to become true, and each one is a separate way for this to
// silently stop working again:
//
//   1. an account can exist with NO email          (web_users.email nullable)
//   2. a claim can be proven with NO email         (resolveClaim, orders.js)
//   3. proving one attaches the order AND the rest (POST /api/orders/claim)
//
// The failure this replaces was quiet in both directions: the OAuth callback
// handed an unknown Discord user a decoy pending_id that never verifies (so the
// page said "check your DMs" for a DM nobody sent), and the claim form demanded
// an address that a hand-delivered order does not have.
//
//   node backend/test_discord_claim.js            (static + unit)
//   railway run node backend/test_discord_claim.js --live   (adds the prod check)
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BOT = process.env.SUPERBOT_DIR || 'C:/Users/VENOM-NODE/Downloads/SUPERBOT-main';
const SITE = process.env.STOREFRONT_DIR
  || 'C:/Users/VENOM-NODE/Documents/GHOSTEXE FINAL/UHSERVICES OG';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const read = p => fs.readFileSync(p, 'utf8');

// The text from `start` up to whichever of `enders` comes next. Regexes with a
// {0,N} window are what a growing comment silently breaks — the block stops
// matching, the assertion inside it never runs, and the test goes green for a
// feature that is gone. An explicit end marker cannot rot that way.
function blockFrom(src, start, ...enders) {
  const i = src.indexOf(start);
  assert.ok(i > -1, `not found in source: ${start}`);
  let end = src.length;
  for (const e of enders) {
    const j = src.indexOf(e, i + start.length);
    if (j > -1 && j < end) end = j;
  }
  return src.slice(i, end);
}
const ordersSrc  = read(path.join(__dirname, 'routes', 'orders.js'));
const authSrc    = read(path.join(__dirname, 'routes', 'auth.js'));
const acctSrc    = read(path.join(__dirname, 'utils', 'discordAccount.js'));
const migSrc     = read(path.join(__dirname, 'migrations', 'discord_signup.sql'));
const botSrc     = read(path.join(BOT, 'index.js'));
const twofaSrc   = read(path.join(BOT, 'modules', 'auth2fa.js'));
// The hand-delivery path is two files now: manualDelivery.js still writes the
// staff-facing strings, but the buyer's DM was lifted into deliveryEmbed.js so
// a website order and a hand-delivered one stop drifting apart. The claim copy
// lives in whichever of the two writes it, so both are searched as one.
const manualSrc  = read(path.join(BOT, 'modules', 'manualDelivery.js'))
                 + read(path.join(BOT, 'modules', 'deliveryEmbed.js'));
const htmlSrc    = read(path.join(SITE, 'index.html'));

// The real module, not a copy. It requires ../db, which builds a Pool lazily —
// nothing here connects.
const { discordUsernameSeed } = require('./utils/discordAccount');

console.log('\n── a Discord display name becomes a username this site can hold ──');

// Discord allows spaces, emoji and the whole of Unicode; web_users.username is
// rendered into the page and matched case-insensitively against a unique index.
const SEEDS = [
  ['GHOST.EXE420',       'GHOST.EXE420',   'an already-legal name is left alone'],
  ['GHOST EXE 420',      'GHOST_EXE_420',  'spaces become underscores, not nothing'],
  ['  padded  ',         'padded',         'the trim happens before the collapse'],
  ['👻👻👻',              'member',         'an all-emoji name reduces to "" — not a username'],
  ['...',                'member',         'and a name of only punctuation reduces to "."'],
  ['a'.repeat(80),       'a'.repeat(24),   'a long name is cut to 24, the column is not the limit'],
  ['nota fridge™.007',   'nota_fridge.007', 'a trademark sign is dropped, the legal parts survive'],
  ['',                   'member',         'no name at all'],
  [null,                 'member',         'and no name field at all'],
];
for (const [input, want, what] of SEEDS) {
  check(what, () => assert.strictEqual(discordUsernameSeed(input), want));
}

check('the seed can never be empty or non-alphanumeric', () => {
  // Whatever comes back is going through `SELECT … lower(username) = lower($2)`
  // and then into an INSERT. '' would take the unique slot for every emoji-only
  // name at once.
  for (const [input] of SEEDS) {
    const s = discordUsernameSeed(input);
    assert.ok(s.length > 0 && /[a-zA-Z0-9]/.test(s), `"${input}" produced "${s}"`);
    assert.ok(!/[^a-zA-Z0-9_.-]/.test(s), `"${s}" still holds a character usernames may not`);
  }
});

console.log('\n── an account with no email, and nothing pretending otherwise ──');

check('the migration drops NOT NULL rather than inventing an address', () => {
  assert.match(migSrc, /ALTER TABLE web_users ALTER COLUMN email DROP NOT NULL/);
  // A synthesised `<snowflake>@discord.local` would be indexed by UNIQUE
  // (guild_id, email), offered back on the account page as "your email", and
  // handed to the receipt mailer. It reads to every later query as an address
  // that simply does not receive.
  assert.ok(!/discord\.local|@placeholder|noreply@/i.test(migSrc.replace(/^--.*$/gm, '')),
    'the migration synthesises a placeholder address somewhere');
});

check('ensureDiscordAccount inserts no email and no password', () => {
  const insert = /INSERT INTO web_users \(([^)]*)\)/.exec(acctSrc);
  assert.ok(insert, 'no INSERT INTO web_users found');
  const cols = insert[1].split(',').map(s => s.trim());
  assert.ok(!cols.includes('email'), 'the signup writes an email column');
  assert.ok(!cols.includes('password_hash'), 'the signup writes a password_hash');
  assert.ok(cols.includes('discord_verified'), 'the signup does not mark the link verified');
});

check('a new account gets a wallet row like every other signup', () => {
  // Every other account gets one at signup; one created here without it would
  // fault the first time it was credited.
  assert.match(acctSrc, /INSERT INTO balances \(web_user_id, guild_id, balance_cents\)/,
    'no balances row is created alongside the account');
  assert.match(acctSrc, /withTransaction/,
    'the account and its wallet are not written in one transaction');
});

check('a lost race re-reads rather than throwing', () => {
  // 23505 = another request created the row (or took the username) in the
  // milliseconds since the lookup. Whoever won, the row they made is the one to
  // use — the alternative is "Discord login failed" for a login that worked.
  assert.match(acctSrc, /err\.code !== '23505'/, 'a unique violation is not caught');
  assert.match(acctSrc, /const again = await find\(\)/, 'the catch does not re-read');
});

check('both signup paths call the same function', () => {
  // Two writers of one account shape is how a customer ends up with two
  // half-accounts — one from the OAuth button, one from the claim.
  assert.match(authSrc, /require\('\.\.\/utils\/discordAccount'\)/,
    'routes/auth.js does not use the shared helper');
  assert.match(ordersSrc, /require\('\.\.\/utils\/discordAccount'\)/,
    'routes/orders.js does not use the shared helper');
  assert.ok(!/INSERT INTO web_users/.test(ordersSrc),
    'routes/orders.js writes a web_users row of its own');
  // auth.js still inserts for the password and Google signups; what it must not
  // do is insert a SECOND kind of Discord one.
  const discordInserts = (authSrc.match(/INSERT INTO web_users[\s\S]{0,300}?discord_verified/g) || []);
  assert.strictEqual(discordInserts.length, 0,
    'routes/auth.js still creates a discord-verified row directly');
});

console.log('\n── the OAuth button signs UP, not just in ──');

check('an unknown snowflake no longer gets a decoy', () => {
  // The bug: the callback looked for an already-linked row and, finding none,
  // returned a pending_id that never verifies. The customer was told to check
  // their DMs and waited for a DM that was never sent.
  assert.match(authSrc, /ensureDiscordAccount\(\{[\s\S]{0,200}?discordId/,
    'the Discord callback does not create an account');
  assert.match(authSrc, /discord_new/, 'the callback does not tell the page it created one');
});

check('the DM step is kept for a brand new account', () => {
  // Every delivery this store makes is a DM, so an account that cannot receive
  // one cannot receive a purchase either. Failing at sign-up — where the message
  // names the privacy setting — beats failing with an order waiting.
  assert.match(authSrc, /const \{ pending_id, dmError \} = await beginDiscordLogin\(discordId\)/,
    'the callback skips the DM verification for a new account');
  assert.match(authSrc, /if \(dmError\) return fail\(dmError\)/,
    'a failed DM is swallowed on the OAuth path');
});

check('the typed-id path still cannot be used to probe who has an account', () => {
  // beginDiscordLogin returns an opaque pending_id for unknown and banned
  // accounts alike. Surfacing the DM error there would reveal that the typed id
  // HAS one; on the OAuth path it cannot, because consent already proved who is
  // asking. So the error is RETURNED and the caller decides.
  assert.match(authSrc, /decoy: true, dmError/,
    'beginDiscordLogin does not return the DM error as a decoy for the caller to judge');
  const typed = blockFrom(authSrc, "router.post('/discord-login/initiate'", '\nrouter.');
  assert.ok(!/dmError/.test(typed),
    'the typed-id route surfaces the DM error — that is an account-enumeration oracle');
  assert.match(typed, /decoy pending_id/,
    'the uniform-response comment is gone; check the response is still uniform');
});

check('the storefront picks up ?discord_new and says the right thing', () => {
  assert.match(htmlSrc, /params\.get\('discord_new'\) === '1'/,
    'the page ignores discord_new');
  assert.match(htmlSrc, /'discord_new'\]\.forEach\(k => params\.delete\(k\)\)/,
    'discord_new is left sitting in the address bar');
  assert.match(htmlSrc, /function showDiscordLoginModal\(isNew\)/,
    'the modal cannot distinguish a signup from a login');
  assert.match(htmlSrc, /SIGN IN \/ SIGN UP WITH DISCORD/,
    'the login button still says LOGIN, which reads as "you need an account already"');
  assert.match(htmlSrc, /SIGN UP WITH DISCORD/,
    'the signup form has no Discord button');
});

console.log('\n── the DM can name an account that has no address ──');

check('initiate-2fa takes a label, not an email', () => {
  // web_users.email is nullable now. This endpoint used to 400 without one, so
  // a Discord signup\'s very first login failed here and reached the customer as
  // "Discord login failed" with the real reason only in the logs.
  assert.match(twofaSrc, /const \{ email, discordId, account_label \} = req\.body/,
    'initiate-2fa does not accept account_label');
  assert.match(twofaSrc, /if \(!discordId \|\| !label\)/,
    'initiate-2fa still hard-requires an email');
  assert.ok(!/Email and discordId are required/.test(twofaSrc),
    'the old email-required refusal is still there');
});

check('every backend caller sends a label', () => {
  const calls = authSrc.match(/initiate-2fa`[\s\S]{0,700}?\n\s*\}\);/g) || [];
  assert.ok(calls.length >= 3, `expected 3 initiate-2fa call sites, found ${calls.length}`);
  for (const c of calls) {
    assert.match(c, /account_label:/, `an initiate-2fa call sends no account_label:\n${c}`);
    assert.match(c, /\|\| `@\$\{/, 'the label does not fall back to the username');
  }
});

check('the DM never displays a fabricated address', () => {
  assert.ok(!/value: email\b/.test(twofaSrc), 'the DM embed still prints the raw email field');
  assert.match(twofaSrc, /email: email \|\| null/,
    'the pending session coerces a missing email into something truthy');
});

console.log('\n── one ownership rule, two routes ──');

const VERIFY = blockFrom(ordersSrc, "router.post('/verify-claim'", '\nrouter.', '\n// ───');
const CLAIM  = blockFrom(ordersSrc, "router.post('/claim'", '\nrouter.', '\n// ───');
const RESOLVE = blockFrom(ordersSrc, 'async function resolveClaim(', '\n// ───');
const MINE   = blockFrom(ordersSrc, "router.get('/mine'", '\nrouter.', '\n// ───');

check('verify-claim and claim both go through resolveClaim', () => {
  assert.match(VERIFY, /await resolveClaim\(/, 'verify-claim re-implements the rule');
  assert.match(CLAIM,  /await resolveClaim\(/, 'claim re-implements the rule');
  // The thing that grants the role and the thing that hands over the order
  // history must not be able to disagree.
  assert.ok(!/ownsByDiscord =/.test(VERIFY) && !/ownsByDiscord =/.test(CLAIM),
    'a route computes ownership itself instead of reading the resolver');
});

check('an invoice number alone proves nothing', () => {
  assert.match(RESOLVE, /proven: emailMatch \|\| ownsByDiscord \|\| ownsByAccount/,
    'the proof set is not the three named ones');
  // Invoice numbers get screenshotted into tickets and pasted into chats.
  // An order with no email, no discord_id and no web_user_id is claimable by
  // nobody, and that is deliberate.
  assert.ok(!/proven: true/.test(RESOLVE), 'resolveClaim can return proven unconditionally');
  // Each proof is checked against something the claimer had to HAVE, not
  // against the order alone.
  assert.match(RESOLVE, /ownsByDiscord = !!claimer && !!order\.discord_id && String\(order\.discord_id\) === claimer/,
    'the Discord proof does not compare the order against the claimer');
  assert.match(RESOLVE, /discord_verified = true/,
    'the account proof accepts an unverified Discord link');
});

check('email is optional but identity is not', () => {
  assert.match(CLAIM, /if \(!discord_id\) return res\.status\(400\)/,
    '/claim runs without knowing who is claiming — there is no account to attach to');
  assert.ok(!/!email\b[\s\S]{0,40}status\(400\)/.test(CLAIM),
    '/claim still refuses a claim with no email');
  assert.match(VERIFY, /if \(!email && !discord_id\)/,
    'verify-claim accepts a bare order_id with nothing to check it against');
});

console.log('\n── attaching, which is the "looked up by user also" half ──');

check('nothing is created before the claim is proven', () => {
  const refuse = CLAIM.indexOf('if (!c.proven || !c.paid)');
  const create = CLAIM.indexOf('ensureDiscordAccount');
  assert.ok(refuse > -1 && create > -1, 'the refusal or the creation is missing');
  assert.ok(refuse < create,
    'an account is created before ownership is checked — a failed claim would leave an orphan');
});

check('an order that already has an owner is never moved', () => {
  const updates = CLAIM.match(/UPDATE orders SET[\s\S]*?RETURNING id/g) || [];
  assert.strictEqual(updates.length, 2, `expected 2 attach statements, found ${updates.length}`);
  for (const u of updates) {
    assert.match(u, /web_user_id IS NULL/,
      `an attach can overwrite an existing owner:\n${u}`);
    assert.match(u, /guild_id = \$/, `an attach is not scoped to the guild:\n${u}`);
  }
});

check('the sweep keys on the Discord account, never on a typed address', () => {
  // The bot checked that this snowflake is the member standing in front of it,
  // so it is proof of an account the claimer CONTROLS. A typed address is proof
  // of a string they KNOW — sweeping on that would let anyone holding one
  // invoice-and-email pair collect a stranger's whole history.
  const sweep = /UPDATE orders SET web_user_id = \$1\s*\n\s*WHERE guild_id[\s\S]*?RETURNING id/.exec(CLAIM);
  assert.ok(sweep, 'no sibling sweep found');
  assert.match(sweep[0], /discord_id = \$3/, 'the sweep is not keyed on discord_id');
  assert.ok(!/email/i.test(sweep[0]), 'the sweep matches on an email address');
});

check('GET /mine finds an order attached by discord_id alone', () => {
  assert.match(MINE, /web_user_id = \$2 OR \(\$3::text IS NOT NULL AND discord_id = \$3\)/,
    'GET /mine still only matches web_user_id');
  // An unverified discord_id is a number somebody typed into a form. Only a
  // link proven by OAuth consent or a clicked DM may widen a customer's view.
  assert.match(MINE, /req\.user\.discord_id && req\.user\.discord_verified/,
    'GET /mine widens on an unverified discord_id');
  assert.match(MINE, /guild_id = \$1/, 'GET /mine is not scoped to the guild');
});

check('both sweeps have an index to run on', () => {
  // Both run interactively while a customer waits on a Discord reply.
  assert.match(migSrc, /CREATE INDEX IF NOT EXISTS idx_orders_guild_discord[\s\S]*?\(guild_id, discord_id\)/);
  // lower(), because an address is matched case-insensitively everywhere it is
  // matched at all — a plain index on `email` would not be usable by that
  // comparison.
  assert.match(migSrc, /idx_orders_guild_email_lower[\s\S]*?\(guild_id, lower\(email\)\)/);
});

console.log('\n── the bot: an order with no address is claimable again ──');

check('the email field is optional on both claim paths', () => {
  assert.match(botSrc, /o\.setName\('email'\)[\s\S]{0,200}?\.setRequired\(false\)/,
    '/claim-customer still requires an email option');
  const modal = blockFrom(botSrc, "setCustomId('claim_email')", '.setMaxLength');
  assert.match(modal, /\.setRequired\(false\)/, 'the modal email field is still required');
});

check('required slash options still precede the optional ones', () => {
  // Discord rejects the whole command definition otherwise, and the failure is
  // at registration — every command in the batch goes with it.
  const cmd = /setName\('claim-customer'\)[\s\S]*?\.addUserOption[\s\S]{0,200}?\),/.exec(botSrc)[0];
  const reqs = [...cmd.matchAll(/setRequired\((true|false)\)/g)].map(m => m[1]);
  assert.deepStrictEqual(reqs, ['true', 'false', 'false'],
    `option ordering is ${reqs.join(',')} — required must come first`);
});

check('both claim paths post to /claim, not /verify-claim', () => {
  // verify-claim only answers. A claim that only answered is what left the
  // order unattached and the buyer with nothing to open.
  assert.match(botSrc, /async function claimOrderFor\(member, order_id, email\)/,
    'there is no shared claim helper in the bot');
  assert.match(botSrc, /\/api\/orders\/claim`/, 'the bot never calls the claim route');
  assert.ok(!/orders\/verify-claim/.test(botSrc),
    'a claim path still calls verify-claim, so the order it verifies is never attached');
  assert.strictEqual((botSrc.match(/claimOrderFor\(/g) || []).length, 3,
    'expected the helper plus exactly two call sites');
});

check('the staff path claims for the TARGET, not the caller', () => {
  // Otherwise staff granting on someone\'s behalf would verify themselves, and
  // the order would be attached to the wrong account entirely.
  assert.match(botSrc, /claimOrderFor\(targetMember, order_id, email\)/,
    '/claim-customer claims against the caller');
  assert.match(botSrc, /claimOrderFor\(interaction\.member, order_id, email\)/,
    'the panel modal does not claim for the member who opened it');
});

check('the role is added only after the order is attached', () => {
  // A backend failure must never leave a member holding a role for an order
  // that was not attached.
  for (const block of [
    blockFrom(botSrc, "if (cmd === 'claim-customer')", '\n      // ──'),
    blockFrom(botSrc, "interaction.customId === 'claim_customer_modal'", '\n      // '),
  ]) {
    assert.ok(block.indexOf('claimOrderFor') < block.indexOf('grantCustomerRole'),
      'the role is granted before the claim is made');
    assert.match(block, /if \(!v\.success\)/, 'a refused claim still reaches the role grant');
  }
});

check('the refusal says something true for an order with no address', () => {
  // "That email does not match" is nonsense advice for an order that has no
  // email to match against, and it is exactly what the customer used to be told.
  assert.match(botSrc, /function claimRefusal\(v, order_id, extra = ''\)/,
    'there is no shared refusal message');
  assert.match(botSrc, /if \(!v\.has_email\)/,
    'the refusal does not distinguish an order with no address on it');
  assert.match(ordersSrc, /has_email: c\.hasEmail/, 'the backend never reports has_email');
});

check('the success reply names the account and the order count', () => {
  // The point of the item: the order stops being a loose invoice number and
  // starts being something they can open.
  assert.match(botSrc, /v\.account_created/, 'the reply never mentions the new account');
  assert.match(botSrc, /v\.orders_attached/, 'the reply never says how many orders came across');
  assert.match(ordersSrc, /account_created: created/, 'the backend does not report the creation');
  assert.match(ordersSrc, /orders_attached: attached\.size/, 'the backend does not count what it attached');
});

check('manual delivery no longer tells the buyer they cannot claim', () => {
  // The DM, the staff log line and the staff summary all used to say an order
  // with no email was unclaimable. All three were true and are now wrong.
  assert.ok(!/claim-customer.{0,30}will not work/i.test(manualSrc),
    'the staff log still says /claim-customer will not work');
  assert.ok(!/cannot verify it/.test(manualSrc),
    'the staff summary still says the order cannot be verified');
  assert.match(manualSrc, /leave the email blank/,
    'the buyer DM does not tell them to leave the email blank');
});

console.log('\n── the storefront copes with an account that has no address ──');

check('the profile page does not print the word "null"', () => {
  assert.ok(!/class="profile-email">\$\{currentUser\.email\}/.test(htmlSrc),
    'the profile card interpolates a possibly-null email bare');
  assert.match(htmlSrc, /No email on file/, 'nothing prompts an addressless account to add one');
  assert.ok(!/id="editEmail" value="\$\{currentUser\.email\}"/.test(htmlSrc),
    'the edit field interpolates a possibly-null email bare');
});

check('email 2FA is not offered to an account with no address', () => {
  // sendLoginCode() returns false on a missing recipient rather than throwing,
  // so the customer would press ENABLE, be told a code was sent, and wait.
  assert.match(htmlSrc, /There is no email address on this account, so there is nowhere to send a code/,
    'the security panel offers email 2FA with no address to send to');
});

check('saving a profile with no email is not refused', () => {
  // The whole page — avatar, username, password — was unsaveable for a Discord
  // signup, over a field they were never given.
  assert.match(authSrc, /if \(!nextEmail && req\.user\.email\)/,
    'PATCH /profile still refuses an empty email outright');
  // '' would be an address as far as UNIQUE (guild_id, email) is concerned, so
  // the second addressless account to save would collide with the first.
  assert.match(authSrc, /\(String\(email\)\.trim\(\) \|\| null\)/,
    'an empty email is stored as an empty string rather than NULL');
  // An address already on file is the account-recovery pivot; blanking it
  // silently is how someone gets locked out.
  assert.match(authSrc, /error: 'Email cannot be empty'/,
    'an existing address can now be blanked');
});

const live = process.argv.includes('--live');
const done = () => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
};

if (!live) { console.log('\n(skipping the prod check — pass --live under `railway run`)'); return done(); }

console.log('\n── against the live database ──');
const { query, pool } = require('./db');
const GUILD_ID = process.env.GUILD_ID;

(async () => {
  // Read-only. Nothing here creates an account or attaches an order — those
  // happen when a real customer claims, and a test that did them would leave
  // a fake member's row in production.
  const { rows: col } = await query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'web_users' AND column_name = 'email'`);
  check('the migration has been applied', () => {
    assert.ok(col[0], 'web_users.email does not exist');
    assert.strictEqual(col[0].is_nullable, 'YES',
      'email is still NOT NULL — every Discord signup will fault, and the customer sees "Discord login failed"');
  });

  const { rows: idx } = await query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'orders'
       AND indexname IN ('idx_orders_guild_discord', 'idx_orders_guild_email_lower')`);
  check('both claim sweeps have their index', () => {
    const have = idx.map(r => r.indexname).sort();
    assert.deepStrictEqual(have,
      ['idx_orders_guild_discord', 'idx_orders_guild_email_lower'],
      `only ${have.join(', ') || 'none'} exist`);
  });

  const { rows: [n] } = await query(
    `SELECT
       count(*) FILTER (WHERE web_user_id IS NULL) AS unowned,
       count(*) FILTER (WHERE web_user_id IS NULL AND email IS NULL AND discord_id IS NOT NULL) AS unblocked,
       count(*) FILTER (WHERE web_user_id IS NULL AND email IS NULL AND discord_id IS NULL) AS unclaimable
     FROM orders WHERE guild_id = $1 AND status IN ('paid','delivered')`, [GUILD_ID]);
  check('the orders this item unblocks are real', () => {
    console.log(`        ${n.unowned} paid orders sit on no account; ${n.unblocked} of those had`);
    console.log(`        no address and are claimable by Discord for the first time.`);
    // Not an assertion about the count — it can legitimately be zero — but a
    // truly unclaimable order (no email, no discord_id, no owner) is a real
    // problem for whoever bought it, and worth naming out loud.
    if (Number(n.unclaimable) > 0) {
      console.log(`        ⚠ ${n.unclaimable} paid order(s) carry NO email, NO discord_id and no owner.`);
      console.log(`          Nobody can prove those; staff must attach them by hand.`);
    }
    assert.ok(true);
  });

  const { rows: dup } = await query(
    `SELECT discord_id, count(*) FROM web_users
      WHERE guild_id = $1 AND discord_id IS NOT NULL AND discord_verified = true
      GROUP BY discord_id HAVING count(*) > 1`, [GUILD_ID]);
  check('no Discord user has two verified accounts', () => {
    // The half-account failure the shared helper exists to prevent.
    assert.strictEqual(dup.length, 0,
      `${dup.length} snowflake(s) hold more than one verified account: ${dup.map(d => d.discord_id).join(', ')}`);
  });

  const { rows: [addr] } = await query(
    `SELECT count(*) FILTER (WHERE email IS NULL) AS none,
            count(*) AS total FROM web_users WHERE guild_id = $1`, [GUILD_ID]);
  check('addressless accounts are counted, not assumed impossible', () => {
    console.log(`        ${addr.none}/${addr.total} accounts hold no email address.`);
    assert.ok(true);
  });

  await pool.end();
  done();
})().catch((e) => {
  console.log(`  FAIL  live check\n        ${e.message}`);
  failed++;
  done();
});
