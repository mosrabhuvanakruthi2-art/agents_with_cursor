/**
 * Dropbox → Google role and link-scope translation.
 *
 * Per `data/feature-scope/dropbox-to-google-inscope.md`, sections 2 and 3. Covers BOTH combinations
 * (My Drive and Shared Drive) because the scope document is written for the two together.
 *
 * A new file rather than another block in `validation/contentRoleMap.js`: that file already holds the
 * Box→SharePoint and Drive→SharePoint tables, and every added pair grows the one file that all live
 * combinations import. Two people adding two pairs collide there. This directory is loaded by scan,
 * so a pair is an added file — the same arrangement as `validation/destinations/` and
 * `utils/contentTolerance/`.
 *
 * Exposes the four functions the shared comparison calls, under the same names, so a combination can
 * hand this to `deepContentCore` in place of the SharePoint-oriented map.
 */

/** Shared ladder, matching contentRoleMap so levels are comparable across maps. */
const LEVEL = { FULL: 4, EDIT: 3, READ: 2, NONE: 0 };

/**
 * Dropbox exposes two collaborator levels plus an owner. There is no "commenter".
 *
 *   Can edit  → EDIT
 *   Can view  → READ
 *   owner     → FULL, and deliberately not comparable (see below)
 *
 * Names vary across the Dropbox API surface — `editor`/`viewer` from sharing endpoints,
 * "Can edit"/"Can view" in the UI — so both spellings map.
 */
const DROPBOX_ROLE_LEVEL = {
  owner: LEVEL.FULL,
  editor: LEVEL.EDIT,
  'can edit': LEVEL.EDIT,
  write: LEVEL.EDIT,
  viewer: LEVEL.READ,
  'can view': LEVEL.READ,
  read: LEVEL.READ,
  // Dropbox also has a view-only-with-no-download variant; access-wise it is still READ.
  viewer_no_comment: LEVEL.READ,
};

/** Google Drive roles, by the access they grant. */
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
 * The Google role a Dropbox role should become, per scope §2.
 *
 * Dropbox has no commenter, so `Commenter` is never an expected outcome — which matters, because a
 * validator that accepted it would pass a downgrade from Editor.
 */
const DROPBOX_TO_GOOGLE_LABEL = {
  editor: 'Editor',
  'can edit': 'Editor',
  write: 'Editor',
  viewer: 'Viewer',
  'can view': 'Viewer',
  read: 'Viewer',
  viewer_no_comment: 'Viewer',
};

/**
 * Roles that cannot be compared as a grant.
 *
 * The destination account owns every migrated copy, so the source owner's ownership is not re-granted
 * to them — exactly as `organizer` is not comparable on the Google→SharePoint map. Treating it as an
 * ordinary grant failed every run on its own owner permission.
 */
const NOT_COMPARABLE = new Set(['owner']);

const norm = (v) => String(v || '').toLowerCase().trim();

/** True when this source role can be compared against a destination grant at all. */
function isComparableDriveRole(role) {
  return !NOT_COMPARABLE.has(norm(role));
}

/** Why a role is not comparable, for the report. */
function nonComparableReason(role) {
  if (norm(role) === 'owner') {
    return 'the source owner is not re-granted at the destination — the migrating account owns the '
      + 'destination copy, so there is no equivalent grant to compare';
  }
  return `"${role}" has no Google equivalent to compare against`;
}

/** Access level of a Dropbox role. */
function driveRoleLevel(role) {
  return DROPBOX_ROLE_LEVEL[norm(role)] ?? LEVEL.NONE;
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

/** The Google role label a Dropbox role is expected to produce. */
function expectedGoogleLabel(dropboxRole) {
  return DROPBOX_TO_GOOGLE_LABEL[norm(dropboxRole)] || 'Viewer';
}

/**
 * Compare one Dropbox grant against the Google roles found on the destination item.
 *
 * Named `compareDriveAccess` to match the interface `deepContentCore` calls — "Drive" there means
 * "the source cloud", not Google Drive specifically.
 *
 * EQUAL access is required, not merely sufficient. A source Viewer arriving as Editor is a privilege
 * escalation and is reported through `overGranted`, never quietly accepted: on a migration QA tool,
 * "they can do more than before" is a finding, not a pass.
 */
function compareDriveAccess(dropboxRole, googleRoles) {
  const want = driveRoleLevel(dropboxRole);
  const got = spRolesLevel(googleRoles);
  return {
    expectedSpLabel: expectedGoogleLabel(dropboxRole),
    match: want === got,
    overGranted: got > want && want !== LEVEL.NONE,
    underGranted: got < want,
    sourceLevel: want,
    destLevel: got,
  };
}

/**
 * Dropbox link audience → Google General access, per scope §3.
 *
 *   "Anyone with the link" → anonymous
 *   "Team members"         → organization  (shown in Google as the org's own name, e.g. "Sync Orbit")
 *
 * Matched on SCOPE, never on the organisation's display name: that string differs per tenant, and a
 * validator keyed to "Sync Orbit" would fail in every other account.
 */
const DROPBOX_LINK_SCOPE = {
  public: 'anonymous',
  anyone: 'anonymous',
  'anyone with the link': 'anonymous',
  team: 'organization',
  'team members': 'organization',
  team_only: 'organization',
  members: 'organization',
  // A password-protected or expiring link is still anonymous in audience terms; the extra condition
  // is not something the destination reproduces.
  password: 'anonymous',
};

/** The Google link scope a Dropbox link audience must become. */
function expectedLinkScope(dropboxLinkAudience) {
  return DROPBOX_LINK_SCOPE[norm(dropboxLinkAudience)] || null;
}

/** A Dropbox link role → the Google link type ('edit' | 'view'). */
function expectedLinkType(dropboxRole) {
  return driveRoleLevel(dropboxRole) >= LEVEL.EDIT ? 'edit' : 'view';
}

/**
 * Compare one source shared link against the link permissions on the destination item.
 *
 * Both axes are asserted — who the link reaches (scope) and what they can do (type). Checking only
 * the scope would pass a viewing link that arrived as an editing link.
 */
function compareSharedLink(sourceLink, destLinks) {
  const expectedScope = expectedLinkScope(sourceLink?.type ?? sourceLink?.audience);
  const expectedType = expectedLinkType(sourceLink?.role);
  const links = Array.isArray(destLinks) ? destLinks : [];

  const scoped = links.filter((l) => norm(l.scope) === expectedScope);
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
  pair: 'dropbox_to_google',
  // One map serves both destinations — the scope document covers them together.
  combinations: ['dropbox_to_googledrive', 'dropbox_to_googleshareddrive'],
  label: 'Dropbox → Google',

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
