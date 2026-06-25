const fs = require('fs');
const { google } = require('googleapis');
const env = require('../config/env');
const tokenStore = require('./oauthTokenStore');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

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

const SERVICE_ACCOUNT_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
];

/** Returns a service-account JWT auth client impersonating the given user (DWD tenants). */
function getServiceAccountAuth(email) {
  const tenant = getGoogleTenant(email);
  const keyPath = tenant === '2' ? env.GOOGLE_SERVICE_ACCOUNT_KEY_2 : env.GOOGLE_SERVICE_ACCOUNT_KEY_3;
  if (!keyPath) throw new Error(`GOOGLE_SERVICE_ACCOUNT_KEY_${tenant} not set in .env`);
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

/** Resolve auth for an email: service account (DWD) if available, else stored OAuth token. */
async function getAuth(email) {
  const tenant = getGoogleTenant(email);
  if (tenant === '2' || tenant === '3') {
    const hasKey = tenant === '2' ? !!env.GOOGLE_SERVICE_ACCOUNT_KEY_2 : !!env.GOOGLE_SERVICE_ACCOUNT_KEY_3;
    if (hasKey) return getServiceAccountAuth(email);
  }
  const token = await tokenStore.get(email);
  if (!token) throw new Error(`No OAuth token found for ${email}. Authenticate via /auth/google first.`);
  return getAuthForToken(token, email);
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
    });
    return res.data;
  });
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
  const res = await drive.permissions.list({ fileId, fields: 'permissions(id,type)' });
  const anyonePerm = (res.data.permissions || []).find((p) => p.type === 'anyone');
  if (anyonePerm) {
    await drive.permissions.delete({ fileId, permissionId: anyonePerm.id });
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
    });
    const res = await drive.files.get({ fileId, fields: 'webViewLink' });
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
    });
    // Fetch and return the shareable URL
    const res = await drive.files.get({ fileId, fields: 'webViewLink' });
    return res.data.webViewLink;
  });
}

/**
 * Get the webViewLink of an existing file without changing its permissions.
 */
async function getWebViewLink(fileId, email) {
  const drive = await getDriveClient(email);
  const res = await drive.files.get({ fileId, fields: 'webViewLink' });
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
  const res = await drive.files.list({ q, fields: 'files(id, name, mimeType)', pageSize: 1 });
  return res.data.files?.[0] || null;
}

/**
 * Delete a file or folder permanently.
 */
async function deleteFile(fileId, email) {
  const drive = await getDriveClient(email);
  await drive.files.delete({ fileId });
}

/**
 * Move a file to Trash.
 */
async function trashFile(fileId, email) {
  const drive = await getDriveClient(email);
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}

module.exports = {
  getAuth,
  getDriveClient,
  createFolder,
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
};