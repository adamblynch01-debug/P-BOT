// ─── Discord Server Access Control ───────────────────────────────────────────
// Checks if a user is in the Discord server with the "customer" role.
// Users NOT in the server or without the role see a blurred/restricted website.

const axios = require('axios');

const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CUSTOMER_ROLE_ID = process.env.CUSTOMER_ROLE_ID || null;
const CUSTOMER_ROLE_NAME = process.env.CUSTOMER_ROLE_NAME || 'customer';

// Cache Discord member data for 5 minutes to avoid rate limits
const memberCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let guildRolesCache = null;

function discordHeaders() {
  return {
    'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function requireDiscordConfig() {
  if (!DISCORD_BOT_TOKEN || !GUILD_ID) {
    const err = new Error('Discord role management is not configured');
    err.statusCode = 503;
    throw err;
  }
}

function normalizedRoleName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function getGuildRoles(force) {
  requireDiscordConfig();
  if (!force && guildRolesCache && Date.now() < guildRolesCache.expiresAt) {
    return guildRolesCache.roles;
  }
  const response = await axios.get(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/roles`,
    { headers: discordHeaders(), timeout: 5000 }
  );
  const roles = Array.isArray(response.data) ? response.data : [];
  guildRolesCache = { roles, expiresAt: Date.now() + CACHE_TTL };
  return roles;
}

// Create a regular Discord guild role.  Role creation is intentionally kept
// in this helper so every caller uses the same bot credentials/configuration
// and the cached role list is invalidated after a successful write.
async function createDiscordRole(name, color) {
  requireDiscordConfig();
  const roleName = String(name || '').trim();
  if (!roleName || roleName.length > 100) {
    const err = new Error('Role name must be between 1 and 100 characters');
    err.statusCode = 400;
    throw err;
  }
  let roleColor = color;
  if (typeof roleColor === 'string') {
    roleColor = roleColor.trim();
    if (roleColor.startsWith('#')) roleColor = roleColor.slice(1);
    if (/^[0-9a-f]{1,6}$/i.test(roleColor)) roleColor = parseInt(roleColor, 16);
  }
  roleColor = Number(roleColor || 0);
  if (!Number.isInteger(roleColor) || roleColor < 0 || roleColor > 0xFFFFFF) {
    const err = new Error('Role color must be a hex color such as #5865f2');
    err.statusCode = 400;
    throw err;
  }
  const response = await axios.post(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/roles`,
    { name: roleName, color: roleColor, hoist: false, mentionable: false },
    { headers: discordHeaders(), timeout: 5000 }
  );
  guildRolesCache = null;
  const role = response.data || {};
  return {
    id: String(role.id || ''),
    name: String(role.name || roleName),
    color: Number(role.color || roleColor),
    position: Number(role.position || 0),
    managed: !!role.managed,
  };
}

async function getDiscordMemberRoles(discordId) {
  requireDiscordConfig();
  const [memberResponse, roles] = await Promise.all([
    axios.get(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}`, {
      headers: discordHeaders(), timeout: 5000,
    }),
    getGuildRoles(false),
  ]);
  const held = new Set((memberResponse.data && memberResponse.data.roles) || []);
  return roles.map((role) => ({
    id: String(role.id),
    name: role.name,
    color: Number(role.color || 0),
    position: Number(role.position || 0),
    managed: !!role.managed,
    assigned: held.has(String(role.id)),
  }));
}

async function setDiscordMemberRole(discordId, roleId, assigned) {
  requireDiscordConfig();
  const roles = await getGuildRoles(false);
  const role = roles.find((item) => String(item.id) === String(roleId));
  if (!role || role.name === '@everyone') {
    const err = new Error('Discord role not found');
    err.statusCode = 404;
    throw err;
  }
  if (role.managed) {
    const err = new Error('Discord integration roles cannot be changed manually');
    err.statusCode = 400;
    throw err;
  }
  const url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${role.id}`;
  if (assigned) await axios.put(url, null, { headers: discordHeaders(), timeout: 5000 });
  else await axios.delete(url, { headers: discordHeaders(), timeout: 5000 });
  clearCache(discordId);
  return { id: String(role.id), name: role.name, assigned: !!assigned };
}

async function setDiscordMemberRoleByName(discordId, roleName, assigned) {
  if (!discordId) return { synced: false, warning: 'Website account has no linked Discord user' };
  try {
    const wanted = normalizedRoleName(roleName);
    const roles = await getGuildRoles(false);
    const role = roles.find((item) => normalizedRoleName(item.name) === wanted);
    if (!role) return { synced: false, warning: `Discord role "${roleName}" was not found` };
    const result = await setDiscordMemberRole(discordId, role.id, assigned);
    return { synced: true, role: result };
  } catch (err) {
    return { synced: false, warning: err.response?.data?.message || err.message || 'Discord role sync failed' };
  }
}

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
    const guildRoles = await getGuildRoles(false);
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
      // Keep the raw ids internally available for role-gated services such as
      // Movie Night.  Callers that render public access continue to use the
      // friendly names below, so this does not broaden any browser response.
      roleIds: memberRoles.map(String),
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
  guildRolesCache = null;
}

module.exports = {
  checkDiscordAccess,
  checkAccessMiddleware,
  getGuildRoles,
  createDiscordRole,
  getDiscordMemberRoles,
  setDiscordMemberRole,
  setDiscordMemberRoleByName,
  normalizedRoleName,
  clearCache,
  clearAllCache,
};
