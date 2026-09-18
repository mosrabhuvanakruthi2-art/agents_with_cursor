'use strict';

/**
 * Deep validation for content: Google My Drive → Google My Drive.
 *
 * Edit ONLY this file to change My Drive → My Drive behaviour. Provider-agnostic comparison logic
 * lives in validation/shared/deepContentCore.js; the numbers live in
 * utils/contentTolerance/googledriveToGoogledrive.js; the Google name/path rules live in
 * validation/destinations/googledrive.js; the role and link tables live in
 * validation/roleMaps/google_to_google.js.
 *
 * Scope: backend/data/feature-scope/my-drive-to-my-drive-inscope.md (17 in-scope features),
 *        my-drive-to-my-drive-outscope.md (7 documented limitations),
 *        my-drive-to-my-drive-testdata.md (what must exist in the source for any of it to mean
 *        anything — read it before trusting a PASS).
 *
 * ── SOURCE AND DESTINATION ARE THE SAME PLATFORM ────────────────────────────────────────────────
 *
 * That one fact is what this file exists to handle, and it cuts both ways. Three things get EASIER
 * and four get HARDER, and the four are where a validator inherited from a cross-platform pair
 * produces confident false results:
 *
 *   Easier — no character replacement (5.1), no path relocation (7.1), no role translation (2.x).
 *   All three expect IDENTITY, and all three are already handled by passing the Google destination
 *   rules and the Google→Google role map in, rather than by branching here.
 *
 *   Harder:
 *
 *   1. **Google Vids is missing from the shared unmigratable table.** `deepContentCore`'s
 *      GOOGLE_NATIVE_NO_EXPORT covers Forms, Sites, Maps, Jamboard, Apps Script, Fusion Tables,
 *      Drawings and shortcuts — it was written for a MICROSOFT destination, and Vids postdates it.
 *      Out-of-scope 3.1 says Vids goes to conflict and is non-migratable, so without the addition
 *      below every seeded Vid is reported MISSING. See NATIVE_CONFLICT_TYPES.
 *
 *   2. **Drawings behave differently here than the shared table says.** That table marks a Drawing
 *      unmigratable ("exportable only as a static image") and therefore EXPECTED ABSENT. Out-of-scope
 *      2.1 for this pair says the opposite: a Drawing arrives as a Google **Doc with empty data** —
 *      present, not absent. Left alone, a Drawing that migrates correctly-as-documented is counted
 *      as an unexpected EXTRA at the destination and its empty content is never examined. See
 *      DRAWING_MIME.
 *
 *   3. **The reasons in the shared table are wrong for this destination.** Every one says "no
 *      Microsoft 365 equivalent". On a Google destination a Form is absent because CloudFuze puts it
 *      into conflict, not because there is nothing to convert it into. The verdict happens to
 *      coincide; the explanation printed next to it would be nonsense to a reviewer holding this
 *      combination's document.
 *
 *   4. **Commenter is a real outcome and the level ladder cannot see it.** Handled in the role map —
 *      see the long note there. Summarised: matching is by role NAME, not by access level, because
 *      Commenter and Viewer score the same on the shared ladder.
 *
 * ── IT IS CROSS-TENANT ──────────────────────────────────────────────────────────────────────────
 *
 * Every figure in the scope document shows @filefuze.co → @cloudfuze.com with different owners, and
 * all nine QA permission cases say "For Root to Root CSV mapping". So roles are preserved but
 * GRANTEES ARE REMAPPED, and every permission comparison must go through the user-mapping CSV
 * (`core.buildEmailMap`). A validator that compares grantee addresses literally fails all nine.
 */

const GoogleDriveValidationAgent = require('../../../agents/googledrive/GoogleDriveValidationAgent');
const driveClient = require('../../../clients/driveClient');
const { extractDocxLinks } = require('../../../utils/docxLinks');
// Only the seeded sentinel, not the agent's behaviour: 8.1's control link has to be read back with
// exactly the string that was written, and that string is owned by the agent that writes it.
const { EMBEDDED_LINK_OUT_OF_SET_ID } = require('../../../agents/drive/DriveTestDataAgent');
const core = require('../../shared/deepContentCore');
const destinations = require('../../destinations');
const roleMaps = require('../../roleMaps');
const tolerance = require('../../../utils/contentTolerance');
const env = require('../../../config/env');
const logger = require('../../../utils/logger');

const COMBINATION = 'googledrive_to_googledrive';

/** Terminal CloudFuze statuses that mean the migration itself finished. */
const CF_OK = ['PROCESSED', 'PROCESS', 'VERSION_PROCESSED'];
const CF_CONFLICTS = ['PROCESSED_WITH_CONFLICTS', 'PROCESS_WITH_CONFLICTS'];

const DRAWING_MIME = 'application/vnd.google-apps.drawing';

/**
 * The five native types out-of-scope 3.1–7.1 say go into CONFLICT and are non-migratable.
 *
 * Keyed by MIME type with THIS combination's own reason, rather than reusing
 * `core.unmigratableReason`, whose strings all say "no Microsoft 365 equivalent" — true for a
 * SharePoint destination, meaningless here.
 *
 * `vid` is the one that matters most: it is absent from the shared table entirely, so without this
 * every Google Vid in a seeded account is reported as missing data.
 *
 * Jamboard and Fusion Tables are in the shared table but NOT in this combination's out-of-scope
 * document, so they are deliberately left out here — they fall through to the shared classification
 * and are reported with its wording. Adding them would be this file inventing scope.
 */
const NATIVE_CONFLICT_TYPES = {
  'application/vnd.google-apps.vid':
    'Google Vids — out-of-scope 3.1: goes into conflict and is non-migratable',
  'application/vnd.google-apps.form':
    'Google Forms — out-of-scope 4.1: goes into conflict and is non-migratable',
  'application/vnd.google-apps.map':
    'Google My Maps — out-of-scope 5.1: goes into conflict and is non-migratable',
  'application/vnd.google-apps.script':
    'Google Apps Script — out-of-scope 6.1: goes into conflict and is non-migratable',
  'application/vnd.google-apps.site':
    'Google Sites — out-of-scope 7.1: goes into conflict and is non-migratable',
};

/**
 * The 17 in-scope features, in the scope document's own numbering.
 *
 * A combination-local list rather than validation/shared/contentFunctionalityChecklist.js, for the
 * same reason dropboxToGoogledrive.js keeps its own: that module hardcodes the Google→SharePoint
 * feature set and numbering, so using it here would produce a report whose feature ids do not match
 * the document a reviewer is holding. Editing it would change both live SharePoint combinations,
 * which CONTRIBUTING forbids.
 */
const DRIVE_FEATURES = [
  { id: '1.1', category: 'Migration', feature: 'Data Migration (Files & Folders with structure)' },
  { id: '1.2', category: 'Migration', feature: 'One Time Migration' },
  { id: '1.3', category: 'Migration', feature: 'Delta Migration' },
  { id: '2.1', category: 'Permissions', feature: 'Root Folder Permissions' },
  { id: '2.2', category: 'Permissions', feature: 'Root File Permissions' },
  { id: '2.3', category: 'Permissions', feature: 'Sub-folder permissions' },
  { id: '2.4', category: 'Permissions', feature: 'Inner File Permissions' },
  { id: '2.5', category: 'Permissions', feature: 'External Shares' },
  { id: '3.1', category: 'Shared Links', feature: 'Shared Links (Anyone with the Link)' },
  { id: '3.2', category: 'Shared Links', feature: 'Shared Links (organisation-restricted)' },
  { id: '4.1', category: 'Metadata', feature: 'Metadata (created and modified timestamps)' },
  { id: '5.1', category: 'Naming', feature: 'Special Characters Replacement' },
  { id: '6.1', category: 'Notifications', feature: 'Suppressing email notifications' },
  { id: '7.1', category: 'Paths', feature: 'Long-File/folder path' },
  { id: '8.1', category: 'Embedded Links', feature: 'Embedded Links' },
  { id: '9.1', category: 'Versions', feature: 'Version History' },
  { id: '9.2', category: 'Versions', feature: 'Selective Versions' },
];

/**
 * Features whose verdict is carried by a check that does NOT spell the feature id in its own
 * parentheses, because one check answers several features at once.
 *
 * The checklist looks a feature up by the literal `(<id>)` in a check name. That works for
 * "Structure (1.1)" or "Metadata (4.1)", and found nothing for nine ids whose verdict lived under
 * "Permissions (2.1–2.5)", "Shared Links (3.1, 3.2)" or "Versions (9.1, 9.2)". All nine rows
 * printed the generic "Not assessed by this run" EVEN ON A RUN WHERE THE LUMPED CHECK HAD PASSED,
 * which is the opposite of what the checklist exists to report.
 *
 * 2.1–2.5 and 3.1/3.2 are no longer lumped — each now carries its own verdict off its own evidence
 * (see PERM_FEATURE_CHECK_NAMES), so the plain `(<id>)` lookup finds them. Versions stay here
 * because the two features share one "not requested" verdict.
 *
 * 9.1 and 9.2 are deliberately not interchangeable: an all-versions run pushes "Version History
 * (9.1)" and a selective run pushes "Selective Versions (9.2)", so each id matches its own verdict
 * and the other correctly stays N/A. Only the not-exercised WARN is shared between them.
 */
const LUMPED_FEATURE_CHECKS = {
  '9.1': ['Version History (9.1)', 'Versions (9.1, 9.2)'],
  '9.2': ['Selective Versions (9.2)', 'Versions (9.1, 9.2)'],
};

/** One check per permission feature, each naming its id so the checklist can find it. */
const PERM_FEATURE_CHECK_NAMES = {
  '2.1': 'Root Folder Permissions (2.1)',
  '2.2': 'Root File Permissions (2.2)',
  '2.3': 'Sub-folder permissions (2.3)',
  '2.4': 'Inner File Permissions (2.4)',
  '2.5': 'External Shares (2.5)',
};

/** What a run needed to have seen for each permission feature — the words its N/A reason uses. */
const PERM_FEATURE_EVIDENCE = {
  '2.1': 'No grant was found on a folder at the root of the migrated tree',
  '2.2': 'No grant was found on a file at the root of the migrated tree',
  '2.3': 'No grant was found on a sub-folder',
  '2.4': 'No grant was found on a file below the root',
  '2.5': 'No grant to a principal outside BOTH tenants was found on any paired item',
};

/** One check per shared-link feature. 3.1 is the "anyone" scope, 3.2 the domain scope. */
const LINK_FEATURE_CHECK_NAMES = {
  '3.1': 'Shared Links — Anyone with the Link (3.1)',
  '3.2': 'Shared Links — organisation-restricted (3.2)',
};

/**
 * Which of 2.1–2.5 a single grant is evidence for.
 *
 * Depth is measured from the migrated root, whose direct children sit at depth 1: those are the
 * "root" items (2.1 folders, 2.2 files) and anything deeper is "inner" (2.3 folders, 2.4 files).
 * 2.5 is orthogonal — one grant can be evidence for two features at once — which is why this
 * returns a list.
 *
 * ── Why 2.5 excludes the DESTINATION tenant ────────────────────────────────────────────────────
 *
 * Scope §2.5 is "Files/Folders shared with people of outside organizations". The rule here used to
 * be "grantee domain ≠ SOURCE domain", which on this pair is every grant there is: the combination
 * is cross-tenant by definition (§2), so the ordinary internal grants that 2.1–2.4 already cover —
 * the destination tenant's own users and groups — all sit outside the source domain too. Run
 * d9607a1c shows what that costs: 2.5 checked 26 grants, which is EVERY grant on the tree, and
 * failed on the same 6 group grants 2.1 and 2.3 had already failed on. It was not a fifth feature,
 * it was the other four added together, and it reported one defect three times.
 *
 * A third party is a principal in neither tenant — `waldo@snapbot.io`, the address
 * `GOOGLE_TEST_EXTERNAL_EMAIL` seeds precisely to exercise this feature. That is the reading the
 * sibling combination already uses: `dropboxToGoogledrive` scores 2.5 on grants to
 * `DROPBOX_TEST_EXTERNAL_USER` alone and reports the feature as not-exercised when none is found.
 *
 * Nothing stops being checked. Every grant still lands in exactly one of 2.1–2.4 and is compared
 * there with the same strictness; 2.5 stops being a second copy of that verdict and goes back to
 * standing on the grants that are evidence for IT.
 */
function permissionFeatureIds(item, grant, sourceDomain, destDomain) {
  const depth = String(item.path || '').split('/').filter(Boolean).length;
  const isFolder = item.type === 'folder';
  const ids = [depth <= 1 ? (isFolder ? '2.1' : '2.2') : (isFolder ? '2.3' : '2.4')];

  const granteeDomain = String(grant.email || '').split('@')[1]?.toLowerCase() || '';
  const inATenant = granteeDomain === sourceDomain || granteeDomain === destDomain;
  if (granteeDomain && sourceDomain && !inATenant) ids.push('2.5');
  return ids;
}

/**
 * The 7 out-of-scope features. Reported, never failed.
 *
 * `expectAbsent` distinguishes the five conflict types from the two that are about CONTENT of an
 * item that does arrive — a distinction a single "out of scope" flag would lose, and the one that
 * decides whether an item's presence at the destination is a pass or a finding.
 */
const OUT_OF_SCOPE_FEATURES = [
  { id: 'out-1.1', category: 'Out of scope', feature: 'In Line comment', expectAbsent: false,
    note: 'The document says comments "preserve in the destination" and mentions no CSV, unlike '
      + 'every other combination. Ambiguous — see out-of-scope question 1. Never failed either way.' },
  { id: 'out-2.1', category: 'Out of scope', feature: 'google drawing', expectAbsent: false,
    note: 'Arrives as a Google Doc with EMPTY data. Present at the destination, so a count-based '
      + 'check passes while the content is gone — the item has to be opened, not counted.' },
  { id: 'out-3.1', category: 'Out of scope', feature: 'google vids', expectAbsent: true },
  { id: 'out-4.1', category: 'Out of scope', feature: 'google forms', expectAbsent: true },
  { id: 'out-5.1', category: 'Out of scope', feature: 'google my maps', expectAbsent: true },
  { id: 'out-6.1', category: 'Out of scope', feature: 'google app script', expectAbsent: true },
  { id: 'out-7.1', category: 'Out of scope', feature: 'google sites', expectAbsent: true },
];

const norm = (v) => String(v || '').toLowerCase().trim();

/** True when this item is one of the five types documented to go into conflict. */
function isConflictType(mimeType) {
  return Object.prototype.hasOwnProperty.call(NATIVE_CONFLICT_TYPES, String(mimeType || ''));
}

/** This combination's own reason, not the shared table's Microsoft-oriented one. */
function conflictReason(mimeType) {
  return NATIVE_CONFLICT_TYPES[String(mimeType || '')] || null;
}

/**
 * Split a source tree into the part that is expected to migrate and the part that is not.
 *
 * Done HERE rather than by loosening a count tolerance, and rather than by editing the shared
 * module. The out-of-scope figures show 13 source items arriving as 7 — a six-item shortfall that is
 * entirely documented behaviour. A `countDelta: 6` would have excused it, but it would equally have
 * excused six genuinely lost files. Classifying the items by type excuses exactly the ones the
 * document names and nothing else.
 *
 * Drawings are pulled out of the conflict set explicitly: out-of-scope 2.1 says they DO arrive (as
 * an empty Doc), which the shared table disagrees with. Keeping them in the comparable set means a
 * Drawing that fails to arrive is still reported as missing.
 */
function partitionSource(items) {
  const comparable = [];
  const conflicts = [];
  const drawings = [];

  for (const it of Array.isArray(items) ? items : []) {
    if (isConflictType(it.mimeType)) {
      conflicts.push({
        path: it.path, name: it.name, type: it.type, mimeType: it.mimeType,
        reason: conflictReason(it.mimeType),
      });
      continue;
    }
    if (String(it.mimeType) === DRAWING_MIME) {
      // Expected to arrive, so it stays in the comparable set AND is tracked for the 2.1 check.
      drawings.push({ path: it.path, name: it.name });
    }
    comparable.push(it);
  }

  return { comparable, conflicts, drawings };
}

/**
 * The permission rows to compare, from either shape a caller can hand us.
 *
 * driveClient.listPermissions() returns an OBJECT — { grants, links } — already split and
 * normalised. A raw drive.permissions.list() page is a flat array. Both reach these helpers, and
 * the object used to fall through an `Array.isArray(perms) ? perms : []` guard to `[]` without a
 * sound: permChecked and linkChecked were pinned at 0 on every run, so features 2.1–2.5 and
 * 3.1/3.2 reported "nothing was proven" against a source with every grant and link seeded. The
 * unit test fed a raw array, which is why it never saw it.
 */
function permissionRows(perms, bucket) {
  if (Array.isArray(perms)) return perms;
  const rows = perms?.[bucket];
  return Array.isArray(rows) ? rows : [];
}

/**
 * Link-type permissions on a Drive item, in the shape the role map compares.
 *
 * In Drive a "shared link" is not an object — it is a permission with `type: 'anyone'` or
 * `type: 'domain'`. Left in the user list it makes every link look like a grant to an unknown
 * principal; pulled out here it becomes feature 3.1 / 3.2 evidence.
 */
function linkPermissions(perms) {
  return permissionRows(perms, 'links')
    .filter((p) => norm(p.type) === 'anyone' || norm(p.type) === 'domain')
    .map((p) => ({ scope: norm(p.type), type: norm(p.role), domain: p.domain || null }));
}

/** User/group grants only — links removed, so the permission comparison sees principals. */
function principalPermissions(perms) {
  return permissionRows(perms, 'grants')
    .filter((p) => norm(p.type) === 'user' || norm(p.type) === 'group')
    .map((p) => ({
      email: norm(p.emailAddress || p.email),
      role: norm(p.role),
      type: norm(p.type),
      // driveClient has already resolved inheritance from permissionDetails; a raw permissions.list
      // row still carries the detail array. Read whichever is present.
      inherited: Boolean(p.inherited ?? p.permissionDetails?.some?.((d) => d.inherited)),
    }));
}

/** Whether the job asked for every version — scope 9.2 makes the expected count a job setting. */
function allVersionsRequested(context) {
  const o = context?.contentOptions || context?.options || {};
  if (o.allVersions === true || o.migrateAllVersions === true) return true;
  const n = Number(o.selectiveVersions ?? o.versionCount);
  if (Number.isFinite(n) && n > 0) return false;
  // `versionHistory` is the key the Run Agent wizard actually sends (CONTENT_PERMS in
  // runwizard/steps.jsx). It was not read here, so ticking "Version History" in the UI left
  // wantAll false, the version block never ran, and 9.1/9.2 reported "the job requested no version
  // migration" on a job where the operator had requested exactly that.
  return Boolean(o.versions || o.versionHistory);
}

/** The selective-version count the job asked for, or null. */
function selectiveVersionCount(context) {
  const o = context?.contentOptions || context?.options || {};
  const n = Number(o.selectiveVersions ?? o.versionCount);
  return Number.isFinite(n) && n > 0 ? n : null;
}

class GoogledriveToGoogledriveValidationAgent extends GoogleDriveValidationAgent {
  static supportsDeepValidation = true;

  constructor() {
    super('GoogledriveToGoogledriveValidationAgent');
  }

  async execute(context) {
    const bands = tolerance.forCombination(COMBINATION) || {};
    const rules = destinations.forDestination('googledrive');
    const roleMap = roleMaps.forCombination(COMBINATION);
    const globalChecks = [];
    const gPush = (status, name, detail) => globalChecks.push({ name, status, detail });

    if (!rules) {
      throw new Error(
        'validation/destinations/googledrive.js is not registered — the Google destination rules are '
        + 'required. Without them this validator would fall back to SharePoint\'s rules and report '
        + 'false renames and false path-limit relocations against a destination that has neither.'
      );
    }
    if (!roleMap) {
      throw new Error(
        `validation/roleMaps has no map covering "${COMBINATION}". Refusing to fall back to the `
        + 'SharePoint role table: it scores Commenter and Viewer identically, which would pass a '
        + 'Commenter → Viewer downgrade on a third of this combination\'s permission cases.'
      );
    }

    if (!env.ENABLE_DEEP_CONTENT_VALIDATION) {
      gPush('WARN', 'Deep content validation',
        'Disabled by ENABLE_DEEP_CONTENT_VALIDATION=false — nothing was compared');
      return this._buildResult(globalChecks, [], { enabled: false }, context);
    }

    this._recordCloudFuzeStatus(context, gPush);

    const emailMap = core.buildEmailMap(context);
    if (Object.keys(emailMap).length === 0) {
      // Not fatal, but it changes what a permission PASS means, so it is said out loud. All nine QA
      // cases route grants through the CSV; without it every cross-tenant grantee compares as
      // unmapped and the permission result is about addresses, not about access.
      gPush('WARN', 'User mapping',
        'No user-mapping CSV was supplied. This combination is cross-tenant (see scope §2), so '
        + 'grantees are expected to be remapped — without the map, permission comparisons can only '
        + 'match grantees whose address is identical in both tenants.');
    }
    const mapEmail = (e) => emailMap[norm(e)] || norm(e);

    const units = core.resolveUnits(context);
    logger.info(`[${COMBINATION} validation] validating ${units.length} user unit(s)`);

    let destRoot;
    try {
      destRoot = await this.resolveDestinationRoot(context);
      gPush('PASS', 'Destination location', `${destRoot.label} resolved for ${context.destinationEmail}`);
    } catch (err) {
      gPush('FAIL', 'Destination location', err.message);
      return this._buildResult(globalChecks, [], { enabled: true, scannedSourceItems: 0 }, context);
    }

    const totals = this._emptyTotals(context);
    const perUser = [];
    for (const unit of units) {
      const unitResult = await this._validateUnit({
        unit, context, destRoot, rules, roleMap, bands, mapEmail, totals,
      });
      // `status` and `summary` are what the PDF's per-user pill renders — pdfGenerator prints
      // `${u.status} · ${u.summary?.split(' ')[0]}`, so with neither set the report for run 95ebb59c
      // read "User 1 undefined ·". Set here rather than at each `return result` inside
      // _validateUnit, because two of its three exits are early returns that would each need their
      // own copy. Mirrors the shape dropboxToGoogledrive already returns.
      const failed = unitResult.checks.filter((c) => c.status === 'FAIL').length;
      const passed = unitResult.checks.filter((c) => c.status === 'PASS').length;
      unitResult.status = failed > 0 ? 'FAIL' : 'PASS';
      unitResult.summary = `${passed}/${unitResult.checks.length} checks passed`;
      perUser.push(unitResult);
    }

    return this._buildResult(globalChecks, perUser, totals, context);
  }

  /** CloudFuze status, recorded as a check. A terminal status with no counts is not evidence. */
  _recordCloudFuzeStatus(context, gPush) {
    const report = context.contentMigrationReport || context.migrationJobDetails;
    const cfStatus = String(report?.status || report?.cfStatus || '').toUpperCase();
    const processed = Number(report?.processedCount) || 0;
    const total = Number(report?.totalCount) || 0;
    const hasCounts = report?.totalCount != null || report?.processedCount != null;

    if (CF_OK.includes(cfStatus) && !hasCounts) {
      gPush('WARN', 'CloudFuze migration status',
        `${cfStatus}, but CloudFuze reported no item counts — the destination comparison is the only evidence`);
    } else if (CF_OK.includes(cfStatus)) {
      gPush('PASS', 'CloudFuze migration status', `${cfStatus} — ${processed}/${total} items`);
    } else if (CF_CONFLICTS.includes(cfStatus)) {
      // Expected on this combination whenever the account holds any of the five native types —
      // conflicts are the DOCUMENTED outcome for them (out-of-scope 3.1–7.1), not a defect.
      gPush('WARN', 'CloudFuze migration status',
        `${cfStatus} — ${processed}/${total}. Conflicts are expected here if the source holds Vids, `
        + 'Forms, My Maps, Apps Script or Sites; see the per-item conflict list below.');
    } else if (!cfStatus) {
      gPush('WARN', 'CloudFuze migration status', 'Status unknown — proceeding with item-level checks');
    } else {
      gPush('FAIL', 'CloudFuze migration status', `${cfStatus} — expected PROCESSED`);
    }
  }

  /** The accumulator matching ValidationResult.deepContentValidation. */
  _emptyTotals(context) {
    return {
      enabled: true,
      combination: COMBINATION,
      migrationType: context.migrationType || 'FULL',
      allVersionsRequested: allVersionsRequested(context),
      selectiveVersionCount: selectiveVersionCount(context),
      scannedSourceItems: 0,
      pairedCount: 0,
      missingCount: 0,
      extraCount: 0,
      conflictTypeCount: 0,
      drawingCount: 0,
      permissionsChecked: 0,
      permissionMatches: 0,
      permissionMismatches: 0,
      commenterInferredCount: 0,
      linksChecked: 0,
      linkMatches: 0,
      timestampsChecked: 0,
      timestampMatches: 0,
      versionsChecked: 0,
      versionMatches: 0,
      renamedCount: 0,
      outOfScope: [],
    };
  }

  /** Resolve the SOURCE tree. Both sides are Drive, so the same client reads them. */
  async _readSourceTree(unit, bands) {
    const email = unit.sourceEmail;
    const path = unit.sourcePath || '';
    const resolved = path
      ? await driveClient.resolveFolderByPath(path, email, { rootId: 'root' })
      : { id: 'root', name: 'My Drive' };
    if (!resolved || !resolved.id) {
      throw new Error(`source path "${path}" not found in ${email}'s My Drive`);
    }
    const items = await driveClient.buildFolderTree(resolved.id, email, {
      maxDepth: bands.treeDepth || 25,
    });
    return { rootId: resolved.id, rootName: resolved.name, items };
  }

  async _validateUnit({ unit, context, destRoot, rules, roleMap, bands, mapEmail, totals }) {
    const checks = [];
    const push = (status, name, detail) => checks.push({ name, status, detail });
    const result = {
      sourceEmail: unit.sourceEmail,
      destinationEmail: unit.destinationEmail,
      sourcePath: unit.sourcePath,
      destinationPath: unit.destinationPath,
      checks,
    };

    // ── Source tree
    let source;
    try {
      source = await this._readSourceTree(unit, bands);
      push('PASS', 'Source items scanned', `${source.items.length} item(s) under ${unit.sourcePath || 'My Drive'}`);
    } catch (err) {
      push('FAIL', 'Source items scanned', `${err.message} — nothing was validated for this unit`);
      return result;
    }
    totals.scannedSourceItems += source.items.length;

    // ── Split off what is documented NOT to arrive, before anything is compared.
    const { comparable, conflicts, drawings } = partitionSource(source.items);
    totals.conflictTypeCount += conflicts.length;
    totals.drawingCount += drawings.length;

    if (conflicts.length > 0) {
      // INFO-shaped: recorded as PASS because the documented outcome is that they do not arrive.
      // Never a FAIL, and never silently dropped either — "absent" and "ignored" are not the same.
      push('PASS', 'Native types documented as non-migratable',
        `${conflicts.length} item(s) excluded from the comparison as documented conflicts: `
        + conflicts.map((c) => `${c.name} (${c.reason})`).join('; '));
      totals.outOfScope.push(...conflicts);
    }

    // ── Destination tree
    let destTree;

    try {
      const found = await this.findMigratedRoot(
        destRoot.rootId, destRoot.driveId, unit.destinationPath, source.rootName, unit.destinationEmail
      );

      destTree = await this.readTree(found.id, unit.destinationEmail, { maxDepth: bands.treeDepth || 25 });
      push('PASS', 'Destination location', `migrated root resolved at ${found.path || unit.destinationPath}`);
    } catch (err) {
      push('FAIL', 'Destination location',
        `${err.message} — the destination tree could not be read, so nothing was compared`);
      return result;
    }

    // ── Tier A: structure (features 1.1, 5.1, 7.1)
    const cmp = core.compareTrees(comparable, destTree, {
      rules,
      destPrefix: '',
      pathLimit: bands.pathLengthLimit ?? Infinity,
      segmentLimit: bands.segmentLengthLimit ?? 32767,
    });

    // core.compareTrees() returns `matched` — a Map of source path → { source, dest } — and
    // `matchedCount`. It has never returned `paired`. Reading cmp.paired therefore evaluated to
    // undefined everywhere in this file, so pairedCount was pinned at 0 no matter what migrated:
    // run 0700d557 paired 89 of 90 items and still reported "MIGRATION MOVED NOTHING — 0 of 90
    // source item(s) reached the destination", while every Tier C check (permissions, links,
    // timestamps, versions) skipped itself as "no paired item". Every other combination in this
    // folder already reads matchedCount; only this one did not.
    const pairs = [...(cmp.matched?.values() || [])];

    totals.pairedCount += cmp.matchedCount || 0;
    totals.missingCount += cmp.missing?.length || 0;
    totals.extraCount += cmp.extra?.length || 0;

    // Per-item rows and the folder roll-up the report and the dashboard read.
    //
    // This combination emitted neither, unlike every sibling (dropboxToGoogledrive emits `items` +
    // `itemDetails`, googledriveToSharepoint the same). ResultsView's Source vs Destination panel is
    // driven entirely by perUser[].items, so with the key absent it rendered SOURCE ITEMS 0, FOUND
    // AT DESTINATION 0 and "Not compared" — on run 95ebb59c, which had migrated 91/91 items and
    // paired all of them.
    result.items = comparable.map((it) => {
      const hit = cmp.matched?.get(it.path);
      return {
        path: it.path,
        name: it.name,
        type: it.type,
        found: Boolean(hit),
        destName: hit?.dest?.name || null,
        destId: hit?.dest?.id || null,
      };
    });
    result.folderStructure = core.compareFolders(comparable, destTree, {
      rules,
      pathLimit: bands.pathLengthLimit ?? Infinity,
      segmentLimit: bands.segmentLengthLimit ?? 32767,
      sourceRootName: core.lastSegment(unit.sourcePath) || '(root)',
      destRootName: source.rootName || '(root)',
      sourceLabel: 'Google My Drive',
      destLabel: 'Google My Drive',
    });

    // "None missing" is not a pass on its own — it is also what an empty comparison looks like.
    // Guard the pass on something having actually paired, or a run that compared nothing reports
    // Structure (1.1) green: run 95ebb59c printed "PASS — 0 item(s) paired, none missing" against
    // 90 scanned source items.
    if ((cmp.matchedCount || 0) === 0 && (source.items?.length || 0) > 0) {
      push('FAIL', 'Structure (1.1)',
        `nothing paired: ${source.items.length} source item(s) were scanned and none were matched at `
        + 'the destination, so no structural claim can be made');
    } else if ((cmp.missing?.length || 0) === 0) {
      push('PASS', 'Structure (1.1)', `${cmp.matchedCount || 0} item(s) paired, none missing`);
    } else {
      push('FAIL', 'Structure (1.1)',
        `${cmp.missing.length} source item(s) not found at the destination: `
        + cmp.missing.slice(0, 10).map((m) => m.path).join(', '));
    }

    // 5.1 and 7.1 expect NO change on this pair. A rename or a relocation is the finding.
    const renamed = pairs.filter((p) => p.source?.name && p.dest?.name
      && norm(p.source.name) !== norm(p.dest.name));
    totals.renamedCount += renamed.length;
    if (renamed.length === 0) {
      push('PASS', 'Special Characters Replacement (5.1)',
        'No name was altered — expected, since the destination is the same platform as the source '
        + 'and accepts every character the source allowed.');
    } else {
      push('FAIL', 'Special Characters Replacement (5.1)',
        `${renamed.length} name(s) changed, which Google should never require: `
        + renamed.slice(0, 5).map((r) => `"${r.source.name}" → "${r.dest.name}"`).join(', '));
    }

    if ((cmp.placeholderLinks?.length || 0) === 0) {
      push('PASS', 'Long-File/folder path (7.1)',
        'No path was shortened or relocated — expected, since no source path can exceed a Google '
        + 'limit when the source is also Google.');
    } else {
      push('FAIL', 'Long-File/folder path (7.1)',
        `${cmp.placeholderLinks.length} item(s) were relocated for path length, which should be `
        + 'impossible on a Google → Google run.');
    }

    // ── out-of-scope 2.1: the Drawings that were expected to arrive, as empty Docs.
    if (drawings.length > 0) {
      const landed = drawings.filter((d) => pairs
        .some((p) => norm(p.source?.path) === norm(d.path)));
      push('PASS', 'Google Drawings (out-of-scope 2.1)',
        `${landed.length}/${drawings.length} Drawing(s) arrived. Documented behaviour is that a `
        + 'Drawing migrates as a Google Doc with EMPTY data — presence here is not evidence the '
        + 'content survived, and this validator does not open them. Reported, never failed.');
    }

    // ── Tier C: permissions, links, timestamps, versions — per paired item.
    await this._validatePairedItems({ cmp, unit, roleMap, bands, mapEmail, totals, push });

    // ── Features this run cannot judge. Said explicitly so a skip never reads as a pass.
    push('WARN', 'Suppressing email notifications (6.1)',
      'Not assessed — the evidence is the ABSENCE of a notification in the destination users\' '
      + 'mailboxes, which the Drive API cannot show. Needs mailbox access to validate.');

    if (String(context.migrationType || '').toUpperCase() !== 'DELTA') {
      push('PASS', 'One Time Migration (1.2)', 'One-time run compared against the source tree');
    } else {
      push('PASS', 'Delta Migration (1.3)', 'Delta run compared against the source tree');
    }

    return result;
  }

  /** Per-item Tier C comparisons. Split out so execute() stays readable. */
  async _validatePairedItems({ cmp, unit, roleMap, bands, mapEmail, totals, push }) {
    const paired = [...(cmp.matched?.values() || [])].filter((p) => p.source && p.dest);
    const maxItems = env.DEEP_CONTENT_MAX_FILES || paired.length;
    const sample = paired.slice(0, maxItems);

    let permChecked = 0;
    let permMatched = 0;
    const permProblems = [];
    let commenterInferred = 0;
    const permUnreadable = [];

    let linkChecked = 0;
    let linkMatched = 0;
    const linkProblems = [];

    // Per-feature evidence, kept alongside the aggregates above (which still feed `totals`).
    //
    // One lumped "Permissions (2.1–2.5)" verdict cannot answer five features honestly: mapped onto
    // all five it would claim 2.5 External Shares on a run whose grants were all internal, and 2.1
    // Root Folder Permissions on a run where no root folder carried a grant. Each feature now
    // stands on the grants that are actually evidence for IT, and goes N/A on its own when it has
    // none — the rule the sibling combination states as the point of the checklist.
    const tally = () => ({ checked: 0, matched: 0, problems: [] });
    const permStats = {
      '2.1': tally(), '2.2': tally(), '2.3': tally(), '2.4': tally(), '2.5': tally(),
    };
    const linkStats = { '3.1': tally(), '3.2': tally() };
    const sourceDomain = String(unit.sourceEmail || '').split('@')[1]?.toLowerCase() || '';
    // The destination tenant is not an "outside organization" — see permissionFeatureIds.
    const destDomain = String(unit.destinationEmail || '').split('@')[1]?.toLowerCase() || '';

    let tsChecked = 0;
    let tsMatched = 0;

    let verChecked = 0;
    let verMatched = 0;
    const verProblems = [];

    const driftMs = bands.timestampDriftMs ?? 5 * 60 * 1000;
    const wantAll = totals.allVersionsRequested;
    const wantCount = totals.selectiveVersionCount;

    for (const pair of sample) {
      const s = pair.source;
      const d = pair.dest;

      // ── Permissions (2.1–2.5)
      let srcPerms = [];
      let dstPerms = [];
      try {
        srcPerms = await driveClient.listPermissions(s.id, unit.sourceEmail);
        dstPerms = await driveClient.listPermissions(d.id, unit.destinationEmail);
      } catch (err) {
        // Kept OUT of permProblems. The verdict block tests `checked === 0` first, so an item whose
        // permissions could not be read at all used to be absorbed into "No comparable source grant
        // was found" — a read failure reported as an absence of grants. It gets its own check below.
        permUnreadable.push(`${s.path} (${err.message})`);
        continue;
      }

      const srcPrincipals = principalPermissions(srcPerms);
      const dstPrincipals = principalPermissions(dstPerms);

      for (const grant of srcPrincipals) {
        if (!roleMap.isComparableDriveRole(grant.role)) continue;
        permChecked += 1;
        const featureIds = permissionFeatureIds(s, grant, sourceDomain, destDomain);
        for (const fid of featureIds) permStats[fid].checked += 1;
        const notePerFeature = (msg) => {
          for (const fid of featureIds) permStats[fid].problems.push(msg);
        };

        const wantEmail = mapEmail(grant.email);
        const destRoles = dstPrincipals
          .filter((p) => p.email === wantEmail)
          .map((p) => p.role);

        const verdict = roleMap.compareDriveAccess(grant.role, destRoles);
        if (verdict.commenterInferred) commenterInferred += 1;

        if (verdict.match) {
          permMatched += 1;
          for (const fid of featureIds) permStats[fid].matched += 1;
        } else if (verdict.commenterInferred) {
          // Held at INFO: the scope document never states the commenter mapping, so a mismatch here
          // may be the document's gap rather than the migration's. See testdata question 1.
          const msg = `${s.path}: ${grant.email} → ${wantEmail} expected ${verdict.expectedSpLabel}, `
            + `got ${verdict.actualRole || 'no grant'} — NOT FAILED: the commenter mapping is `
            + 'inferred, not documented';
          permProblems.push(msg);
          notePerFeature(msg);
        } else {
          const msg = `${s.path}: ${grant.email} → ${wantEmail} expected ${verdict.expectedSpLabel}, `
            + `got ${verdict.actualRole || 'no grant'}`
            + (verdict.overGranted ? ' (ESCALATION)' : verdict.underGranted ? ' (downgrade)' : '');
          permProblems.push(msg);
          notePerFeature(msg);
        }
      }

      // ── Shared links (3.1, 3.2)
      //
      // Compared through the role map DIRECTLY rather than through core.compareSharedLinks: that
      // helper calls the module-level SharePoint map instead of opts.roleMap, so it would translate
      // these with a table that has no Google link scopes in it.
      const srcLinks = linkPermissions(srcPerms);
      const dstLinks = linkPermissions(dstPerms);
      for (const link of srcLinks) {
        linkChecked += 1;
        // scope 'anyone' IS feature 3.1 and scope 'domain' IS feature 3.2 — the two are separable
        // with no inference, so neither one borrows the other's evidence.
        const lid = link.scope === 'domain' ? '3.2' : '3.1';
        linkStats[lid].checked += 1;
        const v = roleMap.compareSharedLink(link, dstLinks);
        if (v.match) {
          linkMatched += 1;
          linkStats[lid].matched += 1;
        } else {
          const msg = `${s.path}: link ${link.scope}/${link.type} expected `
            + `${v.expectedScope}/${v.expectedType}, got ${v.actual.join(', ') || 'no link'}`;
          linkProblems.push(msg);
          linkStats[lid].problems.push(msg);
        }
      }

      // ── Timestamps (4.1)
      // `modifiedAt`, not `modifiedTime`. driveClient.toItem() renames Drive's createdTime /
      // modifiedTime to createdAt / modifiedAt, so `s.modifiedTime` was undefined on every item and
      // tsChecked never left 0 — 4.1 reported "no paired item carried comparable timestamps" for a
      // tree where every item carries one. Every sibling combination compares on modifiedAt.
      const sMod = s.modifiedAt;
      const dMod = d.modifiedAt;
      if (sMod && dMod) {
        tsChecked += 1;
        const drift = Math.abs(new Date(dMod) - new Date(sMod));
        if (drift <= driftMs) tsMatched += 1;
      }

      // ── Versions (9.1, 9.2) — files only.
      if (s.type === 'file' && (wantAll || wantCount)) {
        try {
          const srcRev = await driveClient.listRevisions(s.id, unit.sourceEmail);
          const dstRev = await driveClient.listRevisions(d.id, unit.destinationEmail);
          verChecked += 1;
          const expected = wantCount ? Math.min(wantCount, srcRev.totalVersions) : srcRev.totalVersions;
          if (dstRev.totalVersions === expected) {
            verMatched += 1;
          } else {
            verProblems.push(
              `${s.path}: expected ${expected} version(s), destination has ${dstRev.totalVersions}`);
          }
        } catch {
          // A revision list is unavailable for native docs in some accounts; not a content defect.
        }
      }
    }

    totals.permissionsChecked += permChecked;
    totals.permissionMatches += permMatched;
    totals.permissionMismatches += permProblems.length;
    totals.commenterInferredCount += commenterInferred;
    totals.linksChecked += linkChecked;
    totals.linkMatches += linkMatched;
    totals.timestampsChecked += tsChecked;
    totals.timestampMatches += tsMatched;
    totals.versionsChecked += verChecked;
    totals.versionMatches += verMatched;

    // ── Verdicts
    // A read failure is not an absence of grants. Reported on its own so it cannot be mistaken for
    // one, and failed rather than warned: nothing about permissions was established on these items.
    if (permUnreadable.length) {
      push('FAIL', 'Permission readability',
        `${permUnreadable.length} paired item(s) had unreadable permissions, so no grant on them was `
        + `compared: ${permUnreadable.slice(0, 5).join('; ')}`);
    }

    for (const [fid, name] of Object.entries(PERM_FEATURE_CHECK_NAMES)) {
      const st = permStats[fid];
      if (st.checked === 0) {
        push('WARN', name,
          `${PERM_FEATURE_EVIDENCE[fid]} — nothing was proven about this feature. `
          + (fid === '2.5'
            // 2.5 needs a principal in NEITHER tenant, which only this address supplies.
            ? 'Set GOOGLE_TEST_EXTERNAL_EMAIL to an address outside both tenants so the seeder can '
              + 'grant it (testdata item 5).'
            : 'Seed grants per my-drive-to-my-drive-testdata.md items 1–7.'));
      } else if (st.problems.length === 0) {
        push('PASS', name,
          `${st.matched}/${st.checked} grant(s) preserved with the same role after grantee remapping`);
      } else {
        // A run whose ONLY problems are inferred-commenter ones is not failed — see the role map.
        const onlyInferred = st.problems.every((p) => p.includes('NOT FAILED'));
        push(onlyInferred ? 'WARN' : 'FAIL', name,
          `${st.matched}/${st.checked} matched. ` + st.problems.slice(0, 8).join('; '));
      }
    }

    for (const [fid, name] of Object.entries(LINK_FEATURE_CHECK_NAMES)) {
      const st = linkStats[fid];
      if (st.checked === 0) {
        push('WARN', name,
          `No ${fid === '3.2' ? 'organisation-restricted' : '"anyone with the link"'} share was `
          + 'present on any paired source item, so this feature was not exercised. Seed links per '
          + 'testdata items 11–12.');
      } else if (st.problems.length === 0) {
        push('PASS', name,
          `${st.matched}/${st.checked} link(s) preserved. Compared on SCOPE, not on the `
          + "organisation's display name — that name legitimately differs between tenants "
          + '(scope 3.2).');
      } else {
        push('FAIL', name, `${st.matched}/${st.checked} matched. ` + st.problems.slice(0, 8).join('; '));
      }
    }

    if (tsChecked === 0) {
      push('WARN', 'Metadata (4.1)', 'No paired item carried comparable timestamps');
    } else if (tsMatched === tsChecked) {
      push('PASS', 'Metadata (4.1)', `${tsMatched}/${tsChecked} modified timestamp(s) preserved`);
    } else {
      push('FAIL', 'Metadata (4.1)',
        `${tsMatched}/${tsChecked} modified timestamp(s) preserved — the rest drifted beyond `
        + `${Math.round(driftMs / 1000)}s`);
    }

    if (!wantAll && !wantCount) {
      push('WARN', 'Versions (9.1, 9.2)',
        'The job requested no version migration, so neither 9.1 nor 9.2 was exercised. Note the '
        + 'scope document evidences both with the same TWO-version screenshot — see testdata, '
        + '"The version-count problem": a file needs more than five versions for either to mean '
        + 'anything.');
    } else if (verChecked === 0) {
      push('WARN', 'Versions (9.1, 9.2)', 'No file exposed a comparable revision list');
    } else if (verProblems.length === 0) {
      push('PASS', wantCount ? 'Selective Versions (9.2)' : 'Version History (9.1)',
        `${verMatched}/${verChecked} file(s) carried the expected version count`);
    } else {
      push('FAIL', wantCount ? 'Selective Versions (9.2)' : 'Version History (9.1)',
        `${verMatched}/${verChecked} matched. ` + verProblems.slice(0, 8).join('; '));
    }

    await this._validateEmbeddedLinks({ cmp, unit, push });
  }

  /**
   * 8.1 Embedded Links — judged by FILE ID, which is the only thing that separates a rewritten link
   * from an untouched one on this pair.
   *
   * This check used to be an unconditional WARN reading "not assessed", on the grounds that the
   * rewrite is Drive-id → Drive-id on the SAME host, so a link that was never rewritten still looks
   * like a valid Drive URL and a host check would pass it. That reasoning is right about hosts and
   * wrong about the conclusion: the host is not the evidence, the file id is, and by the time this
   * runs the tree has already been paired — `cmp.matched` holds the destination id of every source
   * item, including the link target. The sibling pairs judge by host because they cross platforms
   * (`drive.google.com` → `sharepoint.com`); here the ids do the same job more precisely, and the
   * CloudFuze EmbeddedLinks CSV the old note asked for is not needed to reach a verdict.
   *
   * Three outcomes, from the two links `DriveTestDataAgent._createEmbeddedLinks` seeds:
   *
   *   PASS — the in-set link now carries the DESTINATION copy's id, and the out-of-set control link
   *          is untouched.
   *   FAIL — the in-set link still carries the SOURCE id (not rewritten), or the control link
   *          changed (rewritten when there was nothing to rewrite it to).
   *   WARN — the document, its target or its bytes could not be read. Never folded into FAIL:
   *          "the link is wrong" and "we could not look" are different findings.
   */
  async _validateEmbeddedLinks({ cmp, unit, push }) {
    const NAME = 'Embedded Links (8.1)';
    const pairs = [...(cmp.matched?.values() || [])];
    const docPair = pairs.find((p) => p.source?.name === 'embedded_link_doc.docx');
    const targetPair = pairs.find((p) => p.source?.name === 'embedded_link_target.txt');

    if (!docPair || !docPair.dest?.id) {
      push('WARN', NAME,
        'embedded_link_doc.docx did not pair to a destination copy, so there was no migrated '
        + 'document to read the links out of. Structure (1.1) above says whether it migrated at all.');
      return;
    }
    if (!targetPair || !targetPair.source?.id || !targetPair.dest?.id) {
      push('WARN', NAME,
        'embedded_link_target.txt did not pair, so the destination id a rewritten link should point '
        + 'at is unknown — the document cannot be judged without it.');
      return;
    }

    let buf;
    try {
      buf = await driveClient.downloadFile(docPair.dest.id, unit.destinationEmail);
    } catch (err) {
      push('WARN', NAME, `the migrated embedded_link_doc.docx could not be downloaded: ${err.message}`);
      return;
    }

    const parsed = extractDocxLinks(buf);
    if (!parsed.ok) {
      push('WARN', NAME, `the migrated embedded_link_doc.docx could not be read: ${parsed.reason}`);
      return;
    }

    // Both the hyperlink relationships and the visible text, because the seeded document prints each
    // URL as plain text too and a migration may rewrite one copy and not the other.
    const haystack = `${parsed.targets.join(' ')} ${parsed.text}`;
    const has = (id) => id && haystack.includes(id);

    const srcTargetId = targetPair.source.id;
    const destTargetId = targetPair.dest.id;
    const problems = [];

    if (has(destTargetId)) {
      // Rewritten. Nothing to report for the in-set link.
    } else if (has(srcTargetId)) {
      problems.push(
        `the link to embedded_link_target.txt still points at the SOURCE file (${srcTargetId}); `
        + `the migrated copy is ${destTargetId}, so the document opens the pre-migration file`);
    } else {
      problems.push(
        'the link to embedded_link_target.txt carries neither the source id nor the destination id — '
        + `expected ${destTargetId} (or ${srcTargetId} if unrewritten), found `
        + `${parsed.targets.join(', ') || 'no hyperlink target'}`);
    }

    // The control. Seeded as a file id that is not in the migration set, so a correct migration has
    // nothing to map it to and must leave it exactly as it was. Read from the seeding agent rather
    // than spelled again here — a second copy of the sentinel would keep matching itself while
    // silently ceasing to match what was actually seeded.
    if (!has(EMBEDDED_LINK_OUT_OF_SET_ID)) {
      problems.push(
        `the control link (${EMBEDDED_LINK_OUT_OF_SET_ID}), which points outside the migration set `
        + 'and must never be rewritten, is no longer in the document — CloudFuze altered a URL it '
        + 'has no destination copy for');
    }

    if (problems.length === 0) {
      push('PASS', NAME,
        `the in-document link was rewritten to the migrated target (${destTargetId}) and the `
        + 'out-of-set control link was left unchanged');
    } else {
      push('FAIL', NAME, `${problems.length} problem(s). ` + problems.join('; '));
    }
  }

  /** The 17-feature checklist, in the scope document's numbering. */
  _buildChecklist(totals, flat) {
    const byFeature = (id) => {
      const covering = LUMPED_FEATURE_CHECKS[id];
      if (covering) return flat.find((c) => covering.some((n) => String(c.name).includes(n)));
      return flat.find((c) => String(c.name).includes(`(${id})`));
    };
    const rows = DRIVE_FEATURES.map((f) => {
      const hit = byFeature(f.id);
      let status = 'na';
      if (hit?.status === 'PASS') status = 'pass';
      else if (hit?.status === 'FAIL') status = 'fail';
      return {
        id: f.id,
        category: f.category,
        // `feature`, not `name`. Every consumer — pdfGenerator's drawContentFeatureChecklist above
        // all — reads { id, category, feature }, which is what the shared builder and all three
        // sibling combinations emit. Emitting `name` here printed the whole checklist as
        // "1.1 undefined", "2.1 undefined" … in the PDF, and dropped the category headers with it.
        feature: f.feature,
        status,
        detail: hit?.detail || 'Not assessed by this run',
      };
    });

    // The out-of-scope features are appended but never contribute a FAIL — they exist so a reviewer
    // can see they were considered, which is the whole point of an out-of-scope document.
    for (const o of OUT_OF_SCOPE_FEATURES) {
      rows.push({
        id: o.id,
        category: o.category,
        feature: `${o.feature} (out of scope)`,
        status: 'na',
        detail: o.note
          || (o.expectAbsent
            ? 'Documented as going into conflict and non-migratable — absence at the destination is '
              + 'the expected outcome and is never failed.'
            : 'Out of scope — reported, never failed.'),
      });
    }
    return rows;
  }

  _buildResult(globalChecks, perUser, totals, context) {
    const flat = [...globalChecks];
    for (const u of perUser) {
      const tag = u.sourceEmail || 'unit';
      for (const c of u.checks) flat.push({ ...c, name: `[${tag}] ${c.name}` });
    }

    const hasFail = flat.some((c) => c.status === 'FAIL');
    const hasWarn = flat.some((c) => c.status === 'WARN');
    const overall = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';

    const featureChecklist = this._buildChecklist(totals, flat);
    const counts = featureChecklist.reduce(
      (acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}
    );
    const featureSummary = {
      line: `Features: ${counts.pass || 0} pass, ${counts.fail || 0} fail, ${counts.na || 0} not assessed `
        + `(of ${featureChecklist.length})`,
      pass: counts.pass || 0,
      fail: counts.fail || 0,
      na: counts.na || 0,
      total: featureChecklist.length,
    };
    if (totals) {
      totals.featureChecklist = featureChecklist;
      totals.featureSummary = featureSummary;
    }

    const infraCheck = /Destination location|Source items scanned|Deep content validation|User mapping/i;
    const mismatches = flat
      .filter((c) => c.status === 'FAIL')
      .map((c) => {
        const infra = infraCheck.test(c.name);
        return {
          category: 'content',
          kind: infra ? 'infrastructure' : 'content',
          kindLabel: infra ? 'Validation could not run' : 'Content comparison',
          field: c.name,
          expected: 'source and destination identical',
          actual: c.detail || '(no detail)',
          summaryLine: `${c.name}: ${c.detail || '(no detail)'}`.slice(0, 300),
          severity: infra ? 'critical' : 'error',
        };
      });

    const scanned = totals?.scannedSourceItems || 0;
    const paired = totals?.pairedCount || 0;
    const passed = flat.filter((c) => c.status === 'PASS').length;

    const summary = (() => {
      const tail = `${perUser.length} unit(s); ${scanned} source item(s) scanned, ${paired} paired. `
        + featureSummary.line;
      if (scanned > 0 && paired === 0) {
        return `MIGRATION MOVED NOTHING — 0 of ${scanned} source item(s) reached the destination, so no `
          + `content was compared. ${passed}/${flat.length} reachability check(s) passed — these say `
          + `nothing about migrated data. ${tail}`;
      }
      return `${passed}/${flat.length} checks passed across ${tail}`;
    })();

    if (totals) totals.summary = summary;

    return {
      featureChecklist,
      featureSummary,
      mismatches,
      status: overall,
      overallStatus: overall,
      domain: 'content',
      sourceProvider: 'googledrive',
      destinationProvider: context?.destinationProvider || 'googledrive',
      combination: COMBINATION,
      checks: flat,
      perUser,
      deepContentValidation: totals,
      summary,
    };
  }
}

module.exports = GoogledriveToGoogledriveValidationAgent;
module.exports.COMBINATION = COMBINATION;
module.exports.DRIVE_FEATURES = DRIVE_FEATURES;
module.exports.OUT_OF_SCOPE_FEATURES = OUT_OF_SCOPE_FEATURES;
module.exports.NATIVE_CONFLICT_TYPES = NATIVE_CONFLICT_TYPES;
module.exports.partitionSource = partitionSource;
module.exports.isConflictType = isConflictType;
module.exports.linkPermissions = linkPermissions;
module.exports.permissionFeatureIds = permissionFeatureIds;
module.exports.PERM_FEATURE_CHECK_NAMES = PERM_FEATURE_CHECK_NAMES;
module.exports.LINK_FEATURE_CHECK_NAMES = LINK_FEATURE_CHECK_NAMES;
module.exports.principalPermissions = principalPermissions;
module.exports.allVersionsRequested = allVersionsRequested;
module.exports.selectiveVersionCount = selectiveVersionCount;
