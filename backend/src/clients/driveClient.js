const fs = require('fs');
const { google } = require('googleapis');
const env = require('../config/env');
const tokenStore = require('./oauthTokenStore');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');
const { normalizeDriveName } = require('../utils/driveNames');

/** Return '2' or '3' if the email belongs to the second/third Google tenant, else '1'. */
function getGoogleTenant(email) {
  const domain = (email || '').split('@')[1]?.toLowerCase() || '';
  if (domain && env.GOOGLE_CLIENT_ID_3 && env.GOOGLE_TENANT_3_DOMAINS?.includes(domain)) return '3';
  if (domain && env.GOOGLE_CLIENT_ID_2 && env.GOOGLE_TENANT_2_DOMAINS?.includes(domain)) return '2';
  return '1';
}

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
];

/**
 * Shared Drive (formerly Team Drive) items are invisible to the Drive API unless these flags are set.
 * Harmless for My Drive, so they are passed on every call rather than branching per caller.
 */
const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true };

/** Field set the content validator needs from every item — richer than the seeding paths require. */
const VALIDATION_FIELDS = [
  'id', 'name', 'mimeType', 'size', 'createdTime', 'modifiedTime', 'trashed', 'driveId', 'parents',
  'owners(emailAddress)', 'lastModifyingUser(emailAddress)',
  'shortcutDetails(targetId,targetMimeType)',
].join(',');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

const SERVICE_ACCOUNT_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
];

/**
 * Resolve the service-account key path for an email's domain — same resolution gmailClient uses.
 * Priority: tenant-specific key (legacy) → the single shared GOOGLE_SERVICE_ACCOUNT_KEY.
 * Returns null when no DWD key is configured, so the caller can fall back to OAuth.
 *
 * This previously looked ONLY at the tenant 2/3 keys, so a domain that maps to tenant 1 (the default)
 * could never use Domain-Wide Delegation even with a shared key configured.
 */
function serviceAccountKeyPathFor(email) {
  const tenant = getGoogleTenant(email);
  if (tenant === '3' && env.GOOGLE_SERVICE_ACCOUNT_KEY_3) return env.GOOGLE_SERVICE_ACCOUNT_KEY_3;
  if (tenant === '2' && env.GOOGLE_SERVICE_ACCOUNT_KEY_2) return env.GOOGLE_SERVICE_ACCOUNT_KEY_2;
  return env.GOOGLE_SERVICE_ACCOUNT_KEY || null;
}

/** Returns a service-account JWT auth client impersonating the given user (DWD). */
function getServiceAccountAuth(email) {
  const keyPath = serviceAccountKeyPathFor(email);
  if (!keyPath) {
    throw new Error(`No service account key configured for ${email} (set GOOGLE_SERVICE_ACCOUNT_KEY)`);
  }
  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SERVICE_ACCOUNT_DRIVE_SCOPES,
    subject: email,
  });
}

/** Get OAuth2 client for a specific refresh token. Picks tenant-correct credentials. */
function getAuthForToken(refreshToken, email) {
  const tenant = getGoogleTenant(email);
  let clientId, clientSecret;
  if (tenant === '3') {
    clientId = env.GOOGLE_CLIENT_ID_3;
    clientSecret = env.GOOGLE_CLIENT_SECRET_3;
  } else if (tenant === '2') {
    clientId = env.GOOGLE_CLIENT_ID_2;
    clientSecret = env.GOOGLE_CLIENT_SECRET_2;
  } else {
    clientId = env.GOOGLE_CLIENT_ID;
    clientSecret = env.GOOGLE_CLIENT_SECRET;
  }
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

/**
 * Resolve auth for an email: service account (DWD) when a key is configured, else a stored OAuth
 * refresh token, else an env-configured account.
 *
 * Three bugs lived here, and together they made Drive unusable for any DWD account:
 *   1. `tokenStore.get` was called — the store has never exported `get`, only `getGoogleToken`, so
 *      this threw `TypeError: tokenStore.get is not a function`.
 *   2. `getGoogleToken` returns the whole stored ENTRY (`{ refreshToken?, isDwd?, connectedAt }`),
 *      not a string. Passing the object as `refresh_token` made Google answer `invalid_request`.
 *   3. Service-account auth was attempted only for tenants 2 and 3, ignoring the shared
 *      GOOGLE_SERVICE_ACCOUNT_KEY — so a DWD account on a tenant-1 domain silently fell through to
 *      an OAuth path it has no refresh token for.
 */
const dwdFallbackWarned = new Set();

async function getAuth(email) {
  const normalized = String(email || '').toLowerCase().trim();
  const stored = tokenStore.getGoogleToken(normalized);

  if (serviceAccountKeyPathFor(normalized)) {
    const jwt = getServiceAccountAuth(normalized);
    // No OAuth alternative: hand back the JWT and let the real Google error surface on first use.
    if (!stored?.refreshToken) return jwt;
    // An OAuth token IS available, so a service account that is present but not authorized for this
    // domain (Domain-Wide Delegation not granted in the Admin console) must not be a dead end.
    try {
      await jwt.authorize();
      return jwt;
    } catch (err) {
      // Once per account, not once per API call. getAuth runs on EVERY Drive request, so a domain
      // without Domain-Wide Delegation logged this identical line hundreds of times in a single
      // run — enough to bury the warnings that matter.
      if (!dwdFallbackWarned.has(normalized)) {
        dwdFallbackWarned.add(normalized);
        logger.warn(
          `[Drive] service account cannot impersonate ${normalized} (${err.message}) — `
          + 'falling back to the stored OAuth token. Grant Domain-Wide Delegation to use DWD instead.'
        );
      }
    }
  }

  if (stored?.refreshToken) return getAuthForToken(stored.refreshToken, normalized);

  const envToken = env.googleAccounts?.get?.(normalized);
  if (envToken) return getAuthForToken(envToken, normalized);

  if (stored?.isDwd) {
    throw new Error(
      `${normalized} is connected via Domain-Wide Delegation but no service account key is configured. `
      + 'Set GOOGLE_SERVICE_ACCOUNT_KEY (or the tenant-specific key) to the service-account JSON, and '
      + 'authorize its client id for the Drive scope in the Google Admin console.'
    );
  }
  throw new Error(`No OAuth token found for ${normalized}. Authenticate via /auth/google first.`);
}

/**
 * Can the configured service account actually impersonate this user?
 *
 * Registering an account as DWD is only a claim; nothing verified it, so an account whose domain has
 * not authorized the service-account client id could be registered and then fail on every call.
 * Returns { ok, reason } rather than throwing so a caller can report the real cause.
 */
async function verifyDwd(email) {
  const normalized = String(email || '').toLowerCase().trim();
  if (!normalized) return { ok: false, reason: 'no email given' };
  if (!serviceAccountKeyPathFor(normalized)) {
    return { ok: false, reason: 'no service account key is configured (set GOOGLE_SERVICE_ACCOUNT_KEY)' };
  }
  try {
    await getServiceAccountAuth(normalized).authorize();
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: explainAuthError(err, normalized) };
  }
}

/**
 * Turn a raw Google auth failure into something a QA engineer can act on.
 *
 * Google answers a dead refresh token with the bare string "invalid_grant", which reached our report
 * verbatim — "Source Shared Drive resolved :: invalid_grant" — and says nothing about the cause or
 * the fix. The usual cause here is not a code fault at all: an OAuth consent screen still in
 * "Testing" publishing status expires every refresh token it issues after 7 days, so a suite that
 * passed last week fails with no code change. Worth naming explicitly, because the failure looks
 * like a regression and is not one.
 *
 * Returns the original message unchanged when it is not an auth failure, so real errors are never
 * masked by a guess.
 */
function explainAuthError(err, email) {
  const raw = String(err?.response?.data?.error || err?.message || err || '');
  const desc = String(err?.response?.data?.error_description || '');
  const who = email ? ` for ${email}` : '';
  if (/invalid_grant/i.test(raw)) {
    return `Google rejected the saved credential${who} (invalid_grant: ${desc || 'token expired or revoked'}). `
      + 'Reconnect the Google account to get a new token. Refresh tokens last only 7 days while the '
      + 'OAuth consent screen is in "Testing" — publish it, or grant Domain-Wide Delegation to the '
      + 'service account for this domain, so the credential stops expiring.';
  }
  if (/unauthorized_client/i.test(raw)) {
    return `The service account is not authorized to impersonate${who} (unauthorized_client). `
      + 'Grant Domain-Wide Delegation to the service-account client id for this domain in the Google '
      + 'Admin console, with the Drive scopes.';
  }
  if (/invalid_client/i.test(raw)) {
    return `Google rejected the OAuth client credentials${who} (invalid_client) — check `
      + 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.';
  }
  return err?.message || raw || 'unknown error';
}

/** Get an authenticated Drive API client for a given email. */
async function getDriveClient(email) {
  const auth = await getAuth(email);
  return google.drive({ version: 'v3', auth });
}

// ─── Folder operations ────────────────────────────────────────────────────────

/** Create a folder in Google Drive. Returns the created file resource. */
async function createFolder(name, parentId, email) {
  const drive = await getDriveClient(email);
  return retryWithBackoff(async () => {
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : [],
      },
      fields: 'id, name',
      supportsAllDrives: true,
    });
    return res.data;
  });
}

/**
 * Create every missing segment of a folder path and return the final folder's id.
 *
 * Mirrors sharepointClient.ensureFolderPath so AgentOrchestrator's pre-create-the-destination step
 * can use the same shape for a Google destination — CloudFuze is handed a destination path with no
 * guarantee it creates a missing segment itself, so this makes sure it already exists before the
 * migration is triggered.
 *
 * Defaults to My Drive (rootId 'root'). For a Shared Drive, pass { rootId: driveId } — createFolder
 * already sends supportsAllDrives and findByName's query already includes items from all drives, so
 * nothing else here is drive-specific; only the starting parent differs.
 *
 * @param {string} path - e.g. "/QA-Automation-Dropbox" or "Sub/Folder"
 * @param {string} email - whose Drive to create the folders in
 * @param {{rootId?: string}} [opts]
 * @returns {Promise<{id: string, created: string[]}>} the deepest folder's id, and which segments were newly made
 */
async function ensureFolderPath(path, email, opts = {}) {
  const rootId = opts.rootId || 'root';
  const segments = String(path || '').split('/').map((s) => s.trim()).filter(Boolean);
  let parentId = rootId;
  const created = [];
  for (const segment of segments) {
    const existing = await findByName(segment, parentId, email);
    if (existing) {
      parentId = existing.id;
    } else {
      const made = await createFolder(segment, parentId, email);
      created.push(segment);
      parentId = made.id;
    }
  }
  return { id: parentId, created };
}

// ─── File upload ──────────────────────────────────────────────────────────────

/**
 * Upload a file to Google Drive.
 * @param {string} name - file name
 * @param {string} mimeType - MIME type of the content
 * @param {Buffer|string} content - file content
 * @param {string} parentId - parent folder id (null = My Drive root)
 * @param {string} email - owner email
 */
async function uploadFile(name, mimeType, content, parentId, email) {
  const drive = await getDriveClient(email);
  const { Readable } = require('stream');
  const body = Buffer.isBuffer(content) ? Readable.from(content) : Readable.from(Buffer.from(content));
  return retryWithBackoff(async () => {
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType,
        parents: parentId ? [parentId] : [],
      },
      media: { mimeType, body },
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });
    return res.data;
  });
}

/**
 * Upload a new version of an existing file (replaces content, keeps same file id).
 * @param {string} fileId - the Drive file id to update
 * @param {string} mimeType - MIME type
 * @param {Buffer|string} content - new version content
 * @param {string} email - owner email
 */
async function uploadVersion(fileId, mimeType, content, email) {
  const drive = await getDriveClient(email);
  const { Readable } = require('stream');
  const body = Buffer.isBuffer(content) ? Readable.from(content) : Readable.from(Buffer.from(content));
  return retryWithBackoff(async () => {
    const res = await drive.files.update({
      fileId,
      media: { mimeType, body },
      fields: 'id, name, version',
      // Without this, a file that lives in a Shared Drive is invisible to the update and the API
      // answers "File not found: <fileId>". That is why every versioned_doc_*.txt failed to get
      // versions 2-5 and File Version History sat at NA in the report.
      supportsAllDrives: true,
    });
    return res.data;
  });
}

// ─── Google Workspace native file creation ────────────────────────────────────

/**
 * Create an empty Google Workspace native file (Doc, Sheet, or Slide).
 * @param {string} name - file name
 * @param {'application/vnd.google-apps.document'|'application/vnd.google-apps.spreadsheet'|'application/vnd.google-apps.presentation'} gMimeType
 * @param {string} parentId - parent folder id
 * @param {string} email - owner email
 */
async function createNativeFile(name, gMimeType, parentId, email) {
  const drive = await getDriveClient(email);
  return retryWithBackoff(async () => {
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: gMimeType,
        parents: parentId ? [parentId] : [],
      },
      fields: 'id, name, mimeType',
      // Same omission as uploadVersion above: without it the Shared Drive parent cannot be
      // resolved and the API answers "File not found: <parentId>", which is why all three
      // Google native files (Doc/Sheet/Slide) failed to seed.
      supportsAllDrives: true,
    });
    return res.data;
  });
}

// ─── Permissions ──────────────────────────────────────────────────────────────

/**
 * Share a file or folder with another user.
 * @param {string} fileId - Drive file/folder id
 * @param {string} targetEmail - email of the user to share with
 * @param {'reader'|'writer'|'commenter'} role - access level
 * @param {string} ownerEmail - email of the file owner (for auth)
 */
async function shareFile(fileId, targetEmail, role, ownerEmail) {
  const drive = await getDriveClient(ownerEmail);
  return retryWithBackoff(async () => {
    const res = await drive.permissions.create({
      fileId,
      requestBody: { type: 'user', role, emailAddress: targetEmail },
      fields: 'id, role',
      sendNotificationEmail: false,
      supportsAllDrives: true,
    });
    return res.data;
  });
}

/**
 * Remove the "anyone with the link" public permission from a file or folder.
 * No-op if no public link exists.
 */
async function removePublicLink(fileId, email) {
  const drive = await getDriveClient(email);
  const res = await drive.permissions.list({
    fileId,
    fields: 'permissions(id,type)',
    supportsAllDrives: true,
  });
  const anyonePerm = (res.data.permissions || []).find((p) => p.type === 'anyone');
  if (anyonePerm) {
    await drive.permissions.delete({ fileId, permissionId: anyonePerm.id, supportsAllDrives: true });
  }
  return !!anyonePerm;
}

/**
 * Create a domain-restricted shareable link (only users in the given domain can open it).
 * @param {string} fileId - Drive file/folder id
 * @param {string} domain - e.g. 'storefuze.com'
 * @param {'reader'|'writer'|'commenter'} role - access level
 * @param {string} ownerEmail - file owner email (for auth)
 * Returns the webViewLink URL string.
 */
async function createDomainLink(fileId, domain, role, ownerEmail) {
  const drive = await getDriveClient(ownerEmail);
  return retryWithBackoff(async () => {
    await drive.permissions.create({
      fileId,
      requestBody: { type: 'domain', role, domain },
      fields: 'id',
      supportsAllDrives: true,
    });
    const res = await drive.files.get({ fileId, fields: 'webViewLink', supportsAllDrives: true });
    return res.data.webViewLink;
  });
}

// ─── Shareable links (hyperlinks) ────────────────────────────────────────────

/**
 * Create an "anyone with the link" shareable hyperlink for a file or folder.
 * Returns the webViewLink URL string.
 * Requires https://www.googleapis.com/auth/drive scope in DWD.
 */
async function createSharedLink(fileId, email) {
  const drive = await getDriveClient(email);
  return retryWithBackoff(async () => {
    // Grant "anyone with the link" reader access
    await drive.permissions.create({
      fileId,
      requestBody: { type: 'anyone', role: 'reader' },
      fields: 'id',
      supportsAllDrives: true,
    });
    // Fetch and return the shareable URL
    const res = await drive.files.get({ fileId, fields: 'webViewLink', supportsAllDrives: true });
    return res.data.webViewLink;
  });
}

/**
 * Get the webViewLink of an existing file without changing its permissions.
 */
async function getWebViewLink(fileId, email) {
  const drive = await getDriveClient(email);
  const res = await drive.files.get({ fileId, fields: 'webViewLink', supportsAllDrives: true });
  return res.data.webViewLink;
}

// ─── List / delete helpers ────────────────────────────────────────────────────

/**
 * List files/folders inside a parent folder (non-recursive).
 * Returns an array of { id, name, mimeType } objects.
 */
async function listChildren(parentId, email) {
  const drive = await getDriveClient(email);
  const items = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
      ...ALL_DRIVES,
    });
    items.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

/**
 * Find a file/folder by name inside a parent. Pass 'root' for My Drive root.
 * Returns the first match or null.
 */
async function findByName(name, parentId, email) {
  const drive = await getDriveClient(email);
  // 'root' is a valid Drive API alias for the My Drive root folder
  const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name = '${escapedName}' and '${parentId}' in parents and trashed = false`;
  const res = await drive.files.list({ q, fields: 'files(id, name, mimeType)', pageSize: 1, ...ALL_DRIVES });
  return res.data.files?.[0] || null;
}

/**
 * Delete a file or folder permanently.
 */
async function deleteFile(fileId, email) {
  const drive = await getDriveClient(email);
  await drive.files.delete({ fileId, supportsAllDrives: true });
}

/**
 * Move a file to Trash.
 */
async function trashFile(fileId, email) {
  const drive = await getDriveClient(email);
  await drive.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true });
}

/**
 * Create a link-style permission with an explicit type and role.
 *
 * The older helpers each hardcode one combination (createSharedLink = anyone/reader,
 * createDomainLink = domain/<role>); this one covers the whole matrix the shared-link features
 * describe — 'anyone' ("Anyone with the link") and 'domain' (the organization link) at any role.
 *
 * @param {{type: 'anyone'|'domain', role: string, domain?: string}} link
 */
async function createLinkPermission(fileId, link, ownerEmail) {
  const drive = await getDriveClient(ownerEmail);
  const { type = 'anyone', role = 'reader', domain = null } = link || {};
  const requestBody = { type, role };
  if (type === 'domain') {
    if (!domain) throw new Error('createLinkPermission: a domain link needs a domain');
    requestBody.domain = domain;
  }
  return retryWithBackoff(async () => {
    const res = await drive.permissions.create({
      fileId,
      requestBody,
      fields: 'id, type, role, domain',
      supportsAllDrives: true,
    });
    return res.data;
  }, { label: `Drive createLinkPermission ${type}/${role}` });
}

// ─── Shared Drives ────────────────────────────────────────────────────────────

/**
 * List the Shared Drives (Team Drives) visible to this user.
 * Returns [{ id, name }].
 */
async function listSharedDrives(email) {
  const drive = await getDriveClient(email);
  const drives = [];
  let pageToken;
  do {
    const res = await retryWithBackoff(
      () => drive.drives.list({ fields: 'nextPageToken, drives(id, name)', pageSize: 100, pageToken }),
      { label: 'Drive listSharedDrives' }
    );
    drives.push(...(res.data.drives || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return drives;
}

/**
 * Find a Shared Drive by name (case-insensitive). Returns { id, name } or null.
 *
 * Names arrive path-style from a CSV column or GOOGLE_SHARED_DRIVE_NAME, so both ends are
 * normalised — "/QA_Team1/" resolves the drive named "QA_Team1".
 */
async function resolveSharedDriveByName(name, email) {
  const wanted = normalizeDriveName(name).toLowerCase();
  if (!wanted) return null;
  const drives = await listSharedDrives(email);
  return drives.find((d) => normalizeDriveName(d.name).toLowerCase() === wanted) || null;
}

/**
 * Every folder with this exact name that `email` can see, across My Drive and all Shared Drives.
 *
 * One query instead of a walk per drive: an admin account here sees ~1000 Shared Drives, so probing
 * them individually is thousands of calls and certain rate-limiting.
 *
 * `driveId` is absent on My Drive results — that absence is meaningful to callers looking for a
 * Shared Drive, so it is passed through rather than normalised away.
 */
async function findFoldersByName(name, email) {
  const wanted = String(name || '').trim();
  if (!wanted) return [];
  const drive = await getDriveClient(email);
  const escaped = wanted.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const res = await retryWithBackoff(
    () => drive.files.list({
      q: `name = '${escaped}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: 'files(id, name, driveId, parents)',
      corpora: 'allDrives',
      pageSize: 100,
      ...ALL_DRIVES,
    }),
    { label: 'Drive findFoldersByName' }
  );
  return res.data.files || [];
}

/** One Shared Drive's { id, name } by id — avoids listing every drive just to name one. */
async function getSharedDriveById(driveId, email) {
  if (!driveId) return null;
  const drive = await getDriveClient(email);
  const res = await retryWithBackoff(
    () => drive.drives.get({ driveId, fields: 'id, name' }),
    { label: 'Drive getSharedDriveById' }
  );
  return res.data || null;
}

// ─── Read side (content validation) ───────────────────────────────────────────

/** Normalise a Drive file resource into the item shape the content validator compares on. */
function toItem(file, path) {
  const isFolder = file.mimeType === FOLDER_MIME;
  return {
    id: file.id,
    name: file.name,
    type: isFolder ? 'folder' : 'file',
    path,
    size: file.size != null ? Number(file.size) : null,
    mimeType: file.mimeType || null,
    createdAt: file.createdTime || null,
    modifiedAt: file.modifiedTime || null,
    createdBy: file.owners?.[0]?.emailAddress?.toLowerCase() || null,
    modifiedBy: file.lastModifyingUser?.emailAddress?.toLowerCase() || null,
    shortcutTargetId: file.shortcutDetails?.targetId || null,
  };
}

/**
 * List the children of a folder with the full validation field set.
 * `driveId` scopes the query to a Shared Drive; omit it for My Drive.
 */
async function listChildrenDetailed(parentId, email, driveId = null) {
  const drive = await getDriveClient(email);
  const items = [];
  let pageToken;
  do {
    const params = {
      q: `'${parentId}' in parents and trashed = false`,
      fields: `nextPageToken, files(${VALIDATION_FIELDS})`,
      pageSize: 1000,
      pageToken,
      orderBy: 'folder,name',
      ...ALL_DRIVES,
    };
    if (driveId) {
      params.corpora = 'drive';
      params.driveId = driveId;
    }
    const res = await retryWithBackoff(() => drive.files.list(params), {
      label: 'Drive listChildrenDetailed',
    });
    items.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

/**
 * Resolve a slash-separated path to a folder, walking one segment at a time.
 *
 * `rootId` is where the walk starts: a Shared Drive id (the drive id doubles as its root folder id),
 * or 'root' for My Drive. Returns { id, name, path } or null when a segment is missing.
 */
async function resolveFolderByPath(path, email, opts = {}) {
  const { rootId = 'root', driveId = null } = opts;
  const segments = String(path || '').split('/').map((s) => s.trim()).filter(Boolean);

  let currentId = rootId;
  let currentName = '';
  const walked = [];

  for (const segment of segments) {
    const children = await listChildrenDetailed(currentId, email, driveId);
    const hit = children.find(
      (c) => c.mimeType === FOLDER_MIME && String(c.name).trim().toLowerCase() === segment.toLowerCase()
    );
    if (!hit) {
      logger.warn(`[Drive] resolveFolderByPath: "${segment}" not found under "${walked.join('/') || rootId}"`);
      return null;
    }
    currentId = hit.id;
    currentName = hit.name;
    walked.push(hit.name);
  }

  return { id: currentId, name: currentName || '(root)', path: `/${walked.join('/')}` };
}

/**
 * Walk a folder recursively and return a flat item list with paths relative to the starting folder.
 * Mirrors boxClient.buildFolderTree so the shared content core sees one interface for both sources.
 *
 * Shortcuts are returned as items but not followed — a shortcut's target is migrated on its own if it
 * is in scope, and following it would double-count.
 */
async function buildFolderTree(rootFolderId, email, opts = {}) {
  const { maxDepth = 25, driveId = null } = opts;

  async function walk(folderId, depth, prefix) {
    const children = await listChildrenDetailed(folderId, email, driveId);
    const out = [];
    for (const child of children) {
      const itemPath = `${prefix}/${child.name}`;
      out.push(toItem(child, itemPath));
      if (child.mimeType === FOLDER_MIME && depth < maxDepth) {
        out.push(...(await walk(child.id, depth + 1, itemPath)));
      }
    }
    return out;
  }

  return walk(rootFolderId, 0, '');
}

/** Download a binary file's bytes. Google native files have no bytes — use exportNativeFile. */
async function downloadFile(fileId, email) {
  const drive = await getDriveClient(email);
  const res = await retryWithBackoff(
    () => drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    ),
    { label: 'Drive downloadFile' }
  );
  return Buffer.from(res.data);
}

/**
 * Export a Google native file (Doc/Sheet/Slides) to a concrete format.
 * The bytes are produced by Google's exporter, so they will NOT match a file converted by a migration
 * tool — this is for inspection, not for hash comparison.
 */
async function exportNativeFile(fileId, mimeType, email) {
  const drive = await getDriveClient(email);
  const res = await retryWithBackoff(
    () => drive.files.export({ fileId, mimeType }, { responseType: 'arraybuffer' }),
    { label: 'Drive exportNativeFile' }
  );
  return Buffer.from(res.data);
}

/**
 * Read the permissions on an item, split into the two things a migration must preserve separately.
 *
 * Returns { grants, links }:
 *   grants — per-user / per-group access: [{ email, role, type }]
 *   links  — link-style access: [{ type: 'anyone'|'domain', role, domain, allowFileDiscovery }]
 *            'anyone' is the "Anyone with the link" link; 'domain' is the organization link that
 *            SharePoint renders as "People in <org> with the link".
 */
async function listPermissions(fileId, email) {
  const drive = await getDriveClient(email);
  const perms = [];
  let pageToken;
  do {
    const res = await retryWithBackoff(
      () => drive.permissions.list({
        fileId,
        // permissionDetails says whether a grant is set ON this item or INHERITED from an ancestor
        // (a Shared Drive root, or a folder above). Without it every drive-level grant looked like a
        // separate per-item grant: one group on a Shared Drive root was counted once per item, which
        // is how a single missing group was reported as "88 mismatches" and totals read 878 grants
        // from a handful of real ones. Shared-drive items only — My Drive omits the field, so the
        // absence is treated as "direct" rather than assumed inherited.
        fields: 'nextPageToken, permissions(id,type,role,emailAddress,domain,allowFileDiscovery,deleted,permissionDetails)',
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
      }),
      { label: 'Drive listPermissions' }
    );
    perms.push(...(res.data.permissions || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const live = perms.filter((p) => !p.deleted);
  return {
    grants: live
      .filter((p) => p.type === 'user' || p.type === 'group')
      .map((p) => {
        // A grant is inherited when permissionDetails says so. Google reports the ancestor it came
        // from, which is what lets a drive-level grant be reported once instead of per item.
        const det = Array.isArray(p.permissionDetails) ? p.permissionDetails : [];
        const inheritedDetail = det.find((d) => d && d.inherited);
        return {
          email: (p.emailAddress || '').toLowerCase(),
          role: p.role,
          type: p.type,
          inherited: Boolean(inheritedDetail),
          inheritedFrom: inheritedDetail?.inheritedFrom || null,
        };
      }),
    links: live
      .filter((p) => p.type === 'anyone' || p.type === 'domain')
      .map((p) => ({
        type: p.type,
        role: p.role,
        domain: p.domain || null,
        allowFileDiscovery: p.allowFileDiscovery ?? null,
      })),
  };
}

/**
 * Version history for a file.
 *
 * NOTE: this count is not comparable to the destination's. Google merges smaller revisions when
 * listing and may expose only the earliest and latest for editor files, so a lower count here is
 * expected behavior — see google-shared-drive-to-sharepoint-outscope.md.
 */
async function listRevisions(fileId, email) {
  const drive = await getDriveClient(email);
  try {
    const res = await retryWithBackoff(
      () => drive.revisions.list({
        fileId,
        fields: 'revisions(id,modifiedTime,keepForever,size)',
        pageSize: 200,
      }),
      { label: 'Drive listRevisions' }
    );
    const revisions = res.data.revisions || [];
    return { totalVersions: revisions.length, revisions };
  } catch (err) {
    // Folders and some native types do not support revisions at all.
    if (err?.response?.status === 403 || err?.response?.status === 404) {
      return { totalVersions: 0, revisions: [], note: 'revisions not available for this item' };
    }
    throw err;
  }
}

module.exports = {
  getAuth,
  explainAuthError,
  verifyDwd,
  getDriveClient,
  createFolder,
  ensureFolderPath,
  uploadFile,
  uploadVersion,
  createNativeFile,
  shareFile,
  removePublicLink,
  createDomainLink,
  createSharedLink,
  getWebViewLink,
  listChildren,
  findByName,
  deleteFile,
  trashFile,
  createLinkPermission,
  // Shared Drives
  listSharedDrives,
  resolveSharedDriveByName,
  findFoldersByName,
  getSharedDriveById,
  // Read side, for content validation
  listChildrenDetailed,
  resolveFolderByPath,
  buildFolderTree,
  downloadFile,
  exportNativeFile,
  listPermissions,
  listRevisions,
  FOLDER_MIME,
};
