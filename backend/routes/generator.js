/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GENERATOR API ROUTES - P-BOT
 * Complete account & SMS generator backend
 * ═══════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const { requireAuth, requireAdmin, requireOwnerAdmin, requireDiscordLinked, requireCurrentDiscordMember } = require('../utils/auth');
const { withTransaction } = require('../db');
const { encryptRuntimeSecret } = require('../utils/runtimeSecrets');
const { logAdminAction } = require('../utils/adminLog');
const {
  setDiscordMemberRoleByName,
  getGuildRoles,
  setDiscordMemberRole,
} = require('../utils/discordAccess');
const { generateTOTP } = require('../utils/totp');
const { rateLimit } = require('../utils/rateLimit');

const GUILD_ID = process.env.GUILD_ID;
const SINGLE_USE_PRICE_CENTS = 100;
const MONTHLY_ACCOUNT_PRICE_CENTS = 1500;
const MONTHLY_PHONE_PRICE_CENTS = 1500;
const MONTHLY_BOTH_PRICE_CENTS = 2500;
// Kept for older callers/tests that read the original constant.
const MONTHLY_PRICE_CENTS = MONTHLY_ACCOUNT_PRICE_CENTS;
const MONTHLY_USE_LIMIT = 30;
const GEN_MEMBER_ROLE_NAME = 'GEN MEMBER';
const GENERATOR_PLAN_ROLE_KEY = 'GENERATOR_PLAN_ROLE_IDS';
const GENERATOR_PLAN_TYPES = ['account', 'phone', 'both', 'combined'];
const STALE_RESERVATION_MINUTES = 30;
const generator2FALimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, name: 'generator-2fa' });

// A generated account is a Vault account, not a browser-only receipt. Keep the
// mapping here so the generator and the Vault agree on the destination bucket.
const GENERATED_ACCOUNT_TYPES = {
  standard:          { vaultType: 'gamelib', platform: 'steam' },
  'phone-verified':  { vaultType: 'gamelib', platform: 'steam' },
  activision:        { vaultType: 'cod',     platform: 'activision' },
  battlenet:         { vaultType: 'gamelib', platform: 'battlenet' },
  claude:            { vaultType: 'ai',      platform: 'claude' },
  chatgpt:           { vaultType: 'ai',      platform: 'chatgpt' },
  gemini:            { vaultType: 'ai',      platform: 'gemini' },
  perplexity:        { vaultType: 'ai',      platform: 'perplexity' },
  telegram:          { vaultType: 'discord', platform: 'telegram' },
  instagram:         { vaultType: 'discord', platform: 'instagram' },
  discord:           { vaultType: 'discord', platform: 'discord' },
  'apple-id':        { vaultType: 'email',   platform: 'apple' },
  '5m-bundle':       { vaultType: 'fivem',   platform: 'steam' },
  'cod-bundle':      { vaultType: 'cod',     platform: 'activision' },
  'email-outlook':   { vaultType: 'email',   platform: 'outlook' },
};

function supportedAccountType(type) {
  return Object.prototype.hasOwnProperty.call(GENERATED_ACCOUNT_TYPES, type);
}

// SUPERBOT and the website share Postgres.  `stock` is therefore the single
// inventory ledger: both consumers DELETE ... FOR UPDATE SKIP LOCKED from the
// same rows, so an account can never be handed out twice.  Discord stock is
// historically stored as account_data text; website entries additionally use
// structured columns.  Read either representation without exposing it in logs.
function parseSharedStockAccount(row) {
  if (row && row.password) {
    const rowEmail = row.email != null ? String(row.email).trim() : '';
    const rowUsername = row.username != null ? String(row.username).trim() : '';
    const structured = {
      // Do not manufacture an Email value for legacy user:password rows.
      // A real email column remains available when one was imported.
      email: rowEmail || null,
      username: rowUsername || rowEmail || '',
      password: String(row.password),
      emailPassword: row.email_password != null ? String(row.email_password) : null,
      extra: row.extra || null,
    };
    // Older imports populated the legacy account_data column but left the
    // structured email_password column NULL. Recover that fourth credential
    // from the canonical Discord format instead of showing it as "extra" or
    // silently dropping it.
    if ((!structured.emailPassword || !structured.extra) && row.account_data) {
      const parsed = parseSharedStockAccount({ account_data: row.account_data });
      if (parsed) {
        if (!structured.emailPassword && parsed.emailPassword) structured.emailPassword = parsed.emailPassword;
        if (!structured.extra && parsed.extra) structured.extra = parsed.extra;
      }
    }
    return structured;
  }
  let raw = String((row && row.account_data) || '').trim();
  if (!raw) return null;
  // Match Discord's parser: a trailing phone number is metadata, not part of
  // the email password shown to the customer.
  let phone = null;
  const phoneMatch = raw.match(/\s*\(([^)]+)\)\s*$/);
  if (phoneMatch) {
    phone = phoneMatch[1].trim() || null;
    raw = raw.slice(0, phoneMatch.index).trim();
  }
  const pipe = raw.indexOf('|');
  if (pipe >= 0) {
    const left = raw.slice(0, pipe).trim();
    const right = raw.slice(pipe + 1).trim();
    const at = left.indexOf(':');
    if (at < 1) return null;
    const second = right.indexOf(':');
    const username = left.slice(0, at).trim();
    return {
      username, password: left.slice(at + 1).trim(),
      email: (second < 0 ? right : right.slice(0, second)).trim() || username,
      emailPassword: second < 0 ? null : right.slice(second + 1).trim() || null,
      extra: phone,
    };
  }
  const parts = raw.split(':');
  if (parts.length < 2) return null;
  const emailIndex = parts.findIndex((part) => part.includes('@'));
  if (emailIndex === 0) return { email: parts[0], username: parts[0], password: parts.slice(1).join(':'), emailPassword: null, extra: phone };
  if (emailIndex > 0) return {
    username: parts[0], password: parts.slice(1, emailIndex).join(':'),
    email: parts[emailIndex],
    emailPassword: parts[emailIndex + 1] || null,
    extra: [parts.slice(emailIndex + 2).join(':'), phone].filter(Boolean).join(' ') || null,
  };
  // A plain user:password record has no email credential. Do not mirror the
  // username into the Email field; that was the source of the old
  // “EMAIL / USERNAME” output and made the fourth field impossible to show.
  return { email: null, username: parts[0], password: parts.slice(1).join(':'), emailPassword: null, extra: phone };
}

async function saveGeneratedVaultAccount(exec, userId, type, account, stockId) {
  if (!userId || !GUILD_ID) return;
  const meta = GENERATED_ACCOUNT_TYPES[type] || GENERATED_ACCOUNT_TYPES.standard;
  const gameType = meta.vaultType;
  // Materialize the row before locking it.  Without this first-write upsert,
  // two concurrent first-time generator requests can both observe no row,
  // then race their final upserts and overwrite one another's account.
  await exec(
    `INSERT INTO vault_data (user_id, guild_id, data, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, guild_id) DO NOTHING`,
    [userId, GUILD_ID, JSON.stringify({})]
  );
  const { rows } = await exec(
    `SELECT data FROM vault_data WHERE user_id = $1 AND guild_id = $2 FOR UPDATE`,
    [userId, GUILD_ID]
  );
  const data = rows.length && rows[0].data && typeof rows[0].data === 'object' ? rows[0].data : {};
  const list = Array.isArray(data[gameType]) ? data[gameType] : [];
  const id = `gen_${stockId}`;
  if (list.some((item) => String(item.id) === id)) return;

  const base = {
    id,
    gameType,
    username: account.username || account.email || 'Generated account',
    platform: meta.platform,
    // Keep the human-friendly date for older Vault cards, but also persist a
    // full timestamp so a freshly generated account sorts above same-day rows.
    dateCreated: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    notes: account.extra || 'Generated by Account Generator',
    tags: ['generated'],
  };
  // Vault cards already know how to render these credential fields; keeping
  // them in the same shape means generated accounts behave exactly like one
  // entered through “+ ADD ACCOUNT”.
  const loginEmail = account.email || account.username || '';
  const loginPass = account.password || '';
  if (gameType === 'fivem') {
    // FiveM cards render Steam credentials (and may later be edited to add
    // Discord/Rockstar credentials).  Keep the generated pair in that field
    // instead of the generic Activision slot, which the card never displays.
    base.steamEmail = loginEmail;
    base.steamPass = loginPass;
  } else {
    // COD, Game Library and Email cards use the account/Activision pair.
    base.activEmail = loginEmail;
    base.activPass = loginPass;
  }
  if (account.emailPassword) base.emailPass = account.emailPassword;
  // Game Library cards can show the Discord-style four-field credential set
  // without changing the shape of older manually entered records.
  if (gameType === 'gamelib') {
    base.generatedAccount = true;
    base.steamUsername = account.username || '';
    base.steamPass = account.password || '';
    base.emailEmail = account.email || '';
    base.emailPass = account.emailPassword || '';
  }
  list.push(base);
  data[gameType] = list;
  await exec(
    `INSERT INTO vault_data (user_id, guild_id, data, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, guild_id)
     DO UPDATE SET data = $3, updated_at = now()`,
    [userId, GUILD_ID, JSON.stringify(data)]
  );
}

function publicAccessState(state) {
  const planType = state.planType || (state.type === 'subscription' ? 'combined' : null);
  return {
    hasAccess: !!state.hasAccess,
    type: state.type || null,
    remaining: state.unlimited ? null : Number(state.remaining || 0),
    unlimited: !!state.unlimited,
    genMember: !!state.genMember,
    expiresAt: state.expiresAt || null,
    quota: state.genMember ? MONTHLY_USE_LIMIT : null,
    planType,
    accountRemaining: state.unlimited ? null : Number(state.accountRemaining ?? state.remaining ?? 0),
    phoneRemaining: state.unlimited ? null : Number(state.phoneRemaining ?? state.remaining ?? 0),
    totalRemaining: state.unlimited ? null : Number(state.totalRemaining ?? state.remaining ?? 0),
    prices: {
      single_account_cents: SINGLE_USE_PRICE_CENTS,
      single_phone_cents: SINGLE_USE_PRICE_CENTS,
      monthly_account_cents: MONTHLY_ACCOUNT_PRICE_CENTS,
      monthly_phone_cents: MONTHLY_PHONE_PRICE_CENTS,
      monthly_both_cents: MONTHLY_BOTH_PRICE_CENTS,
      // Compatibility for the original UI.
      single_cents: SINGLE_USE_PRICE_CENTS,
      monthly_cents: MONTHLY_PRICE_CENTS,
    },
  };
}

// Plan roles are configured by an owner in the website Roles tab. Role IDs are
// not secrets, so they are stored as a small JSON value in the existing config
// table and validated against the live guild role list on every save.
async function getGeneratorPlanRoleMap() {
  try {
    const { rows } = await db.query(
      'SELECT value FROM config WHERE guild_id = $1 AND key = $2 LIMIT 1',
      [GUILD_ID, GENERATOR_PLAN_ROLE_KEY]
    );
    const raw = rows[0] && rows[0].value;
    const parsed = raw ? JSON.parse(String(raw)) : {};
    const map = {};
    GENERATOR_PLAN_TYPES.forEach((type) => {
      const id = parsed && /^\d{15,22}$/.test(String(parsed[type] || '')) ? String(parsed[type]) : '';
      if (id) map[type] = id;
    });
    return map;
  } catch (error) {
    // A missing config table should not prevent the generator from operating
    // with its historical GEN MEMBER role.
    if (error && (error.code === '42P01' || error.code === '42703')) return {};
    throw error;
  }
}

async function syncGeneratorPlanRole(discordId, planType) {
  if (!discordId) return { synced: false, warning: 'Website account has no linked Discord user' };
  const map = await getGeneratorPlanRoleMap();
  const selected = map[planType] || map.combined || '';
  if (!selected) {
    return setDiscordMemberRoleByName(discordId, GEN_MEMBER_ROLE_NAME, true);
  }
  const results = [];
  for (const roleId of new Set(Object.values(map))) {
    if (roleId === selected) continue;
    try { results.push(await setDiscordMemberRole(discordId, roleId, false)); } catch (_) { /* best effort */ }
  }
  try {
    const role = await setDiscordMemberRole(discordId, selected, true);
    return { synced: true, role, plan_type: planType, revoked: results.length };
  } catch (error) {
    return { synced: false, warning: error.message || 'Discord plan role sync failed' };
  }
}

async function revokeGeneratorPlanRoles(discordId) {
  if (!discordId) return { synced: false, warning: 'Website account has no linked Discord user' };
  const map = await getGeneratorPlanRoleMap();
  let removed = 0;
  for (const roleId of new Set(Object.values(map))) {
    try { await setDiscordMemberRole(discordId, roleId, false); removed += 1; } catch (_) { /* best effort */ }
  }
  const legacy = await setDiscordMemberRoleByName(discordId, GEN_MEMBER_ROLE_NAME, false);
  return { synced: !!(removed || legacy.synced), removed, legacy };
}

function operationKind(type) {
  return String(type || '').toLowerCase().startsWith('sms:') ? 'phone' : 'account';
}

// Every subscription row is locked while reserving a use.  Legacy `combined`
// plans use one shared 30-use pool; the newer `account`, `phone`, and `both`
// plans count each operation type separately, so concurrent requests cannot
// overspend either allowance.
async function generatorAccessState(exec, userId, lock, role, requestedKind) {
  // Website admins and staff operate the stock/service panel and should be
  // able to verify inventory without buying a customer entitlement. This is
  // deliberately server-side; changing localStorage.role never grants it.
  if (role === 'admin' || role === 'staff') {
    return { hasAccess: true, type: 'unlimited', remaining: null, accountRemaining: null, phoneRemaining: null, unlimited: true, genMember: false };
  }
  // A provider request can outlive the Node process. Do not let a crashed
  // request consume a member's shared allowance forever; successful and
  // currently in-flight reservations remain counted, while anything older
  // than the provider's normal response window is released before counting.
  await exec(
    `UPDATE generator_logs SET status = 'failed'
     WHERE status = 'reserved' AND created_at < now() - interval '${STALE_RESERVATION_MINUTES} minutes'`
  );
  const { rows: subscriptions } = await exec(
    `SELECT id, created_at, expires_at, COALESCE(plan_type, 'combined') AS plan_type FROM generator_subscriptions
     WHERE user_id = $1 AND expires_at > now() AND active = true
     ORDER BY expires_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [userId]
  );
  const sub = subscriptions[0] || null;
  if (sub) {
    const { rows } = await exec(
      `SELECT
         COUNT(*) FILTER (WHERE type LIKE 'account:%')::int AS account_used,
         COUNT(*) FILTER (WHERE type LIKE 'sms:%')::int AS phone_used,
         COUNT(*)::int AS total_used
       FROM generator_logs
       WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
         AND status IN ('reserved','success')`,
      [userId, sub.created_at, sub.expires_at]
    );
    const accountUsed = Number(rows[0]?.account_used || 0);
    const phoneUsed = Number(rows[0]?.phone_used || 0);
    const totalUsed = Number(rows[0]?.total_used || 0);
    const planType = String(sub.plan_type || 'combined').toLowerCase();
    const accountRemaining = planType === 'phone' ? 0 : planType === 'combined' ? Math.max(0, MONTHLY_USE_LIMIT - totalUsed) : Math.max(0, MONTHLY_USE_LIMIT - accountUsed);
    const phoneRemaining = planType === 'account' ? 0 : planType === 'combined' ? Math.max(0, MONTHLY_USE_LIMIT - totalUsed) : Math.max(0, MONTHLY_USE_LIMIT - phoneUsed);
    const remaining = requestedKind === 'phone' ? phoneRemaining : requestedKind === 'account' ? accountRemaining : Math.max(accountRemaining, phoneRemaining);
    if (remaining > 0) {
      return {
        hasAccess: true, type: 'subscription', planType, remaining,
        accountRemaining, phoneRemaining, totalRemaining: accountRemaining + phoneRemaining,
        genMember: true, subscriptionId: sub.id, expiresAt: sub.expires_at,
      };
    }
  }

  const creditParams = [userId];
  let creditSql = `SELECT id, COALESCE(credit_type, 'combined') AS credit_type
                     FROM generator_credits WHERE user_id = $1 AND used = false`;
  if (requestedKind) {
    creditParams.push(requestedKind);
    creditSql += ` AND COALESCE(credit_type, 'combined') IN ($2, 'combined')`;
  }
  creditSql += ` ORDER BY created_at ASC${lock ? ' LIMIT 1 FOR UPDATE SKIP LOCKED' : ''}`;
  const { rows: credits } = await exec(creditSql, creditParams);
  const matchingCredit = credits.find((credit) => !requestedKind || credit.credit_type === requestedKind || credit.credit_type === 'combined');
  if (matchingCredit) {
    // A normal access check sees every unused credit.  A reservation locks only
    // the matching row, which is all it needs before atomically marking it used.
    const accountCredits = credits.filter((credit) => credit.credit_type === 'account').length;
    const phoneCredits = credits.filter((credit) => credit.credit_type === 'phone').length;
    const combinedCredits = credits.filter((credit) => credit.credit_type === 'combined').length;
    const accountRemaining = accountCredits + combinedCredits;
    const phoneRemaining = phoneCredits + combinedCredits;
    return {
      hasAccess: true, type: 'credit',
      remaining: requestedKind === 'phone' ? phoneRemaining : requestedKind === 'account' ? accountRemaining : credits.length,
      accountRemaining, phoneRemaining, totalRemaining: credits.length,
      genMember: !!sub, subscriptionId: sub?.id || null, expiresAt: sub?.expires_at || null,
      creditId: matchingCredit.id,
    };
  }
  return {
    hasAccess: false, type: sub ? 'subscription' : null, remaining: 0,
    accountRemaining: 0, phoneRemaining: 0, planType: sub?.plan_type || null,
    genMember: !!sub, subscriptionId: sub?.id || null, expiresAt: sub?.expires_at || null,
  };
}

async function reserveGeneratorUse(exec, userId, type, role) {
  const access = await generatorAccessState(exec, userId, true, role, operationKind(type));
  if (!access.hasAccess) {
    const err = new Error(access.genMember ? 'Monthly generator allowance exhausted' : 'Generator access required');
    err.public = true;
    err.statusCode = 402;
    throw err;
  }
  if (access.type === 'credit') {
    const { rowCount } = await exec(
      `UPDATE generator_credits SET used = true, used_at = now()
       WHERE id = $1 AND user_id = $2 AND used = false`,
      [access.creditId, userId]
    );
    if (!rowCount) {
      const err = new Error('Generator credit is no longer available');
      err.public = true;
      err.statusCode = 409;
      throw err;
    }
  }
  const { rows } = await exec(
    `INSERT INTO generator_logs (user_id, type, account_email, status)
     VALUES ($1,$2,NULL,$3) RETURNING id`,
    [userId, type, access.unlimited ? 'admin_reserved' : 'reserved']
  );
  return { logId: rows[0].id, accessType: access.type, creditId: access.creditId || null, unlimited: !!access.unlimited };
}

async function completeGeneratorUse(exec, reservation, accountEmail) {
  await exec(
    `UPDATE generator_logs SET status = $1, account_email = $2
     WHERE id = $3 AND status = $4`,
    [reservation.unlimited ? 'admin_success' : 'success', accountEmail || null, reservation.logId,
      reservation.unlimited ? 'admin_reserved' : 'reserved']
  );
}

async function releaseGeneratorUse(userId, reservation) {
  if (!reservation) return;
  await withTransaction(async (exec) => {
    const { rowCount } = await exec(
      `UPDATE generator_logs SET status = 'failed'
       WHERE id = $1 AND user_id = $2 AND status IN ('reserved','admin_reserved')`,
      [reservation.logId, userId]
    );
    if (rowCount && reservation.creditId) {
      await exec(
        `UPDATE generator_credits SET used = false, used_at = NULL WHERE id = $1 AND user_id = $2`,
        [reservation.creditId, userId]
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK GENERATOR ACCESS
// ─────────────────────────────────────────────────────────────────────────────

router.post('/check-access', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const kind = req.body?.kind === 'phone' || req.body?.kind === 'account' ? req.body.kind : undefined;
    const state = await generatorAccessState(db.query, req.user.id, false, req.user.role, kind);
    return res.json(publicAccessState(state));

  } catch (error) {
    console.error('[GENERATOR] Access check error:', error);
    res.json({ hasAccess: false, error: 'Server error' });
  }
});

// Public counts only (never account_data). This lets an authenticated Discord
// member see whether a generator category has inventory before spending an
// allowance. Claims still happen atomically in POST /account.
router.get('/stock', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT type, COUNT(*)::int AS available
         FROM stock
        WHERE guild_id = $1
        GROUP BY type`,
      [GUILD_ID]
    );
    const stock = {};
    rows.forEach((row) => { stock[String(row.type)] = Number(row.available) || 0; });
    res.set('Cache-Control', 'private, max-age=15');
    return res.json({ stock });
  } catch (error) {
    console.error('[GENERATOR] Stock count error:', error.message);
    return res.status(500).json({ error: 'Could not load generator stock' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE ACCESS
// ─────────────────────────────────────────────────────────────────────────────

router.post('/purchase-access', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const type = String((req.body && req.body.type) || '').trim();
    const userId = req.user.id;
    const plan = {
      credit_account: { kind: 'credit', creditType: 'account', priceCents: SINGLE_USE_PRICE_CENTS, description: 'Generator one account use' },
      credit_phone: { kind: 'credit', creditType: 'phone', priceCents: SINGLE_USE_PRICE_CENTS, description: 'Generator one phone-number use' },
      subscription_account: { kind: 'subscription', planType: 'account', priceCents: MONTHLY_ACCOUNT_PRICE_CENTS, description: 'GEN ACCOUNT - 30 account uses / 30 days' },
      subscription_phone: { kind: 'subscription', planType: 'phone', priceCents: MONTHLY_PHONE_PRICE_CENTS, description: 'GEN PHONE - 30 phone-number uses / 30 days' },
      subscription_both: { kind: 'subscription', planType: 'both', priceCents: MONTHLY_BOTH_PRICE_CENTS, description: 'GEN COMPLETE - 30 accounts + 30 phone numbers / 30 days' },
      // Existing links retain the original shared 30-use entitlement.
      credit: { kind: 'credit', creditType: 'combined', priceCents: SINGLE_USE_PRICE_CENTS, description: 'Generator single-use credit' },
      subscription: { kind: 'subscription', planType: 'combined', priceCents: MONTHLY_PRICE_CENTS, description: 'GEN MEMBER - 30 combined generator uses / 30 days' },
    }[type];
    if (!plan) {
      return res.status(400).json({ success: false, error: 'Invalid access plan' });
    }

    const priceCents = plan.priceCents;
    const expiresAt = plan.kind === 'subscription' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null;
    await withTransaction(async (exec) => {
      if (plan.kind === 'subscription') {
        const { rows } = await exec(
          `SELECT id FROM generator_subscriptions
           WHERE user_id = $1 AND active = true AND expires_at > now()
           LIMIT 1 FOR UPDATE`,
          [userId]
        );
        if (rows.length) {
          const err = new Error('GEN MEMBER is already active');
          err.public = true;
          err.statusCode = 409;
          throw err;
        }
      }
      await exec(
        `INSERT INTO balances (web_user_id, guild_id, balance_cents)
         VALUES ($1,$2,0) ON CONFLICT (web_user_id) DO NOTHING`,
        [userId, GUILD_ID]
      );
      const { rows: debited } = await exec(
        `UPDATE balances SET balance_cents = balance_cents - $1, updated_at = now()
         WHERE web_user_id = $2 AND balance_cents >= $1 RETURNING balance_cents`,
        [priceCents, userId]
      );
      if (!debited.length) {
        const err = new Error(`Insufficient website balance — €${(priceCents / 100).toFixed(2)} required`);
        err.public = true;
        err.statusCode = 400;
        throw err;
      }
      await exec(
        `INSERT INTO transactions (guild_id, web_user_id, kind, amount_cents, description)
         VALUES ($1,$2,'debit',$3,$4)`,
        [GUILD_ID, userId, priceCents, plan.description]
      );
      if (plan.kind === 'subscription') {
        await exec(
          `INSERT INTO generator_subscriptions (user_id, expires_at, active, plan_type)
           VALUES ($1,$2,true,$3)`,
          [userId, expiresAt, plan.planType]
        );
      } else {
        await exec('INSERT INTO generator_credits (user_id, used, credit_type) VALUES ($1,false,$2)', [userId, plan.creditType]);
      }
    });

    const discordRole = plan.kind === 'subscription'
      ? await syncGeneratorPlanRole(req.user.discord_id, plan.planType || 'combined')
      : null;
    const state = await generatorAccessState(db.query, userId, false, req.user.role);
    res.json({ success: true, plan: plan.planType || plan.creditType, access: publicAccessState(state), discord_role: discordRole });

  } catch (error) {
    if (error && error.public) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
    console.error('[GENERATOR] Purchase error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────

router.post('/account', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const type = String((req.body && req.body.type) || '').trim();
    const userId = req.user.id;

    if (!type) {
      return res.json({ success: false, error: 'Missing type' });
    }
    if (!supportedAccountType(type)) {
      return res.status(400).json({ success: false, error: 'Unsupported account category' });
    }

    let account;
    let reservation;
    await withTransaction(async (exec) => {
      reservation = await reserveGeneratorUse(exec, userId, `account:${type}`, req.user.role);
      const stockResult = await exec(`
        DELETE FROM stock WHERE id = (
          SELECT id FROM stock
          WHERE guild_id = $1 AND type = $2
          ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `, [GUILD_ID, type]);
      if (!stockResult.rows.length) {
        const err = new Error('Out of stock');
        err.public = true;
        throw err;
      }
      const claimedStock = stockResult.rows[0];
      account = parseSharedStockAccount(claimedStock);
      if (!account || !account.password || !(account.email || account.username)) {
        const err = new Error('Stock record is invalid');
        err.public = true;
        throw err;
      }

      await completeGeneratorUse(exec, reservation, account.email);
      await saveGeneratedVaultAccount(exec, userId, type, account, claimedStock.id);
    });

    const state = await generatorAccessState(db.query, userId, false, req.user.role);

    res.json({
      success: true,
      account: {
        email: account.email,
        username: account.username,
        password: account.password,
        emailPassword: account.emailPassword || null,
        extra: account.extra
      },
      access: publicAccessState(state),
    });

  } catch (error) {
    if (error && error.public) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
    console.error('[GENERATOR] Account generation error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Generate a one-time code for an account's TOTP secret.  This is a free
// utility: it deliberately does not call reserveGeneratorUse, touch credits,
// or require a GEN MEMBER entitlement.  The secret exists only for the
// duration of this request and is never echoed, stored, or written to logs.
router.post('/2fa', requireAuth, generator2FALimiter, async (req, res) => {
  try {
    const secret = String((req.body && req.body.secret) || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!secret || secret.length < 8 || secret.length > 128 || !/^[A-Z2-7]+=*$/.test(secret)) {
      return res.status(400).json({ success: false, error: 'Enter a valid base32 TOTP secret (letters A-Z and numbers 2-7).' });
    }
    const result = generateTOTP(secret);
    return res.json({ success: true, code: result.code, remaining: result.remaining, period: result.period, free: true });
  } catch (error) {
    if (/Invalid TOTP/.test(String(error && error.message))) {
      return res.status(400).json({ success: false, error: 'Enter a valid base32 TOTP secret (letters A-Z and numbers 2-7).' });
    }
    console.error('[GENERATOR] 2FA generation error:', error);
    return res.status(500).json({ success: false, error: 'Could not generate the 2FA code' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SMS GENERATOR - 5SIM
// ─────────────────────────────────────────────────────────────────────────────

// Read at request time so an owner can rotate credentials without restarting
// PM2. The config loader restores the encrypted value during the next boot.
const getFivesimApiKey = () => process.env.FIVESIM_API_KEY || '';
const FIVESIM_BASE = 'https://5sim.net/v1';

router.get('/sms/fivesim/services', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const response = await axios.get(`${FIVESIM_BASE}/guest/products/usa/any`);
    const data = response.data;

    const services = Object.keys(data).map(key => ({
      value: key,
      label: key.charAt(0).toUpperCase() + key.slice(1)
    }));

    res.json({ success: true, services });
  } catch (error) {
    console.error('[5SIM] Services error:', error);
    res.json({ success: false, error: 'Failed to load services' });
  }
});

router.get('/sms/fivesim/countries', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { service } = req.query;

    const response = await axios.get(`${FIVESIM_BASE}/guest/countries`);
    const data = response.data;

    const countries = Object.keys(data).map(code => ({
      code: code,
      name: data[code].text_en,
      price: '$0.50'
    }));

    res.json({ success: true, countries });
  } catch (error) {
    console.error('[5SIM] Countries error:', error);
    res.json({ success: false, error: 'Failed to load countries' });
  }
});

router.post('/sms/fivesim/purchase', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  let reservation = null;
  try {
    const { service, country } = req.body;
    const userId = req.user.id;
    if (!service || !country) return res.status(400).json({ success: false, error: 'Service and country are required' });
    if (!getFivesimApiKey()) return res.status(503).json({ success: false, error: '5SIM is not configured' });

    reservation = await withTransaction((exec) => reserveGeneratorUse(exec, userId, 'sms:fivesim', req.user.role));

    const response = await axios.get(
      `${FIVESIM_BASE}/user/buy/activation/${country}/any/${service}`,
      {
        headers: {
          'Authorization': `Bearer ${getFivesimApiKey()}`,
          'Accept': 'application/json'
        }
      }
    );

    const data = response.data;

    if (data.id && data.phone) {
      await withTransaction(async (exec) => {
        await exec(`
          INSERT INTO sms_orders (order_id, provider, service_name, country, number, user_id, channel_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [data.id, 'fivesim', service, country, data.phone, userId, null]);
        await completeGeneratorUse(exec, reservation, data.phone);
      });
      reservation = null;
      const state = await generatorAccessState(db.query, userId, false, req.user.role);

      res.json({
        success: true,
        order: {
          id: data.id,
          number: data.phone,
          provider: 'fivesim'
        },
        access: publicAccessState(state),
      });
    } else {
      console.error('[5SIM] Purchase failed - invalid response:', data);
      await releaseGeneratorUse(userId, reservation);
      reservation = null;
      res.status(502).json({ success: false, error: '5SIM did not return a number' });
    }
  } catch (error) {
    await releaseGeneratorUse(req.user.id, reservation).catch(() => {});
    if (error && error.public) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
    console.error('[5SIM] Purchase error:', error.response?.data || error.message);
    res.status(502).json({ success: false, error: '5SIM purchase failed' });
  }
});

router.get('/sms/fivesim/check/:orderId', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { orderId } = req.params;
    const owned = await db.query('SELECT 1 FROM sms_orders WHERE order_id = $1 AND user_id = $2 LIMIT 1', [orderId, req.user.id]);
    if (!owned.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });

    const response = await axios.get(`${FIVESIM_BASE}/user/check/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${getFivesimApiKey()}`,
        'Accept': 'application/json'
      }
    });

    const data = response.data;

    if (data.sms && data.sms.length > 0) {
      const code = data.sms[0].code;

      // Update database
      await db.query(`
        UPDATE sms_orders SET code = $1, completed = true WHERE order_id = $2
      `, [code, orderId]);

      res.json({ success: true, code });
    } else {
      res.json({ success: true, code: null });
    }
  } catch (error) {
    console.error('[5SIM] Check error:', error);
    res.json({ success: false });
  }
});

router.post('/sms/fivesim/cancel/:orderId', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { orderId } = req.params;
    const owned = await db.query('SELECT 1 FROM sms_orders WHERE order_id = $1 AND user_id = $2 LIMIT 1', [orderId, req.user.id]);
    if (!owned.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });

    await axios.get(`${FIVESIM_BASE}/user/cancel/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${getFivesimApiKey()}`,
        'Accept': 'application/json'
      }
    });

    await db.query(`UPDATE sms_orders SET cancelled = true WHERE order_id = $1`, [orderId]);

    res.json({ success: true });
  } catch (error) {
    console.error('[5SIM] Cancel error:', error);
    res.json({ success: false });
  }
});

router.post('/sms/fivesim/resend/:orderId', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { orderId } = req.params;
    const owned = await db.query('SELECT cancelled FROM sms_orders WHERE order_id = $1 AND user_id = $2 LIMIT 1', [orderId, req.user.id]);
    if (!owned.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    if (owned.rows[0].cancelled) return res.status(409).json({ success: false, error: 'This SMS number is no longer active' });

    await axios.get(`${FIVESIM_BASE}/user/finish/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${getFivesimApiKey()}`,
        'Accept': 'application/json'
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[5SIM] Resend error:', error);
    res.json({ success: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SMS GENERATOR - SMSPOOL
// ─────────────────────────────────────────────────────────────────────────────

const getSmspoolApiKey = () => process.env.SMSPOOL_API_KEY || '';
const SMSPOOL_BASE = 'https://api.smspool.net';

router.get('/sms/smspool/services', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const params = new URLSearchParams({ key: getSmspoolApiKey() });

    const response = await axios.post(`${SMSPOOL_BASE}/service/retrieve_all`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = response.data;

    const services = Object.keys(data).map(key => ({
      value: key,
      label: data[key].name || key
    }));

    res.json({ success: true, services });
  } catch (error) {
    console.error('[SMSPOOL] Services error:', error);
    res.json({ success: false, error: 'Failed to load services' });
  }
});

router.get('/sms/smspool/countries', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { service } = req.query;
    const params = new URLSearchParams({ key: getSmspoolApiKey() });

    const response = await axios.post(`${SMSPOOL_BASE}/country/retrieve_all`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = response.data;

    const countries = Object.keys(data).map(code => ({
      code: code,
      name: data[code].name,
      price: '$0.50'
    }));

    res.json({ success: true, countries });
  } catch (error) {
    console.error('[SMSPOOL] Countries error:', error);
    res.json({ success: false, error: 'Failed to load countries' });
  }
});

router.post('/sms/smspool/purchase', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  let reservation = null;
  try {
    const { service, country } = req.body;
    const userId = req.user.id;
    if (!service || !country) return res.status(400).json({ success: false, error: 'Service and country are required' });
    if (!getSmspoolApiKey()) return res.status(503).json({ success: false, error: 'SMSPool is not configured' });

    reservation = await withTransaction((exec) => reserveGeneratorUse(exec, userId, 'sms:smspool', req.user.role));

    const params = new URLSearchParams({
      key: getSmspoolApiKey(),
      country: country,
      service: service
    });

    const response = await axios.post(`${SMSPOOL_BASE}/purchase/sms`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const data = response.data;

    if (data.success && data.number) {
      await withTransaction(async (exec) => {
        await exec(`
          INSERT INTO sms_orders (order_id, provider, service_name, country, number, user_id, channel_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [data.order_id, 'smspool', service, country, data.number, userId, null]);
        await completeGeneratorUse(exec, reservation, data.number);
      });
      reservation = null;
      const state = await generatorAccessState(db.query, userId, false, req.user.role);

      res.json({
        success: true,
        order: {
          id: data.order_id,
          number: data.number,
          provider: 'smspool'
        },
        access: publicAccessState(state),
      });
    } else {
      console.error('[SMSPOOL] Purchase failed - invalid response:', data);
      await releaseGeneratorUse(userId, reservation);
      reservation = null;
      res.status(502).json({ success: false, error: 'SMSPool did not return a number' });
    }
  } catch (error) {
    await releaseGeneratorUse(req.user.id, reservation).catch(() => {});
    if (error && error.public) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
    console.error('[SMSPOOL] Purchase error:', error.response?.data || error.message);
    res.status(502).json({ success: false, error: 'SMSPool purchase failed' });
  }
});

router.get('/sms/smspool/check/:orderId', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { orderId } = req.params;
    const owned = await db.query('SELECT 1 FROM sms_orders WHERE order_id = $1 AND user_id = $2 LIMIT 1', [orderId, req.user.id]);
    if (!owned.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });

    const response = await axios.get(
      `${SMSPOOL_BASE}/sms/check?key=${getSmspoolApiKey()}&orderid=${orderId}`
    );

    const data = response.data;

    if (data.status === 3 && data.sms) {
      await db.query(`
        UPDATE sms_orders SET code = $1, completed = true WHERE order_id = $2
      `, [data.sms, orderId]);

      res.json({ success: true, code: data.sms });
    } else {
      res.json({ success: true, code: null });
    }
  } catch (error) {
    console.error('[SMSPOOL] Check error:', error);
    res.json({ success: false });
  }
});

router.post('/sms/smspool/cancel/:orderId', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { orderId } = req.params;
    const owned = await db.query('SELECT 1 FROM sms_orders WHERE order_id = $1 AND user_id = $2 LIMIT 1', [orderId, req.user.id]);
    if (!owned.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });

    await axios.get(`${SMSPOOL_BASE}/sms/cancel?key=${getSmspoolApiKey()}&orderid=${orderId}`, {
    });

    await db.query(`UPDATE sms_orders SET cancelled = true WHERE order_id = $1`, [orderId]);

    res.json({ success: true });
  } catch (error) {
    console.error('[SMSPOOL] Cancel error:', error);
    res.json({ success: false });
  }
});

router.post('/sms/smspool/resend/:orderId', requireAuth, requireCurrentDiscordMember, async (req, res) => {
  try {
    const { orderId } = req.params;
    const owned = await db.query('SELECT cancelled FROM sms_orders WHERE order_id = $1 AND user_id = $2 LIMIT 1', [orderId, req.user.id]);
    if (!owned.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });
    if (owned.rows[0].cancelled) return res.status(409).json({ success: false, error: 'This SMS number is no longer active' });

    await axios.get(`${SMSPOOL_BASE}/sms/resend?key=${getSmspoolApiKey()}&orderid=${orderId}`, {
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[SMSPOOL] Resend error:', error);
    res.json({ success: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ─── ADMIN · SMS PROVIDER CREDENTIALS ───────────────────
// Credentials are encrypted before they enter the config table. The browser
// receives only configured/masked metadata; plaintext is never serialized into
// an API response or the static website. POST is owner-admin-only because
// changing a provider key changes where real SMS purchases are charged.
const SMS_PROVIDER_KEYS = {
  fivesim: { env: 'FIVESIM_API_KEY', db: 'FIVESIM_API_KEY_ENC', label: '5SIM' },
  smspool: { env: 'SMSPOOL_API_KEY', db: 'SMSPOOL_API_KEY_ENC', label: 'SMSPool' },
};

router.get('/admin/provider-config', requireAdmin, async (req, res) => {
  const providers = {};
  Object.entries(SMS_PROVIDER_KEYS).forEach(([id, meta]) => {
    const value = String(process.env[meta.env] || '');
    providers[id] = {
      label: meta.label,
      configured: !!value,
      masked: value ? `••••••••${value.slice(-4)}` : '',
    };
  });
  res.json({ success: true, providers });
});

router.post('/admin/provider-config', requireOwnerAdmin, async (req, res) => {
  try {
    const provider = String((req.body && req.body.provider) || '').trim().toLowerCase();
    const meta = SMS_PROVIDER_KEYS[provider];
    if (!meta) return res.status(400).json({ error: 'Unknown SMS provider' });
    const raw = req.body && req.body.api_key;
    if (raw == null) return res.status(400).json({ error: 'api_key is required (send an empty value to clear it)' });
    const value = String(raw).trim();
    if (value.length > 512) return res.status(400).json({ error: 'API key is too long' });

    const previous = !!process.env[meta.env];
    // Store an encrypted empty value when CLEAR is requested. Deleting the DB
    // row would let an older Railway environment value come back on restart,
    // making a successful clear temporary and dangerously misleading.
    const encrypted = encryptRuntimeSecret(value);
    await db.query(
      `INSERT INTO config (guild_id, key, value, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (guild_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [GUILD_ID, meta.db, encrypted]
    );
    process.env[meta.env] = value;
    await logAdminAction(req, 'update_sms_provider_key', null, {
      provider, configured: !!value, was_configured: previous,
    });
    res.json({
      success: true,
      provider,
      configured: !!value,
      masked: value ? `••••••••${value.slice(-4)}` : '',
    });
  } catch (err) {
    console.error('[ADMIN] Provider credential update error:', err);
    res.status(500).json({ error: 'Failed to update provider credential' });
  }
});

// ─── ADMIN · GEN MEMBER ROLE ──────────────────────────────────────────────
// GEN MEMBER is an additive entitlement, not a replacement for the website's
// member/staff/admin/reseller role. That lets an owner or staff account also
// hold a monthly generator plan without losing panel authority.
router.get('/admin/plan-roles', requireOwnerAdmin, async (req, res) => {
  try {
    const [mapping, roles] = await Promise.all([getGeneratorPlanRoleMap(), getGuildRoles(false)]);
    res.json({
      success: true,
      mapping,
      roles: roles
        .filter((role) => role && role.name !== '@everyone' && !role.managed && /^\d{15,22}$/.test(String(role.id)))
        .map((role) => ({ id: String(role.id), name: String(role.name || ''), color: Number(role.color || 0), position: Number(role.position || 0) }))
        .sort((a, b) => b.position - a.position),
    });
  } catch (error) {
    console.error('[ADMIN] generator plan-role load error:', error.message);
    res.status(error.statusCode || 500).json({ error: 'Failed to load generator plan roles' });
  }
});

router.put('/admin/plan-roles', requireOwnerAdmin, async (req, res) => {
  try {
    const incoming = req.body && req.body.mapping && typeof req.body.mapping === 'object' ? req.body.mapping : {};
    const mapping = {};
    GENERATOR_PLAN_TYPES.forEach((type) => {
      const value = String(incoming[type] || '').trim();
      if (value) mapping[type] = value;
    });
    const roles = await getGuildRoles(false);
    const valid = new Set(roles.filter((role) => role && role.name !== '@everyone' && !role.managed).map((role) => String(role.id)));
    if (Object.values(mapping).some((id) => !/^\d{15,22}$/.test(id) || !valid.has(id))) {
      return res.status(400).json({ error: 'Each selected generator role must be an existing, assignable Discord role' });
    }
    await db.query(
      `INSERT INTO config (guild_id, key, value, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (guild_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [GUILD_ID, GENERATOR_PLAN_ROLE_KEY, JSON.stringify(mapping)]
    );
    await logAdminAction(req, 'generator_plan_roles', null, { mapping });
    res.json({ success: true, mapping });
  } catch (error) {
    console.error('[ADMIN] generator plan-role save error:', error.message);
    res.status(error.statusCode || 500).json({ error: 'Failed to save generator plan roles' });
  }
});

router.get('/admin/members', requireOwnerAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      WITH active AS (
        SELECT DISTINCT ON (user_id) id, user_id, created_at, expires_at, COALESCE(plan_type, 'combined') AS plan_type
        FROM generator_subscriptions
        WHERE active = true AND expires_at > now()
        ORDER BY user_id, expires_at DESC
      )
      SELECT a.id, a.user_id, a.created_at, a.expires_at, a.plan_type,
             u.username, u.discord_id,
             COUNT(l.id) FILTER (WHERE l.type LIKE 'account:%')::int AS account_used,
             COUNT(l.id) FILTER (WHERE l.type LIKE 'sms:%')::int AS phone_used,
             COUNT(l.id)::int AS total_used
      FROM active a
      JOIN web_users u ON u.id = a.user_id AND u.guild_id = $1
      LEFT JOIN generator_logs l ON l.user_id = a.user_id
        AND l.created_at >= a.created_at AND l.created_at < a.expires_at
        AND l.status IN ('reserved','success')
      GROUP BY a.id, a.user_id, a.created_at, a.expires_at, a.plan_type, u.username, u.discord_id
      ORDER BY u.username
    `, [GUILD_ID]);
    res.json({
      success: true,
      members: rows.map((row) => ({
        subscription_id: String(row.id),
        user_id: String(row.user_id),
        username: row.username,
        discord_id: row.discord_id,
        plan_type: row.plan_type,
        account_used: Number(row.account_used || 0),
        phone_used: Number(row.phone_used || 0),
        total_used: Number(row.total_used || 0),
        account_remaining: row.plan_type === 'phone' ? 0
          : row.plan_type === 'combined' ? Math.max(0, MONTHLY_USE_LIMIT - Number(row.total_used || 0))
          : Math.max(0, MONTHLY_USE_LIMIT - Number(row.account_used || 0)),
        phone_remaining: row.plan_type === 'account' ? 0
          : row.plan_type === 'combined' ? Math.max(0, MONTHLY_USE_LIMIT - Number(row.total_used || 0))
          : Math.max(0, MONTHLY_USE_LIMIT - Number(row.phone_used || 0)),
        remaining: row.plan_type === 'combined'
          ? Math.max(0, MONTHLY_USE_LIMIT - Number(row.total_used || 0))
          : row.plan_type === 'both'
            ? Math.max(0, MONTHLY_USE_LIMIT - Number(row.account_used || 0)) + Math.max(0, MONTHLY_USE_LIMIT - Number(row.phone_used || 0))
            : Math.max(0, MONTHLY_USE_LIMIT - Number(row.plan_type === 'phone' ? row.phone_used : row.account_used || 0)),
        expires_at: row.expires_at,
      })),
      quota: MONTHLY_USE_LIMIT,
    });
  } catch (err) {
    console.error('[ADMIN] GEN MEMBER list error:', err);
    res.status(500).json({ error: 'Failed to load GEN MEMBER roles' });
  }
});

router.post('/admin/member-role', requireOwnerAdmin, async (req, res) => {
  try {
    const userId = String((req.body && req.body.user_id) || '').trim();
    const enabled = !!(req.body && req.body.enabled);
    if (!/^\d+$/.test(userId)) return res.status(400).json({ error: 'Valid user_id is required' });
    const { rows } = await db.query(
      'SELECT id, username, discord_id FROM web_users WHERE id = $1 AND guild_id = $2',
      [userId, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const target = rows[0];
    let expiresAt = null;
    await withTransaction(async (exec) => {
      await exec(
        `UPDATE generator_subscriptions SET active = false
         WHERE user_id = $1 AND active = true`,
        [userId]
      );
      if (enabled) {
        expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await exec(
          `INSERT INTO generator_subscriptions (user_id, expires_at, active)
           VALUES ($1,$2,true)`,
          [userId, expiresAt]
        );
      }
    });
    const discordRole = enabled
      ? await syncGeneratorPlanRole(target.discord_id, 'combined')
      : await revokeGeneratorPlanRoles(target.discord_id);
    await logAdminAction(req, enabled ? 'grant_gen_member' : 'revoke_gen_member', userId, {
      username: target.username,
      expires_at: expiresAt,
      quota: enabled ? MONTHLY_USE_LIMIT : 0,
      discord_role_synced: !!discordRole.synced,
    });
    res.json({
      success: true,
      user_id: userId,
      enabled,
      expires_at: expiresAt,
      remaining: enabled ? MONTHLY_USE_LIMIT : 0,
      discord_role: discordRole,
    });
  } catch (err) {
    console.error('[ADMIN] GEN MEMBER update error:', err);
    res.status(500).json({ error: 'Failed to update GEN MEMBER role' });
  }
});

// Grant one free account generation and one free phone-number generation.
// Credits are typed and reserved inside the normal generator transaction, so
// this admin action cannot be replayed in the browser to produce extra stock.
router.post('/admin/free-use', requireOwnerAdmin, async (req, res) => {
  try {
    const userId = String((req.body && req.body.user_id) || '').trim();
    const grantAccount = req.body?.account !== false;
    const grantPhone = req.body?.phone !== false;
    if (!/^\d+$/.test(userId)) return res.status(400).json({ error: 'Valid user_id is required' });
    if (!grantAccount && !grantPhone) return res.status(400).json({ error: 'Select at least one free use' });
    const { rows } = await db.query(
      'SELECT id, username FROM web_users WHERE id = $1 AND guild_id = $2', [userId, GUILD_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await withTransaction(async (exec) => {
      if (grantAccount) await exec(
        `INSERT INTO generator_credits (user_id, used, credit_type) VALUES ($1,false,'account')`, [userId]
      );
      if (grantPhone) await exec(
        `INSERT INTO generator_credits (user_id, used, credit_type) VALUES ($1,false,'phone')`, [userId]
      );
    });
    await logAdminAction(req, 'grant_generator_free_use', userId, {
      username: rows[0].username, account: grantAccount, phone: grantPhone,
    });
    res.json({ success: true, user_id: userId, account: grantAccount, phone: grantPhone });
  } catch (err) {
    console.error('[ADMIN] Generator free-use grant error:', err);
    res.status(500).json({ error: 'Failed to grant free generator use' });
  }
});

// ADMIN - ADD STOCK
// ─────────────────────────────────────────────────────────────────────────────

router.post('/admin/add-stock', requireAdmin, async (req, res) => {
  try {
    const { type, accounts } = req.body;
    const normalizedType = String(type || '').trim();

    if (!supportedAccountType(normalizedType)) {
      return res.status(400).json({ success: false, error: 'Unsupported account category' });
    }
    if (!Array.isArray(accounts) || !accounts.length || accounts.length > 1000) {
      return res.status(400).json({ success: false, error: 'Provide between 1 and 1000 accounts' });
    }

    const normalized = accounts.map((account) => {
      const email = String((account && account.email) || '').trim();
      const username = String((account && account.username) || email).trim();
      const password = String((account && account.password) || '').trim();
      const emailPassword = account && account.emailPassword != null ? String(account.emailPassword).trim() : null;
      const extra = account && account.extra != null ? String(account.extra).trim() : null;
      return { email, username, password, emailPassword: emailPassword || null, extra: extra || null };
    });
    if (normalized.some((a) => !a.email || !a.password || a.email.length > 255 ||
        a.username.length > 255 || a.password.length > 255 || (a.extra && a.extra.length > 10000))) {
      return res.status(400).json({ success: false, error: 'One or more account lines are invalid or too long' });
    }

    await withTransaction(async (exec) => {
      for (const account of normalized) {
        await exec(`
          INSERT INTO stock (guild_id, type, account_data, email, username, password, email_password, extra, source)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'website')
        `, [GUILD_ID, normalizedType,
          `${account.username}:${account.password}|${account.email}${account.emailPassword ? `:${account.emailPassword}` : ''}${account.extra ? `:${account.extra}` : ''}`,
          account.email, account.username, account.password, account.emailPassword, account.extra]);
      }
    });

    res.json({ success: true, added: normalized.length });

  } catch (error) {
    console.error('[ADMIN] Add stock error:', error);
    res.json({ success: false, error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN - GET STOCK
// ─────────────────────────────────────────────────────────────────────────────

router.get('/admin/generator-stock', requireAdmin, async (req, res) => {
  try {
    const stockResult = await db.query(`
      SELECT type, COUNT(*) as count
      FROM stock
      WHERE guild_id = $1
      GROUP BY type
    `, [GUILD_ID]);

    const stock = {};
    stockResult.rows.forEach(row => {
      stock[row.type] = { count: parseInt(row.count) };
    });

    const logsResult = await db.query(`
      SELECT * FROM generator_logs
      ORDER BY created_at DESC
      LIMIT 50
    `);

    res.json({ success: true, stock, logs: logsResult.rows });

  } catch (error) {
    console.error('[ADMIN] Get stock error:', error);
    res.json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
