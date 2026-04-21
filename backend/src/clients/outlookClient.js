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
 * Refresh the stored Microsoft OAuth delegated token using its refresh_token.
 * Uses the correct tenant's client credentials based on the stored email.
 */
async function refreshStoredMicrosoftToken(stored) {
  const tenant = getMsTenant(stored.email);
  const { clientId, clientSecret, tenantId } = getMsCredentials(tenant);
  const tokenUrl = `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
    scope: 'offline_access User.Read Mail.ReadWrite Calendars.ReadWrite',
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
};
