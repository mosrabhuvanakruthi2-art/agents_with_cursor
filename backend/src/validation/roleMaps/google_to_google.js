/**
 * Google → Google role and link-scope translation (My Drive → My Drive).
 *
 * Per `data/feature-scope/my-drive-to-my-drive-inscope.md`, sections 2 and 3.
 *
 * A new file rather than another block in `validation/contentRoleMap.js`, for the same reason
 * `dropbox_to_google.js` is: this directory is loaded by scan, so a pair is an ADDED FILE and two
 * people adding two pairs never collide. Exposes the four functions `deepContentCore` calls, under
 * the same names.
 *
 * ── Why this map is not a copy of dropbox_to_google.js ──────────────────────────────────────────
 *
 * Source and destination are the SAME platform, which makes the translation identity — and that is
 * exactly what makes it easy to get wrong in two specific ways:
 *
 *   1. **Commenter is a real, distinct outcome here.** Dropbox and Box have no commenter, so
 *      `dropbox_to_google.js` folds `commenter` and `reader` into one READ level and nothing is lost.
 *      On this pair a source Commenter arriving as Viewer is a genuine downgrade, and a level ladder
 *      that scores both as READ reports it as a match. Three of the nine QA cases for this
 *      combination (`/Mydrive to Mydrive/Root Folder Permissions`, TEST-34400/34401/34406) grant
 *      commenter, so this is the majority-of-a-third of the tested surface, not an edge case.
 *
 *      Therefore: matching compares the CANONICAL ROLE NAME, not the level. The level ladder is kept
 *      only to decide whether a difference is an escalation or a downgrade.
 *
 *   2. **The role is preserved but the PRINCIPAL is not.** This combination is cross-tenant —
 *      `@filefuze.co` → `@cloudfuze.com` in every figure of the scope document — so
 *      `alex@filefuze.co` as Viewer arrives as `anthony@cloudfuze.com` as Viewer. Identity of role,
 *      not of grantee. This map deliberately does NOT resolve principals: that is the user-mapping
 *      CSV's job, and `deepContentCore.comparePermissions` already takes a `mapEmail` callback built
 *      from it. Stated here because "Google to Google" reads like nothing changes, and a validator
 *      written on that assumption fails all nine permission cases on the grantee address.
 *
 * ⚠️ OPEN QUESTION — see `my-drive-to-my-drive-testdata.md`, question 1. The scope document never
 * mentions the commenter role and no figure shows one; the QA cases exercise it heavily. Identity
 * mapping is the obvious reading of a Google→Google pair, but it is an INFERENCE, not a documented
 * rule. `COMMENTER_IS_INFERRED` below is exported so the validator can report commenter outcomes at
 * INFO rather than failing them until the combination owner rules.
 */

/**
 * Access ladder.
 *
 * FULL / EDIT / READ keep the values used by `contentRoleMap` and `dropbox_to_google` so a level is
 * comparable across maps. COMMENT has no slot in that shared ladder — it sits strictly between
 * Viewer and Editor — so it takes the fractional value rather than renumbering the others, which
 * would silently change what every other map's numbers mean.
 */
const LEVEL = { FULL: 4, EDIT: 3, COMMENT: 2.5, READ: 2, NONE: 0 };

/**
 * Google Drive roles by the access they grant. One table, used for BOTH sides — that is the whole
 * point of this pair.
 *
 * `organizer` and `fileOrganizer` are Shared Drive membership roles. They are included because a
 * My Drive item shared INTO a Shared Drive context can surface them, and an unknown role scoring
 * NONE would read as "no access at the destination" — a false failure rather than an unknown.
 */
const GOOGLE_ROLE_LEVEL = {
  owner: LEVEL.FULL,
  organizer: LEVEL.FULL,
  fileorganizer: LEVEL.EDIT,
  writer: LEVEL.EDIT,
  editor: LEVEL.EDIT,
  commenter: LEVEL.COMMENT,
  reader: LEVEL.READ,
  viewer: LEVEL.READ,
};

/**
 * Canonical role name, so the two spellings Google itself uses for the same thing compare equal.
 *
 * The Drive API returns `writer` / `reader`; the Drive UI (and the scope document's figures) say
 * `Editor` / `Viewer`. They are the same grant. Comparing the raw strings would report every single
 * grant as mismatched purely on vocabulary.
 */
const CANONICAL = {
  owner: 'owner',
  organizer: 'organizer',
  fileorganizer: 'fileOrganizer',
  writer: 'writer',
  editor: 'writer',
  commenter: 'commenter',
  reader: 'reader',
  viewer: 'reader',
};

/** The label the Google UI shows for a canonical role — what a reviewer sees in the share dialog. */
const LABEL = {
  owner: 'Owner',
  organizer: 'Manager',
  fileOrganizer: 'Content manager',
  writer: 'Editor',
  commenter: 'Commenter',
  reader: 'Viewer',
};

/**
 * Roles that cannot be compared as a grant.
 *
 * The destination account owns every migrated copy, so the source owner's ownership is not
 * re-granted to them. Same reasoning as every other map in this directory — treating it as an
 * ordinary grant failed runs on their own owner permission.
 *
 * `organizer` joins it for the Shared Drive case: membership of a Shared Drive is not a per-item
 * grant and has no My Drive equivalent to compare against.
 */
const NOT_COMPARABLE = new Set(['owner', 'organizer']);

/**
 * True while the commenter mapping rests on inference rather than on the scope document.
 *
 * Exported so the validator can downgrade commenter verdicts to INFO. Flip to false once the
 * combination owner confirms commenter → commenter in the document, and the verdicts become real.
 */
const COMMENTER_IS_INFERRED = true;

const norm = (v) => String(v || '').toLowerCase().trim();

/** Canonical form of a role name, or '' when the role is unknown to this map. */
function canonicalRole(role) {
  return CANONICAL[norm(role)] || '';
}

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
  if (r === 'organizer') {
    return 'Shared Drive membership (organizer) is not a per-item grant and has no My Drive '
      + 'equivalent to compare against';
  }
  return `"${role}" is not a Google Drive role this map recognises`;
}

/** Access level of a Google role. */
function driveRoleLevel(role) {
  return GOOGLE_ROLE_LEVEL[norm(role)] ?? LEVEL.NONE;
}

/**
 * Highest access level among a set of destination roles on one item.
 *
 * Named `spRolesLevel` to match the interface `deepContentCore` calls — "sp" there means "the
 * destination cloud", not SharePoint specifically.
 */
function spRolesLevel(roles) {
  let best = LEVEL.NONE;
  for (const r of Array.isArray(roles) ? roles : []) {
    const lvl = GOOGLE_ROLE_LEVEL[norm(r)];
    if (lvl != null && lvl > best) best = lvl;
  }
  return best;
}

/** The destination role a source role is expected to produce — itself. */
function expectedGoogleLabel(sourceRole) {
  return LABEL[canonicalRole(sourceRole)] || 'Viewer';
}

/**
 * The best destination role by level, in canonical form — what the item actually ended up granting.
 *
 * Picking the HIGHEST rather than looking for the expected one is deliberate: if a source Commenter
 * arrived as both Commenter and Viewer (two entries), the effective access is Commenter and that is
 * what should be judged.
 */
function bestDestRole(roles) {
  let best = '';
  let bestLvl = LEVEL.NONE;
  for (const r of Array.isArray(roles) ? roles : []) {
    const lvl = GOOGLE_ROLE_LEVEL[norm(r)];
    if (lvl != null && lvl > bestLvl) {
      bestLvl = lvl;
      best = canonicalRole(r);
    }
  }
  return best;
}

/**
 * Compare one source grant against the destination roles found on the migrated item.
 *
 * EQUAL access is required, not merely sufficient — a source Viewer arriving as Editor is a
 * privilege escalation and is reported through `overGranted`, never quietly accepted.
 *
 * The match is on canonical ROLE NAME, not on level, so Commenter → Viewer is caught. Scoring by
 * level alone would pass it, because `dropbox_to_google`'s ladder has both at READ — that map can
 * afford it (Dropbox has no commenter) and this one cannot.
 *
 * `commenterInferred` is set whenever either side is a commenter, so the caller can hold the verdict
 * at INFO while the scope document stays silent on the role.
 */
function compareDriveAccess(sourceRole, destRoles) {
  const wantRole = canonicalRole(sourceRole);
  const gotRole = bestDestRole(destRoles);
  const want = driveRoleLevel(sourceRole);
  const got = spRolesLevel(destRoles);

  return {
    expectedSpLabel: expectedGoogleLabel(sourceRole),
    expectedRole: wantRole,
    actualRole: gotRole,
    // Identity is the rule: the same role, not merely the same amount of access.
    match: Boolean(wantRole) && wantRole === gotRole,
    overGranted: got > want && want !== LEVEL.NONE,
    underGranted: got < want,
    sourceLevel: want,
    destLevel: got,
    // The inference is about which ROLE a commenter becomes — commenter or Viewer — so it can only
    // excuse a grant that actually ARRIVED. A source commenter with NO destination grant at all is
    // a lost grant, not an undocumented mapping, and holding it at INFO hid exactly that: the
    // missing group grants on /root_folder_commenter and /Permission Matrix/folder_commenter were
    // reported as "NOT FAILED: the commenter mapping is inferred" while the reader and writer
    // grants lost the same way were failed. `gotRole` is '' when nothing was granted.
    commenterInferred: COMMENTER_IS_INFERRED
      && Boolean(gotRole)
      && (wantRole === 'commenter' || gotRole === 'commenter'),
  };
}

/**
 * Link audience → link audience, per scope §3.
 *
 * Google's general-access values are the same on both sides, so this is identity:
 *   'anyone'  — "Anyone with the link"        (scope 3.1)
 *   'domain'  — the organisation's own name   (scope 3.2)
 *   'private' — "Restricted"                  (no link)
 *
 * Matched on SCOPE, never on the organisation's DISPLAY NAME. Scope 3.2's prose says a
 * `Sync Orbit` link migrates as `Sync Orbit`, but its own figure 3.2.1 shows the destination reading
 * `cloudfuze.com` — because that string is the *source* tenant's organisation name and cannot
 * survive into a different tenant. Keying on the literal word would pass only in the account the
 * screenshots came from. See the scope file's warning on 3.2 and testdata question 3.
 */
const LINK_SCOPE = {
  anyone: 'anyone',
  anonymous: 'anyone',
  'anyone with the link': 'anyone',
  public: 'anyone',
  domain: 'domain',
  organization: 'domain',
  'sync orbit': 'domain',
  private: 'private',
  restricted: 'private',
};

/** The destination link scope a source link audience must become. */
function expectedLinkScope(sourceLinkAudience) {
  return LINK_SCOPE[norm(sourceLinkAudience)] || null;
}

/**
 * A source link role → the destination link type.
 *
 * Three values, not two: a commenter link is its own outcome here for the same reason a commenter
 * grant is. Collapsing it into 'view' would pass a comment link that arrived read-only.
 */
function expectedLinkType(sourceRole) {
  const c = canonicalRole(sourceRole);
  if (c === 'writer' || c === 'fileOrganizer') return 'edit';
  if (c === 'commenter') return 'comment';
  return 'view';
}

/**
 * Compare one source shared link against the link permissions on the destination item.
 *
 * Both axes are asserted — who the link reaches (scope) and what they can do (type). Checking only
 * the scope would pass a viewing link that arrived as an editing link.
 *
 * Note `deepContentCore.compareSharedLinks` calls the module-level SharePoint map rather than
 * `opts.roleMap`, so a combination using this map must call THIS function directly rather than going
 * through that helper. `dropboxToGoogledrive.js` does the same for the same reason.
 */
function compareSharedLink(sourceLink, destLinks) {
  // Read the audience from `scope` FIRST and the role from `role` LAST.
  //
  // Two link shapes reach this function and they disagree on what `type` means. The raw
  // driveClient row is { type: 'anyone'|'domain', role: 'reader' } — `type` is the AUDIENCE. The
  // shape the combination builds is { scope: 'anyone'|'domain', type: 'reader' } — `type` is the
  // ROLE. Reading `type` first fed a ROLE to the audience table on every link from
  // googledriveToGoogledrive, which has no entry for it: expectedScope came back null, nothing in
  // the destination could match it, and 3.1/3.2 reported "0/96 matched … expected null/view" on a
  // tree whose links were all present and correct. The dest side of this same function already
  // reads `scope` then `type ?? role`; this is the source side agreeing with it.
  const expectedScope = expectedLinkScope(
    sourceLink?.scope ?? sourceLink?.audience ?? sourceLink?.type);
  const expectedType = expectedLinkType(sourceLink?.role ?? sourceLink?.type);
  const links = Array.isArray(destLinks) ? destLinks : [];

  const scoped = links.filter((l) => norm(l.scope) === expectedScope);
  const exact = scoped.find((l) => expectedLinkType(l.type ?? l.role) === expectedType) || null;

  return {
    expectedScope,
    expectedType,
    found: scoped.length > 0,
    scopeMatch: scoped.length > 0,
    typeMatch: Boolean(exact),
    match: Boolean(exact),
    actual: links.map((l) => `${norm(l.scope) || '?'}/${norm(l.type ?? l.role) || '?'}`),
    // True when a domain link was compared. The destination's org name legitimately differs from the
    // source's, so a report should say so rather than leave a reviewer comparing two different words.
    domainNameDiffers: expectedScope === 'domain',
  };
}

module.exports = {
  pair: 'google_to_google',
  // My Drive → My Drive only. Shared Drive as a source or destination is a different scope document
  // (different ownership model, different membership roles) and is deliberately NOT claimed here —
  // claiming it would hand this map to a combination whose document nobody has read.
  // My Drive → My Drive is this map's own pair. The Shared Drive keys are listed because the
  // vocabulary is identical on both sides and the googleshareddrive → googleshareddrive validator
  // resolves its map from here — without them it throws "no map covers this combination" and
  // refuses to run rather than silently mistranslating grants against a SharePoint table.
  combinations: [
    'googledrive_to_googledrive',
    // Shared Drive → Shared Drive only. Both sides speak the same vocabulary there, and the
    // googleshareddrive → googleshareddrive validator resolves its map from here — without this key
    // it throws "no map covers this combination" rather than mistranslating grants against a
    // SharePoint table.
    //
    // The CROSS pairs (My Drive ↔ Shared Drive) are deliberately NOT claimed: their ownership model
    // and membership roles are a different scope document, and googledriveToGoogledrive.test.js
    // pins that they resolve to null.
    'googleshareddrive_to_googleshareddrive',
  ],
  label: 'Google My Drive → Google My Drive',

  LEVEL,
  COMMENTER_IS_INFERRED,
  isComparableDriveRole,
  nonComparableReason,
  driveRoleLevel,
  spRolesLevel,
  canonicalRole,
  bestDestRole,
  compareDriveAccess,
  compareSharedLink,
  expectedLinkScope,
  expectedLinkType,
  expectedGoogleLabel,
};
