'use strict';

/**
 * Source-cloud ↔ SharePoint permission role mapping for content-migration validation.
 *
 * Box support came first; Google Drive support was added alongside it (see the DRIVE_* block at the
 * bottom). The Box exports keep their original behavior — the Box→SharePoint validator depends on them.
 *
 * Both sides are reduced to a canonical access LEVEL so they can be compared despite
 * different role vocabularies:
 *   FULL  (4) — owner / co-owner / full control
 *   EDIT  (3) — editor / write / contribute / upload
 *   READ  (2) — viewer / previewer / read
 *   NONE  (0) — no access
 *
 * CloudFuze maps Box roles to SharePoint roles roughly as below; we validate that the
 * destination grants AT LEAST the equivalent level for the same user.
 */
const LEVEL = { FULL: 4, EDIT: 3, READ: 2, NONE: 0 };

// Box collaboration roles → canonical level
const BOX_ROLE_LEVEL = {
  owner: 'FULL',
  'co-owner': 'FULL',
  editor: 'EDIT',
  uploader: 'EDIT',
  'viewer uploader': 'EDIT',
  'previewer uploader': 'EDIT',
  viewer: 'READ',
  previewer: 'READ',
};

// SharePoint / Graph permission roles → canonical level
const SP_ROLE_LEVEL = {
  owner: 'FULL',
  'sp.full control': 'FULL',
  'full control': 'FULL',
  write: 'EDIT',
  'sp.edit': 'EDIT',
  'sp.contribute': 'EDIT',
  contribute: 'EDIT',
  edit: 'EDIT',
  read: 'READ',
  'sp.read': 'READ',
  view: 'READ',
};

/** Human label for the SharePoint role a Box role should map to. */
const BOX_TO_SP_LABEL = {
  owner: 'Full Control',
  'co-owner': 'Full Control',
  editor: 'Edit',
  uploader: 'Contribute',
  'viewer uploader': 'Contribute',
  'previewer uploader': 'Contribute',
  viewer: 'Read',
  previewer: 'Read',
};

function boxRoleLevel(role) {
  return BOX_ROLE_LEVEL[String(role || '').toLowerCase().trim()] || 'NONE';
}

function spRolesLevel(roles) {
  let best = 'NONE';
  for (const r of roles || []) {
    const lvl = SP_ROLE_LEVEL[String(r || '').toLowerCase().trim()];
    if (lvl && LEVEL[lvl] > LEVEL[best]) best = lvl;
  }
  return best;
}

function expectedSpLabel(boxRole) {
  return BOX_TO_SP_LABEL[String(boxRole || '').toLowerCase().trim()] || 'Read';
}

/**
 * Compare a Box collaboration role against the SharePoint roles granted to the same user.
 * Returns { boxLevel, spLevel, match, expectedSpLabel }.
 * match = destination grants AT LEAST the equivalent access level.
 */
function compareAccess(boxRole, spRoles) {
  const boxLevel = boxRoleLevel(boxRole);
  const spLevel = spRolesLevel(spRoles);
  return {
    boxLevel,
    spLevel,
    match: LEVEL[spLevel] >= LEVEL[boxLevel] && LEVEL[boxLevel] > 0,
    expectedSpLabel: expectedSpLabel(boxRole),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Google Drive → SharePoint
 *
 * Drive API role names differ from the Shared Drive UI labels the feature docs use:
 *   organizer     → "Manager"          fileOrganizer → "Content Manager"
 *   writer        → "Contributor"      (labelled "Editor" on files)
 *   commenter     → "Commenter"        reader        → "Viewer"
 * `owner` does not exist in shared drives.
 *
 * Expected destination access, per google-shared-drive-to-sharepoint-inscope.md §4:
 *   Viewer / Commenter          → can view   (Commenter maps DOWN — SharePoint has no comment-only role)
 *   Contributor / Editor        → can edit
 *   Content Manager             → can edit
 * ──────────────────────────────────────────────────────────────────────────── */

// Google Drive permission roles → canonical level
const DRIVE_ROLE_LEVEL = {
  organizer: 'EDIT',
  fileorganizer: 'EDIT',
  writer: 'EDIT',
  commenter: 'READ',
  reader: 'READ',
};

/** Human label for the SharePoint role a Drive role should map to. */
const DRIVE_TO_SP_LABEL = {
  organizer: 'Edit',
  fileorganizer: 'Edit',
  writer: 'Edit',
  commenter: 'Read',
  reader: 'Read',
};

/**
 * Roles that exist on the source but have no comparable destination permission.
 *
 * `owner` is ownership, not a shareable grant — Drive returns it for every file in My Drive, and
 * SharePoint has no equivalent row to match it against. Treating it as an ordinary grant made every
 * My Drive run fail on its own owner permission, so it is reported as not-comparable instead.
 */
const DRIVE_ROLES_NOT_COMPARABLE = new Set(['owner']);

/** False when this role cannot be meaningfully compared against a SharePoint permission. */
function isComparableDriveRole(role) {
  const r = String(role || '').toLowerCase().trim();
  if (DRIVE_ROLES_NOT_COMPARABLE.has(r)) return false;
  return Object.prototype.hasOwnProperty.call(DRIVE_ROLE_LEVEL, r);
}

/** Why a role cannot be compared. */
function nonComparableReason(role) {
  const r = String(role || '').toLowerCase().trim();
  if (r === 'owner') return 'ownership is not a shareable permission — SharePoint has no equivalent grant';
  return `unrecognised Drive role "${role}" — no documented SharePoint mapping`;
}

/** Drive roles are camelCase in the API (`fileOrganizer`); compare case-insensitively. */
function driveRoleLevel(role) {
  return DRIVE_ROLE_LEVEL[String(role || '').toLowerCase().trim()] || 'NONE';
}

function expectedSpLabelForDrive(driveRole) {
  return DRIVE_TO_SP_LABEL[String(driveRole || '').toLowerCase().trim()] || 'Read';
}

/**
 * Compare a Drive permission role against the SharePoint roles granted to the same user.
 *
 * Returns { driveLevel, spLevel, match, exact, overGranted, expectedSpLabel }.
 *   match       — destination grants AT LEAST the expected level (same semantics as compareAccess)
 *   exact       — destination grants EXACTLY the expected level
 *   overGranted — destination grants MORE than expected, e.g. a Commenter who can edit. This is a
 *                 privilege escalation, so the caller decides its severity rather than it being
 *                 silently folded into `match`.
 */
function compareDriveAccess(driveRole, spRoles) {
  const driveLevel = driveRoleLevel(driveRole);
  const spLevel = spRolesLevel(spRoles);
  return {
    driveLevel,
    spLevel,
    match: LEVEL[spLevel] >= LEVEL[driveLevel] && LEVEL[driveLevel] > 0,
    exact: LEVEL[spLevel] === LEVEL[driveLevel] && LEVEL[driveLevel] > 0,
    overGranted: LEVEL[driveLevel] > 0 && LEVEL[spLevel] > LEVEL[driveLevel],
    expectedSpLabel: expectedSpLabelForDrive(driveRole),
  };
}

/* ── Shared links ───────────────────────────────────────────────────────────
 * A Drive shared link carries a TYPE (who the link reaches) and a ROLE (what they can do). Both must
 * survive migration. Graph expresses the same two axes as permission.link.scope / permission.link.type:
 *   Drive type 'anyone' ("Anyone with the link")            → scope 'anonymous'
 *   Drive type 'domain' ("Sync Orbit", the source org)      → scope 'organization'
 *   reader / commenter                                      → type 'view'
 *   writer / fileOrganizer / organizer                      → type 'edit'
 * Checking only "a link exists" would pass a run that silently narrowed every public link to
 * organization-only, so scope and type are asserted separately.
 * ───────────────────────────────────────────────────────────────────────────*/

const DRIVE_LINK_SCOPE = { anyone: 'anonymous', domain: 'organization' };

/** Drive link type ('anyone' | 'domain') → the Graph link scope it must become. */
function expectedLinkScope(driveLinkType) {
  return DRIVE_LINK_SCOPE[String(driveLinkType || '').toLowerCase().trim()] || null;
}

/** Drive role on a link → the Graph link type ('view' | 'edit') it must become. */
function expectedLinkType(driveRole) {
  return LEVEL[driveRoleLevel(driveRole)] >= LEVEL.EDIT ? 'edit' : 'view';
}

/**
 * Compare one source shared link against the link permissions found on the destination item.
 *
 * @param {{ type: string, role: string }} sourceLink   Drive link: type 'anyone'|'domain', role name
 * @param {Array<{ scope?: string, type?: string, roles?: string[] }>} destLinks  Graph link permissions
 * @returns {{ expectedScope, expectedType, found, scopeMatch, typeMatch, match, actual }}
 *   found      — a link permission of the expected scope exists on the destination
 *   scopeMatch — some destination link has the expected scope
 *   typeMatch  — that link also carries the expected type
 */
function compareSharedLink(sourceLink, destLinks) {
  const expectedScope = expectedLinkScope(sourceLink?.type);
  const expectedType = expectedLinkType(sourceLink?.role);
  const links = Array.isArray(destLinks) ? destLinks : [];
  const norm = (v) => String(v || '').toLowerCase().trim();

  const scoped = links.filter((l) => norm(l.scope) === expectedScope);
  // 'edit' satisfies a 'view' expectation only if the source link was itself editable; a view-only
  // source link that arrives as an edit link is an escalation, so types are compared exactly.
  const exact = scoped.find((l) => norm(l.type) === expectedType) || null;

  return {
    expectedScope,
    expectedType,
    found: scoped.length > 0,
    scopeMatch: scoped.length > 0,
    typeMatch: Boolean(exact),
    match: Boolean(exact),
    actual: links.map((l) => `${norm(l.scope) || '?'}/${norm(l.type) || '?'}`),
  };
}

module.exports = {
  LEVEL,
  boxRoleLevel,
  spRolesLevel,
  expectedSpLabel,
  compareAccess,
  // Google Drive → SharePoint
  DRIVE_ROLE_LEVEL,
  DRIVE_ROLES_NOT_COMPARABLE,
  isComparableDriveRole,
  nonComparableReason,
  driveRoleLevel,
  expectedSpLabelForDrive,
  compareDriveAccess,
  expectedLinkScope,
  expectedLinkType,
  compareSharedLink,
};
