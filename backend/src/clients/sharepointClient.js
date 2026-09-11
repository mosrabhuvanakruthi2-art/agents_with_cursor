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

/**
 * Build the Graph drive-item URL for a path — `/drive/root` at root, `/drive/root:/<enc>` otherwise.
 *
 * `opts.driveId` addresses a NAMED document library instead of the site's default one. A site can
 * hold many libraries (SharePoint calls the default one "Documents"), and the SharePoint → Google
 * Shared Drive scope has a feature about exactly that — 15.1 Custom Library. Every read below
 * therefore accepts the same option and defaults to the site drive, so no existing caller changes
 * behaviour.
 */
function driveItemUrl(siteId, folderPath, suffix = '', opts = {}) {
  const enc = encodeDrivePath(folderPath);
  const base = opts && opts.driveId
    ? `${GRAPH_BASE}/drives/${opts.driveId}`
    : `${GRAPH_BASE}/sites/${siteId}/drive`;
  return enc
    ? `${base}/root:/${enc}${suffix ? `:${suffix}` : ''}`
    : `${base}/root${suffix || ''}`;
}

/** `/drives/<id>/items/<itemId>` when a library is named, else the site's default drive. */
function driveItemsBase(siteId, opts = {}) {
  return opts && opts.driveId
    ? `${GRAPH_BASE}/drives/${opts.driveId}/items`
    : `${GRAPH_BASE}/sites/${siteId}/drive/items`;
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
/**
 * Create every missing segment of a folder path inside the site's default document library.
 *
 * Exists so a multi-drive run can put each source drive in its own destination folder without
 * anyone pre-creating them by hand: the requester supplies one base path ("/QA/Documents") and each
 * row's drive name becomes a sub-folder under it.
 *
 * The alternative was CloudFuze's `migrateFolderName` job field, but that has never been sent
 * non-blank against this server, and whether CloudFuze creates a missing destination path segment
 * is equally unproven. Creating it ourselves is verifiable before the migration starts, and is
 * symmetric with deleteItemByPath, which cleanup already uses.
 *
 * Idempotent — an existing segment is left alone. Returns the paths actually created.
 */
async function ensureFolderPath(siteId, folderPath, email) {
  const segs = String(folderPath || '').split('/').map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return [];

  const tenant = getMsTenant(email || '');
  const created = [];
  let current = '';
  for (const seg of segs) {
    const parent = current;
    current = `${current}/${seg}`;
    // A GET first keeps this idempotent and keeps the log honest about what was actually created.
    if (await getFolderItem(siteId, current, email)) continue;

    const token = await getAppAccessToken(tenant || '1');
    const url = driveItemUrl(siteId, parent, '/children');
    logger.info(`[SharePoint] CREATE FOLDER ${current}`);
    try {
      await retryWithBackoff(
        () => axios.post(
          url,
          { name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 60000 }
        ),
        { label: `SharePoint CREATE ${current}`, maxRetries: 2 }
      );
      created.push(current);
    } catch (err) {
      // 409 means it appeared between the GET and the POST — a concurrent run, or a retry landing
      // twice. Either way the folder now exists, which is all the caller needs.
      if (err?.response?.status === 409) {
        logger.info(`[SharePoint] ${current} already exists`);
        continue;
      }
      throw err;
    }
  }
  return created;
}

async function deleteItemByPath(siteId, path, email, opts = {}) {
  const clean = `/${String(path || '').replace(/^\/+/, '')}`;
  if (clean === '/') throw new Error('deleteItemByPath: refusing to delete the library root');

  const tenant = getMsTenant(email || '');
  const token = await getAppAccessToken(tenant || '1');
  // encodeURI leaves #, ? and % unescaped, so a path like "/Special !@#$…" is truncated at the # and
  // Graph answers 404 — the delete silently reported "already absent" for exactly the special-character
  // folders this suite exists to test. Encode per segment and escape the reserved characters Graph
  // needs literally.
  const encoded = clean.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  // `opts.driveId` targets a named library. Without it this always addressed the site's DEFAULT
  // drive, so a delete aimed at a custom library silently hit the same path in Documents — the
  // wrong drive, and possibly a real folder of someone else's.
  const driveBase = opts && opts.driveId
    ? `${GRAPH_BASE}/drives/${opts.driveId}`
    : `${GRAPH_BASE}/sites/${siteId}/drive`;
  const url = `${driveBase}/root:${encoded}`;
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
 * Resolve a site for ONE ACCOUNT, trying a preferred hostname and then that account's own tenant.
 *
 * The hostname is not derivable from the email domain — granger@gajha.com's tenant serves
 * SharePoint at trydemos.sharepoint.com — and a configured hostname belonging to a DIFFERENT tenant
 * answers HTTP 400, not 404. That is what happened on the first SharePoint → Shared Drive run:
 * SHAREPOINT_SOURCE_HOSTNAME named filefuze.sharepoint.com while the run's source account was in the
 * gajha tenant, so CleanupAgent gave up with "status code 400" and cleaned nothing, while the
 * seeding agent — which had this fallback — went on to seed trydemos correctly. Two components
 * disagreeing about where the data lives is worse than either being wrong.
 *
 * One implementation, used by the seeder, the validator and cleanup, so they cannot drift.
 *
 * @returns {{ siteId, hostname, sitePath, tried: string[] }}
 * @throws when no candidate resolves — with every attempt listed, because "site not reachable" and
 *   "wrong tenant" need different fixes and the caller cannot tell them apart otherwise.
 */
async function resolveSiteForAccount(email, sitePath, preferredHostname = null) {
  const path = String(sitePath || '').trim();
  if (!path) throw new Error('resolveSiteForAccount: a site path is required (e.g. /sites/QA)');

  const candidates = [];
  if (preferredHostname) candidates.push(String(preferredHostname).trim());
  try {
    const tenantHost = await resolveTenantHostname(email);
    if (tenantHost && !candidates.includes(tenantHost)) candidates.push(tenantHost);
  } catch (err) {
    logger.warn(`[SharePoint] could not read the tenant hostname for ${email}: ${err.message}`);
  }

  const tried = [];
  for (const hostname of candidates) {
    try {
      const site = await getSite(hostname, path, email);
      if (site?.id) {
        if (preferredHostname && hostname !== preferredHostname) {
          logger.info(`[SharePoint] ${preferredHostname}${path} did not resolve for ${email} — `
            + `using that account's own tenant ${hostname}${path}`);
        }
        // displayName travels too: CloudFuze addresses a SharePoint cloud by the site's DISPLAY
        // name ("/SS test/Documents"), which is not the URL slug — "SS test" has a space in it.
        return {
          siteId: site.id,
          hostname,
          sitePath: path,
          displayName: site.displayName || site.name || null,
          tried,
        };
      }
      tried.push(`${hostname}${path} (no id)`);
    } catch (err) {
      tried.push(`${hostname}${path} (${err?.response?.status || err.message})`);
    }
  }
  throw new Error(
    `SharePoint site ${path} is not reachable for ${email}. Tried ${tried.join(', ') || '(no candidate hostname)'}. `
    + 'A 400 here usually means the hostname belongs to a different tenant than the account; a 403 '
    + 'means the app lacks consent in this tenant.'
  );
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
  const url = driveItemUrl(siteId, folderPath, suffix, opts);
  logger.info(`[SharePoint] listFolderChildren: GET ${url}`);
  const data = await graphGet(url, email);
  return Array.isArray(data?.value) ? data.value : [];
}

/**
 * Check if a folder exists at folderPath in the default drive.
 * Returns the DriveItem if found, null if 404.
 */
async function getFolderItem(siteId, folderPath, email, opts = {}) {
  const url = driveItemUrl(siteId, folderPath, '', opts);
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
async function buildFolderTree(siteId, rootPath, email, maxDepth = 5, _depth = 0, opts = {}) {
  let items;
  try {
    items = await listFolderChildren(siteId, rootPath, email, { select: TREE_FIELDS, ...opts });
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
      const children = await buildFolderTree(siteId, itemPath, email, maxDepth, _depth + 1, opts);
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
async function getItemPermissions(siteId, itemPath, email, opts = {}) {
  const item = await getFolderItem(siteId, itemPath, email, opts);
  if (!item?.id) return { found: false, permissions: [], links: [] };
  const url = `${driveItemsBase(siteId, opts)}/${item.id}/permissions`;
  try {
    logger.info(`[SharePoint] getItemPermissions: GET ${url}`);
    const data = await graphGet(url, email);
    const permissions = (Array.isArray(data?.value) ? data.value : []).map((p) => {
      const granted = p.grantedToV2 || p.grantedTo || {};
      const idsV2   = Array.isArray(p.grantedToIdentitiesV2) ? p.grantedToIdentitiesV2 : [];
      // GROUP is resolved FIRST, and that order is the whole point. Graph returns a group grant
      // as { group, siteUser } — a siteUser entry exists for groups as well as for people — so
      // testing siteUser first classified every migrated group as a USER whose "email" was
      // SharePoint's claims string (c:0t.c|tenant|<objectId>). Nothing can ever match that, so a
      // migration that had preserved group access correctly was reported as failing.
      const group   = granted.group || granted.siteGroup || idsV2[0]?.group || null;
      const user    = group ? null : (granted.user || idsV2[0]?.user || granted.siteUser || null);
      const principal = group || user;
      return {
        // A group from another tenant often carries no email at all, only a displayName, so the
        // name travels separately and group matching falls back to it.
        email: (principal?.email || principal?.loginName || '').toLowerCase() || null,
        name: principal?.displayName || null,
        principalType: group ? 'group' : (user ? 'user' : 'unknown'),
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
async function getItemVersions(siteId, itemPath, email, opts = {}) {
  const item = await getFolderItem(siteId, itemPath, email, opts);
  if (!item?.id) return { found: false, totalVersions: 0 };
  const url = `${driveItemsBase(siteId, opts)}/${item.id}/versions`;
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
async function getItemInfo(siteId, itemPath, email, opts = {}) {
  const item = await getFolderItem(siteId, itemPath, email, opts);
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
async function getItemMetadata(siteId, itemPath, email, opts = {}) {
  const item = await getFolderItem(siteId, itemPath, email, opts);
  if (!item?.id) return { found: false, fields: {} };
  const url = `${driveItemsBase(siteId, opts)}/${item.id}/listItem?$expand=fields`;
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
async function downloadItemContent(siteId, itemPath, email, opts = {}) {
  const item = await getFolderItem(siteId, itemPath, email, opts);
  if (!item?.id) throw new Error(`SharePoint item not found: ${itemPath}`);

  // Read the bytes through /content rather than resolving @microsoft.graph.downloadUrl first.
  //
  // Graph does NOT return that annotation when it is named in $select: the response comes back with
  // only @odata.context, @odata.etag and size, so the download URL was always undefined and every
  // call threw "no download URL (a folder, or content unavailable)" — for ordinary files that
  // download perfectly well. Verified against the live tenant: with $select the annotation is
  // absent, without it present, and /content returns the bytes directly.
  //
  // Latent until now only because Tier B file hashing is off by default; switching
  // CONTENT_DEEP_VALIDATE_FILE_HASH on would have failed the hash of every single file.
  // /content also costs one request instead of two.
  const contentUrl = `${driveItemsBase(siteId, opts)}/${item.id}/content`;
  const token = await getAppAccessToken(getMsTenant(email || '') || '1');
  const res = await retryWithBackoff(
    () => axios.get(contentUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: 120000,
    }),
    { label: `SharePoint download ${itemPath}`, maxRetries: 2 }
  );
  return Buffer.from(res.data);
}

// ─── Write helpers (source-side seeding) ──────────────────────────────────────
//
// Everything above reads SharePoint, because SharePoint had only ever been a migration
// DESTINATION in this repo. SharePoint → Google Shared Drive makes it a SOURCE, and a source has to
// be seeded before it can be migrated — so these are the create/upload/share calls
// SharePointTestDataAgent needs, in the same style as the reads: app-only token, retryWithBackoff,
// and the same optional `opts.driveId` for a named document library.
//
// Graph permission required on the app registration: Sites.ReadWrite.All (or Files.ReadWrite.All).
// A 403 here while the reads work means the app has read consent only — that is a configuration
// error, and the seeding agent reports it as one rather than continuing with no data.

/**
 * Graph's own explanation of a failure, pulled out of the response body.
 *
 * Axios only ever says "Request failed with status code 400", and that is what every seeding
 * warning showed — five scenarios reported as unseeded with no way to tell a blocked tenant policy
 * from a bad payload from a principal that does not exist. Graph always says which in
 * `error.code` / `error.message`; it was simply being discarded.
 *
 * Returns the original message unchanged when there is no Graph body (a socket error, a timeout).
 */
function graphErrorDetail(err) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const inner = body?.error || body;
  const code = inner?.code || inner?.error || null;
  const message = inner?.message || inner?.error_description || null;
  if (!code && !message) {
    return status ? `HTTP ${status}: ${err.message}` : err.message;
  }
  return `HTTP ${status} ${code || ''}${code && message ? ' — ' : ''}${message || ''}`.trim();
}

/** Wrap an axios failure so the thrown Error carries Graph's reason, keeping `response` intact. */
function enrichGraphError(err, label) {
  const detail = graphErrorDetail(err);
  const wrapped = new Error(`${label}: ${detail}`);
  wrapped.response = err.response;
  wrapped.graphCode = err?.response?.data?.error?.code || null;
  wrapped.status = err?.response?.status || null;
  wrapped.cause = err;
  return wrapped;
}

/**
 * POST/PUT/PATCH with the app-only token for this account's tenant.
 *
 * No retry guard needed: utils/retry.js already breaks out on any 4xx except 429, which is right —
 * a 400 from Graph is a verdict about the request (a blocked sharing policy, an unknown principal,
 * a path over the limit) and re-sending it unchanged would only add backoff to an instant answer.
 */
async function graphWrite(method, url, body, email, extra = {}) {
  const tenant = getMsTenant(email || '');
  const token = await getAppAccessToken(tenant || '1');
  const label = `SharePoint ${method.toUpperCase()} ${String(url).replace(GRAPH_BASE, '')}`;
  try {
    const res = await retryWithBackoff(() => axios({
      method,
      url,
      data: body,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': extra.contentType || 'application/json',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: extra.timeout || 120000,
    }), { label, maxRetries: 2 });
    return res.data;
  } catch (err) {
    throw enrichGraphError(err, label);
  }
}

/**
 * Every document library on a site — the default "Documents" plus any custom library.
 *
 * Feature 15.1 (Custom Library) is a question about a library that is NOT the default one, so the
 * suite has to be able to find one by name and read it. Returns Graph drive objects.
 */
async function listDrives(siteId, email) {
  const data = await graphGet(`${GRAPH_BASE}/sites/${siteId}/drives`, email);
  return Array.isArray(data?.value) ? data.value : [];
}

/** One library by display name (case-insensitive), or null. */
async function findDriveByName(siteId, name, email) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const drives = await listDrives(siteId, email);
  return drives.find((d) => String(d.name || '').trim().toLowerCase() === want) || null;
}

/**
 * Create a custom document library on the site, or return the existing one of that name.
 *
 * Graph creates a library as a LIST with the documentLibrary template; the matching `drive` then
 * appears under /sites/{id}/drives, which is what every read here addresses. The list id and the
 * drive id are different ids for the same library — the drive id is the useful one, so it is
 * resolved and returned.
 */
async function ensureDocumentLibrary(siteId, displayName, email) {
  const existing = await findDriveByName(siteId, displayName, email);
  if (existing) {
    logger.info(`[SharePoint] library "${displayName}" already exists (${existing.id})`);
    return existing;
  }
  logger.info(`[SharePoint] CREATE LIBRARY ${displayName}`);
  await graphWrite('post', `${GRAPH_BASE}/sites/${siteId}/lists`, {
    displayName,
    list: { template: 'documentLibrary' },
  }, email);

  // The drive behind a just-created list is not always visible on the first read.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const drive = await findDriveByName(siteId, displayName, email);
    if (drive) return drive;
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Not something the caller can paper over: without the drive id nothing can be written into the
  // library, and falling back to the default drive would seed feature 15.1 in the wrong place while
  // the log still said "custom library".
  throw new Error(
    `SharePoint library "${displayName}" was created but its drive never appeared under `
    + `/sites/${siteId}/drives — cannot seed into it`
  );
}

/**
 * Create one folder under `parentPath`. Idempotent — an existing folder is returned as-is.
 * @returns {object} the driveItem
 */
async function createFolder(siteId, parentPath, name, email, opts = {}) {
  const path = `${String(parentPath || '').replace(/\/+$/, '')}/${name}`;
  const existing = await getFolderItem(siteId, path, email, opts);
  if (existing) return existing;
  const url = driveItemUrl(siteId, parentPath, '/children', opts);
  logger.info(`[SharePoint] CREATE FOLDER ${path}`);
  try {
    return await graphWrite('post', url, {
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    }, email, { timeout: 60000 });
  } catch (err) {
    // 409: it appeared between the GET and the POST (a retry landing twice, or a concurrent run).
    if (err?.response?.status === 409) return getFolderItem(siteId, path, email, opts);
    throw err;
  }
}

/**
 * Upload (or overwrite) a file by path.
 *
 * Uploading the same path again creates a NEW VERSION in SharePoint — that is how feature 10.1
 * (Version History) is seeded, since Graph has no "add a version" call.
 *
 * Simple PUT only: every fixture this suite writes is a few KB, far below Graph's ~4 MB
 * simple-upload ceiling. A large-file case would need createUploadSession, as outlookClient's
 * OneDrive uploader does; that is deliberately not duplicated here for files that never need it.
 */
async function uploadFile(siteId, folderPath, name, content, email, opts = {}) {
  const path = `${String(folderPath || '').replace(/\/+$/, '')}/${name}`;
  const url = driveItemUrl(siteId, path, '/content', opts);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  logger.info(`[SharePoint] UPLOAD ${path} (${body.length} bytes)`);
  return graphWrite('put', url, body, email, { contentType: 'application/octet-stream' });
}

/**
 * Grant a user or group access to one item — features 3.1 / 4.1 / 5.1 / 6.1 / 8.1.
 *
 * `sendInvitation: false` by default, which is what SharePoint's own "don't notify people" checkbox
 * does. Feature 13.1 asks whether the DESTINATION suppresses its notifications, so seeding must not
 * fill the same mailboxes with its own invitations — otherwise the two are indistinguishable.
 *
 * @param {'read'|'write'} role
 * @returns {Array} the permission objects Graph created
 */
async function invitePermission(
  siteId, itemPath, { emails, role = 'read', sendInvitation = false, message } = {}, email, opts = {}
) {
  const item = await getFolderItem(siteId, itemPath, email, opts);
  if (!item?.id) throw new Error(`SharePoint invitePermission: ${itemPath} not found`);
  const recipients = (Array.isArray(emails) ? emails : [emails])
    .map((e) => String(e || '').trim())
    .filter(Boolean)
    .map((e) => ({ email: e }));
  if (recipients.length === 0) throw new Error('SharePoint invitePermission: no recipients');

  const url = `${driveItemsBase(siteId, opts)}/${item.id}/invite`;
  logger.info(`[SharePoint] INVITE ${itemPath} → ${recipients.map((r) => r.email).join(', ')} as ${role}`);
  const data = await graphWrite('post', url, {
    recipients,
    roles: [role],
    requireSignIn: true,
    sendInvitation,
    ...(message ? { message } : {}),
  }, email, { timeout: 60000 });
  return Array.isArray(data?.value) ? data.value : [];
}

/**
 * Create a sharing link on one item — feature 7.1 (Shared links).
 *
 * Both axes are the caller's choice because both are validated at the destination: `scope` is who
 * the link reaches ('organization' | 'anonymous') and `type` is what they can do ('view' | 'edit').
 * A tenant that forbids anonymous links answers 400/403 here, and the caller records that as a
 * seeding gap rather than letting the feature read as exercised.
 */
async function createSharingLink(
  siteId, itemPath, { type = 'view', scope = 'organization' } = {}, email, opts = {}
) {
  const item = await getFolderItem(siteId, itemPath, email, opts);
  if (!item?.id) throw new Error(`SharePoint createSharingLink: ${itemPath} not found`);
  const url = `${driveItemsBase(siteId, opts)}/${item.id}/createLink`;
  logger.info(`[SharePoint] CREATE LINK ${itemPath} ${scope}/${type}`);
  const data = await graphWrite('post', url, { type, scope }, email, { timeout: 60000 });
  return {
    webUrl: data?.link?.webUrl || null,
    scope: data?.link?.scope || scope,
    type: data?.link?.type || type,
  };
}

module.exports = {
  getSite,
  resolveSiteForAccount,
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
  ensureFolderPath,
  deleteItemByPath,
  // Write side — used by SharePointTestDataAgent to seed a SharePoint SOURCE.
  listDrives,
  findDriveByName,
  ensureDocumentLibrary,
  createFolder,
  uploadFile,
  invitePermission,
  createSharingLink,
  // Exported for the unit tests: addressing is where a named-library bug would hide, and a wrong
  // drive means reading (or deleting) the same path in the default library instead.
  driveItemUrl,
};
