'use strict';

// Offline contract test for browser playback.  It deliberately uses no real
// IPTV, Discord, database, or session credentials.
const assert = require('assert');
const express = require('express');
const http = require('http');
const { PassThrough } = require('stream');

process.env.GUILD_ID = 'guild-test';
process.env.MOVIE_NIGHT_XTREAM_URL = 'https://iptv.test';
process.env.MOVIE_NIGHT_XTREAM_USERNAME = 'user-test';
process.env.MOVIE_NIGHT_XTREAM_PASSWORD = 'pass-test';

const user = {
  id: 7,
  guild_id: 'guild-test',
  role: 'member',
  discord_id: '123456789012345678',
  discord_verified: true,
  banned: false,
};

const fakeDb = {
  query: async (sql) => {
    if (/FROM movie_night_settings/i.test(sql)) {
      return { rows: [{ enabled: true, allowed_role_ids: ['987654321098765432'], updated_at: new Date() }] };
    }
    if (/INSERT INTO movie_night_playback_log/i.test(sql)) return { rows: [] };
    if (/FROM web_users u/i.test(sql)) return { rows: [user] };
    throw new Error(`Unexpected test query: ${sql}`);
  },
};

const fakeAuth = {
  requireAuth: (req, _res, next) => { req.user = user; next(); },
  requireOwnerAdmin: (_req, res) => res.status(403).end(),
  discordLinked: () => true,
  bearerToken: () => null,
  getSessionUser: async () => null,
};
const fakeDiscord = {
  checkDiscordAccess: async () => ({ inServer: true, hasCustomerRole: true, roleIds: ['987654321098765432'] }),
  getGuildRoles: async () => [],
};
const fakeAdminLog = { logAdminAction: async () => {} };

const dbPath = require.resolve('./db');
const authPath = require.resolve('./utils/auth');
const discordPath = require.resolve('./utils/discordAccess');
const adminLogPath = require.resolve('./utils/adminLog');
const axiosPath = require.resolve('axios');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: fakeAuth };
require.cache[discordPath] = { id: discordPath, filename: discordPath, loaded: true, exports: fakeDiscord };
require.cache[adminLogPath] = { id: adminLogPath, filename: adminLogPath, loaded: true, exports: fakeAdminLog };

function streamResponse(contentType, body) {
  const data = new PassThrough();
  process.nextTick(() => data.end(Buffer.from(body)));
  return { status: 200, headers: { 'content-type': contentType }, data };
}

const fakeAxios = {
  get: async (url, options = {}) => {
    if (url.includes('player_api.php')) {
      const action = new URL(url).searchParams.get('action');
      if (action === 'get_live_streams') {
        return { status: 200, data: [{ stream_id: 1, name: 'Test Live', category_name: 'News', stream_icon: '', container_extension: 'ts' }] };
      }
      if (action === 'get_vod_streams') return { status: 200, data: [] };
      if (action === 'get_series') return { status: 200, data: [] };
    }
    if (url.includes('/live/')) {
      assert.strictEqual(options.responseType, 'text');
      return {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        data: '#EXTM3U\n#EXT-X-TARGETDURATION:4\nsegment.ts\n',
      };
    }
    if (url.includes('/segment.ts')) return streamResponse('video/mp2t', 'segment');
    throw new Error(`Unexpected IPTV URL: ${url}`);
  },
};
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: fakeAxios };

const router = require('./routes/movieNight');
const app = express();
app.use(express.json());
app.use('/api/movie-night', router);

(async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/movie-night`;
  try {
    const play = await fetch(`${base}/play`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: 1, kind: 'live' }),
    });
    assert.strictEqual(play.status, 200);
    const playBody = await play.json();
    assert.strictEqual(playBody.stream_type, 'hls');
    assert.match(playBody.stream_url, /^\/api\/movie-night\/stream\//);

    // This request intentionally has no Authorization header, matching a
    // native <video> element's request. The opaque stream capability is enough.
    const origin = new URL(base).origin;
    const playlist = await fetch(`${origin}${playBody.stream_url}`);
    assert.strictEqual(playlist.status, 200);
    assert.match(await playlist.text(), /\/api\/movie-night\/stream\//);

    console.log('Movie Night browser stream contract passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
