const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios = require('axios');
const env = require('../config/env');
const tokenStore = require('./oauthTokenStore');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Microsoft Graph requires user principal names to be URL-encoded in /users/{segment}/ paths. */
function graphUserPath(userId) {
  return encodeURIComponent(String(userId == null ? '' : userId).trim());
}

/** Return '2' if the email's domain belongs to the second tenant, else '1'. */
function getMsTenant(email) {
  const domain = (email || '').split('@')[1]?.toLowerCase() || '';
  if (domain && env.GRAPH_CLIENT_ID_2 && env.GRAPH_TENANT_2_DOMAINS?.includes(domain)) return '2';
  return '1';
}

/** Return the right Azure AD app credentials for a given tenant key ('1' or '2'). */
function getMsCredentials(tenant) {
  if (tenant === '2') {
    return {
      clientId: env.GRAPH_CLIENT_ID_2,
      clientSecret: env.GRAPH_CLIENT_SECRET_2,
      tenantId: env.GRAPH_TENANT_ID_2,
    };
  }
  return {
    clientId: env.GRAPH_CLIENT_ID,
    clientSecret: env.GRAPH_CLIENT_SECRET,
    tenantId: env.GRAPH_TENANT_ID,
  };
}

// Per-tenant app-only token cache
const tokenCaches = {};

/**
 * Decode the appid from a JWT access token without verifying the signature.
 * Returns null if the token is missing or malformed.
 */
function decodeJwtAppId(accessToken) {
  if (!accessToken) return null;
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return null;
    // JWT uses base64url — replace - with + and _ with /
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload.appid || payload.azp || null;
  } catch {
    return null;
  }
}

/**
 * Refresh the stored Microsoft OAuth delegated token using its refresh_token.
 *
 * Refresh tokens are bound to the Azure AD app that issued them — we decode the
 * JWT appid to detect which app to use. Falling back to agent-tag heuristics
 * only when no access token is present.
 */
async function refreshStoredMicrosoftToken(stored) {
  const tenant = getMsTenant(stored.email);
  const isMessageAgent = stored.agent === 'message' || stored.agent === 'both';

  // Detect which app originally issued this token
  const issuingAppId = decodeJwtAppId(stored.accessToken);
  logger.info(
    `[auth] Refreshing token for ${stored.email} — issuingAppId=${issuingAppId || 'unknown'} agent=${stored.agent || 'mail'}`
  );

  let clientId, clientSecret, tenantId, refreshScope;

  if (issuingAppId && env.MS_MESSAGE_CLIENT_ID && issuingAppId === env.MS_MESSAGE_CLIENT_ID) {
    // Token was issued by the dedicated Message Agent app
    clientId     = env.MS_MESSAGE_CLIENT_ID;
    clientSecret = env.MS_MESSAGE_CLIENT_SECRET;
    tenantId     = env.GRAPH_TENANT_ID;
    refreshScope = 'offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send ChannelMessage.Read.All Chat.Read Chat.ReadWrite ChatMessage.Send';
  } else {
    // Token was issued by the standard mail/calendar app (GRAPH_CLIENT_ID or tenant-2 variant)
    ({ clientId, clientSecret, tenantId } = getMsCredentials(tenant));
    // If the original token had Teams scopes (agent=message), request them here too —
    // Microsoft will include them when the app already has consent.
    if (isMessageAgent) {
      refreshScope =
        'offline_access User.Read Mail.ReadWrite Calendars.ReadWrite ' +
        'Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send Chat.ReadWrite ChatMessage.Send';
    } else {
      refreshScope = 'offline_access User.Read Mail.ReadWrite Calendars.ReadWrite';
    }
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
    scope: refreshScope,
  });
  const res = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  const { access_token, refresh_token, expires_in } = res.data;
  const updated = {
    ...stored,
    accessToken: access_token,
    refreshToken: refresh_token || stored.refreshToken,
    expiresAt: Date.now() + expires_in * 1000,
  };
  tokenStore.setMicrosoftToken(updated);
  return access_token;
}

/**
 * App-only token via client_credentials for the given tenant ('1' or '2').
 * Used for tenant-wide operations like listing all users or accessing any mailbox.
 */
async function getAppAccessToken(tenant = '1') {
  const cache = tokenCaches[tenant] || (tokenCaches[tenant] = { accessToken: null, expiresAt: 0 });
  if (cache.accessToken && Date.now() < cache.expiresAt) return cache.accessToken;
  const { clientId, clientSecret, tenantId } = getMsCredentials(tenant);
  const cca = new ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority: `https://login.microsoftonline.com/${tenantId}` },
  });
  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  cache.accessToken = result.accessToken;
  cache.expiresAt = Date.now() + (result.expiresOn - Date.now()) * 0.9;
  return cache.accessToken;
}

/**
 * Get a valid Microsoft Graph access token.
 * Priority:
 *   1. Stored OAuth delegated token (from UI login) — refreshed automatically if expired
 *      NOTE: delegated tokens only have the scopes requested at login (User.Read,
 *      Mail.ReadWrite, Calendars.ReadWrite). Use getAppAccessToken() for operations
 *      that need User.Read.All or other application-level permissions.
 *   2. App client_credentials token (from GRAPH_* env vars)
 */
/**
 * Get a valid access token for the given email (or first stored account if omitted).
 * Picks the correct tenant credentials for refresh and app-only fallback.
 */
async function getAccessToken(email) {
  const tenant = getMsTenant(email);
  // 1. Try stored OAuth token for this specific email (or first account)
  const stored = tokenStore.getMicrosoftToken(email || null);
  if (stored?.accessToken) {
    const bufferMs = 60_000;
    if (stored.expiresAt && Date.now() < stored.expiresAt - bufferMs) {
      return stored.accessToken;
    }
    if (stored.refreshToken) {
      try {
        logger.info(`[auth] Refreshing Microsoft OAuth token for ${stored.email || email}...`);
        return await refreshStoredMicrosoftToken(stored);
      } catch (err) {
        logger.warn(`[auth] Microsoft token refresh failed: ${err.message}. Falling back to client_credentials.`);
      }
    }
  }

  // 2. Fall back to app-only client_credentials for the right tenant
  return getAppAccessToken(tenant);
}

async function graphGet(url, userId = null) {
  const token = await getAccessToken(userId);
  return retryWithBackoff(
    () =>
      axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    { label: `Graph GET ${url.replace(GRAPH_BASE, '')}` }
  );
}

async function getMailFolders(userId) {
  const uid = graphUserPath(userId);
  const base = `${GRAPH_BASE}/users/${uid}/mailFolders?$top=100`;
  const deepExpand = encodeURIComponent('childFolders($expand=childFolders($expand=childFolders))');
  const shallowExpand = encodeURIComponent('childFolders');
  try {
    const res = await graphGet(`${base}&$expand=${deepExpand}`, userId);
    return res.data.value || [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 400) {
      logger.warn(
        `getMailFolders: deep $expand returned 400 for ${userId}, retrying shallow childFolders expand`
      );
      const res = await graphGet(`${base}&$expand=${shallowExpand}`, userId);
      return res.data.value || [];
    }
    throw err;
  }
}

async function getAllFoldersFlat(userId) {
  const topFolders = await getMailFolders(userId);
  const all = [];

  function flatten(folders) {
    for (const f of folders) {
      all.push(f);
      if (f.childFolders && f.childFolders.length > 0) {
        flatten(f.childFolders);
      }
    }
  }

  flatten(topFolders);
  return all;
}

async function getTotalMessageCount(userId) {
  const token = await getAccessToken(userId);
  const uid = graphUserPath(userId);
  const res = await retryWithBackoff(
    () =>
      axios.get(`${GRAPH_BASE}/users/${uid}/messages/$count`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ConsistencyLevel: 'eventual',
        },
      }),
    { label: 'Graph getTotalMessageCount' }
  );
  return typeof res.data === 'number' ? res.data : 0;
}

async function getMessages(userId, folderId, top = 100) {
  const uid = graphUserPath(userId);
  const url = folderId
    ? `${GRAPH_BASE}/users/${uid}/mailFolders/${encodeURIComponent(folderId)}/messages?$top=${top}&$select=subject,bodyPreview,hasAttachments,receivedDateTime`
    : `${GRAPH_BASE}/users/${uid}/messages?$top=${top}&$select=subject,bodyPreview,hasAttachments,receivedDateTime`;
  const res = await graphGet(url, userId);
  return res.data.value || [];
}

async function getMessageCount(userId, folderId) {
  const uid = graphUserPath(userId);
  const url = folderId
    ? `${GRAPH_BASE}/users/${uid}/mailFolders/${encodeURIComponent(folderId)}/messages/$count`
    : `${GRAPH_BASE}/users/${uid}/messages/$count`;
  const token = await getAccessToken(userId);
  const res = await retryWithBackoff(
    () =>
      axios.get(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          ConsistencyLevel: 'eventual',
        },
      }),
    { label: 'Graph getMessageCount' }
  );
  return res.data;
}

async function getCalendars(userId) {
  const res = await graphGet(`${GRAPH_BASE}/users/${graphUserPath(userId)}/calendars?$top=100`, userId);
  return res.data.value || [];
}

async function getEvents(userId, calendarId, top = 250) {
  const uid = graphUserPath(userId);
  const url = calendarId
    ? `${GRAPH_BASE}/users/${uid}/calendars/${encodeURIComponent(calendarId)}/events?$top=${top}`
    : `${GRAPH_BASE}/users/${uid}/events?$top=${top}`;
  const res = await graphGet(url, userId);
  return res.data.value || [];
}

async function getEventCount(userId, calendarId) {
  const token = await getAccessToken(userId);
  const uid = graphUserPath(userId);
  const calSeg = calendarId ? encodeURIComponent(calendarId) : '';
  // Try $count endpoint (requires ConsistencyLevel: eventual)
  try {
    const url = calendarId
      ? `${GRAPH_BASE}/users/${uid}/calendars/${calSeg}/events/$count`
      : `${GRAPH_BASE}/users/${uid}/events/$count`;
    const res = await axios.get(url, {
      headers: { Authorization: 'Bearer ' + token, ConsistencyLevel: 'eventual' },
      timeout: 15000,
    });
    if (typeof res.data === 'number') return res.data;
  } catch { /* fall through to pagination fallback */ }

  // Fallback: paginate through all events and count
  try {
    let count = 0;
    let nextLink = calendarId
      ? `${GRAPH_BASE}/users/${uid}/calendars/${calSeg}/events?$top=200&$select=id`
      : `${GRAPH_BASE}/users/${uid}/events?$top=100&$select=id`;
    while (nextLink) {
      const res = await axios.get(nextLink, {
        headers: { Authorization: 'Bearer ' + token },
        timeout: 30000,
      });
      count += (res.data.value || []).length;
      nextLink = res.data['@odata.nextLink'] || null;
    }
    return count;
  } catch {
    return 0;
  }
}

async function getAttachments(userId, messageId) {
  const res = await graphGet(
    `${GRAPH_BASE}/users/${graphUserPath(userId)}/messages/${encodeURIComponent(messageId)}/attachments`,
    userId
  );
  return res.data.value || [];
}

/**
 * Paginate through all users with a given token.
 */
async function _fetchAllUsers(token) {
  const users = [];
  let url = `${GRAPH_BASE}/users?$top=999&$select=id,displayName,mail,givenName,surname,userPrincipalName`;
  while (url) {
    const res = await retryWithBackoff(
      () => axios.get(url, { headers: { Authorization: `Bearer ${token}` } }),
      { label: 'Graph listUsers' }
    );
    for (const u of res.data.value || []) {
      if (u.mail) {
        users.push({
          id: u.id,
          email: u.mail,
          displayName: u.displayName || '',
          firstName: u.givenName || u.displayName?.split(' ')[0] || '',
          lastName: u.surname || '',
        });
      }
    }
    url = res.data['@odata.nextLink'] || null;
  }
  return users;
}

/**
 * List all users in the tenant with a mailbox.
 * Tries delegated OAuth token first (works when admin has User.Read.All delegated consent),
 * then falls back to app-only client_credentials (requires User.Read.All application permission).
 */
async function listUsers(adminEmail) {
  const tenant = getMsTenant(adminEmail);
  // 1. Try delegated OAuth token for this admin
  try {
    const token = await getAccessToken(adminEmail);
    return await _fetchAllUsers(token);
  } catch (err) {
    if (err.response?.status !== 403) throw err;
    logger.warn(`[listUsers] Delegated token lacks User.Read.All for ${adminEmail}; retrying with app-only token (tenant ${tenant})...`);
  }
  // 2. Fall back to app-only token for the correct tenant
  const appToken = await getAppAccessToken(tenant);
  return _fetchAllUsers(appToken);
}

/**
 * Check if a user has a mailbox enabled.
 * Tries delegated token first, then app-only on 403.
 */
async function hasMailbox(userEmail) {
  const url = `${GRAPH_BASE}/users/${graphUserPath(userEmail)}/mailFolders/inbox?$select=id`;
  async function tryToken(token) {
    await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
  }
  try {
    await tryToken(await getAccessToken());
    return true;
  } catch (err) {
    if (err.response?.status !== 403) return false;
  }
  try {
    await tryToken(await getAppAccessToken());
    return true;
  } catch {
    return false;
  }
}

/**
 * Filter a list of user emails to only those with mailbox licenses.
 * Checks each user in parallel (batches of 5) for performance.
 */
async function filterMailboxEnabled(userEmails) {
  const results = [];
  const batchSize = 5;

  for (let i = 0; i < userEmails.length; i += batchSize) {
    const batch = userEmails.slice(i, i + batchSize);
    const checks = await Promise.all(
      batch.map(async (email) => ({ email, enabled: await hasMailbox(email) }))
    );
    results.push(...checks);
  }

  return results.filter((r) => r.enabled).map((r) => r.email);
}

const DEFAULT_FOLDER_NAMES = new Set([
  'Inbox', 'Drafts', 'Sent Items', 'Deleted Items', 'Junk Email',
  'Outbox', 'Archive', 'Conversation History', 'Clutter',
  'Sync Issues', 'Conflicts', 'Local Failures', 'Server Failures',
  'RSS Feeds',
]);

async function graphDelete(url, userId = null) {
  const token = await getAccessToken(userId);
  return retryWithBackoff(
    () => axios.delete(url, { headers: { Authorization: `Bearer ${token}` } }),
    { label: `Graph DELETE ${url.replace(GRAPH_BASE, '')}`, maxRetries: 2 }
  );
}

async function graphPost(url, body, userId = null) {
  const token = await getAccessToken(userId);
  return retryWithBackoff(
    () => axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }),
    { label: `Graph POST ${url.replace(GRAPH_BASE, '')}`, maxRetries: 2 }
  );
}

/**
 * Send a Graph API $batch request with up to 20 delete operations.
 */
async function batchDelete(requests, userId = null) {
  if (requests.length === 0) return;
  const token = await getAccessToken(userId);
  const batchBody = {
    requests: requests.map((url, i) => ({
      id: String(i + 1),
      method: 'DELETE',
      url: url.replace(GRAPH_BASE, ''),
    })),
  };
  try {
    await axios.post(`${GRAPH_BASE}/$batch`, batchBody, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    });
  } catch (err) {
    // Fallback: delete individually if batch fails
    for (const req of requests) {
      try {
        const tkn = await getAccessToken(userId);
        await axios.delete(req, { headers: { Authorization: `Bearer ${tkn}` }, timeout: 10000 });
      } catch { /* skip */ }
    }
  }
}

/**
 * Empty a folder using the Graph API emptyFolder action (server-side, much faster than batch delete).
 * deleteSubFolders=false preserves child folder structure (we handle those separately).
 */
async function emptyFolderViaApi(userId, folderId) {
  const token = await getAccessToken(userId);
  await axios.post(
    `${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/${encodeURIComponent(folderId)}/emptyFolder?deleteSubFolders=false`,
    {},
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 120000 }
  );
}

/**
 * Delete all messages from a folder using Graph $batch API (20 per batch call).
 */
async function deleteAllMessagesInFolder(userId, folderId) {
  let deleted = 0;
  let hasMore = true;

  while (hasMore) {
    const token = await getAccessToken(userId);
    const res = await axios.get(
      `${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages?$top=100&$select=id`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const messages = res.data.value || [];
    if (messages.length === 0) { hasMore = false; break; }

    const batchSize = 20;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      await batchDelete(batch.map((m) => `${GRAPH_BASE}/users/${graphUserPath(userId)}/messages/${encodeURIComponent(m.id)}`), userId);
      deleted += batch.length;
    if (deleted % 500 === 0 && deleted > 0) { const log = require('../utils/logger'); log.info('[events] Deleted ' + deleted + ' events so far...'); }
    }
  }

  return deleted;
}

function deleteFolder(userId, folderId) {
  return graphDelete(`${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/${encodeURIComponent(folderId)}`, userId);
}

/**
 * Delete all events from a calendar using parallel Graph $batch API calls.
 * Fetches 100 events per page and fires all batch-delete calls in parallel (5x faster).
 */
async function deleteAllEventsInCalendar(userId, calendarId) {
  let deleted = 0;

  while (true) {
    const token = await getAccessToken(userId);
    const res = await axios.get(
      `${GRAPH_BASE}/users/${graphUserPath(userId)}/calendars/${encodeURIComponent(calendarId)}/events?$top=100&$select=id`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
    );

    const events = res.data.value || [];
    if (events.length === 0) break;

    // Split into batches of 20 and fire ALL in parallel instead of sequentially
    const batchSize = 20;
    const batches = [];
    for (let i = 0; i < events.length; i += batchSize) {
      batches.push(events.slice(i, i + batchSize).map((e) => `${GRAPH_BASE}/users/${graphUserPath(userId)}/events/${encodeURIComponent(e.id)}`));
    }
    await Promise.all(batches.map((b) => batchDelete(b, userId)));
    deleted += events.length;
  }

  return deleted;
}

/**
 * Delete a non-default calendar entirely.
 */
function deleteCalendar(userId, calendarId) {
  return graphDelete(`${GRAPH_BASE}/users/${graphUserPath(userId)}/calendars/${encodeURIComponent(calendarId)}`, userId);
}

/**
 * Clean the entire destination mailbox:
 * 1. Delete custom folders entirely
 * 2. Delete all messages from default folders (parallel batch)
 * 3. Delete calendar events and non-default calendars
 */
async function cleanMailbox(userId) {
  const log = require('../utils/logger');
  const topFolders = await getMailFolders(userId);
  const summary = { foldersDeleted: 0, messagesDeleted: 0, calendarsDeleted: 0, eventsDeleted: 0, errors: [] };

  const customFolders = topFolders.filter((f) => !DEFAULT_FOLDER_NAMES.has(f.displayName));
  log.info(`[clean ${userId}] Step 1: Deleting ${customFolders.length} custom folders...`);

  for (const folder of customFolders) {
    try {
      const msgs = folder.totalItemCount || 0;
      await deleteFolder(userId, folder.id);
      summary.messagesDeleted += msgs;
      summary.foldersDeleted++;
      log.info(`[clean ${userId}]   Deleted folder "${folder.displayName}" (${msgs} msgs)`);
    } catch (err) {
      summary.errors.push(`Folder "${folder.displayName}": ${err.message}`);
      log.warn(`[clean ${userId}]   Failed folder "${folder.displayName}": ${err.message}`);
    }
  }

  let deletedItemsFolder = null;
  log.info(`[clean ${userId}] Step 2: Cleaning default folders...`);

  for (const folder of topFolders) {
    if (!DEFAULT_FOLDER_NAMES.has(folder.displayName)) continue;
    if (folder.displayName === 'Deleted Items') { deletedItemsFolder = folder; continue; }

    if (folder.childFolders?.length > 0) {
      for (const child of folder.childFolders) {
        if (DEFAULT_FOLDER_NAMES.has(child.displayName)) continue;
        try {
          summary.messagesDeleted += child.totalItemCount || 0;
          await deleteFolder(userId, child.id);
          summary.foldersDeleted++;
          log.info(`[clean ${userId}]   Deleted child folder "${child.displayName}"`);
        } catch (err) {
          summary.errors.push(`Child folder "${child.displayName}": ${err.message}`);
        }
      }
    }

    if (folder.totalItemCount > 0) {
      log.info(`[clean ${userId}]   Cleaning "${folder.displayName}" (${folder.totalItemCount} msgs)...`);
      try {
        await emptyFolderViaApi(userId, folder.id);
        summary.messagesDeleted += folder.totalItemCount || 0;
        log.info(`[clean ${userId}]   Cleaned "${folder.displayName}" — ${folder.totalItemCount} msgs deleted (emptyFolder API)`);
      } catch (emptyErr) {
        log.warn(`[clean ${userId}]   emptyFolder API failed for "${folder.displayName}", falling back to batch delete: ${emptyErr.message}`);
        try {
          const count = await deleteAllMessagesInFolder(userId, folder.id);
          summary.messagesDeleted += count;
          log.info(`[clean ${userId}]   Cleaned "${folder.displayName}" — ${count} msgs deleted (batch fallback)`);
        } catch (err) {
          summary.errors.push(`Clean "${folder.displayName}": ${err.message}`);
          log.warn(`[clean ${userId}]   Failed "${folder.displayName}": ${err.message}`);
        }
      }
    }
  }

  if (deletedItemsFolder) {
    log.info(`[clean ${userId}] Step 2b: Emptying Deleted Items (${deletedItemsFolder.totalItemCount || 0} msgs)...`);
    try {
      await emptyFolderViaApi(userId, deletedItemsFolder.id);
      summary.messagesDeleted += deletedItemsFolder.totalItemCount || 0;
      log.info(`[clean ${userId}]   Deleted Items emptied via emptyFolder API`);
    } catch (emptyErr) {
      log.warn(`[clean ${userId}]   emptyFolder API failed for Deleted Items, falling back: ${emptyErr.message}`);
      try {
        const count = await deleteAllMessagesInFolder(userId, deletedItemsFolder.id);
        summary.messagesDeleted += count;
        log.info(`[clean ${userId}]   Deleted Items emptied — ${count} msgs deleted (batch fallback)`);
      } catch (err) {
        summary.errors.push(`Clean "Deleted Items": ${err.message}`);
      }
    }
  }

  log.info('[clean ' + userId + '] Step 3: Cleaning calendars...');
  try {
    const calendars = await getCalendars(userId);
    log.info('[clean ' + userId + ']   Found ' + calendars.length + ' calendars');

    for (const cal of calendars) {
      if (cal.name === 'Birthdays' || cal.name.includes('holidays') || cal.canEdit === false) {
        log.info('[clean ' + userId + ']   Skipping system calendar: ' + cal.name);
        continue;
      }
      if (cal.isDefaultCalendar) {
        log.info('[clean ' + userId + ']   Cleaning default calendar "' + cal.name + '" events...');
        const evtCount = await getEventCount(userId, cal.id);
        if (evtCount === 0) {
          log.info('[clean ' + userId + ']   Default calendar has 0 events, skipping');
          continue;
        }
        if (evtCount > 500) {
          log.info('[clean ' + userId + ']   Large calendar (' + evtCount + ' events) - trying calendar delete & recreate...');
          try {
            await deleteCalendar(userId, cal.id);
            summary.eventsDeleted += evtCount;
            summary.calendarsDeleted++;
            log.info('[clean ' + userId + ']   Deleted default calendar with ' + evtCount + ' events (will auto-recreate)');
          } catch (delErr) {
            log.warn('[clean ' + userId + ']   Cannot delete default calendar, falling back to batch: ' + delErr.message);
            let deleted = 0;
            try {
              deleted = await deleteAllEventsInCalendar(userId, cal.id);
            } catch (te) {
              log.warn('[clean ' + userId + ']   Event deletion timed out or failed for calendar: ' + te.message);
            }
            summary.eventsDeleted += deleted;
            log.info('[clean ' + userId + ']   Deleted ' + deleted + ' events from default calendar');
          }
        } else {
          log.info('[clean ' + userId + ']   Deleting ' + evtCount + ' events from default calendar (batch)...');
          let deleted = 0;
          try {
            deleted = await deleteAllEventsInCalendar(userId, cal.id);
          } catch (te) {
            log.warn('[clean ' + userId + ']   Event deletion failed: ' + te.message);
            summary.errors.push(`Default calendar "${cal.name}": ${te.message}`);
          }
          summary.eventsDeleted += deleted;
          log.info('[clean ' + userId + ']   Deleted ' + deleted + ' events from default calendar');
        }
      } else {
        try {
          // Deleting the calendar automatically removes all its events — no need to delete events first
          log.info('[clean ' + userId + ']   Deleting secondary calendar "' + cal.name + '"...');
          await deleteCalendar(userId, cal.id);
          summary.calendarsDeleted++;
          log.info('[clean ' + userId + ']   Deleted secondary calendar "' + cal.name + '"');
        } catch (err) {
          summary.errors.push('Calendar "' + cal.name + '": ' + err.message);
          log.warn('[clean ' + userId + ']   Failed calendar "' + cal.name + '": ' + err.message);
        }
      }
    }
  } catch (err) {
    summary.errors.push('Calendars: ' + err.message);
  }

  log.info(`[clean ${userId}] DONE — ${summary.messagesDeleted} msgs, ${summary.foldersDeleted} folders, ${summary.eventsDeleted} events, ${summary.calendarsDeleted} calendars deleted${summary.errors.length > 0 ? ` (${summary.errors.length} errors)` : ''}`);
  return summary;
}

/**
 * List Teams channels and chats visible to the admin user via Graph.
 *
 * Returns: { publicChannels, privateChannels, dms, groupDms }
 *   publicChannels: { id (teamId/channelId), name ("TeamName / channelName"), memberCount }
 *   privateChannels: same shape (private / shared)
 *   dms: { id (chatId), name (partner displayName), members }
 *   groupDms: { id (chatId), name (topic or joined names), members }
 *
 * Requires delegated scopes: Team.ReadBasic.All, Channel.ReadBasic.All, Chat.Read.
 * This uses the admin's own delegated token (the `adminEmail` one connected via OAuth).
 */
async function listTeamsTargets(adminEmail) {
  const stored = tokenStore.getMicrosoftToken(adminEmail);
  if (!stored?.accessToken && !stored?.refreshToken) {
    throw new Error(
      `Microsoft is not connected for ${adminEmail}. Connect this admin via Login with Microsoft (Message Agent Step 1) before fetching Teams channels.`
    );
  }
  const token = await getAccessToken(adminEmail);
  const headers = { Authorization: `Bearer ${token}` };

  // Decode scopes from the access token (JWT middle segment) to give a clear
  // error when the token was issued with mail scopes instead of Teams scopes.
  function extractScopes(jwt) {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
      return (payload.scp || payload.scope || '').split(' ');
    } catch { return []; }
  }
  const grantedScopes = extractScopes(token);
  const hasTeamsScope = grantedScopes.some((s) =>
    s.toLowerCase().includes('team') || s.toLowerCase().includes('channel') || s.toLowerCase().includes('chat')
  );

  if (!hasTeamsScope) {
    throw new Error(
      `The token for ${adminEmail} has mail/calendar scopes only (${grantedScopes.filter(s => !['openid','email','profile','offline_access'].includes(s)).join(', ')}). ` +
      `Sign out ${adminEmail} and re-authenticate via Message Agent Step 1 → Microsoft tab to get Teams scopes (Team.ReadBasic.All, Channel.ReadBasic.All, Chat.Read).`
    );
  }

  const publicChannels = [];
  const privateChannels = [];

  // ── joined teams → channels ─────────────────────────────────────────────
  let teams = [];
  let teamsError = null;
  try {
    const r = await axios.get(`${GRAPH_BASE}/me/joinedTeams?$select=id,displayName`, { headers });
    teams = r.data.value || [];
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    teamsError = { status, msg };
    logger.warn(`[listTeamsTargets] /me/joinedTeams ${status}: ${msg}`);
    if (status === 403) {
      throw new Error(
        `Access denied fetching Teams for ${adminEmail} (403). ` +
        `Sign out and re-authenticate via Message Agent Step 1 → Microsoft tab with Teams permissions.`
      );
    }
  }

  for (const team of teams) {
    try {
      const r = await axios.get(
        `${GRAPH_BASE}/teams/${team.id}/allChannels?$select=id,displayName,membershipType`,
        { headers }
      );
      for (const ch of r.data.value || []) {
        const item = {
          id: `${team.id}/${ch.id}`,
          name: `${team.displayName} / ${ch.displayName}`,
          type: ch.membershipType === 'private' ? 'private_channel' : 'public_channel',
          teamId: team.id,
          channelId: ch.id,
        };
        if (ch.membershipType === 'private' || ch.membershipType === 'shared') {
          privateChannels.push(item);
        } else {
          publicChannels.push(item);
        }
      }
    } catch (err) {
      logger.warn(`[listTeamsTargets] allChannels for team ${team.id} failed: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  // ── chats (1:1 + group) ─────────────────────────────────────────────────
  const dms = [];
  const groupDms = [];
  try {
    let url = `${GRAPH_BASE}/me/chats?$expand=members&$top=50`;
    while (url) {
      const r = await axios.get(url, { headers });
      for (const chat of r.data.value || []) {
        const members = (chat.members || []).map((m) => ({
          id: m.userId || m.id,
          name: m.displayName || m.email || '',
          email: m.email || null,
        }));
        if (chat.chatType === 'oneOnOne') {
          const partner = members.find((m) => (m.email || '').toLowerCase() !== (adminEmail || '').toLowerCase());
          dms.push({
            id: chat.id,
            name: (partner?.name || partner?.email || chat.topic || chat.id),
            type: 'dm',
            members,
          });
        } else if (chat.chatType === 'group' || chat.chatType === 'meeting') {
          groupDms.push({
            id: chat.id,
            name: chat.topic || members.slice(0, 5).map((m) => m.name).filter(Boolean).join(', ') || chat.id,
            type: 'group_dm',
            members,
          });
        }
      }
      url = r.data['@odata.nextLink'];
    }
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    logger.warn(`[listTeamsTargets] /me/chats ${status}: ${msg}`);
    if (status === 403) {
      throw new Error(
        `Access denied fetching Teams chats for ${adminEmail} (403). ` +
        `Sign out and re-authenticate via Message Agent Step 1 → Microsoft tab with Chat.Read permission.`
      );
    }
  }

  publicChannels.sort((a, b) => a.name.localeCompare(b.name));
  privateChannels.sort((a, b) => a.name.localeCompare(b.name));
  dms.sort((a, b) => a.name.localeCompare(b.name));
  groupDms.sort((a, b) => a.name.localeCompare(b.name));

  return { publicChannels, privateChannels, dms, groupDms };
}

/**
 * Post a message to a Teams channel or chat using the user's delegated token.
 * Requires ChannelMessage.Send (channels) or Chat.ReadWrite (chats).
 *
 * targetId format:
 *   "teamId/channelId" → channel post  (POST /teams/{t}/channels/{c}/messages)
 *   "chatId" (19:…)    → chat message  (POST /chats/{id}/messages)
 *
 * contentType: "html" (default — Teams renders bold/italic/lists) | "text"
 *
 * Returns { ok, id, isChannel } — id is the Graph message ID, needed for replies.
 */
async function postTeamsMessage(userEmail, targetId, htmlContent, contentType = 'html') {
  const token = await getAccessToken(userEmail);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const body = { body: { content: htmlContent, contentType } };

  let url;
  let isChannel = false;
  const slashIdx = targetId.indexOf('/');
  if (slashIdx !== -1) {
    const teamId    = targetId.slice(0, slashIdx);
    const channelId = targetId.slice(slashIdx + 1);
    url = `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
    isChannel = true;
  } else {
    url = `${GRAPH_BASE}/chats/${encodeURIComponent(targetId)}/messages`;
  }

  const res = await axios.post(url, body, { headers });
  return { ok: true, id: res.data.id, isChannel };
}

/**
 * Post a reply to an existing channel message (creates / extends a thread).
 * Only works for channels (targetId "teamId/channelId"). Chat replies are not
 * supported by Graph API — for chats just post sequential messages instead.
 */
async function postTeamsReply(userEmail, targetId, parentMessageId, htmlContent, contentType = 'html') {
  if (!targetId.includes('/')) {
    // Chats don't have thread replies via Graph; fall back to a regular message
    return postTeamsMessage(userEmail, targetId, htmlContent, contentType);
  }
  const token = await getAccessToken(userEmail);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const slashIdx = targetId.indexOf('/');
  const teamId    = targetId.slice(0, slashIdx);
  const channelId = targetId.slice(slashIdx + 1);
  const url =
    `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}` +
    `/channels/${encodeURIComponent(channelId)}` +
    `/messages/${encodeURIComponent(parentMessageId)}/replies`;
  const body = { body: { content: htmlContent, contentType } };
  const res = await axios.post(url, body, { headers });
  return { ok: true, id: res.data.id };
}

/**
 * True if a delegated Microsoft token with Teams posting scopes is stored for this user.
 *
 * Checks (in order):
 *   1. Explicit agent tag: 'message' or 'both'
 *   2. JWT scp fallback: token contains ChannelMessage.Send or Chat.ReadWrite
 *
 * App-only tokens are always rejected — messages must be sent as a user.
 */
function hasTeamsToken(userEmail) {
  try {
    const stored = tokenStore.getMicrosoftToken(userEmail);
    if (!stored?.accessToken && !stored?.refreshToken) return false;
    if (stored.mode === 'app-only') return false;
    const agent = (stored.agent || '').toLowerCase();
    // Explicitly tagged message accounts always pass
    if (agent === 'message' || agent === 'both') return true;
    // For untagged accounts: decode the stored access token JWT and check for Teams scopes
    if (stored.accessToken) {
      try {
        const payload = JSON.parse(Buffer.from(stored.accessToken.split('.')[1], 'base64').toString());
        const scp = (payload.scp || payload.scope || '').toLowerCase();
        if (scp.includes('channel') || scp.includes('team') || scp.includes('chat')) return true;
      } catch { /* ignore JWT decode errors */ }
    }
    return false;
  } catch { return false; }
}

/**
 * Read recent messages from a Teams chat (DM) or channel.
 *
 * For DMs/group chats (targetId has no '/'):
 *   GET /chats/{chatId}/messages  — requires Chat.Read or Chat.ReadWrite (delegated)
 *
 * For channels (targetId "teamId/channelId"):
 *   GET /teams/{teamId}/channels/{channelId}/messages
 *   — requires ChannelMessage.Read.All (typically needs admin consent)
 *   — falls back gracefully with an empty array + warning if forbidden.
 *
 * Returns an array of raw Graph message objects (newest-first order may vary).
 * Pass { top, sinceMinutes } to limit results.
 */
async function readTeamsMessages(userEmail, targetId, { top = 50, sinceMinutes = 120 } = {}) {
  const token = await getAccessToken(userEmail);
  const headers = { Authorization: `Bearer ${token}` };
  const sinceMs = Date.now() - sinceMinutes * 60 * 1000;

  let url;
  const isChannel = targetId.includes('/');
  if (isChannel) {
    const slash = targetId.indexOf('/');
    const teamId    = targetId.slice(0, slash);
    const channelId = targetId.slice(slash + 1);
    // Teams channel messages: Graph supports $top but not $filter createdDateTime on this endpoint
    url =
      `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}` +
      `/channels/${encodeURIComponent(channelId)}/messages?$top=${top}`;
  } else {
    // Chat messages: $top supported; filter by date client-side
    url =
      `${GRAPH_BASE}/chats/${encodeURIComponent(targetId)}/messages?$top=${top}`;
  }

  try {
    const res = await axios.get(url, { headers });
    const all = res.data.value || [];
    // Filter to the time window on the client side
    return all.filter((m) => {
      if (!m.createdDateTime) return true;
      return new Date(m.createdDateTime).getTime() >= sinceMs;
    });
  } catch (err) {
    const status = err.response?.status;
    const errMsg = err.response?.data?.error?.message || err.message;
    if (status === 403) {
      logger.warn(
        `[readTeamsMessages] 403 reading ${targetId} for ${userEmail}: ${errMsg}. ` +
        (isChannel ? 'Add ChannelMessage.Read.All consent in Azure.' : 'Token missing Chat.Read scope.')
      );
      return [];
    }
    throw err;
  }
}

module.exports = {
  getAppAccessToken,
  getMailFolders,
  getAllFoldersFlat,
  getTotalMessageCount,
  getMessages,
  getMessageCount,
  getCalendars,
  getEvents,
  getEventCount,
  getAttachments,
  listUsers,
  hasMailbox,
  filterMailboxEnabled,
  DEFAULT_FOLDER_NAMES,
  emptyFolderViaApi,
  deleteAllMessagesInFolder,
  deleteFolder,
  deleteAllEventsInCalendar,
  deleteCalendar,
  cleanMailbox,
  listTeamsTargets,
  postTeamsMessage,
  postTeamsReply,
  readTeamsMessages,
  hasTeamsToken,
};
