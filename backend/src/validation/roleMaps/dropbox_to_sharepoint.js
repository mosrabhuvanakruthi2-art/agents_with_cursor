/**
 * Dropbox → SharePoint role and link-scope translation.
 *
 * Per `data/feature-scope/dropbox-to-sharepoint-inscope.md`, sections 4 (Permissions) and 5 (Shared
 * Links).
 *
 * A new file rather than another block in `validation/contentRoleMap.js`. That file holds the
 * Box→SharePoint and Drive→SharePoint tables and is imported by both live SharePoint combinations,
 * so every added pair grows the one file they all depend on. This directory is loaded by scan, so a
 * pair is an added file and nobody else's combination moves — the same arrangement as
 * `validation/destinations/` and `utils/contentTolerance/`.
 *
 * It is also a new file rather than an extra entry on `roleMaps/dropbox_to_google.js`: that map's
 * labels are `Editor` / `Viewer`, which are Google role names. SharePoint's are `Edit` / `Read`.
 * Adding `'dropbox_to_sharepoint'` to its `combinations` array would report Google role names on a
 * SharePoint run.
 *
 * ⚠️ CALLING CONVENTION. `driveRoleLevel()` here returns a **number** (the `LEVEL` value), matching
 * every other map in this directory. `validation/contentRoleMap.js` has a function of the same name
 * that returns a **string** key (`'EDIT'`) which its callers then re-index through `roleMap.LEVEL`.
 * The two are not interchangeable; mixing them silently mis-scores every grant.
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

/**
 * SharePoint roles, by the access they grant.
 *
 * Values follow `validation/contentRoleMap.js`'s SP table so a level computed here means the same
 * thing it means on the Box and Drive combinations. Graph returns bare `write`/`read`; the site
 * permission UI returns `Full Control` / `Edit` / `Contribute` / `Read`; and `sp.` prefixed forms
 * appear on some tenants. All three spellings are accepted.
 */
const SP_ROLE_LEVEL = {
  owner: LEVEL.FULL,
  'full control': LEVEL.FULL,
  'sp.full control': LEVEL.FULL,
  write: LEVEL.EDIT,
  edit: LEVEL.EDIT,
  'sp.edit': LEVEL.EDIT,
  contribute: LEVEL.EDIT,
  'sp.contribute': LEVEL.EDIT,
  read: LEVEL.READ,
  'sp.read': LEVEL.READ,
  view: LEVEL.READ,
  restricted: LEVEL.READ,
};

/**
 * The SharePoint role a Dropbox role should become, per scope §4.
 *
 * Dropbox has no comment-only role, so no source role may legitimately produce a read-level
 * destination grant other than `Can view`. A Dropbox Editor arriving as Read is a DOWNGRADE and
 * must be reported, never accepted as "close enough".
 */
const DROPBOX_TO_SP_LABEL = {
  editor: 'Edit',
  'can edit': 'Edit',
  write: 'Edit',
  viewer: 'Read',
  'can view': 'Read',
  read: 'Read',
  viewer_no_comment: 'Read',
};

/**
 * Roles that cannot be compared as a grant.
 *
 * The destination account owns every migrated copy, so the source owner's ownership is not
 * re-granted to them. Treating it as an ordinary grant fails every run on its own owner permission.
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
  return `"${role}" has no SharePoint equivalent to compare against`;
}

/** Access level of a Dropbox role, as a NUMBER. See the calling-convention note at the top. */
function driveRoleLevel(role) {
  return DROPBOX_ROLE_LEVEL[norm(role)] ?? LEVEL.NONE;
}

/** Highest access level among a set of SharePoint roles on one item. */
function spRolesLevel(roles) {
  let best = LEVEL.NONE;
  for (const r of Array.isArray(roles) ? roles : []) {
    const lvl = SP_ROLE_LEVEL[norm(r)];
    if (lvl != null && lvl > best) best = lvl;
  }
  return best;
}

/** The SharePoint role label a Dropbox role is expected to produce. */
function expectedSpLabel(dropboxRole) {
  return DROPBOX_TO_SP_LABEL[norm(dropboxRole)] || 'Read';
}

/**
 * Compare one Dropbox grant against the SharePoint roles found on the destination item.
 *
 * Named `compareDriveAccess` to match the interface `deepContentCore` calls — "Drive" there means
 * "the source cloud", not Google Drive specifically.
 *
 * EQUAL access is required, not merely sufficient. A source Viewer arriving with Edit is a privilege
 * escalation and is reported through `overGranted`, never quietly accepted: on a migration QA tool,
 * "they can do more than before" is a finding, not a pass.
 */
function compareDriveAccess(dropboxRole, spRoles) {
  const want = driveRoleLevel(dropboxRole);
  const got = spRolesLevel(spRoles);
  return {
    expectedSpLabel: expectedSpLabel(dropboxRole),
    match: want === got,
    overGranted: got > want && want !== LEVEL.NONE,
    underGranted: got < want,
    sourceLevel: want,
    destLevel: got,
  };
}

/**
 * Dropbox link audience → SharePoint link scope, per scope §5.
 *
 *   5.1 "Anyone with the link" → anonymous    (destination: "Anyone with the link")
 *   5.2 "Team members"         → organization (destination: "People in organization with the link")
 *
 * Matched on SCOPE, never on a display name. The Google pair's equivalent has to match the tenant's
 * own organisation name because Google renders it that way; SharePoint renders the fixed phrase
 * "People in organization with the link", so there is no tenant-specific string to key on here.
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

/** The SharePoint link scope a Dropbox link audience must become. */
function expectedLinkScope(dropboxLinkAudience) {
  return DROPBOX_LINK_SCOPE[norm(dropboxLinkAudience)] || null;
}

/** A Dropbox link role → the SharePoint link type ('edit' | 'view'). */
function expectedLinkType(dropboxRole) {
  return driveRoleLevel(dropboxRole) >= LEVEL.EDIT ? 'edit' : 'view';
}

/**
 * Compare one source shared link against the link permissions on the destination item.
 *
 * Both axes are asserted — who the link reaches (scope) and what they can do (type). Checking only
 * the scope would pass a viewing link that arrived as an editing link, which §5.1 and §5.2 both
 * state explicitly must be preserved.
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
  pair: 'dropbox_to_sharepoint',
  // Only SharePoint today. The scope document also covers OneDrive, and `destinations/sharepoint.js`
  // already aliases it, so adding 'dropbox_to_onedrive' here is the whole role-map change when that
  // combination is built — deliberately not added now, because nothing would look it up.
  combinations: ['dropbox_to_sharepoint'],
  label: 'Dropbox → SharePoint',

  LEVEL,
  isComparableDriveRole,
  nonComparableReason,
  driveRoleLevel,
  spRolesLevel,
  compareDriveAccess,
  compareSharedLink,
  expectedLinkScope,
  expectedLinkType,
  expectedSpLabel,
};
