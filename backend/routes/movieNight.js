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

const router = express.Router();
const GUILD_ID = process.env.GUILD_ID;
const CONTROL_URL = String(process.env.MOVIE_NIGHT_CONTROL_URL || '').replace(/\/+$/, '');
const CONTROL_TOKEN = process.env.MOVIE_NIGHT_CONTROL_TOKEN || '';
const CONTROL_TIMEOUT_MS = Math.max(1000, Math.min(15000, Number(process.env.MOVIE_NIGHT_CONTROL_TIMEOUT_MS) || 7000));
const MAX_CATALOG_LIMIT = 100;
// Browser playback uses a server-side Xtream/M3U proxy. Provider credentials
// stay in the backend environment; the browser receives only short-lived,
// per-user proxy tokens. The older Luminary control path remains available as
// a compatibility fallback until the browser IPTV connection is configured.
const IPTV_BASE = String(process.env.MOVIE_NIGHT_XTREAM_URL || process.env.MOVIE_NIGHT_IPTV_URL || '').replace(/\/+$/, '');
const IPTV_USER = String(process.env.MOVIE_NIGHT_XTREAM_USERNAME || process.env.MOVIE_NIGHT_IPTV_USERNAME || '').trim();
const IPTV_PASSWORD = String(process.env.MOVIE_NIGHT_XTREAM_PASSWORD || process.env.MOVIE_NIGHT_IPTV_PASSWORD || '').trim();
const IPTV_M3U_URL = String(process.env.MOVIE_NIGHT_M3U_URL || '').trim();
// Xtream servers commonly expose live channels as MPEG-TS (`.ts`) and also
// provide an HLS variant. Browsers cannot play a raw TS response reliably, so
// prefer the HLS variant for the browser player; an owner can override this for
// a provider that uses a different live extension.
const IPTV_LIVE_EXTENSION = String(process.env.MOVIE_NIGHT_XTREAM_LIVE_EXTENSION || 'm3u8').replace(/[^a-z0-9]/gi, '') || 'm3u8';
const STREAM_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const streamTokens = new Map();
let browserCatalogCache = { at: 0, items: [], groups: [] };

function browserIptvConfigured() { return !!((IPTV_BASE && IPTV_USER && IPTV_PASSWORD) || IPTV_M3U_URL); }

function iptvStreamOrigin() {
  return IPTV_BASE.replace(/\/player_api\.php$/i, '').replace(/\/+$/, '');
}

function cleanProviderUrl(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw;
}

function stableStreamId(value, fallback) {
  const text = String(value || fallback || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return Math.abs(hash >>> 0) || 1;
}

async function xtreamRequest(action, extra) {
  if (!(IPTV_BASE && IPTV_USER && IPTV_PASSWORD)) return null;
  const base = /player_api\.php$/i.test(IPTV_BASE) ? IPTV_BASE : IPTV_BASE + '/player_api.php';
  const params = new URLSearchParams({ username: IPTV_USER, password: IPTV_PASSWORD, action: String(action) });
  Object.entries(extra || {}).forEach(([key, value]) => { if (value != null) params.set(key, String(value)); });
  const response = await axios.get(base + '?' + params.toString(), { timeout: CONTROL_TIMEOUT_MS, validateStatus: (status) => status < 500 });
  if (response.status >= 400) throw new Error('IPTV catalog request failed');
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

async function parseM3U() {
  if (!IPTV_M3U_URL) return [];
  const response = await axios.get(IPTV_M3U_URL, { timeout: CONTROL_TIMEOUT_MS, responseType: 'text' });
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
      const item = normaliseBrowserItem({ name: info.name, group: info.group, logo: info.logo }, kind, line.trim(), items.length);
      if (item) items.push(item);
      info = null;
    }
  }
  return items;
}

async function getBrowserCatalog() {
  if (!browserIptvConfigured()) return null;
  if (Date.now() - browserCatalogCache.at < 60_000 && browserCatalogCache.items.length) return browserCatalogCache;
  let items = [];
  if (IPTV_BASE && IPTV_USER && IPTV_PASSWORD) {
    const [live, movies, series] = await Promise.all([
      xtreamRequest('get_live_streams'),
      xtreamRequest('get_vod_streams'),
      xtreamRequest('get_series'),
    ]);
    const liveRows = Array.isArray(live) ? live : [];
    const movieRows = Array.isArray(movies) ? movies : [];
    const seriesRows = Array.isArray(series) ? series : [];
    items = liveRows.map((row, i) => normaliseBrowserItem(row, 'live', `${iptvStreamOrigin()}/live/${encodeURIComponent(IPTV_USER)}/${encodeURIComponent(IPTV_PASSWORD)}/${row.stream_id}.${IPTV_LIVE_EXTENSION}`, i)).filter(Boolean)
      .concat(movieRows.map((row, i) => normaliseBrowserItem(row, 'movie', `${iptvStreamOrigin()}/movie/${encodeURIComponent(IPTV_USER)}/${encodeURIComponent(IPTV_PASSWORD)}/${row.stream_id}.${row.container_extension || 'mp4'}`, i)).filter(Boolean))
      .concat(seriesRows.map((row, i) => ({ id: Number.parseInt(row.series_id, 10) || stableStreamId(row.name, i), kind: 'series', title: cleanString(row.name, 180), group: cleanString(row.category_name || '', 120) || null, logo: /^https:\/\//i.test(String(row.cover || '')) ? String(row.cover) : null, sourceUrl: null, container: null })));
  } else {
    items = await parseM3U();
  }
  const groups = [...new Set(items.map((item) => item.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  browserCatalogCache = { at: Date.now(), items, groups };
  return browserCatalogCache;
}

function issueStreamToken(userId, item) {
  // Playlist rewriting can mint a token per segment. Prune old capabilities on
  // the write path so a long-running Movie Night session cannot grow this
  // process-local map without bound.
  const now = Date.now();
  for (const [key, value] of streamTokens) {
    if (!value || value.expiresAt < now) streamTokens.delete(key);
  }
  const token = require('crypto').randomBytes(24).toString('base64url');
  streamTokens.set(token, { userId: String(userId), sourceUrl: item.sourceUrl, title: item.title, kind: item.kind, expiresAt: now + STREAM_TOKEN_TTL_MS });
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
  return access.allowed ? { user, settings, access } : null;
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
    const canManage = req.user.role === 'admin';
    return res.json({
      visible: access.allowed || canManage,
      can_access: access.allowed,
      can_manage: canManage,
      enabled: settings.enabled,
      discord_linked: discordLinked(req.user),
      streaming_configured: controlConfigured() || browserIptvConfigured(),
      browser_configured: browserIptvConfigured(),
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
  const limit = Math.max(1, Math.min(MAX_CATALOG_LIMIT, Number.parseInt(req.query.limit, 10) || 40));
  try {
    const browserCatalog = await getBrowserCatalog();
    if (browserCatalog) {
      const wanted = search.toLowerCase();
      const filtered = browserCatalog.items.filter((item) => {
        if (group && String(item.group || '') !== group) return false;
        if (!wanted) return true;
        return `${item.title} ${item.group || ''} ${item.kind}`.toLowerCase().includes(wanted);
      }).slice(0, limit);
      return res.json({
        channels: filtered.map((item) => publicChannel({ id: item.id, title: item.title, group: item.group, logo: item.logo, kind: item.kind })),
        groups: browserCatalog.groups,
        total: filtered.length,
        current: null,
        mode: 'browser',
      });
    }
    const params = new URLSearchParams({ limit: String(limit) });
    if (search) params.set('search', search);
    if (group) params.set('group', group);
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

router.get('/series/:seriesId', requireAuth, requireMovieNightAccess, async (req, res) => {
  if (!browserIptvConfigured() || !(IPTV_BASE && IPTV_USER && IPTV_PASSWORD)) {
    return res.status(503).json({ error: 'Series playback is not configured' });
  }
  const seriesId = Number.parseInt(req.params.seriesId, 10);
  if (!Number.isSafeInteger(seriesId) || seriesId < 1) return res.status(400).json({ error: 'Invalid series' });
  try {
    const data = await xtreamRequest('get_series_info', { series_id: seriesId });
    const episodes = [];
    const seasons = data && data.episodes && typeof data.episodes === 'object' ? data.episodes : {};
    Object.keys(seasons).forEach((seasonKey) => {
      (Array.isArray(seasons[seasonKey]) ? seasons[seasonKey] : []).forEach((episode, index) => {
        const streamId = Number.parseInt(episode.id || episode.episode_id || episode.stream_id, 10);
        if (!Number.isSafeInteger(streamId) || streamId < 1) return;
        const extension = String(episode.container_extension || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
        const sourceUrl = `${iptvStreamOrigin()}/series/${encodeURIComponent(IPTV_USER)}/${encodeURIComponent(IPTV_PASSWORD)}/${streamId}.${extension}`;
        const item = { id: streamId, kind: 'episode', title: cleanString(episode.title || `Episode ${index + 1}`, 180), group: `Season ${seasonKey}`, sourceUrl };
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
  const sourceUrl = cleanProviderUrl(entry.sourceUrl);
  if (!sourceUrl) return res.status(404).json({ error: 'Playback source unavailable' });
  try {
    const isPlaylist = /\.m3u8(?:$|\?)/i.test(sourceUrl);
    const response = await axios.get(sourceUrl, {
      responseType: isPlaylist ? 'text' : 'stream', timeout: CONTROL_TIMEOUT_MS,
      headers: req.headers.range ? { Range: req.headers.range } : undefined,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    if (isPlaylist || /mpegurl/i.test(String(response.headers['content-type'] || ''))) {
      const playlist = String(response.data || '');
      const rewritten = playlist.split(/\r?\n/).map((line) => {
        if (!line || line.startsWith('#EXT')) {
          return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
            const absolute = cleanProviderUrl(new URL(uri, sourceUrl).toString());
            if (!absolute) return `URI="${uri}"`;
            const child = issueStreamToken(streamUserId, { sourceUrl: absolute, title: entry.title, kind: entry.kind });
            return `URI="/api/movie-night/stream/${child}"`;
          });
        }
        if (line.trim().startsWith('#')) return line;
        let absolute;
        try { absolute = cleanProviderUrl(new URL(line.trim(), sourceUrl).toString()); } catch (_) { absolute = null; }
        if (!absolute) return line;
        const child = issueStreamToken(streamUserId, { sourceUrl: absolute, title: entry.title, kind: entry.kind });
        return `/api/movie-night/stream/${child}`;
      }).join('\n');
      res.status(200).set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }).send(rewritten);
      return;
    }
    res.status(response.status).set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Cache-Control': 'no-store',
      ...(response.headers['content-length'] ? { 'Content-Length': response.headers['content-length'] } : {}),
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
    if (browserIptvConfigured()) {
      const kind = cleanString(req.body?.kind, 20).toLowerCase() || 'live';
      let item = null;
      if (req.body?.stream_token) {
        const tokenEntry = takeStreamToken(req.body.stream_token, req.user.id);
        if (!tokenEntry) return res.status(404).json({ error: 'This playback link has expired' });
        item = { id: channelId, kind: tokenEntry.kind, title: tokenEntry.title, group: null, sourceUrl: tokenEntry.sourceUrl };
      } else {
        const catalog = await getBrowserCatalog();
        item = catalog && catalog.items.find((candidate) => Number(candidate.id) === channelId && String(candidate.kind) === kind);
      }
      if (!item || !item.sourceUrl) {
        return res.status(400).json({ error: kind === 'series' ? 'Choose an episode from the series list' : 'That title is no longer available' });
      }
      const token = issueStreamToken(req.user.id, item);
      const channel = publicChannel({ id: item.id, title: item.title, group: item.group, logo: item.logo, kind: item.kind }) || { id: channelId, title: item.title };
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
    if (browserIptvConfigured()) {
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
    });
  } catch (error) {
    if (migrationError(error)) return res.status(503).json({ error: 'Movie Night setup has not been installed yet' });
    console.error('[MovieNight] save settings failed:', error.message);
    return res.status(error.statusCode || 500).json({ error: 'Could not save Movie Night settings' });
  }
});

module.exports = router;
