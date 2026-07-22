const axios = require('axios');

// Notify the Discord bot of events
// Bot runs on same Railway project so we call its internal HTTP server
async function notifyBot(event, data) {
  try {
    const botUrl = process.env.BOT_INTERNAL_URL || 'http://localhost:3001';
    await axios.post(`${botUrl}/internal/${event}`, {
      secret: process.env.API_SECRET,
      ...data,
    });
  } catch (err) {
    // Bot might not be running yet, non-fatal
    console.warn('[BotNotify] Could not reach bot:', err.message);
  }
}

module.exports = { notifyBot };
