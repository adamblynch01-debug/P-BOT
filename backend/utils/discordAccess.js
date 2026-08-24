// ─── Discord Server Access Control ───────────────────────────────────────────
// Checks if a user is in the Discord server with the "customer" role.
// Users NOT in the server or without the role see a blurred/restricted website.

const axios = require('axios');

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CUSTOMER_ROLE_ID = process.env.CUSTOMER_ROLE_ID || null;
const CUSTOMER_ROLE_NAME = process.env.CUSTOMER_ROLE_NAME || 'customer';

// Cache Discord member data for 5 minutes to avoid rate limits
const memberCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a Discord user is in the guild with the customer role
 * @param {string} discordId - Discord user ID
 * @returns {Promise<{inServer: boolean, hasCustomerRole: boolean, roles: string[]}>}
 */
async function checkDiscordAccess(discordId) {
  if (!discordId || !DISCORD_BOT_TOKEN || !GUILD_ID) {
    return { inServer: false, hasCustomerRole: false, roles: [] };
  }

  // Check cache first
  const cached = memberCache.get(discordId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  try {
    // Fetch member from Discord API
    const response = await axios.get(
      `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}`,
      {
        headers: {
          'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
        validateStatus: (status) => status < 500, // Don't throw on 404
      }
    );

    // User not in server
    if (response.status === 404) {
      const result = { inServer: false, hasCustomerRole: false, roles: [] };
      memberCache.set(discordId, { data: result, expiresAt: Date.now() + CACHE_TTL });
      return result;
    }

    // User in server - check roles
    const member = response.data;
    const memberRoles = member.roles || [];

    // Fetch guild roles to map role IDs to names
    const rolesResponse = await axios.get(
      `https://discord.com/api/v10/guilds/${GUILD_ID}/roles`,
      {
        headers: {
          'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );

    const guildRoles = rolesResponse.data;
    const roleMap = new Map(guildRoles.map(r => [r.id, r.name.toLowerCase()]));

    // Check if user has customer role (by ID or name)
    const hasCustomerRole = memberRoles.some(roleId => {
      // Priority 1: Check by role ID (most reliable)
      if (CUSTOMER_ROLE_ID && roleId === CUSTOMER_ROLE_ID) {
        return true;
      }
      // Priority 2: Fallback to role name
      const roleName = roleMap.get(roleId);
      return roleName === CUSTOMER_ROLE_NAME.toLowerCase();
    });

    const result = {
      inServer: true,
      hasCustomerRole,
      roles: memberRoles.map(id => roleMap.get(id)).filter(Boolean),
    };

    // Cache the result
    memberCache.set(discordId, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;

  } catch (error) {
    console.error('[DiscordAccess] Error checking Discord access:', error.message);
    // On error, return restrictive result but don't cache it
    return { inServer: false, hasCustomerRole: false, roles: [] };
  }
}

/**
 * Middleware to check if user has Discord access
 * Sets req.hasDiscordAccess = true/false
 */
async function checkAccessMiddleware(req, res, next) {
  try {
    // If user is logged in and has Discord linked
    if (req.user && req.user.discord_id) {
      const access = await checkDiscordAccess(req.user.discord_id);
      req.hasDiscordAccess = access.inServer && access.hasCustomerRole;
      req.discordRoles = access.roles;
    } else {
      // Not logged in or no Discord linked = no access
      req.hasDiscordAccess = false;
      req.discordRoles = [];
    }
    next();
  } catch (error) {
    console.error('[DiscordAccess] Middleware error:', error);
    req.hasDiscordAccess = false;
    req.discordRoles = [];
    next();
  }
}

/**
 * Clear cache for a specific user (when they join/leave server or roles change)
 */
function clearCache(discordId) {
  if (discordId) {
    memberCache.delete(discordId);
  }
}

/**
 * Clear all cache (use sparingly)
 */
function clearAllCache() {
  memberCache.clear();
}

module.exports = {
  checkDiscordAccess,
  checkAccessMiddleware,
  clearCache,
  clearAllCache,
};
