/**
 * SharePoint Online → Google (My Drive / Shared Drive) role and link-scope translation.
 *
 * Per `data/feature-scope/sharepoint-to-google-shared-drive-inscope.md` sections 3-8 (permissions,
 * shared links, external shares) and the out-of-scope document, which records what Google refuses
 * to accept.
 *
 * A new file rather than another block in `validation/contentRoleMap.js`: that file holds the
 * Box→SharePoint and Drive→SharePoint tables and is imported by every live combination, so each
 * added pair grows the one file that two people then have to merge. This directory is loaded by
 * scan — a pair is an added file. Same arrangement as `validation/destinations/` and
 * `utils/contentTolerance/`.
 *
 * Exposes the four functions `deepContentCore` calls, under the names it calls them by, so a
 * combination can hand this over in place of the SharePoint-oriented map.
 */

/** Shared ladder, matching contentRoleMap so levels are comparable across maps. */
const LEVEL = { FULL: 4, EDIT: 3, READ: 2, NONE: 0 };

/**
 * SharePoint / Graph permission roles, by the access they grant.
 *
 * Graph reports drive-item roles as 'read' | 'write' | 'owner', and SharePoint adds its own
 * role-definition names through the same field — 'sp.full control', 'sp.edit', 'sp.read' — so both
 * vocabularies map. 'sp.limited access' is not access to the item itself (SharePoint uses it to let
 * a principal traverse to something below), so it is NONE rather than READ.
 */
const SP_ROLE_LEVEL = {
  owner: LEVEL.FULL,
  'sp.full control': LEVEL.FULL,
  'full control': LEVEL.FULL,
  write: LEVEL.EDIT,
  edit: LEVEL.EDIT,
  'sp.edit': LEVEL.EDIT,
  contribute: LEVEL.EDIT,
  'sp.contribute': LEVEL.EDIT,
  read: LEVEL.READ,
  'sp.read': LEVEL.READ,
  restricted_view: LEVEL.READ,
  'sp.restricted view': LEVEL.READ,
  // A review/comment grant lets someone annotate but not change the file — READ in access terms,
  // and Google's own `commenter` sits at the same level in the map below.
  review: LEVEL.READ,
  'sp.review': LEVEL.READ,
  'sp.limited access': LEVEL.NONE,
};

/** Google Drive roles, by the access they grant. Same table as the Dropbox→Google map. */
const GOOGLE_ROLE_LEVEL = {
  owner: LEVEL.FULL,
  organizer: LEVEL.FULL,
  fileorganizer: LEVEL.EDIT,
  writer: LEVEL.EDIT,
  editor: LEVEL.EDIT,
  commenter: LEVEL.READ,
  reader: LEVEL.READ,
  viewer: LEVEL.READ,
};

/**
 * The Google role a SharePoint role should become.
 *
 * SharePoint has no commenter-only grant in the Graph drive-item vocabulary, so Commenter is never
 * an expected outcome — which matters, because accepting it would pass a downgrade from Edit.
 */
const SP_TO_GOOGLE_LABEL = {
  write: 'Editor',
  edit: 'Editor',
  'sp.edit': 'Editor',
  contribute: 'Editor',
  'sp.contribute': 'Editor',
  read: 'Viewer',
  'sp.read': 'Viewer',
  restricted_view: 'Viewer',
  'sp.restricted view': 'Viewer',
  review: 'Viewer',
  'sp.review': 'Viewer',
};

/**
 * Roles that cannot be compared as a grant.
 *
 * `owner` / `sp.full control`: the migrating account owns every destination copy, so the source
 * owner is not re-granted — the same rule the Dropbox and Drive maps state, and the reason runs
 * used to fail on their own owner permission.
 *
 * `sp.limited access`: SharePoint's traversal marker. It grants nothing on the item, and Google has
 * no equivalent, so requiring a destination grant for it would fail every parent of a shared child.
 */
const NOT_COMPARABLE = new Set(['owner', 'sp.full control', 'full control', 'sp.limited access']);

const norm = (v) => String(v || '').toLowerCase().trim();

/** True when this source role can be compared against a destination grant at all. */
function isComparableDriveRole(role) {
  return !NOT_COMPARABLE.has(norm(role));
}

/** Why a role is not comparable, for the report. */
function nonComparableReason(role) {
  const r = norm(role);
  if (r === 'owner' || r === 'sp.full control' || r === 'full control') {
    return 'the source owner is not re-granted at the destination — the migrating account owns the '
      + 'destination copy, so there is no equivalent grant to compare';
  }
  if (r === 'sp.limited access') {
    return 'SharePoint Limited Access grants no rights on the item itself (it only allows '
      + 'traversal to a shared child), and Google has no equivalent to compare it against';
  }
  return `"${role}" has no Google equivalent to compare against`;
}

/** Access level of a SharePoint role. */
function driveRoleLevel(role) {
  return SP_ROLE_LEVEL[norm(role)] ?? LEVEL.NONE;
}

/** Highest access level among a set of Google roles on one item. */
function spRolesLevel(roles) {
  let best = LEVEL.NONE;
  for (const r of Array.isArray(roles) ? roles : []) {
    const lvl = GOOGLE_ROLE_LEVEL[norm(r)];
    if (lvl != null && lvl > best) best = lvl;
  }
  return best;
}

/** The Google role label a SharePoint role is expected to produce. */
function expectedGoogleLabel(spRole) {
  return SP_TO_GOOGLE_LABEL[norm(spRole)] || 'Viewer';
}

/**
 * Compare one SharePoint grant against the Google roles on the destination item.
 *
 * EQUAL access is required, not merely sufficient: a source Viewer arriving as Editor is a
 * privilege escalation, reported through `overGranted` and never quietly accepted. On a migration
 * QA tool, "they can do more than before" is a finding.
 */
function compareDriveAccess(spRole, googleRoles) {
  const want = driveRoleLevel(spRole);
  const got = spRolesLevel(googleRoles);
  return {
    expectedSpLabel: expectedGoogleLabel(spRole),
    match: want === got,
    overGranted: got > want && want !== LEVEL.NONE,
    underGranted: got < want,
    sourceLevel: want,
    destLevel: got,
  };
}

/**
 * SharePoint link scope → Google General access.
 *
 *   'anonymous'    → anonymous     ("Anyone with the link")
 *   'organization' → organization  (shown in Google as the org's own name)
 *   'users'        → not a link in Google's sense: a "specific people" link is an ordinary per-user
 *                    grant, so it has no General-access counterpart and returns null. Comparing it
 *                    as a link would fail every such link against a destination that expressed it
 *                    correctly as a user permission.
 */
const SP_LINK_SCOPE = {
  anonymous: 'anonymous',
  anyone: 'anonymous',
  organization: 'organization',
  users: null,
  existingaccess: null,
};

/** The Google link scope a SharePoint link scope must become, or null when it is not a link. */
function expectedLinkScope(spLinkScope) {
  const key = norm(spLinkScope);
  return Object.prototype.hasOwnProperty.call(SP_LINK_SCOPE, key) ? SP_LINK_SCOPE[key] : null;
}

/**
 * A SharePoint link type → the Google link type ('edit' | 'view').
 *
 * SharePoint's 'embed' link is a view link with a different rendering, and 'blocksDownload' /
 * 'review' links still only read — all of them are 'view'.
 */
function expectedLinkType(spLinkType) {
  return norm(spLinkType) === 'edit' ? 'edit' : 'view';
}

/**
 * Compare one source shared link against the link permissions on the destination item.
 *
 * Both axes are asserted — who the link reaches (scope) and what they can do (type). Checking only
 * the scope would pass a viewing link that arrived as an editing link.
 *
 * A 'users' link returns `comparable: false`: it is a per-person grant wearing a link, already
 * covered by the permission comparison, and the caller reports it there instead.
 */
function compareSharedLink(sourceLink, destLinks) {
  const rawScope = sourceLink?.scope ?? sourceLink?.linkScope ?? sourceLink?.type;
  const rawType = sourceLink?.type ?? sourceLink?.linkType;
  const expectedScope = expectedLinkScope(rawScope);
  const expectedType = expectedLinkType(rawType);
  const links = Array.isArray(destLinks) ? destLinks : [];

  if (!expectedScope) {
    return {
      comparable: false,
      expectedScope: null,
      expectedType,
      found: false,
      scopeMatch: false,
      typeMatch: false,
      match: false,
      actual: links.map((l) => `${norm(l.scope) || '?'}/${norm(l.type) || '?'}`),
      reason: `a "${norm(rawScope) || 'specific people'}" SharePoint link is a per-user grant, not `
        + 'a Google General-access link — it is compared as a permission instead',
    };
  }

  const scoped = links.filter((l) => norm(l.scope) === expectedScope);
  const exact = scoped.find((l) => norm(l.type) === expectedType) || null;

  return {
    comparable: true,
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
  pair: 'sharepoint_to_google',
  // One map for both Google destinations: the scope document is written for Shared Drive, and My
  // Drive differs only in ownership, which the permission levels above do not depend on.
  combinations: ['sharepoint_to_googleshareddrive', 'sharepoint_to_googledrive'],
  label: 'SharePoint → Google',

  LEVEL,
  isComparableDriveRole,
  nonComparableReason,
  driveRoleLevel,
  spRolesLevel,
  compareDriveAccess,
  compareSharedLink,
  expectedLinkScope,
  expectedLinkType,
  expectedGoogleLabel,
};
