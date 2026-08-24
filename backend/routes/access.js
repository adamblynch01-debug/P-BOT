// ─── Discord Access Check Route ──────────────────────────────────────────────
// Returns whether the current user has access to the full website
const express = require('express');
const router = express.Router();
const { attachUser } = require('../utils/auth');
const { checkDiscordAccess } = require('../utils/discordAccess');

// GET /api/access/check
// Returns { hasAccess: boolean, reason: string, discordLinked: boolean }
router.get('/check', attachUser, async (req, res) => {
  try {
    console.log('[Access] Check request received, user:', req.user ? req.user.username : 'none');

    // User not logged in
    if (!req.user) {
      console.log('[Access] Not logged in');
      return res.json({
        hasAccess: false,
        reason: 'not_logged_in',
        discordLinked: false,
      });
    }

    // User has no Discord linked
    if (!req.user.discord_id) {
      console.log('[Access] No Discord linked:', req.user.username);
      return res.json({
        hasAccess: false,
        reason: 'no_discord_linked',
        discordLinked: false,
        username: req.user.username,
      });
    }

    console.log('[Access] Checking Discord access for:', req.user.discord_id);

    // Check Discord server membership and role
    const access = await checkDiscordAccess(req.user.discord_id);

    console.log('[Access] Discord check result:', access);

    if (!access.inServer) {
      return res.json({
        hasAccess: false,
        reason: 'not_in_server',
        discordLinked: true,
        username: req.user.username,
      });
    }

    if (!access.hasCustomerRole) {
      return res.json({
        hasAccess: false,
        reason: 'no_customer_role',
        discordLinked: true,
        inServer: true,
        username: req.user.username,
        roles: access.roles,
      });
    }

    // User has full access!
    console.log('[Access] User authorized:', req.user.username);
    return res.json({
      hasAccess: true,
      reason: 'authorized',
      discordLinked: true,
      inServer: true,
      username: req.user.username,
      roles: access.roles,
    });

  } catch (error) {
    console.error('[Access] Check error:', error);
    res.status(500).json({ error: 'Failed to check access' });
  }
});

module.exports = router;
