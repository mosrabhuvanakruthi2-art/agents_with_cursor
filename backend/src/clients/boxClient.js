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

async function getValidToken(adminEmail) {
  const devToken = process.env.BOX_DEVELOPER_TOKEN;
  const tokenStore = require('./oauthTokenStore');
  const stored = tokenStore.getBoxToken(adminEmail);

  // If no stored token or it has no accessToken, fall back to developer token
  if (!stored || !stored.accessToken) {
    if (devToken) return devToken;
    throw new Error(`No Box token for ${adminEmail}. Set BOX_DEVELOPER_TOKEN in .env or connect via OAuth at GET /api/auth/box/url`);
  }

  if (!stored.expiresAt || Date.now() >= stored.expiresAt - 60_000) {
    if (!stored.refreshToken) {
      if (devToken) return devToken;
      throw new Error(`No Box refresh token for ${adminEmail}. Please reconnect or set BOX_DEVELOPER_TOKEN.`);
    }
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: process.env.BOX_CLIENT_ID,
      client_secret: process.env.BOX_CLIENT_SECRET,
    });
    const res = await axios.post(BOX_TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const { access_token, refresh_token, expires_in } = res.data;
    tokenStore.setBoxToken({
      email: adminEmail,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + expires_in * 1000,
    });
    logger.info(`[boxClient] Token refreshed for ${adminEmail}`);
    return access_token;
  }
  return stored.accessToken;
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
  const res = await axios.get(`${BOX_API}/users`, {
    headers: authHeaders(token),
    params: { fields: 'id,login,name,status', user_type: 'managed', limit: 1000 },
  });
  return (res.data.entries || []).filter((u) => u.status === 'active');
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

async function uploadFile(name, fileBuffer, parentId, token, asUserId = null) {
  const { body, contentType } = buildMultipart(
    { name, parent: { id: String(parentId) } },
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

// ─── Shared links ─────────────────────────────────────────────────────────────

async function createSharedLink(itemType, itemId, token, asUserId = null) {
  const endpoint = itemType === 'file' ? 'files' : 'folders';
  const body = {
    shared_link: {
      access: 'open',
      ...(itemType === 'file' ? { permissions: { can_download: true, can_preview: true } } : {}),
    },
  };
  const res = await axios.put(`${BOX_API}/${endpoint}/${itemId}?fields=shared_link`, body, {
    headers: { ...authHeaders(token, asUserId), 'Content-Type': 'application/json' },
  });
  return res.data.shared_link?.url || null;
}

module.exports = { getValidToken, getMe, getUsers, createFolder, uploadFile, uploadVersion, createSharedLink };
