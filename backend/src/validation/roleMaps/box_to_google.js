/**
 * Box → Google role and link-scope translation.
 *
 * Per `data/feature-scope/box-to-google-inscope.md`, sections 2 and 5. My Drive only —
 * `combinations` names a single entry; a `box_to_googleshareddrive` combination is out of scope for
 * this pass and must not be added here until that combination actually exists (see the note in
 * `dropbox_to_google.js`, which covers both of its destinations because both were built together).
 *
 * A new file rather than another block in `validation/contentRoleMap.js`, for the same reason
 * `roleMaps/dropbox_to_google.js` is its own file: that module already holds the Box→SharePoint and
 * Drive→SharePoint tables and is imported by every live combination, so every added pair grows the one
 * file two people would then have to merge. This directory is loaded by scan (see `index.js`), so a
 * pair is an added file.
 *
 * Exposes the same functions `deepContentCore` and `dropboxToGoogledrive.js`-style validators call:
 * `isComparableDriveRole`, `nonComparableReason`, `compareDriveAccess`, `compareSharedLink`, plus the
 * `expectedLinkScope` / `expectedLinkType` / `expectedGoogleLabel` helpers a combination file can use
 * directly when building its own per-link report rows.
 */

/** Shared ladder, matching contentRoleMap and dropbox_to_google so levels are comparable across maps. */
const LEVEL = { FULL: 4, EDIT: 3, READ: 2, NONE: 0 };

/**
 * Box's real collaboration roles, from `boxClient.getCollaborations` (`GET /folders|files/{id}/
 * collaborations`): `owner, co-owner, editor, viewer, previewer, uploader, previewer uploader,
 * viewer uploader`. Box has no single "can edit / can view" pair the way Dropbox does — it is an
 * eight-role ladder, and three of those roles (`uploader`, `previewer uploader`, `viewer uploader`)
 * have no clean Google Drive equivalent at all.
 *
 *   editor              → can view, edit, upload, download, delete, share            → EDIT
 *   viewer               → can view, download                                        → READ
 *   previewer            → can view in Box's own previewer, but CANNOT download      → READ (nuance below)
 *   co-owner              → almost everything owner can do except delete/transfer own → see below
 *   owner                 → full control, and not re-granted at the destination       → FULL, NOT_COMPARABLE
 *   uploader               → can upload NEW files, cannot see existing content at all → NOT_COMPARABLE
 *   previewer uploader     → preview (no download) + upload                          → READ (nuance below)
 *   viewer uploader        → view/download + upload, cannot edit existing content    → READ (nuance below)
 *
 * `previewer` is deliberately mapped to READ rather than a finer "read, no download" level: Google
 * Drive's own ladder has no such level either (a Drive `reader` can always download unless the file
 * owner disables download for everyone on the file, which is a file-wide setting, not a per-grant
 * one). So a `previewer` grant is compared as a Viewer, and the no-download restriction is NOT
 * verified by this map — noted in `nonComparableReason`-adjacent commentary below rather than pretended
 * away.
 *
 * `previewer uploader` and `viewer uploader` both carry an upload capability Google's ladder has no
 * equivalent for (a Drive `writer` can also edit EXISTING files, which these two Box roles explicitly
 * cannot). They are compared at READ — the closest level that does not silently accept an edit-capable
 * destination as correct — with the upload half of the role left unverified. This is a deliberate
 * under-approximation: failing to notice a real Editor-level escalation matters more here than failing
 * to notice the (rare) reverse case.
 */
const BOX_ROLE_LEVEL = {
  owner: LEVEL.FULL,
  // Box's own admin console describes co-owner as "almost all of owner's rights except the ability to
  // delete/transfer the owner's ownership of the top-level folder". On a Google My Drive destination
  // there is no grantable role above Editor for a non-owning collaborator — `organizer` /
  // `fileorganizer` are Shared-Drive-only concepts, not available to an invited person on My Drive.
  // So the only level actually ACHIEVABLE here is EDIT, and treating co-owner as FULL would make this
  // feature fail on every run (nothing but the destination account itself can ever reach FULL on My
  // Drive). Mapped to EDIT deliberately — the ceiling Google can actually produce — with the
  // administrative capabilities Box co-owner carries beyond Editor (deleting the root, changing
  // collaborators) left unverified. Documented here rather than silently assumed.
  'co-owner': LEVEL.EDIT,
  coowner: LEVEL.EDIT,
  editor: LEVEL.EDIT,
  viewer: LEVEL.READ,
  previewer: LEVEL.READ,
  'previewer uploader': LEVEL.READ,
  'viewer uploader': LEVEL.READ,
  // uploader has NO comparable level: it is upload-only and grants no read access to existing content
  // at all. Excluded from this map's level table entirely; isComparableDriveRole refuses it below
  // rather than assigning it a level that would silently compare against nothing.
};

/** Google Drive roles, by the access they grant — identical table to dropbox_to_google.js. */
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

/** The Google role label a Box role should become, per scope §2. */
const BOX_TO_GOOGLE_LABEL = {
  'co-owner': 'Editor',
  coowner: 'Editor',
  editor: 'Editor',
  viewer: 'Viewer',
  previewer: 'Viewer',
  'previewer uploader': 'Viewer',
  'viewer uploader': 'Viewer',
};

/**
 * Roles that cannot be compared as a grant at all.
 *
 *   owner    — the destination account owns every migrated copy, so the source owner's ownership is
 *              not re-granted to them. Same treatment as Dropbox's `owner`.
 *   uploader — grants NO read access to existing content. Google's ladder has nothing that both (a)
 *              denies reading existing files and (b) allows creating new ones inside a folder — the
 *              closest, `writer`, can also read and edit everything. Comparing it at any level would
 *              either falsely fail a correct migration (comparing at EDIT/READ, which uploader never
 *              had) or falsely pass a real over-grant (comparing at NONE, which nothing ever
 *              satisfies). Reported as not comparable instead, exactly as Dropbox's `owner` is.
 */
const NOT_COMPARABLE = new Set(['owner', 'uploader']);

const norm = (v) => String(v || '').toLowerCase().trim();

/** True when this source role can be compared against a destination grant at all. */
function isComparableDriveRole(role) {
  return !NOT_COMPARABLE.has(norm(role));
}

/** Why a role is not comparable, for the report. */
function nonComparableReason(role) {
  const r = norm(role);
  if (r === 'owner') {
    return 'the source owner is not re-granted at the destination — the migrating account owns the '
      + 'destination copy, so there is no equivalent grant to compare';
  }
  if (r === 'uploader') {
    return '"uploader" grants no read access to existing content at all — Google\'s Drive roles have '
      + 'no equivalent that both denies reading existing files and allows creating new ones, so there '
      + 'is no level this can be compared against without either a false fail or a false pass';
  }
  return `"${role}" has no Google equivalent to compare against`;
}

/** Access level of a Box collaboration role. */
function driveRoleLevel(role) {
  return BOX_ROLE_LEVEL[norm(role)] ?? LEVEL.NONE;
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

/** The Google role label a Box role is expected to produce. */
function expectedGoogleLabel(boxRole) {
  return BOX_TO_GOOGLE_LABEL[norm(boxRole)] || 'Viewer';
}

/**
 * Compare one Box grant against the Google roles found on the destination item.
 *
 * Named `compareDriveAccess` to match the interface `deepContentCore` calls — "Drive" there means "the
 * source cloud", not Google Drive specifically (see dropbox_to_google.js, which uses the same name).
 *
 * EQUAL access is required, not merely sufficient — a source Viewer arriving as Editor is a privilege
 * escalation and is reported through `overGranted`, never quietly accepted.
 */
function compareDriveAccess(boxRole, googleRoles) {
  const want = driveRoleLevel(boxRole);
  const got = spRolesLevel(googleRoles);
  return {
    expectedSpLabel: expectedGoogleLabel(boxRole),
    match: want === got,
    overGranted: got > want && want !== LEVEL.NONE,
    underGranted: got < want,
    sourceLevel: want,
    destLevel: got,
  };
}

/**
 * Box shared-link `access` → Google General access, per scope §5.
 *
 *   open          → "Anyone with the link"     → anonymous
 *   company       → "<organisation>"            → organization (Box's "people in your company" link is
 *                                                  the Box equivalent of Dropbox's "team members" link
 *                                                  and Google's domain-scope link)
 *   collaborators → NOT a public link scope at all — it restricts the link to people who ALREADY have
 *                   collaborator access, so it grants no NEW access the way `open`/`company` do. There
 *                   is no Google "anyone who already has access" link scope to compare it against, so
 *                   it is reported as not comparable rather than mapped to a scope it does not carry.
 */
const BOX_LINK_SCOPE = {
  open: 'anonymous',
  company: 'organization',
};

/** The Google link scope a Box link `access` value must become, or null when it is not comparable. */
function expectedLinkScope(boxAccess) {
  return BOX_LINK_SCOPE[norm(boxAccess)] || null;
}

/**
 * A Box shared link has no edit-vs-view axis at all.
 *
 * Confirmed against `boxClient.createSharedLink` and the Box API's own shared_link schema: the only
 * per-link settings are `access` (open/company/collaborators) and `permissions.can_download` /
 * `can_preview` — there is no `can_edit`. Editing a file always requires a real collaboration
 * (`editor` role or above); a shared link itself only ever grants viewing/downloading. So the expected
 * Google link type is ALWAYS `'view'` for this pair — never `'edit'` — and a migration that produced
 * an editing link from a Box shared link would itself be the anomaly, not the other way around.
 *
 * This is a genuine platform limitation, not a guess: it is why `expectedLinkType` takes no role
 * argument at all, unlike `dropbox_to_google.js`'s version, which does vary by the link's role because
 * Dropbox links genuinely have both audiences.
 */
function expectedLinkType() {
  return 'view';
}

/**
 * Compare one source Box shared link against the link permissions on the destination item.
 *
 * `sourceLink` is `{ access: 'open'|'company'|'collaborators' }` (from `boxClient.getItemSharing`).
 * `destLinks` is the Google-side link list from `GoogleDriveValidationAgent.readPermissions` —
 * `[{ scope, type, role, domain }]`.
 *
 * A `collaborators`-scoped source link has no comparable expectation (see `expectedLinkScope` above),
 * so it is reported `match: true` / `notComparable: true` rather than failed against a scope that was
 * never going to appear at the destination — the same "don't invent a defect" rule
 * `dropbox_to_google.js` applies to Dropbox's `no_one` (invite-only) audience.
 */
function compareSharedLink(sourceLink, destLinks) {
  const boxAccess = sourceLink?.access;
  const expectedScope = expectedLinkScope(boxAccess);
  const expectedType = expectedLinkType();
  const links = Array.isArray(destLinks) ? destLinks : [];

  if (!expectedScope) {
    return {
      expectedScope: null,
      expectedType,
      notComparable: true,
      match: true,
      actual: links.map((l) => `${norm(l.scope) || '?'}/${norm(l.type) || '?'}`),
    };
  }

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
  pair: 'box_to_google',
  // My Drive only. A `box_to_googleshareddrive` combination does not exist in this repo yet — see the
  // file header. Add it here only alongside actually building that combination.
  combinations: ['box_to_googledrive'],
  label: 'Box → Google',

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
