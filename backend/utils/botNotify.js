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
    if (res.data && res.data.handled === false) {
      console.warn(`[BotNotify] Bot has no handler for '${event}' — notification dropped`);
    }
    return res.data || null;
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 404) {
      console.warn(`[BotNotify] Bot returned 404 for '${event}' — the bot is running an older build without /internal routes`);
    } else if (status === 401 || status === 503) {
      console.warn(`[BotNotify] Bot rejected '${event}' (${status}) — API_SECRET mismatch or not set on the bot`);
    } else if (status) {
      console.warn(`[BotNotify] Bot returned ${status} for '${event}':`, err.message);
    } else {
      console.warn(`[BotNotify] Could not reach bot for '${event}':`, err.message);
    }
    return null;
  }
}

module.exports = { notifyBot };
