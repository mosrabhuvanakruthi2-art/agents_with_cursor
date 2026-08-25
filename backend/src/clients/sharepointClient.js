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
 * Delete one item (file or folder) from a site's default document library, by path.
 *
 * The only destructive call in this client. It exists because content cleanup had no way to clear a
 * SharePoint destination — /api/agents/clean-content supports Box only — so every QA run stacked
 * another copy of the migrated tree next to the last one (`Agent Files`, `Agent Files 1` …), and the
 * validation report attributed those duplicates to the migration as "extra" and "misplaced".
 *
 * Deleting a folder removes everything under it. The path is logged at warn level on purpose: this
 * is not something that should ever happen quietly.
 *
 * @param {string} siteId  Graph site id
 * @param {string} path    '/Agent Shared Drive 1' — library-root relative
 * @param {string} email   destination account (selects the tenant)
 * @returns {Promise<boolean>} true when deleted, false when the path did not exist
 */
async function deleteItemByPath(siteId, path, email) {
  const clean = `/${String(path || '').replace(/^\/+/, '')}`;
  if (clean === '/') throw new Error('deleteItemByPath: refusing to delete the library root');

  const tenant = getMsTenant(email || '');
  const token = await getAppAccessToken(tenant || '1');
  // encodeURI leaves #, ? and % unescaped, so a path like "/Special !@#$…" is truncated at the # and
  // Graph answers 404 — the delete silently reported "already absent" for exactly the special-character
  // folders this suite exists to test. Encode per segment and escape the reserved characters Graph
  // needs literally.
  const encoded = clean.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const url = `${GRAPH_BASE}/sites/${siteId}/drive/root:${encoded}`;
  logger.warn(`[SharePoint] DELETE ${clean}`);
  try {
    await retryWithBackoff(
      () => axios.delete(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 }),
      { label: `SharePoint DELETE ${clean}`, maxRetries: 2 }
    );
    return true;
  } catch (err) {
    if (err?.response?.status === 404) {
      logger.info(`[SharePoint] ${clean} already absent`);
      return false;
    }
    throw err;
  }
}
/**
 * Resolve a SharePoint site by its hostname + relative path.
 * hostname = 'filefuze.sharepoint.com', sitePath = '/sites/SANITYDATAA'
 * Returns the full site object including siteId.
 */
/**
 * The SharePoint hostname of the account's own tenant, from `/sites/root`.
 *
 * The hostname is NOT derivable from the email domain — granger@gajha.com's tenant serves SharePoint
 * at trydemos.sharepoint.com. Guessing produces an opaque Graph 400, so ask Graph instead.
 */
async function resolveTenantHostname(email) {
  const data = await graphGet(`${GRAPH_BASE}/sites/root`, email);
  return data?.siteCollection?.hostname
    || (data?.webUrl ? String(data.webUrl).replace(/^https?:\/\//, '').split('/')[0] : null);
}

async function getSite(hostname, sitePath, email) {
  const url = `${GRAPH_BASE}/sites/${hostname}:${sitePath}`;
  logger.info(`[SharePoint] getSite: GET ${url}`);
  return graphGet(url, email);
}

/**
 * Find a site by its display name via Graph search. Used when the destination path names a site
 * (e.g. "/SANITY DATAA/Documents") whose URL form is unknown — SharePoint drops or rewrites spaces,
 * so the path cannot reliably be constructed from the name.
 * Returns the site object whose displayName or URL segment matches, or null.
 */
async function findSiteByName(name, email) {
  const query = String(name || '').trim();
  if (!query) return null;
  const url = `${GRAPH_BASE}/sites?search=${encodeURIComponent(query)}`;
  logger.info(`[SharePoint] findSiteByName: GET ${url}`);
  const data = await graphGet(url, email);
  const sites = Array.isArray(data?.value) ? data.value : [];
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(query);
  return sites.find((s) => norm(s.displayName) === target || norm(s.name) === target)
    || sites.find((s) => norm(s.webUrl).endsWith(target))
    || null;
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
/**
 * @param {object} [opts]
 * @param {string} [opts.select]  Graph $select list. Graph omits some facets unless asked for —
 *   `publication` (check-out state) is one of them — but naming any field drops every default
 *   field not listed, so a caller passing this must list everything it needs.
 */
async function listFolderChildren(siteId, folderPath, email, opts = {}) {
  const suffix = opts.select ? `/children?$select=${encodeURIComponent(opts.select)}` : '/children';
  const url = driveItemUrl(siteId, folderPath, suffix);
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
 * Fields buildFolderTree needs. `publication` carries check-out state and is NOT returned by
 * default, so it must be named — and once anything is named, every other field we read has to be
 * named too or it comes back undefined.
 */
const TREE_FIELDS = [
  'id', 'name', 'size', 'folder', 'file', 'webUrl', 'parentReference',
  'createdBy', 'lastModifiedBy', 'createdDateTime', 'lastModifiedDateTime',
  'fileSystemInfo', 'publication',
].join(',');

/**
 * Build a flat tree of { name, type, path } for every item under rootPath in the default drive.
 * type = 'file' | 'folder'
 */
async function buildFolderTree(siteId, rootPath, email, maxDepth = 5, _depth = 0) {
  let items;
  try {
    items = await listFolderChildren(siteId, rootPath, email, { select: TREE_FIELDS });
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
      // A file checked out with no checked-in version is invisible to every other user in
      // SharePoint. Our reads use an app-only token, which sees it regardless — so without this
      // flag a run can report every file present while the destination user sees an empty folder.
      checkedOut: item.publication ? item.publication.level === 'checkout' : false,
      checkedOutBy: (item.publication
        && item.publication.checkedOutBy
        && item.publication.checkedOutBy.user
        && (item.publication.checkedOutBy.user.email || item.publication.checkedOutBy.user.displayName)) || null,
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
  if (!item?.id) return { found: false, permissions: [], links: [] };
  const url = `${GRAPH_BASE}/sites/${siteId}/drive/items/${item.id}/permissions`;
  try {
    logger.info(`[SharePoint] getItemPermissions: GET ${url}`);
    const data = await graphGet(url, email);
    const permissions = (Array.isArray(data?.value) ? data.value : []).map((p) => {
      const granted = p.grantedToV2 || p.grantedTo || {};
      const idsV2   = Array.isArray(p.grantedToIdentitiesV2) ? p.grantedToIdentitiesV2 : [];
      const user    = granted.user || granted.siteUser || idsV2[0]?.user || null;
      // A permission can be granted to a GROUP rather than a person. Migrations that preserve
      // group access land here, and treating a group grant as "no user access" would fail a
      // correct migration, so the principal type travels with the row.
      const group   = granted.group || granted.siteGroup || idsV2[0]?.group || null;
      const principal = user || group;
      return {
        email: (principal?.email || principal?.loginName || '').toLowerCase() || null,
        name: principal?.displayName || null,
        principalType: user ? 'user' : (group ? 'group' : 'unknown'),
        roles: Array.isArray(p.roles) ? p.roles.map((r) => String(r).toLowerCase()) : [],
        isLink: Boolean(p.link),
        linkScope: p.link?.scope || null, // 'anonymous' | 'organization' | 'users'
        linkType: p.link?.type || null,   // 'view' | 'edit' | 'embed'
      };
    });
    // Link permissions on their own, shaped for the shared-link comparison. A migrated link has to
    // preserve BOTH axes — who it reaches (scope) and what they can do (type) — so both travel here.
    const links = permissions
      .filter((p) => p.isLink)
      .map((p) => ({ scope: p.linkScope, type: p.linkType, roles: p.roles }));
    return { found: true, itemId: item.id, permissions, links };
  } catch (err) {
    if (err?.response?.status === 403 || err?.response?.status === 404) {
      return { found: true, itemId: item.id, permissions: [], links: [] };
    }
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

/**
 * Download a drive item's bytes by path, for Tier B content hashing.
 *
 * Graph serves content from a short-lived pre-authenticated redirect, so the Authorization header must
 * NOT be forwarded to the redirect target — axios follows redirects and would otherwise send the bearer
 * token to a storage host, which rejects it. The download URL is read first, then fetched unauthenticated.
 */
async function downloadItemContent(siteId, itemPath, email) {
  const item = await getFolderItem(siteId, itemPath, email);
  if (!item?.id) throw new Error(`SharePoint item not found: ${itemPath}`);

  const metaUrl = `${GRAPH_BASE}/sites/${siteId}/drive/items/${item.id}?$select=@microsoft.graph.downloadUrl,size`;
  const meta = await graphGet(metaUrl, email);
  const downloadUrl = meta?.['@microsoft.graph.downloadUrl'];
  if (!downloadUrl) throw new Error(`no download URL for ${itemPath} (a folder, or content unavailable)`);

  const res = await retryWithBackoff(
    () => axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 120000 }),
    { label: `SharePoint download ${itemPath}`, maxRetries: 2 }
  );
  return Buffer.from(res.data);
}

module.exports = {
  getSite,
  findSiteByName,
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
  downloadItemContent,
  resolveTenantHostname,
  deleteItemByPath,
};
