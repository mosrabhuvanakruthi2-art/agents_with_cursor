/**
 * OneDrive for Business client — the destination side of `googleshareddrive → onedrive`.
 *
 * WHY A SEPARATE FILE, when sharepointClient already speaks Graph driveItem.
 *
 * Everything below the drive root is identical between the two: children, permissions and content
 * are the same `driveItem` shapes at the same sub-paths. Only the ROOT differs —
 * `/sites/{siteId}/drive` for a document library, `/users/{upn}/drive` for a personal one. So this
 * could have been three lines in sharepointClient.
 *
 * It is not, because that file is imported by four live combinations (box→sharepoint,
 * googledrive→sharepoint, dropbox→sharepoint, googleshareddrive→sharepoint). Threading a second
 * root through its every function to serve a fifth would put all four at risk of a regression for
 * no benefit to them. The permission normalisation below is deliberately copied rather than shared,
 * for the same reason — see the note on resolveGrant.
 *
 * REACHING A ONEDRIVE AT ALL — two things cost a day to learn, so they are written down.
 *
 *   1. `/users/{upn}/drive` needs the `Files.*` application permission. Without it Graph answers
 *      `404 itemNotFound`, NOT `403` — it hides resources you may not see. On tenant
 *      0de6d210 the app held Mail, Calendar, Chat, Directory and User roles but no Files role, and
 *      every drive in the tenant read as "does not exist", including ordinary SharePoint sites.
 *      A 404 here means "check consent" at least as often as it means "no such drive".
 *
 *   2. The personal SITE (`/sites/{tenant}-my.sharepoint.com:/personal/{user}`) resolves with only
 *      Sites permission, so a site that reads fine while its `/drives` list comes back EMPTY is the
 *      signature of the missing Files role — not of an unprovisioned OneDrive.
 *
 * Read-only by design apart from deleteItemByPath, which content cleanup needs so a re-run does not
 * stack another copy of the migrated tree beside the last one.
 */
const axios = require('axios');
const { getAppAccessToken, getMsTenant } = require('./outlookClient');
const logger = require('../utils/logger');
const { retryWithBackoff } = require('../utils/retry');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Percent-encode a drive path segment by segment.
 *
 * Encoding the whole path in one call would escape the separators too, turning `a/b` into one
 * segment named "a/b" — which Graph answers with 404 and reads exactly like a missing folder.
 */
function encodeDrivePath(p) {
  return String(p || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

async function graphGet(url, upn) {
  const token = await getAppAccessToken(getMsTenant(upn || ''));
  const res = await retryWithBackoff(
    () => axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }),
    { label: `OneDrive GET ${url.replace(GRAPH_BASE, '')}`, maxRetries: 2 }
  );
  return res.data;
}

/**
 * The user's OneDrive.
 *
 * @returns {{ id, driveType, webUrl, owner }}
 * @throws with a diagnosis rather than a bare 404, because the two causes need different fixes.
 */
async function resolveDrive(upn) {
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(upn)}/drive`;
  try {
    const d = await graphGet(url, upn);
    logger.info(`[OneDrive] resolved drive for ${upn}: ${d.driveType} ${d.webUrl || ''}`);
    return {
      id: d.id,
      driveType: d.driveType || null,
      webUrl: d.webUrl || null,
      owner: d.owner?.user?.displayName || null,
    };
  } catch (err) {
    if (err?.response?.status === 404) {
      const e = new Error(
        `OneDrive for ${upn} is not readable (Graph answered 404 itemNotFound). Two causes look `
        + 'identical here and Graph does not distinguish them: (a) the app has no Files.* '
        + 'application permission consented in this tenant — Graph hides what you may not see, so '
        + 'a permission gap reads as "not found"; (b) the user genuinely has no OneDrive '
        + 'provisioned. To tell them apart, read the app token\'s `roles` claim: no Files.* role '
        + 'means (a), and an admin grants consent at '
        + 'https://login.microsoftonline.com/<tenantId>/adminconsent?client_id=<appId>.'
      );
      e.status = 404;
      e.diagnosis = 'missing-files-permission-or-unprovisioned';
      throw e;
    }
    throw err;
  }
}

/**
 * Every principal the DESTINATION tenant holds, indexed by local part.
 *
 * WHY A SEEDING AGENT NEEDS THIS.
 *
 * A grant only migrates if CloudFuze can say who the grantee BECOMES at the destination. It reads
 * that from the permission-mapping CSV, which is built from the run's `userEmailMappings` — and a
 * run that maps only the migrating user (erik -> granger) has told CloudFuze nothing about the
 * collaborators the seeding granted to. Every one of their grants is then dropped, and the migrated
 * item arrives carrying the destination owner and nobody else.
 *
 * Measured on run 27a74447: 21 of 21 grants across all four permission positions read "no grant
 * for this principal" at the destination, on a job whose options requested every permission flag.
 * The QA team's own hand-run migrations in the same OneDrive show what a mapped run looks like —
 * `/premissions_data/file_example_XLS_50.xls` carries `harry@gajha.com:read alex@gajha.com:write
 * mia@gajha.com:read` — i.e. each source collaborator arrived as its counterpart in the
 * DESTINATION tenant's own domain.
 *
 * So the pairs have to be discovered before the migration is created, which means reading the
 * destination directory. One call, cached per tenant: `$top=999` returned this tenant whole.
 *
 * Groups are fetched too. A group grant is part of the population for features 2.1-2.4 (the scope
 * document says so), and a group that exists in the source domain and not in the destination tenant
 * cannot be mapped at all — which is a fact about the test accounts, not a product defect, and is
 * worth reporting as such rather than discovering it as a failed feature.
 */
const principalCache = new Map();

async function listTenantPrincipals(upn) {
  const tenant = getMsTenant(upn || '');
  if (principalCache.has(tenant)) return principalCache.get(tenant);

  const byLocalPart = new Map();
  const addRow = (addresses, kind) => {
    for (const a of addresses) {
      const addr = String(a || '').toLowerCase();
      if (!addr.includes('@')) continue;
      // A guest arrives as `alex_filefuze.co#EXT#@trydemos.onmicrosoft.com` with `mail` holding the
      // real address. Both are indexed, but the local part comes from the MAIL address, because the
      // UPN's local part for a guest is the whole foreign address with @ replaced by _.
      const local = addr.split('@')[0];
      if (!byLocalPart.has(local)) byLocalPart.set(local, []);
      byLocalPart.get(local).push({ address: addr, kind });
    }
  };

  for (const [path, kind] of [['users', 'user'], ['groups', 'group']]) {
    const select = kind === 'user' ? 'userPrincipalName,mail' : 'mail,displayName';
    let url = `${GRAPH_BASE}/${path}?$select=${select}&$top=999`;
    let pages = 0;
    while (url && pages < 5) {
      // A directory read is not worth failing a seed over: without it the agent falls back to
      // seeding nothing rather than seeding grants it knows cannot migrate.
      const page = await graphGet(url, upn).catch((err) => {
        logger.warn(`[OneDrive] could not read destination ${path}: ${err.message}`);
        return null;
      });
      if (!page) break;
      for (const p of page.value || []) {
        addRow([p.mail, p.userPrincipalName].filter(Boolean), kind);
      }
      url = page['@odata.nextLink'] || null;
      pages += 1;
    }
  }

  principalCache.set(tenant, byLocalPart);
  logger.info(`[OneDrive] destination tenant ${tenant}: indexed ${byLocalPart.size} principal `
    + 'local part(s) for permission mapping');
  return byLocalPart;
}

/**
 * The destination identity a source grantee should be mapped to, or null when there is none.
 *
 * Matched on LOCAL PART, and the destination account's OWN domain wins.
 *
 * That preference is not cosmetic. `alex@filefuze.co` exists in this destination tenant twice: as
 * the guest `alex_filefuze.co#EXT#@trydemos.onmicrosoft.com` and as the internal member
 * `alex@gajha.com`. Mapping to the guest routes an in-scope permission feature through EXTERNAL
 * sharing, which this combination's document puts out of scope — so the feature would be exercised
 * by a mechanism nobody promised. Mapping to the internal member is what the working data does.
 *
 * @param {string} sourceEmail  the grantee as the SOURCE cloud reports it
 * @param {string} destUpn      the destination account, whose domain is preferred
 * @returns {{ address: string, kind: string, exact: boolean } | null}
 */
async function resolveCounterpart(sourceEmail, destUpn) {
  const local = String(sourceEmail || '').toLowerCase().split('@')[0];
  if (!local) return null;
  const index = await listTenantPrincipals(destUpn);
  const hits = index.get(local) || [];
  if (hits.length === 0) return null;

  const destDomain = String(destUpn || '').toLowerCase().split('@')[1] || '';
  const internal = hits.find((h) => h.address.endsWith(`@${destDomain}`));
  const chosen = internal || hits[0];
  return {
    address: chosen.address,
    kind: chosen.kind,
    // False when the only counterpart is a guest or sits on a third domain — the caller reports it
    // rather than passing it off as a clean mapping.
    exact: Boolean(internal),
  };
}

/** Graph URL for a path inside a drive — the root itself, or `root:/a/b:`. */
function itemUrl(driveId, itemPath, suffix = '') {
  const enc = encodeDrivePath(itemPath);
  return enc
    ? `${GRAPH_BASE}/drives/${driveId}/root:/${enc}${suffix ? `:${suffix}` : ''}`
    : `${GRAPH_BASE}/drives/${driveId}/root${suffix || ''}`;
}

/** One item by path, or null when it does not exist. A 404 is an answer here, not a failure. */
async function getItem(driveId, itemPath, upn) {
  try {
    return await graphGet(itemUrl(driveId, itemPath), upn);
  } catch (err) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

/** Children of a folder, following Graph's paging so a large folder is not silently truncated. */
async function listChildren(driveId, folderPath, upn) {
  let url = itemUrl(driveId, folderPath, '/children?$top=200');
  const out = [];
  while (url) {
    const data = await graphGet(url, upn);
    out.push(...(Array.isArray(data?.value) ? data.value : []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

/**
 * The whole tree under a path, flattened, each entry carrying its path relative to that root.
 *
 * Depth-bounded on purpose: a cycle is impossible in a drive, but a runaway depth on a large
 * destination costs thousands of calls before anyone notices.
 */
async function buildFolderTree(driveId, rootPath, upn, opts = {}) {
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 25;
  const out = [];
  const walk = async (absPath, relPath, depth) => {
    if (depth > maxDepth) return;
    const kids = await listChildren(driveId, absPath, upn).catch(() => []);
    for (const k of kids) {
      const rel = relPath ? `${relPath}/${k.name}` : `/${k.name}`;
      const abs = absPath ? `${absPath}/${k.name}` : k.name;
      out.push({
        id: k.id,
        name: k.name,
        path: rel.startsWith('/') ? rel : `/${rel}`,
        type: k.folder ? 'folder' : 'file',
        size: typeof k.size === 'number' ? k.size : null,
        mimeType: k.file?.mimeType || null,
        createdAt: k.createdDateTime || null,
        modifiedAt: k.lastModifiedDateTime || null,
        childCount: k.folder?.childCount ?? null,
      });
      if (k.folder) await walk(abs, rel, depth + 1);
    }
  };
  await walk(encodeDrivePath(rootPath) ? String(rootPath).replace(/^\/+|\/+$/g, '') : '', '', 0);
  return out;
}

/**
 * Normalise one Graph permission into the shape the content comparators expect.
 *
 * GROUP IS RESOLVED FIRST, and the order is the entire point. Graph returns a group grant as
 * `{ group, siteUser }` — a siteUser entry exists for groups as well as for people — so testing
 * siteUser first classified every migrated group as a USER whose "email" was SharePoint's claims
 * string (`c:0t.c|tenant|<objectId>`). Nothing can match that, so a migration that had preserved
 * group access correctly was reported as failing. sharepointClient learned this the hard way; the
 * logic is repeated here rather than imported so that file stays untouched.
 */
function resolveGrant(p) {
  const granted = p.grantedToV2 || p.grantedTo || {};
  const idsV2 = Array.isArray(p.grantedToIdentitiesV2) ? p.grantedToIdentitiesV2 : [];
  const group = granted.group || granted.siteGroup || idsV2[0]?.group || null;
  const user = group ? null : (granted.user || idsV2[0]?.user || granted.siteUser || null);
  const principal = group || user;
  return {
    // A group from another tenant often carries no email at all, only a displayName, so the name
    // travels separately and group matching falls back to it.
    email: (principal?.email || principal?.loginName || '').toLowerCase() || null,
    name: principal?.displayName || null,
    principalType: group ? 'group' : (user ? 'user' : 'unknown'),
    roles: Array.isArray(p.roles) ? p.roles.map((r) => String(r).toLowerCase()) : [],
    isLink: Boolean(p.link),
    linkScope: p.link?.scope || null,
    linkType: p.link?.type || null,
    inherited: Boolean(p.inheritedFrom),
  };
}

/**
 * Permissions on one item, by path.
 *
 * A 403 or 404 on the permissions call itself returns an EMPTY list with `found: true`, which is
 * deliberate: the item exists, we simply could not read its sharing. Reporting that as "no
 * permissions" would be a silent lie, so callers get `readable: false` to tell the two apart.
 */
async function getItemPermissions(driveId, itemPath, upn) {
  const item = await getItem(driveId, itemPath, upn);
  if (!item?.id) return { found: false, readable: false, itemId: null, permissions: [], links: [] };
  const url = `${GRAPH_BASE}/drives/${driveId}/items/${item.id}/permissions`;
  try {
    const data = await graphGet(url, upn);
    const permissions = (Array.isArray(data?.value) ? data.value : []).map(resolveGrant);
    const links = permissions
      .filter((p) => p.isLink)
      .map((p) => ({ scope: p.linkScope, type: p.linkType, roles: p.roles }));
    return { found: true, readable: true, itemId: item.id, permissions, links };
  } catch (err) {
    if (err?.response?.status === 403 || err?.response?.status === 404) {
      return { found: true, readable: false, itemId: item.id, permissions: [], links: [] };
    }
    throw err;
  }
}

/** Permissions by item id, for callers that already walked the tree and need no second lookup. */
async function getPermissionsById(driveId, itemId, upn) {
  const url = `${GRAPH_BASE}/drives/${driveId}/items/${itemId}/permissions`;
  try {
    const data = await graphGet(url, upn);
    const permissions = (Array.isArray(data?.value) ? data.value : []).map(resolveGrant);
    return {
      readable: true,
      permissions,
      links: permissions.filter((p) => p.isLink)
        .map((p) => ({ scope: p.linkScope, type: p.linkType, roles: p.roles })),
    };
  } catch (err) {
    if (err?.response?.status === 403 || err?.response?.status === 404) {
      return { readable: false, permissions: [], links: [] };
    }
    throw err;
  }
}

/** File bytes, for any check that needs to read a migrated document rather than its metadata. */
async function downloadItemContent(driveId, itemId, upn) {
  const token = await getAppAccessToken(getMsTenant(upn || ''));
  const res = await retryWithBackoff(
    () => axios.get(`${GRAPH_BASE}/drives/${driveId}/items/${itemId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: 120000,
    }),
    { label: 'OneDrive download', maxRetries: 2 }
  );
  return Buffer.from(res.data);
}

/**
 * Delete one item by path. The only destructive call here.
 *
 * Content cleanup needs it so a re-run does not stack another copy of the migrated tree beside the
 * last one — the duplicates a previous run leaves behind are then attributed to THIS migration as
 * "extra" and "misplaced", which is how a clean run reads as a structure failure.
 */
async function deleteItemByPath(driveId, itemPath, upn) {
  const item = await getItem(driveId, itemPath, upn);
  if (!item?.id) return { deleted: false, reason: 'not found' };
  const token = await getAppAccessToken(getMsTenant(upn || ''));
  await retryWithBackoff(
    () => axios.delete(`${GRAPH_BASE}/drives/${driveId}/items/${item.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000,
    }),
    { label: 'OneDrive delete', maxRetries: 2 }
  );
  logger.info(`[OneDrive] deleted ${itemPath} for ${upn}`);
  return { deleted: true, itemId: item.id };
}

module.exports = {
  resolveDrive,
  listTenantPrincipals,
  resolveCounterpart,
  getItem,
  listChildren,
  buildFolderTree,
  getItemPermissions,
  getPermissionsById,
  downloadItemContent,
  deleteItemByPath,
  // exported for tests
  encodeDrivePath,
  resolveGrant,
};
