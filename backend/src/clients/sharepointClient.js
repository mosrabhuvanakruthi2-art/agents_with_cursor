const axios = require('axios');
const { getAppAccessToken, getMsTenant } = require('./outlookClient');
const logger = require('../utils/logger');
const { retryWithBackoff } = require('../utils/retry');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Encode a drive path for Graph's `root:/<path>` addressing: strip leading/trailing slashes,
 * then URL-encode EACH segment (so spaces/specials are escaped but the "/" separators are kept).
 * Returns '' for the drive root.
 */
function encodeDrivePath(folderPath) {
  return String(folderPath || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

/** Build the Graph drive-item URL for a path — `/drive/root` at root, `/drive/root:/<enc>` otherwise. */
function driveItemUrl(siteId, folderPath, suffix = '') {
  const enc = encodeDrivePath(folderPath);
  return enc
    ? `${GRAPH_BASE}/sites/${siteId}/drive/root:/${enc}${suffix ? `:${suffix}` : ''}`
    : `${GRAPH_BASE}/sites/${siteId}/drive/root${suffix || ''}`;
}

async function graphGet(url, email) {
  const tenant = getMsTenant(email || '');
  const token = await getAppAccessToken(tenant || '1');
  const res = await retryWithBackoff(
    () => axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
    }),
    { label: `SharePoint GET ${url.replace(GRAPH_BASE, '')}`, maxRetries: 2 }
  );
  return res.data;
}

/**
 * Resolve a SharePoint site by its hostname + relative path.
 * hostname = 'filefuze.sharepoint.com', sitePath = '/sites/SANITYDATAA'
 * Returns the full site object including siteId.
 */
async function getSite(hostname, sitePath, email) {
  const url = `${GRAPH_BASE}/sites/${hostname}:${sitePath}`;
  logger.info(`[SharePoint] getSite: GET ${url}`);
  return graphGet(url, email);
}

/**
 * Get the default document library (drive) of a SharePoint site.
 * Returns the drive object with .id field.
 */
async function getDefaultDrive(siteId, email) {
  const url = `${GRAPH_BASE}/sites/${siteId}/drive`;
  logger.info(`[SharePoint] getDefaultDrive: GET ${url}`);
  return graphGet(url, email);
}

/**
 * List immediate children of a folder path within the default drive.
 * folderPath: '/' for library root, '/Agent Box Data' for a subfolder.
 * Returns array of DriveItem objects.
 */
async function listFolderChildren(siteId, folderPath, email) {
  const url = driveItemUrl(siteId, folderPath, '/children');
  logger.info(`[SharePoint] listFolderChildren: GET ${url}`);
  const data = await graphGet(url, email);
  return Array.isArray(data?.value) ? data.value : [];
}

/**
 * Check if a folder exists at folderPath in the default drive.
 * Returns the DriveItem if found, null if 404.
 */
async function getFolderItem(siteId, folderPath, email) {
  const url = driveItemUrl(siteId, folderPath);
  try {
    logger.info(`[SharePoint] getFolderItem: GET ${url}`);
    return await graphGet(url, email);
  } catch (err) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Count files and folders one level deep inside folderPath.
 * Returns { files, folders, total, items }.
 */
async function countFolderChildren(siteId, folderPath, email) {
  try {
    const items = await listFolderChildren(siteId, folderPath, email);
    const files   = items.filter((i) => !i.folder).length;
    const folders = items.filter((i) => Boolean(i.folder)).length;
    return { files, folders, total: items.length, items };
  } catch (err) {
    if (err?.response?.status === 404) return { files: 0, folders: 0, total: 0, items: [], notFound: true };
    throw err;
  }
}

/**
 * Recursively count all files/folders within folderPath up to maxDepth levels.
 * Returns { files, folders, total }.
 */
async function countItemsRecursive(siteId, folderPath, email, maxDepth = 3, _depth = 0) {
  const { items, notFound } = await countFolderChildren(siteId, folderPath, email);
  if (notFound) return { files: 0, folders: 0, total: 0 };

  let files   = items.filter((i) => !i.folder).length;
  let folders = items.filter((i) => Boolean(i.folder)).length;

  if (_depth < maxDepth) {
    for (const item of items.filter((i) => Boolean(i.folder))) {
      const childPath = `${folderPath.replace(/\/+$/, '')}/${item.name}`;
      const child = await countItemsRecursive(siteId, childPath, email, maxDepth, _depth + 1);
      files   += child.files;
      folders += child.folders;
    }
  }

  return { files, folders, total: files + folders };
}

/**
 * Build a flat tree of { name, type, path } for every item under rootPath in the default drive.
 * type = 'file' | 'folder'
 */
async function buildFolderTree(siteId, rootPath, email, maxDepth = 5, _depth = 0) {
  let items;
  try {
    items = await listFolderChildren(siteId, rootPath, email);
  } catch (err) {
    if (err?.response?.status === 404) return [];
    throw err;
  }
  const result = [];
  for (const item of items) {
    const type = item.folder ? 'folder' : 'file';
    const itemPath = `${rootPath.replace(/\/+$/, '')}/${item.name}`;
    const fs = item.fileSystemInfo || {};
    result.push({
      name: item.name,
      type,
      path: itemPath,
      id: item.id || null,
      size: item.size ?? null,
      // fileSystemInfo carries the migrated (preserved) create/modify times; fall back to the
      // DriveItem's own timestamps when absent.
      createdAt: fs.createdDateTime || item.createdDateTime || null,
      modifiedAt: fs.lastModifiedDateTime || item.lastModifiedDateTime || null,
      createdBy: (item.createdBy?.user?.email || item.createdBy?.user?.displayName || '').toLowerCase() || null,
      modifiedBy: (item.lastModifiedBy?.user?.email || item.lastModifiedBy?.user?.displayName || '').toLowerCase() || null,
    });
    if (type === 'folder' && _depth < maxDepth) {
      const children = await buildFolderTree(siteId, itemPath, email, maxDepth, _depth + 1);
      result.push(...children);
    }
  }
  return result;
}

/**
 * List permissions on a SharePoint drive item (identified by its path).
 * Returns [{ email, name, roles: ['read'|'write'|'owner'|...], isLink, linkScope }].
 * Graph permission roles: 'read', 'write', 'owner', 'sp.full control', etc.
 */
async function getItemPermissions(siteId, itemPath, email) {
  const item = await getFolderItem(siteId, itemPath, email);
  if (!item?.id) return { found: false, permissions: [] };
  const url = `${GRAPH_BASE}/sites/${siteId}/drive/items/${item.id}/permissions`;
  try {
    logger.info(`[SharePoint] getItemPermissions: GET ${url}`);
    const data = await graphGet(url, email);
    const permissions = (Array.isArray(data?.value) ? data.value : []).map((p) => {
      const granted = p.grantedToV2 || p.grantedTo || {};
      const idsV2   = Array.isArray(p.grantedToIdentitiesV2) ? p.grantedToIdentitiesV2 : [];
      const user    = granted.user || granted.siteUser || idsV2[0]?.user || null;
      return {
        email: (user?.email || user?.loginName || '').toLowerCase() || null,
        name: user?.displayName || granted.user?.displayName || null,
        roles: Array.isArray(p.roles) ? p.roles.map((r) => String(r).toLowerCase()) : [],
        isLink: Boolean(p.link),
        linkScope: p.link?.scope || null, // 'anonymous' | 'organization' | 'users'
      };
    });
    return { found: true, itemId: item.id, permissions };
  } catch (err) {
    if (err?.response?.status === 403 || err?.response?.status === 404) return { found: true, itemId: item.id, permissions: [] };
    throw err;
  }
}

/**
 * Count versions of a SharePoint drive item (by path).
 * Returns { found, totalVersions }.
 */
async function getItemVersions(siteId, itemPath, email) {
  const item = await getFolderItem(siteId, itemPath, email);
  if (!item?.id) return { found: false, totalVersions: 0 };
  const url = `${GRAPH_BASE}/sites/${siteId}/drive/items/${item.id}/versions`;
  try {
    logger.info(`[SharePoint] getItemVersions: GET ${url}`);
    const data = await graphGet(url, email);
    return { found: true, totalVersions: Array.isArray(data?.value) ? data.value.length : 0 };
  } catch (err) {
    if (err?.response?.status === 403 || err?.response?.status === 404) return { found: true, totalVersions: 0 };
    throw err;
  }
}

/**
 * Read a drive item's timestamps (by path). Returns { found, createdDateTime, lastModifiedDateTime }.
 * fileSystemInfo carries the migrated/preserved times; falls back to the item's own timestamps.
 */
async function getItemInfo(siteId, itemPath, email) {
  const item = await getFolderItem(siteId, itemPath, email);
  if (!item?.id) return { found: false };
  const fs = item.fileSystemInfo || {};
  return {
    found: true,
    itemId: item.id,
    name: item.name,
    size: item.size ?? null,
    createdDateTime: fs.createdDateTime || item.createdDateTime || null,
    lastModifiedDateTime: fs.lastModifiedDateTime || item.lastModifiedDateTime || null,
    createdBy: (item.createdBy?.user?.email || item.createdBy?.user?.displayName || '').toLowerCase() || null,
    modifiedBy: (item.lastModifiedBy?.user?.email || item.lastModifiedBy?.user?.displayName || '').toLowerCase() || null,
  };
}

/**
 * Read a drive item's SharePoint list-item columns (metadata) by path.
 * Returns { found, fields } where fields excludes system columns when possible.
 */
async function getItemMetadata(siteId, itemPath, email) {
  const item = await getFolderItem(siteId, itemPath, email);
  if (!item?.id) return { found: false, fields: {} };
  const url = `${GRAPH_BASE}/sites/${siteId}/drive/items/${item.id}/listItem?$expand=fields`;
  try {
    logger.info(`[SharePoint] getItemMetadata: GET ${url}`);
    const data = await graphGet(url, email);
    return { found: true, fields: data?.fields || {} };
  } catch (err) {
    if (err?.response?.status === 403 || err?.response?.status === 404) return { found: true, fields: {} };
    throw err;
  }
}

module.exports = {
  getSite,
  getDefaultDrive,
  listFolderChildren,
  getFolderItem,
  countFolderChildren,
  countItemsRecursive,
  buildFolderTree,
  getItemPermissions,
  getItemVersions,
  getItemInfo,
  getItemMetadata,
};
