const axios = require('axios');
const logger = require('../utils/logger');

const BOX_API = 'https://api.box.com/2.0';
const BOX_UPLOAD = 'https://upload.box.com/api/2.0';
const BOX_TOKEN_URL = 'https://api.box.com/oauth2/token';

// ─── Multipart builder (no external form-data dependency) ────────────────────

function buildMultipart(attributes, filename, fileBuffer) {
  const boundary = `BoxBoundary${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const nl = '\r\n';
  const attrPart = Buffer.from(
    `--${boundary}${nl}Content-Disposition: form-data; name="attributes"${nl}${nl}${JSON.stringify(attributes)}${nl}`
  );
  const fileHeader = Buffer.from(
    `--${boundary}${nl}Content-Disposition: form-data; name="file"; filename="${filename}"${nl}Content-Type: application/octet-stream${nl}${nl}`
  );
  const end = Buffer.from(`${nl}--${boundary}--${nl}`);
  return {
    body: Buffer.concat([attrPart, fileHeader, fileBuffer, end]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ─── Token management ─────────────────────────────────────────────────────────

// Cached Client Credentials Grant (server auth) enterprise token.
let ccgToken = null; // { token, expiresAt }

// In-flight OAuth refresh promises, keyed by lower-cased email. Box refresh tokens are
// SINGLE-USE: each refresh rotates the token and invalidates the old one. Without this lock,
// a burst of concurrent Box calls would each POST a refresh with the same token — Box accepts
// one and rejects the rest with 400 invalid_grant, permanently killing the refresh token (the
// "must reconnect daily" symptom). Concurrent callers share one refresh and one rotation.
const boxRefreshLocks = new Map(); // email → Promise<string>

/**
 * Refresh a Box OAuth token, serialized per account. Re-reads the latest stored token first
 * (another caller may have just refreshed), then rotates exactly once and persists the new pair.
 *
 * `boxRefreshLocks` only serializes callers WITHIN THIS PROCESS. Box's refresh token is single-use
 * and rotates on redemption (confirmed live 2026-09-15) — the same failure mode this repo already
 * documents for Dropbox — but unlike a single long-running server, this repo routinely has SEVERAL
 * separate `node` processes touching the same account at once: the backend server plus any number of
 * one-off diagnostic/seeding scripts. Two processes racing to redeem the SAME stored refresh token
 * both send it to Box; Box honours the first and 400s the second with invalid_grant, and the losing
 * process's in-process lock does nothing to prevent that because it has no idea the other process
 * exists. Measured directly: repeated `OAuth refresh failed … 400` errors while a hand-run diagnostic
 * script and the running server were both calling `getValidToken` around the same time.
 *
 * The fix is not a cross-process mutex (a real one needs a shared lock service this repo doesn't
 * have) — it is to make LOSING the race recoverable: on a 400, wait briefly and re-read the shared
 * token store once more. If another process won the race and already rotated the token, its result
 * is sitting there now, and the loser can just use it instead of surfacing a failure that was never
 * really an expired/invalid credential — only a redemption that arrived a few hundred milliseconds
 * late.
 */
async function refreshBoxToken(email, tokenStore) {
  const key = String(email).toLowerCase();
  if (boxRefreshLocks.has(key)) return boxRefreshLocks.get(key);

  const p = (async () => {
    // A concurrent caller (in this process, or another one) may have refreshed already.
    const latest = tokenStore.getBoxToken(email);
    if (latest?.accessToken && latest.expiresAt && Date.now() < latest.expiresAt - 60_000) {
      return latest.accessToken;
    }
    const refreshToken = latest?.refreshToken;
    if (!refreshToken) throw new Error('no refresh token');
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.BOX_CLIENT_ID,
      client_secret: process.env.BOX_CLIENT_SECRET,
    });
    try {
      const res = await axios.post(BOX_TOKEN_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const { access_token, refresh_token, expires_in } = res.data;
      tokenStore.setBoxToken({ email, accessToken: access_token, refreshToken: refresh_token, expiresAt: Date.now() + expires_in * 1000 });
      logger.info(`[boxClient] Token refreshed for ${email}`);
      return access_token;
    } catch (err) {
      // A 400 here is exactly what Box returns for "this refresh token was already redeemed" —
      // give whichever OTHER process won the race a moment to persist its result, then use it
      // instead of failing on a token that was never actually invalid, just already spent.
      if (err?.response?.status === 400) {
        await new Promise((r) => setTimeout(r, 1500));
        const afterWait = tokenStore.getBoxToken(email);
        if (afterWait?.accessToken && afterWait.refreshToken !== refreshToken) {
          logger.info(`[boxClient] Refresh for ${email} lost a cross-process race — another process `
            + 'already rotated the token; using its result instead of failing.');
          return afterWait.accessToken;
        }
      }
      throw err;
    }
  })().finally(() => boxRefreshLocks.delete(key));

  boxRefreshLocks.set(key, p);
  return p;
}

/**
 * Box Client Credentials Grant — server-to-server auth as the enterprise (admin).
 * No user login, no 60-minute developer-token expiry. Requires BOX_ENTERPRISE_ID and a
 * Box app of type "Server Authentication (Client Credentials Grant)" authorized in the
 * Box Admin Console. This is the right auth for listing managed users + seeding data.
 */
async function getEnterpriseToken() {
  const enterpriseId = (process.env.BOX_ENTERPRISE_ID || '').trim();
  const clientId = process.env.BOX_CLIENT_ID;
  const clientSecret = process.env.BOX_CLIENT_SECRET;
  if (!enterpriseId || !clientId || !clientSecret) return null;

  if (ccgToken && Date.now() < ccgToken.expiresAt - 60_000) return ccgToken.token;

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    box_subject_type: 'enterprise',
    box_subject_id: enterpriseId,
  });
  const res = await axios.post(BOX_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const { access_token, expires_in } = res.data;
  ccgToken = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  logger.info('[boxClient] Obtained enterprise token via Client Credentials Grant');
  return access_token;
}

async function getValidToken(adminEmail) {
  const devToken = process.env.BOX_DEVELOPER_TOKEN;
  const tokenStore = require('./oauthTokenStore');

  // 1. Preferred: server-auth (CCG) enterprise token — auto-renews, admin scope.
  try {
    const ccg = await getEnterpriseToken();
    if (ccg) return ccg;
  } catch (err) {
    logger.warn(`[boxClient] CCG token failed: ${err.response?.status || ''} ${JSON.stringify(err.response?.data || err.message)}`);
  }

  // 2. Stored OAuth token (user connected via Connect Clouds).
  const stored = tokenStore.getBoxToken(adminEmail);
  if (stored && stored.accessToken) {
    if (!stored.expiresAt || Date.now() >= stored.expiresAt - 60_000) {
      if (stored.refreshToken) {
        try {
          // Serialized refresh — concurrent callers share one rotation (see boxRefreshLocks).
          return await refreshBoxToken(adminEmail, tokenStore);
        } catch (err) {
          // Stale/invalid refresh token (Box returns 400 invalid_grant) — fall through to dev token.
          logger.warn(`[boxClient] OAuth refresh failed for ${adminEmail}: ${err.response?.status || ''} — falling back to developer token`);
        }
      }
    } else {
      return stored.accessToken;
    }
  }

  // 3. Developer token (manual, expires ~60 min — quick tests only).
  if (devToken) return devToken;

  throw new Error(
    `No usable Box credential for ${adminEmail}. Set BOX_ENTERPRISE_ID (+ a Client Credentials Grant app) for server auth, `
    + `connect Box via OAuth at GET /api/auth/box/url, or set a fresh BOX_DEVELOPER_TOKEN (expires in 60 min).`,
  );
}

// ─── Request helpers ──────────────────────────────────────────────────────────

function authHeaders(token, asUserId = null) {
  const h = { Authorization: `Bearer ${token}` };
  if (asUserId) h['As-User'] = String(asUserId);
  return h;
}

// ─── User management ──────────────────────────────────────────────────────────

async function getMe(adminEmail) {
  const token = await getValidToken(adminEmail);
  const res = await axios.get(`${BOX_API}/users/me`, {
    headers: authHeaders(token),
    params: { fields: 'id,login,name' },
  });
  return res.data;
}

async function getUsers(adminEmail) {
  const token = await getValidToken(adminEmail);
  try {
    const res = await axios.get(`${BOX_API}/users`, {
      headers: authHeaders(token),
      params: { fields: 'id,login,name,status', user_type: 'managed', limit: 1000 },
    });
    return (res.data.entries || []).filter((u) => u.status === 'active');
  } catch (err) {
    const box = err.response?.data;
    // /2.0/users requires an enterprise admin token. A user-scoped token gets 403/400.
    const detail = box?.message || box?.error_description || box?.code || err.message;
    throw new Error(`Box list-users failed (HTTP ${err.response?.status}): ${detail}. `
      + `Listing managed users requires an enterprise admin token — use Client Credentials Grant (BOX_ENTERPRISE_ID).`);
  }
}

// ─── Folder operations ────────────────────────────────────────────────────────

async function createFolder(name, parentId, token, asUserId = null) {
  const safeName = name.substring(0, 255);
  const res = await axios.post(
    `${BOX_API}/folders`,
    { name: safeName, parent: { id: String(parentId) } },
    { headers: { ...authHeaders(token, asUserId), 'Content-Type': 'application/json' } }
  );
  return res.data;
}

// ─── File operations ──────────────────────────────────────────────────────────

async function uploadFile(name, fileBuffer, parentId, token, asUserId = null, opts = {}) {
  const attributes = { name, parent: { id: String(parentId) } };
  if (opts.contentModifiedAt) attributes.content_modified_at = opts.contentModifiedAt;
  if (opts.contentCreatedAt) attributes.content_created_at = opts.contentCreatedAt;
  const { body, contentType } = buildMultipart(
    attributes,
    name,
    Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer)
  );
  const res = await axios.post(`${BOX_UPLOAD}/files/content`, body, {
    headers: { ...authHeaders(token, asUserId), 'Content-Type': contentType },
    maxBodyLength: Infinity,
  });
  return res.data.entries[0];
}

async function uploadVersion(fileId, name, fileBuffer, token, asUserId = null) {
  const { body, contentType } = buildMultipart(
    { name },
    name,
    Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer)
  );
  const res = await axios.post(`${BOX_UPLOAD}/files/${fileId}/content`, body, {
    headers: { ...authHeaders(token, asUserId), 'Content-Type': contentType },
    maxBodyLength: Infinity,
  });
  return res.data.entries[0];
}

// ─── Box Notes ─────────────────────────────────────────────────────────────────

/**
 * Create a REAL Box Note from Markdown via Box's Notes API (`POST /2.0/notes/convert`, released
 * May 2026 — Box API version 2026.0+, requires the `box-version: 2026.0` request header on every
 * call). Converts Markdown into a genuine `.boxnote` file uploaded directly to the target folder —
 * this is the box-notes equivalent of Dropbox's `files/paper/create`.
 *
 * Superseded assumption: earlier code in this repo (BoxToGoogledriveTestDataAgent's original
 * `_seedBoxNotes`) uploaded a plain JSON placeholder through the generic `files/content` endpoint on
 * the belief that Box had no public Notes-authoring API at all. Confirmed live (2026-09-15): a file
 * uploaded that way carries only generic `extracted_text`/`embedded_metadata` representations — Box
 * does not recognise it as an actual Note. This endpoint is the real one.
 *
 * No new OAuth scope is required — ordinary file-upload permission on the target folder is enough.
 * Known limits from Box's own docs: content must be Markdown, capped at 1 MB, and conversion can take
 * up to ~30s server-side (the request may legitimately be slow).
 *
 * @param {string} markdown — Markdown content, max 1 MB
 * @param {string} parentId — destination folder id
 * @param {string} token
 * @param {string|null} asUserId
 * @param {string} [name] — filename for the resulting .boxnote file (Box appends .boxnote itself if
 *   omitted from the name)
 * @returns {Promise<{id: string, type: string}>}
 */
async function createNote(markdown, parentId, token, asUserId = null, name) {
  // NOT `parent_id` — the API rejects that with "should NOT have additional properties" /
  // "should have required property 'parent'" (confirmed live 2026-09-15). It wants the same
  // `parent: { id }` shape every other Box create call uses (see createFolder above).
  const body = {
    content: markdown,
    parent: { id: String(parentId), type: 'folder' },
    content_format: 'markdown',
    ...(name ? { name } : {}),
  };
  const res = await axios.post(`${BOX_API}/notes/convert`, body, {
    headers: {
      ...authHeaders(token, asUserId),
      'Content-Type': 'application/json',
      'box-version': '2026.0',
    },
    timeout: 45000, // conversion can take up to ~30s per Box's own documented limit
  });
  return res.data;
}

// ─── Shared links ─────────────────────────────────────────────────────────────

/**
 * Create (or replace) a shared link on a Box file or folder.
 *
 * `access` defaults to `'open'` — unchanged from every existing caller (BoxTestDataAgent's public
 * "anyone with the link" scenarios) — but accepts Box's other two shared_link.access values:
 *   'open'          — anyone with the link (Dropbox/Google's "anyone" audience)
 *   'company'       — anyone in the enterprise (Box's "people in your company" link; the Google
 *                      equivalent of a domain-scope link)
 *   'collaborators' — only people who already have collaborator access on the item
 *
 * Box's shared_link has NO edit-vs-view axis — only `can_download` / `can_preview`, never `can_edit`.
 * Editing always requires a real collaboration; a shared link only ever grants viewing/downloading,
 * regardless of `access`. See validation/roleMaps/box_to_google.js's `expectedLinkType`, which is
 * always `'view'` for exactly this reason.
 */
async function createSharedLink(itemType, itemId, token, asUserId = null, access = 'open') {
  const endpoint = itemType === 'file' ? 'files' : 'folders';
  const body = {
    shared_link: {
      access,
      ...(itemType === 'file' ? { permissions: { can_download: true, can_preview: true } } : {}),
    },
  };
  const res = await axios.put(`${BOX_API}/${endpoint}/${itemId}?fields=shared_link`, body, {
    headers: { ...authHeaders(token, asUserId), 'Content-Type': 'application/json' },
  });
  return res.data.shared_link?.url || null;
}

/**
 * Update a Box file or folder's own attributes — rename (`{ name }`) or move (`{ parent: { id } }`).
 *
 * Added for BoxToGoogledriveTestDataAgent.applyDeltaChanges (content scope 1.3 — delta migration),
 * which needs to rename and move items that already migrated in a prior one-time pass. Box addresses
 * everything by id, so a rename/move is the same PUT either way; no path arithmetic is needed the way
 * Dropbox's `movePath` requires.
 */
async function updateItem(itemType, itemId, updates, token, asUserId = null) {
  const base = itemType === 'folder' ? 'folders' : 'files';
  const res = await axios.put(`${BOX_API}/${base}/${itemId}`, updates, {
    headers: { ...authHeaders(token, asUserId), 'Content-Type': 'application/json' },
  });
  return res.data;
}

// ─── Comments ─────────────────────────────────────────────────────────────────

async function addComment(fileId, message, token, asUserId = null) {
  const res = await axios.post(`${BOX_API}/comments`, {
    item: { type: 'file', id: String(fileId) },
    message,
  }, {
    headers: { ...authHeaders(token, asUserId), 'Content-Type': 'application/json' },
  });
  return res.data;
}

// ─── Groups ───────────────────────────────────────────────────────────────────

async function createGroup(name, token, asUserId = null) {
  const res = await axios.post(`${BOX_API}/groups`, { name }, {
    headers: { ...authHeaders(token, asUserId), 'Content-Type': 'application/json' },
  });
  return res.data;
}

async function addGroupMember(groupId, userId, role = 'member', token, asUserId = null) {
  const res = await axios.post(`${BOX_API}/group_memberships`, {
    user: { id: String(userId) },
    group: { id: String(groupId) },
    role,
  }, {
    headers: { ...authHeaders(token, asUserId), 'Content-Type': 'application/json' },
  });
  return res.data;
}

async function createGroupCollaboration(itemType, itemId, groupId, role, token, suppressNotify = true, asUserId = null) {
  const url = suppressNotify
    ? `${BOX_API}/collaborations?notify=false`
    : `${BOX_API}/collaborations`;
  const res = await axios.post(url, {
    item: { type: itemType, id: String(itemId) },
    accessible_by: { type: 'group', id: String(groupId) },
    role,
  }, {
    headers: { ...authHeaders(token, asUserId), 'Content-Type': 'application/json' },
  });
  return res.data;
}

// ─── Collaborations ───────────────────────────────────────────────────────────

async function createCollaboration(itemType, itemId, userEmail, role, token, suppressNotify = true, asUserId = null) {
  const url = suppressNotify
    ? `${BOX_API}/collaborations?notify=false`
    : `${BOX_API}/collaborations`;
  const res = await axios.post(url, {
    item: { type: itemType, id: String(itemId) },
    accessible_by: { type: 'user', login: userEmail },
    role,
  }, {
    headers: { ...authHeaders(token, asUserId), 'Content-Type': 'application/json' },
  });
  return res.data;
}

// ─── Content stats & cleanup ──────────────────────────────────────────────────

async function getFolderItems(folderId, token, asUserId = null) {
  const res = await axios.get(`${BOX_API}/folders/${folderId}/items`, {
    headers: authHeaders(token, asUserId),
    // timestamps + created_by/modified_by are read by validation (timestamp & author preservation)
    params: { fields: 'id,name,type,size,created_at,modified_at,content_created_at,content_modified_at,created_by,modified_by,owned_by', limit: 1000 },
  });
  return res.data.entries || [];
}

/**
 * Resolve an EXISTING folder path (e.g. "/NEWDATA" or "/Projects/Q1") to its Box folder id by
 * walking from the account root. Case-insensitive segment match. Returns { id, name, path } or
 * null if any segment isn't found. asUserId resolves within that user's account (As-User).
 */
async function resolveFolderByPath(path, token, asUserId = null) {
  const segments = String(path || '').split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return { id: '0', name: '', path: '/' };
  let parentId = '0';
  let resolvedName = '';
  for (const seg of segments) {
    const items = await getFolderItems(parentId, token, asUserId);
    const match = items.find((i) => i.type === 'folder' && String(i.name).toLowerCase() === seg.toLowerCase());
    if (!match) return null;
    parentId = match.id;
    resolvedName = match.name;
  }
  return { id: parentId, name: resolvedName, path: `/${segments.join('/')}` };
}

async function deleteBoxItem(type, id, token, asUserId = null) {
  const url = type === 'folder'
    ? `${BOX_API}/folders/${id}?recursive=true`
    : `${BOX_API}/files/${id}`;
  await axios.delete(url, { headers: authHeaders(token, asUserId) });
}

// ─── Read methods for validation (permissions / versions / shared links) ───────

/**
 * List collaborations (permissions) on a Box file or folder.
 * Returns [{ accessibleByEmail, accessibleByName, accessibleByType, role, status }].
 * Box roles: editor, viewer, previewer, uploader, previewer uploader, viewer uploader,
 *            co-owner, owner.
 */
async function getCollaborations(itemType, itemId, token, asUserId = null) {
  const base = itemType === 'folder' ? 'folders' : 'files';
  try {
    const res = await axios.get(`${BOX_API}/${base}/${itemId}/collaborations`, {
      headers: authHeaders(token, asUserId),
      params: { fields: 'role,status,accessible_by' },
    });
    return (res.data.entries || []).map((c) => ({
      accessibleByEmail: c.accessible_by?.login || null,
      accessibleByName: c.accessible_by?.name || null,
      accessibleByType: c.accessible_by?.type || null, // 'user' | 'group'
      role: c.role || null,
      status: c.status || null,
    }));
  } catch (err) {
    // 403 when the token lacks rights to read collaborations on this item.
    if (err?.response?.status === 403 || err?.response?.status === 404) return [];
    throw err;
  }
}

/**
 * List prior versions of a Box file. Box returns only NON-current versions here, so the
 * total version count = entries.length + 1 (the current version).
 * Returns { totalVersions, priorVersions: [{ id, name, size, modifiedAt }] }.
 */
async function getFileVersions(fileId, token, asUserId = null) {
  try {
    const res = await axios.get(`${BOX_API}/files/${fileId}/versions`, {
      headers: authHeaders(token, asUserId),
      params: { fields: 'id,name,size,modified_at' },
    });
    const prior = (res.data.entries || []).map((v) => ({
      id: v.id, name: v.name, size: v.size, modifiedAt: v.modified_at,
    }));
    return { totalVersions: prior.length + 1, priorVersions: prior };
  } catch (err) {
    if (err?.response?.status === 403 || err?.response?.status === 404) return { totalVersions: 1, priorVersions: [] };
    throw err;
  }
}

/**
 * Fetch an item's shared-link + collaboration summary in one call.
 * Returns { sharedLink: <url|null>, access: <open|company|collaborators|null> }.
 */
async function getItemSharing(itemType, itemId, token, asUserId = null) {
  const base = itemType === 'folder' ? 'folders' : 'files';
  try {
    const res = await axios.get(`${BOX_API}/${base}/${itemId}`, {
      headers: authHeaders(token, asUserId),
      params: { fields: 'shared_link,name' },
    });
    const sl = res.data.shared_link;
    return { sharedLink: sl?.url || null, access: sl?.access || null };
  } catch (err) {
    if (err?.response?.status === 403 || err?.response?.status === 404) return { sharedLink: null, access: null };
    throw err;
  }
}

async function getBoxUserByEmail(adminEmail, userEmail) {
  const users = await getUsers(adminEmail);
  return users.find((u) => u.login.toLowerCase() === userEmail.toLowerCase()) || null;
}

async function getBoxContentStats(adminEmail, userEmail) {
  const token = await getValidToken(adminEmail);
  const user = await getBoxUserByEmail(adminEmail, userEmail);
  const asUserId = user ? user.id : null;
  const items = await getFolderItems('0', token, asUserId);
  return {
    email: userEmail,
    fileCount: items.filter((i) => i.type === 'file').length,
    folderCount: items.filter((i) => i.type === 'folder').length,
    totalItems: items.length,
  };
}

async function cleanBoxContent(adminEmail, userEmail) {
  const token = await getValidToken(adminEmail);
  const user = await getBoxUserByEmail(adminEmail, userEmail);
  const asUserId = user ? user.id : null;
  const items = await getFolderItems('0', token, asUserId);
  let deletedFiles = 0, deletedFolders = 0;
  const errors = [];
  for (const item of items) {
    try {
      await deleteBoxItem(item.type, item.id, token, asUserId);
      if (item.type === 'file') deletedFiles++;
      else deletedFolders++;
    } catch (err) {
      errors.push(`${item.name}: ${err.message}`);
    }
  }
  return { deletedFiles, deletedFolders, errors };
}

async function cleanBoxFiles(adminEmail, userEmail) {
  const token = await getValidToken(adminEmail);
  const user = await getBoxUserByEmail(adminEmail, userEmail);
  const asUserId = user ? user.id : null;
  const items = await getFolderItems('0', token, asUserId);
  let deletedFiles = 0;
  const errors = [];
  for (const item of items.filter((i) => i.type === 'file')) {
    try {
      await deleteBoxItem('file', item.id, token, asUserId);
      deletedFiles++;
    } catch (err) {
      errors.push(`${item.name}: ${err.message}`);
    }
  }
  return { deletedFiles, errors };
}

async function cleanBoxFolders(adminEmail, userEmail) {
  const token = await getValidToken(adminEmail);
  const user = await getBoxUserByEmail(adminEmail, userEmail);
  const asUserId = user ? user.id : null;
  const items = await getFolderItems('0', token, asUserId);
  let deletedFolders = 0;
  const errors = [];
  for (const item of items.filter((i) => i.type === 'folder')) {
    try {
      await deleteBoxItem('folder', item.id, token, asUserId);
      deletedFolders++;
    } catch (err) {
      errors.push(`${item.name}: ${err.message}`);
    }
  }
  return { deletedFolders, errors };
}

/**
 * Build a flat tree of { name, type, path } for every item under rootFolderId.
 * maxDepth limits recursion to avoid infinite loops in deep/circular structures.
 */
async function buildFolderTree(rootFolderId, token, asUserId, maxDepth = 5, _depth = 0, _path = '') {
  const items = await getFolderItems(rootFolderId, token, asUserId);
  const result = [];
  for (const item of items) {
    const itemPath = `${_path}/${item.name}`;
    result.push({
      name: item.name,
      type: item.type,
      path: itemPath,
      id: item.id,
      size: item.size ?? null,
      // Box content_* reflect the file's own create/modify time (preserved across upload);
      // fall back to platform created_at/modified_at when content_* are absent (e.g. folders).
      createdAt: item.content_created_at || item.created_at || null,
      modifiedAt: item.content_modified_at || item.modified_at || null,
      createdBy: item.created_by?.login || null,
      modifiedBy: item.modified_by?.login || null,
      ownedBy: item.owned_by?.login || null,
    });
    if (item.type === 'folder' && _depth < maxDepth) {
      const children = await buildFolderTree(item.id, token, asUserId, maxDepth, _depth + 1, itemPath);
      result.push(...children);
    }
  }
  return result;
}

// ─── Metadata & comments (read, for validation) ────────────────────────────────

/**
 * List custom-metadata instances on a Box file or folder.
 * Returns { count, instances: [{ template, scope, fields }] }.
 */
async function getItemMetadata(itemType, itemId, token, asUserId = null) {
  const base = itemType === 'folder' ? 'folders' : 'files';
  try {
    const res = await axios.get(`${BOX_API}/${base}/${itemId}/metadata`, {
      headers: authHeaders(token, asUserId),
    });
    const entries = res.data.entries || [];
    return {
      count: entries.length,
      instances: entries.map((e) => ({
        template: e.$template || null,
        scope: e.$scope || null,
        fields: Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('$'))),
      })),
    };
  } catch (err) {
    if (err?.response?.status === 403 || err?.response?.status === 404) return { count: 0, instances: [] };
    throw err;
  }
}

/**
 * List comments on a Box file.
 * Returns { total, comments: [{ message, by }] }.
 */
async function listComments(fileId, token, asUserId = null) {
  try {
    const res = await axios.get(`${BOX_API}/files/${fileId}/comments`, {
      headers: authHeaders(token, asUserId),
      params: { fields: 'message,created_by,created_at' },
    });
    const entries = res.data.entries || [];
    return {
      total: res.data.total_count ?? entries.length,
      comments: entries.map((c) => ({ message: c.message, by: c.created_by?.login || c.created_by?.name || null })),
    };
  } catch (err) {
    if (err?.response?.status === 403 || err?.response?.status === 404) return { total: 0, comments: [] };
    throw err;
  }
}

module.exports = {
  getValidToken, getMe, getUsers,
  createFolder, uploadFile, uploadVersion, createNote,
  createSharedLink, addComment, createCollaboration,
  createGroup, addGroupMember, createGroupCollaboration,
  getBoxContentStats, cleanBoxContent, cleanBoxFiles, cleanBoxFolders,
  getFolderItems, buildFolderTree, resolveFolderByPath,
  getCollaborations, getFileVersions, getItemSharing,
  getItemMetadata, listComments, getBoxUserByEmail,
  updateItem, deleteBoxItem,
};
