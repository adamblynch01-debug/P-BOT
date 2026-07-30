const axios = require('axios');

// Notify the Discord bot of events.
//
// The bot is a separate Railway service, so this is a real network call over
// the public internet — not the localhost hop the original default implied.
// Two things follow from that:
//
//   1. It needs a timeout. Without one, axios waits on the OS default (minutes)
//      and every caller that awaits notifyBot stalls with it. deliver() runs
//      after the payment transaction commits, so a hung notify cannot lose
//      money — but it can pin a request handler open for the whole wait.
//   2. Failures must stay non-fatal. The buyer has already paid and the goods
//      are already recorded as delivered; a Discord outage must not turn that
//      into an error the caller has to handle.
//
// Note the failure mode this replaces: the bot had no /internal/* routes at
// all, so every call 404'd and this warning was the only trace. It read like a
// transient "bot not up yet" — hence the original comment — when in fact no
// notification had ever been delivered. The message below names the status so
// a permanent 404 can't hide as a blip again.
const NOTIFY_TIMEOUT_MS = Number(process.env.BOT_NOTIFY_TIMEOUT_MS) || 8000;

async function notifyBot(event, data) {
  const botUrl = process.env.BOT_INTERNAL_URL || 'http://localhost:3001';
  try {
    const res = await axios.post(
      `${botUrl}/internal/${event}`,
      { secret: process.env.API_SECRET, ...data },
      { timeout: NOTIFY_TIMEOUT_MS }
    );
    // The bot answers 200 with handled:false for events it has no route for.
    // That is a deliberate "not an outage" signal, but it still means this
    // event went nowhere, so say so.
    //
    // `posted:false` is the other way an event dies: the route ran, but there
    // was no channel to send to. That case used to come back as
    // `{ok:true, posted:false}` and this function only looked at `handled` —
    // so a notification that reached nobody was indistinguishable from one
    // that landed. That is exactly how the order log failed silently while
    // returning 200. Both are now surfaced, and the caller can see it.
    const d = res.data || {};
    if (d.handled === false) {
      console.warn(`[BotNotify] Bot has no handler for '${event}' — notification dropped`);
    } else if (d.posted === false || d.log_channel_missing) {
      console.error(
        `[BotNotify] '${event}' reached the bot but was NOT posted` +
        (d.reason ? ` (${d.reason})` : '') +
        ' — check ORDER_LOG_CHANNEL_ID on the bot service'
      );
    }
    return res.data || null;
  } catch (err) {
    const status = err.response && err.response.status;
    const botMsg = err.response && err.response.data && err.response.data.error;
    if (status === 404) {
      console.warn(`[BotNotify] Bot returned 404 for '${event}' — the bot is running an older build without /internal routes`);
    } else if (status === 401) {
      console.warn(`[BotNotify] Bot rejected '${event}' (401) — API_SECRET mismatch or not set on the bot`);
    } else if (status === 503) {
      console.error(`[BotNotify] Bot could not deliver '${event}': ${botMsg || 'service not configured'}`);
    } else if (status) {
      console.warn(`[BotNotify] Bot returned ${status} for '${event}':`, err.message);
    } else {
      console.warn(`[BotNotify] Could not reach bot for '${event}':`, err.message);
    }
    return null;
  }
}

module.exports = { notifyBot };
