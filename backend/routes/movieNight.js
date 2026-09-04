'use strict';

// Movie Night is a policy and proxy layer.  The browser never receives an M3U
// URL, provider login, or a Discord user token: only Luminary's local control
// endpoint can inspect those values and start the actual voice stream.

const express = require('express');
const axios = require('axios');
const db = require('../db');
const { requireAuth, requireOwnerAdmin, discordLinked, bearerToken, getSessionUser } = require('../utils/auth');
const { getGuildRoles, checkDiscordAccess } = require('../utils/discordAccess');
const { logAdminAction } = require('../utils/adminLog');
const { encryptRuntimeSecret, decryptRuntimeSecret } = require('../utils/runtimeSecrets');

const router = express.Router();
const GUILD_ID = process.env.GUILD_ID;
const MAX_CATALOG_LIMIT = 100;
// Browser playback uses a server-side Xtream/M3U proxy. Provider credentials
// stay in the backend environment; the browser receives only short-lived,
// per-user proxy tokens. The older Luminary control path remains available as
// a compatibility fallback until the browser IPTV connection is configured.
// Xtream servers commonly expose live channels as MPEG-TS (`.ts`) and also
// provide an HLS variant. Browsers cannot play a raw TS response reliably, so
// prefer the HLS variant for the browser player; an owner can override this for
// a provider that uses a different live extension.
const STREAM_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const STREAM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const streamTokens = new Map();
const streamAccessCache = new Map();
const STREAM_ACCESS_CACHE_MS = 15 * 1000;
const BROWSER_CATALOG_CACHE_MS = 60 * 1000;
const WATCH_SESSION_CACHE_MS = 10 * 1000;
const WATCH_SESSION_TOUCH_MS = 20 * 1000;
// Catalog requests can be large (especially M3U feeds). Share an in-flight
// fetch so a burst of tabs/searches does not start the same provider request
// several times concurrently.
const browserCatalogInflight = new Map();
const watchSessionStatusCache = new Map();
const watchSessionTouchAt = new Map();
let streamTokenPruneAt = 0;
let browserCatalogCache = { at: 0, items: [], groups: [], bySource: {} };

const MOVIE_NIGHT_SECRET_KEYS = {
  xtream_url: { env: 'MOVIE_NIGHT_XTREAM_URL', db: 'MOVIE_NIGHT_XTREAM_URL_ENC', label: 'Xtream server URL' },
  xtream_username: { env: 'MOVIE_NIGHT_XTREAM_USERNAME', db: 'MOVIE_NIGHT_XTREAM_USERNAME_ENC', label: 'Xtream username' },
  xtream_password: { env: 'MOVIE_NIGHT_XTREAM_PASSWORD', db: 'MOVIE_NIGHT_XTREAM_PASSWORD_ENC', label: 'Xtream password' },
  m3u_url: { env: 'MOVIE_NIGHT_M3U_URL', db: 'MOVIE_NIGHT_M3U_URL_ENC', label: 'M3U URL' },
  control_url: { env: 'MOVIE_NIGHT_CONTROL_URL', db: 'MOVIE_NIGHT_CONTROL_URL_ENC', label: 'Luminary control URL' },
  control_token: { env: 'MOVIE_NIGHT_CONTROL_TOKEN', db: 'MOVIE_NIGHT_CONTROL_TOKEN_ENC', label: 'Luminary control token' },
};

// These values may be loaded from encrypted owner-admin settings after this
// module is required. Keep them refreshable instead of capturing process.env
// once at boot, so a newly saved IPTV connection works without a restart.
let CONTROL_URL = '';
let CONTROL_TOKEN = '';
let CONTROL_TIMEOUT_MS = 7000;
let IPTV_BASE = '';
let IPTV_USER = '';
let IPTV_PASSWORD = '';
let IPTV_M3U_URL = '';
let IPTV_LIVE_EXTENSION = 'm3u8';
let runtimeConfigSignature = '';

function refreshRuntimeConfig() {
  const next = {
    controlUrl: String(process.env.MOVIE_NIGHT_CONTROL_URL || '').replace(/\/+$/, ''),
    controlToken: String(process.env.MOVIE_NIGHT_CONTROL_TOKEN || ''),
    timeout: Math.max(1000, Math.min(15000, Number(process.env.MOVIE_NIGHT_CONTROL_TIMEOUT_MS) || 7000)),
    iptvBase: String(process.env.MOVIE_NIGHT_XTREAM_URL || process.env.MOVIE_NIGHT_IPTV_URL || '').replace(/\/+$/, ''),
    iptvUser: String(process.env.MOVIE_NIGHT_XTREAM_USERNAME || process.env.MOVIE_NIGHT_IPTV_USERNAME || '').trim(),
    iptvPassword: String(process.env.MOVIE_NIGHT_XTREAM_PASSWORD || process.env.MOVIE_NIGHT_IPTV_PASSWORD || '').trim(),
    m3uUrl: String(process.env.MOVIE_NIGHT_M3U_URL || '').trim(),
    liveExtension: String(process.env.MOVIE_NIGHT_XTREAM_LIVE_EXTENSION || 'm3u8').replace(/[^a-z0-9]/gi, '') || 'm3u8',
  };
  const signature = JSON.stringify(next);
  CONTROL_URL = next.controlUrl;
  CONTROL_TOKEN = next.controlToken;
  CONTROL_TIMEOUT_MS = next.timeout;
  IPTV_BASE = next.iptvBase;
  IPTV_USER = next.iptvUser;
  IPTV_PASSWORD = next.iptvPassword;
  IPTV_M3U_URL = next.m3uUrl;
  IPTV_LIVE_EXTENSION = next.liveExtension;
  if (signature === runtimeConfigSignature) return;
  runtimeConfigSignature = signature;
  // A changed connection must not leave a catalog from the previous provider
  // in memory or make the owner wait for the one-minute cache to expire.
  browserCatalogCache = { at: 0, items: [], groups: [], bySource: {} };
}

refreshRuntimeConfig();

// Config loading happens after route modules are required during server boot.
// Refresh before every request so admin changes and DB-restored secrets apply
// immediately and no secret is ever sent to the browser.
router.use((req, res, next) => { refreshRuntimeConfig(); next(); });

function browserIptvConfigured() { return !!((IPTV_BASE && IPTV_USER && IPTV_PASSWORD) || IPTV_M3U_URL); }

function runtimeConnection() {
  return { id: null, method: IPTV_BASE && IPTV_USER && IPTV_PASSWORD ? 'xtream' : 'm3u', base: IPTV_BASE, username: IPTV_USER, password: IPTV_PASSWORD, m3uUrl: IPTV_M3U_URL, liveExtension: IPTV_LIVE_EXTENSION, liveCategories: [], movieCategories: [], seriesCategories: [] };
}

async function primaryPlaylistConnection() {
  try {
    const { rows } = await db.query(
      `SELECT id, method, playlist_url_enc, host_url_enc, username_enc,
              password_enc, live_categories, movie_categories, series_categories FROM movie_night_playlists
        WHERE guild_id = $1 AND enabled = true
        ORDER BY sort_order, id LIMIT 1`, [GUILD_ID]
    );
    const row = rows[0];
    if (!row) return runtimeConnection();
    return playlistConnectionFromRow(row) || runtimeConnection();
  } catch (error) {
    // The table is optional during a rolling deploy and in older test/legacy
    // environments. Keep the original environment-backed connection working
    // until the migration is present.
    if (!migrationError(error)) console.warn('[MovieNight] playlist lookup unavailable:', error.message);
    return runtimeConnection();
  }
}

function playlistConnectionFromRow(row) {
  if (!row) return null;
  const method = playlistMethod(row.method);
  return {
    id: Number(row.id) || null,
    method,
    base: decryptRuntimeSecret(String(row.host_url_enc || '')) || '',
    username: decryptRuntimeSecret(String(row.username_enc || '')) || '',
    password: decryptRuntimeSecret(String(row.password_enc || '')) || '',
    m3uUrl: decryptRuntimeSecret(String(row.playlist_url_enc || '')) || '',
    liveExtension: IPTV_LIVE_EXTENSION,
    liveCategories: playlistCategories(row.live_categories),
    movieCategories: playlistCategories(row.movie_categories),
    seriesCategories: playlistCategories(row.series_categories),
  };
}

async function playlistConnections() {
  try {
    const { rows } = await db.query(
      `SELECT id, method, playlist_url_enc, host_url_enc, username_enc,
              password_enc, live_categories, movie_categories, series_categories
         FROM movie_night_playlists
        WHERE guild_id = $1 AND enabled = true
        ORDER BY sort_order, id`, [GUILD_ID]
    );
    const connections = rows.map(playlistConnectionFromRow).filter((source) => source && ((source.base && source.username && source.password) || source.m3uUrl));
    if (connections.length) return connections;
  } catch (error) {
    if (!migrationError(error)) console.warn('[MovieNight] playlist list unavailable:', error.message);
  }
  return browserIptvConfigured() ? [runtimeConnection()] : [];
}

async function browserIptvConfiguredAsync() {
  return (await playlistConnections()).length > 0;
}

async function playlistConnectionById(id) {
  const wanted = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(wanted) || wanted < 1) return null;
  try {
    const { rows } = await db.query(
      `SELECT id, method, playlist_url_enc, host_url_enc, username_enc,
              password_enc, live_categories, movie_categories, series_categories
         FROM movie_night_playlists WHERE id = $1 AND guild_id = $2 AND enabled = true LIMIT 1`, [wanted, GUILD_ID]
    );
    return playlistConnectionFromRow(rows[0]);
  } catch (error) {
    if (!migrationError(error)) console.warn('[MovieNight] playlist lookup unavailable:', error.message);
    return null;
  }
}

function maskedSecretConfig() {
  const mask = (value) => value ? `••••••••${String(value).slice(-4)}` : '';
  let host = '';
  try { host = IPTV_BASE ? new URL(IPTV_BASE).host : ''; } catch (_) { host = ''; }
  let m3uHost = '';
  try { m3uHost = IPTV_M3U_URL ? new URL(IPTV_M3U_URL).host : ''; } catch (_) { m3uHost = ''; }
  return {
    xtream_url: { configured: !!IPTV_BASE, host },
    xtream_username: { configured: !!IPTV_USER, masked: mask(IPTV_USER) },
    xtream_password: { configured: !!IPTV_PASSWORD, masked: mask(IPTV_PASSWORD) },
    m3u_url: { configured: !!IPTV_M3U_URL, host: m3uHost },
    control_url: { configured: !!CONTROL_URL, host: (() => { try { return CONTROL_URL ? new URL(CONTROL_URL).host : ''; } catch (_) { return ''; } })() },
    control_token: { configured: !!CONTROL_TOKEN, masked: mask(CONTROL_TOKEN) },
  };
}

function validPrivateUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) { return false; }
}

async function saveMovieNightSecretConfig(body) {
  const changes = [];
  for (const [field, meta] of Object.entries(MOVIE_NIGHT_SECRET_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(body || {}, field)) continue;
    const value = String(body[field] == null ? '' : body[field]).trim();
    if (value.length > 2048) {
      const error = new Error(`${meta.label} is too long`);
      error.statusCode = 400;
      throw error;
    }
    if ((field === 'xtream_url' || field === 'm3u_url' || field === 'control_url') && value && !validPrivateUrl(value)) {
      const error = new Error(`${meta.label} must be a valid http(s) URL`);
      error.statusCode = 400;
      throw error;
    }
    const encrypted = encryptRuntimeSecret(value);
    await db.query(
      `INSERT INTO config (guild_id, key, value, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (guild_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [GUILD_ID, meta.db, encrypted]
    );
    process.env[meta.env] = value;
    changes.push(field);
  }
  if (changes.length) refreshRuntimeConfig();
  return changes;
}

function iptvStreamOrigin(connection) {
  return String((connection || runtimeConnection()).base || '').replace(/\/player_api\.php$/i, '').replace(/\/+$/, '');
}

function cleanProviderUrl(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw;
}

function browserCompatibleM3uUrl(value) {
  const url = cleanProviderUrl(value);
  if (!url) return null;
  // Xtream M3U exports often contain raw `.ts` live URLs even when the same
  // channel is available as HLS. Prefer the HLS variant for browsers; VOD
  // files and already-HLS URLs are left untouched.
  if (/\.ts(?:$|\?)/i.test(url)) {
    const extension = String(process.env.MOVIE_NIGHT_M3U_LIVE_EXTENSION || 'm3u8').replace(/[^a-z0-9]/gi, '') || 'm3u8';
    return url.replace(/\.ts(?=$|\?)/i, `.${extension}`);
  }
  return url;
}

function stableStreamId(value, fallback) {
  const text = String(value || fallback || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return Math.abs(hash >>> 0) || 1;
}

async function xtreamRequest(action, extra, requestOptions, connection) {
  const source = connection || runtimeConnection();
  if (!(source.base && source.username && source.password)) return null;
  const base = /player_api\.php$/i.test(source.base) ? source.base : source.base + '/player_api.php';
  const params = new URLSearchParams({ username: source.username, password: source.password, action: String(action) });
  Object.entries(extra || {}).forEach(([key, value]) => { if (value != null) params.set(key, String(value)); });
  const response = await axios.get(base + '?' + params.toString(), { timeout: Number(requestOptions?.timeoutMs) || CONTROL_TIMEOUT_MS, validateStatus: (status) => status < 500 });
  if (response.status >= 400) throw new Error('IPTV catalog request failed');
  if (action === 'get_live_streams' || action === 'get_vod_streams' || action === 'get_series') {
    if (!Array.isArray(response.data)) throw new Error('IPTV catalog response was invalid');
  }
  return response.data;
}

function classifyGroup(group, fallback) {
  const value = String(group || '').toLowerCase();
  if (/movie|film|vod/.test(value)) return 'movie';
  if (/series|show|tv show/.test(value)) return 'series';
  return fallback || 'live';
}

function normaliseBrowserItem(raw, kind, sourceUrl, fallbackIndex) {
  const title = cleanString(raw?.name || raw?.title || raw?.stream_display_name || '', 180);
  const group = cleanString(raw?.category_name || raw?.group || raw?.group_title || '', 120) || null;
  const id = Number.parseInt(raw?.stream_id ?? raw?.series_id ?? raw?.id, 10) || stableStreamId(sourceUrl || title, fallbackIndex);
  const url = cleanProviderUrl(sourceUrl || raw?.stream_url || raw?.url);
  if (!title || !url) return null;
  return { id, kind, title, group, logo: /^https:\/\//i.test(String(raw?.stream_icon || raw?.logo || '')) ? String(raw.stream_icon || raw.logo) : null, sourceUrl: url, container: String(raw?.container_extension || '').toLowerCase() || null };
}

function categoryMap(rows) {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = String(row?.category_id ?? row?.id ?? '').trim();
    const name = cleanString(row?.category_name || row?.name || '', 120);
    if (id && name) map.set(id, name);
  });
  return map;
}

function withCategory(row, categories) {
  if (!row || row.category_name) return row;
  const category = categories.get(String(row.category_id ?? ''));
  return category ? { ...row, category_name: category } : row;
}

async function parseM3U(connection) {
  const source = connection || runtimeConnection();
  if (!source.m3uUrl) return [];
  const response = await axios.get(source.m3uUrl, { timeout: CONTROL_TIMEOUT_MS, responseType: 'text' });
  const lines = String(response.data || '').split(/\r?\n/);
  const items = [];
  let info = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      line.replace(/([\w-]+)="([^"]*)"/g, (_, key, value) => { attrs[key] = value; return _; });
      const comma = line.indexOf(',');
      info = { name: comma >= 0 ? line.slice(comma + 1).trim() : '', group: attrs['group-title'] || attrs.group || '', logo: attrs['tvg-logo'] || '' };
    } else if (info && line.trim() && !line.startsWith('#')) {
      const kind = classifyGroup(info.group, 'live');
      const item = normaliseBrowserItem({ name: info.name, group: info.group, logo: info.logo }, kind, browserCompatibleM3uUrl(line.trim()), items.length);
      if (item) { item.playlist_id = source.id || null; items.push(item); }
      info = null;
    }
  }
  return items;
}

async function getBrowserCatalogFromConnection(requestedKind, connection) {
  const source = connection || await primaryPlaylistConnection();
  if (!(source && ((source.base && source.username && source.password) || source.m3uUrl))) return null;
  const wantedKind = ['live', 'movie', 'series'].includes(String(requestedKind || '').toLowerCase()) ? String(requestedKind).toLowerCase() : '';
  const sourceKey = source.id ? `playlist:${source.id}` : 'runtime';
  browserCatalogCache.bySource = browserCatalogCache.bySource || {};
  const sourceCache = browserCatalogCache.bySource[sourceKey] || (browserCatalogCache.bySource[sourceKey] = {});
  const now = Date.now();
  const cached = sourceCache[wantedKind || 'all'];
  // Empty feeds are valid cache entries too. Re-fetching an empty provider on
  // every search/tab change was a particularly expensive failure mode.
  if (cached && now - cached.at < BROWSER_CATALOG_CACHE_MS) return cached;

  const fetchKey = `${sourceKey}|${wantedKind || 'all'}`;
  if (browserCatalogInflight.has(fetchKey)) return browserCatalogInflight.get(fetchKey);
  const pending = (async () => {
    let items = [];
    if (source.base && source.username && source.password) {
      const kinds = wantedKind ? [wantedKind] : ['live', 'movie', 'series'];
      const actions = { live: 'get_live_streams', movie: 'get_vod_streams', series: 'get_series' };
      const categoryActions = { live: 'get_live_categories', movie: 'get_vod_categories', series: 'get_series_categories' };
      const rowsByKind = Object.fromEntries(await Promise.all(kinds.map(async (kind) => [kind, await xtreamRequest(actions[kind], null, { timeoutMs: 30_000 }, source)] )));
      // Category endpoints are optional across Xtream providers. A provider
      // may expose streams but reject one or more category calls; titles should
      // still load, using the stream's own category_name when available.
      const categoriesByKind = Object.fromEntries(await Promise.all(kinds.map(async (kind) => [kind, categoryMap(await xtreamRequest(categoryActions[kind], null, { timeoutMs: 15_000 }, source).catch(() => []))])));
      const liveRows = Array.isArray(rowsByKind.live) ? rowsByKind.live : [];
      const movieRows = Array.isArray(rowsByKind.movie) ? rowsByKind.movie : [];
      const seriesRows = Array.isArray(rowsByKind.series) ? rowsByKind.series : [];
      const liveMap = categoriesByKind.live || new Map();
      const vodMap = categoriesByKind.movie || new Map();
      const seriesMap = categoriesByKind.series || new Map();
      items = liveRows.map((row, i) => {
        const item = normaliseBrowserItem(withCategory(row, liveMap), 'live', `${iptvStreamOrigin(source)}/live/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}/${row.stream_id}.${source.liveExtension || 'm3u8'}`, i);
        if (item) item.playlist_id = source.id || null;
        return item;
      }).filter(Boolean)
        .concat(movieRows.map((row, i) => {
          const item = normaliseBrowserItem(withCategory(row, vodMap), 'movie', `${iptvStreamOrigin(source)}/movie/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}/${row.stream_id}.${row.container_extension || 'mp4'}`, i);
          if (item) item.playlist_id = source.id || null;
          return item;
        }).filter(Boolean))
        .concat(seriesRows.map((row, i) => { const item = withCategory(row, seriesMap); return { id: Number.parseInt(item.series_id, 10) || stableStreamId(item.name, i), kind: 'series', title: cleanString(item.name, 180), group: cleanString(item.category_name || '', 120) || null, logo: /^https:\/\//i.test(String(item.cover || '')) ? String(item.cover) : null, sourceUrl: null, container: null, playlist_id: source.id || null }; }));
    } else {
      // Parse an M3U exactly once, then derive per-kind views from that cache.
      // This avoids repeatedly downloading and scanning a large playlist when
      // the UI switches between Live/Movies/Series tabs.
      const allKey = `${sourceKey}|m3u`;
      let allEntry = sourceCache.all;
      if (!(allEntry && now - allEntry.at < BROWSER_CATALOG_CACHE_MS)) {
        if (browserCatalogInflight.has(allKey)) {
          allEntry = await browserCatalogInflight.get(allKey);
        } else {
          const m3uPending = parseM3U(source).then((parsed) => {
            const entry = { at: Date.now(), items: parsed, groups: [...new Set(parsed.map((item) => item.group).filter(Boolean))].sort((a, b) => a.localeCompare(b)) };
            sourceCache.all = entry;
            return entry;
          }).finally(() => browserCatalogInflight.delete(allKey));
          browserCatalogInflight.set(allKey, m3uPending);
          allEntry = await m3uPending;
        }
      }
      items = (allEntry?.items || []).filter((item) => !wantedKind || item.kind === wantedKind);
    }
    const categoryAllowlist = wantedKind === 'live' ? source.liveCategories : wantedKind === 'movie' ? source.movieCategories : wantedKind === 'series' ? source.seriesCategories : [];
    if (categoryAllowlist.length) {
      const allowed = new Set(categoryAllowlist.map((value) => String(value).toLowerCase()));
      items = items.filter((item) => item.group && allowed.has(String(item.group).toLowerCase()));
    }
    const groups = [...new Set(items.map((item) => item.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const result = { at: Date.now(), items, groups };
    sourceCache[wantedKind || 'all'] = result;
    return result;
  })().finally(() => browserCatalogInflight.delete(fetchKey));
  browserCatalogInflight.set(fetchKey, pending);
  return pending;
}

async function getBrowserCatalog(requestedKind, connection) {
  if (connection) return getBrowserCatalogFromConnection(requestedKind, connection);
  const connections = await playlistConnections();
  if (!connections.length) return null;
  let lastError = null;
  for (let index = 0; index < connections.length; index += 1) {
    try {
      const result = await getBrowserCatalogFromConnection(requestedKind, connections[index]);
      // An empty feed is a failed fallback candidate when another playlist is
      // available. Keep the final empty result so the UI can still explain it.
      if (result && (result.items.length || index === connections.length - 1)) return result;
    } catch (error) {
      lastError = error;
      if (index === connections.length - 1) throw error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

function normaliseProviderCookie(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  const cookies = values.map((cookie) => String(cookie || '').split(';', 1)[0].trim()).filter(Boolean);
  return cookies.length ? cookies.join('; ') : null;
}

function providerCookiePairs(value, setCookie) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  return values.flatMap((cookie) => {
    const text = String(cookie || '').trim();
    // Set-Cookie values contain attributes after the first semicolon. A
    // browser Cookie header, on the other hand, may contain several pairs;
    // preserve each pair without ever forwarding cookie attributes upstream.
    return String(setCookie ? text.split(';', 1)[0] : text)
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && part.includes('='));
  });
}

function mergeProviderCookies(previous, responseCookies) {
  const byName = new Map();
  providerCookiePairs(previous, false).concat(providerCookiePairs(responseCookies, true)).forEach((pair) => {
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    if (name) byName.set(name, pair);
  });
  return byName.size ? [...byName.values()].join('; ') : null;
}

function providerAuthorizationFromUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!parsed.username && !parsed.password) return null;
    const username = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } catch (_) { return null; }
}

function providerStreamContext(entry, sourceUrl, response, requestHeaders) {
  const previous = entry && entry.providerContext && typeof entry.providerContext === 'object'
    ? entry.providerContext : {};
  // Axios' Node adapter exposes the final URL after redirects on the response
  // request object. Keep it server-side so providers that bind segments to
  // the redirected playlist continue to see the right Referer.
  const redirectedUrl = cleanProviderUrl(response?.request?.res?.responseUrl || response?.request?._currentUrl);
  let origin = previous.origin || null;
  if (!origin) {
    try { origin = new URL(previous.referrer || redirectedUrl || sourceUrl).origin; } catch (_) { origin = null; }
  }
  const authorization = previous.authorization
    || requestHeaders?.Authorization
    || providerAuthorizationFromUrl(sourceUrl)
    || null;
  return {
    // Keep the first playlist as the referrer for every child request. This
    // matters for providers that authorize segments against the playlist URL.
    referrer: previous.referrer || redirectedUrl || sourceUrl,
    origin,
    cookie: mergeProviderCookies(previous.cookie, response?.headers?.['set-cookie']),
    authorization,
  };
}

function providerRequestHeaders(entry, sourceUrl, req) {
  const context = entry && entry.providerContext && typeof entry.providerContext === 'object'
    ? entry.providerContext : {};
  const headers = { 'User-Agent': STREAM_USER_AGENT };
  if (context.referrer && validPrivateUrl(context.referrer)) headers.Referer = context.referrer;
  if (context.origin && /^https?:\/\//i.test(String(context.origin))) headers.Origin = context.origin;
  if (context.cookie) headers.Cookie = context.cookie;
  const authorization = context.authorization || providerAuthorizationFromUrl(sourceUrl);
  if (authorization && /^(?:Basic|Bearer)\s+\S+$/i.test(String(authorization))) headers.Authorization = authorization;
  if (req?.headers?.range) headers.Range = req.headers.range;
  return headers;
}

function issueStreamToken(userId, item, providerContext) {
  // Playlist rewriting can mint a token per segment. Prune old capabilities on
  // the write path so a long-running Movie Night session cannot grow this
  // process-local map without bound.
  const now = Date.now();
  // Pruning the complete map for every HLS segment is O(n) per request. A
  // short periodic sweep provides the same bound while keeping token minting
  // effectively constant-time during playback.
  if (now - streamTokenPruneAt >= 30 * 1000) {
    streamTokenPruneAt = now;
    for (const [key, value] of streamTokens) {
      if (!value || value.expiresAt < now) streamTokens.delete(key);
    }
  }
  const token = require('crypto').randomBytes(24).toString('base64url');
  streamTokens.set(token, {
    userId: String(userId), sourceUrl: item.sourceUrl, title: item.title,
    kind: item.kind, container: item.container || null,
    playlistId: Number.parseInt(item.playlist_id || item.playlistId || 0, 10) || null,
    sessionId: Number.parseInt(item.sessionId || 0, 10) || null,
    // Provider request context is deliberately held only in this server-side
    // capability map; it is never serialized into browser-visible URLs.
    providerContext: providerContext && typeof providerContext === 'object' ? {
      referrer: cleanProviderUrl(providerContext.referrer),
      origin: /^https?:\/\//i.test(String(providerContext.origin || '')) ? String(providerContext.origin) : null,
      cookie: mergeProviderCookies(null, providerContext.cookie),
      authorization: /^(?:Basic|Bearer)\s+\S+$/i.test(String(providerContext.authorization || '')) ? String(providerContext.authorization) : null,
    } : null,
    expiresAt: now + STREAM_TOKEN_TTL_MS,
  });
  return token;
}

function takeStreamToken(token, userId) {
  const entry = streamTokens.get(String(token || ''));
  if (!entry || entry.expiresAt < Date.now() || String(entry.userId) !== String(userId)) return null;
  return entry;
}

// A media element cannot attach an Authorization header to the follow-up
// requests it makes for MP4 ranges, HLS playlists, and HLS segments.  The
// short-lived stream token is therefore the capability for those requests.
// Resolve its owner here and re-check the current Movie Night role on every
// request instead of weakening the role gate or putting a long-lived session
// token in the media URL.
async function getStreamUser(entry, req) {
  const cacheKey = String(entry.userId);
  const cached = streamAccessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let user = null;
  try {
    const sessionUser = await getSessionUser(bearerToken(req));
    if (sessionUser && String(sessionUser.id) === String(entry.userId)) user = sessionUser;
  } catch (_) {}
  if (!user) {
    const { rows } = await db.query(
      `SELECT u.*, b.balance_cents
         FROM web_users u
         LEFT JOIN balances b ON b.web_user_id = u.id
        WHERE u.id = $1
        LIMIT 1`,
      [entry.userId]
    );
    user = rows[0] || null;
  }
  if (!user || user.banned) return null;
  const settings = await getSettings();
  const access = await roleAccess(user, settings);
  const value = access.allowed ? { user, settings, access } : null;
  if (value) streamAccessCache.set(cacheKey, { value, expiresAt: Date.now() + STREAM_ACCESS_CACHE_MS });
  else streamAccessCache.delete(cacheKey);
  return value;
}

async function watchSessionIsActive(sessionId) {
  const id = Number.parseInt(sessionId, 10);
  if (!Number.isSafeInteger(id) || id < 1) return true;
  const cached = watchSessionStatusCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.active;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM movie_night_watch_sessions
        WHERE id = $1 AND status = 'active'
          AND last_seen_at > now() - interval '2 hours' LIMIT 1`, [id]
    );
    const active = !!rows[0];
    watchSessionStatusCache.set(id, { active, expiresAt: Date.now() + WATCH_SESSION_CACHE_MS });
    return active;
  } catch (error) {
    if (migrationError(error)) return true;
    throw error;
  }
}

function controlConfigured() {
  return !!(CONTROL_URL && CONTROL_TOKEN);
}

function controlHeaders() {
  return { 'X-Movie-Night-Token': CONTROL_TOKEN };
}

function cleanRoleIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || '').trim()).filter((id) => /^\d{15,22}$/.test(id)))].slice(0, 50);
}

function cleanString(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function publicChannel(row) {
  if (!row || !Number.isInteger(Number(row.id))) return null;
  return {
    id: Number(row.id),
    title: cleanString(row.title || row.tvg_name, 180),
    group: cleanString(row.group || row.group_title, 120) || null,
    kind: cleanString(row.kind || row.stream_type, 20) || null,
    playlist_id: Number.isSafeInteger(Number(row.playlist_id)) && Number(row.playlist_id) > 0 ? Number(row.playlist_id) : null,
    logo: /^https:\/\//i.test(String(row.logo || row.tvg_logo || '')) ? String(row.logo || row.tvg_logo) : null,
    now_playing: cleanString(row.now_playing || '', 220) || null,
  };
}

async function getSettings() {
  const { rows } = await db.query(
    `SELECT enabled, allowed_role_ids, updated_at
       FROM movie_night_settings WHERE singleton = true LIMIT 1`
  );
  const settings = rows[0] || { enabled: false, allowed_role_ids: [] };
  return {
    enabled: !!settings.enabled,
    allowedRoleIds: cleanRoleIds(settings.allowed_role_ids),
    updatedAt: settings.updated_at || null,
  };
}

function migrationError(error) {
  return error && (error.code === '42P01' || error.code === '42703');
}

function playlistMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  return method === 'xtream' || method === 'xc' ? 'xtream' : 'm3u';
}

function playlistCategories(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanString(item, 120)).filter(Boolean))].slice(0, 250);
}

function playlistUrl(value) {
  const text = String(value || '').trim();
  return text && validPrivateUrl(text) ? text : null;
}

function maskedPlaylist(row) {
  const decrypt = (value) => decryptRuntimeSecret(String(value || '')) || '';
  const hostValue = decrypt(row.host_url_enc);
  const m3uValue = decrypt(row.playlist_url_enc);
  let host = '';
  let m3uHost = '';
  try { host = hostValue ? new URL(hostValue).host : ''; } catch (_) {}
  try { m3uHost = m3uValue ? new URL(m3uValue).host : ''; } catch (_) {}
  return {
    id: Number(row.id), name: cleanString(row.name, 120), method: playlistMethod(row.method),
    enabled: row.enabled !== false, max_users: Math.max(1, Number(row.max_users) || 1),
    sort_order: Number(row.sort_order) || 0, active_users: Math.max(0, Number(row.active_users) || 0),
    host, m3u_host: m3uHost,
    configured: playlistMethod(row.method) === 'xtream'
      ? !!(hostValue && decrypt(row.username_enc) && decrypt(row.password_enc)) : !!m3uValue,
    categories: {
      live: playlistCategories(row.live_categories), movie: playlistCategories(row.movie_categories),
      series: playlistCategories(row.series_categories),
    },
  };
}

async function beginWatchSession({ playlistId, user, channel }) {
  const id = Number.parseInt(playlistId, 10);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  try {
    // An atomic insert makes the max-user limit safe when two viewers start at
    // the same time. Stale streams are expired as part of the same statement.
    const { rows } = await db.query(
      `WITH chosen AS (
         SELECT p.id
           FROM movie_night_playlists p
          WHERE p.id = $1 AND p.enabled = true
            AND (SELECT COUNT(*) FROM movie_night_watch_sessions s
                   WHERE s.playlist_id = p.id AND s.status = 'active'
                     AND s.last_seen_at > now() - interval '2 hours') < p.max_users
          FOR UPDATE SKIP LOCKED
       ), inserted AS (
         INSERT INTO movie_night_watch_sessions
           (playlist_id, user_id, discord_id, channel_id, title)
         SELECT c.id, $2, $3, $4, $5 FROM chosen c
         RETURNING id
       ) SELECT id FROM inserted`,
      [id, user?.id || null, user?.discord_id ? String(user.discord_id) : null,
        Number(channel?.id) || null, cleanString(channel?.title || 'Movie Night', 180) || 'Movie Night']
    );
    return rows[0] ? Number(rows[0].id) : 0;
  } catch (error) {
    if (migrationError(error)) return null;
    throw error;
  }
}

function touchWatchSession(sessionId) {
  const id = Number.parseInt(sessionId, 10);
  if (!Number.isSafeInteger(id) || id < 1) return;
  const now = Date.now();
  const previous = watchSessionTouchAt.get(id) || 0;
  // HLS clients request a playlist and several segments every few seconds.
  // Updating last_seen_at on each request creates avoidable write pressure;
  // one heartbeat per interval is sufficient for the two-hour stale cutoff.
  if (now - previous < WATCH_SESSION_TOUCH_MS) return;
  watchSessionTouchAt.set(id, now);
  watchSessionStatusCache.set(id, { active: true, expiresAt: now + WATCH_SESSION_CACHE_MS });
  db.query(`UPDATE movie_night_watch_sessions SET last_seen_at = now()
            WHERE id = $1 AND status = 'active'`, [id]).catch(() => {});
}

async function endWatchSessions(userId) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isSafeInteger(id) || id < 1) return 0;
  try {
    const result = await db.query(
      `UPDATE movie_night_watch_sessions
          SET status = 'stopped', ended_at = now(), last_seen_at = now()
        WHERE user_id = $1 AND status = 'active'`, [id]
    );
    // Admin/user stop must take effect immediately even though stream status
    // checks are cached to avoid one DB SELECT per HLS segment.
    for (const [sessionId] of watchSessionStatusCache) {
      watchSessionStatusCache.delete(sessionId);
    }
    for (const [sessionId] of watchSessionTouchAt) {
      watchSessionTouchAt.delete(sessionId);
    }
    return Number(result.rowCount) || 0;
  } catch (error) {
    if (migrationError(error)) return 0;
    throw error;
  }
}

async function roleAccess(user, settings) {
  if (!settings.enabled || !settings.allowedRoleIds.length || !discordLinked(user)) {
    return { allowed: false, roleIds: [] };
  }
  const membership = await checkDiscordAccess(user.discord_id);
  const held = new Set((membership.roleIds || []).map(String));
  const matched = settings.allowedRoleIds.filter((roleId) => held.has(roleId));
  return { allowed: matched.length > 0, roleIds: matched };
}

async function requireMovieNightAccess(req, res, next) {
  try {
    const settings = await getSettings();
    const access = await roleAccess(req.user, settings);
    if (!access.allowed) {
      return res.status(403).json({ error: 'Movie Night is restricted to approved Discord roles' });
    }
    req.movieNight = { settings, access };
    return next();
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Movie Night setup has not been installed yet' });
    console.error('[MovieNight] access check failed:', error.message);
    return res.status(503).json({ error: 'Movie Night access check is temporarily unavailable' });
  }
}

async function callControl(method, path, body) {
  if (!controlConfigured()) {
    const error = new Error('Movie Night streaming service is not configured');
    error.statusCode = 503;
    throw error;
  }
  try {
    const response = await axios({
      method,
      url: CONTROL_URL + path,
      headers: controlHeaders(),
      data: body,
      timeout: CONTROL_TIMEOUT_MS,
      validateStatus: (status) => status < 500,
    });
    if (response.status >= 400) {
      const error = new Error(cleanString(response.data?.error, 180) || 'Movie Night request was refused');
      error.statusCode = response.status;
      throw error;
    }
    return response.data || {};
  } catch (error) {
    if (error.statusCode) throw error;
    const unavailable = new Error('Movie Night streaming service is unavailable');
    unavailable.statusCode = 503;
    throw unavailable;
  }
}

async function writePlaybackLog({ user, channel, action, status, detail }) {
  // Logging must not turn a completed stream action into an apparent failure.
  // Keep it durable whenever Postgres is healthy, and never record a URL or
  // provider detail even if a downstream service has one in its error text.
  try {
    await db.query(
      `INSERT INTO movie_night_playback_log
         (user_id, discord_id, channel_id, title, group_title, action, status, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        user?.id || null,
        user?.discord_id ? String(user.discord_id) : null,
        channel?.id ? Number(channel.id) : null,
        cleanString(channel?.title || 'Movie Night', 180) || 'Movie Night',
        cleanString(channel?.group || '', 120) || null,
        cleanString(action, 20) || 'play',
        cleanString(status, 20) || 'unknown',
        cleanString(detail, 250) || null,
      ]
    );
  } catch (error) {
    console.error('[MovieNight] playback log failed:', error.message);
  }
}

router.get('/access', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const access = await roleAccess(req.user, settings);
    const browserConfigured = await browserIptvConfiguredAsync();
    const canManage = req.user.role === 'admin';
    return res.json({
      visible: access.allowed || canManage,
      can_access: access.allowed,
      can_manage: canManage,
      enabled: settings.enabled,
      discord_linked: discordLinked(req.user),
      streaming_configured: controlConfigured() || browserConfigured,
      browser_configured: browserConfigured,
    });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Movie Night setup has not been installed yet' });
    console.error('[MovieNight] access status failed:', error.message);
    return res.status(503).json({ error: 'Movie Night access check is temporarily unavailable' });
  }
});

router.get('/catalog', requireAuth, requireMovieNightAccess, async (req, res) => {
  const search = cleanString(req.query.search, 100);
  const group = cleanString(req.query.group, 120);
  const requestedKind = cleanString(req.query.kind, 20).toLowerCase();
  const kind = ['live', 'movie', 'series'].includes(requestedKind) ? requestedKind : '';
  const limit = Math.max(1, Math.min(MAX_CATALOG_LIMIT, Number.parseInt(req.query.limit, 10) || 40));
  try {
    // Load only the selected provider feed. Fetching all live, movie, and
    // series rows for every request makes the first Movie Night render wait on
    // a very large Xtream response even when the user only wants Live TV.
    const browserCatalog = await getBrowserCatalog(kind);
    if (browserCatalog) {
      const wanted = search.toLowerCase();
      const matching = browserCatalog.items.filter((item) => {
        if (kind && item.kind !== kind) return false;
        if (group && String(item.group || '') !== group) return false;
        if (!wanted) return true;
        return `${item.title} ${item.group || ''} ${item.kind}`.toLowerCase().includes(wanted);
      });
      const filtered = matching.slice(0, limit);
      const groups = [...new Set(matching.map((item) => item.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      return res.json({
        channels: filtered.map((item) => publicChannel({ id: item.id, title: item.title, group: item.group, logo: item.logo, kind: item.kind })),
        groups,
        total: matching.length,
        current: null,
        mode: 'browser',
      });
    }
    const params = new URLSearchParams({ limit: String(limit) });
    if (search) params.set('search', search);
    if (group) params.set('group', group);
    if (kind) params.set('kind', kind);
    const data = await callControl('get', '/v1/catalog?' + params.toString());
    const channels = Array.isArray(data.channels) ? data.channels.map(publicChannel).filter(Boolean) : [];
    return res.json({
      channels,
      groups: Array.isArray(data.groups) ? data.groups.map((item) => cleanString(item, 120)).filter(Boolean).slice(0, 250) : [],
      total: Number.isFinite(Number(data.total)) ? Number(data.total) : channels.length,
      current: publicChannel(data.current),
    });
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.message || 'Could not load Movie Night catalog' });
  }
});

function decodeXtreamText(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return decoded && /[A-Za-z0-9]/.test(decoded) ? decoded : cleanString(raw, 500);
  } catch (_) { return cleanString(raw, 500); }
}

router.get('/epg/:streamId', requireAuth, requireMovieNightAccess, async (req, res) => {
  const streamId = Number.parseInt(req.params.streamId, 10);
  if (!Number.isSafeInteger(streamId) || streamId < 1) return res.status(400).json({ error: 'Invalid channel' });
  const source = await playlistConnectionById(req.query.playlist_id) || await primaryPlaylistConnection();
  if (!(source && source.base && source.username && source.password)) {
    return res.status(503).json({ error: 'Live TV guide is not configured' });
  }
  try {
    const data = await xtreamRequest('get_short_epg', { stream_id: streamId, limit: 24 }, null, source);
    const entries = Array.isArray(data?.epg_listings) ? data.epg_listings : [];
    return res.json({ stream_id: streamId, listings: entries.map((entry) => ({
      id: cleanString(entry.id || '', 120),
      title: decodeXtreamText(entry.title),
      description: decodeXtreamText(entry.description),
      start: cleanString(entry.start || '', 40),
      end: cleanString(entry.end || '', 40),
      start_timestamp: Number(entry.start_timestamp) || null,
      stop_timestamp: Number(entry.stop_timestamp) || null,
      now_playing: String(entry.now_playing) === '1',
    })).filter((entry) => entry.title) });
  } catch (error) {
    return res.status(503).json({ error: 'Could not load the live TV guide' });
  }
});

router.get('/series/:seriesId', requireAuth, requireMovieNightAccess, async (req, res) => {
  const source = await playlistConnectionById(req.query.playlist_id) || await primaryPlaylistConnection();
  if (!(source && source.base && source.username && source.password)) {
    return res.status(503).json({ error: 'Series playback is not configured' });
  }
  const seriesId = Number.parseInt(req.params.seriesId, 10);
  if (!Number.isSafeInteger(seriesId) || seriesId < 1) return res.status(400).json({ error: 'Invalid series' });
  try {
    const data = await xtreamRequest('get_series_info', { series_id: seriesId }, null, source);
    const episodes = [];
    const seasons = data && data.episodes && typeof data.episodes === 'object' ? data.episodes : {};
    Object.keys(seasons).forEach((seasonKey) => {
      (Array.isArray(seasons[seasonKey]) ? seasons[seasonKey] : []).forEach((episode, index) => {
        const streamId = Number.parseInt(episode.id || episode.episode_id || episode.stream_id, 10);
        if (!Number.isSafeInteger(streamId) || streamId < 1) return;
        const extension = String(episode.container_extension || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
        const sourceUrl = `${iptvStreamOrigin(source)}/series/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}/${streamId}.${extension}`;
        const item = { id: streamId, kind: 'episode', title: cleanString(episode.title || `Episode ${index + 1}`, 180), group: `Season ${seasonKey}`, sourceUrl, playlist_id: source.id };
        const token = issueStreamToken(req.user.id, item);
        episodes.push({ id: streamId, title: item.title, season: String(seasonKey), episode: Number(episode.episode_num || index + 1), stream_token: token });
      });
    });
    return res.json({ title: cleanString(data?.info?.name || '', 180) || 'Series', episodes });
  } catch (error) {
    return res.status(503).json({ error: 'Could not load series episodes' });
  }
});

router.get('/stream/:token', async (req, res) => {
  // Do not require the session header here: browsers do not send custom
  // headers for <video> requests.  The opaque token is short-lived, bound to
  // one user, and its owner is checked against the live Discord role below.
  const rawEntry = streamTokens.get(String(req.params.token || ''));
  if (!rawEntry || rawEntry.expiresAt < Date.now() || !rawEntry.sourceUrl) {
    streamTokens.delete(String(req.params.token || ''));
    return res.status(404).json({ error: 'Playback link expired' });
  }
  let streamAccess;
  try {
    streamAccess = await getStreamUser(rawEntry, req);
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Movie Night setup has not been installed yet' });
    console.error('[MovieNight] stream access check failed:', error.message);
    return res.status(503).json({ error: 'Movie Night access check is temporarily unavailable' });
  }
  if (!streamAccess) return res.status(403).json({ error: 'Movie Night access is no longer available' });
  const streamUserId = streamAccess.user.id;
  const entry = takeStreamToken(req.params.token, streamUserId);
  if (!entry || !entry.sourceUrl) return res.status(404).json({ error: 'Playback link expired' });
  try {
    if (!(await watchSessionIsActive(entry.sessionId))) return res.status(410).json({ error: 'This viewing session was stopped by an administrator' });
  } catch (error) {
    console.error('[MovieNight] watch session check failed:', error.message);
    return res.status(503).json({ error: 'Movie Night session status is temporarily unavailable' });
  }
  touchWatchSession(entry.sessionId);
  const sourceUrl = cleanProviderUrl(entry.sourceUrl);
  if (!sourceUrl) return res.status(404).json({ error: 'Playback source unavailable' });
  try {
    const isPlaylist = /\.m3u8(?:$|\?)/i.test(sourceUrl);
    const requestHeaders = providerRequestHeaders(entry, sourceUrl, req);
    const response = await axios.get(sourceUrl, {
      responseType: isPlaylist ? 'text' : 'stream', timeout: CONTROL_TIMEOUT_MS,
      headers: requestHeaders,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const contentType = String(response.headers['content-type'] || '');
    if (isPlaylist || /mpegurl/i.test(contentType)) {
      const playlist = typeof response.data === 'string'
        ? response.data
        : await new Promise((resolve, reject) => {
          let text = '';
          response.data.setEncoding?.('utf8');
          response.data.on('data', (chunk) => { text += String(chunk); });
          response.data.on('end', () => resolve(text));
          response.data.on('error', reject);
        });
      const effectiveSourceUrl = cleanProviderUrl(response?.request?.res?.responseUrl || response?.request?._currentUrl) || sourceUrl;
      const childContext = providerStreamContext(entry, effectiveSourceUrl, response, requestHeaders);
      const rewritten = playlist.split(/\r?\n/).map((line) => {
        if (!line || line.startsWith('#EXT')) {
          return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
            const absolute = cleanProviderUrl(new URL(uri, effectiveSourceUrl).toString());
            if (!absolute) return `URI="${uri}"`;
            const child = issueStreamToken(streamUserId, { sourceUrl: absolute, title: entry.title, kind: entry.kind, sessionId: entry.sessionId }, childContext);
            return `URI="/api/movie-night/stream/${child}"`;
          });
        }
        if (line.trim().startsWith('#')) return line;
        let absolute;
        try { absolute = cleanProviderUrl(new URL(line.trim(), effectiveSourceUrl).toString()); } catch (_) { absolute = null; }
        if (!absolute) return line;
        const child = issueStreamToken(streamUserId, { sourceUrl: absolute, title: entry.title, kind: entry.kind, sessionId: entry.sessionId }, childContext);
        return `/api/movie-night/stream/${child}`;
      }).join('\n');
      res.status(200).set({
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
      }).send(rewritten);
      return;
    }
    const upstreamType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const mediaType = upstreamType === 'application/octet-stream' || !upstreamType
      ? ((entry.kind === 'movie' || entry.kind === 'episode') ? 'video/mp4' : (upstreamType || 'application/octet-stream'))
      : upstreamType;
    res.status(response.status).set({
      'Content-Type': mediaType,
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      ...(response.headers['accept-ranges'] ? { 'Accept-Ranges': response.headers['accept-ranges'] } : {}),
      ...(response.headers['content-range'] ? { 'Content-Range': response.headers['content-range'] } : {}),
    });
    response.data.on('error', () => { if (!res.headersSent) res.status(502); res.end(); });
    response.data.pipe(res);
  } catch (error) {
    return res.status(502).json({ error: 'The IPTV stream is temporarily unavailable' });
  }
});

router.post('/play', requireAuth, requireMovieNightAccess, async (req, res) => {
  const channelId = Number.parseInt(req.body?.channel_id, 10);
  if (!Number.isSafeInteger(channelId) || channelId < 1) {
    return res.status(400).json({ error: 'Choose a valid Movie Night title' });
  }
  try {
    const browserConnections = await playlistConnections();
    if (browserConnections.length) {
      const kind = cleanString(req.body?.kind, 20).toLowerCase() || 'live';
      let item = null;
      if (req.body?.stream_token) {
        const tokenEntry = takeStreamToken(req.body.stream_token, req.user.id);
        if (!tokenEntry) return res.status(404).json({ error: 'This playback link has expired' });
        item = { id: channelId, kind: tokenEntry.kind, title: tokenEntry.title, group: null, sourceUrl: tokenEntry.sourceUrl, container: tokenEntry.container, playlist_id: tokenEntry.playlistId };
      } else {
        const catalog = await getBrowserCatalog(kind);
        item = catalog && catalog.items.find((candidate) => Number(candidate.id) === channelId && String(candidate.kind) === kind);
      }
      if (!item || !item.sourceUrl) {
        return res.status(400).json({ error: kind === 'series' ? 'Choose an episode from the series list' : 'That title is no longer available' });
      }
      // A full playlist slot should fail over to the next matching playlist,
      // but do that lazily. Fetching every provider's (potentially very large)
      // catalog before trying the first slot made a click feel slow even when
      // the primary playlist had capacity. Only inspect alternates after the
      // atomic slot reservation says the current playlist is full.
      const primary = { item, playlistId: item.playlist_id || req.body?.playlist_id || null };
      let sessionId = null;
      let chosen = null;
      const tryCandidate = async (candidate) => {
        try {
          const id = await beginWatchSession({ playlistId: candidate.playlistId, user: req.user, channel: candidate.item });
          if (id === 0) return false;
          sessionId = id;
          chosen = candidate;
          return true;
        } catch (sessionError) {
          if (!migrationError(sessionError)) throw sessionError;
          // Legacy environment-backed playback has no playlist table/slot;
          // it is still a valid candidate with a null session id.
          sessionId = null;
          chosen = candidate;
          return true;
        }
      };
      if (!(await tryCandidate(primary))) {
        for (const source of browserConnections) {
          if (String(source.id || '') === String(primary.playlistId || '')) continue;
          try {
            const alternate = await getBrowserCatalog(kind, source);
            const match = alternate && alternate.items.find((candidate) => String(candidate.kind) === String(kind)
              && (String(candidate.title).toLowerCase() === String(item.title).toLowerCase()
                || (Number(candidate.id) === channelId && !source.id)));
            if (match && await tryCandidate({ item: match, playlistId: source.id || null })) break;
          } catch (_) { /* try the next configured playlist */ }
        }
      }
      if (!chosen) return res.status(429).json({ error: 'All available IPTV playlists are at their viewing limit or temporarily unavailable. Please wait for a slot to open.' });
      item = chosen.item;
      const channel = publicChannel({ id: item.id, title: item.title, group: item.group, logo: item.logo, kind: item.kind, playlist_id: chosen.playlistId }) || { id: channelId, title: item.title };
      const token = issueStreamToken(req.user.id, { ...item, sessionId });
      await writePlaybackLog({ user: req.user, channel, action: 'play', status: 'started' });
      const streamType = /\.m3u8(?:$|\?)/i.test(String(item.sourceUrl || '')) || /m3u8/i.test(String(item.container || '')) ? 'hls' : 'file';
      return res.json({ success: true, mode: 'browser', channel, stream_type: streamType, stream_url: `/api/movie-night/stream/${token}` });
    }
    // The caller's Discord id comes exclusively from the verified web session.
    // The browser cannot choose another user or another Discord guild.
    const data = await callControl('post', '/v1/play', {
      channel_id: channelId,
      discord_id: String(req.user.discord_id),
      guild_id: String(GUILD_ID || ''),
    });
    const channel = publicChannel(data.channel) || { id: channelId, title: 'Movie Night' };
    await writePlaybackLog({ user: req.user, channel, action: 'play', status: 'started', detail: data.voice_channel_name || null });
    return res.json({ success: true, channel, voice_channel_name: cleanString(data.voice_channel_name, 100) || null });
  } catch (error) {
    await writePlaybackLog({
      user: req.user,
      channel: { id: channelId, title: 'Movie Night' },
      action: 'play', status: 'failed', detail: error.statusCode && error.statusCode < 500 ? error.message : 'Streaming service unavailable',
    });
    return res.status(error.statusCode || 503).json({ error: error.message || 'Could not start Movie Night' });
  }
});

router.post('/stop', requireAuth, requireMovieNightAccess, async (req, res) => {
  try {
    if (await browserIptvConfiguredAsync()) {
      await endWatchSessions(req.user.id);
      await writePlaybackLog({ user: req.user, channel: { title: 'Movie Night' }, action: 'stop', status: 'stopped' });
      return res.json({ success: true, current: null, mode: 'browser' });
    }
    const data = await callControl('post', '/v1/stop', { guild_id: String(GUILD_ID || '') });
    const channel = publicChannel(data.channel) || { title: 'Movie Night' };
    await writePlaybackLog({ user: req.user, channel, action: 'stop', status: 'stopped' });
    return res.json({ success: true, current: null });
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.message || 'Could not stop Movie Night' });
  }
});

router.get('/history', requireAuth, requireMovieNightAccess, async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 25));
  try {
    const { rows } = await db.query(
      `SELECT l.id, l.channel_id, l.title, l.group_title, l.action, l.status, l.detail, l.created_at,
              COALESCE(u.username, 'Unknown user') AS username
         FROM movie_night_playback_log l
         LEFT JOIN web_users u ON u.id = l.user_id
        ORDER BY l.created_at DESC
        LIMIT $1`,
      [limit]
    );
    return res.json({ history: rows.map((row) => ({
      id: Number(row.id), title: cleanString(row.title, 180), group: cleanString(row.group_title, 120) || null,
      action: cleanString(row.action, 20), status: cleanString(row.status, 20),
      detail: cleanString(row.detail, 250) || null, username: cleanString(row.username, 80) || 'Unknown user',
      created_at: row.created_at,
    })) });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Movie Night setup has not been installed yet' });
    return res.status(500).json({ error: 'Could not load Movie Night history' });
  }
});

// Owner admins need to be able to inspect the audit log even when they are not
// personally assigned a viewing role (for example while the feature is off).
router.get('/admin/history', requireOwnerAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));
  try {
    const { rows } = await db.query(
      `SELECT l.id, l.channel_id, l.title, l.group_title, l.action, l.status, l.detail, l.created_at,
              COALESCE(u.username, 'Unknown user') AS username
         FROM movie_night_playback_log l
         LEFT JOIN web_users u ON u.id = l.user_id
        ORDER BY l.created_at DESC
        LIMIT $1`,
      [limit]
    );
    return res.json({ history: rows.map((row) => ({
      id: Number(row.id), title: cleanString(row.title, 180), group: cleanString(row.group_title, 120) || null,
      action: cleanString(row.action, 20), status: cleanString(row.status, 20),
      detail: cleanString(row.detail, 250) || null, username: cleanString(row.username, 80) || 'Unknown user',
      created_at: row.created_at,
    })) });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Movie Night setup has not been installed yet' });
    return res.status(500).json({ error: 'Could not load Movie Night history' });
  }
});

// ─── Admin IPTV playlist and room controls ────────────────────────────────
// Provider URLs and credentials are accepted only over an authenticated owner
// request, encrypted before storage, and represented to the browser by hosts
// and masked status only. A playlist is never returned with its secret fields.
router.get('/admin/playlists', requireOwnerAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.method, p.playlist_url_enc, p.host_url_enc,
              p.username_enc, p.password_enc, p.max_users, p.enabled,
              p.sort_order, p.live_categories, p.movie_categories,
              p.series_categories,
              (SELECT COUNT(*) FROM movie_night_watch_sessions s
                WHERE s.playlist_id = p.id AND s.status = 'active'
                  AND s.last_seen_at > now() - interval '2 hours') AS active_users
         FROM movie_night_playlists p
        WHERE p.guild_id = $1
        ORDER BY p.sort_order, p.id`, [GUILD_ID]
    );
    return res.json({ playlists: rows.map(maskedPlaylist) });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Playlist management migration is not installed yet' });
    console.error('[MovieNight] playlist list failed:', error.message);
    return res.status(500).json({ error: 'Could not load IPTV playlists' });
  }
});

function playlistInput(body, current) {
  const method = playlistMethod(body?.method || current?.method);
  const name = cleanString(body?.name ?? current?.name, 120);
  const maxUsers = Math.max(1, Math.min(1000, Number.parseInt(body?.max_users ?? current?.max_users, 10) || 1));
  const enabled = body?.enabled == null ? current?.enabled !== false : body.enabled === true;
  const sortOrder = Math.max(0, Math.min(100000, Number.parseInt(body?.sort_order ?? current?.sort_order, 10) || 0));
  if (!name) { const e = new Error('Playlist name is required'); e.statusCode = 400; throw e; }
  const value = (key, encryptedKey) => {
    const clearKey = `clear_${key}`;
    if (body && body[clearKey] === true) return '';
    if (body && Object.prototype.hasOwnProperty.call(body, key)) {
      const text = String(body[key] == null ? '' : body[key]).trim();
      return text ? text : (current ? decryptRuntimeSecret(String(current[encryptedKey] || '')) || '' : '');
    }
    return current ? decryptRuntimeSecret(String(current[encryptedKey] || '')) || '' : '';
  };
  const playlistUrlValue = value('playlist_url', 'playlist_url_enc');
  const hostValue = value('host_url', 'host_url_enc');
  const usernameValue = value('username', 'username_enc');
  const passwordValue = value('password', 'password_enc');
  if (method === 'm3u') {
    if (!playlistUrlValue || !validPrivateUrl(playlistUrlValue)) { const e = new Error('M3U playlist URL must be a valid http(s) URL'); e.statusCode = 400; throw e; }
  } else if (!hostValue || !validPrivateUrl(hostValue) || !usernameValue || !passwordValue) {
    const e = new Error('XC playlists require a valid host, username, and password'); e.statusCode = 400; throw e;
  }
  return {
    name, method, maxUsers, enabled, sortOrder,
    playlistUrlValue: method === 'm3u' ? playlistUrlValue : '',
    hostValue: method === 'xtream' ? hostValue : '',
    usernameValue: method === 'xtream' ? usernameValue : '',
    passwordValue: method === 'xtream' ? passwordValue : '',
    liveCategories: playlistCategories(body?.live_categories ?? current?.live_categories),
    movieCategories: playlistCategories(body?.movie_categories ?? current?.movie_categories),
    seriesCategories: playlistCategories(body?.series_categories ?? current?.series_categories),
  };
}

function encryptedOrNull(value) {
  return value ? encryptRuntimeSecret(value) : null;
}

router.post('/admin/playlists', requireOwnerAdmin, async (req, res) => {
  try {
    const input = playlistInput(req.body || {});
    const { rows } = await db.query(
      `INSERT INTO movie_night_playlists
         (guild_id, name, method, playlist_url_enc, host_url_enc, username_enc,
          password_enc, max_users, enabled, sort_order, live_categories,
          movie_categories, series_categories, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,now())
       RETURNING id, name, method, max_users, enabled, sort_order,
                 live_categories, movie_categories, series_categories`,
      [GUILD_ID, input.name, input.method, encryptedOrNull(input.playlistUrlValue),
        encryptedOrNull(input.hostValue), encryptedOrNull(input.usernameValue),
        encryptedOrNull(input.passwordValue), input.maxUsers, input.enabled, input.sortOrder,
        JSON.stringify(input.liveCategories), JSON.stringify(input.movieCategories), JSON.stringify(input.seriesCategories)]
    );
    await logAdminAction(req, 'movie_night_playlist_create', Number(rows[0].id), { name: input.name, method: input.method, max_users: input.maxUsers });
    return res.status(201).json({ success: true, playlist: maskedPlaylist(rows[0]) });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Playlist management migration is not installed yet' });
    console.error('[MovieNight] playlist create failed:', error.message);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not add IPTV playlist' });
  }
});

router.put('/admin/playlists/:id', requireOwnerAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid playlist' });
  try {
    const found = await db.query('SELECT * FROM movie_night_playlists WHERE id = $1 AND guild_id = $2 LIMIT 1', [id, GUILD_ID]);
    if (!found.rows[0]) return res.status(404).json({ error: 'Playlist not found' });
    const input = playlistInput(req.body || {}, found.rows[0]);
    const { rows } = await db.query(
      `UPDATE movie_night_playlists SET name=$1, method=$2, playlist_url_enc=$3,
          host_url_enc=$4, username_enc=$5, password_enc=$6, max_users=$7,
          enabled=$8, sort_order=$9, live_categories=$10::jsonb,
          movie_categories=$11::jsonb, series_categories=$12::jsonb, updated_at=now()
        WHERE id=$13 AND guild_id=$14
        RETURNING id, name, method, max_users, enabled, sort_order,
                  live_categories, movie_categories, series_categories`,
      [input.name, input.method, encryptedOrNull(input.playlistUrlValue), encryptedOrNull(input.hostValue),
        encryptedOrNull(input.usernameValue), encryptedOrNull(input.passwordValue), input.maxUsers,
        input.enabled, input.sortOrder, JSON.stringify(input.liveCategories), JSON.stringify(input.movieCategories),
        JSON.stringify(input.seriesCategories), id, GUILD_ID]
    );
    await logAdminAction(req, 'movie_night_playlist_update', id, { name: input.name, method: input.method, max_users: input.maxUsers });
    return res.json({ success: true, playlist: maskedPlaylist(rows[0]) });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Playlist management migration is not installed yet' });
    console.error('[MovieNight] playlist update failed:', error.message);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not update IPTV playlist' });
  }
});

router.delete('/admin/playlists/:id', requireOwnerAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid playlist' });
  try {
    const result = await db.query(
      `UPDATE movie_night_watch_sessions SET status='stopped', ended_at=now(), last_seen_at=now()
        WHERE playlist_id=$1 AND status='active';
       DELETE FROM movie_night_playlists WHERE id=$1 AND guild_id=$2`, [id, GUILD_ID]
    );
    await logAdminAction(req, 'movie_night_playlist_delete', id, {});
    return res.json({ success: true, deleted: Number(result?.[1]?.rowCount || result?.rowCount || 0) > 0 });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Playlist management migration is not installed yet' });
    console.error('[MovieNight] playlist delete failed:', error.message);
    return res.status(500).json({ error: 'Could not remove IPTV playlist' });
  }
});

router.get('/admin/sessions', requireOwnerAdmin, async (_req, res) => {
  try {
    await db.query(`UPDATE movie_night_watch_sessions SET status='expired', ended_at=now()
      WHERE status='active' AND last_seen_at <= now() - interval '2 hours'`);
    const { rows } = await db.query(
      `SELECT s.id, s.playlist_id, p.name AS playlist_name, s.user_id, s.discord_id,
              s.channel_id, s.title, s.status, s.started_at, s.last_seen_at
         FROM movie_night_watch_sessions s
         LEFT JOIN movie_night_playlists p ON p.id=s.playlist_id
        WHERE s.status='active' ORDER BY s.started_at DESC LIMIT 250`
    );
    return res.json({ sessions: rows.map((row) => ({
      id: Number(row.id), playlist_id: row.playlist_id ? Number(row.playlist_id) : null,
      playlist_name: cleanString(row.playlist_name || 'Legacy provider', 120), user_id: row.user_id ? Number(row.user_id) : null,
      discord_id: cleanString(row.discord_id || '', 30) || null, channel_id: row.channel_id ? Number(row.channel_id) : null,
      title: cleanString(row.title, 180), status: row.status, started_at: row.started_at, last_seen_at: row.last_seen_at,
    })) });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Playlist management migration is not installed yet' });
    return res.status(500).json({ error: 'Could not load active Movie Night sessions' });
  }
});

router.post('/admin/sessions/:id/stop', requireOwnerAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid session' });
  try {
    const result = await db.query(`UPDATE movie_night_watch_sessions
      SET status='stopped', ended_at=now(), last_seen_at=now()
      WHERE id=$1 AND status='active'`, [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Session is already stopped' });
    await logAdminAction(req, 'movie_night_session_stop', id, {});
    return res.json({ success: true });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Playlist management migration is not installed yet' });
    return res.status(500).json({ error: 'Could not stop the Movie Night session' });
  }
});

router.delete('/admin/history', requireOwnerAdmin, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM movie_night_playback_log');
    await logAdminAction(req, 'movie_night_history_clear', null, { deleted: Number(result.rowCount) || 0 });
    return res.json({ success: true, deleted: Number(result.rowCount) || 0 });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Movie Night setup has not been installed yet' });
    return res.status(500).json({ error: 'Could not clear the Movie Night room log' });
  }
});

router.get('/admin/settings', requireOwnerAdmin, async (req, res) => {
  try {
    const [settings, roles] = await Promise.all([getSettings(), getGuildRoles(false)]);
    return res.json({
      enabled: settings.enabled,
      allowed_role_ids: settings.allowedRoleIds,
      roles: roles
        .filter((role) => role && role.name !== '@everyone' && !role.managed)
        .map((role) => ({ id: String(role.id), name: cleanString(role.name, 100), color: Number(role.color || 0), position: Number(role.position || 0) }))
        .sort((a, b) => b.position - a.position),
      streaming_configured: controlConfigured() || browserIptvConfigured(),
      control_configured: controlConfigured(),
      browser_configured: browserIptvConfigured(),
      browser_config: maskedSecretConfig(),
    });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Movie Night setup has not been installed yet' });
    console.error('[MovieNight] admin settings failed:', error.message);
    return res.status(error.statusCode || 500).json({ error: 'Could not load Movie Night settings' });
  }
});

router.put('/admin/settings', requireOwnerAdmin, async (req, res) => {
  const enabled = req.body?.enabled === true;
  const allowedRoleIds = cleanRoleIds(req.body?.allowed_role_ids);
  try {
    const roles = await getGuildRoles(false);
    const validIds = new Set(roles.filter((role) => role && role.name !== '@everyone' && !role.managed).map((role) => String(role.id)));
    if (allowedRoleIds.some((id) => !validIds.has(id))) {
      return res.status(400).json({ error: 'One or more selected Discord roles no longer exist' });
    }
    if (enabled && !allowedRoleIds.length) {
      return res.status(400).json({ error: 'Select at least one Discord role before enabling Movie Night' });
    }
    const changedSecrets = await saveMovieNightSecretConfig(req.body || {});
    await db.query(
      `INSERT INTO movie_night_settings (singleton, enabled, allowed_role_ids, updated_by, updated_at)
       VALUES (true,$1,$2::jsonb,$3,now())
       ON CONFLICT (singleton) DO UPDATE
         SET enabled = EXCLUDED.enabled, allowed_role_ids = EXCLUDED.allowed_role_ids,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [enabled, JSON.stringify(allowedRoleIds), req.user.id]
    );
    await logAdminAction(req, 'movie_night_settings', null, { enabled, allowed_role_ids: allowedRoleIds });
    return res.json({
      success: true,
      enabled,
      allowed_role_ids: allowedRoleIds,
      streaming_configured: controlConfigured() || browserIptvConfigured(),
      control_configured: controlConfigured(),
      browser_configured: browserIptvConfigured(),
      browser_config: maskedSecretConfig(),
      changed_secret_fields: changedSecrets,
    });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Movie Night setup has not been installed yet' });
    console.error('[MovieNight] save settings failed:', error.message);
    return res.status(error.statusCode || 500).json({ error: 'Could not save Movie Night settings' });
  }
});

module.exports = router;
