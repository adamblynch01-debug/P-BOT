// ─── Discord Access Check Route ──────────────────────────────────────────────
// Returns whether the current user has access to the full website
const express = require('express');
const router = express.Router();
const { publicUser } = require('../utils/auth');
const { checkDiscordAccess } = require('../utils/discordAccess');

// GET /api/access/check
// Returns { hasAccess: boolean, reason: string, discordLinked: boolean }
router.get('/check', publicUser, async (req, res) => {
  try {
    // User not logged in
    if (!req.user) {
      return res.json({
        hasAccess: false,
        reason: 'not_logged_in',
        discordLinked: false,
      });
    }

    // User has no Discord linked
    if (!req.user.discord_id) {
      return res.json({
        hasAccess: false,
        reason: 'no_discord_linked',
        discordLinked: false,
        username: req.user.username,
      });
    }

    // Check Discord server membership and role
    const access = await checkDiscordAccess(req.user.discord_id);

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
