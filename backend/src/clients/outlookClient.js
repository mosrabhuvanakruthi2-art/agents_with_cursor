const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios = require('axios');
const env = require('../config/env');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Microsoft Graph requires user principal names to be URL-encoded in /users/{segment}/ paths. */
function graphUserPath(userId) {
  return encodeURIComponent(String(userId == null ? '' : userId).trim());
}

let tokenCache = { accessToken: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const msalConfig = {
    auth: {
      clientId: env.GRAPH_CLIENT_ID,
      clientSecret: env.GRAPH_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}`,
    },
  };

  const cca = new ConfidentialClientApplication(msalConfig);
  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });

  tokenCache = {
    accessToken: result.accessToken,
    expiresAt: Date.now() + (result.expiresOn - Date.now()) * 0.9,
  };

  return result.accessToken;
}

async function graphGet(url) {
  const token = await getAccessToken();
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
    const res = await graphGet(`${base}&$expand=${deepExpand}`);
    return res.data.value || [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 400) {
      logger.warn(
        `getMailFolders: deep $expand returned 400 for ${userId}, retrying shallow childFolders expand`
      );
      const res = await graphGet(`${base}&$expand=${shallowExpand}`);
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
  const token = await getAccessToken();
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
  const res = await graphGet(url);
  return res.data.value || [];
}

async function getMessageCount(userId, folderId) {
  const uid = graphUserPath(userId);
  const url = folderId
    ? `${GRAPH_BASE}/users/${uid}/mailFolders/${encodeURIComponent(folderId)}/messages/$count`
    : `${GRAPH_BASE}/users/${uid}/messages/$count`;
  const token = await getAccessToken();
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
  const res = await graphGet(`${GRAPH_BASE}/users/${graphUserPath(userId)}/calendars?$top=100`);
  return res.data.value || [];
}

async function getEvents(userId, calendarId, top = 250) {
  const uid = graphUserPath(userId);
  const url = calendarId
    ? `${GRAPH_BASE}/users/${uid}/calendars/${encodeURIComponent(calendarId)}/events?$top=${top}`
    : `${GRAPH_BASE}/users/${uid}/events?$top=${top}`;
  const res = await graphGet(url);
  return res.data.value || [];
}

async function getEventCount(userId, calendarId) {
  const token = await getAccessToken();
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
    `${GRAPH_BASE}/users/${graphUserPath(userId)}/messages/${encodeURIComponent(messageId)}/attachments`
  );
  return res.data.value || [];
}

/**
 * List all users in the tenant with a mailbox (has a mail address).
 */
async function listUsers() {
  const token = await getAccessToken();
  const users = [];
  let url = `${GRAPH_BASE}/users?$top=999&$select=id,displayName,mail,givenName,surname,userPrincipalName`;

  while (url) {
    const res = await retryWithBackoff(
      () => axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { label: 'Graph listUsers' }
    );

    const items = res.data.value || [];
    for (const u of items) {
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
 * Check if a user has a mailbox enabled by trying to access their inbox.
 * Returns true if the user has a working mailbox, false otherwise.
 */
async function hasMailbox(userEmail) {
  try {
    const token = await getAccessToken();
    await axios.get(
      `${GRAPH_BASE}/users/${graphUserPath(userEmail)}/mailFolders/inbox?$select=id`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
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

async function graphDelete(url) {
  const token = await getAccessToken();
  return retryWithBackoff(
    () => axios.delete(url, { headers: { Authorization: `Bearer ${token}` } }),
    { label: `Graph DELETE ${url.replace(GRAPH_BASE, '')}`, maxRetries: 2 }
  );
}

async function graphPost(url, body) {
  const token = await getAccessToken();
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
async function batchDelete(requests) {
  if (requests.length === 0) return;
  const token = await getAccessToken();
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
        const tkn = await getAccessToken();
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
  const token = await getAccessToken();
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
    const token = await getAccessToken();
    const res = await axios.get(
      `${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages?$top=100&$select=id`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const messages = res.data.value || [];
    if (messages.length === 0) { hasMore = false; break; }

    const batchSize = 20;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      await batchDelete(batch.map((m) => `${GRAPH_BASE}/users/${graphUserPath(userId)}/messages/${encodeURIComponent(m.id)}`));
      deleted += batch.length;
    if (deleted % 500 === 0 && deleted > 0) { const log = require('../utils/logger'); log.info('[events] Deleted ' + deleted + ' events so far...'); }
    }
  }

  return deleted;
}

function deleteFolder(userId, folderId) {
  return graphDelete(`${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/${encodeURIComponent(folderId)}`);
}

/**
 * Delete all events from a calendar using parallel Graph $batch API calls.
 * Fetches 100 events per page and fires all batch-delete calls in parallel (5x faster).
 */
async function deleteAllEventsInCalendar(userId, calendarId) {
  let deleted = 0;

  while (true) {
    const token = await getAccessToken();
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
    await Promise.all(batches.map((b) => batchDelete(b)));
    deleted += events.length;
  }

  return deleted;
}

/**
 * Delete a non-default calendar entirely.
 */
function deleteCalendar(userId, calendarId) {
  return graphDelete(`${GRAPH_BASE}/users/${graphUserPath(userId)}/calendars/${encodeURIComponent(calendarId)}`);
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
