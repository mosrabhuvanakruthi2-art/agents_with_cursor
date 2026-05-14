const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios = require('axios');
const env = require('../config/env');
const tokenStore = require('./oauthTokenStore');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');
const { normalizeSubject } = require('../utils/mailMigrationComparator');

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

// Per-tenant app-only token cache (Graph)
const tokenCaches = {};

// Per-tenant EWS token cache (Exchange Web Services — separate scope from Graph)
const ewsTokenCaches = {};

// In-memory cache for getMailFolders — avoids 40+ repeated Graph calls during validation
const _folderCache = new Map(); // userId -> { data, expiresAt }
const FOLDER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const EWS_ENDPOINT = 'https://outlook.office365.com/EWS/Exchange.asmx';

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

async function graphGetWithHeaders(url, userId = null, extraHeaders = {}) {
  const token = await getAccessToken(userId);
  return retryWithBackoff(
    () =>
      axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
      }),
    { label: `Graph GET ${url.replace(GRAPH_BASE, '')}` }
  );
}

async function getMailFolders(userId) {
  const cached = _folderCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const uid = graphUserPath(userId);
  const base = `${GRAPH_BASE}/users/${uid}/mailFolders?$top=100`;
  const deepExpand = encodeURIComponent('childFolders($expand=childFolders($expand=childFolders))');
  const shallowExpand = encodeURIComponent('childFolders');
  let data;
  try {
    const res = await graphGet(`${base}&$expand=${deepExpand}`, userId);
    data = res.data.value || [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 400) {
      logger.warn(
        `getMailFolders: deep $expand returned 400 for ${userId}, retrying shallow childFolders expand`
      );
      const res = await graphGet(`${base}&$expand=${shallowExpand}`, userId);
      data = res.data.value || [];
    } else {
      throw err;
    }
  }

  _folderCache.set(userId, { data, expiresAt: Date.now() + FOLDER_CACHE_TTL_MS });
  return data;
}

function clearFolderCache(userId) {
  if (userId) _folderCache.delete(userId);
  else _folderCache.clear();
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

/**
 * Walk parentFolderId chain to a human path: "Inbox / QA-TestLabel / Nested-Child"
 */
async function getMailFolderPathString(userId, leafFolderId) {
  if (!leafFolderId) return '';
  const flat = await getAllFoldersFlat(userId);
  const byId = new Map(flat.map((f) => [f.id, f]));
  const parts = [];
  let cur = leafFolderId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const f = byId.get(cur);
    if (!f) break;
    parts.unshift((f.displayName || '').trim() || cur);
    cur = f.parentFolderId || null;
  }
  return parts.join(' / ');
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

/** Fields for deep source↔destination mail validation (includes Gmail-mapping markers). */
const MESSAGE_SELECT_DEEP =
  'internetMessageId,subject,bodyPreview,body,hasAttachments,receivedDateTime,sentDateTime,toRecipients,ccRecipients,bccRecipients,from,parentFolderId,flag,importance,categories';

/**
 * Single message by Graph id with recipient + body fields.
 */
async function getMessageById(userId, messageId, selectOverride) {
  const uid = graphUserPath(userId);
  const select = encodeURIComponent(selectOverride || MESSAGE_SELECT_DEEP);
  const url = `${GRAPH_BASE}/users/${uid}/messages/${encodeURIComponent(messageId)}?$select=${select}`;
  const res = await graphGet(url, userId);
  return res.data;
}

/**
 * Find messages anywhere in mailbox by RFC 5322 Message-ID (internetMessageId).
 * OData single quotes in filter values must be doubled.
 */
async function findMessagesByInternetMessageId(userId, internetMessageId) {
  const raw = String(internetMessageId || '').trim();
  if (!raw) return [];
  const uid = graphUserPath(userId);
  const escaped = raw.replace(/'/g, "''");
  const filter = `internetMessageId eq '${escaped}'`;
  const url = `${GRAPH_BASE}/users/${uid}/messages?$filter=${encodeURIComponent(filter)}&$top=25&$select=${encodeURIComponent(MESSAGE_SELECT_DEEP)}`;
  try {
    const res = await graphGet(url, userId);
    return res.data.value || [];
  } catch (err) {
    logger.warn(`findMessagesByInternetMessageId filter failed for ${userId}: ${err.message}`);
    return [];
  }
}

/**
 * Strip RFC 5322 angle brackets from Message-ID / internetMessageId for comparison.
 */
function stripAngleBrackets(s) {
  return String(s || '')
    .trim()
    .replace(/^<+/, '')
    .replace(/>+$/, '')
    .trim();
}

/**
 * Whether two Message-IDs refer to the same identifier (ignore brackets; case-insensitive).
 */
function internetMessageIdsEqual(a, b) {
  if (!a || !b) return false;
  return stripAngleBrackets(a).toLowerCase() === stripAngleBrackets(b).toLowerCase();
}

/**
 * Resolve destination Graph message(s) for a source RFC Message-ID.
 * Tries OData filter string variants, optional $search, then paginated mailbox scan.
 * Migration tools sometimes rewrite Message-ID — if nothing matches after scan, pairing fails.
 *
 * @param {string} userId – destination mailbox (UPN)
 * @param {string} sourceInternetMessageId – Message-ID from Gmail or Outlook source
 * @param {{ maxScan?: number, skipMailboxScan?: boolean }} [options]
 */
async function resolveDestinationByInternetMessageId(userId, sourceInternetMessageId, options = {}) {
  const maxScan =
    typeof options.maxScan === 'number' && options.maxScan > 0
      ? options.maxScan
      : parseInt(process.env.DEEP_VALIDATION_SCAN_MAX, 10) || 3000;
  const skipMailboxScan =
    options.skipMailboxScan === true ||
    String(process.env.DEEP_VALIDATION_SKIP_MAILBOX_SCAN || '').toLowerCase() === 'true' ||
    process.env.DEEP_VALIDATION_SKIP_MAILBOX_SCAN === '1';

  const raw = String(sourceInternetMessageId || '').trim();
  if (!raw) {
    return { matches: [], strategy: 'none', detail: 'empty-id', scannedMessages: 0 };
  }

  const inner = stripAngleBrackets(raw);
  /** @type {string[]} */
  const variants = [];
  const addVariant = (v) => {
    const s = String(v || '').trim();
    if (s && !variants.includes(s)) variants.push(s);
  };
  addVariant(raw);
  addVariant(inner);
  addVariant(`<${inner}>`);
  try {
    const dec = decodeURIComponent(inner);
    if (dec !== inner) addVariant(dec);
    addVariant(`<${dec}>`);
  } catch {
    /* ignore */
  }

  for (const v of variants) {
    const hits = await findMessagesByInternetMessageId(userId, v);
    if (hits.length) {
      return {
        matches: hits,
        strategy: 'odata-filter',
        detail: null,
        scannedMessages: 0,
      };
    }
  }

  try {
    const uid = graphUserPath(userId);
    const searchPhrase = inner.includes(' ') ? `"${inner.replace(/"/g, '')}"` : inner;
    const url = `${GRAPH_BASE}/users/${uid}/messages?$search=${encodeURIComponent(
      searchPhrase
    )}&$top=50&$select=${encodeURIComponent(MESSAGE_SELECT_DEEP)}`;
    const res = await graphGetWithHeaders(url, userId, { ConsistencyLevel: 'eventual' });
    const vals = res.data.value || [];
    const matched = vals.filter((m) => internetMessageIdsEqual(sourceInternetMessageId, m.internetMessageId));
    if (matched.length) {
      return {
        matches: matched,
        strategy: 'graph-search',
        detail: null,
        scannedMessages: 0,
      };
    }
  } catch (err) {
    logger.warn(`resolveDestinationByInternetMessageId: $search fallback failed for ${userId}: ${err.message}`);
  }

  if (skipMailboxScan) {
    return {
      matches: [],
      strategy: 'none',
      detail: 'no-odata-or-search-match',
      scannedMessages: 0,
    };
  }

  let scannedMessages = 0;
  try {
    const scanned = await listMessagesInFolderPaged(
      userId,
      null,
      maxScan,
      'id,internetMessageId,receivedDateTime',
      'receivedDateTime desc'
    );
    scannedMessages = scanned.length;
    for (let i = 0; i < scanned.length; i++) {
      const m = scanned[i];
      if (internetMessageIdsEqual(sourceInternetMessageId, m.internetMessageId)) {
        return {
          matches: [{ id: m.id, internetMessageId: m.internetMessageId }],
          strategy: 'mailbox-scan',
          detail: null,
          scannedMessages: i + 1,
        };
      }
    }
  } catch (err) {
    logger.warn(`resolveDestinationByInternetMessageId: mailbox scan failed for ${userId}: ${err.message}`);
    return {
      matches: [],
      strategy: 'none',
      detail: `mailbox-scan-error: ${err.message}`,
      scannedMessages,
    };
  }

  return {
    matches: [],
    strategy: 'none',
    detail: 'no-match-after-scan',
    scannedMessages,
  };
}

/**
 * Paginate message list (folder-scoped or all mail) until maxTotal rows.
 */
async function listMessagesInFolderPaged(userId, folderId, maxTotal = 500, selectFields, orderBy) {
  const uid = graphUserPath(userId);
  const select = encodeURIComponent(selectFields || 'id,internetMessageId,subject,hasAttachments,receivedDateTime,sentDateTime');
  const top = Math.min(100, Math.max(maxTotal, 1));
  const orderClause =
    orderBy && String(orderBy).trim()
      ? `&$orderby=${encodeURIComponent(String(orderBy).trim())}`
      : '';
  let url = folderId
    ? `${GRAPH_BASE}/users/${uid}/mailFolders/${encodeURIComponent(folderId)}/messages?$top=${top}&$select=${select}${orderClause}`
    : `${GRAPH_BASE}/users/${uid}/messages?$top=${top}&$select=${select}${orderClause}`;
  const out = [];
  while (url && out.length < maxTotal) {
    const res = await graphGet(url, userId);
    const batch = res.data.value || [];
    for (const m of batch) {
      out.push(m);
      if (out.length >= maxTotal) break;
    }
    if (out.length >= maxTotal) break;
    url = res.data['@odata.nextLink'] || null;
  }
  return out;
}

/**
 * When Message-ID changes during migration, pair by normalized subject + received/sent time.
 * Among messages within the time window, picks the smallest |Δ(receivedTime − anchor)|.
 *
 * @returns {{ match: { id: string, internetMessageId?: string } | null, candidatesCount: number, detail: string, bestDeltaMs: number | null }}
 */
async function findBestMessageBySubjectAndTime(userId, normalizedSubject, anchorEpochMs, windowMinutes, maxScan) {
  const ns = String(normalizedSubject || '').trim();
  if (!ns || !Number.isFinite(anchorEpochMs)) {
    return { match: null, candidatesCount: 0, detail: 'invalid-input', bestDeltaMs: null };
  }
  const wm = Number(windowMinutes);
  const windowMs = Math.max(1, Number.isFinite(wm) && wm > 0 ? wm : 30) * 60 * 1000;
  const cap = typeof maxScan === 'number' && maxScan > 0 ? maxScan : 3000;
  const scanned = await listMessagesInFolderPaged(
    userId,
    null,
    cap,
    'id,subject,internetMessageId,receivedDateTime,sentDateTime',
    'receivedDateTime desc'
  );
  const candidates = [];
  for (const m of scanned) {
    if (normalizeSubject(m.subject) !== ns) continue;
    const rt = new Date(m.receivedDateTime || m.sentDateTime || 0).getTime();
    if (!Number.isFinite(rt)) continue;
    const delta = Math.abs(rt - anchorEpochMs);
    if (delta <= windowMs) candidates.push({ m, delta });
  }
  if (candidates.length === 0) {
    return { match: null, candidatesCount: 0, detail: 'no-subject-time-match', bestDeltaMs: null };
  }
  candidates.sort((a, b) => a.delta - b.delta);
  const best = candidates[0];
  return {
    match: { id: best.m.id, internetMessageId: best.m.internetMessageId },
    candidatesCount: candidates.length,
    detail: candidates.length > 1 ? 'closest-of-multiple' : 'unique',
    bestDeltaMs: best.delta,
  };
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
 * When options.permanent=true, uses POST …/permanentDelete — removes messages without
 * going through Deleted Items or Recoverable Items.
 *
 * 429 handling: mirrors Java CalendarService — up to 6 retries per throttled sub-request,
 * sleeping Retry-After seconds (min 2s) between each attempt.
 */
async function batchDelete(requests, userId = null, options = {}) {
  if (requests.length === 0) return;
  const permanent = options.permanent === true;
  const MAX_RETRIES = 6;

  let pending = [...requests];

  for (let attempt = 0; attempt <= MAX_RETRIES && pending.length > 0; attempt++) {
    const token = await getAccessToken(userId);
    const batchBody = {
      requests: pending.map((url, i) =>
        permanent
          ? {
              id: String(i + 1),
              method: 'POST',
              url: url.replace(GRAPH_BASE, '') + '/permanentDelete',
              body: {},
              headers: { 'Content-Type': 'application/json' },
            }
          : {
              id: String(i + 1),
              method: 'DELETE',
              url: url.replace(GRAPH_BASE, ''),
            }
      ),
    };

    let batchRes;
    try {
      batchRes = await axios.post(`${GRAPH_BASE}/$batch`, batchBody, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 60000,
      });
    } catch (err) {
      // HTTP-level failure — fall back to individual operations (no retry loop)
      for (const req of pending) {
        try {
          const tkn = await getAccessToken(userId);
          if (permanent) {
            await axios.post(`${req}/permanentDelete`, {}, {
              headers: { Authorization: `Bearer ${tkn}`, 'Content-Type': 'application/json' },
              timeout: 10000,
            });
          } else {
            await axios.delete(req, { headers: { Authorization: `Bearer ${tkn}` }, timeout: 10000 });
          }
        } catch { /* skip */ }
      }
      return;
    }

    // Check individual sub-response statuses for 429 (throttling)
    const responses = batchRes.data?.responses || [];
    const throttledIds = new Set();
    let retryAfterMs = 2000;

    for (const r of responses) {
      if (r.status === 429) {
        throttledIds.add(r.id);
        const ra = r.headers?.['Retry-After'] || r.headers?.['retry-after'];
        if (ra) {
          const secs = parseInt(ra, 10);
          if (Number.isFinite(secs) && secs > 0) retryAfterMs = Math.max(retryAfterMs, secs * 1000);
        }
      }
    }

    if (throttledIds.size === 0) break; // all succeeded

    // Keep only the throttled requests for the next attempt
    pending = pending.filter((_, i) => throttledIds.has(String(i + 1)));

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, retryAfterMs));
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
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
}

/**
 * Delete ALL messages from a mailbox in one shot regardless of folder.
 * Uses GET /messages (no folder filter) with $top=999 — one page covers most mailboxes.
 * Batch deletes are fired in parallel. Used as fast fallback when emptyFolderViaApi fails.
 *
 * Safety guard: if two consecutive iterations see the same message count, deletes are not
 * working (e.g. missing Mail.ReadWrite application permission). Throws instead of looping forever.
 */
async function deleteAllMailboxMessages(userId) {
  const log = require('../utils/logger');
  let deleted = 0;
  let lastCount = -1;
  const MAX_ITERATIONS = 50;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const token = await getAccessToken(userId);
    const res = await axios.get(
      `${GRAPH_BASE}/users/${graphUserPath(userId)}/messages?$top=999&$select=id`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
    );
    const messages = res.data.value || [];
    if (messages.length === 0) break;

    if (messages.length === lastCount) {
      throw new Error(
        `deleteAllMailboxMessages: no progress after delete attempt — ${messages.length} messages still present. ` +
        `Check that the Azure AD app has Mail.ReadWrite application permission for ${userId}.`
      );
    }
    lastCount = messages.length;

    const batchSize = 20;
    const batches = [];
    for (let i = 0; i < messages.length; i += batchSize) {
      batches.push(messages.slice(i, i + batchSize).map((m) =>
        `${GRAPH_BASE}/users/${graphUserPath(userId)}/messages/${encodeURIComponent(m.id)}`
      ));
    }
    await Promise.all(batches.map((b) => batchDelete(b, userId, { permanent: true })));
    deleted += messages.length;
    log.info(`[deleteAllMailbox ${userId}] Permanently deleted ${deleted} messages so far (iter ${iter + 1})…`);
  }
  return deleted;
}

/**
 * Delete all messages from a folder using Graph $batch API (20 per batch call).
 * Loop guard: if two consecutive iterations see the same count, deletes are silently
 * failing — throws instead of looping forever.
 */
async function deleteAllMessagesInFolder(userId, folderId) {
  let deleted = 0;
  let lastCount = -1;
  const MAX_ITERATIONS = 50;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const token = await getAccessToken(userId);
    const res = await axios.get(
      `${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages?$top=100&$select=id`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const messages = res.data.value || [];
    if (messages.length === 0) break;

    if (messages.length === lastCount) {
      throw new Error(`deleteAllMessagesInFolder: no progress — ${messages.length} messages remain. Check Mail.ReadWrite application permission.`);
    }
    lastCount = messages.length;

    const batchSize = 20;
    const batches = [];
    for (let i = 0; i < messages.length; i += batchSize) {
      batches.push(messages.slice(i, i + batchSize).map((m) => `${GRAPH_BASE}/users/${graphUserPath(userId)}/messages/${encodeURIComponent(m.id)}`));
    }
    await Promise.all(batches.map((b) => batchDelete(b, userId, { permanent: true })));
    deleted += messages.length;
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

// ─── EWS (Exchange Web Services) ─────────────────────────────────────────────
// Used for calendar event deletion with SendMeetingCancellations="SendToNone"
// so attendees do not receive cancellation emails during QA mailbox cleanup.
// Requires the Azure AD app to have the "full_access_as_app" Exchange permission
// (separate from Graph permissions — add in Azure AD → App registrations → API permissions
//  → APIs my org uses → Office 365 Exchange Online → Application permissions → full_access_as_app).

/**
 * App-only EWS token via client_credentials using the Exchange Online scope.
 * Cached per tenant, same pattern as getAppAccessToken.
 */
async function getEwsToken(tenant = '1') {
  const cache = ewsTokenCaches[tenant] || (ewsTokenCaches[tenant] = { accessToken: null, expiresAt: 0 });
  if (cache.accessToken && Date.now() < cache.expiresAt) return cache.accessToken;
  const { clientId, clientSecret, tenantId } = getMsCredentials(tenant);
  const cca = new ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority: `https://login.microsoftonline.com/${tenantId}` },
  });
  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://outlook.office365.com/.default'],
  });
  cache.accessToken = result.accessToken;
  cache.expiresAt = Date.now() + (result.expiresOn - Date.now()) * 0.9;
  return cache.accessToken;
}

/**
 * EWS FindItem — returns all calendar event ItemIds for the given mailbox.
 * Uses ExchangeImpersonation so the app-only token can access any mailbox.
 */
async function ewsFindCalendarItemIds(userId, tenant = '1') {
  const token = await getEwsToken(tenant);
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016"/>
    <t:ExchangeImpersonation>
      <t:ConnectingSID><t:SmtpAddress>${userId}</t:SmtpAddress></t:ConnectingSID>
    </t:ExchangeImpersonation>
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="1000" Offset="0" BasePoint="Beginning"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="calendar">
          <t:Mailbox><t:EmailAddress>${userId}</t:EmailAddress></t:Mailbox>
        </t:DistinguishedFolderId>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;

  const res = await axios.post(EWS_ENDPOINT, soap, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/xml; charset=utf-8' },
    timeout: 30000,
  });

  // Extract ItemId values with a simple regex — EWS returns <t:ItemId Id="..." ChangeKey="..."/>
  const ids = [];
  for (const m of String(res.data).matchAll(/ItemId Id="([^"]+)"/g)) ids.push(m[1]);
  return ids;
}

/**
 * EWS DeleteItem — permanently deletes calendar events with SendToNone
 * so no cancellation emails are sent to attendees.
 * Processes up to 100 items per SOAP call.
 */
async function ewsDeleteCalendarItems(userId, itemIds, tenant = '1') {
  if (itemIds.length === 0) return;
  const token = await getEwsToken(tenant);
  const chunkSize = 100;

  for (let i = 0; i < itemIds.length; i += chunkSize) {
    const chunk = itemIds.slice(i, i + chunkSize);
    const itemXml = chunk.map((id) => `<t:ItemId Id="${id}"/>`).join('');
    const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016"/>
    <t:ExchangeImpersonation>
      <t:ConnectingSID><t:SmtpAddress>${userId}</t:SmtpAddress></t:ConnectingSID>
    </t:ExchangeImpersonation>
  </soap:Header>
  <soap:Body>
    <m:DeleteItem DeleteType="HardDelete" SendMeetingCancellations="SendToNone">
      <m:ItemIds>${itemXml}</m:ItemIds>
    </m:DeleteItem>
  </soap:Body>
</soap:Envelope>`;

    await axios.post(EWS_ENDPOINT, soap, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/xml; charset=utf-8' },
      timeout: 30000,
    });
  }
}

/**
 * Delete ALL default-calendar events via EWS with SendToNone (no cancellation emails).
 * Loops until the calendar is empty. Falls through on any error so caller can fall back to Graph.
 * Requires full_access_as_app Exchange permission on the Azure AD app.
 */
async function deleteAllCalendarEventsViaEws(userId) {
  const log = require('../utils/logger');
  const tenant = getMsTenant(userId);
  let deleted = 0;
  let lastCount = -1;

  for (let iter = 0; iter < 50; iter++) {
    const itemIds = await ewsFindCalendarItemIds(userId, tenant);
    if (itemIds.length === 0) break;
    if (itemIds.length === lastCount) {
      log.warn(`[EWS ${userId}] No progress on calendar delete — stopping`);
      break;
    }
    lastCount = itemIds.length;
    await ewsDeleteCalendarItems(userId, itemIds, tenant);
    deleted += itemIds.length;
    log.info(`[EWS ${userId}] Deleted ${deleted} calendar events via EWS so far…`);
  }
  return deleted;
}
// ─── End EWS ─────────────────────────────────────────────────────────────────

/**
 * Delete all messages from every folder but leave the folder structure intact.
 * Uses mailbox-wide GET /messages?$top=999 + parallel batch deletes — no folder
 * enumeration needed, so it's fast even on mailboxes with hundreds of label-folders.
 */
async function cleanOutlookEmailsOnly(userId) {
  const log = require('../utils/logger');
  const summary = { messagesDeleted: 0, errors: [] };

  try {
    const count = await deleteAllMailboxMessages(userId);
    summary.messagesDeleted += count;
  } catch (err) {
    summary.errors.push(`Mailbox-wide delete failed: ${err.message}`);
    log.warn(`[cleanEmailsOnly ${userId}] Mailbox-wide delete error: ${err.message}`);
  }

  const recovered = await cleanRecoverableItems(userId);
  summary.messagesDeleted += recovered;
  log.info(`[cleanEmailsOnly ${userId}] Done — ${summary.messagesDeleted} msgs deleted (incl. ${recovered} recoverable)`);
  return summary;
}

/**
 * Delete only custom folders (and their contents). Default folders are not touched.
 */
async function cleanOutlookFoldersOnly(userId) {
  const log = require('../utils/logger');
  const topFolders = await getMailFolders(userId);
  const summary = { foldersDeleted: 0, messagesDeleted: 0, errors: [] };

  for (const folder of topFolders) {
    if (!DEFAULT_FOLDER_NAMES.has(folder.displayName)) {
      try {
        summary.messagesDeleted += folder.totalItemCount || 0;
        await deleteFolder(userId, folder.id);
        summary.foldersDeleted++;
        log.info(`[cleanFoldersOnly ${userId}] Deleted "${folder.displayName}"`);
      } catch (err) {
        if (/404/.test(err.message)) {
          log.info(`[cleanFoldersOnly ${userId}] Folder "${folder.displayName}" already gone (404), skipping`);
        } else {
          summary.errors.push(`Folder "${folder.displayName}": ${err.message}`);
        }
      }
    } else if (folder.childFolders?.length > 0) {
      for (const child of folder.childFolders) {
        if (!DEFAULT_FOLDER_NAMES.has(child.displayName)) {
          try {
            summary.messagesDeleted += child.totalItemCount || 0;
            await deleteFolder(userId, child.id);
            summary.foldersDeleted++;
          } catch (err) {
            if (!/404/.test(err.message)) {
              summary.errors.push(`Child folder "${child.displayName}": ${err.message}`);
            }
        }
      }
    }
  }
  }
  log.info(`[cleanFoldersOnly ${userId}] Done — ${summary.foldersDeleted} folders deleted`);
  return summary;
}

/**
 * Delete calendar events only (does not touch emails or folders).
 * EWS path (primary): uses SendToNone so no cancellation emails are sent to attendees.
 * Graph path (fallback): used when EWS token/permission is unavailable.
 */
async function cleanOutlookEventsOnly(userId) {
  const log = require('../utils/logger');
  const summary = { eventsDeleted: 0, calendarsDeleted: 0, errors: [], ewsUsed: false };

  // EWS path — suppresses cancellation notifications (mirrors Java CalendarService EWS path)
  let ewsHandledDefault = false;
  try {
    const deleted = await deleteAllCalendarEventsViaEws(userId);
    summary.eventsDeleted += deleted;
    summary.ewsUsed = true;
    ewsHandledDefault = true;
    log.info(`[cleanEventsOnly ${userId}] EWS: deleted ${deleted} default-calendar events (no notifications sent)`);
  } catch (ewsErr) {
    log.warn(`[cleanEventsOnly ${userId}] EWS unavailable (${ewsErr.message}) — falling back to Graph API`);
  }

  // Graph path — handles non-default calendars always; also handles default calendar if EWS failed
  try {
    const calendars = await getCalendars(userId);
    for (const cal of calendars) {
      if (cal.name === 'Birthdays' || cal.name.toLowerCase().includes('holidays') || cal.canEdit === false) continue;
      if (cal.isDefaultCalendar) {
        if (!ewsHandledDefault) {
          try {
            const evtCount = await getEventCount(userId, cal.id);
            if (evtCount > 0) {
              const deleted = await deleteAllEventsInCalendar(userId, cal.id);
              summary.eventsDeleted += deleted;
              log.info(`[cleanEventsOnly ${userId}] Graph: deleted ${deleted} events from default calendar`);
            }
          } catch (err) {
            summary.errors.push(`Default calendar "${cal.name}": ${err.message}`);
          }
        }
      } else {
        try {
          await deleteCalendar(userId, cal.id);
          summary.calendarsDeleted++;
          log.info(`[cleanEventsOnly ${userId}] Deleted secondary calendar "${cal.name}"`);
        } catch (err) {
          summary.errors.push(`Calendar "${cal.name}": ${err.message}`);
        }
      }
    }
  } catch (err) {
    summary.errors.push(`Calendars: ${err.message}`);
  }

  log.info(`[cleanEventsOnly ${userId}] Done — ${summary.eventsDeleted} events, ${summary.calendarsDeleted} calendars deleted (EWS: ${summary.ewsUsed})`);
  return summary;
}

/**
 * Return the count of soft-deleted items in the Recoverable Items > Deletions folder.
 * This is the hidden folder Outlook shows as "Recover items deleted from this folder".
 */
async function getRecoverableItemsCount(userId) {
  try {
    const token = await getAccessToken(userId);
    const res = await axios.get(
      `${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/recoverableitemsdeletions`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    return res.data?.totalItemCount ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Permanently purge the Recoverable Items > Deletions folder.
 * Uses permanentDelete action on each item — truly removes them so they don't show as
 * "Recover items deleted from this folder (N items)" in Outlook.
 * Returns the number of items purged.
 */
async function cleanRecoverableItems(userId) {
  const log = require('../utils/logger');
  try {
    const token = await getAccessToken(userId);
    const folderRes = await axios.get(
      `${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/recoverableitemsdeletions`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    const folderCount = folderRes.data?.totalItemCount ?? 0;
    if (folderCount === 0) return 0;

    log.info(`[cleanRecoverable ${userId}] Purging ${folderCount} recoverable items via permanentDelete…`);
    const folderId = folderRes.data?.id;
    if (!folderId) return 0;

    // Fetch all items and permanentDelete them in parallel batches
    let purged = 0;
    let lastCount = -1;
    for (let iter = 0; iter < 20; iter++) {
      const tkn = await getAccessToken(userId);
      const res = await axios.get(
        `${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages?$top=100&$select=id`,
        { headers: { Authorization: `Bearer ${tkn}` }, timeout: 15000 }
      );
      const items = res.data.value || [];
      if (items.length === 0) break;
      if (items.length === lastCount) {
        log.warn(`[cleanRecoverable ${userId}] No progress on recoverable items — may require Mail.Purge permission`);
        break;
      }
      lastCount = items.length;
      const batchSize = 20;
      const batches = [];
      for (let i = 0; i < items.length; i += batchSize) {
        batches.push(items.slice(i, i + batchSize).map((m) =>
          `${GRAPH_BASE}/users/${graphUserPath(userId)}/messages/${encodeURIComponent(m.id)}`
        ));
      }
      await Promise.all(batches.map((b) => batchDelete(b, userId, { permanent: true })));
      purged += items.length;
    }
    log.info(`[cleanRecoverable ${userId}] Purged ${purged} recoverable items`);
    return purged;
  } catch (err) {
    log.warn(`[cleanRecoverable ${userId}] Could not purge recoverable items: ${err.message}`);
    return 0;
  }
}

/**
 * Clean the entire destination mailbox:
 * 1. Delete ALL messages mailbox-wide (fast — no folder enumeration)
 * 2. Delete custom folders (now empty, so deletion is instant)
 * 3. Purge recoverable items
 * 4. Delete calendar events and non-default calendars
 */
async function cleanMailbox(userId) {
  const log = require('../utils/logger');
  const summary = { foldersDeleted: 0, messagesDeleted: 0, calendarsDeleted: 0, eventsDeleted: 0, errors: [] };

  // Step 1: Delete all messages mailbox-wide
  log.info(`[clean ${userId}] Step 1: Deleting all messages mailbox-wide...`);
  try {
    const count = await deleteAllMailboxMessages(userId);
    summary.messagesDeleted += count;
    log.info(`[clean ${userId}] Step 1 done — ${count} messages deleted`);
  } catch (err) {
    summary.errors.push(`Messages: ${err.message}`);
    log.warn(`[clean ${userId}] Step 1 error: ${err.message}`);
  }

  // Step 2: Delete custom folders (messages already gone, so delete is fast)
  log.info(`[clean ${userId}] Step 2: Deleting custom folders...`);
  let topFolders = [];
  try {
    topFolders = await getMailFolders(userId);
  } catch (err) {
    summary.errors.push(`getMailFolders: ${err.message}`);
  }
  const customFolders = topFolders.filter((f) => !DEFAULT_FOLDER_NAMES.has(f.displayName));
  log.info(`[clean ${userId}] Step 2: found ${customFolders.length} custom folders`);

  for (const folder of customFolders) {
    try {
      await deleteFolder(userId, folder.id);
      summary.foldersDeleted++;
      log.info(`[clean ${userId}]   Deleted folder "${folder.displayName}"`);
    } catch (err) {
      summary.errors.push(`Folder "${folder.displayName}": ${err.message}`);
      log.warn(`[clean ${userId}]   Failed folder "${folder.displayName}": ${err.message}`);
    }
  }
  log.info(`[clean ${userId}] Step 2 done — ${summary.foldersDeleted} folders deleted`);

  // Step 3: Purge recoverable items
  log.info(`[clean ${userId}] Step 3: Purging recoverable items...`);
  summary.messagesDeleted += await cleanRecoverableItems(userId);

  // Step 4: Clean calendars (EWS first for default calendar — no cancellation emails)
  log.info(`[clean ${userId}] Step 4: Cleaning calendars...`);
  let ewsHandledDefault = false;
  try {
    const deleted = await deleteAllCalendarEventsViaEws(userId);
    summary.eventsDeleted += deleted;
    ewsHandledDefault = true;
    log.info(`[clean ${userId}]   EWS: deleted ${deleted} default-calendar events (no notifications sent)`);
  } catch (ewsErr) {
    log.warn(`[clean ${userId}]   EWS unavailable (${ewsErr.message}) — using Graph API for calendars`);
  }
  try {
    const calendars = await getCalendars(userId);
    log.info(`[clean ${userId}]   Found ${calendars.length} calendars`);
    for (const cal of calendars) {
      if (cal.name === 'Birthdays' || cal.name.toLowerCase().includes('holidays') || cal.canEdit === false) continue;
      if (cal.isDefaultCalendar) {
        if (!ewsHandledDefault) {
          try {
            const evtCount = await getEventCount(userId, cal.id);
            if (evtCount > 0) {
              const deleted = await deleteAllEventsInCalendar(userId, cal.id);
              summary.eventsDeleted += deleted;
              log.info(`[clean ${userId}]   Graph: deleted ${deleted} events from default calendar "${cal.name}"`);
            }
          } catch (err) {
            summary.errors.push(`Default calendar "${cal.name}": ${err.message}`);
            log.warn(`[clean ${userId}]   Default calendar error: ${err.message}`);
          }
        }
      } else {
        try {
          await deleteCalendar(userId, cal.id);
          summary.calendarsDeleted++;
          log.info(`[clean ${userId}]   Deleted secondary calendar "${cal.name}"`);
        } catch (err) {
          summary.errors.push(`Calendar "${cal.name}": ${err.message}`);
          log.warn(`[clean ${userId}]   Failed calendar "${cal.name}": ${err.message}`);
        }
      }
    }
  } catch (err) {
    summary.errors.push(`Calendars: ${err.message}`);
  }

  log.info(`[clean ${userId}] DONE — ${summary.messagesDeleted} msgs, ${summary.foldersDeleted} folders, ${summary.eventsDeleted} events, ${summary.calendarsDeleted} calendars deleted${summary.errors.length > 0 ? ` (${summary.errors.length} errors)` : ''}`);
  return summary;
}

/**
 * Encode a header value using RFC 2047 base64 encoded-word if it contains non-ASCII chars.
 */
function encodeHeaderValue(str) {
  if (!str) return '';
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

/**
 * Simple quoted-printable encoder for MIME body parts.
 * Encodes non-ASCII bytes and keeps line endings as CRLF.
 */
function encodeQP(str) {
  return str
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, c => {
      return [...Buffer.from(c, 'utf8')].map(b => `=${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    })
    .replace(/\r\n|\r|\n/g, '\r\n');
}

/**
 * Build a MIME RFC 5322 message string from a Graph-API-style message object.
 * Supports plain text, HTML, regular attachments, and inline images.
 */
function buildMimeMessage(msg) {
  const boundary    = `----=_MQA_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const relBoundary = `----=_Related_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const fmt = r => r?.emailAddress
    ? (r.emailAddress.name ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress.address)
    : '';

  const fromStr = fmt(msg.from);
  const toStr   = (msg.toRecipients  || []).map(fmt).filter(Boolean).join(', ');
  const ccStr   = (msg.ccRecipients  || []).map(fmt).filter(Boolean).join(', ');
  const bccStr  = (msg.bccRecipients || []).map(fmt).filter(Boolean).join(', ');

  const isHtml      = (msg.body?.contentType || '').toLowerCase() === 'html';
  const bodyContent = msg.body?.content || '';
  const allAttach   = msg.attachments || [];
  const inlineAtts  = allAttach.filter(a => a.isInline);
  const regularAtts = allAttach.filter(a => !a.isInline);
  const hasInline   = inlineAtts.length > 0;
  const hasRegular  = regularAtts.length > 0;

  const msgId = `<mqa-${Date.now()}-${Math.random().toString(36).slice(2)}@mqa.local>`;
  const L = [];

  // ── headers ──
  L.push(`Message-ID: ${msgId}`);
  if (fromStr) L.push(`From: ${fromStr}`);
  if (toStr)   L.push(`To: ${toStr}`);
  if (ccStr)   L.push(`Cc: ${ccStr}`);
  if (bccStr)  L.push(`Bcc: ${bccStr}`);
  L.push(`Subject: ${encodeHeaderValue(msg.subject || '')}`);
  L.push(`Date: ${new Date().toUTCString()}`);
  L.push('MIME-Version: 1.0');
  L.push('X-Mailer: MigrationQA-Agent');
  if (msg.importance === 'high') { L.push('Importance: high'); L.push('X-Priority: 1'); }
  else if (msg.importance === 'low') { L.push('Importance: low'); L.push('X-Priority: 5'); }

  const addBodyPart = (lines, bodyBoundary) => {
    lines.push(`--${bodyBoundary}`);
    if (hasInline) {
      lines.push(`Content-Type: multipart/related; boundary="${relBoundary}"`);
      lines.push('');
      lines.push(`--${relBoundary}`);
      lines.push(`Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=UTF-8`);
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(encodeQP(bodyContent));
      for (const att of inlineAtts) {
        lines.push(`--${relBoundary}`);
        lines.push(`Content-Type: ${att.contentType || 'image/png'}; name="${att.name}"`);
        lines.push(`Content-ID: <${att.contentId || att.name}>`);
        lines.push(`Content-Disposition: inline; filename="${att.name}"`);
        lines.push('Content-Transfer-Encoding: base64');
        lines.push('');
        lines.push(att.contentBytes);
      }
      lines.push(`--${relBoundary}--`);
    } else {
      lines.push(`Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=UTF-8`);
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(encodeQP(bodyContent));
    }
  };

  if (!hasRegular && !hasInline) {
    // Simple message — no attachments at all
    L.push(`Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=UTF-8`);
    L.push('Content-Transfer-Encoding: quoted-printable');
    L.push('');
    L.push(encodeQP(bodyContent));
  } else {
    L.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    L.push('');
    addBodyPart(L, boundary);
    for (const att of regularAtts) {
      L.push(`--${boundary}`);
      L.push(`Content-Type: ${att.contentType || 'application/octet-stream'}; name="${att.name}"`);
      L.push(`Content-Disposition: attachment; filename="${att.name}"`);
      L.push('Content-Transfer-Encoding: base64');
      L.push('');
      L.push(att.contentBytes);
    }
    L.push(`--${boundary}--`);
  }

  return L.join('\r\n');
}

/**
 * Send an email AS senderEmail using Graph sendMail (requires Mail.Send.All app permission).
 * Returns immediately — the message is delivered by Exchange and appears as a proper
 * received/sent email (isDraft=false, real receivedDateTime, real SMTP headers).
 */
async function sendMailAsUser(senderEmail, messagePayload, saveToSentItems) {
  const token = await getAppAccessToken(getMsTenant(senderEmail));
  const uid   = graphUserPath(senderEmail);
  const msg   = {
    subject:       messagePayload.subject,
    body:          messagePayload.body,
    toRecipients:  messagePayload.toRecipients  || [],
    ccRecipients:  messagePayload.ccRecipients  || [],
    bccRecipients: messagePayload.bccRecipients || [],
  };
  if (Array.isArray(messagePayload.attachments) && messagePayload.attachments.length > 0) {
    msg.attachments = messagePayload.attachments;
  }
  await axios.post(
    `${GRAPH_BASE}/users/${uid}/sendMail`,
    { message: msg, saveToSentItems: Boolean(saveToSentItems) },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
}

/**
 * Wait for a message delivered via sendMail to appear in the recipient's Inbox,
 * then return its Graph message ID.  Retries up to 3× with 2 s gaps.
 * Returns null if not found (caller logs / falls back).
 */
async function findDeliveredInboxMessage(recipientEmail, subject, fromEmail) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const token      = await getAppAccessToken(getMsTenant(recipientEmail));
    const uid        = graphUserPath(recipientEmail);
    const safeSubj   = (subject || '').replace(/'/g, "''");
    const fromLower  = (fromEmail || '').toLowerCase();
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
      const res = await axios.get(
        `${GRAPH_BASE}/users/${uid}/mailFolders/inbox/messages` +
        `?$filter=${encodeURIComponent(`subject eq '${safeSubj}'`)}&$select=id,subject,from&$top=10`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      const found = (res.data.value || []).find(
        (m) => (m.from?.emailAddress?.address || '').toLowerCase() === fromLower
      );
      if (found) return found.id;
    }
  } catch (err) {
    logger.warn(`findDeliveredInboxMessage: "${subject}": ${err.message}`);
  }
  return null;
}

/** Mark a delivered inbox message as read (sendMail always delivers unread). */
async function patchDeliveredInboxIsRead(recipientEmail, subject, fromEmail) {
  try {
    const msgId = await findDeliveredInboxMessage(recipientEmail, subject, fromEmail);
    if (!msgId) { logger.warn(`patchDeliveredInboxIsRead: "${subject}" not found`); return; }
    const token = await getAppAccessToken(getMsTenant(recipientEmail));
    const uid   = graphUserPath(recipientEmail);
    await axios.patch(
      `${GRAPH_BASE}/users/${uid}/messages/${msgId}`,
      { isRead: true },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
  } catch (err) {
    logger.warn(`patchDeliveredInboxIsRead: "${subject}": ${err.message}`);
  }
}

// ─── EWS message injection helpers ───────────────────────────────────────────

// EWS well-known folder name mapping (Graph folder key → EWS DistinguishedFolderId)
const EWS_FOLDER_MAP = {
  inbox: 'inbox',
  sentitems: 'sentitems',
  'sent items': 'sentitems',
  drafts: 'drafts',
  deleteditems: 'deleteditems',
  'deleted items': 'deleteditems',
  junkemail: 'junkemail',
  'junk email': 'junkemail',
  junk: 'junkemail',
  archive: 'archive',
  recoverableitemsdeletions: 'recoverableitemsdeletions',
};

function xmlEsc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function ewsMailboxXml(emailObj) {
  let address, name;
  if (emailObj?.emailAddress) { address = emailObj.emailAddress.address; name = emailObj.emailAddress.name; }
  else if (emailObj?.address)  { address = emailObj.address;             name = emailObj.name; }
  if (!address) return '';
  return `<t:Mailbox>${name ? `<t:Name>${xmlEsc(name)}</t:Name>` : ''}<t:EmailAddress>${xmlEsc(address)}</t:EmailAddress></t:Mailbox>`;
}

function ewsRecipientsXml(tag, list) {
  if (!Array.isArray(list) || !list.length) return '';
  const inner = list.map(ewsMailboxXml).filter(Boolean).join('');
  return inner ? `<t:${tag}>${inner}</t:${tag}>` : '';
}

function ewsAttachmentsXml(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const items = attachments.map((att) => {
    const name    = xmlEsc(att.name || 'attachment');
    const ct      = xmlEsc(att.contentType || 'application/octet-stream');
    const content = att.contentBytes || '';
    const inline  = att.isInline  ? '<t:IsInline>true</t:IsInline>' : '';
    const cid     = att.contentId ? `<t:ContentId>${xmlEsc(att.contentId)}</t:ContentId>` : '';
    return `<t:FileAttachment><t:Name>${name}</t:Name><t:ContentType>${ct}</t:ContentType>${inline}${cid}<t:Content>${content}</t:Content></t:FileAttachment>`;
  });
  return `<t:Attachments>${items.join('')}</t:Attachments>`;
}

/**
 * Insert a message directly into a mailbox folder via EWS CreateItem (SaveOnly).
 * Sets PR_MESSAGE_FLAGS = 0 (no MSGFLAG_UNSENT) so the message appears as a real
 * delivered/sent email — not a draft — regardless of from/to/cc addresses.
 *
 * Returns a minimal object { isDraft: false, subject } on success, or null if the
 * folder is not a well-known name (caller should fall back to Graph POST).
 */
/**
 * Generate a synthetic RFC 2822 Message-ID.
 * Format: <timestamp.random@domain> — unique per call, deterministic-looking.
 */
function generateMessageId(userId) {
  const domain    = (userId || 'qatestagent.com').split('@')[1] || 'qatestagent.com';
  const ts        = Date.now().toString(36);
  const rand      = Math.random().toString(36).slice(2, 8);
  return `<${ts}.${rand}@${domain}>`;
}

async function createMessageViaEws(userId, folderId, messageBody) {
  const folderKey        = String(folderId).trim().toLowerCase();
  const ewsFolderId      = EWS_FOLDER_MAP[folderKey];
  if (!ewsFolderId) return null; // custom folder — caller handles separately

  const savedItemFolderXml = `<t:DistinguishedFolderId Id="${ewsFolderId}">
          <t:Mailbox><t:EmailAddress>${xmlEsc(userId)}</t:EmailAddress></t:Mailbox>
        </t:DistinguishedFolderId>`;

  const tenant = getMsTenant(userId);
  const token  = await getEwsToken(tenant);
  const now    = new Date().toISOString();

  const isRead      = messageBody.isRead !== false;
  const msgFlagVal  = isRead ? 1 : 0; // 0x1=MSGFLAG_READ; 0x8=MSGFLAG_UNSENT cleared
  const receivedDt  = messageBody.receivedDateTime || now;
  const sentDt      = messageBody.sentDateTime     || now;

  // Message-ID: use caller-supplied or generate a fresh unique one.
  // PR_INTERNET_MESSAGE_ID (0x1035) — used by migration tools for deduplication
  // and by Exchange for thread linking (In-Reply-To / References).
  const messageId  = messageBody.internetMessageId || generateMessageId(userId);
  const inReplyTo  = messageBody.inReplyTo  || '';   // PR_IN_REPLY_TO_ID  (0x1042)
  const references = messageBody.references || '';   // PR_INTERNET_REFERENCES (0x1039)

  const bodyType    = (messageBody.body?.contentType || 'text').toLowerCase() === 'html' ? 'HTML' : 'Text';
  const bodyContent = messageBody.body?.content || '';
  // HTML must be wrapped in CDATA so the XML parser treats it as character data, not
  // XML child elements — otherwise Exchange reads the <t:Body> text node as empty.
  const bodyXml     = bodyType === 'HTML'
    ? `<t:Body BodyType="HTML"><![CDATA[${bodyContent}]]></t:Body>`
    : `<t:Body BodyType="Text">${xmlEsc(bodyContent)}</t:Body>`;

  const importanceMap = { low: 'Low', normal: 'Normal', high: 'High' };
  const importance  = importanceMap[(messageBody.importance || 'normal').toLowerCase()] || 'Normal';

  const fromXml   = messageBody.from   ? `<t:From>${ewsMailboxXml(messageBody.from)}</t:From>`                       : '';
  const senderXml = (messageBody.sender || messageBody.from)
    ? `<t:Sender>${ewsMailboxXml(messageBody.sender || messageBody.from)}</t:Sender>` : '';

  const toXml  = ewsRecipientsXml('ToRecipients', messageBody.toRecipients);
  const ccXml  = ewsRecipientsXml('CcRecipients', messageBody.ccRecipients);
  const bccXml = ewsRecipientsXml('BccRecipients', messageBody.bccRecipients);

  const catXml = Array.isArray(messageBody.categories) && messageBody.categories.length
    ? `<t:Categories>${messageBody.categories.map((c) => `<t:String>${xmlEsc(c)}</t:String>`).join('')}</t:Categories>` : '';

  let flagXml = '';
  const flagStatus = messageBody.flag?.flagStatus;
  if (flagStatus === 'flagged')  flagXml = '<t:Flag><t:FlagStatus>Flagged</t:FlagStatus></t:Flag>';
  else if (flagStatus === 'complete') flagXml = '<t:Flag><t:FlagStatus>Complete</t:FlagStatus></t:Flag>';

  const attachXml = ewsAttachmentsXml(messageBody.attachments);

  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016"/>
    <t:ExchangeImpersonation>
      <t:ConnectingSID><t:PrimarySmtpAddress>${xmlEsc(userId)}</t:PrimarySmtpAddress></t:ConnectingSID>
    </t:ExchangeImpersonation>
  </soap:Header>
  <soap:Body>
    <m:CreateItem MessageDisposition="SaveOnly">
      <m:SavedItemFolderId>
        ${savedItemFolderXml}
      </m:SavedItemFolderId>
      <m:Items>
        <t:Message>
          <t:Subject>${xmlEsc(messageBody.subject || '')}</t:Subject>
          ${bodyXml}
          <t:Importance>${importance}</t:Importance>
          <t:IsRead>${isRead}</t:IsRead>
          ${fromXml}
          ${senderXml}
          ${toXml}
          ${ccXml}
          ${bccXml}
          ${catXml}
          ${flagXml}
          ${attachXml}
          <t:ExtendedProperty>
            <t:ExtendedFieldURI PropertyTag="0x0E07" PropertyType="Integer"/>
            <t:Value>${msgFlagVal}</t:Value>
          </t:ExtendedProperty>
          <t:ExtendedProperty>
            <t:ExtendedFieldURI PropertyTag="0x0E06" PropertyType="SystemTime"/>
            <t:Value>${receivedDt}</t:Value>
          </t:ExtendedProperty>
          <t:ExtendedProperty>
            <t:ExtendedFieldURI PropertyTag="0x0039" PropertyType="SystemTime"/>
            <t:Value>${sentDt}</t:Value>
          </t:ExtendedProperty>
          <t:ExtendedProperty>
            <t:ExtendedFieldURI PropertyTag="0x1035" PropertyType="String"/>
            <t:Value>${xmlEsc(messageId)}</t:Value>
          </t:ExtendedProperty>
          ${inReplyTo  ? `<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x1042" PropertyType="String"/><t:Value>${xmlEsc(inReplyTo)}</t:Value></t:ExtendedProperty>` : ''}
          ${references ? `<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x1039" PropertyType="String"/><t:Value>${xmlEsc(references)}</t:Value></t:ExtendedProperty>` : ''}
        </t:Message>
      </m:Items>
    </m:CreateItem>
  </soap:Body>
</soap:Envelope>`;

  const res = await axios.post(EWS_ENDPOINT, soap, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: '"http://schemas.microsoft.com/exchange/services/2006/messages/CreateItem"',
    },
    timeout: 60000,
  });

  if (!String(res.data).includes('NoError')) {
    const errMatch = String(res.data).match(/<m:MessageText>([^<]+)<\/m:MessageText>/);
    throw new Error(`EWS CreateItem: ${errMatch?.[1] || String(res.data).substring(0, 200)}`);
  }

  return { isDraft: false, subject: messageBody.subject, internetMessageId: messageId };
}

/**
 * Clear MSGFLAG_UNSENT on an existing message so it appears as isDraft=false.
 * Uses EWS UpdateItem on the Graph message ID (Exchange uses the same ID format).
 * flagVal: 1 = MSGFLAG_READ (read non-draft), 0 = unread non-draft.
 */
async function ewsClearDraftFlag(userId, graphMessageId, flagVal = 1) {
  const tenant = getMsTenant(userId);
  const token  = await getEwsToken(tenant);
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016"/>
    <t:ExchangeImpersonation>
      <t:ConnectingSID><t:PrimarySmtpAddress>${xmlEsc(userId)}</t:PrimarySmtpAddress></t:ConnectingSID>
    </t:ExchangeImpersonation>
  </soap:Header>
  <soap:Body>
    <m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">
      <m:ItemChanges>
        <t:ItemChange>
          <t:ItemId Id="${xmlEsc(graphMessageId)}"/>
          <t:Updates>
            <t:SetItemField>
              <t:ExtendedFieldURI PropertyTag="0x0E07" PropertyType="Integer"/>
              <t:Message>
                <t:ExtendedProperty>
                  <t:ExtendedFieldURI PropertyTag="0x0E07" PropertyType="Integer"/>
                  <t:Value>${flagVal}</t:Value>
                </t:ExtendedProperty>
              </t:Message>
            </t:SetItemField>
          </t:Updates>
        </t:ItemChange>
      </m:ItemChanges>
    </m:UpdateItem>
  </soap:Body>
</soap:Envelope>`;
  const res = await axios.post(EWS_ENDPOINT, soap, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: '"http://schemas.microsoft.com/exchange/services/2006/messages/UpdateItem"',
    },
    timeout: 30000,
  });
  if (!String(res.data).includes('NoError')) {
    const errMatch = String(res.data).match(/<m:MessageText>([^<]+)<\/m:MessageText>/);
    throw new Error(`EWS UpdateItem: ${errMatch?.[1] || String(res.data).substring(0, 200)}`);
  }
}

// ─── End EWS message injection helpers ───────────────────────────────────────

/**
 * Find the Graph message ID for a message that was just injected via EWS.
 * Searches in `folder` (well-known name or Graph folder ID) by internetMessageId.
 * Retries up to `retries` times with `delayMs` between attempts.
 * Returns the Graph message id string, or null if not found.
 */
async function getGraphIdByInternetMessageId(userId, folder, internetMessageId, { retries = 4, delayMs = 1500 } = {}) {
  if (!internetMessageId) return null;
  const uid     = graphUserPath(userId);
  const token   = await getAccessToken(userId);
  const safeMid = internetMessageId.replace(/'/g, "''");
  for (let i = 0; i < retries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await axios.get(
        `${GRAPH_BASE}/users/${uid}/mailFolders/${encodeURIComponent(folder)}/messages` +
        `?$filter=${encodeURIComponent(`internetMessageId eq '${safeMid}'`)}&$select=id&$top=1`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      const id = (res.data?.value || [])[0]?.id;
      if (id) return id;
    } catch (_) { /* ignore transient errors */ }
  }
  return null;
}

/**
 * Create a message directly in a mail folder without triggering Exchange delivery.
 *
 * Uses EWS CreateItem with SaveOnly + PR_MESSAGE_FLAGS=0 so the message appears as a
 * real received/sent email (isDraft=false) for ALL folders — well-known (inbox, sentitems,
 * deleteditems, junkemail, archive) and custom folders alike.
 *
 * Falls back to Graph POST only when EWS fails entirely (network error, auth failure).
 */
async function createMessageInFolder(userId, folderId, messageBody) {
  const folderKey   = String(folderId).trim().toLowerCase();
  const isDraftFolder = folderKey === 'drafts' || folderKey === 'draft' || messageBody.isDraft === true;

  if (!isDraftFolder) {
    try {
      const result = await createMessageViaEws(userId, folderId, messageBody);
      if (result !== null) return result; // well-known EWS folder handled it
    } catch (ewsErr) {
      logger.warn(`[EWS insert ${userId}] ${ewsErr.message} — falling back to Graph POST`);
    }

    // Custom folder: EWS can't accept Graph folder IDs directly.
    // Strategy: inject into inbox via EWS (isDraft=false guaranteed), then move via Graph.
    if (EWS_FOLDER_MAP[folderKey] === undefined) {
      try {
        const msgId = messageBody.internetMessageId || generateMessageId(userId);
        // Strip attachments from the EWS inject — upload them to the moved message separately
        // to avoid Exchange locking the message while it processes inline attachment data.
        const hasAttachments = Array.isArray(messageBody.attachments) && messageBody.attachments.length > 0;
        await createMessageViaEws(userId, 'inbox', {
          ...messageBody,
          attachments: undefined,
          internetMessageId: msgId,
        });

        // Retry-aware lookup: Exchange may take a moment to index the new message
        const graphMsgId = await getGraphIdByInternetMessageId(userId, 'inbox', msgId, {
          retries: 4, delayMs: 2000,
        });
        if (!graphMsgId) throw new Error('Message not found in inbox after EWS inject (4 retries)');

        // Move to the custom target folder
        const token2 = await getAccessToken(userId);
        const uid2   = graphUserPath(userId);
        const moveRes = await axios.post(
          `${GRAPH_BASE}/users/${uid2}/messages/${graphMsgId}/move`,
          { destinationId: folderId },
          { headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        const movedId = moveRes.data?.id;

        // Upload attachments to the moved message if any
        if (hasAttachments && movedId) {
          for (const att of messageBody.attachments) {
            try {
              await axios.post(
                `${GRAPH_BASE}/users/${uid2}/messages/${movedId}/attachments`,
                att,
                { headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' }, timeout: 30000 }
              );
            } catch (attErr) {
              logger.warn(`[EWS+move attach ${userId}] ${att.name || 'att'}: ${attErr.message}`);
            }
          }
        }

        return { isDraft: false, subject: messageBody.subject, internetMessageId: msgId, id: movedId };
      } catch (customErr) {
        logger.warn(`[EWS+move ${userId}/${folderId}] ${customErr.message} — falling back to Graph POST`);
      }
    }
  }

  // Graph POST fallback (drafts folder or EWS+move failure)
  const uid   = graphUserPath(userId);
  const token = await getAccessToken(userId);
  const body  = { ...messageBody };
  if (!isDraftFolder) {
    const now = new Date().toISOString();
    body.receivedDateTime = body.receivedDateTime || now;
    body.sentDateTime     = body.sentDateTime     || now;
    if (!body.sender && body.from) body.sender = body.from;
  }
  const res = await axios.post(
    `${GRAPH_BASE}/users/${uid}/mailFolders/${encodeURIComponent(folderId)}/messages`,
    body,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  const created = res.data;
  const patch = {};
  if (messageBody.flag)                                                         patch.flag       = messageBody.flag;
  if (messageBody.importance && messageBody.importance !== 'normal')            patch.importance = messageBody.importance;
  if (Array.isArray(messageBody.categories) && messageBody.categories.length)  patch.categories = messageBody.categories;
  if (Object.keys(patch).length > 0 && created.id) {
    await axios.patch(
      `${GRAPH_BASE}/users/${uid}/messages/${created.id}`,
      patch,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
  }
  return created;
}

/**
 * Best-effort count of contacts in a user's Graph /users/{id}/contacts.
 * Uses $count with `ConsistencyLevel: eventual`; falls back to paging if $count is rejected.
 * Returns { count, available, note? }.
 */
async function getContactsCount(userId) {
  const uid = graphUserPath(userId);
  try {
    const token = await getAccessToken(userId);
    const res = await axios.get(`${GRAPH_BASE}/users/${uid}/contacts/$count`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ConsistencyLevel: 'eventual',
        'Content-Type': 'text/plain',
      },
      timeout: 15000,
    });
    const n = Number(res.data);
    if (Number.isFinite(n)) return { count: n, available: true };
  } catch (e) {
    // fall through to paged enumeration
  }
  try {
    const token = await getAccessToken(userId);
    let url = `${GRAPH_BASE}/users/${uid}/contacts?$top=999&$select=id`;
    let count = 0;
    for (let page = 0; page < 20; page++) {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
      });
      count += (res.data?.value || []).length;
      const next = res.data?.['@odata.nextLink'];
      if (!next) break;
      url = next;
    }
    return { count, available: true };
  } catch (e) {
    const msg = String(e?.message || e);
    return {
      count: 0,
      available: false,
      note: `Outlook contacts fetch failed: ${msg.substring(0, 160)}`,
    };
  }
}

// ── Test data creation helpers ────────────────────────────────────────────────

async function createContact(userId, contact) {
  const uid = graphUserPath(userId);
  const res = await graphPost(`${GRAPH_BASE}/users/${uid}/contacts`, contact, userId);
  return res.data;
}

async function createCalendarEvent(userId, calendarId, event) {
  const uid = graphUserPath(userId);
  const url = calendarId
    ? `${GRAPH_BASE}/users/${uid}/calendars/${encodeURIComponent(calendarId)}/events`
    : `${GRAPH_BASE}/users/${uid}/events`;
  const res = await graphPost(url, event, userId);
  return res.data;
}

async function getOrCreateCalendar(userId, name) {
  const cals = await getCalendars(userId);
  const existing = cals.find((c) => c.name?.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const token = await getAccessToken(userId);
  const uid = graphUserPath(userId);
  const res = await axios.post(
    `${GRAPH_BASE}/users/${uid}/calendars`,
    { name },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return res.data;
}

async function shareCalendar(userId, calendarId, recipientEmail, role = 'write') {
  const uid = graphUserPath(userId);
  const url = `${GRAPH_BASE}/users/${uid}/calendars/${encodeURIComponent(calendarId)}/calendarPermissions`;
  const res = await graphPost(url, {
    isRemovable: true,
    isInsideOrganization: true,
    role,
    emailAddress: { address: recipientEmail },
  }, userId);
  return res.data;
}

async function createGroup(displayName, mailNickname, description = '', isPrivate = false, userId = null) {
  const tenant = getMsTenant(userId || '');
  const token = await getAppAccessToken(tenant);
  const res = await retryWithBackoff(
    () => axios.post(
      `${GRAPH_BASE}/groups`,
      {
        displayName,
        mailNickname: (mailNickname || displayName.replace(/\s+/g, '').toLowerCase()).substring(0, 64),
        description,
        groupTypes: ['Unified'],
        mailEnabled: true,
        securityEnabled: false,
        visibility: isPrivate ? 'Private' : 'Public',
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    ),
    { label: `Graph POST /groups (${displayName})`, maxRetries: 2 }
  );
  return res.data;
}

/**
 * Count Microsoft 365 Groups in the tenant (app-only token).
 * @param {string} userId - any user in the target tenant (used to pick credentials)
 * @returns {Promise<{ count: number, available: boolean, note?: string }>}
 */
async function getGroupsCount(userId = '') {
  try {
    const tenant = getMsTenant(userId);
    const token  = await getAppAccessToken(tenant);
    let count = 0;
    let url   = `${GRAPH_BASE}/groups?$select=id&$top=999`;
    for (let page = 0; page < 20; page++) {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
      });
      count += (res.data.value || []).length;
      url = res.data['@odata.nextLink'];
      if (!url) break;
    }
    return { count, available: true };
  } catch (e) {
    const msg = String(e?.message || e);
    return {
      count: 0,
      available: false,
      note: `Groups count failed: ${msg.substring(0, 160)}`,
    };
  }
}

/**
 * Creates a message in a folder and attaches a large file via upload session.
 * Handles files >3MB (Graph API limit for inline attachments).
 * sizeMB: desired file size in megabytes (e.g. 26).
 */
/**
 * Create a message with a large (>3 MB) attachment using the Graph upload-session API.
 *
 * Flow (primary):
 *   1. Create a draft in the SENDER's mailbox (not in the recipient's folder — avoids isDraft issue)
 *   2. Create an upload session on that draft and upload the file in 4 MB chunks
 *   3. Send the draft → Exchange delivers it to the recipient's Inbox
 *   4. Find the delivered message in the recipient's Inbox
 *   5. Move to the target folder if it isn't Inbox; patch isRead
 *
 * Fallback (if upload session or send fails):
 *   Send via sendMailAsUser with a referenceAttachment (link) so the message is still
 *   a real non-draft in the Inbox — it won't have a binary attachment but the subject
 *   and link name reflect the intended size.
 */
async function createMessageWithLargeAttachment(userId, folderId, messageBody, fileName, sizeMB = 26) {
  const recipientToken = await getAppAccessToken(getMsTenant(userId));
  const recipientUid   = graphUserPath(userId);
  const sizeBytes      = sizeMB * 1024 * 1024;

  let draftId = null;

  try {
    // ── Step 1: create draft directly in recipient's mailbox (no send) ──────
    const draftRes = await axios.post(
      `${GRAPH_BASE}/users/${recipientUid}/messages`,
      {
        subject:      messageBody.subject,
        body:         messageBody.body,
        from:         messageBody.from,
        toRecipients: messageBody.toRecipients || [],
        importance:   messageBody.importance   || 'normal',
      },
      { headers: { Authorization: `Bearer ${recipientToken}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    draftId = draftRes.data.id;

    // ── Step 2: create upload session on the draft ──────────────────────────
    const sessionRes = await axios.post(
      `${GRAPH_BASE}/users/${recipientUid}/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`,
      { AttachmentItem: { attachmentType: 'file', name: fileName, size: sizeBytes } },
      { headers: { Authorization: `Bearer ${recipientToken}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const uploadUrl = sessionRes.data.uploadUrl;

    // ── Step 3: upload in 4 MB chunks ───────────────────────────────────────
    const chunkSize = 4 * 1024 * 1024;
    const pattern   = Buffer.from('QA Migration Large Attachment Test Data — CloudFuze QA Agent\n');
    let offset = 0;
    while (offset < sizeBytes) {
      const end      = Math.min(offset + chunkSize - 1, sizeBytes - 1);
      const chunkLen = end - offset + 1;
      const chunk    = Buffer.alloc(chunkLen);
      for (let i = 0; i < chunkLen; i++) chunk[i] = pattern[i % pattern.length];
      await axios.put(uploadUrl, chunk, {
        headers: {
          'Content-Length': chunkLen,
          'Content-Range': `bytes ${offset}-${end}/${sizeBytes}`,
          'Content-Type': 'application/octet-stream',
        },
        timeout: 120000,
        maxBodyLength: chunkSize + 1024,
      });
      offset = end + 1;
    }

    // ── Step 4: move draft to target folder, capture new message ID ─────────
    const targetFolder = folderId || 'inbox';
    let movedId = draftId;
    if (targetFolder !== 'drafts' && targetFolder !== 'draft') {
      const moveRes = await axios.post(
        `${GRAPH_BASE}/users/${recipientUid}/messages/${encodeURIComponent(draftId)}/move`,
        { destinationId: targetFolder },
        { headers: { Authorization: `Bearer ${recipientToken}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      movedId = moveRes.data?.id || draftId;
    }

    // ── Step 5: clear MSGFLAG_UNSENT via Graph extended property → isDraft=false ─
    // EWS UpdateItem requires an EWS item ID; movedId is a Graph REST ID, so use
    // Graph singleValueExtendedProperties PATCH to set PR_MESSAGE_FLAGS directly.
    const isRead = messageBody.isRead !== false;
    try {
      await axios.patch(
        `${GRAPH_BASE}/users/${recipientUid}/messages/${encodeURIComponent(movedId)}`,
        { singleValueExtendedProperties: [{ id: 'Integer 0x0e07', value: String(isRead ? 1 : 0) }] },
        { headers: { Authorization: `Bearer ${recipientToken}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      logger.info(`createMessageWithLargeAttachment: ${sizeMB} MB attachment in ${targetFolder} (isDraft cleared via Graph PATCH)`);
    } catch (clearErr) {
      logger.warn(`createMessageWithLargeAttachment: clear-draft PATCH failed (${clearErr.message})`);
    }
    return { id: movedId };

  } catch (err) {
    logger.warn(`createMessageWithLargeAttachment: ${err.message}`);
    if (draftId) {
      try {
        await axios.delete(
          `${GRAPH_BASE}/users/${recipientUid}/messages/${encodeURIComponent(draftId)}`,
          { headers: { Authorization: `Bearer ${recipientToken}` }, timeout: 15000 }
        );
      } catch (_) { /* ignore */ }
    }
    return null;
  }
}

/**
 * Create an Outlook inbox message rule via Graph API.
 * Rules are evaluated when new mail ARRIVES through Exchange transport (not on direct API inserts).
 *
 * @param {string} userId
 * @param {string} displayName   — visible rule name in Outlook → Manage Rules
 * @param {object} conditions    — e.g. { senderContains: ['user@domain.com'] }
 * @param {object} actions       — e.g. { moveToFolder: 'folderId' }
 * @param {number} [sequence=1] — rule evaluation order (1 = highest priority)
 */
async function createMessageRule(userId, displayName, conditions, actions, sequence = 1) {
  const uid = graphUserPath(userId);
  const res = await graphPost(
    `${GRAPH_BASE}/users/${uid}/mailFolders/inbox/messageRules`,
    { displayName, sequence, isEnabled: true, conditions, actions },
    userId
  );
  return res.data;
}

async function listMessageRules(userId) {
  const res = await graphGet(
    `${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/inbox/messageRules`,
    userId
  );
  return res.data.value || [];
}

async function deleteMessageRule(userId, ruleId) {
  return graphDelete(
    `${GRAPH_BASE}/users/${graphUserPath(userId)}/mailFolders/inbox/messageRules/${encodeURIComponent(ruleId)}`,
    userId
  );
}

/**
 * Send an email as a specific mailbox user via Graph sendMail endpoint.
 * Unlike createMessageInFolder (direct folder insert), this goes through Exchange transport,
 * which triggers inbox rules on the recipient side.
 * Requires Mail.Send (Application) permission on the Azure AD app.
 */
async function sendMailAs(senderEmail, toEmail, subject, textBody) {
  const token = await getAccessToken(senderEmail);
  const uid = graphUserPath(senderEmail);
  await retryWithBackoff(
    () => axios.post(
      `${GRAPH_BASE}/users/${uid}/sendMail`,
      {
        message: {
          subject,
          body: { contentType: 'Text', content: textBody },
          toRecipients: [{ emailAddress: { address: toEmail } }],
        },
        saveToSentItems: false,
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    ),
    { label: `Graph sendMail (${senderEmail} → ${toEmail})`, maxRetries: 1 }
  );
}

/**
 * Create a chain of nested mail folders (parent → child → grandchild … ).
 * folderNames is an ordered array of display names, outermost first.
 * Returns an array of folder IDs, one per level (same order as input).
 * If a folder at a given level already exists it is reused.
 */
async function createNestedFolderChain(userId, folderNames) {
  const token = await getAccessToken(userId);
  const uid   = graphUserPath(userId);
  let parentId = null;
  const folderIds = [];

  for (const displayName of folderNames) {
    const baseUrl = parentId
      ? `${GRAPH_BASE}/users/${uid}/mailFolders/${parentId}/childFolders`
      : `${GRAPH_BASE}/users/${uid}/mailFolders`;
    let folderId;
    try {
      const res = await axios.post(
        baseUrl, { displayName },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      folderId = res.data.id;
    } catch (err) {
      if (err.response?.status === 409) {
        const listRes = await axios.get(
          `${baseUrl}?$filter=${encodeURIComponent(`displayName eq '${displayName}'`)}&$select=id,displayName`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
        );
        folderId = (listRes.data.value || [])[0]?.id;
        if (!folderId) throw new Error(`Folder "${displayName}" already exists but could not be located`);
      } else {
        throw err;
      }
    }
    folderIds.push(folderId);
    parentId = folderId;
  }
  return folderIds;
}

/**
 * Create a properly threaded 3-message email exchange that shares one ConversationId.
 *
 *  Msg 1: senderEmail → recipientEmail   (sendMail → in recipient's Inbox)
 *  Msg 2: recipientEmail → senderEmail   (createReply + send → in recipient's Sent Items)
 *  Msg 3: senderEmail → recipientEmail   (createReply on msg2 + send → in recipient's Inbox)
 *
 * All 3 carry the same ConversationId and appear as a single conversation in Outlook.
 * senderEmail must be a real tenant user (needs Mail.Send.All + Mail.ReadWrite.All on the app).
 *
 * @param {string}   senderEmail      Tenant user who starts the thread
 * @param {string}   recipientEmail   Source mailbox (the migration source)
 * @param {string}   subject          Thread subject (no "Re:" prefix)
 * @param {string[]} bodies           [originalBody, reply1Body, reply2Body]
 * @returns {Promise<number>}         Messages created (3 on full success)
 */
async function createEmailThread(senderEmail, recipientEmail, subject, bodies) {
  const sndUid   = graphUserPath(senderEmail);
  const rcpUid   = graphUserPath(recipientEmail);
  const sndToken = await getAppAccessToken(getMsTenant(senderEmail));
  const rcpToken = await getAppAccessToken(getMsTenant(recipientEmail));

  // ── Msg 1: sender → recipient ─────────────────────────────────────────────
  await sendMailAsUser(senderEmail, {
    subject,
    body:         { contentType: 'text', content: bodies[0] },
    toRecipients: [{ emailAddress: { address: recipientEmail, name: recipientEmail.split('@')[0] } }],
  }, false);
  const msg1Id = await findDeliveredInboxMessage(recipientEmail, subject, senderEmail);
  if (!msg1Id) throw new Error(`Thread: msg1 "${subject}" not found in ${recipientEmail} inbox`);

  // ── Msg 2: recipient createReply → send to sender ─────────────────────────
  const draft2 = await axios.post(
    `${GRAPH_BASE}/users/${rcpUid}/messages/${msg1Id}/createReply`,
    { comment: bodies[1] },
    { headers: { Authorization: `Bearer ${rcpToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  await axios.post(
    `${GRAPH_BASE}/users/${rcpUid}/messages/${draft2.data.id}/send`,
    {},
    { headers: { Authorization: `Bearer ${rcpToken}` }, timeout: 15000 }
  );
  // Find reply in sender's inbox (delivered from recipient)
  const replySubject  = `Re: ${subject}`;
  const msg2InSender  = await findDeliveredInboxMessage(senderEmail, replySubject, recipientEmail);
  if (!msg2InSender) throw new Error(`Thread: msg2 "${replySubject}" not found in ${senderEmail} inbox`);

  // ── Msg 3: sender createReply → send back to recipient ────────────────────
  const draft3 = await axios.post(
    `${GRAPH_BASE}/users/${sndUid}/messages/${msg2InSender}/createReply`,
    { comment: bodies[2] },
    { headers: { Authorization: `Bearer ${sndToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  await axios.post(
    `${GRAPH_BASE}/users/${sndUid}/messages/${draft3.data.id}/send`,
    {},
    { headers: { Authorization: `Bearer ${sndToken}` }, timeout: 15000 }
  );

  return 3;
}

/**
 * Create an Outlook inbox rule on userId's mailbox.
 * Requires MailboxSettings.ReadWrite application permission on the Azure AD app.
 *
 * Minimal rule shape:
 *   {
 *     displayName: 'QA - …',
 *     sequence: 100,
 *     isEnabled: true,
 *     conditions: { from: [{ emailAddress: { address: '…', name: '…' } }] },
 *     actions:    { moveToFolder: '<folderId>', stopProcessingRules: true }
 *   }
 */
async function createInboxRule(userId, rule) {
  const token = await getAppAccessToken(getMsTenant(userId));
  const uid   = graphUserPath(userId);
  const res   = await axios.post(
    `${GRAPH_BASE}/users/${uid}/mailFolders/inbox/messageRules`,
    rule,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return res.data;
}

/**
 * Create a child folder under parentFolderId. Returns the child folder ID.
 * Reuses the folder if it already exists (409).
 */
async function moveMessageToFolder(userId, messageId, destinationFolderId) {
  const token = await getAccessToken(userId);
  const uid = encodeURIComponent(String(userId).trim());
  const axios = require('axios');
  const res = await axios.post(
    `${GRAPH_BASE}/users/${uid}/messages/${encodeURIComponent(messageId)}/move`,
    { destinationId: destinationFolderId },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return res.data;
}

async function createChildFolder(userId, parentFolderId, displayName) {
  const token  = await getAccessToken(userId);
  const uid    = graphUserPath(userId);
  const url    = `${GRAPH_BASE}/users/${uid}/mailFolders/${parentFolderId}/childFolders`;
  try {
    const res = await axios.post(
      url, { displayName },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return res.data.id;
  } catch (err) {
    if (err.response?.status === 409) {
      const listRes = await axios.get(
        `${url}?$filter=${encodeURIComponent(`displayName eq '${displayName}'`)}&$select=id,displayName`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      const found = (listRes.data.value || [])[0];
      if (found) return found.id;
    }
    throw err;
  }
}

/**
 * Create a top-level mail folder if it doesn't already exist. Returns the folder ID.
 */
async function getOrCreateMailFolder(userId, displayName) {
  const folders = await getMailFolders(userId);
  const existing = folders.find((f) => f.displayName.toLowerCase() === displayName.toLowerCase());
  if (existing) return existing.id;
  const token = await getAccessToken(userId);
  const uid = graphUserPath(userId);
  const res = await axios.post(
    `${GRAPH_BASE}/users/${uid}/mailFolders`,
    { displayName },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    }
  );
  return res.data.id;
}

async function getContactsWithDetails(userId) {
  const uid = graphUserPath(userId);
  try {
    const token = await getAccessToken(userId);
    const select = 'id,displayName,givenName,surname,emailAddresses,businessPhones,mobilePhone,companyName,jobTitle,personalNotes';
    let url = `${GRAPH_BASE}/users/${uid}/contacts?$top=100&$select=${select}`;
    const contacts = [];
    for (let page = 0; page < 10; page++) {
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
      contacts.push(...(res.data.value || []));
      url = res.data['@odata.nextLink'];
      if (!url) break;
    }
    return { contacts, available: true };
  } catch (e) {
    return { contacts: [], available: false, note: `getContactsWithDetails failed: ${String(e.message).substring(0, 160)}` };
  }
}

async function setContactPhoto(userId, contactId, photoBase64) {
  const uid = graphUserPath(userId);
  const token = await getAccessToken(userId);
  const buf = Buffer.from(photoBase64, 'base64');
  await axios.put(
    `${GRAPH_BASE}/users/${uid}/contacts/${contactId}/photo/$value`,
    buf,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, timeout: 15000 }
  );
}

async function getInboxRules(userId) {
  const uid = graphUserPath(userId);
  try {
    const token = await getAccessToken(userId);
    const res = await axios.get(
      `${GRAPH_BASE}/users/${uid}/mailFolders/inbox/messageRules`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    return { rules: res.data.value || [], available: true };
  } catch (e) {
    return { rules: [], available: false, note: `Inbox rules fetch failed: ${String(e.message).substring(0, 120)}` };
  }
}

async function addEventAttachment(userId, eventId, attachment) {
  const uid = graphUserPath(userId);
  const res = await graphPost(`${GRAPH_BASE}/users/${uid}/events/${eventId}/attachments`, attachment, userId);
  return res.data;
}

/**
 * Sum all message sizes in a mailbox via paginated GET /messages?$select=size.
 * Returns { sizeBytes, messageCount, method }.
 */
async function getMailboxSizeBytes(userId) {
  const uid = graphUserPath(userId);
  let url = `${GRAPH_BASE}/users/${uid}/messages?$select=size&$top=999`;
  let totalBytes = 0;
  let messageCount = 0;
  while (url) {
    const res = await graphGet(url, userId);
    for (const msg of (res.data.value || [])) {
      totalBytes += Number(msg.size) || 0;
      messageCount++;
    }
    url = res.data['@odata.nextLink'] || null;
  }
  return { sizeBytes: totalBytes, messageCount, method: 'graph_messages_size' };
}

module.exports = {
  getAccessToken,
  getMailFolders,
  getMailFolderPathString,
  getAllFoldersFlat,
  getTotalMessageCount,
  getMessages,
  getMessageCount,
  getMessageById,
  findMessagesByInternetMessageId,
  findBestMessageBySubjectAndTime,
  resolveDestinationByInternetMessageId,
  stripAngleBrackets,
  internetMessageIdsEqual,
  listMessagesInFolderPaged,
  MESSAGE_SELECT_DEEP,
  getCalendars,
  getEvents,
  getEventCount,
  getAttachments,
  listUsers,
  hasMailbox,
  filterMailboxEnabled,
  DEFAULT_FOLDER_NAMES,
  sendMailAsUser,
  createEmailThread,
  createInboxRule,
  createMessageInFolder,
  createNestedFolderChain,
  createChildFolder,
  getOrCreateMailFolder,
  getContactsCount,
  emptyFolderViaApi,
  deleteAllMessagesInFolder,
  deleteFolder,
  deleteAllEventsInCalendar,
  deleteCalendar,
  getRecoverableItemsCount,
  cleanRecoverableItems,
  cleanMailbox,
  cleanOutlookEmailsOnly,
  cleanOutlookFoldersOnly,
  cleanOutlookEventsOnly,
  createContact,
  createCalendarEvent,
  getOrCreateCalendar,
  shareCalendar,
  createGroup,
  getGroupsCount,
  createMessageWithLargeAttachment,
  deleteMessageRule,
  moveMessageToFolder,
  getGraphIdByInternetMessageId,
  clearFolderCache,
  getContactsWithDetails,
  setContactPhoto,
  getInboxRules,
  addEventAttachment,
  getMailboxSizeBytes,
};
