const axios = require('axios');
const { getAppAccessToken, getMsTenant } = require('./outlookClient');
const logger = require('../utils/logger');
const { retryWithBackoff } = require('../utils/retry');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

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
  const encoded = encodeURIComponent(folderPath.replace(/^\/+/, ''));
  const url = (!folderPath || folderPath === '/')
    ? `${GRAPH_BASE}/sites/${siteId}/drive/root/children`
    : `${GRAPH_BASE}/sites/${siteId}/drive/root:/${encoded}:/children`;
  logger.info(`[SharePoint] listFolderChildren: GET ${url}`);
  const data = await graphGet(url, email);
  return Array.isArray(data?.value) ? data.value : [];
}

/**
 * Check if a folder exists at folderPath in the default drive.
 * Returns the DriveItem if found, null if 404.
 */
async function getFolderItem(siteId, folderPath, email) {
  const encoded = encodeURIComponent(folderPath.replace(/^\/+/, ''));
  const url = `${GRAPH_BASE}/sites/${siteId}/drive/root:/${encoded}`;
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
    result.push({ name: item.name, type, path: itemPath });
    if (type === 'folder' && _depth < maxDepth) {
      const children = await buildFolderTree(siteId, itemPath, email, maxDepth, _depth + 1);
      result.push(...children);
    }
  }
  return result;
}

module.exports = {
  getSite,
  getDefaultDrive,
  listFolderChildren,
  getFolderItem,
  countFolderChildren,
  countItemsRecursive,
  buildFolderTree,
};
