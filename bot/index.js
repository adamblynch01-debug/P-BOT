/**
 * ╔══════════════════════════════════════════════════════╗
 * ║          UH SERVICES — SUPER BOT  v2.0.0            ║
 * ║  Combines: Verify/Welcome • Updates • Anti-Scam     ║
 * ║            DM Support • 2FA Auth Server             ║
 * ╚══════════════════════════════════════════════════════╝
 */
'use strict';
require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  PermissionFlagsBits, ChannelType, AttachmentBuilder,
  REST, Routes, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');

const { createCanvas, loadImage } = require('canvas');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const db     = require('./db');

// ─── Modules ─────────────────────────────────────────────────────────────────
const antiscam   = require('./modules/antiscam');
const support    = require('./modules/support');
const { startAuthServer, handle2FAInteraction } = require('./modules/auth2fa');
const { getAllProducts, getProduct, setProductUrl, getProductChunks, getProductByName } = require('./modules/downloads');
const { commands: smsCommands, handleSMSInteraction } = require('./modules/sms-gen');

// ─── ENV Config ───────────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const GUILD_ID       = process.env.GUILD_ID || null;

// Verify/Welcome module — these are now the FALLBACK defaults only, used
// when a guild has no row in guild_settings yet (see getGuildSettings()
// below). Your original server keeps behaving exactly as before.
const VERIFIED_ROLE_ENV  = process.env.VERIFIED_ROLE_NAME  || 'Verified';
const VERIFY_CHANNEL_ENV = process.env.VERIFY_CHANNEL_NAME || 'get-verify';
const WELCOME_CHANNEL_ENV= process.env.WELCOME_CHANNEL_NAME|| 'welcome';
const WELCOME_CHANNEL_ID = '1400773021274341396';
const INVITES_CHANNEL_ID = '1482585544998256781';
const INVITES_CHANNEL_ENV= process.env.INVITES_CHANNEL_NAME|| 'invites';
const INVITES_NEEDED_ENV = parseInt(process.env.INVITES_NEEDED || '10');

// Updates module
const BOT_NAME  = process.env.BOT_NAME  || 'UH Services';
const SITE_URL  = process.env.SITE_URL  || '';

// Vouch module
const LEAVE_VOUCH_CHANNEL_ID = '1522983274417360896'; // #leave-vouch — panel lives here
const VOUCHES_CHANNEL_ID     = '1242134878263447552'; // #vouches — results get posted here

// Counting game module
const COUNTING_CHANNEL_ID = '1484663384443064510'; // #counting-game

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID in environment variables!');
  process.exit(1);
}

// ─── Discord Client ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ─── Invite Tracking (Verify module) ────────────────────────────────────────
const inviteCache = new Map(); // guildId → Map<code, {inviterId, uses}>
const inviteData  = new Map(); // guildId → Map<userId, {total,real,left,fake,usedKeys}>

// ─── Persistent storage (survive restarts) ────────────────────────────────────
// DATA_DIR should point at a mounted Railway Volume (e.g. /app/data) so this
// survives redeploys/restarts. Falls back to the project folder if unset —
// that fallback does NOT survive a redeploy on Railway.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const GIVEAWAYS_FILE = path.join(DATA_DIR, 'giveaways.json');
const VOUCHES_FILE   = path.join(DATA_DIR, 'vouches.json');

function loadJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}
function saveJSON(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('Save error:', e); }
}

// giveaways: { [messageId]: { prize, channelId, guildId, endsAt (ISO), participants: [], ended } }
const giveawaysRaw = loadJSON(GIVEAWAYS_FILE, {});
const giveaways    = new Map(Object.entries(giveawaysRaw).map(([id, g]) => [id, { ...g, participants: new Set(g.participants || []) }]));

function saveGiveaways() {
  const obj = {};
  for (const [id, g] of giveaways) obj[id] = { ...g, participants: [...g.participants] };
  saveJSON(GIVEAWAYS_FILE, obj);
}

function saveVouches() {
  const obj = {};
  for (const [gid, v] of vouchData) obj[gid] = v;
  saveJSON(VOUCHES_FILE, obj);
}

// vouches: { [guildId]: { count, channelId, entries: [{id, userId, username, rating, feedback, imageUrl, timestamp}] } }
const vouchDataRaw = loadJSON(VOUCHES_FILE, {});
const vouchData    = new Map(Object.entries(vouchDataRaw).map(([gid, v]) => [gid, { count: v.count || 0, channelId: v.channelId || null, entries: v.entries || [] }]));

// ─── Counting game ──────────────────────────────────────────────────────────
const COUNTING_FILE = path.join(DATA_DIR, 'counting.json');
function saveCounting() {
  const obj = {};
  for (const [gid, c] of countingData) obj[gid] = c;
  saveJSON(COUNTING_FILE, obj);
}
// counting: { [guildId]: { count, lastUserId, highScore } }
const countingDataRaw = loadJSON(COUNTING_FILE, {});
const countingData    = new Map(Object.entries(countingDataRaw));

// ─── Steam account stock — migrated to Postgres, guild-scoped ─────────────
const STOCK_COOLDOWN_HOURS = parseInt(process.env.STOCK_COOLDOWN_HOURS || '24');

async function getStockTypes(guildId) {
  const { rows } = await db.query(
    'SELECT type, COUNT(*)::int AS count FROM stock WHERE guild_id = $1 GROUP BY type ORDER BY type ASC',
    [guildId]
  );
  return rows; // [{type, count}]
}

async function getStockCount(guildId, type) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM stock WHERE guild_id = $1 AND type = $2', [guildId, type]);
  return rows[0].n;
}

async function addStockAccounts(guildId, type, lines) {
  await db.ensureGuild(guildId);
  for (const line of lines) {
    await db.query('INSERT INTO stock (guild_id, type, account_data) VALUES ($1,$2,$3)', [guildId, type, line]);
  }
}

// Atomically claims and removes one account — FOR UPDATE SKIP LOCKED means
// two people claiming at the exact same moment can never get the same row,
// even under concurrent requests.
async function claimOneStockAccount(guildId, type) {
  const { rows } = await db.query(
    `DELETE FROM stock WHERE id = (
       SELECT id FROM stock WHERE guild_id = $1 AND type = $2 ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING account_data`,
    [guildId, type]
  );
  return rows.length ? rows[0].account_data : null;
}

async function clearStockDB(guildId, type) {
  if (type) {
    const { rowCount } = await db.query('DELETE FROM stock WHERE guild_id = $1 AND type = $2', [guildId, type]);
    return { removed: rowCount, types: rowCount ? 1 : 0 };
  }
  const { rows: countRows } = await db.query('SELECT COUNT(*)::int AS n FROM stock WHERE guild_id = $1', [guildId]);
  const { rows: typeRows }  = await db.query('SELECT COUNT(DISTINCT type)::int AS n FROM stock WHERE guild_id = $1', [guildId]);
  await db.query('DELETE FROM stock WHERE guild_id = $1', [guildId]);
  return { removed: countRows[0].n, types: typeRows[0].n };
}

async function getStockCooldown(guildId, userId, type) {
  const { rows } = await db.query(
    'SELECT last_claimed_at FROM stock_cooldowns WHERE guild_id = $1 AND user_id = $2 AND type = $3',
    [guildId, userId, type]
  );
  return rows.length ? rows[0].last_claimed_at : null;
}

async function setStockCooldown(guildId, userId, type) {
  await db.query(
    `INSERT INTO stock_cooldowns (guild_id, user_id, type, last_claimed_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (guild_id, user_id, type) DO UPDATE SET last_claimed_at = now()`,
    [guildId, userId, type]
  );
}

// Useful links — persisted to DATA_DIR so /addusefullink and /removeusefullink
// changes survive restarts, same as stock/giveaways/vouches. Seeded once from
// the list below the first time the bot runs; after that, the file is the
// source of truth and this array is only used if the file doesn't exist yet.
// ─── Useful links — migrated to Postgres (Phase 1), guild-scoped ──────────
// One row per link, one guild's links never visible to another guild.
// Seed data only used the very first time a guild's list is empty AND it's
// your original GUILD_ID (so your existing 11 links aren't lost after the
// migrate.js run, but a brand-new server installing the bot starts empty).
const USEFUL_LINKS_SEED = [
  { label: 'Windows 11 25H2 Download',                            url: 'https://www.microsoft.com/en-us/software-download/windows11' },
  { label: 'Cleaning all partitions',                              url: 'https://youtu.be/FWUpRMqFcu4?is=OMPSQ7TUFKJk2f6U' },
  { label: 'Visual C++ Redistributable Runtimes All-in-One Jun 2026', url: 'https://www.techpowerup.com/download/visual-c-redistributable-runtime-package-all-in-one/?amp' },
  { label: 'DirectX',                                              url: 'https://www.microsoft.com/en-us/download/details.aspx?id=35' },
  { label: 'REQUIREMENTS',                                         url: 'https://pixeldrain.com/u/DSuyQNiK' },
  { label: 'UH Support Tool',                                      url: 'https://pixeldrain.com/u/qa6qTrVS' },
  { label: 'IObit Driver Booster',                                 url: 'https://pixeldrain.com/u/qyHWKWVt' },
  { label: 'Revo Uninstaller Pro',                                 url: 'https://pixeldrain.com/u/NZVsEdZQ' },
  { label: 'reWASD',                                                url: 'https://pixeldrain.com/u/tii1QT1h' },
  { label: 'Bypass the online Microsoft account requirement during Windows 11 setup', url: 'https://i.imgur.com/1gBBI7f.png' },
  { label: 'Cloudflare WARP 1.1.1.1',                              url: 'https://one.one.one.one/' },
];

async function getUsefulLinks(guildId) {
  const { rows } = await db.query(
    'SELECT id, label, url FROM useful_links WHERE guild_id = $1 ORDER BY sort_order ASC, id ASC',
    [guildId]
  );
  return rows;
}

async function addUsefulLink(guildId, label, url) {
  await db.ensureGuild(guildId);
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM useful_links WHERE guild_id = $1',
    [guildId]
  );
  await db.query(
    'INSERT INTO useful_links (guild_id, label, url, sort_order) VALUES ($1,$2,$3,$4)',
    [guildId, label, url, rows[0].next]
  );
}

// Returns the removed {label,url} row, or null if the number was out of range.
async function removeUsefulLinkByNumber(guildId, number) {
  const links = await getUsefulLinks(guildId);
  const index = number - 1;
  if (index < 0 || index >= links.length) return null;
  const target = links[index];
  await db.query('DELETE FROM useful_links WHERE id = $1', [target.id]);
  return target;
}

async function clearUsefulLinks(guildId) {
  const { rowCount } = await db.query('DELETE FROM useful_links WHERE guild_id = $1', [guildId]);
  return rowCount;
}

async function bulkInsertUsefulLinks(guildId, parsedLinks, mode) {
  await db.ensureGuild(guildId);
  if (mode === 'replace') {
    await db.query('DELETE FROM useful_links WHERE guild_id = $1', [guildId]);
  }
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS max FROM useful_links WHERE guild_id = $1',
    [guildId]
  );
  let nextOrder = rows[0].max + 1;
  for (const link of parsedLinks) {
    await db.query(
      'INSERT INTO useful_links (guild_id, label, url, sort_order) VALUES ($1,$2,$3,$4)',
      [guildId, link.label, link.url, nextOrder++]
    );
  }
}

// Parses bulk-pasted/uploaded lines like:
//   Windows 11 25H2 Download - https://www.microsoft.com/en-us/software-download/windows11
//   * REQUIREMENTS - https://pixeldrain.com/u/DSuyQNiK
// Strips common leading bullets/numbering, splits on the last " - " before
// the URL. Returns { parsed: [{label,url}], skipped: [rawLine] } so callers
// can report anything that didn't match instead of silently dropping it.
function parseUsefulLinksBulk(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const parsed = [];
  const skipped = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[\*\-•]\s*/, '').replace(/^\d+[.)]\s*/, '');
    const m = line.match(/^(.*?)\s*-\s*(https?:\/\/\S+)\s*$/);
    if (m && m[1].trim() && m[2].trim()) {
      parsed.push({ label: m[1].trim(), url: m[2].trim() });
    } else {
      skipped.push(rawLine);
    }
  }
  return { parsed, skipped };
}

// ─── TOS / Rules / Guide — staff-editable content, one per guild per key ───
const CONTENT_TYPES = {
  tos:             { label: 'Terms of Service', defaultTitle: '📜 Terms of Service' },
  rules:           { label: 'Rules',            defaultTitle: '📋 Server Rules' },
  guide:           { label: 'Guide',            defaultTitle: '📖 Guide' },
  'payment-method': { label: 'Payment Methods',  defaultTitle: '💳 Payment Methods' },
};

async function getGuildContent(guildId, key) {
  const { rows } = await db.query('SELECT * FROM guild_content WHERE guild_id = $1 AND content_key = $2', [guildId, key]);
  return rows[0] || null;
}

async function setGuildContent(guildId, key, title, body, updatedBy) {
  await db.ensureGuild(guildId);
  await db.query(
    `INSERT INTO guild_content (guild_id, content_key, title, body, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (guild_id, content_key) DO UPDATE SET title = $3, body = $4, updated_by = $5, updated_at = now()`,
    [guildId, key, title, body, updatedBy]
  );
}

async function buildContentEmbed(guildId, key) {
  const row = await getGuildContent(guildId, key);
  if (!row) return null;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(row.title)
    .setDescription(row.body)
    .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() })
    .setTimestamp(new Date(row.updated_at));
}

async function buildUsefulLinksEmbed(guildId) {
  let links = await getUsefulLinks(guildId);

  // First-run convenience: if this is your original server and it's empty
  // (e.g. before migrate.js has been run), seed it once instead of showing
  // an empty list. Brand-new servers installing the bot start empty — no
  // unrelated server should see your download links by default.
  if (!links.length && guildId === process.env.GUILD_ID) {
    await bulkInsertUsefulLinks(guildId, USEFUL_LINKS_SEED, 'replace');
    links = await getUsefulLinks(guildId);
  }

  const description = links.length
    ? links.map((l, i) => `**${i + 1}.** [${l.label}](${l.url})`).join('\n')
    : 'No links added yet.';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔗 Useful Links')
    .setDescription(description)
    .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });
}

// ─── Redeemable time-limited role keys — migrated to Postgres ─────────────
// duration_ms is NULL in the DB for lifetime keys; in JS we represent that
// as the string 'lifetime' to keep call sites simple. rowToKeyEntry()
// converts at the boundary.
function rowToKeyEntry(row) {
  if (!row) return null;
  return {
    key: row.key,
    guildId: row.guild_id,
    roleId: row.role_id,
    roleName: row.role_name,
    durationMs: row.duration_ms === null ? 'lifetime' : Number(row.duration_ms),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    redeemedBy: row.redeemed_by,
    redeemedAt: row.redeemed_at,
    expiresAt: row.expires_at,
  };
}

async function generateKeyString() {
  const segment = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  for (;;) {
    const key = `UH-${segment()}-${segment()}-${segment()}`;
    const { rows } = await db.query('SELECT 1 FROM keys WHERE key = $1', [key]);
    if (!rows.length) return key;
  }
}

async function createKeyRow({ key, guildId, roleId, roleName, durationMs, createdBy }) {
  await db.ensureGuild(guildId);
  await db.query(
    `INSERT INTO keys (key, guild_id, role_id, role_name, duration_ms, status, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,'unredeemed',$6, now())`,
    [key, guildId, roleId, roleName, durationMs === 'lifetime' ? null : durationMs, createdBy]
  );
}

async function getKeyEntry(key) {
  const { rows } = await db.query('SELECT * FROM keys WHERE key = $1', [key]);
  return rowToKeyEntry(rows[0]);
}

async function markKeyRedeemed(key, userId, expiresAtDate) {
  await db.query(
    `UPDATE keys SET status='active', redeemed_by=$2, redeemed_at=now(), expires_at=$3 WHERE key=$1`,
    [key, userId, expiresAtDate]
  );
}

async function markKeyStatus(key, status) {
  await db.query('UPDATE keys SET status=$2 WHERE key=$1', [key, status]);
}

// Renamed from parseDuration to avoid colliding with the pre-existing
// giveaway duration parser elsewhere in this file (same name, different
// unit rules — JS silently keeps only the later declaration, which was
// causing /genkey to use the WRONG parser: "1m" was read as 1 minute via
// the giveaway parser instead of erroring or meaning something else).
// Accepts the fixed preset values from /genkey's duration choices, or
// "lifetime" for a key that never expires.
function parseKeyDuration(raw) {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'lifetime') return 'lifetime';
  const m = v.match(/^(\d+)\s*([mhdw])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n <= 0) return null;
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * unitMs[m[2]];
}

// Removes the role for any key whose time is up. Runs on a timer, and once
// immediately at startup in case expirations piled up while the bot was down.
// The whole body is wrapped defensively — if the database is briefly
// unreachable (misconfigured DATABASE_URL, Postgres restarting, etc.) this
// logs and moves on instead of throwing an unhandled rejection that takes
// the entire bot process down. A missing key-expiry check for one minute is
// fine; a fully crashed bot is not.
async function sweepExpiredKeys() {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT * FROM keys WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()`
    ));
  } catch (e) {
    console.error('[keys] sweep skipped — could not reach the database:', e.message);
    return;
  }

  for (const row of rows) {
    const entry = rowToKeyEntry(row);
    try {
      await markKeyStatus(entry.key, 'expired');
      const guild = client.guilds.cache.get(entry.guildId);
      if (!guild) continue;
      const member = await guild.members.fetch(entry.redeemedBy).catch(() => null);
      const role = guild.roles.cache.get(entry.roleId);
      if (member && role && member.roles.cache.has(role.id)) {
        await member.roles.remove(role).catch(e => console.error(`[keys] failed to remove expired role for key ${entry.key}:`, e));
      }
    } catch (e) {
      console.error(`[keys] sweep error for key ${entry.key}:`, e);
    }
  }
}

// Called from the /api/keys/issue HTTP endpoint (see modules/auth2fa.js) —
// same key shape /genkey produces, so it works interchangeably with /redeem,
// /listkeys, /revokekey, and the expiry sweep above.
async function issueKeyAndNotify({ discordUserId, guildId, roleId, durationMs }) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, error: `Bot is not in guild ${guildId}.` };

  const role = guild.roles.cache.get(roleId);
  if (!role) return { ok: false, error: `Role ${roleId} not found in that guild.` };

  const key = await generateKeyString();
  await createKeyRow({ key, guildId, roleId: role.id, roleName: role.name, durationMs, createdBy: 'website' });

  let dmSent = false;
  try {
    const user = await client.users.fetch(discordUserId);
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🔑 Your Key Is Ready')
      .setDescription(
        `Thanks for your order! Here's your key for **${role.name}**:\n\n` +
        `\`${key}\`\n\n` +
        `Redeem it in the server with:\n\`/redeem key:${key}\``
      )
      .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    await user.send({ embeds: [embed] });
    dmSent = true;
  } catch (e) {
    console.error(`[keys] failed to DM key to ${discordUserId}:`, e);
  }

  return { ok: true, key, dmSent };
}

// Shared redeem logic — used by /redeem and by the postredeem panel's modal.
// `interaction` must not have been replied to yet.
async function redeemKey(interaction, rawKeyInput) {
  const keyInput = (rawKeyInput || '').trim().toUpperCase();
  const entry = await getKeyEntry(keyInput);

  if (!entry) {
    return interaction.reply({ content: '❌ That key doesn\'t exist.', flags: 64 });
  }
  if (entry.guildId !== interaction.guild.id) {
    return interaction.reply({ content: '❌ That key isn\'t valid on this server.', flags: 64 });
  }
  if (entry.status !== 'unredeemed') {
    const already = entry.status === 'active' ? 'already been redeemed' : entry.status;
    return interaction.reply({ content: `❌ That key has ${already}.`, flags: 64 });
  }

  const role = interaction.guild.roles.cache.get(entry.roleId);
  if (!role) {
    return interaction.reply({ content: '❌ The role tied to this key no longer exists — contact staff.', flags: 64 });
  }

  try {
    await interaction.member.roles.add(role);
  } catch (e) {
    console.error('[keys] redeem role add error:', e);
    return interaction.reply({ content: '❌ Could not assign the role — contact staff.', flags: 64 });
  }

  const now = Date.now();
  const isLifetime = entry.durationMs === 'lifetime';
  const expiresAtDate = isLifetime ? null : new Date(now + entry.durationMs);
  await markKeyRedeemed(keyInput, interaction.user.id, expiresAtDate);

  const expiryText = isLifetime
    ? 'forever — this is a lifetime key'
    : `until <t:${Math.floor(expiresAtDate.getTime() / 1000)}:F> (<t:${Math.floor(expiresAtDate.getTime() / 1000)}:R>)`;

  return interaction.reply({
    content: `🎉 Key redeemed! You've been given **${role.name}** ${expiryText}.`,
    flags: 64,
  });
}

// Fixed types shown as dedicated panel buttons (staff still use /addstock with
// these same slugs — e.g. /addstock type:steam, type:steam phone verified, etc.)
const GEN_PANEL_TYPES = [
  { type: 'steam',           label: 'Steam',                 emoji: '🎮' },
  { type: 'phone-verified',  label: 'Steam Phone Verified',  emoji: '📱' },
  { type: 'email-outlook',   label: 'Email: Outlook',        emoji: '📧' },
];

function normalizeStockType(raw) {
  const t = (raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return t || 'standard';
}

// Stock access roles — set as env vars if you ever need to change them without a redeploy.
const GEN_ROLE_ID_ENV      = process.env.GEN_ROLE_ID      || '1525288697656901712'; // 💎 Gen Member
const OVERSEER_ROLE_ID_ENV = process.env.OVERSEER_ROLE_ID || '1518372339115360358'; // OVERSEER — unlimited

// ─── Per-guild settings — Postgres-backed, cached in memory ────────────────
// Cache exists so hot paths (every message, every interaction) don't hit the
// DB every time — 30s is short enough that a panel edit shows up almost
// immediately, long enough to not matter for load. invalidateGuildSettings()
// (called from the panel's settings save route) clears it instantly instead
// of waiting out the TTL.
const guildSettingsCache = new Map(); // guildId -> { data, expiresAt }
const SETTINGS_CACHE_MS = 30_000;

async function getGuildSettings(guildId) {
  const cached = guildSettingsCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  let row = null;
  try {
    const { rows } = await db.query('SELECT * FROM guild_settings WHERE guild_id = $1', [guildId]);
    row = rows[0] || null;
  } catch (e) {
    console.error('[settings] load failed, using defaults:', e.message);
  }

  // Your original server keeps its exact old hardcoded/env values as
  // defaults (so nothing changes there unless you save new ones in the
  // panel). Any other guild gets plain bot defaults until configured.
  const isOriginal = guildId === GUILD_ID;
  const data = {
    // ID-based (preferred) — set these in the panel by pasting the actual
    // role/channel ID. If unset, the bot falls back to finding-or-creating
    // a channel/role by name (verifiedRoleName etc.) so a brand-new server
    // still works before anyone's configured anything.
    verifiedRoleId:     row?.verified_role_id     || null,
    welcomeChannelId:   row?.welcome_channel_id    || (isOriginal ? WELCOME_CHANNEL_ID : null),
    verifyChannelId:    row?.verify_channel_id     || null,
    invitesChannelId:   row?.invites_channel_id    || (isOriginal ? INVITES_CHANNEL_ID : null),

    // Name-based bootstrap fallbacks — only used when the ID above isn't set.
    verifiedRoleName:   row?.verified_role_name    || (isOriginal ? VERIFIED_ROLE_ENV   : 'Verified'),
    verifyChannelName:  row?.verify_channel_name   || (isOriginal ? VERIFY_CHANNEL_ENV  : 'get-verify'),
    welcomeChannelName: row?.welcome_channel_name  || (isOriginal ? WELCOME_CHANNEL_ENV : 'welcome'),
    invitesChannelName: row?.invites_channel_name  || (isOriginal ? INVITES_CHANNEL_ENV : 'invites'),

    invitesNeeded:      row?.invites_needed ?? (isOriginal ? INVITES_NEEDED_ENV : 10),
    genRoleId:          row?.gen_role_id          || (isOriginal ? GEN_ROLE_ID_ENV        : null),
    overseerRoleId:     row?.overseer_role_id     || (isOriginal ? OVERSEER_ROLE_ID_ENV   : null),
    countingChannelId:  row?.counting_channel_id  || (isOriginal ? COUNTING_CHANNEL_ID : null),
    leaveVouchChannelId:row?.leave_vouch_channel_id || (isOriginal ? LEAVE_VOUCH_CHANNEL_ID : null),
    vouchesChannelId:   row?.vouches_channel_id    || (isOriginal ? VOUCHES_CHANNEL_ID    : null),
  };

  guildSettingsCache.set(guildId, { data, expiresAt: Date.now() + SETTINGS_CACHE_MS });
  return data;
}

function invalidateGuildSettings(guildId) {
  guildSettingsCache.delete(guildId);
}

async function canAccessStock(member) {
  if (member.permissions.has('Administrator')) return true;
  const settings = await getGuildSettings(member.guild.id);
  if (settings.overseerRoleId && member.roles.cache.has(settings.overseerRoleId)) return true;
  if (settings.genRoleId && member.roles.cache.has(settings.genRoleId)) return true;
  return false;
}

// Admins / OVERSEER bypass the per-type cooldown entirely.
async function hasUnlimitedGen(member) {
  if (member.permissions.has('Administrator')) return true;
  const settings = await getGuildSettings(member.guild.id);
  return !!(settings.overseerRoleId && member.roles.cache.has(settings.overseerRoleId));
}

// Parses lines like:
//   sadHawk69367:vFbdmjbjdOJC|sutkuschampeau525@outlook.com:InD28x9O4mKk (+447452933178)
// into { username, password, email, emailPassword, phone }. Phone is optional.
// Returns null if the line doesn't match — callers should fall back to raw display,
// so accounts in any other format (or other stock types) still work fine.
function parseStockAccountLine(raw) {
  const m = raw.match(/^\s*(\S+):(\S+)\|(\S+):(\S+?)(?:\s*\(([^)]+)\))?\s*$/);
  if (!m) return null;
  const [, username, password, email, emailPassword, phone] = m;
  return { username, password, email, emailPassword, phone: phone || null };
}

async function buildStockEmbed(guildId) {
  const types = await getStockTypes(guildId);
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📦 Stock Levels')
    .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

  if (!types.length) {
    embed.setDescription('No stock has been added yet.');
  } else {
    embed.setDescription(types.map(t => `**${t.type}** — ${t.count} available`).join('\n'));
  }
  return embed;
}

// Shared claim logic — used by /gensteam directly, and by the postgensteam
// panel's button + type-select dropdown flow. `interaction` must not have
// been replied to yet when this is called.
async function claimStockAccount(interaction, type) {
  const guildId = interaction.guild.id;
  const userId  = interaction.user.id;
  const unlimited = await hasUnlimitedGen(interaction.member);

  if (!unlimited) {
    const lastGen = await getStockCooldown(guildId, userId, type);
    if (lastGen) {
      const elapsedMs = Date.now() - new Date(lastGen).getTime();
      const cooldownMs = STOCK_COOLDOWN_HOURS * 60 * 60 * 1000;
      if (elapsedMs < cooldownMs) {
        const readyAt = Math.floor((new Date(lastGen).getTime() + cooldownMs) / 1000);
        return interaction.reply({ content: `⏳ You can generate another **${type}** account <t:${readyAt}:R>.`, flags: 64 });
      }
    }
  }

  const account = await claimOneStockAccount(guildId, type);
  if (!account) {
    return interaction.reply({ content: `❌ Out of stock for **${type}**. Check back later!`, flags: 64 });
  }

  if (!unlimited) await setStockCooldown(guildId, userId, type);

  const remaining = await getStockCount(guildId, type);

  const embed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle('🔐 Your Account')
    .addFields(
      { name: 'Type', value: type, inline: true },
      { name: 'Remaining Stock', value: `${remaining}`, inline: true },
    )
    .setFooter({ text: `${BOT_NAME} | Keep this safe — it will not be shown again`, iconURL: client.user.displayAvatarURL() });

  const parsed = parseStockAccountLine(account);
  if (parsed) {
    embed.addFields(
      { name: 'Username', value: `\`${parsed.username}\``, inline: true },
      { name: 'Password', value: `\`${parsed.password}\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: true }, // spacer so the row breaks evenly
      { name: 'Email', value: `\`${parsed.email}\``, inline: true },
      { name: 'Email Password', value: `\`${parsed.emailPassword}\``, inline: true },
    );
    if (parsed.phone) embed.addFields({ name: 'Phone', value: `\`${parsed.phone}\``, inline: true });
  } else {
    // Doesn't match the expected schema — show it raw rather than lose data.
    embed.setDescription(`\`\`\`${account}\`\`\``);
  }

  let delivered = false;
  try {
    await interaction.user.send({ embeds: [embed] });
    delivered = true;
  } catch (_) { /* DMs closed — fall back below */ }

  if (delivered) {
    return interaction.reply({ content: '✅ Sent your account via DM! Check your messages.', flags: 64 });
  } else {
    return interaction.reply({ content: '⚠️ Couldn\'t DM you (your DMs may be closed), so here it is — only you can see this message:', embeds: [embed], flags: 64 });
  }
}

// Small, safe math expression evaluator for the counting game — deliberately
// NOT eval() (that would let anyone run arbitrary JS by posting it in the
// counting channel). Hand-written tokenizer + recursive-descent parser that
// only understands digits, + - * / ^ and parentheses. Returns a number, or
// null if the input isn't a valid expression this parser understands.
function evalMathExpression(expr) {
  const clean = expr.replace(/\s+/g, '');
  if (!clean) return null;
  if (!/^[0-9+\-*/^().]+$/.test(clean)) return null; // reject anything unexpected outright

  let pos = 0;
  const peek = () => clean[pos];
  const consume = () => clean[pos++];

  function parseNumber() {
    const start = pos;
    while (pos < clean.length && /[0-9.]/.test(clean[pos])) pos++;
    if (pos === start) return null;
    const n = parseFloat(clean.slice(start, pos));
    return Number.isNaN(n) ? null : n;
  }

  function parseFactor() {
    if (peek() === '(') {
      consume();
      const v = parseExpression();
      if (v === null || peek() !== ')') return null;
      consume();
      return v;
    }
    if (peek() === '-') { consume(); const v = parseFactor(); return v === null ? null : -v; }
    return parseNumber();
  }

  function parsePower() {
    const base = parseFactor();
    if (base === null) return null;
    if (peek() === '^') {
      consume();
      const exp = parsePower(); // right-associative: 2^3^2 = 2^(3^2)
      return exp === null ? null : Math.pow(base, exp);
    }
    return base;
  }

  function parseTerm() {
    let v = parsePower();
    if (v === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = consume();
      const rhs = parsePower();
      if (rhs === null) return null;
      if (op === '*') v *= rhs;
      else { if (rhs === 0) return null; v /= rhs; }
    }
    return v;
  }

  function parseExpression() {
    let v = parseTerm();
    if (v === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const rhs = parseTerm();
      if (rhs === null) return null;
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  const result = parseExpression();
  if (result === null || pos !== clean.length) return null; // leftover characters = malformed input
  return result;
}

async function handleCountingMessage(message) {
  const gid   = message.guild.id;
  const state = countingData.get(gid) || { count: 0, lastUserId: null, highScore: 0 };
  const raw   = message.content.trim();
  const expected = state.count + 1;
  const sameUserTwice = state.lastUserId === message.author.id;

  // Accept either a plain number ("10") or a math expression that evaluates
  // to the expected number ("5+5", "20/2", "10^2", "2*(1+4)") — a common
  // way counting-game communities spice things up.
  let num = NaN;
  if (/^\d+$/.test(raw)) {
    num = parseInt(raw, 10);
  } else {
    const evaluated = evalMathExpression(raw);
    if (evaluated !== null && Number.isInteger(evaluated)) num = evaluated;
  }
  const isValidNumber = !Number.isNaN(num);

  if (isValidNumber && num === expected && !sameUserTwice) {
    state.count = expected;
    state.lastUserId = message.author.id;
    if (state.count > (state.highScore || 0)) state.highScore = state.count;
    countingData.set(gid, state);
    saveCounting();
    try { await message.react('✅'); } catch (_) {}
    return;
  }

  // Wrong number, repeat user, or non-numeric message — reset the count
  const brokenAt = state.count;
  const reason = sameUserTwice
    ? "counted twice in a row"
    : (!isValidNumber ? "didn't post a valid number or equation" : `posted ${raw} instead of ${expected}`);

  state.count = 0;
  state.lastUserId = null;
  countingData.set(gid, state);
  saveCounting();

  try { if (message.deletable) await message.delete(); } catch (_) {}
  try {
    await message.channel.send({
      content: `❌ <@${message.author.id}> ${reason} — the count was **${brokenAt}**. Back to **1**!${state.highScore ? ` (Best: ${state.highScore})` : ''}`,
    });
  } catch (_) {}
}

function getGuildData(gid) {
  if (!inviteData.has(gid)) inviteData.set(gid, new Map());
  return inviteData.get(gid);
}
function getUserInviteData(gid, uid) {
  const g = getGuildData(gid);
  if (!g.has(uid)) g.set(uid, { total: 0, real: 0, left: 0, fake: 0, usedKeys: 0 });
  return g.get(uid);
}

// ─── Updates module state ────────────────────────────────────────────────────
const PRODUCT_COLORS = [
  0x5865F2,0xEB459E,0x57F287,0xFEE75C,0xED4245,
  0x9B59B6,0x1ABC9C,0xE67E22,0x3498DB,0xE74C3C,
  0x2ECC71,0xF39C12,0x1F8B4C,0x206694,0x71368A,
  0xAD1457,0x11806A,0xC27C0E,0xA84300,0x979C9F,
];
const productColorMap    = {};
let colorIndex           = 0;
const productLastStatus  = {};
const websiteMessages    = {};
const resellerMessages   = {};
const pendingUpdates     = {};
const resellerLinks      = { apply: 'https://uhservicess.netlify.app/', panel: 'https://uhservicess.netlify.app/' };
// Competitor-detection: server IDs to watch for on join, role to tag flagged members with, and a staff log channel.
const competitorWatch    = { guildIds: [], roleId: null, logChannel: 'mod-log' };

const UPDATE_TYPES = {
  status_change:  { label: 'Status Change',  emoji: '🔄' },
  maintenance:    { label: 'Maintenance',     emoji: '🛠️' },
  update:         { label: 'Update',          emoji: '⬆️' },
  patch:          { label: 'Patch',           emoji: '🩹' },
  undetected:     { label: 'Undetected',      emoji: '✅' },
  detected:       { label: 'Detected',        emoji: '🚨' },
  disabled:       { label: 'Disabled',        emoji: '⛔' },
  enabled:        { label: 'Enabled',         emoji: '🟢' },
  new_product:    { label: 'New Product',     emoji: '🆕' },
  sale:           { label: 'Sale',            emoji: '💸' },
  bug_fix:        { label: 'Bug Fix',         emoji: '🔧' },
  announcement:   { label: 'Announcement',    emoji: '📣' },
  time_extension: { label: 'Time Extension',  emoji: '🕐' },
  new_feature:    { label: 'New Feature',     emoji: '✨' },
};
const STATUS_TYPES = {
  updating: { emoji: '🔵', label: 'Updating', color: 0x9B59B6 },
  testing:  { emoji: '🟡', label: 'Testing',  color: 0xF1C40F },
  updated:  { emoji: '🟢', label: 'Updated',  color: 0x57F287 },
};

function getProductColor(name) {
  const k = name.toLowerCase().trim();
  if (!(k in productColorMap)) productColorMap[k] = PRODUCT_COLORS[colorIndex++ % PRODUCT_COLORS.length];
  return productColorMap[k];
}

function hasAccess(interaction) {
  const member = interaction.member;
  if (member.permissions.has('Administrator')) return true;
  if (member.roles.cache.some(r => r.name === 'MODERATOR')) return true;
  return false;
}

// Only true for the bot owner's own Discord account — used for commands
// that operate across every server the bot is in (list/leave a guild),
// not just the guild the command was run from. Set OWNER_DISCORD_ID in
// Railway to your own Discord user ID.
function isBotOwner(interaction) {
  return !!process.env.OWNER_DISCORD_ID && interaction.user.id === process.env.OWNER_DISCORD_ID;
}

function autoDelete(interaction, ms) {
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
}

// Safe setTimeout that handles durations longer than JS's ~24.8 day limit by chaining.
function safeSetTimeout(fn, ms) {
  const MAX = 2_147_483_647;
  if (ms <= MAX) { setTimeout(fn, ms); return; }
  setTimeout(() => safeSetTimeout(fn, ms - MAX), MAX);
}

// Pick up to `count` unique random winners from a participants array.
function pickWinners(participants, count) {
  const pool = [...participants];
  const winners = [];
  while (winners.length < count && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  return winners;
}
function parseDuration(str) {
  const match = str.trim().match(/^(\d+)\s*(s|sec|m|min|h|hr|d|day|w|week|mo|month)s?$/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  switch (match[2].toLowerCase()) {
    case 's': case 'sec':   return n * 1000;
    case 'm': case 'min':   return n * 60 * 1000;
    case 'h': case 'hr':    return n * 60 * 60 * 1000;
    case 'd': case 'day':   return n * 24 * 60 * 60 * 1000;
    case 'w': case 'week':  return n * 7 * 24 * 60 * 60 * 1000;
    case 'mo': case 'month': return n * 30 * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

// Normalizes a channel name: lowercase, strip emoji/symbols/pipes/spaces, keep only letters/numbers/hyphens/underscores.
function normalizeChannelName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_]/gu, ''); // strip everything except letters, numbers, hyphen, underscore (drops emoji, pipes, spaces)
}

// Finds a channel whose normalized name contains the normalized target — survives emoji prefixes, pipes, capitalization, etc.
// e.g. findChannelByName(guild, 'invites') will match '📨 | Invites', 'invites', 'INVITES-chat', etc.
function findChannelByName(guild, targetName, type = ChannelType.GuildText) {
  const target = normalizeChannelName(targetName);
  if (!target) return null;
  // Prefer an exact normalized match first, then fall back to "contains".
  const channels = [...guild.channels.cache.values()].filter(c => c.type === type);
  const exact = channels.find(c => normalizeChannelName(c.name) === target);
  if (exact) return exact;
  return channels.find(c => normalizeChannelName(c.name).includes(target)) || null;
}

function parseStatusTransition(raw) {
  const parts = raw.split(/→|->|>|\bto\b|\//).map(p => p.trim());
  if (parts.length === 2) return { old: STATUS_TYPES[parts[0]] || null, new: STATUS_TYPES[parts[1]] || null };
  if (parts.length === 1) return { old: null, new: STATUS_TYPES[parts[0]] || null };
  return { old: null, new: null };
}

// ─── Welcome Card ────────────────────────────────────────────────────────────
async function createWelcomeCard(member) {
  const W = 600, H = 400;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);
  const teal = '#00e5ff', arm = 55, pad = 18;
  ctx.strokeStyle = teal; ctx.lineWidth = 6; ctx.lineCap = 'square';
  ctx.beginPath(); ctx.moveTo(pad,pad+arm); ctx.lineTo(pad,pad); ctx.lineTo(pad+arm,pad); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W-pad-arm,pad); ctx.lineTo(W-pad,pad); ctx.lineTo(W-pad,pad+arm); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad,H-pad-arm); ctx.lineTo(pad,H-pad); ctx.lineTo(pad+arm,H-pad); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W-pad-arm,H-pad); ctx.lineTo(W-pad,H-pad); ctx.lineTo(W-pad,H-pad-arm); ctx.stroke();
  const pillText = `Member #${member.guild.memberCount}`;
  ctx.font = 'bold 16px Arial';
  const tw = ctx.measureText(pillText).width;
  const pillW = tw+36, pillH = 30, pillX = (W-pillW)/2, pillY = 22;
  ctx.fillStyle = '#2c2c4a'; ctx.beginPath(); ctx.roundRect(pillX,pillY,pillW,pillH,15); ctx.fill();
  ctx.fillStyle = '#cccccc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(pillText, W/2, pillY+pillH/2);
  const cx = W/2, cy = 195, r = 70;
  try {
    const avatar = await loadImage(member.user.displayAvatarURL({ extension: 'png', size: 256 }));
    ctx.beginPath(); ctx.arc(cx,cy,r+4,0,Math.PI*2); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.clip();
    ctx.drawImage(avatar,cx-r,cy-r,r*2,r*2); ctx.restore();
  } catch (_) { ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle='#5865f2'; ctx.fill(); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 32px Arial'; ctx.fillText(`Welcome ${member.user.username}`, W/2, 300);
  ctx.fillStyle = '#aaaaaa'; ctx.font = '20px Arial'; ctx.fillText('to', W/2, 328);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 24px Arial'; ctx.fillText(member.guild.name, W/2, 360);
  return canvas.toBuffer('image/png');
}

// ─── Slash Commands ───────────────────────────────────────────────────────────
const ownCommands = [
  // Verify module
  new SlashCommandBuilder().setName('setup-verify').setDescription('Sets up the verification channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('setup-invites').setDescription('Sets up the invite reward channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  // Updates module
  new SlashCommandBuilder().setName('postupdate').setDescription('Open the product update form'),
  new SlashCommandBuilder().setName('announce').setDescription('Send a custom announcement to any channel'),
  new SlashCommandBuilder().setName('downloads').setDescription('Browse and download products'),
  new SlashCommandBuilder().setName('setdownload').setDescription('Admin: Set or update a download link for a product')
    .addStringOption(o => o.setName('product').setDescription('Product name').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('url').setDescription('Download URL').setRequired(true)),
  new SlashCommandBuilder().setName('setupdownloads').setDescription('Admin: Post the download panel to #downloads'),
  new SlashCommandBuilder().setName('setwebsite').setDescription('Admin: Set or update the website URL')
    .addStringOption(o => o.setName('url').setDescription('Full website URL').setRequired(true)),
  new SlashCommandBuilder().setName('statusupdate').setDescription('Post a status update to #status-updates'),
  new SlashCommandBuilder().setName('setupreseller').setDescription('Admin: Post the reseller program panel'),
  new SlashCommandBuilder().setName('postimage').setDescription('Admin: Post an image with an optional message')
    .addAttachmentOption(o => o.setName('image').setDescription('Image to post').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Optional message').setRequired(false))
    .addStringOption(o => o.setName('channel').setDescription('Channel to post in').setRequired(false)),
  new SlashCommandBuilder().setName('setresellerlinks').setDescription('Admin: Update Apply and Preview Panel button links'),
  new SlashCommandBuilder().setName('postlink').setDescription('Staff: Post a titled link to the Useful-Links channel')
    .addStringOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('setcompetitors').setDescription('Admin: Configure competitor-server join detection')
    .addStringOption(o => o.setName('guild_ids').setDescription('Comma-separated server IDs to watch for (bot must share that server)').setRequired(true))
    .addRoleOption(o => o.setName('flag_role').setDescription('Role to apply to flagged members').setRequired(false))
    .addStringOption(o => o.setName('log_channel').setDescription('Staff channel name to log detections in (default: mod-log)').setRequired(false)),
  new SlashCommandBuilder().setName('giveaway').setDescription('Staff: Start a giveaway')
    .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 1h, 30m, 2d, 1w, 1mo').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners 1-5 (default 1)').setMinValue(1).setMaxValue(5).setRequired(false))
    .addStringOption(o => o.setName('image').setDescription('Image URL for the giveaway embed (optional)').setRequired(false))
    .addStringOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current)').setRequired(false)),
  new SlashCommandBuilder().setName('setupvouch').setDescription('Staff: Post the Leave a Vouch panel')
    .addStringOption(o => o.setName('channel').setDescription('Panel channel (defaults to #leave-vouch)').setRequired(false))
    .addStringOption(o => o.setName('results_channel').setDescription('Where received vouches post (defaults to #vouches)').setRequired(false)),
  new SlashCommandBuilder().setName('exportvouches').setDescription('Staff: Download a backup file of all vouches on this server'),
  new SlashCommandBuilder().setName('importvouches').setDescription('Staff: Restore vouches from a backup file into this server')
    .addAttachmentOption(o => o.setName('file').setDescription('The vouches backup .json file').setRequired(true))
    .addBooleanOption(o => o.setName('repost').setDescription('Repost each vouch as an embed in the vouches channel? (default: true)').setRequired(false)),
  new SlashCommandBuilder().setName('commands').setDescription('Show all available bot commands'),
  new SlashCommandBuilder().setName('addstock').setDescription('Staff: Add accounts to stock')
    .addStringOption(o => o.setName('type').setDescription('Account type (e.g. phone-verified). Leave blank for standard').setRequired(false))
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file, one account per line').setRequired(false))
    .addStringOption(o => o.setName('accounts').setDescription('Paste accounts here (one per line) if not using a file').setRequired(false)),
  new SlashCommandBuilder().setName('stock').setDescription('Check how much stock is available'),
  new SlashCommandBuilder().setName('gensteam').setDescription('Generate a Steam account')
    .addStringOption(o => o.setName('type').setDescription('Account type (e.g. phone-verified). Leave blank for standard').setRequired(false)),
  new SlashCommandBuilder().setName('postgensteam').setDescription('Staff: Post the Steam account generator panel')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('clearstock').setDescription('Staff: Remove stock accounts (fix a bad upload)')
    .addBooleanOption(o => o.setName('confirm').setDescription('Set to True to confirm — this cannot be undone').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Account type to clear. Leave blank to clear ALL types').setRequired(false)),
  new SlashCommandBuilder().setName('postusefullinks').setDescription('Staff: Post the full useful-links list in one go')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('addusefullink').setDescription('Staff: Add a link to the useful-links list')
    .addStringOption(o => o.setName('title').setDescription('Display title for the link').setRequired(true))
    .addStringOption(o => o.setName('url').setDescription('The URL').setRequired(true)),
  new SlashCommandBuilder().setName('removeusefullink').setDescription('Staff: Remove a link by its number (see /listusefullinks)')
    .addIntegerOption(o => o.setName('number').setDescription('The link number to remove').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('listusefullinks').setDescription('Staff: Preview the useful-links list with numbers (only you can see it)'),
  new SlashCommandBuilder().setName('clearusefullinks').setDescription('Staff: Clear the entire useful-links list')
    .addBooleanOption(o => o.setName('confirm').setDescription('Set to True to confirm — this cannot be undone').setRequired(true)),
  new SlashCommandBuilder().setName('importusefullinks').setDescription('Staff: Bulk add links — one per line, formatted "Title - https://url"')
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file, one "Title - https://url" per line').setRequired(false))
    .addStringOption(o => o.setName('links').setDescription('Paste "Title - https://url" lines here if not using a file').setRequired(false))
    .addStringOption(o => o.setName('mode').setDescription('append (default) or replace the whole list').setRequired(false)
      .addChoices({ name: 'Append to current list', value: 'append' }, { name: 'Replace entire list', value: 'replace' })),
  new SlashCommandBuilder().setName('genkey').setDescription('Staff: Generate redeemable key(s) that grant a role for a set duration')
    .addRoleOption(o => o.setName('role').setDescription('Role the key grants').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('How long the role lasts').setRequired(true)
      .addChoices(
        { name: 'Lifetime',   value: 'lifetime' },
        { name: '1 Year',     value: '365d' },
        { name: '3 Months',   value: '90d' },
        { name: '1 Month',    value: '30d' },
        { name: '2 Weeks',    value: '14d' },
        { name: '3 Days',     value: '3d' },
        { name: '1 Day',      value: '1d' },
        { name: '5 Minutes (testing)', value: '5m' },
      ))
    .addIntegerOption(o => o.setName('amount').setDescription('How many keys to generate (default 1, max 25)').setRequired(false).setMinValue(1).setMaxValue(25)),
  new SlashCommandBuilder().setName('redeem').setDescription('Redeem a key to receive a role for a limited time')
    .addStringOption(o => o.setName('key').setDescription('Your key, e.g. UH-XXXX-XXXX-XXXX').setRequired(true)),
  new SlashCommandBuilder().setName('listkeys').setDescription('Staff: View unredeemed and active keys on this server'),
  new SlashCommandBuilder().setName('revokekey').setDescription('Staff: Revoke a key — removes the role immediately if already redeemed')
    .addStringOption(o => o.setName('key').setDescription('The key to revoke').setRequired(true)),
  new SlashCommandBuilder().setName('postredeem').setDescription('Staff: Post a button-based key redeem panel')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('set-tos').setDescription('Staff: Set the Terms of Service content')
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file instead of typing in a popup form').setRequired(false)),
  new SlashCommandBuilder().setName('set-rules').setDescription('Staff: Set the Rules content')
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file instead of typing in a popup form').setRequired(false)),
  new SlashCommandBuilder().setName('set-guide').setDescription('Staff: Set the Guide content')
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file instead of typing in a popup form').setRequired(false)),
  new SlashCommandBuilder().setName('set-payment-method').setDescription('Staff: Set the Payment Methods content')
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file instead of typing in a popup form').setRequired(false)),
  new SlashCommandBuilder().setName('post-tos').setDescription('Staff: Post the Terms of Service')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('post-rules').setDescription('Staff: Post the Rules')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('post-guide').setDescription('Staff: Post the Guide')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('post-payment-method').setDescription('Staff: Post the Payment Methods')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('listguilds').setDescription('Owner only: List every server the bot is currently in'),
  new SlashCommandBuilder().setName('leaveguild').setDescription('Owner only: Make the bot leave a specific server')
    .addStringOption(o => o.setName('guild_id').setDescription('The server ID to leave (from /listguilds)').setRequired(true)),
].map(c => c.toJSON());

// Merge with support module commands
const allCommands = [...ownCommands, ...support.supportCommands, ...smsCommands.map(c => c.toJSON())];

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  ✅ UH SUPER BOT online            ║`);
  console.log(`║  Logged in as: ${client.user.tag.padEnd(19)}║`);
  console.log(`╚════════════════════════════════════╝\n`);

  // Cache guild invites
  for (const [, guild] of client.guilds.cache) {
    try {
      const inv = await guild.invites.fetch();
      const cache = new Map();
      inv.forEach(i => cache.set(i.code, { inviterId: i.inviter?.id, uses: i.uses }));
      inviteCache.set(guild.id, cache);
    } catch (_) {}
  }

  // Re-schedule any active giveaway timers that survived a restart
  for (const [msgId, gw] of giveaways) {
    if (gw.ended) continue;
    const remaining = new Date(gw.endsAt).getTime() - Date.now();
    if (remaining <= 0) {
      // Already expired while bot was offline — end it now
      gw.ended = true;
      saveGiveaways();
      (async () => {
        try {
          const gwCh  = await client.channels.fetch(gw.channelId);
          const gwMsg = await gwCh.messages.fetch(msgId);
          const participants = [...gw.participants];
          const count   = gw.winnerCount || 1;
          const winners = pickWinners(participants, count);
          const winnersText = winners.length ? winners.map(w => `<@${w}>`).join(', ') : null;
          const endedEmbed = new EmbedBuilder().setColor(0x95A5A6).setTitle(`🎁 ${gw.prize} [ENDED]`)
            .setDescription(`This giveaway has ended!\n\n**${winners.length > 1 ? 'Winners' : 'Winner'}:** ${winnersText || 'No participants'}`)
            .setFooter({ text: `Ended on ${new Date(gw.endsAt).toUTCString()}`, iconURL: client.user.displayAvatarURL() });
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('giveaway_enter').setLabel(`🎉 Participate (${participants.length})`).setStyle(ButtonStyle.Primary).setDisabled(true),
          );
          await gwMsg.edit({ embeds: [endedEmbed], components: [disabledRow] });
          const resultsEmbed = new EmbedBuilder().setColor(0x2ECC71).setTitle(`🎁 ${gw.prize} [RESULTS]`)
            .setDescription(`The ${winners.length > 1 ? 'winners are' : 'winner is'} tagged above! Congratulations 🎉`)
            .addFields({ name: 'Prize', value: gw.prize }, { name: 'Participants', value: `${participants.length}` }, { name: 'Winners', value: `${winners.length}` })
            .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
          await gwCh.send({ content: winnersText || '❌ No participants — no winner.', embeds: [resultsEmbed] });
        } catch (e) { console.error('Giveaway restart-end error:', e); }
      })();
    } else {
      // Still has time left — re-arm the timer for the remaining duration
      safeSetTimeout(async () => {
        const g = giveaways.get(msgId);
        if (!g || g.ended) return;
        g.ended = true;
        saveGiveaways();
        try {
          const gwCh  = await client.channels.fetch(g.channelId);
          const gwMsg = await gwCh.messages.fetch(msgId);
          const participants = [...g.participants];
          const count   = g.winnerCount || 1;
          const winners = pickWinners(participants, count);
          const winnersText = winners.length ? winners.map(w => `<@${w}>`).join(', ') : null;
          const endedEmbed = new EmbedBuilder().setColor(0x95A5A6).setTitle(`🎁 ${g.prize} [ENDED]`)
            .setDescription(`This giveaway has ended!\n\n**${winners.length > 1 ? 'Winners' : 'Winner'}:** ${winnersText || 'No participants'}`)
            .setFooter({ text: `Ended on ${new Date(g.endsAt).toUTCString()}`, iconURL: client.user.displayAvatarURL() });
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('giveaway_enter').setLabel(`🎉 Participate (${participants.length})`).setStyle(ButtonStyle.Primary).setDisabled(true),
          );
          await gwMsg.edit({ embeds: [endedEmbed], components: [disabledRow] });
          const resultsEmbed = new EmbedBuilder().setColor(0x2ECC71).setTitle(`🎁 ${g.prize} [RESULTS]`)
            .setDescription(`The ${winners.length > 1 ? 'winners are' : 'winner is'} tagged above! Congratulations 🎉`)
            .addFields({ name: 'Prize', value: g.prize }, { name: 'Participants', value: `${participants.length}` }, { name: 'Winners', value: `${winners.length}` })
            .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
          await gwCh.send({ content: winnersText || '❌ No participants — no winner.', embeds: [resultsEmbed] });
        } catch (e) { console.error('Giveaway rescheduled-end error:', e); }
      }, remaining);
      console.log(`⏰ Rescheduled giveaway ${msgId} (${gw.prize}) — ${Math.round(remaining / 60000)}m remaining`);
    }
  }

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('📋 Registering slash commands...');
    // Global registration — required for the bot to work on any server it
    // joins, not just GUILD_ID. Takes up to ~1hr to propagate to every
    // server on updates (normal Discord behavior for public bots), but new
    // commands are usually visible within minutes in practice.
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: allCommands });
    console.log('✅ Global slash commands registered');
  } catch (err) { console.error('Failed to register commands:', err); }

  // Start 2FA auth server
  startAuthServer(client, { issueKey: issueKeyAndNotify, invalidateGuildSettings });

  // Redeemable-key expiry — catch up on anything that expired while the bot
  // was offline, then check every minute going forward.
  await sweepExpiredKeys();
  setInterval(sweepExpiredKeys, 60_000);

  await client.user.setActivity('for scams 🛡️', { type: 3 }); // Watching
});

// ─── Invite tracking ─────────────────────────────────────────────────────────
client.on('inviteCreate', inv => {
  const cache = inviteCache.get(inv.guild.id) || new Map();
  cache.set(inv.code, { inviterId: inv.inviter?.id, uses: inv.uses });
  inviteCache.set(inv.guild.id, cache);
});
client.on('inviteDelete', inv => {
  const cache = inviteCache.get(inv.guild.id);
  if (cache) cache.delete(inv.code);
});

// ─── Member Join ─────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  // Competitor-server detection: check if this member is also in any watched guild the bot shares with them.
  if (competitorWatch.guildIds.length) {
    try {
      const sharedWith = [];
      for (const gid of competitorWatch.guildIds) {
        const g = client.guilds.cache.get(gid);
        if (!g) continue; // bot isn't in that server, can't check it
        const isMember = g.members.cache.has(member.id) || await g.members.fetch(member.id).then(() => true).catch(() => false);
        if (isMember) sharedWith.push(g.name);
      }
      if (sharedWith.length) {
        if (competitorWatch.roleId) {
          const role = member.guild.roles.cache.get(competitorWatch.roleId);
          if (role) await member.roles.add(role).catch(() => {});
        }
        const logCh = findChannelByName(member.guild, competitorWatch.logChannel);
        if (logCh) {
          await logCh.send({
            content: `🚩 <@${member.id}> (**${member.user.tag}**) joined and is also in: ${sharedWith.join(', ')}`,
          }).catch(() => {});
        }
      }
    } catch (err) { console.error('Competitor detection error:', err); }
  }

  // Track invite
  try {
    const newInvites = await member.guild.invites.fetch();
    const oldCache   = inviteCache.get(member.guild.id) || new Map();
    let inviterId = null;
    newInvites.forEach(inv => {
      const old = oldCache.get(inv.code);
      if (old && inv.uses > old.uses) inviterId = old.inviterId;
    });
    const newCache = new Map();
    newInvites.forEach(inv => newCache.set(inv.code, { inviterId: inv.inviter?.id, uses: inv.uses }));
    inviteCache.set(member.guild.id, newCache);
    if (inviterId) {
      const d = getUserInviteData(member.guild.id, inviterId);
      d.total++; d.real++;
    }
  } catch (_) {}

  const settings = await getGuildSettings(member.guild.id);
  const verifyChForDM = (settings.verifyChannelId && member.guild.channels.cache.get(settings.verifyChannelId))
    || findChannelByName(member.guild, settings.verifyChannelName);

  // DM new member
  try {
    await member.send(
      `👋 Welcome to **${member.guild.name}**!\n\nPlease head to **#${verifyChForDM?.name || settings.verifyChannelName}** and click **Verify Me** to access the server.`
    );
  } catch (_) {}

  // Welcome card
  try {
    const welcomeCh = (settings.welcomeChannelId && member.guild.channels.cache.get(settings.welcomeChannelId))
      || findChannelByName(member.guild, settings.welcomeChannelName);
    if (!welcomeCh) return;
    const buf = await createWelcomeCard(member);
    await welcomeCh.send({
      content: `Welcome <@${member.user.id}> to **${member.guild.name}**! 🎉`,
      files: [new AttachmentBuilder(buf, { name: 'welcome.png' })],
    });
  } catch (err) { console.error('Welcome card error:', err); }
});

// ─── Messages ─────────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  // DM support (support module handles !close in DMs)
  if (message.channel.type === ChannelType.DM) {
    await support.handleDM(message, client);
    return;
  }
  // Counting game (dedicated channel — skip other message processing)
  const msgSettings = await getGuildSettings(message.guild.id);
  if (msgSettings.countingChannelId && message.channel.id === msgSettings.countingChannelId) {
    if (message.author.bot) return;
    await handleCountingMessage(message);
    return;
  }
  // Anti-scam prefix commands
  if (message.content.startsWith('!')) {
    const handled = await antiscam.handlePrefixCommand(message, client);
    if (handled) return;
  }
  // Anti-scam scanning (runs on all non-admin messages)
  await antiscam.onMessage(message, client);
});

// ─── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {
    // 2FA button
    if (await handle2FAInteraction(interaction)) return;
    // Support module interactions
    if (await support.handleInteraction(interaction, client)) return;
    // SMS Gen (commands + select menus + buttons)
    const _smsCmd = interaction.commandName || '';
    const _smsId  = interaction.customId || '';
    if (['gennumber', 'post-smsgen', 'set-5sim-api', 'set-smspool-api'].includes(_smsCmd) || _smsId.startsWith('sms_')) {
      return handleSMSInteraction(interaction, client);
    }
    // Autocomplete
    if (interaction.isAutocomplete() && interaction.commandName === 'setdownload') {
      const focused = interaction.options.getFocused().toLowerCase();
      return interaction.respond(
        getAllProducts().filter(p => p.name.toLowerCase().includes(focused)).slice(0, 25).map(p => ({ name: p.name, value: p.id }))
      );
    }

    // ── Slash commands ──────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // ── /commands ──────────────────────────────────────────────────────────
      if (cmd === 'commands') {
        const embed = new EmbedBuilder()
          .setTitle('🤖 UH Super Bot — All Commands').setColor(0x5865F2)
          .addFields(
            { name: '🔐 Verification & Invites', value: '`/setup-verify` — Set up verification channel\n`/setup-invites` — Set up invite reward channel', inline: false },
            { name: '📦 Products & Downloads', value: '`/downloads` — Browse & download products\n`/setupdownloads` — Post download panel to #downloads\n`/setdownload` — Set a product download link', inline: false },
            { name: '📣 Updates & Status', value: '`/postupdate` — Post a product update\n`/statusupdate` — Post a status update\n`/announce` — Send a custom announcement', inline: false },
            { name: '🌐 Server Setup', value: '`/setwebsite` — Pin website URL\n`/setupreseller` — Post reseller panel\n`/setresellerlinks` — Update reseller button links\n`/postimage` — Post an image', inline: false },
            { name: '🎫 Support Tickets', value: '`/panel` — Post the support panel\n`/clearlogs` — Clear ticket log channel\n`/reply` — Reply to a user\'s ticket', inline: false },
            { name: '📝 Vouches', value: '`/setupvouch` — Post the Leave a Vouch panel\n`/exportvouches` — Download a backup of all vouches\n`/importvouches` — Restore vouches from a backup file', inline: false },
            { name: '🎮 Steam Stock', value: '`/gensteam [type]` — Generate a Steam account\n`/stock` — Check available stock\n`/addstock` — Staff: add accounts to stock', inline: false },
            { name: '📲 SMS Gen', value: '`/gennumber` — Generate a phone number (private dropdowns)\n`/post-smsgen` — Staff: Post the SMS Gen panel\n`/set-smspool-api` — Admin: Set SMSPool.net key\n`/set-5sim-api` — Admin: Set 5sim.net key', inline: false },
            { name: '🛡️ Anti-Scam (Prefix)', value: '`!bothelp` — Anti-scam command list\n`!manage` — Management panel\n`!scamcheck <text>` — Test message\n`!warnings / !clearwarnings` — Warning system\n`!nuke` — Wipe channel\n`!addlink / !removelink / !listlinks` — Manage banned links\n`!addword / !removeword` — Manage profanity filter', inline: false },
            { name: '💬 DM Commands', value: '`!close` — Close your support ticket (type in DM)', inline: false },
          )
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // ── /post-video ────────────────────────────────────────────────────────


      // ── /setup-verify ──────────────────────────────────────────────────────
      if (cmd === 'setup-verify') {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const settings = await getGuildSettings(guild.id);
        let verifiedRole = (settings.verifiedRoleId && guild.roles.cache.get(settings.verifiedRoleId))
          || guild.roles.cache.find(r => r.name === settings.verifiedRoleName);
        if (!verifiedRole) verifiedRole = await guild.roles.create({ name: settings.verifiedRoleName, color: 0x5865f2 });
        const everyoneRole = guild.roles.everyone;
        const botRole = guild.members.me.roles.highest;
        await guild.channels.fetch();
        // Channel IDs that Verified role is allowed to see (besides get-verify)
        // NOTE: still hardcoded to your original server's specific channels —
        // a genuine per-guild "which channels are public" setting is a
        // reasonable next addition, but out of scope for this pass.
        const VERIFIED_ALLOWED_IDS = [
          '1481172050801463367', // support channel
          '1242139449320804393', // Support 1 voice
        ];
        let verifyCh = (settings.verifyChannelId && guild.channels.cache.get(settings.verifyChannelId))
          || findChannelByName(guild, settings.verifyChannelName);
        if (!verifyCh) verifyCh = await guild.channels.create({ name: settings.verifyChannelName, type: ChannelType.GuildText });
        for (const [, ch] of guild.channels.cache) {
          if (ch.id === verifyCh.id) continue;
          try {
            await ch.permissionOverwrites.edit(everyoneRole, { ViewChannel: false, SendMessages: false });
            await ch.permissionOverwrites.edit(botRole, { ViewChannel: true, SendMessages: true });
            if (VERIFIED_ALLOWED_IDS.includes(ch.id)) {
              await ch.permissionOverwrites.edit(verifiedRole, { ViewChannel: true, SendMessages: true });
            } else {
              await ch.permissionOverwrites.edit(verifiedRole, { ViewChannel: false });
            }
          } catch (_) {}
        }
        await verifyCh.permissionOverwrites.edit(everyoneRole, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true });
        await verifyCh.permissionOverwrites.edit(verifiedRole, { ViewChannel: true, SendMessages: false });
        try { const msgs = await verifyCh.messages.fetch({ limit: 10 }); await verifyCh.bulkDelete(msgs); } catch (_) {}
        const embed = new EmbedBuilder()
          .setTitle('🔐 Verify to Access the Server')
          .setDescription('Welcome! To gain access to all channels, click the **Verify** button below.\n\nBy verifying, you agree to follow our server rules.')
          .setColor(0x5865f2).setFooter({ text: 'Click once — verification is instant!' });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('verify_button').setLabel('✅ Verify Me').setStyle(ButtonStyle.Primary)
        );
        await verifyCh.send({ embeds: [embed], components: [row] });
        await interaction.editReply('✅ Done!'); autoDelete(interaction, 5000);
        return;
      }

      // ── /setup-invites ────────────────────────────────────────────────────
      if (cmd === 'setup-invites') {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const settings = await getGuildSettings(guild.id);
        let invCh = (settings.invitesChannelId && guild.channels.cache.get(settings.invitesChannelId)) || findChannelByName(guild, settings.invitesChannelName);
        if (!invCh) invCh = await guild.channels.create({ name: settings.invitesChannelName, type: ChannelType.GuildText });
        await invCh.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        try { const msgs = await invCh.messages.fetch({ limit: 10 }); await invCh.bulkDelete(msgs); } catch (_) {}
        const embed = new EmbedBuilder()
          .setTitle('🎉 Invite Your Friends & Earn Rewards!')
          .setDescription(`Invite your friends and earn **free keys**!\n\n**How it works:**\n1️⃣ Click **Your Invite Link** to get your link\n2️⃣ Share it with friends\n3️⃣ Once you have **${settings.invitesNeeded} real invites**, click **Redeem Your Key**!\n\nRedeem **unlimited times** — every ${settings.invitesNeeded} invites = 1 free key 🔑\n\n⚠️ *Fake invites & users who leave don't count!*`)
          .setColor(0x5865f2).setTimestamp().setFooter({ text: 'Invite Reward System' });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('get_invite_link').setLabel('🔗 Your Invite Link').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('check_invites').setLabel('📊 Check Your Invites').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('redeem_key').setLabel('🎁 Redeem Your Key').setStyle(ButtonStyle.Success),
        );
        await invCh.send({ embeds: [embed], components: [row] });
        await interaction.editReply('✅ Invite system set up!'); autoDelete(interaction, 5000);
        return;
      }

      // ── /postupdate ────────────────────────────────────────────────────────
      if (cmd === 'postupdate') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const select = new StringSelectMenuBuilder()
          .setCustomId('select_update_type').setPlaceholder('Select update type...')
          .addOptions(Object.entries(UPDATE_TYPES).map(([val, { label, emoji }]) =>
            new StringSelectMenuOptionBuilder().setLabel(label).setValue(val).setEmoji(emoji)
          ));
        await interaction.reply({ content: '### 📋 New Product Update\nSelect the **update type** to continue:', components: [new ActionRowBuilder().addComponents(select)], flags: 64 });
        autoDelete(interaction, 60000);
        return;
      }

      // ── /announce ──────────────────────────────────────────────────────────
      if (cmd === 'announce') {
        const modal = new ModalBuilder().setCustomId('announce_modal').setTitle('📣 New Announcement');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_title').setLabel('TITLE').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_message').setLabel('MESSAGE').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_download').setLabel('DOWNLOAD LINK (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_channel').setLabel('POST TO CHANNEL (name or ID, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_ping').setLabel('PING (everyone / here / role name)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
        );
        return interaction.showModal(modal);
      }

      // ── /downloads ────────────────────────────────────────────────────────
      if (cmd === 'downloads') {
        const chunks = getProductChunks();
        const makeMenu = (id, placeholder, chunk) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
          .addOptions(chunk.map(p => ({ label: p.name.length > 100 ? p.name.slice(0,97)+'...' : p.name, value: p.id, description: p.url ? 'Download available' : 'Coming soon' })));
        await interaction.reply({
          content: '### Product Downloads\nSelect your product below:',
          components: [
            new ActionRowBuilder().addComponents(makeMenu('dl_page_1', 'Products A-F  (Page 1 of 3)', chunks[0] || [])),
            new ActionRowBuilder().addComponents(makeMenu('dl_page_2', 'Products G-R  (Page 2 of 3)', chunks[1] || [])),
            new ActionRowBuilder().addComponents(makeMenu('dl_page_3', 'Products S-Z + HWID  (Page 3 of 3)', chunks[2] || [])),
          ],
          flags: 64,
        });
        autoDelete(interaction, 120000);
        return;
      }

      // ── /setupdownloads ───────────────────────────────────────────────────
      if (cmd === 'setupdownloads') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const dlCh = findChannelByName(interaction.guild, 'downloads') || interaction.channel;
        const chunks = getProductChunks();
        const makeMenu = (id, placeholder, chunk) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
          .addOptions(chunk.map(p => ({ label: p.name.length > 100 ? p.name.slice(0,97)+'...' : p.name, value: p.id, description: p.url ? 'Download available' : 'Coming soon' })));
        const embed = new EmbedBuilder().setTitle('📦  PRODUCT DOWNLOADS').setColor(0x5865F2)
          .setDescription('> Select your product from the dropdown below and click **DOWNLOAD** to get your file.')
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        await dlCh.send({ embeds: [embed], components: [
          new ActionRowBuilder().addComponents(makeMenu('dl_page_1', 'Products A-F  (Page 1 of 3)', chunks[0] || [])),
          new ActionRowBuilder().addComponents(makeMenu('dl_page_2', 'Products G-R  (Page 2 of 3)', chunks[1] || [])),
          new ActionRowBuilder().addComponents(makeMenu('dl_page_3', 'Products S-Z + HWID  (Page 3 of 3)', chunks[2] || [])),
        ]});
        await interaction.reply({ content: `✅ Download panel posted in <#${dlCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /setdownload ──────────────────────────────────────────────────────
      if (cmd === 'setdownload') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const productId = interaction.options.getString('product');
        let url = interaction.options.getString('url').trim();
        if (url && !url.startsWith('http')) url = 'https://' + url;
        const product = getProduct(productId);
        if (!product) return interaction.reply({ content: '❌ Product not found.', flags: 64 });
        setProductUrl(productId, url);
        await interaction.reply({ content: `✅ Download link updated for **${product.name}**\n🔗 ${url}`, flags: 64 });
        autoDelete(interaction, 8000);
        return;
      }

      // ── /setwebsite ───────────────────────────────────────────────────────
      if (cmd === 'setwebsite') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        let url = interaction.options.getString('url').trim();
        if (url && !url.startsWith('http')) url = 'https://' + url;
        const wsCh = findChannelByName(interaction.guild, 'website') || interaction.channel;
        const displayUrl = url.replace(/^https?:\/\//, '');
        const embed = new EmbedBuilder().setDescription(`### [${displayUrl}](${url})`).setColor(0x5865F2).setTimestamp();
        const gKey = interaction.guild.id;
        const existing = websiteMessages[gKey];
        if (existing) {
          try {
            const ch = await client.channels.fetch(existing.channelId);
            const msg = await ch.messages.fetch(existing.messageId);
            await msg.edit({ content: '', embeds: [embed] });
            await interaction.reply({ content: `✅ Website updated to **${url}** in <#${existing.channelId}>`, flags: 64 }); autoDelete(interaction, 5000); return;
          } catch (_) {}
        }
        const msg = await wsCh.send({ content: '', embeds: [embed] });
        websiteMessages[gKey] = { channelId: wsCh.id, messageId: msg.id };
        await interaction.reply({ content: `📌 Website posted in <#${wsCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /postimage ────────────────────────────────────────────────────────
      if (cmd === 'postimage') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const attachment = interaction.options.getAttachment('image');
        const message    = interaction.options.getString('message') || null;
        const chanName   = interaction.options.getString('channel') || null;
        let targetCh = interaction.channel;
        if (chanName) {
          const found = findChannelByName(interaction.guild, chanName.replace('#',''));
          if (found) targetCh = found;
        }
        await targetCh.send({ content: message, files: [attachment.url] });
        await interaction.reply({ content: `✅ Image posted to <#${targetCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /setupreseller ────────────────────────────────────────────────────
      if (cmd === 'setupreseller') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const resCh = findChannelByName(interaction.guild, 'reseller') || interaction.channel;
        const embed = new EmbedBuilder().setColor(0x5865F2).setDescription(
          '# UH SERVICES IS LOOKING FOR RESELLERS\n\n**Did you know you can make up to $5000+ monthly reselling our products?**\n\n## Why Start Reselling?\n- All keys are bought through our **centralized panel**, where you can **generate, manage, reset, and freeze keys**\n- We provide **10+** of the **markets leading products**\n- We offer all of our resellers a **minimum discount of 50% off keys** right away\n- We take care of the hard part. **Development, testing, updates, and more are all handled by us**\n- We offer **priority support** in your personal ticket\n- We provide **tips on how to grow and expand** your brand\n- We offer **dynamic delivery** so you can link your site to our panel for seamless product delivery\n- **Pressure free environment**, we don\'t force you to deposit\n- Access to a community of over **100+ successful resellers**'
        );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('APPLY HERE!').setEmoji('📋').setStyle(ButtonStyle.Link).setURL(resellerLinks.apply),
          new ButtonBuilder().setLabel('Preview Panel').setEmoji('👀').setStyle(ButtonStyle.Link).setURL(resellerLinks.panel),
        );
        const gKey = interaction.guild.id;
        const existing = resellerMessages[gKey];
        if (existing) {
          try {
            const ch = await client.channels.fetch(existing.channelId);
            const msg = await ch.messages.fetch(existing.messageId);
            await msg.edit({ embeds: [embed], components: [row] });
            await interaction.editReply({ content: `✅ Reseller panel updated in <#${existing.channelId}>` }); autoDelete(interaction, 5000); return;
          } catch (_) {}
        }
        const msg = await resCh.send({ embeds: [embed], components: [row] });
        resellerMessages[gKey] = { channelId: resCh.id, messageId: msg.id };
        await interaction.editReply({ content: `✅ Reseller panel posted in <#${resCh.id}>` }); autoDelete(interaction, 5000);
        return;
      }

      // ── /setresellerlinks ─────────────────────────────────────────────────
      if (cmd === 'setresellerlinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('reseller_links_modal').setTitle('Update Reseller Button Links');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reseller_apply_url').setLabel('APPLY HERE! — Button URL').setStyle(TextInputStyle.Short).setValue(resellerLinks.apply).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reseller_panel_url').setLabel('Preview Panel — Button URL').setStyle(TextInputStyle.Short).setValue(resellerLinks.panel).setRequired(true)),
        );
        return interaction.showModal(modal);
      }

      // ── /postlink ──────────────────────────────────────────────────────────
      if (cmd === 'postlink') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const chanInput = interaction.options.getString('channel');
        // Stash the target channel name/ID on the customId so the modal submit handler can read it back.
        const customId = chanInput ? `postlink_modal::${chanInput.replace('#', '').slice(0, 90)}` : 'postlink_modal';
        const modal = new ModalBuilder().setCustomId(customId).setTitle('🔗 Post a Useful Link');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('postlink_title').setLabel('TITLE').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(150)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('postlink_url').setLabel('URL').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)),
        );
        return interaction.showModal(modal);
      }

      // ── /setcompetitors ───────────────────────────────────────────────────
      if (cmd === 'setcompetitors') {
        if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: '❌ Admin only.', flags: 64 });
        const ids = interaction.options.getString('guild_ids').split(',').map(s => s.trim()).filter(Boolean);
        const role = interaction.options.getRole('flag_role');
        const logChan = interaction.options.getString('log_channel');
        competitorWatch.guildIds = ids;
        if (role) competitorWatch.roleId = role.id;
        if (logChan) competitorWatch.logChannel = logChan.replace('#', '');
        await interaction.reply({
          content: `✅ Watching ${ids.length} server ID(s) for shared members.\n` +
                    `Flag role: ${competitorWatch.roleId ? `<@&${competitorWatch.roleId}>` : '*none set*'}\n` +
                    `Log channel: #${competitorWatch.logChannel}\n\n` +
                    `ℹ️ This only detects servers the bot itself is a member of — it can't see servers it's not in.`,
          flags: 64,
        });
        return;
      }

      // ── /giveaway ──────────────────────────────────────────────────────────
      if (cmd === 'giveaway') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const prize       = interaction.options.getString('prize');
        const durStr      = interaction.options.getString('duration');
        const winnerCount = interaction.options.getInteger('winners') || 1;
        const imageUrl    = interaction.options.getString('image') || null;
        const chanName    = interaction.options.getString('channel') || null;
        const durMs       = parseDuration(durStr);
        if (!durMs) return interaction.reply({ content: '❌ Invalid duration. Use formats like `10m`, `1h`, `2d`, `1w`, `1mo`.', flags: 64 });

        let targetCh = interaction.channel;
        if (chanName) { const f = interaction.guild.channels.cache.get(chanName) || findChannelByName(interaction.guild, chanName.replace('#','')); if (f) targetCh = f; }

        const endsAt  = new Date(Date.now() + durMs);
        const endsTs  = `<t:${Math.floor(endsAt.getTime() / 1000)}:F>`;

        const embed = new EmbedBuilder()
          .setColor(0x9B59B6)
          .setAuthor({ name: BOT_NAME, iconURL: client.user.displayAvatarURL() })
          .setTitle(`🎁 ${prize}`)
          .setDescription(`Click the button below to enter the giveaway!\n\n🏆 **Winners:** ${winnerCount}\n⏰ **Ends:** ${endsTs}`)
          .setThumbnail(client.user.displayAvatarURL())
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() })
          .setTimestamp(endsAt);
        if (imageUrl) embed.setImage(imageUrl);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('giveaway_enter').setLabel('🎉 Participate (0)').setStyle(ButtonStyle.Primary),
        );

        await interaction.deferReply({ ephemeral: true });
        const msg = await targetCh.send({ content: '@everyone', embeds: [embed], components: [row] });

        giveaways.set(msg.id, { prize, channelId: targetCh.id, guildId: interaction.guild.id, endsAt: endsAt.toISOString(), participants: new Set(), ended: false, winnerCount });
        saveGiveaways();

        // Schedule auto-end
        safeSetTimeout(async () => {
          const gw = giveaways.get(msg.id);
          if (!gw || gw.ended) return;
          gw.ended = true;
          saveGiveaways();
          const participants = [...gw.participants];
          const count   = gw.winnerCount || 1;
          const winners = pickWinners(participants, count);
          const winnersText = winners.length ? winners.map(w => `<@${w}>`).join(', ') : null;

          // Edit original embed to [ENDED]
          try {
            const endedEmbed = new EmbedBuilder()
              .setColor(0x95A5A6)
              .setAuthor({ name: BOT_NAME, iconURL: client.user.displayAvatarURL() })
              .setTitle(`🎁 ${prize} [ENDED]`)
              .setDescription(`This giveaway has ended!\n\n**${winners.length > 1 ? 'Winners' : 'Winner'}:** ${winnersText || 'No participants'}`)
              .setThumbnail(client.user.displayAvatarURL())
              .setFooter({ text: `Ended on ${endsAt.toUTCString()}`, iconURL: client.user.displayAvatarURL() });
            if (imageUrl) endedEmbed.setImage(imageUrl);
            const disabledRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('giveaway_enter').setLabel(`🎉 Participate (${participants.length})`).setStyle(ButtonStyle.Primary).setDisabled(true),
            );
            const gwCh = await client.channels.fetch(gw.channelId);
            const gwMsg = await gwCh.messages.fetch(msg.id);
            await gwMsg.edit({ embeds: [endedEmbed], components: [disabledRow] });

            // Post results embed
            const resultsEmbed = new EmbedBuilder()
              .setColor(0x2ECC71)
              .setTitle(`🎁 ${prize} [RESULTS]`)
              .setDescription(`The ${winners.length > 1 ? 'winners are' : 'winner is'} tagged above! Congratulations 🎉`)
              .addFields(
                { name: 'Prize', value: prize, inline: false },
                { name: 'Winners', value: `${winners.length}`, inline: false },
                { name: 'Participants', value: `${participants.length}`, inline: false },
              )
              .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() })
              .setTimestamp();
            await gwCh.send({ content: winnersText || '❌ No participants — no winner.', embeds: [resultsEmbed] });
          } catch (e) { console.error('Giveaway end error:', e); }
        }, durMs);

        await interaction.editReply({ content: `✅ Giveaway started in <#${targetCh.id}>! Ends ${endsTs}` }); autoDelete(interaction, 8000);
        return;
      }

      // ── /setupvouch ────────────────────────────────────────────────────────
      if (cmd === 'setupvouch') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const chanName    = interaction.options.getString('channel') || null;
        const resultsName = interaction.options.getString('results_channel') || null;
        const vSettings = await getGuildSettings(interaction.guild.id);

        // Panel channel: defaults to #leave-vouch (or this server's configured channel)
        let targetCh = (vSettings.leaveVouchChannelId && interaction.guild.channels.cache.get(vSettings.leaveVouchChannelId)) || interaction.channel;
        if (chanName) { const f = interaction.guild.channels.cache.get(chanName) || findChannelByName(interaction.guild, chanName.replace('#','')); if (f) targetCh = f; }

        // Results channel: defaults to #vouches (or this server's configured channel)
        let resultsCh = (vSettings.vouchesChannelId && interaction.guild.channels.cache.get(vSettings.vouchesChannelId)) || targetCh;
        if (resultsName) { const f = interaction.guild.channels.cache.get(resultsName) || findChannelByName(interaction.guild, resultsName.replace('#','')); if (f) resultsCh = f; }

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('📝 Leave a Vouch')
          .setDescription('We value your feedback!\nClick the button below to leave a vouch.\n\n**Your feedback helps us grow** 💡')
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('leave_vouch').setLabel('📝 Leave a Vouch').setStyle(ButtonStyle.Primary),
        );
        await targetCh.send({ embeds: [embed], components: [row] });
        // Store which channel to post received vouches into
        const existing = vouchData.get(interaction.guild.id) || { count: 0, channelId: resultsCh.id, entries: [] };
        existing.channelId = resultsCh.id;
        vouchData.set(interaction.guild.id, existing);
        saveVouches();
        await interaction.reply({ content: `✅ Vouch panel posted in <#${targetCh.id}> — results will go to <#${resultsCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /exportvouches ────────────────────────────────────────────────────
      if (cmd === 'exportvouches') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const gData = vouchData.get(interaction.guild.id) || { count: 0, channelId: null, entries: [] };
        const backup = {
          exportedFrom: interaction.guild.id,
          exportedAt: new Date().toISOString(),
          count: gData.count,
          entries: gData.entries || [],
        };
        const buf = Buffer.from(JSON.stringify(backup, null, 2), 'utf8');
        const file = new AttachmentBuilder(buf, { name: `vouches-backup-${interaction.guild.id}.json` });
        await interaction.reply({
          content: `✅ Exported **${backup.entries.length}** vouch${backup.entries.length === 1 ? '' : 'es'}. Keep this file safe — use \`/importvouches\` on a new server to restore.`,
          files: [file],
          flags: 64,
        });
        return;
      }

      // ── /importvouches ────────────────────────────────────────────────────
      if (cmd === 'importvouches') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });
        const attachment = interaction.options.getAttachment('file');
        const repost = interaction.options.getBoolean('repost') ?? true;

        if (!attachment || !attachment.name?.toLowerCase().endsWith('.json')) {
          return interaction.editReply({ content: '❌ Please attach the `.json` backup file from `/exportvouches`.' });
        }

        let backup;
        try {
          const res = await fetch(attachment.url);
          const text = await res.text();
          backup = JSON.parse(text);
        } catch (e) {
          console.error('Import vouches parse error:', e);
          return interaction.editReply({ content: '❌ Could not read that file — is it a valid vouches backup .json?' });
        }

        const incoming = Array.isArray(backup.entries) ? backup.entries : null;
        if (!incoming) {
          return interaction.editReply({ content: '❌ That file doesn\'t look like a vouches backup (missing `entries`).' });
        }

        const ivSettings = await getGuildSettings(interaction.guild.id);
        const gData = vouchData.get(interaction.guild.id) || { count: 0, channelId: ivSettings.vouchesChannelId, entries: [] };
        gData.entries = gData.entries || [];

        const vouchCh =
          (ivSettings.vouchesChannelId && interaction.guild.channels.cache.get(ivSettings.vouchesChannelId)) ||
          (gData.channelId && interaction.guild.channels.cache.get(gData.channelId));

        let imported = 0;
        for (const old of incoming) {
          const newId = ++gData.count;
          const entry = {
            id: newId,
            userId: old.userId || null,
            username: old.username || 'Unknown',
            rating: Math.min(5, Math.max(1, parseInt(old.rating) || 1)),
            feedback: old.feedback || '',
            imageUrl: old.imageUrl || null,
            timestamp: old.timestamp || new Date().toISOString(),
            importedFrom: backup.exportedFrom || null,
          };
          gData.entries.push(entry);
          imported++;

          if (repost && vouchCh) {
            const stars = '⭐'.repeat(entry.rating);
            const embed = new EmbedBuilder()
              .setColor(0x2ECC71)
              .setTitle('New Vouch Received 🎉')
              .addFields(
                { name: 'Vouch ID', value: `Nº ${entry.id}`, inline: false },
                { name: 'Rating', value: stars, inline: false },
                { name: 'Feedback', value: entry.feedback || '—', inline: false },
                { name: 'Vouched By', value: entry.userId ? `<@${entry.userId}>` : entry.username, inline: false },
                { name: 'Vouched At', value: `<t:${Math.floor(new Date(entry.timestamp).getTime() / 1000)}:R>`, inline: false },
              )
              .setFooter({ text: `Imported backup | ${BOT_NAME}`, iconURL: client.user.displayAvatarURL() });
            if (entry.imageUrl && /^https?:\/\//i.test(entry.imageUrl)) embed.setImage(entry.imageUrl);
            try { const rm = await vouchCh.send({ embeds: [embed] }); await rm.react('💯'); await rm.react('🔥'); } catch (_) {}
          }
        }

        vouchData.set(interaction.guild.id, gData);
        saveVouches();

        await interaction.editReply({
          content: `✅ Imported **${imported}** vouch${imported === 1 ? '' : 'es'} from backup${repost ? ` and reposted them in <#${vouchCh?.id || ivSettings.vouchesChannelId}>` : ' (silently, no repost)'}.`,
        });
        return;
      }

      // ── /addstock ─────────────────────────────────────────────────────────
      if (cmd === 'addstock') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });

        const type       = normalizeStockType(interaction.options.getString('type'));
        const attachment = interaction.options.getAttachment('file');
        const pasted     = interaction.options.getString('accounts');

        let raw = '';
        if (attachment) {
          try {
            const res = await fetch(attachment.url);
            raw += (await res.text()) + '\n';
          } catch (e) {
            console.error('addstock file fetch error:', e);
            return interaction.editReply({ content: '❌ Could not read that file.' });
          }
        }
        if (pasted) raw += pasted + '\n';

        if (!raw.trim()) {
          return interaction.editReply({ content: '❌ Provide either a `file` or paste `accounts` (one per line).' });
        }

        const lines = raw.split(/[\r\n,]+/).map(l => l.trim()).filter(Boolean);
        if (!lines.length) {
          return interaction.editReply({ content: '❌ No valid lines found.' });
        }

        await addStockAccounts(interaction.guild.id, type, lines);
        const totalNow = await getStockCount(interaction.guild.id, type);

        await interaction.editReply({
          content: `✅ Added **${lines.length}** account${lines.length === 1 ? '' : 's'} to **${type}**. Total in stock: **${totalNow}**.`,
        });
        return;
      }

      // ── /stock ────────────────────────────────────────────────────────────
      if (cmd === 'stock') {
        await interaction.reply({ embeds: [await buildStockEmbed(interaction.guild.id)], flags: 64 });
        return;
      }

      // ── /gensteam ─────────────────────────────────────────────────────────
      if (cmd === 'gensteam') {
        if (!await canAccessStock(interaction.member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }
        const type = normalizeStockType(interaction.options.getString('type'));
        return claimStockAccount(interaction, type);
      }

      // ── /postgensteam ────────────────────────────────────────────────────
      if (cmd === 'postgensteam') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const channel = interaction.options.getChannel('channel') || interaction.channel;

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('⚙️ Account Generator')
          .setDescription(
            `Click a button below to generate an account.\n\n` +
            `You need the **💎 Gen Member** role (or higher) to use this.\n` +
            `Limit: one account per person every **${STOCK_COOLDOWN_HOURS}h**, per account type. Staff/OVERSEER have no limit.`
          )
          .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

        const genRow = new ActionRowBuilder().addComponents(
          ...GEN_PANEL_TYPES.map(t =>
            new ButtonBuilder().setCustomId(`gensteam_claim::${t.type}`).setLabel(t.label).setEmoji(t.emoji).setStyle(ButtonStyle.Primary)
          )
        );
        const utilRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('gensteam_check_stock').setLabel('Check Stock').setEmoji('📦').setStyle(ButtonStyle.Secondary)
        );

        await channel.send({ embeds: [embed], components: [genRow, utilRow] });
        await interaction.reply({ content: `✅ Posted the generator panel in <#${channel.id}>.`, flags: 64 });
        return;
      }

      // ── /clearstock ──────────────────────────────────────────────────────
      if (cmd === 'clearstock') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const confirm = interaction.options.getBoolean('confirm');
        if (!confirm) {
          return interaction.reply({ content: '⚠️ Set `confirm` to **True** to actually clear stock — this cannot be undone.', flags: 64 });
        }

        const typeArg = interaction.options.getString('type');
        const type = typeArg ? normalizeStockType(typeArg) : null;
        const { removed, types } = await clearStockDB(interaction.guild.id, type);

        if (type) {
          return interaction.reply({ content: `🗑️ Cleared **${removed}** account${removed === 1 ? '' : 's'} from **${type}**.`, flags: 64 });
        }
        return interaction.reply({
          content: `🗑️ Cleared **${removed}** account${removed === 1 ? '' : 's'} across **${types}** type${types === 1 ? '' : 's'}. Stock is now empty.`,
          flags: 64,
        });
      }

      // ── /postusefullinks ─────────────────────────────────────────────────
      if (cmd === 'postusefullinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const channel = interaction.options.getChannel('channel') || interaction.channel;
        const embed = await buildUsefulLinksEmbed(interaction.guild.id);
        const links = await getUsefulLinks(interaction.guild.id);

        await channel.send({ embeds: [embed] });
        await interaction.reply({ content: `✅ Posted **${links.length}** links in <#${channel.id}>.`, flags: 64 });
        return;
      }

      // ── /addusefullink ───────────────────────────────────────────────────
      if (cmd === 'addusefullink') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const title = interaction.options.getString('title');
        const url   = interaction.options.getString('url');

        try { new URL(url); } catch (_) {
          return interaction.reply({ content: '❌ That doesn\'t look like a valid URL — make sure it starts with `https://`.', flags: 64 });
        }

        await addUsefulLink(interaction.guild.id, title, url);
        const links = await getUsefulLinks(interaction.guild.id);

        return interaction.reply({
          content: `✅ Added **${title}** as link **#${links.length}**. Run \`/postusefullinks\` to repost the updated list.`,
          flags: 64,
        });
      }

      // ── /removeusefullink ────────────────────────────────────────────────
      if (cmd === 'removeusefullink') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const number  = interaction.options.getInteger('number');
        const removed = await removeUsefulLinkByNumber(interaction.guild.id, number);

        if (!removed) {
          return interaction.reply({ content: `❌ No link at #${number}. Run \`/listusefullinks\` to see current numbers.`, flags: 64 });
        }

        return interaction.reply({
          content: `🗑️ Removed **${removed.label}**. Run \`/postusefullinks\` to repost the updated list.`,
          flags: 64,
        });
      }

      // ── /listusefullinks ─────────────────────────────────────────────────
      if (cmd === 'listusefullinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        return interaction.reply({ embeds: [await buildUsefulLinksEmbed(interaction.guild.id)], flags: 64 });
      }

      // ── /clearusefullinks ────────────────────────────────────────────────
      if (cmd === 'clearusefullinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const confirm = interaction.options.getBoolean('confirm');
        if (!confirm) {
          return interaction.reply({ content: '⚠️ Set `confirm` to **True** to actually clear the list — this cannot be undone.', flags: 64 });
        }

        const removed = await clearUsefulLinks(interaction.guild.id);
        return interaction.reply({ content: `🗑️ Cleared **${removed}** link${removed === 1 ? '' : 's'}. List is now empty.`, flags: 64 });
      }

      // ── /importusefullinks ───────────────────────────────────────────────
      if (cmd === 'importusefullinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });

        const attachment = interaction.options.getAttachment('file');
        const pasted      = interaction.options.getString('links');
        const mode         = interaction.options.getString('mode') || 'append';

        let raw = '';
        if (attachment) {
          try {
            const res = await fetch(attachment.url);
            raw += (await res.text()) + '\n';
          } catch (e) {
            console.error('importusefullinks file fetch error:', e);
            return interaction.editReply({ content: '❌ Could not read that file.' });
          }
        }
        if (pasted) raw += pasted + '\n';

        if (!raw.trim()) {
          return interaction.editReply({ content: '❌ Provide either a `file` or paste `links` — one per line, formatted `Title - https://url`.' });
        }

        const { parsed, skipped } = parseUsefulLinksBulk(raw);

        if (!parsed.length) {
          return interaction.editReply({ content: '❌ No valid lines found. Each line needs to look like `Title - https://example.com`.' });
        }

        await bulkInsertUsefulLinks(interaction.guild.id, parsed, mode);
        const totalNow = (await getUsefulLinks(interaction.guild.id)).length;

        let msg = `✅ ${mode === 'replace' ? 'Replaced the list with' : 'Added'} **${parsed.length}** link${parsed.length === 1 ? '' : 's'}. Total now: **${totalNow}**.`;
        if (skipped.length) {
          msg += `\n⚠️ Skipped **${skipped.length}** line${skipped.length === 1 ? '' : 's'} that didn't match \`Title - https://url\`:\n` +
            skipped.slice(0, 5).map(l => `\`${l.slice(0, 80)}\``).join('\n') +
            (skipped.length > 5 ? `\n...and ${skipped.length - 5} more` : '');
        }
        msg += `\nRun \`/postusefullinks\` to repost the updated list.`;

        return interaction.editReply({ content: msg });
      }

      // ── /genkey ──────────────────────────────────────────────────────────
      if (cmd === 'genkey') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const role        = interaction.options.getRole('role');
        const durationStr = interaction.options.getString('duration');
        const amount      = interaction.options.getInteger('amount') || 1;

        const durationMs = parseKeyDuration(durationStr);
        if (durationMs === null) {
          return interaction.reply({ content: '❌ Invalid duration.', flags: 64 });
        }

        const DURATION_LABELS = {
          lifetime: 'Lifetime', '365d': '1 Year', '90d': '3 Months', '30d': '1 Month',
          '14d': '2 Weeks', '3d': '3 Days', '1d': '1 Day', '5m': '5 Minutes',
        };
        const durationLabel = DURATION_LABELS[durationStr] || durationStr;

        const generated = [];
        for (let i = 0; i < amount; i++) {
          const key = await generateKeyString();
          await createKeyRow({
            key,
            guildId: interaction.guild.id,
            roleId: role.id,
            roleName: role.name,
            durationMs,
            createdBy: interaction.user.id,
          });
          generated.push(key);
        }

        return interaction.reply({
          content: `✅ Generated **${amount}** key${amount === 1 ? '' : 's'} for **${role.name}** (${durationLabel}):\n` +
            generated.map(k => `\`${k}\``).join('\n') +
            `\n\nEach works once with \`/redeem\` — keep them safe.`,
          flags: 64,
        });
      }

      // ── /redeem ──────────────────────────────────────────────────────────
      if (cmd === 'redeem') {
        return redeemKey(interaction, interaction.options.getString('key'));
      }

      // ── /listkeys ────────────────────────────────────────────────────────
      if (cmd === 'listkeys') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const { rows } = await db.query(
          `SELECT * FROM keys WHERE guild_id = $1 AND status IN ('unredeemed','active') ORDER BY created_at DESC`,
          [interaction.guild.id]
        );
        const entries    = rows.map(rowToKeyEntry);
        const unredeemed = entries.filter(e => e.status === 'unredeemed');
        const active     = entries.filter(e => e.status === 'active');

        const fmtUnredeemed = unredeemed.length
          ? unredeemed.slice(0, 15).map(e => `\`${e.key}\` — ${e.roleName}`).join('\n') +
            (unredeemed.length > 15 ? `\n...and ${unredeemed.length - 15} more` : '')
          : 'None';

        const fmtActive = active.length
          ? active.slice(0, 15).map(e => {
              const expiry = e.expiresAt
                ? `expires <t:${Math.floor(new Date(e.expiresAt).getTime() / 1000)}:R>`
                : 'lifetime — never expires';
              return `<@${e.redeemedBy}> — ${e.roleName} — ${expiry}`;
            }).join('\n') + (active.length > 15 ? `\n...and ${active.length - 15} more` : '')
          : 'None';

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('🔑 Keys')
          .addFields(
            { name: `Unredeemed (${unredeemed.length})`, value: fmtUnredeemed, inline: false },
            { name: `Active (${active.length})`, value: fmtActive, inline: false },
          )
          .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // ── /revokekey ───────────────────────────────────────────────────────
      if (cmd === 'revokekey') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const keyInput = interaction.options.getString('key').trim().toUpperCase();
        const entry = await getKeyEntry(keyInput);

        if (!entry) return interaction.reply({ content: '❌ That key doesn\'t exist.', flags: 64 });
        if (entry.status === 'revoked' || entry.status === 'expired') {
          return interaction.reply({ content: `❌ That key is already ${entry.status}.`, flags: 64 });
        }

        if (entry.status === 'active' && entry.redeemedBy) {
          try {
            const member = await interaction.guild.members.fetch(entry.redeemedBy).catch(() => null);
            const role   = interaction.guild.roles.cache.get(entry.roleId);
            if (member && role && member.roles.cache.has(role.id)) {
              await member.roles.remove(role);
            }
          } catch (e) { console.error('[keys] revoke role removal error:', e); }
        }

        await markKeyStatus(keyInput, 'revoked');
        return interaction.reply({ content: `🗑️ Key \`${keyInput}\` revoked.`, flags: 64 });
      }

      // ── /postredeem ──────────────────────────────────────────────────────
      if (cmd === 'postredeem') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const channel = interaction.options.getChannel('channel') || interaction.channel;

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('🔑 Redeem Your Key')
          .setDescription(
            `**Instructions:**\n` +
            `• Click the button below to open the redeem form.\n` +
            `• Enter your key exactly as it was sent to you.\n` +
            `• Once submitted, your role will be activated automatically.\n\n` +
            `If you need help, open a support ticket.`
          )
          .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('redeem_open_modal').setLabel('Redeem Key').setEmoji('🔑').setStyle(ButtonStyle.Primary)
        );

        await channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: `✅ Posted the redeem panel in <#${channel.id}>.`, flags: 64 });
        return;
      }

      // ── /set-tos, /set-rules, /set-guide ────────────────────────────────
      if (cmd === 'set-tos' || cmd === 'set-rules' || cmd === 'set-guide' || cmd === 'set-payment-method') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const key = cmd.replace('set-', '');
        const meta = CONTENT_TYPES[key];
        const attachment = interaction.options.getAttachment('file');

        if (attachment) {
          await interaction.deferReply({ ephemeral: true });
          let body;
          try {
            const res = await fetch(attachment.url);
            body = (await res.text()).trim();
          } catch (e) {
            console.error('set-content file fetch error:', e);
            return interaction.editReply({ content: '❌ Could not read that file.' });
          }
          if (!body) return interaction.editReply({ content: '❌ That file is empty.' });

          const existing = await getGuildContent(interaction.guild.id, key);
          const title = existing?.title || meta.defaultTitle;
          await setGuildContent(interaction.guild.id, key, title, body.slice(0, 4000), interaction.user.id);
          return interaction.editReply({ content: `✅ ${meta.label} updated from file. Run \`/post-${key}\` to post it.` });
        }

        // No file — open a popup form instead
        const existing = await getGuildContent(interaction.guild.id, key);
        const modal = new ModalBuilder().setCustomId(`set_content_modal::${key}`).setTitle(`Set ${meta.label}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('content_title').setLabel('Title').setStyle(TextInputStyle.Short)
              .setValue(existing?.title || meta.defaultTitle).setRequired(true).setMaxLength(256)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('content_body').setLabel('Content').setStyle(TextInputStyle.Paragraph)
              .setValue(existing?.body || '').setRequired(true).setMaxLength(4000)
          )
        );
        return interaction.showModal(modal);
      }

      // ── /post-tos, /post-rules, /post-guide ──────────────────────────────
      if (cmd === 'post-tos' || cmd === 'post-rules' || cmd === 'post-guide' || cmd === 'post-payment-method') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const key = cmd.replace('post-', '');
        const meta = CONTENT_TYPES[key];

        const embed = await buildContentEmbed(interaction.guild.id, key);
        if (!embed) {
          return interaction.reply({ content: `❌ No ${meta.label} content set yet. Run \`/set-${key}\` first.`, flags: 64 });
        }

        const channel = interaction.options.getChannel('channel') || interaction.channel;
        await channel.send({ embeds: [embed] });
        await interaction.reply({ content: `✅ Posted ${meta.label} in <#${channel.id}>.`, flags: 64 });
        return;
      }

      // ── /listguilds ──────────────────────────────────────────────────────
      if (cmd === 'listguilds') {
        if (!isBotOwner(interaction)) return interaction.reply({ content: '❌ Owner only.', flags: 64 });

        const guilds = [...client.guilds.cache.values()];
        const list = guilds
          .map(g => `**${g.name}**\nID: \`${g.id}\` · Members: ${g.memberCount} · Owner: <@${g.ownerId}>`)
          .join('\n\n');

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(`🌐 In ${guilds.length} server${guilds.length === 1 ? '' : 's'}`)
          .setDescription(list.slice(0, 4000) || 'Not in any servers.')
          .setFooter({ text: 'Use /leaveguild guild_id:<id> to remove the bot from one' });

        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // ── /leaveguild ──────────────────────────────────────────────────────
      if (cmd === 'leaveguild') {
        if (!isBotOwner(interaction)) return interaction.reply({ content: '❌ Owner only.', flags: 64 });

        const targetId = interaction.options.getString('guild_id');
        const target = client.guilds.cache.get(targetId);
        if (!target) {
          return interaction.reply({ content: `❌ Not in a server with ID \`${targetId}\`. Check \`/listguilds\` for the exact ID.`, flags: 64 });
        }

        const name = target.name;
        await target.leave();
        return interaction.reply({ content: `✅ Left **${name}** (\`${targetId}\`).`, flags: 64 });
      }

      if (cmd === 'statusupdate') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('setstatus_modal').setTitle('Status Update');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_product').setLabel('PRODUCT NAME').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_status').setLabel('STATUS (e.g. updated -> updating)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_notes').setLabel('NOTES (optional, separate with |)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_ping').setLabel('PING ROLE (name or ID, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
        );
        return interaction.showModal(modal);
      }
    }

    // ── Select menus ──────────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      // Steam stock — type chosen from the postgensteam panel dropdown
      if (interaction.customId === 'gensteam_select_type') {
        if (!await canAccessStock(interaction.member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }
        return claimStockAccount(interaction, interaction.values[0]);
      }

      // Update type selected
      if (interaction.customId === 'select_update_type') {
        const typeKey  = interaction.values[0];
        const typeInfo = UPDATE_TYPES[typeKey];
        pendingUpdates[interaction.user.id] = { typeKey };
        const isTimeExt = typeKey === 'time_extension' || typeKey === 'new_feature';
        const modal = new ModalBuilder().setCustomId('update_modal').setTitle(`${typeInfo.emoji} ${typeInfo.label} — Product Update`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('product_name').setLabel('PRODUCT NAME').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('status_transition').setLabel(isTimeExt ? 'TIME ADDED (e.g. 12 hours, 3 days)' : 'STATUS (e.g. updating → updated)').setStyle(TextInputStyle.Short).setRequired(isTimeExt).setMaxLength(40)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('NOTES (separate bullet points with |)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('custom_title').setLabel('CUSTOM TITLE (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image_url').setLabel('IMAGE URL (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500)),
        );
        await interaction.showModal(modal);
        try { await interaction.deleteReply(); } catch (_) {}
        return;
      }

      // Download page select
      if (['dl_page_1','dl_page_2','dl_page_3'].includes(interaction.customId)) {
        const product = getProduct(interaction.values[0]);
        if (!product) return interaction.reply({ content: '❌ Product not found.', flags: 64 });
        const embed = new EmbedBuilder().setTitle(`📦  ${product.name}`).setColor(0x57F287)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        if (product.url) {
          embed.setDescription('Your download is ready! Click the button below.');
          const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('⬇️  DOWNLOAD').setURL(product.url).setStyle(ButtonStyle.Link));
          await interaction.reply({ embeds: [embed], components: [btn], flags: 64 });
        } else {
          embed.setDescription('Download link not yet available. Check back soon or contact support.');
          await interaction.reply({ embeds: [embed], flags: 64 });
        }
        autoDelete(interaction, 60000);
        return;
      }
    }

    // ── Buttons ───────────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const { customId, guild, member } = interaction;
      const btnSettings = await getGuildSettings(guild.id);

      // Steam stock panel — one of the fixed type buttons (Steam / Steam Phone
      // Verified / Email: Outlook)
      if (customId.startsWith('gensteam_claim::')) {
        if (!await canAccessStock(member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }
        const type = customId.split('::')[1];
        return claimStockAccount(interaction, type);
      }

      // Steam stock panel — Check Stock button
      if (customId === 'gensteam_check_stock') {
        return interaction.reply({ embeds: [await buildStockEmbed(guild.id)], flags: 64 });
      }

      // Legacy single "Generate Account" button, kept for any panel posted
      // before the 4-button layout — safe to leave in even after re-posting.
      // Redeem panel — opens the key-entry modal
      if (customId === 'redeem_open_modal') {
        const modal = new ModalBuilder().setCustomId('redeem_modal').setTitle('🔑 Redeem Key');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('redeem_key_input')
              .setLabel('Your Key')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('UH-XXXX-XXXX-XXXX')
              .setRequired(true)
              .setMaxLength(64)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === 'gensteam_open') {
        if (!await canAccessStock(member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }

        const types = (await getStockTypes(guild.id)).filter(t => t.count > 0);
        if (!types.length) {
          return interaction.reply({ content: '❌ No stock is currently available for any account type. Check back later!', flags: 64 });
        }

        // Only one type in stock — skip the picker and claim immediately.
        if (types.length === 1) {
          return claimStockAccount(interaction, types[0].type);
        }

        const select = new StringSelectMenuBuilder()
          .setCustomId('gensteam_select_type')
          .setPlaceholder('Choose an account type')
          .addOptions(types.map(t =>
            new StringSelectMenuOptionBuilder().setLabel(t.type).setValue(t.type).setDescription(`${t.count} available`)
          ));

        return interaction.reply({
          content: 'Select the account type you want:',
          components: [new ActionRowBuilder().addComponents(select)],
          flags: 64,
        });
      }

      // Giveaway enter button
      if (customId === 'giveaway_enter') {
        const msgId = interaction.message.id;
        const gw = giveaways.get(msgId);
        if (!gw || gw.ended) { await interaction.reply({ content: '❌ This giveaway has already ended.', ephemeral: true }); return; }
        if (gw.participants.has(member.id)) { await interaction.reply({ content: '✅ You are already entered!', ephemeral: true }); return; }
        gw.participants.add(member.id);
        saveGiveaways();
        // Update button label with new count
        const updatedRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('giveaway_enter').setLabel(`🎉 Participate (${gw.participants.size})`).setStyle(ButtonStyle.Primary),
        );
        await interaction.update({ components: [updatedRow] });
        return;
      }

      // Leave a vouch button — opens the vouch modal
      if (customId === 'leave_vouch') {
        const modal = new ModalBuilder().setCustomId('vouch_modal').setTitle('📝 Leave a Vouch');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vouch_rating').setLabel('RATING (1-5 stars)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(1).setPlaceholder('e.g. 5')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vouch_feedback').setLabel('FEEDBACK').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setPlaceholder('Tell us about your experience...')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vouch_image').setLabel('IMAGE LINK (optional, or leave blank)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setPlaceholder('Leave blank to upload a screenshot after')),
        );
        return interaction.showModal(modal);
      }

      // Verify button
      if (customId === 'verify_button') {
        const verifiedRole = (btnSettings.verifiedRoleId && guild.roles.cache.get(btnSettings.verifiedRoleId))
          || guild.roles.cache.find(r => r.name === btnSettings.verifiedRoleName);
        if (!verifiedRole) { await interaction.reply({ content: '⚠️ Verified role not found.', ephemeral: true }); autoDelete(interaction, 5000); return; }
        if (member.roles.cache.has(verifiedRole.id)) { await interaction.reply({ content: '✅ You are already verified!', ephemeral: true }); autoDelete(interaction, 5000); return; }
        try { await member.roles.add(verifiedRole); await interaction.reply({ content: '🎉 You have been verified! Welcome!', ephemeral: true }); autoDelete(interaction, 5000); }
        catch (_) { await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }); autoDelete(interaction, 5000); }
        return;
      }

      // Get invite link
      if (customId === 'get_invite_link') {
        try {
          const invCh = (btnSettings.invitesChannelId && guild.channels.cache.get(btnSettings.invitesChannelId))
            || findChannelByName(guild, btnSettings.invitesChannelName)
            || guild.channels.cache.find(c => c.type === ChannelType.GuildText);
          const invite = await invCh.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: `Invite link for ${member.user.tag}` });
          const cache = inviteCache.get(guild.id) || new Map();
          cache.set(invite.code, { inviterId: member.user.id, uses: 0 });
          inviteCache.set(guild.id, cache);
          const embed = new EmbedBuilder().setTitle('🔗 Your Personal Invite Link')
            .setDescription(`Your **permanent** invite link:\n\n**https://discord.gg/${invite.code}**\n\nEvery **${btnSettings.invitesNeeded} real invites** = 1 free key 🔑\nThis link never expires and is unique to you!`)
            .setColor(0x5865f2).setTimestamp();
          await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        } catch (_) { await interaction.reply({ content: '❌ Could not create invite.', ephemeral: true }); autoDelete(interaction, 5000); }
        return;
      }

      // Check invites
      if (customId === 'check_invites') {
        const data = getUserInviteData(guild.id, member.user.id);
        const N = btnSettings.invitesNeeded;
        const available = Math.floor(data.real / N) - data.usedKeys;
        const filled = Math.min(data.real % N, N);
        const bar = '█'.repeat(filled) + '░'.repeat(N - filled);
        const next = data.real % N === 0 && data.real > 0 ? 'Ready to redeem! 🎁' : `${N - (data.real % N)} more needed`;
        const embed = new EmbedBuilder().setTitle('📊 Your Invite Stats')
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 128 }))
          .setDescription(`**Progress:**\n${bar} ${data.real % N}/${N}\n\n**Next Reward:** ${next}\n\n📨 **Total** — ${data.total}\n✅ **Real** — ${data.real}\n🎁 **Available Keys** — ${available}\n🔑 **Used Keys** — ${data.usedKeys}\n👋 **Left** — ${data.left}\n🚫 **Fake** — ${data.fake}`)
          .setColor(0x5865f2).setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        return;
      }

      // Redeem key
      if (customId === 'redeem_key') {
        const data = getUserInviteData(guild.id, member.user.id);
        const N = btnSettings.invitesNeeded;
        const available = Math.floor(data.real / N) - data.usedKeys;
        if (available <= 0) {
          const needed = N - (data.real % N);
          await interaction.reply({ content: `❌ Need **${N} invites**. You have **${data.real}**. ${needed} more needed!`, ephemeral: true }); autoDelete(interaction, 5000); return;
        }
        data.usedKeys++;
        const embed = new EmbedBuilder().setTitle('🎁 Key Redeemed!')
          .setDescription(`✅ You have successfully redeemed **1 key**!\n\nPlease open a **support ticket** or DM an admin to claim your reward.\n\n🔑 Keys used: **${data.usedKeys}**\n🎁 Keys remaining: **${available - 1}**`)
          .setColor(0x00e5ff).setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        console.log(`🎁 ${member.user.tag} redeemed a key!`);
        return;
      }
    }

    // ── Modal submits ─────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      // Redeem panel modal
      if (interaction.customId === 'redeem_modal') {
        const keyInput = interaction.fields.getTextInputValue('redeem_key_input');
        return redeemKey(interaction, keyInput);
      }

      // TOS/Rules/Guide content modal
      if (interaction.customId.startsWith('set_content_modal::')) {
        const key = interaction.customId.split('::')[1];
        const title = interaction.fields.getTextInputValue('content_title');
        const body  = interaction.fields.getTextInputValue('content_body');
        await setGuildContent(interaction.guild.id, key, title, body, interaction.user.id);
        return interaction.reply({ content: `✅ ${CONTENT_TYPES[key].label} updated. Run \`/post-${key}\` to post it.`, flags: 64 });
      }

      // Update modal
      if (interaction.customId === 'update_modal') {
        const product     = interaction.fields.getTextInputValue('product_name').trim();
        const notesRaw    = interaction.fields.getTextInputValue('notes');
        const customTitle = interaction.fields.getTextInputValue('custom_title').trim();
        let imageUrl      = interaction.fields.getTextInputValue('image_url').trim();
        if (imageUrl && !imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
        const statusRaw   = interaction.fields.getTextInputValue('status_transition').trim().toLowerCase();
        const pending = pendingUpdates[interaction.user.id] || {};
        const typeKey = pending.typeKey || 'update';
        const typeInfo = UPDATE_TYPES[typeKey] || { label: typeKey, emoji: '📢' };
        delete pendingUpdates[interaction.user.id];

        let oldStatus = null, newStatus = null;
        if (statusRaw && typeKey !== 'time_extension' && typeKey !== 'new_feature') {
          const { old, new: ns } = parseStatusTransition(statusRaw);
          oldStatus = old; newStatus = ns;
          if (!oldStatus) { const lk = productLastStatus[product.toLowerCase()]; if (lk) oldStatus = STATUS_TYPES[lk] === ns ? null : STATUS_TYPES[lk]; }
        }
        if (newStatus) { const nk = Object.keys(STATUS_TYPES).find(k => STATUS_TYPES[k] === newStatus); if (nk) productLastStatus[product.toLowerCase()] = nk; }

        const notes = notesRaw ? notesRaw.split('|').map(n => `• ${n.trim()}`).join('\n') : null;
        const embedColor = newStatus ? newStatus.color : getProductColor(product);
        const fields = [
          { name: 'Product', value: `\`${product}\``, inline: false },
          { name: 'Type',    value: `${typeInfo.emoji}  ${typeInfo.label}`, inline: false },
        ];
        if ((typeKey === 'time_extension' || typeKey === 'new_feature') && statusRaw) fields.push({ name: 'Time Added', value: statusRaw, inline: false });
        if (oldStatus && newStatus) { fields.push({ name: 'Changed from', value: `${oldStatus.emoji}  ${oldStatus.label}`, inline: true }, { name: 'New Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: true }); }
        else if (newStatus) fields.push({ name: 'Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: false });
        if (notes) fields.push({ name: 'Notes', value: notes, inline: false });

        const embed = new EmbedBuilder()
          .setTitle((customTitle ? customTitle.toUpperCase() : product.toUpperCase()))
          .setColor(embedColor).addFields(fields)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        if (imageUrl) embed.setThumbnail(imageUrl);

        const productData = getProductByName(product);
        const downloadUrl = productData ? (productData.url || '') : '';
        const buttonRow = downloadUrl ? new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('⬇️  DOWNLOAD').setURL(downloadUrl).setStyle(ButtonStyle.Link)) : null;
        const payload = { embeds: [embed], ...(buttonRow ? { components: [buttonRow] } : {}) };
        try {
          await interaction.channel.send(payload);
          await interaction.reply({ content: `✅ Update posted to <#${interaction.channel.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        } catch (err) { await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 }); autoDelete(interaction, 8000); }
        return;
      }

      // Announce modal
      if (interaction.customId === 'announce_modal') {
        const title    = interaction.fields.getTextInputValue('announce_title').trim();
        const message  = interaction.fields.getTextInputValue('announce_message').trim();
        const chanName = interaction.fields.getTextInputValue('announce_channel').trim();
        const pingStr  = interaction.fields.getTextInputValue('announce_ping').trim();
        let dlUrl      = interaction.fields.getTextInputValue('announce_download').trim();
        if (dlUrl && !dlUrl.startsWith('http')) dlUrl = 'https://' + dlUrl;

        let targetCh = interaction.channel;
        if (chanName) { const f = (guild => guild.channels.cache.get(chanName) || findChannelByName(guild, chanName.replace('#','')))(interaction.guild); if (f) targetCh = f; }

        let pingText = '@everyone';
        if (pingStr) {
          const clean = pingStr.replace('@','').trim().toLowerCase();
          if (clean === 'everyone') pingText = '@everyone';
          else if (clean === 'here') pingText = '@here';
          else { const rm = pingStr.match(/\d+/); if (rm) pingText = `<@&${rm[0]}>`; else { const r = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === clean); if (r) pingText = `<@&${r.id}>`; } }
        }

        const embed = new EmbedBuilder().setColor(0x5865F2);
        if (title) embed.setTitle(title);
        embed.setDescription(message).setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        const buttonRow = dlUrl ? new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('⬇️  DOWNLOAD').setURL(dlUrl).setStyle(ButtonStyle.Link)) : null;
        try {
          await targetCh.send({ content: pingText, embeds: [embed], ...(buttonRow ? { components: [buttonRow] } : {}) });
          await interaction.reply({ content: `✅ Announcement posted to <#${targetCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        } catch (err) { await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 }); autoDelete(interaction, 8000); }
        return;
      }

      // Status update modal
      if (interaction.customId === 'setstatus_modal') {
        const product   = interaction.fields.getTextInputValue('ss_product').trim();
        const statusRaw = interaction.fields.getTextInputValue('ss_status').trim().toLowerCase();
        const notesRaw  = interaction.fields.getTextInputValue('ss_notes').trim();
        const pingStr   = interaction.fields.getTextInputValue('ss_ping').trim();
        const { old: oldStatus, new: newStatus } = parseStatusTransition(statusRaw);
        if (newStatus) { const nk = Object.keys(STATUS_TYPES).find(k => STATUS_TYPES[k] === newStatus); if (nk) productLastStatus[product.toLowerCase()] = nk; }
        const fields = [{ name: 'Product', value: `\`${product.toUpperCase()}\``, inline: false }];
        if (oldStatus && newStatus) { fields.push({ name: 'Changed from', value: `${oldStatus.emoji}  ${oldStatus.label}`, inline: false }, { name: 'New Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: false }); }
        else if (newStatus) fields.push({ name: 'New Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: false });
        if (notesRaw) fields.push({ name: 'Notes', value: notesRaw.split('|').map(n => `• ${n.trim()}`).join('\n'), inline: false });
        const embed = new EmbedBuilder().setTitle('Status Change').setColor(getProductColor(product)).addFields(fields)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        const statusCh = findChannelByName(interaction.guild, 'statusupdates') || interaction.channel;
        let pingText = '@everyone';
        if (pingStr) { const clean = pingStr.replace('@','').trim().toLowerCase(); if (clean==='everyone') pingText='@everyone'; else if (clean==='here') pingText='@here'; else { const rm=pingStr.match(/\d+/); if(rm) pingText=`<@&${rm[0]}>`; else { const r=interaction.guild.roles.cache.find(r=>r.name.toLowerCase()===clean); if(r) pingText=`<@&${r.id}>`; } } }
        try {
          await statusCh.send({ content: pingText, embeds: [embed] });
          await interaction.reply({ content: `✅ Status update posted to <#${statusCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        } catch (err) { await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 }); autoDelete(interaction, 8000); }
        return;
      }

      // Reseller links modal
      if (interaction.customId === 'reseller_links_modal') {
        let applyUrl = interaction.fields.getTextInputValue('reseller_apply_url').trim();
        let panelUrl = interaction.fields.getTextInputValue('reseller_panel_url').trim();
        if (applyUrl && !applyUrl.startsWith('http')) applyUrl = 'https://' + applyUrl;
        if (panelUrl && !panelUrl.startsWith('http')) panelUrl = 'https://' + panelUrl;
        resellerLinks.apply = applyUrl; resellerLinks.panel = panelUrl;
        const gKey = interaction.guild.id;
        const existing = resellerMessages[gKey];
        if (existing) {
          try {
            const ch = await client.channels.fetch(existing.channelId);
            const msg = await ch.messages.fetch(existing.messageId);
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setLabel('APPLY HERE!').setEmoji('📋').setStyle(ButtonStyle.Link).setURL(applyUrl),
              new ButtonBuilder().setLabel('Preview Panel').setEmoji('👀').setStyle(ButtonStyle.Link).setURL(panelUrl),
            );
            await msg.edit({ components: [row] });
          } catch (_) {}
        }
        await interaction.reply({ content: `✅ Links updated!\n**Apply:** ${applyUrl}\n**Panel:** ${panelUrl}`, flags: 64 }); autoDelete(interaction, 8000);
        return;
      }

      // Post-link modal (Useful-Links style: bold title + raw URL + footer)
      if (interaction.customId === 'postlink_modal' || interaction.customId.startsWith('postlink_modal::')) {
        const title = interaction.fields.getTextInputValue('postlink_title').trim();
        let url     = interaction.fields.getTextInputValue('postlink_url').trim();
        if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;

        // Resolve target channel: explicit option (stashed in customId) > current channel
        let targetCh = interaction.channel;
        const stashed = interaction.customId.startsWith('postlink_modal::') ? interaction.customId.split('::')[1] : null;
        if (stashed) {
          const found = interaction.guild.channels.cache.get(stashed) || findChannelByName(interaction.guild, stashed);
          if (found) targetCh = found;
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(title)
          .setDescription(url)
          .setFooter({ text: `${BOT_NAME}${SITE_URL ? ` | ${SITE_URL}` : ''}`, iconURL: client.user.displayAvatarURL() })
          .setTimestamp();

        try {
          if (!targetCh.isTextBased()) throw new Error('That channel is not a text channel.');
          await targetCh.send({ content: '@everyone', embeds: [embed] });
          await interaction.reply({ content: `✅ Link posted to <#${targetCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        } catch (err) {
          await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 }); autoDelete(interaction, 8000);
        }
        return;
      }

      // Vouch modal submit
      if (interaction.customId === 'vouch_modal') {
        const ratingRaw  = interaction.fields.getTextInputValue('vouch_rating').trim();
        const feedback   = interaction.fields.getTextInputValue('vouch_feedback').trim();
        const imageUrl   = interaction.fields.getTextInputValue('vouch_image')?.trim() || null;
        const ratingNum  = Math.min(5, Math.max(1, parseInt(ratingRaw) || 1));
        const stars      = '⭐'.repeat(ratingNum);

        const gData = vouchData.get(interaction.guild.id) || { count: 0, channelId: null, entries: [] };
        gData.count += 1;
        const nowIso = new Date().toISOString();
        const entry = {
          id: gData.count,
          userId: interaction.user.id,
          username: interaction.user.tag || interaction.user.username,
          rating: ratingNum,
          feedback,
          imageUrl,
          timestamp: nowIso,
        };
        gData.entries = gData.entries || [];
        gData.entries.push(entry);
        vouchData.set(interaction.guild.id, gData);
        saveVouches();

        const vouchSettings = await getGuildSettings(interaction.guild.id);
        // Settings (panel/setupvouch) always wins over the older cached
        // gData.channelId — otherwise a stale value from before Settings
        // was configured gets stuck forever, ignoring later fixes.
        const vouchCh =
          (vouchSettings.vouchesChannelId && interaction.guild.channels.cache.get(vouchSettings.vouchesChannelId)) ||
          (gData.channelId && interaction.guild.channels.cache.get(gData.channelId));

        const embed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('New Vouch Received 🎉')
          .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: 'Vouch ID', value: `Nº ${gData.count}`, inline: false },
            { name: 'Rating', value: stars, inline: false },
            { name: 'Feedback', value: feedback, inline: false },
            { name: 'Vouched By', value: `<@${interaction.user.id}>`, inline: false },
            { name: 'Vouched At', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false },
          )
          .setFooter({ text: `Thanks for supporting ${BOT_NAME} | ${new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })} ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`, iconURL: client.user.displayAvatarURL() });

        if (imageUrl && /^https?:\/\//i.test(imageUrl)) embed.setImage(imageUrl);

        const vouchMsg = vouchCh ? await vouchCh.send({ embeds: [embed] }) : null;
        if (vouchMsg) { try { await vouchMsg.react('💯'); await vouchMsg.react('🔥'); } catch (_) {} }

        if (imageUrl) {
          await interaction.reply({ content: '✅ Thank you for your vouch!', ephemeral: true });
        } else {
          await interaction.reply({ content: '✅ Thank you for your vouch! 📸 Want to add a screenshot? Just upload it as a message in this channel within the next 60 seconds and I\'ll attach it automatically — no need for imgur or any external site.', ephemeral: true });

          if (vouchMsg && interaction.channel) {
            const collector = interaction.channel.createMessageCollector({
              filter: m => m.author.id === interaction.user.id && m.attachments.size > 0,
              max: 1,
              time: 60000,
            });
            collector.on('collect', async m => {
              const att = [...m.attachments.values()].find(a => a.contentType?.startsWith('image/')) || m.attachments.first();
              if (att) {
                try {
                  const ext = (att.name?.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
                  const fileName = `vouch-${entry.id}.${ext}`;
                  embed.setImage(`attachment://${fileName}`);
                  const file = new AttachmentBuilder(att.url, { name: fileName });
                  await vouchMsg.edit({ embeds: [embed], files: [file] });
                  entry.imageUrl = vouchMsg.embeds?.[0]?.image?.url || att.url;
                  saveVouches();
                } catch (e) { console.error('Vouch image attach error:', e); }
              }
              try { if (m.deletable) await m.delete(); } catch (_) {}
            });
          }
        }
        return;
      }
    }

  } catch (err) {
    console.error('Interaction error:', err.stack || err);
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: `❌ An error occurred: ${err.message}`, flags: 64 });
      else await interaction.reply({ content: `❌ An error occurred: ${err.message}`, flags: 64 });
    } catch (_) {}
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
