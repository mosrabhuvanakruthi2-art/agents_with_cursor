/**
 * Google → Google role and link-scope translation (My Drive → My Drive).
 *
 * Per `data/feature-scope/google-my-drive-to-my-drive-inscope.md` sections 2 and 3.
 *
 * The simplest map in the directory, and worth having explicitly rather than defaulting: both sides
 * speak the same vocabulary, so the translation is the IDENTITY. Falling back to the Box/Drive to
 * SharePoint table would classify Google's own roles against SharePoint levels and report
 * differences that do not exist; falling back to the Dropbox map would not know `commenter` at all.
 *
 * Exposes the four functions `deepContentCore` calls, under the names it calls them by.
 */

/** Shared ladder, matching the other maps so levels stay comparable across combinations. */
const LEVEL = { FULL: 4, EDIT: 3, READ: 2, NONE: 0 };

/**
 * Google Drive roles by the access they grant — the same table on both sides.
 *
 * `commenter` sits at READ deliberately: a commenter cannot change the file. Keeping it distinct
 * from `reader` in the LABEL (below) while sharing a level means a reader arriving as a commenter
 * is not a privilege escalation, but is still reported as a different role.
 */
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

/** Identity: a Google role should arrive as the same Google role. */
const GOOGLE_TO_GOOGLE_LABEL = {
  writer: 'Editor',
  editor: 'Editor',
  fileorganizer: 'Content manager',
  commenter: 'Commenter',
  reader: 'Viewer',
  viewer: 'Viewer',
};

/**
 * Roles that cannot be compared as a grant.
 *
 * The destination account owns its own copy of every migrated item, so the SOURCE owner is not
 * re-granted there — asserting it would fail every run on its own owner permission, which is the
 * mistake the Dropbox and SharePoint maps both record. `organizer` is the Shared Drive spelling of
 * the same thing and is excluded for the same reason.
 */
const NOT_COMPARABLE = new Set(['owner', 'organizer']);

const norm = (v) => String(v || '').toLowerCase().trim();

/** True when this source role can be compared against a destination grant at all. */
function isComparableDriveRole(role) {
  return !NOT_COMPARABLE.has(norm(role));
}

/** Why a role is not comparable, for the report. */
function nonComparableReason(role) {
  const r = norm(role);
  if (r === 'owner' || r === 'organizer') {
    return 'the source owner is not re-granted at the destination — the migrating account owns its '
      + 'own copy, so there is no equivalent grant to compare';
  }
  return `"${role}" has no counterpart to compare against`;
}

/** Access level of a source role. */
function driveRoleLevel(role) {
  return GOOGLE_ROLE_LEVEL[norm(role)] ?? LEVEL.NONE;
}

/** Highest access level among the destination roles on one item. */
function spRolesLevel(roles) {
  let best = LEVEL.NONE;
  for (const r of Array.isArray(roles) ? roles : []) {
    const lvl = GOOGLE_ROLE_LEVEL[norm(r)];
    if (lvl != null && lvl > best) best = lvl;
  }
  return best;
}

/** The destination role label a source role is expected to produce. */
function expectedGoogleLabel(role) {
  return GOOGLE_TO_GOOGLE_LABEL[norm(role)] || 'Viewer';
}

/**
 * Compare one source grant against the roles found on the destination item.
 *
 * EQUAL access is required, not merely sufficient: a source Viewer arriving as Editor is a privilege
 * escalation and is reported through `overGranted`, never quietly accepted.
 *
 * Between two Google clouds the role should also be the SAME role, not merely the same level — a
 * commenter arriving as a reader keeps the level but loses the ability to comment. That is reported
 * through `roleChanged`, which the combination surfaces as an observation rather than a failure,
 * because the scope document asks for access levels to be preserved and both are READ.
 */
function compareDriveAccess(sourceRole, destRoles) {
  const want = driveRoleLevel(sourceRole);
  const got = spRolesLevel(destRoles);
  const wantRole = norm(sourceRole);
  const sameRole = (Array.isArray(destRoles) ? destRoles : []).some((r) => norm(r) === wantRole);
  return {
    expectedSpLabel: expectedGoogleLabel(sourceRole),
    match: want === got,
    overGranted: got > want && want !== LEVEL.NONE,
    underGranted: got < want,
    roleChanged: want === got && !sameRole,
    sourceLevel: want,
    destLevel: got,
  };
}

/**
 * Google link scope → Google link scope. Also the identity.
 *
 *   'anyone' → anonymous     ("Anyone with the link", scope document 3.1)
 *   'domain' → organization  (shown as the organisation's name, e.g. "Sync Orbit", 3.2)
 *
 * Matched on SCOPE, never on the organisation's display name: the destination is a DIFFERENT
 * organisation, so that label is expected to change while the scope must not.
 */
const GOOGLE_LINK_SCOPE = {
  anyone: 'anonymous',
  anonymous: 'anonymous',
  domain: 'organization',
  organization: 'organization',
  // A "specific people" grant is an ordinary user permission wearing a link; it has no
  // General-access counterpart and is judged by the permission features instead.
  user: null,
  users: null,
};

/** The destination link scope a source link scope must become, or null when it is not a link. */
function expectedLinkScope(scope) {
  const key = norm(scope);
  return Object.prototype.hasOwnProperty.call(GOOGLE_LINK_SCOPE, key) ? GOOGLE_LINK_SCOPE[key] : null;
}

/** A source link role → the destination link type ('edit' | 'view'). */
function expectedLinkType(role) {
  return driveRoleLevel(role) >= LEVEL.EDIT ? 'edit' : 'view';
}

/**
 * Compare one source shared link against the link permissions on the destination item.
 *
 * Both axes are asserted — who the link reaches (scope) and what they can do (type). Checking only
 * the scope would pass a viewing link that arrived as an editing link.
 */
function compareSharedLink(sourceLink, destLinks) {
  const rawScope = sourceLink?.scope ?? sourceLink?.type;
  const rawRole = sourceLink?.role ?? sourceLink?.type;
  const expectedScope = expectedLinkScope(rawScope);
  const expectedType = sourceLink?.type === 'edit' || sourceLink?.type === 'view'
    ? sourceLink.type
    : expectedLinkType(rawRole);
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
      reason: 'a per-person grant, not a General-access link — compared as a permission instead',
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
  pair: 'google_to_google',
  // My Drive → My Drive today. A Shared Drive on either side would be the same vocabulary, so the
  // key is listed for it too rather than silently falling back to another pair's table.
  combinations: [
    'googledrive_to_googledrive',
    'googledrive_to_googleshareddrive',
    'googleshareddrive_to_googledrive',
    'googleshareddrive_to_googleshareddrive',
  ],
  label: 'Google → Google',

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
