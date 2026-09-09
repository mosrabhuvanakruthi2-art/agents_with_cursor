/**
 * Google Chat API helper — lists spaces (DMs, group chats, named spaces)
 * visible to the admin user's OAuth token.
 *
 * Required OAuth scopes on the admin's token:
 *   https://www.googleapis.com/auth/chat.spaces.readonly
 *   https://www.googleapis.com/auth/chat.memberships.readonly
 *
 * These are already part of the Message Agent scope bundle; if the admin's
 * token was issued without them, the API call will 403 and this function
 * returns empty lists (the caller can surface that to the UI).
 */
const axios = require('axios');
const { google } = require('googleapis');
const env = require('../config/env');
const tokenStore = require('./oauthTokenStore');
const logger = require('../utils/logger');

const CHAT_BASE = 'https://chat.googleapis.com/v1';

function getTenantCreds(tenant) {
  switch (String(tenant)) {
    case '2': return { clientId: env.GOOGLE_CLIENT_ID_2, clientSecret: env.GOOGLE_CLIENT_SECRET_2 };
    case '3': return { clientId: env.GOOGLE_CLIENT_ID_3, clientSecret: env.GOOGLE_CLIENT_SECRET_3 };
    case '4': return { clientId: env.GOOGLE_CLIENT_ID_4, clientSecret: env.GOOGLE_CLIENT_SECRET_4 };
    default:  return { clientId: env.GOOGLE_CLIENT_ID,   clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
}

function getGoogleTenant(email) {
  const domain = (email || '').split('@')[1]?.toLowerCase() || '';
  if (!domain) return '1';
  if (env.GOOGLE_CLIENT_ID_2 && env.GOOGLE_TENANT_2_DOMAINS?.includes(domain)) return '2';
  if (env.GOOGLE_CLIENT_ID_3 && env.GOOGLE_TENANT_3_DOMAINS?.includes(domain)) return '3';
  if (env.GOOGLE_CLIENT_ID_4 && env.GOOGLE_TENANT_4_DOMAINS?.includes(domain)) return '4';
  return '1';
}

async function getAccessTokenFor(adminEmail) {
  const stored = tokenStore.getGoogleToken(adminEmail);
  if (!stored?.refreshToken) {
    throw new Error(
      `Google Chat is not connected for ${adminEmail}. Sign in this admin via Login with Google (Message Agent) first.`
    );
  }
  const tenant = getGoogleTenant(adminEmail);
  const { clientId, clientSecret } = getTenantCreds(tenant);
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: stored.refreshToken });
  const { token } = await oauth2.getAccessToken();
  if (!token) throw new Error('Failed to obtain Google access token for Chat API.');
  return token;
}

/**
 * List all spaces the admin is a member of, grouped by type.
 *
 * SPACE + accessSettings.accessState === 'DISCOVERABLE' → publicChannels
 * SPACE + accessSettings.accessState === 'PRIVATE'      → privateChannels
 * GROUP_CHAT                                             → groupDms
 * DIRECT_MESSAGE                                         → dms
 */
async function listSpaces(adminEmail) {
  const token = await getAccessTokenFor(adminEmail);
  const headers = { Authorization: `Bearer ${token}` };

  const publicChannels  = [];
  const privateChannels = [];
  const dms      = [];
  const groupDms = [];

  let pageToken;
  try {
    do {
      const res = await axios.get(`${CHAT_BASE}/spaces`, {
        headers,
        params: {
          pageSize: 100,
          pageToken: pageToken || undefined,
          // Request accessSettings so we can split public vs private spaces
          fields: 'spaces(name,displayName,spaceType,singleUserBotDm,accessSettings,spaceDetails),nextPageToken',
        },
      });
      const spaces = res.data.spaces || [];
      for (const s of spaces) {
        const id          = s.name;          // "spaces/AAAA..."
        const displayName = s.displayName || '';
        const spaceType   = s.spaceType || s.type;

        if (spaceType === 'DIRECT_MESSAGE' || s.singleUserBotDm === true) {
          // Resolve partner display name via memberships
          let partnerName = displayName || id;
          try {
            const m = await axios.get(`${CHAT_BASE}/${id}/members`, { headers });
            const members = (m.data.memberships || [])
              .map((x) => x.member)
              .filter((x) => x && x.type === 'HUMAN');
            const partner = members.find(
              (u) => (u.name || '').toLowerCase() !== `users/${(adminEmail || '').toLowerCase()}`
            );
            partnerName = partner?.displayName || partnerName;
          } catch { /* ignore — keep id */ }
          dms.push({ id, name: partnerName, type: 'dm' });

        } else if (spaceType === 'GROUP_CHAT') {
          groupDms.push({ id, name: displayName || id, type: 'group_dm' });

        } else {
          // SPACE type — use accessSettings.accessState to split public / private
          // 'DISCOVERABLE' = anyone in the org can find and join → public
          // 'PRIVATE' or missing = invite-only → private
          const accessState = s.accessSettings?.accessState;
          if (accessState === 'DISCOVERABLE') {
            publicChannels.push({ id, name: displayName || id, type: 'public_channel' });
          } else {
            privateChannels.push({ id, name: displayName || id, type: 'private_channel' });
          }
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.warn(`[googleChatClient] listSpaces failed for ${adminEmail}: ${msg}`);
    const isAppNotFound = msg.toLowerCase().includes('app not found') || msg.toLowerCase().includes('chat app');
    throw new Error(
      isAppNotFound
        ? `Google Chat app not configured. Fix: Go to Google Cloud Console → APIs & Services → Google Chat API → "Configuration" tab → fill in App Name + Description → Save. Then sign out and re-authenticate via Message Agent Step 1 → Google tab.`
        : `Google Chat spaces fetch failed: ${msg}. Re-authenticate via Message Agent Step 1 → Google tab.`
    );
  }

  publicChannels.sort((a, b)  => a.name.localeCompare(b.name));
  privateChannels.sort((a, b) => a.name.localeCompare(b.name));
  dms.sort((a, b)      => a.name.localeCompare(b.name));
  groupDms.sort((a, b) => a.name.localeCompare(b.name));

  return { publicChannels, privateChannels, dms, groupDms };
}

/**
 * Post a plain-text message to a Google Chat space or DM.
 * spaceId: the space resource name returned by listSpaces, e.g. "spaces/AAAA…"
 * Requires chat.messages scope (already in messageScopes in authRoutes.js).
 * Returns { ok, name } — name is the message resource name, needed for thread replies.
 */
async function postChatMessage(adminEmail, spaceId, text) {
  const token = await getAccessTokenFor(adminEmail);
  const res = await axios.post(
    `${CHAT_BASE}/${spaceId}/messages`,
    { text },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return { ok: true, name: res.data.name };
}

/**
 * Post a reply in a Google Chat thread.
 * parentMessageName: the `name` field from the parent message (e.g. "spaces/AAA/messages/BBB").
 * Google Chat thread replies use the thread key derived from the parent message name.
 */
async function postChatThreadReply(adminEmail, spaceId, parentMessageName, text) {
  const token = await getAccessTokenFor(adminEmail);
  // Extract thread name from parent message name: "spaces/AAA/messages/BBB" → thread key "BBB"
  const threadName = `${spaceId}/threads/${parentMessageName.split('/').pop()}`;
  const res = await axios.post(
    `${CHAT_BASE}/${spaceId}/messages`,
    { text, thread: { name: threadName } },
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' },
    }
  );
  return { ok: true, name: res.data.name };
}

/**
 * True if a message-tagged Google OAuth token is stored for this admin.
 * Mail-only tokens don't have chat scopes and cannot post.
 */
function hasGoogleChatToken(adminEmail) {
  try {
    const stored = tokenStore.getGoogleToken(adminEmail);
    if (!stored?.refreshToken) return false;
    const agent = (stored.agent || 'mail').toLowerCase();
    return agent === 'message' || agent === 'both';
  } catch { return false; }
}

/**
 * Count messages in a Google Chat space posted in the last `sinceMinutes` minutes.
 * Used by MessageMigrationAgent to poll the destination for migration completion.
 */
async function getSpaceMessageCount(adminEmail, spaceId, sinceMinutes = 240) {
  const token = await getAccessTokenFor(adminEmail);
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
  let count = 0;
  let pageToken;
  try {
    do {
      const res = await axios.get(`${CHAT_BASE}/${spaceId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          pageSize: 100,
          pageToken: pageToken || undefined,
          filter: `createTime > "${since}"`,
        },
      });
      count += (res.data.messages || []).length;
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch { /* scope or space not accessible — return 0 */ }
  return count;
}

module.exports = { listSpaces, postChatMessage, postChatThreadReply, hasGoogleChatToken, getSpaceMessageCount };
