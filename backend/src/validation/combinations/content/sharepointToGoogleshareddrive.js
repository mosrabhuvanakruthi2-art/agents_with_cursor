'use strict';

/**
 * Deep validation for content: SharePoint Online → Google Shared Drive.
 *
 * Edit ONLY this file to change SharePoint → Shared Drive behaviour. How GOOGLE is read lives in
 * agents/googledrive/GoogleDriveValidationAgent.js (destination side, shared with the Dropbox
 * pairs); provider-agnostic comparison lives in validation/shared/deepContentCore.js; the numbers
 * live in utils/contentTolerance/sharepointToGoogleshareddrive.js; the role table lives in
 * validation/roleMaps/sharepoint_to_google.js.
 *
 * Feature coverage — the 17 in-scope features of
 * `backend/data/feature-scope/sharepoint-to-google-shared-drive-inscope.md`, in the document's own
 * numbering:
 *
 *   1.1  Onetime                       ← the structure comparison, read under the run's type
 *   1.2  Delta                         ←     "
 *   2.1  Preserving file/folder structure   Tier A tree comparison
 *   3.1  Root folder permissions       Tier C, by POSITION in the tree
 *   4.1  Root file permissions              "
 *   5.1  Sub-folder permissions             "
 *   6.1  Inner file permissions             "
 *   7.1  Shared links                  Tier C, scope + type on both axes
 *   8.1  External shares               Tier C, by PRINCIPAL (outside the source tenant)
 *   9.1  Metadata                      created/modified timestamps within the drift band
 *   10.1 Version history               history PRESENT at the destination (counts informational)
 *   11.1 Special characters            NEGATIVE test — Google replaces nothing, names arrive intact
 *   12.1 Long folder path              NEGATIVE test — Google has no limit, nothing is relocated
 *   13.1 Suppress email notifications  NOT VERIFIED — see _checkNotificationSuppression
 *   14.1 Embedded links                links inside a migrated document, re-pointed at the copy
 *   15.1 Custom library                a non-default SharePoint library arrives with its content
 *   16.1 CrossLinks                    a link that crosses libraries, re-pointed at the copy
 *
 * Out of scope (`…-outscope.md`) — reported as INFO and never allowed to fail a run: selective
 * versions, in-line comments, Lists and page libraries, coloured folders, SharePoint site-level
 * permissions, "Modified By"/"Created By" identity, document expiration dates, Forms, shortcuts,
 * legal-hold data, the single Google group type, external members of migrated groups, and Google's
 * own share notifications.
 *
 * Two shapes of this combination are worth stating, because both have burned a sibling:
 *
 *   1. **SharePoint is the SOURCE here.** agents/sharepoint/SharePointValidationAgent.js reads
 *      SharePoint as a DESTINATION and is not reused: its site resolution keys on
 *      `destinationEmail`, and its migrated-root probe looks for a folder CloudFuze created. The
 *      source side needs neither. Source-side reads therefore go straight to sharepointClient,
 *      which is what CONTRIBUTING asks for ("source-side behaviour stays in the combination file").
 *   2. **Google applies item sharing minutes-to-tens-of-minutes AFTER the copy.** A grant that is
 *      missing on the first read is reported as NOT YET JUDGEABLE, never as a defect — the Dropbox
 *      pair filed four bug tickets against permissions that a later read showed were correct.
 */

const GoogleDriveValidationAgent = require('../../../agents/googledrive/GoogleDriveValidationAgent');
const sharepointClient = require('../../../clients/sharepointClient');
const docxLinks = require('../../../utils/docxLinks');
const core = require('../../shared/deepContentCore');
const destinations = require('../../destinations');
const roleMaps = require('../../roleMaps');
const tolerance = require('../../../utils/contentTolerance');
const env = require('../../../config/env');
const logger = require('../../../utils/logger');

const DEFAULT_COMBINATION = 'sharepoint_to_googleshareddrive';

/**
 * The tolerance/role-map lookup key for this run.
 *
 * A function rather than a constant, for the reason the Dropbox pair documents: if this file is
 * ever registered for a My Drive destination too, a hardcoded key would silently read the Shared
 * Drive bands and label every My Drive run as a Shared Drive one.
 */
function combinationFor(context) {
  const provider = String(context?.destinationProvider || 'googleshareddrive').toLowerCase();
  return provider === 'googledrive' ? 'sharepoint_to_googledrive' : DEFAULT_COMBINATION;
}

/** How long to wait for CloudFuze's permission phase before calling a grant missing. */
const PERMISSION_SETTLE_ATTEMPTS = env.CONTENT_PERMISSION_SETTLE_ATTEMPTS;
const PERMISSION_SETTLE_MS = env.CONTENT_PERMISSION_SETTLE_MS;

/** Terminal CloudFuze statuses that mean the migration itself finished. */
const CF_OK = ['PROCESSED', 'PROCESS', 'VERSION_PROCESSED'];
const CF_CONFLICTS = ['PROCESSED_WITH_CONFLICTS', 'PROCESS_WITH_CONFLICTS'];

/**
 * The 17 in-scope features, in the scope document's own numbering.
 *
 * A combination-local list rather than validation/shared/contentFunctionalityChecklist.js: that
 * module hardcodes the Google→SharePoint feature set (Commenter / Content Manager roles, "Sync
 * Orbit" wording) which does not describe this pair, and editing it would change both live
 * SharePoint-destination combinations — which CONTRIBUTING forbids.
 */
const SHAREPOINT_FEATURES = [
  { id: '1.1', category: 'Migration', feature: 'Onetime' },
  { id: '1.2', category: 'Migration', feature: 'Delta' },
  { id: '2.1', category: 'Preserving File/Folder structure', feature: 'Preserving File/Folder structure' },
  { id: '3.1', category: 'Root Folder Permissions', feature: 'Root Folder Permissions' },
  { id: '4.1', category: 'Root File Permissions', feature: 'Root File Permissions' },
  { id: '5.1', category: 'Sub-folder permissions', feature: 'Sub-folder permissions' },
  { id: '6.1', category: 'Inner file permissions', feature: 'Inner file permissions' },
  { id: '7.1', category: 'Shared links', feature: 'Shared links' },
  { id: '8.1', category: 'External Shares', feature: 'External Shares' },
  { id: '9.1', category: 'Metadata', feature: 'Metadata' },
  { id: '10.1', category: 'Version History', feature: 'Version History' },
  { id: '11.1', category: 'Special Characters Replacement', feature: 'Special Characters Replacement' },
  { id: '12.1', category: 'Long-File/folder path', feature: 'Long-folder path' },
  { id: '13.1', category: 'Suppress email notifications', feature: 'Suppress email notifications' },
  { id: '14.1', category: 'Embedded Links', feature: 'Embedded Links' },
  { id: '15.1', category: 'Custom Library', feature: 'Custom Library' },
  { id: '16.1', category: 'CrossLinks', feature: 'CrossLinks' },
];

/**
 * Documented limitations from the out-of-scope document, reported as INFO on every run.
 *
 * Stated rather than silently absent: a reader holding the out-of-scope document should see the
 * suite acknowledge each item, and a future run that starts failing one of them should be
 * recognisable as a scope change rather than a new defect.
 */
const OUT_OF_SCOPE_NOTES = [
  ['Selective Versions', 'Selective/specific version migration is not supported for Microsoft → Google. '
    + 'Version PRESENCE is checked under 10.1; an exact count is not asserted.'],
  ['In-line comments', 'Threaded comments in an Office file are not preserved as native Google comments.'],
  ['Lists and page libraries', 'SharePoint Lists and page libraries are not migrated by CloudFuze, so '
    + 'they are never expected at the destination.'],
  ['Coloured folders', 'Folder colour metadata does not migrate; structure and contents do.'],
  ['Site-level permissions', 'SharePoint site-level permissions are not migrated. Only file- and '
    + 'folder-level grants are compared here (features 3.1-6.1).'],
  ['Modified By / Created By', 'Google does not accept the source identity, so createdBy/modifiedBy '
    + 'are recorded but never compared. Timestamps ARE compared, under 9.1.'],
  ['Document expiration dates', 'SharePoint expiration metadata has no Google counterpart.'],
  ['Forms', 'Microsoft Forms do not migrate — an empty folder at the destination is the documented outcome.'],
  ['Shortcuts', 'SharePoint shortcuts do not migrate.'],
  ['Legal Hold data', 'Legal-hold and compliance retention data do not migrate.'],
  ['Single standard group type', 'Google has one group type, so a Distribution List, M365 group and '
    + 'security group all arrive as one standard Google Group.'],
  ['Group external members', 'External members of a migrated group are not preserved — internal '
    + 'members only.'],
  ['Google share notifications', 'Google notifies admin accounts on share by default; suppression is '
    + 'a destination-side setting, not a migration outcome.'],
];

/** SharePoint site-collection groups, which appear on items and are not migrated permissions. */
function isBuiltinSiteGroup(principal) {
  if (String(principal?.principalType || '').toLowerCase() !== 'group') return false;
  const name = String(principal.name || principal.displayName || '').toLowerCase().trim();
  const email = String(principal.email || '').toLowerCase().trim();
  if (/\b(owners|members|visitors)$/.test(name)) return true;
  if (/@[^@]*\.onmicrosoft\.com$/.test(email)) return true;
  return false;
}

class SharepointToGoogleshareddriveValidationAgent extends GoogleDriveValidationAgent {
  static supportsDeepValidation = true;

  constructor() {
    super('SharepointToGoogleshareddriveValidationAgent');
  }

  async execute(context) {
    const COMBINATION = combinationFor(context);
    const bands = tolerance.forCombination(COMBINATION) || {};
    const rules = destinations.forDestination('googleshareddrive');
    const roleMap = roleMaps.forCombination(COMBINATION);
    const globalChecks = [];
    const gPush = (status, name, detail) => globalChecks.push({ name, status, detail });

    if (!rules) {
      throw new Error(
        'validation/destinations/googledrive.js is not registered — the Google destination rules are '
        + 'required. Without them this validator would fall back to SharePoint\'s own rules and '
        + 'report false renames and false path-limit relocations against a destination that '
        + 'performs neither.'
      );
    }
    if (!roleMap) {
      throw new Error(
        `validation/roleMaps has no map covering "${COMBINATION}". Refusing to fall back to the `
        + 'Box/Drive→SharePoint role table, which has no Google roles in it and would mistranslate '
        + 'every grant.'
      );
    }

    if (!env.ENABLE_DEEP_CONTENT_VALIDATION) {
      gPush('WARN', 'Deep content validation',
        'Disabled by ENABLE_DEEP_CONTENT_VALIDATION=false — nothing was compared');
      return this._buildResult(globalChecks, [], { enabled: false }, context);
    }

    this._recordCloudFuzeStatus(context, gPush);

    const emailMap = core.buildEmailMap(context);
    // { detail: true } tells the caller whether a mapping actually existed, instead of silently
    // handing back the input address and comparing it against a tenant it cannot belong to.
    const mapEmail = (e, opts) => {
      const key = String(e || '').toLowerCase();
      const hit = emailMap[key];
      if (opts && opts.detail) return { email: hit || key, mapped: Boolean(hit) };
      return hit || key;
    };
    const units = core.resolveUnits(context);
    logger.info(`[${COMBINATION} validation] validating ${units.length} user unit(s)`);

    // ── Source site (SharePoint is the source in this pair) ─────────────────
    let site;
    try {
      site = await this._resolveSourceSite(context);
      gPush('PASS', 'Source site accessible', `${site.hostname}${site.sitePath} read as ${context.sourceEmail}`);
    } catch (err) {
      gPush('FAIL', 'Source items scanned', err.message);
      return this._buildResult(globalChecks, [], { enabled: true, scannedSourceItems: 0 }, context);
    }

    // ── Destination root (the destination-side agent owns how Google is read) ─
    let destRoot;
    try {
      destRoot = await this.resolveDestinationRoot(context);
      gPush('PASS', 'Destination location', `${destRoot.label} resolved for ${context.destinationEmail}`);
    } catch (err) {
      // An AUTH failure is not a migration finding, and Google's own wording gives the reader
      // nothing to act on: "unauthorized_client: Client is unauthorized to retrieve access tokens
      // using this method" means the service account has no Domain-Wide Delegation in the
      // destination user's Workspace domain and no OAuth token is stored for them — so the
      // destination could not be READ, which is different from the destination being empty.
      // Observed on the first end-to-end run, where the mapped destination user was an account
      // that had never been connected.
      const authFailure = /unauthorized_client|invalid_grant|access_denied|invalid_client/i.test(err.message);
      gPush('FAIL', 'Destination location', authFailure
        ? `Could not READ the destination as ${context.destinationEmail} — ${err.message} `
          + 'This is an access problem, NOT evidence about the migration: Domain-Wide Delegation is '
          + `not authorised for @${String(context.destinationEmail || '').split('@')[1] || 'that domain'} `
          + 'and no OAuth token is stored for this account. Connect it under Connect Clouds, or map '
          + 'the pair to an account that is connected (Map Users). Nothing below says anything about '
          + 'what did or did not migrate.'
        : err.message);
      return this._buildResult(globalChecks, [], { enabled: true, scannedSourceItems: 0 }, context);
    }

    const skipped = Array.isArray(context.skippedUsers) ? context.skippedUsers : [];
    if (skipped.length > 0) {
      gPush('WARN', `Skipped pairs (${skipped.length})`,
        skipped.map((s) => `${s.sourceEmail} "${s.sourcePath}" — ${s.reason || 'not migrated'}`).join(' | '));
    }

    const totals = this._emptyTotals(context);
    const perUser = [];

    for (const unit of units) {
      perUser.push(await this._validateUnit({
        unit, context, site, destRoot, rules, roleMap, bands, mapEmail, totals,
      }));
    }

    // Features that live outside a single transfer unit.
    const globalPush = (status, name, detail) => globalChecks.push({ name, status, detail });
    await this._checkCustomLibrary(globalPush, context, site, destRoot, rules, bands, totals);
    this._checkNotificationSuppression(globalPush, totals);
    this._recordOutOfScope(globalPush);

    return this._buildResult(globalChecks, perUser, totals, context);
  }

  /**
   * Resolve the SOURCE SharePoint site.
   *
   * SHAREPOINT_SOURCE_* first, then the destination-side settings, then the tenant's own root
   * hostname — which is not derivable from the email domain (granger@gajha.com is served at
   * trydemos.sharepoint.com), the trap resolveTenantHostname exists for. Mirrors
   * SharePointTestDataAgent._resolveSite so seeding and validation cannot disagree about which
   * site holds the data.
   */
  async _resolveSourceSite(context) {
    const email = context.sourceEmail;
    const sitePath = (context.sharepointSourceSitePath
      || env.SHAREPOINT_SOURCE_SITE_PATH
      || env.SHAREPOINT_SITE_PATH || '').trim();
    if (!sitePath) {
      throw new Error('No SharePoint source site configured — set SHAREPOINT_SOURCE_SITE_PATH.');
    }
    const configured = (context.sharepointSourceHostname
      || env.SHAREPOINT_SOURCE_HOSTNAME
      || env.SHAREPOINT_HOSTNAME || '').trim();
    try {
      // The same resolver the seeder uses, so validation reads the tenant that was actually seeded.
      return await sharepointClient.resolveSiteForAccount(email, sitePath, configured);
    } catch (err) {
      throw new Error(
        `The SharePoint SOURCE site could not be read. ${err.message} Nothing was validated — a `
        + 'source that cannot be read is not an empty source.'
      );
    }
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
      gPush('WARN', 'CloudFuze migration status', `${cfStatus} — ${processed}/${total} (conflicts present)`);
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
      combination: combinationFor(context),
      migrationType: context.migrationType || 'FULL',
      scannedSourceItems: 0,
      pairedCount: 0,
      skippedCount: 0,
      missing: [],
      extra: [],
      misplaced: [],
      placeholderLinks: [],
      notMigratable: [],
      notComparable: [],
      hashedCount: 0,
      notHashedCount: 0,
      hashMismatches: [],
      permissionMismatches: [],
      permissionObservations: [],
      // The PATHS of items whose grants CloudFuze had not applied yet — not just a count. The
      // roll-up has to know WHICH feature a pending item belongs to.
      permissionsPendingPaths: [],
      sharedLinkMismatches: [],
      linkObservations: [],
      conversionMismatches: [],
      timestampDrift: [],
      versionInfo: [],
      notificationLeaks: [],
      embeddedLinkEvidence: [],
      crossLinkEvidence: [],
      customLibrary: null,
      specialChars: { total: 0, arrived: 0 },
      longPathEvidence: [],
      outOfScopeNotes: [],
      featureChecklist: [],
      featureSummary: null,
      itemResults: [],
      summary: '',
    };
  }

  /** Validate one source→destination unit. */
  async _validateUnit({ unit, context, site, destRoot, rules, roleMap, bands, mapEmail, totals }) {
    const combination = combinationFor(context);
    const checks = [];
    const push = (status, name, detail) => checks.push({ name, status, detail });
    const sourceEmail = unit.sourceEmail || context.sourceEmail;
    const destEmail = unit.destinationEmail || context.destinationEmail;
    // The seeded root, library-root relative: "/Agent SharePoint Data".
    const sourcePath = `/${String(unit.sourcePath || context.sourceTestDataPath || '').replace(/^\/+/, '')}`
      .replace(/\/+$/, '') || '/';

    // ── Source: the SharePoint tree.
    let sourceTree = [];
    try {
      sourceTree = await sharepointClient.buildFolderTree(
        site.siteId, sourcePath, sourceEmail, bands.treeDepth || 25
      );
    } catch (err) {
      push('FAIL', 'Source items scanned',
        `Could not read SharePoint ${site.hostname}${site.sitePath}${sourcePath}: ${err.message}`);
      return { sourceEmail, destinationPath: unit.destinationPath, checks, items: [], itemDetails: [] };
    }

    if (sourceTree.length === 0) {
      push('FAIL', 'Source items scanned',
        `No source items were read from SharePoint ${sourcePath}. Either seeding did not run for `
        + 'this unit, or the app lacks read access to the library.');
      return { sourceEmail, destinationPath: unit.destinationPath, checks, items: [], itemDetails: [] };
    }

    // Keep the absolute library path before relativizing: every per-item read below hands the path
    // back to Graph, where the relativized form does not exist. The Dropbox pair lost permissions,
    // links and versions for a whole run to exactly this, and its catches turned the 404s into
    // "no source permissions".
    for (const item of sourceTree) item.spPath = item.path;
    sourceTree = core.relativize(sourceTree, sourcePath);

    totals.scannedSourceItems += sourceTree.length;
    push('PASS', 'Source items scanned',
      `${sourceTree.length} item(s) read from SharePoint ${sourcePath}`);

    // ── Destination: where it landed, and its tree.
    const sourceFolderName = core.lastSegment(sourcePath);
    const migrated = await this.findMigratedRoot(
      destRoot.rootId, destRoot.driveId, unit.destinationPath, sourceFolderName, destEmail
    );
    if (!migrated) {
      push('FAIL', 'Destination location',
        `Nothing named "${sourceFolderName}" (or a dedup variant) exists under ${destRoot.label} — `
        + 'the migration appears to have created nothing.');
      return { sourceEmail, destinationPath: unit.destinationPath, checks, items: [], itemDetails: [] };
    }
    push('PASS', 'Destination location', `Migrated content found at ${migrated.path} in ${destRoot.label}`);

    const destTree = await this.readTree(migrated.id, destEmail, {
      driveId: destRoot.driveId,
      maxDepth: bands.treeDepth || 25,
    });

    // ── Feature 2.1: structure, with GOOGLE's rules.
    const cmp = core.compareTrees(sourceTree, destTree, {
      rules,
      pathLimit: bands.pathLengthLimit ?? rules.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit ?? rules.segmentLengthLimit,
    });

    totals.pairedCount += cmp.matchedCount;
    totals.missing.push(...cmp.missing.map((i) => ({ path: i.path, type: i.type, name: i.name })));
    totals.extra.push(...cmp.extra.map((i) => ({ path: i.path, type: i.type, name: i.name })));
    totals.misplaced.push(...(cmp.misplaced || []));
    totals.placeholderLinks.push(...(cmp.placeholderLinks || []));
    totals.notMigratable.push(...(cmp.notMigratable || []));

    const structureOk = cmp.missing.length === 0
      && (cmp.extra || []).length === 0
      && (cmp.misplaced || []).length === 0;
    push(structureOk ? 'PASS' : 'FAIL', '2.1 Preserving File/Folder structure',
      `source ${cmp.totalSource}, dest ${cmp.totalDest}, matched ${cmp.matchedCount}, `
      + `missing ${cmp.missing.length}, extra ${(cmp.extra || []).length}, `
      + `misplaced ${(cmp.misplaced || []).length}`);

    // ── Per-item Tier C (+ Tier B when enabled).
    const itemDetails = [];
    for (const { source: srcItem, dest: destItem } of cmp.matched.values()) {
      if (!srcItem || !destItem) continue;
      itemDetails.push(await this._validateItem({
        srcItem, destItem, site, sourceEmail, destEmail, roleMap, bands, mapEmail, totals, combination,
      }));
    }

    if (totals.uninspectable) {
      push('WARN', 'Items inspected',
        `${totals.uninspectable} of ${cmp.matchedCount} paired item(s) carried no destination id, so `
        + 'their permissions, versions and content hashes were NOT checked. They are present at the '
        + 'destination but unverified — do not read them as passing.');
    }

    this._rollUpItemChecks(push, totals, itemDetails);
    this._checkSpecialCharacters(push, sourceTree, cmp, rules, totals);
    this._checkLongPaths(push, sourceTree, cmp, rules, totals);
    await this._checkEmbeddedAndCrossLinks(push, context, cmp, destEmail, totals);

    const folderStructure = core.compareFolders(sourceTree, destTree, {
      rules,
      pathLimit: bands.pathLengthLimit ?? rules.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit ?? rules.segmentLengthLimit,
      sourceRootName: sourceFolderName || '(root)',
      destRootName: migrated.name || '(root)',
      sourceLabel: 'SharePoint',
      destLabel: destRoot.driveId ? 'Google Shared Drive' : 'Google My Drive',
    });

    const passed = checks.filter((c) => c.status === 'PASS').length;
    const failed = checks.filter((c) => c.status === 'FAIL').length;

    return {
      sourceEmail,
      destinationEmail: destEmail,
      sourcePath,
      destinationPath: unit.destinationPath,
      sourceDriveName: null,
      mapping: {
        sourceEmail,
        sourceLocation: `${site.hostname}${site.sitePath}${sourcePath}`,
        destEmail,
        destLocation: `${unit.destinationPath || '/'}`
          + (migrated.path && migrated.path !== '/' ? ` → ${migrated.path}` : ''),
      },
      status: failed > 0 ? 'FAIL' : 'PASS',
      summary: `${passed}/${checks.length} checks passed`,
      checks,
      folderStructure,
      // Both names: `items` is what the PDF and the UI read, `itemDetails` is what this file's own
      // roll-up consumes. Keeping only one breaks whichever reader was not updated.
      items: itemDetails,
      itemDetails,
    };
  }

  /** Tier C + Tier B for one paired item. */
  async _validateItem({
    srcItem, destItem, site, sourceEmail, destEmail, roleMap, bands, mapEmail, totals, combination,
  }) {
    const row = {
      path: srcItem.path,
      name: srcItem.name,
      type: srcItem.type,
      found: true,
      destName: destItem.name,
      sourceLabel: 'SharePoint',
      // The report renders "<source> "<role>" → <dest> <roles>"; without this the destination half
      // was labelled "SP", i.e. the source cloud, on a Google destination.
      destLabel: 'Google',
    };

    // A paired destination item with no id cannot be inspected, and every Drive call would reject
    // with "Missing required parameters: fileId" — which retry.js treats as retryable, so each one
    // burns ~15s of guaranteed-doomed backoff. Counted and surfaced: an item nobody could inspect
    // is not an item that passed.
    if (!destItem.id) {
      row.inspectionSkipped = 'destination item carries no id, so it could not be inspected';
      totals.uninspectable = (totals.uninspectable || 0) + 1;
      logger.warn(`[${combination} validation] "${srcItem.path}" paired with a destination item `
        + 'that has no id — skipping its permission, version and hash checks');
      return row;
    }

    const spPath = srcItem.spPath || srcItem.path;
    const [srcPerms, destPermsFirst] = await Promise.all([
      sharepointClient.getItemPermissions(site.siteId, spPath, sourceEmail).catch((err) => {
        // Logged, never silent: an unreadable source is not an unshared one, and treating it as
        // "none" is how a permission gap becomes an invisible pass.
        logger.warn(`[${combination} validation] could not read source permissions for `
          + `"${spPath}": ${err.message}`);
        return { found: false, permissions: [], links: [] };
      }),
      this.readPermissions(destItem.id, destEmail),
    ]);
    let destPerms = destPermsFirst;

    // Comparable source grants: real principals only.
    //
    // SharePoint's own site groups (<Site> Owners/Members/Visitors and the @*.onmicrosoft.com
    // principal behind the M365 group) sit on effectively every item and are not migrated
    // permissions. Counting them would demand Google grants that should not exist, and failing
    // features 3.1-6.1 on them would be a defect invented by the validator.
    const sourcePerms = (srcPerms.permissions || [])
      .filter((p) => !p.isLink)
      .filter((p) => !isBuiltinSiteGroup(p))
      .filter((p) => (p.email || p.name))
      .filter((p) => (p.roles || []).some((r) => roleMap.isComparableDriveRole(r)))
      .map((p) => ({
        email: p.email || '',
        displayName: p.name || '',
        type: p.principalType === 'group' ? 'group' : 'user',
        // The item's highest comparable role — Graph can list several on one permission entry.
        role: (p.roles || [])
          .filter((r) => roleMap.isComparableDriveRole(r))
          .sort((a, b) => roleMap.driveRoleLevel(b) - roleMap.driveRoleLevel(a))[0],
      }));

    for (const p of (srcPerms.permissions || []).filter((x) => !x.isLink && !isBuiltinSiteGroup(x))) {
      const nonComparable = (p.roles || []).filter((r) => !roleMap.isComparableDriveRole(r));
      if (nonComparable.length > 0 && !sourcePerms.some((s) => s.email === (p.email || ''))) {
        totals.notComparable.push({
          path: srcItem.path,
          principal: p.email || p.name,
          role: nonComparable.join(', '),
          reason: roleMap.nonComparableReason(nonComparable[0]),
        });
      }
    }

    // Has CloudFuze applied the item-level grants yet?
    //
    // Asking "does the destination have ZERO grants" never fires on a Shared Drive: every item
    // there always carries the drive's own grant by inheritance. The right question is whether any
    // DIRECT grant exists — CloudFuze re-grants per item, so a processed item has at least one.
    const directGrants = (perms) => (perms.permissions || []).filter((x) => !x.inherited);

    if (sourcePerms.length > 0 && directGrants(destPerms).length === 0) {
      for (let attempt = 1; attempt <= PERMISSION_SETTLE_ATTEMPTS; attempt += 1) {
        await new Promise((r) => setTimeout(r, PERMISSION_SETTLE_MS));
        const retry = await this.readPermissions(destItem.id, destEmail);
        if (directGrants(retry).length > 0) {
          logger.info(`[${combination} validation] "${srcItem.path}" had no direct destination `
            + `grants on the first read; ${directGrants(retry).length} appeared after `
            + `${attempt * (PERMISSION_SETTLE_MS / 1000)}s — CloudFuze was still applying sharing`);
          destPerms = retry;
          break;
        }
      }
    }

    // Still only inherited grants: the sharing phase has not run for this item YET.
    //
    // Marked NOT YET JUDGEABLE rather than failed. On the sibling combination the grants appeared
    // tens of MINUTES after the job reported PROCESSED, and failing early filed four bug tickets
    // against permissions that were correct.
    if (sourcePerms.length > 0 && directGrants(destPerms).length === 0) {
      row.permissionsNotYetApplied = true;
      totals.permissionsPendingPaths.push(srcItem.path);
      logger.warn(`[${combination} validation] "${srcItem.path}" still carries only inherited `
        + `drive grants after ${PERMISSION_SETTLE_ATTEMPTS * (PERMISSION_SETTLE_MS / 1000)}s — `
        + 'CloudFuze has not applied item sharing yet. Reported as pending, NOT as a difference.');
    }

    if (sourcePerms.length > 0) {
      const permCmp = core.comparePermissions(sourcePerms, destPerms.permissions, mapEmail, {
        roleMap,
        // A Google group may legitimately stand in for a user's grant (the migrated group holds
        // them as a member), but the DRIVE-level grant every Shared Drive item inherits must not:
        // it covers everyone with drive access, so accepting it would satisfy every user grant
        // automatically and pass the whole permission check regardless of what migrated.
        groupFallbackFrom: (d) => !d.inherited,
      });
      row.permissionComparison = permCmp;
      // The per-grant ARRAY the report renders. pdfGenerator iterates `it.permissions`, so handing
      // it the comparison object throws "object is not iterable" and takes the PDF endpoint down
      // with a 500 — which is how the sibling combination learned this.
      row.permissions = [
        ...(permCmp.matches || []).map((m) => ({ ...m, match: true })),
        ...(permCmp.mismatches || []).map((m) => ({ ...m, match: false })),
        ...(permCmp.escalations || []).map((m) => ({ ...m, match: false })),
        ...(permCmp.viaGroup || []).map((m) => ({ ...m, match: true, viaGroup: true })),
      ];

      // Feature 8.1 asks about a grant to someone OUTSIDE the source organisation, which is a
      // question about the PRINCIPAL rather than the item's position — so it is counted here,
      // where the per-grant rows are still in scope.
      const extAddr = String(env.SHAREPOINT_TEST_EXTERNAL_EMAIL || '').trim().toLowerCase();
      const isExtRow = (r) => Boolean(extAddr) && String(r.user || '').toLowerCase() === extAddr;

      totals.permissionObservations.push({
        path: srcItem.path,
        type: srcItem.type,
        checked: permCmp.checked,
        // Grants whose PRINCIPAL has no destination counterpart in the mapping. Counted so the
        // roll-up can say that rather than "no item carried a grant" — the first real run seeded
        // casey@gajha.com on the root file, and casey maps to nothing at the destination, so
        // feature 4.1 reported "not exercised" while the grant was sitting there.
        unmapped: (permCmp.unmappedPrincipals || []).length,
        unmappedWho: (permCmp.unmappedPrincipals || [])
          .map((u) => u.user || u.email || u.principal).filter(Boolean).slice(0, 3),
        externalChecked: (permCmp.matches || []).filter(isExtRow).length
          + (permCmp.mismatches || []).filter(isExtRow).length,
        externalFailed: (permCmp.mismatches || []).filter(isExtRow).length,
        matches: permCmp.matches.length,
        mismatches: permCmp.mismatches.length,
        escalations: permCmp.escalations.length,
        viaGroup: permCmp.viaGroup.length,
      });
      for (const m of permCmp.mismatches) {
        totals.permissionMismatches.push({ path: srcItem.path, ...m });
      }
      // A privilege escalation is a finding in its own right, never a pass.
      for (const e of permCmp.escalations) {
        totals.permissionMismatches.push({ path: srcItem.path, ...e, escalation: true });
      }
    }

    // ── 7.1 shared links.
    //
    // Two things have to happen before a source link can be compared at all, and skipping either
    // manufactured failures on the first real run:
    //
    //   1. DEDUPE. SharePoint reports a parent folder's link on the child too, so link_view.txt
    //      came back with its own organization/view twice — once its own, once the folder's. A
    //      duplicate adds no information and inflates the "6 links" the report counted.
    //
    //   2. COLLAPSE per scope. Google holds ONE general-access entry per scope: a file cannot be
    //      both "anyone in the org can edit" and "anyone in the org can view". link_edit.txt
    //      carried organization/edit AND organization/view at the source, so the destination can
    //      only express one of them — and judging each independently failed the pair for a
    //      platform limit rather than a migration defect. The STRONGEST source role for a scope is
    //      what the destination should show; the rest are recorded as collapsed.
    const rawLinks = Array.isArray(srcPerms.links) ? srcPerms.links : [];
    const seenLink = new Set();
    const deduped = rawLinks.filter((l) => {
      const key = `${String(l.scope || '').toLowerCase()}/${String(l.type || '').toLowerCase()}`;
      if (seenLink.has(key)) return false;
      seenLink.add(key);
      return true;
    });
    const strongestByScope = new Map();
    for (const l of deduped) {
      const scope = String(l.scope || '').toLowerCase();
      const isEdit = String(l.type || '').toLowerCase() === 'edit';
      const held = strongestByScope.get(scope);
      if (!held || (isEdit && String(held.type || '').toLowerCase() !== 'edit')) {
        strongestByScope.set(scope, l);
      }
    }
    const collapsed = deduped.length - strongestByScope.size;
    if (collapsed > 0) {
      totals.linkCollapses = (totals.linkCollapses || 0) + collapsed;
      row.linkCollapsed = collapsed;
    }
    // Whether the destination expressed an anonymous link ANYWHERE in this run — a Workspace that
    // forbids "Anyone with the link" is a destination policy, not a migration defect, and the
    // roll-up needs to know which of the two it is looking at.
    if ((destPerms.links || []).some((l) => String(l.scope || '').toLowerCase() === 'anonymous')) {
      totals.destAnonymousLinkSeen = true;
    }

    const srcLinks = [...strongestByScope.values()];
    if (srcLinks.length > 0) {
      row.sharedLinks = [];
      for (const link of srcLinks) {
        const linkCmp = roleMap.compareSharedLink(link, destPerms.links);
        totals.linkObservations.push({
          path: srcItem.path,
          type: srcItem.type,
          sourceScope: link.scope,
          sourceType: link.type,
          comparable: linkCmp.comparable !== false,
          expectedScope: linkCmp.expectedScope,
          expectedType: linkCmp.expectedType,
          match: linkCmp.match,
          actual: linkCmp.actual,
          reason: linkCmp.reason || null,
        });
        row.sharedLinks.push({
          sourceType: `${link.scope || '?'}/${link.type || '?'}`,
          sourceRole: (link.roles || []).join(', '),
          actual: (linkCmp.actual || []).join(', ') || '(none)',
          match: linkCmp.comparable === false ? true : linkCmp.match,
        });
        if (linkCmp.comparable !== false && !linkCmp.match) {
          totals.sharedLinkMismatches.push({
            path: srcItem.path,
            expected: `${linkCmp.expectedScope}/${linkCmp.expectedType}`,
            actual: (linkCmp.actual || []).join(', ') || '(no link permission at the destination)',
          });
        }
      }
      row.sharedLinkCounts = { source: srcLinks.length, dest: (destPerms.links || []).length };
    }

    if (srcItem.type === 'folder') return row;

    // ── 9.1 metadata. BOTH halves are comparable here: SharePoint's fileSystemInfo carries created
    // and modified times, unlike Dropbox which exposes no creation time. Identity (Created By /
    // Modified By) is out of scope — recorded on the row, never compared.
    const tsCmp = core.compareTimestamps(
      { createdAt: srcItem.createdAt, modifiedAt: srcItem.modifiedAt },
      { createdAt: destItem.createdAt, modifiedAt: destItem.modifiedAt },
      bands.timestampDriftMs
    );
    row.timestamps = { ...tsCmp, createdComparable: Boolean(srcItem.createdAt) };
    row.identity = {
      sourceCreatedBy: srcItem.createdBy || null,
      destCreatedBy: destItem.createdBy || null,
      note: 'Out of scope — Google does not accept the source identity, so this is recorded only.',
    };
    if (tsCmp && tsCmp.drifted) {
      totals.timestampDrift.push({
        path: srcItem.path,
        source: `${srcItem.createdAt || '?'} / ${srcItem.modifiedAt || '?'}`,
        dest: `${destItem.createdAt || '?'} / ${destItem.modifiedAt || '?'}`,
        field: tsCmp.driftedFields ? tsCmp.driftedFields.join(', ') : 'timestamps',
      });
    }

    // ── 10.1 version history.
    const [srcVersions, destVersions] = await Promise.all([
      sharepointClient.getItemVersions(site.siteId, spPath, sourceEmail)
        .then((v) => (v && Number.isFinite(v.totalVersions) ? v.totalVersions : 0))
        .catch((err) => {
          logger.warn(`[${combination} validation] could not read source versions for `
            + `"${spPath}": ${err.message}`);
          return 0;
        }),
      this.readVersionCount(destItem.id, destEmail),
    ]);
    if (srcVersions > 1 || destVersions > 1) {
      totals.versionInfo.push({
        path: srcItem.path,
        sourceVersions: srcVersions,
        destVersions,
        note: 'Exact counts are not asserted — Google merges revisions, and selective versions are '
          + 'out of scope for this combination. History PRESENCE is what 10.1 judges.',
      });
      row.versions = { source: srcVersions, dest: destVersions };
    }

    // ── Size, banded by whether the destination was converted to a Google native doc.
    const converted = core.isConverted(destItem) || core.isGoogleNative(destItem.mimeType);
    const sizeBands = converted ? bands.convertedFileSize : bands.fileSize;
    if (srcItem.size != null && destItem.size != null && sizeBands) {
      const sizeCmp = core.compareSize(srcItem, destItem, sizeBands);
      row.size = sizeCmp;
      if (sizeCmp && sizeCmp.severity === 'error') {
        totals.conversionMismatches.push({
          path: srcItem.path, source: srcItem.size, dest: destItem.size, converted,
        });
      }
    }

    return row;
  }

  /** Turn per-item observations into the unit's feature checks. */
  _rollUpItemChecks(push, totals, itemDetails) {
    // ── Permissions: 3.1/4.1 at the root, 5.1/6.1 below it, 8.1 by principal ──
    const permAt = (atRoot, type) => totals.permissionObservations.filter((o) =>
      (core.segmentsOf(o.path).length <= 1) === atRoot && o.type === type);

    const seed = 'Seed grants with SHAREPOINT_TEST_EDITOR_EMAIL / SHAREPOINT_TEST_VIEWER_EMAIL '
      + '/ SHAREPOINT_TEST_GROUP_EMAIL.';

    // Has CloudFuze's sharing phase demonstrably RUN in this migration?
    //
    // "Pending" was judged per item: an item with no direct destination grants was excused as
    // "sharing has not been applied yet". That is only true while the phase is still running — and
    // the run itself says whether it is. On the first successful run, every FILE had received its
    // grant (mia → writer on two files) while both FOLDERS had none; the folders were excused as
    // pending, so features 3.1 and 5.1 reported "not judgeable" and the checklist showed N/A —
    // when the real finding was that FOLDER permissions did not arrive at all.
    //
    // If any item in this run carries a direct grant, the phase has run. Absence elsewhere is then
    // a difference, not a delay. Still conservative: with NO item carrying a direct grant the old
    // benefit of the doubt stands, because that is what an unfinished sharing phase looks like.
    const sharingHasRun = totals.permissionObservations.some((o) => o.matches > 0 || o.mismatches > 0)
      && totals.permissionObservations.length > (totals.permissionsPendingPaths || []).length;

    /** One permission feature's verdict, over only the items that feature covers. */
    const permFeature = (id, label, obs, notExercised) => {
      const checked = obs.reduce((n, o) => n + o.checked, 0);
      if (checked === 0) {
        // "Nothing was seeded" and "what was seeded cannot be compared" are different problems with
        // different fixes, and saying the first when the second is true sends the reader to look
        // for missing test data that is actually present.
        const unmapped = obs.reduce((n, o) => n + (o.unmapped || 0), 0);
        if (unmapped > 0) {
          const who = [...new Set(obs.flatMap((o) => o.unmappedWho || []))].slice(0, 3);
          push('WARN', `${id} ${label}`,
            `${unmapped} grant(s) exist at the source but their principal has no destination `
            + `counterpart in this run's user mapping${who.length ? ` (${who.join(', ')})` : ''}, so `
            + 'there is nothing to compare them against. This is a MAPPING gap, not missing test '
            + 'data: grant the scenario to a user that appears in Map Users (or in CloudFuze\'s own '
            + 'user mapping) and the feature becomes assessable.');
          return;
        }
        push('WARN', `${id} ${label}`, notExercised);
        return;
      }
      const paths = new Set(obs.map((o) => o.path));
      const bad = totals.permissionMismatches.filter((m) => paths.has(m.path));
      const pending = (totals.permissionsPendingPaths || []).filter((x) => paths.has(x)).length;

      if (bad.length === 0) {
        push('PASS', `${id} ${label}`,
          `${checked} grant(s) compared across ${paths.size} item(s), all matched`);
      } else if (pending > 0 && pending >= bad.length && sharingHasRun) {
        push('FAIL', `${id} ${label}`,
          // Finding first, justification after, and no explanatory clause trailing an em dash:
          // the failure index takes a short em-dash tail as the "root cause", so a message that
          // ended in prose was summarised as a fragment starting mid-sentence.
          `${bad.length} of ${checked} grant(s) missing at the destination: `
          + `${[...new Set(bad.map((m) => m.path))].slice(0, 4).join(' | ')}. `
          + 'These items carry only the inherited drive grant, while OTHER items in this same run '
          + 'did receive their direct grants. CloudFuze\'s sharing phase has therefore run, so this '
          + 'is a real difference rather than a delay.');
      } else if (pending > 0 && pending >= bad.length) {
        push('WARN', `${id} ${label}`,
          `Not judgeable yet: ${pending} item(s) still carried only inherited drive grants when `
          + 'validation ran, and NO item in this run had received a direct grant — consistent with '
          + 'the sharing phase not having run. CloudFuze applies item sharing AFTER the copy, tens '
          + 'of minutes behind the PROCESSED status — re-validate this execution once it has settled.');
      } else {
        const esc = bad.filter((m) => m.escalation).length;
        push('FAIL', `${id} ${label}`,
          `${bad.length} of ${checked} grant(s) differ`
          + (esc > 0 ? ` (${esc} privilege escalation(s))` : '')
          + (pending > 0 ? ` (${pending} more item(s) not yet shared by CloudFuze — not counted)` : ''));
      }
    };

    permFeature('3.1', 'Root Folder Permissions', permAt(true, 'folder'),
      `No folder at the source root carried a comparable grant, so this was not exercised. ${seed}`);
    permFeature('4.1', 'Root File Permissions', permAt(true, 'file'),
      `No file at the source root carried a comparable grant, so this was not exercised. ${seed}`);
    permFeature('5.1', 'Sub-folder permissions', permAt(false, 'folder'),
      `No sub-folder carried a comparable grant, so this was not exercised. ${seed}`);
    permFeature('6.1', 'Inner file permissions', permAt(false, 'file'),
      `No file below the root carried a comparable grant, so this was not exercised. ${seed}`);

    // ── 8.1 external shares: a grant to an address outside the source tenant.
    const extAddr = String(env.SHAREPOINT_TEST_EXTERNAL_EMAIL || '').trim();
    const extChecked = totals.permissionObservations.reduce((n, o) => n + (o.externalChecked || 0), 0);
    const extFailed = totals.permissionObservations.reduce((n, o) => n + (o.externalFailed || 0), 0);
    if (!extAddr) {
      push('WARN', '8.1 External Shares',
        'SHAREPOINT_TEST_EXTERNAL_EMAIL is not set, so no external grant was seeded and the feature '
        + 'was not exercised. It must be an address outside the SOURCE tenant, and the tenant must '
        + 'allow external sharing.');
    } else if (extChecked === 0) {
      push('WARN', '8.1 External Shares',
        `No grant to ${extAddr} was found on any source item, so external sharing was not exercised. `
        + 'Either seeding could not create it (external sharing may be disabled tenant-wide) or the '
        + 'grant was removed.');
    } else if (extFailed === 0) {
      push('PASS', '8.1 External Shares',
        `${extChecked} external grant(s) to ${extAddr} compared, all matched`);
    } else {
      push('FAIL', '8.1 External Shares',
        `${extFailed} of ${extChecked} external grant(s) to ${extAddr} differ`);
    }

    // ── 7.1 shared links.
    const comparable = totals.linkObservations.filter((o) => o.comparable);
    const notComparableLinks = totals.linkObservations.filter((o) => !o.comparable);
    if (comparable.length === 0) {
      push('WARN', '7.1 Shared links',
        notComparableLinks.length > 0
          ? `${notComparableLinks.length} source link(s) were "specific people" links, which are `
            + 'per-user grants rather than Google General access — they are covered by the '
            + 'permission features instead, so 7.1 itself was not exercised.'
          : 'No source item carried a sharing link, so this was not exercised. Seeding creates '
            + 'organization view/edit links; a tenant that blocks link creation leaves this empty.');
    } else {
      const bad = comparable.filter((o) => !o.match);
      // An expected ANONYMOUS link that is absent, on a destination that produced no anonymous link
      // anywhere in this run, is a Workspace policy — "Anyone with the link" is the one scope a
      // Google destination can legitimately refuse, and most tenants do. Reported apart, and never
      // as a pass. If the destination DID produce an anonymous link somewhere, the policy clearly
      // permits it and a missing one is a real difference, so it stays in `bad`.
      const anonBlocked = totals.destAnonymousLinkSeen
        ? []
        : bad.filter((o) => o.expectedScope === 'anonymous');
      const realBad = bad.filter((o) => !anonBlocked.includes(o));

      if (realBad.length === 0 && anonBlocked.length === 0) {
        push('PASS', '7.1 Shared links',
          `${comparable.length} link(s) compared on both axes (who it reaches, what they can do), `
          + 'all matched'
          + (totals.linkCollapses
            ? `. ${totals.linkCollapses} additional source link(s) shared a scope with another and `
              + 'could not be expressed separately at the destination — Google holds one '
              + 'general-access entry per scope; the strongest role was compared.'
            : ''));
      } else if (realBad.length === 0) {
        push('WARN', '7.1 Shared links',
          `${comparable.length - anonBlocked.length} link(s) matched. `
          + `${anonBlocked.length} anonymous ("anyone with the link") link(s) did not arrive, and `
          + 'no anonymous link was produced anywhere at this destination — consistent with the '
          + 'Workspace forbidding link sharing outside the organisation, which is a destination '
          + 'policy rather than a migration defect. NOT judged as a pass: confirm the tenant policy, '
          + `or re-run once it allows anonymous links. Items: ${
            anonBlocked.slice(0, 3).map((o) => o.path).join(' | ')}`);
      } else {
        // The anonymous aside goes FIRST so the message ends on the item list — see the note above.
        push('FAIL', '7.1 Shared links',
          (anonBlocked.length
            ? `(${anonBlocked.length} anonymous link(s) the destination appears to forbid are `
              + 'reported separately and not counted here.) '
            : '')
          + `${realBad.length} of ${comparable.length} link(s) differ: `
          + realBad.slice(0, 4).map((o) => `${o.path} expected ${o.expectedScope}/${o.expectedType}, `
            + `got ${(o.actual || []).join(', ') || 'none'}`).join(' | '));
      }
    }
    if (notComparableLinks.length > 0 && comparable.length > 0) {
      push('INFO', '7.x Shared links (specific people)',
        `${notComparableLinks.length} source link(s) target specific people. Google expresses that `
        + 'as an ordinary user permission, not as General access, so they are judged by features '
        + '3.1-6.1 rather than by 7.1.');
    }

    // ── 9.1 metadata.
    const tsCompared = itemDetails.filter((r) => r.timestamps).length;
    if (tsCompared === 0) {
      push('WARN', '9.1 Metadata', 'No files were available to compare timestamps on');
    } else if (totals.timestampDrift.length === 0) {
      // One template literal, not a half-finished concatenation: the previous form had `' + '`
      // INSIDE the backticks, so the report printed those characters verbatim mid-sentence.
      push('PASS', '9.1 Metadata',
        `Created and modified timestamps preserved on ${tsCompared} file(s). `
        + '"Created By" / "Modified By" identity is NOT compared — out of scope, Google does not '
        + 'accept it.');
    } else {
      push('FAIL', '9.1 Metadata',
        `${totals.timestampDrift.length} of ${tsCompared} file(s) drifted beyond the tolerance: `
        + totals.timestampDrift.slice(0, 4).map((d) => `${d.path} (${d.field})`).join(' | '));
    }

    // ── 10.1 version history: did history ARRIVE. Counts are not asserted.
    if (totals.versionInfo.length === 0) {
      push('WARN', '10.1 Version History',
        'No file reported version data on either side, so version history was not exercised. '
        + 'Seeding uploads three files five times each — check that scenario ran.');
    } else {
      const versioned = totals.versionInfo.filter((v) => v.sourceVersions > 1);
      const lostHistory = versioned.filter((v) => v.destVersions <= 1);
      if (versioned.length === 0) {
        push('WARN', '10.1 Version History',
          `${totals.versionInfo.length} file(s) reported version data but none had more than one `
          + 'source version, so there was no history to preserve.');
      } else if (lostHistory.length === 0) {
        push('PASS', '10.1 Version History',
          `${versioned.length} file(s) had multiple SharePoint versions and all of them arrived with `
          + 'version history at the destination. Exact counts are NOT compared — Google merges '
          + `revisions, so a lower number is expected (e.g. ${versioned.slice(0, 4)
            .map((v) => `${core.lastSegment(v.path)} ${v.sourceVersions}→${v.destVersions}`)
            .join(', ')}).`);
      } else {
        push('FAIL', '10.1 Version History',
          `${lostHistory.length} of ${versioned.length} versioned file(s) arrived with no history at `
          + `all: ${lostHistory.slice(0, 5)
            .map((v) => `${v.path} (${v.sourceVersions}→${v.destVersions})`).join(' | ')}`);
      }
    }
  }

  /**
   * Feature 11.1 — special characters, as a NEGATIVE test.
   *
   * On a Google destination the expected outcome is NO replacement: Google forbids no character and
   * rewrites nothing. So this asserts the names arrived UNCHANGED, and a sanitized name is the
   * defect — the reverse of every SharePoint-destination combination, where replacement is correct.
   */
  _checkSpecialCharacters(push, sourceTree, cmp, rules, totals) {
    const special = sourceTree.filter((i) => /[^A-Za-z0-9 ._\-()]/.test(String(i.name || '')));
    totals.specialChars.total = special.length;
    if (special.length === 0) {
      push('WARN', '11.1 Special Characters Replacement',
        'No source name carried a special character, so this was not exercised. Seeding creates '
        + '"09-Special !@#$ Chars" and a file with the same characters.');
      return;
    }
    const arrivedIntact = [];
    const rewritten = [];
    for (const item of special) {
      const pair = cmp.matched.get(item.path);
      if (!pair || !pair.dest) continue;
      if (String(pair.dest.name) === String(item.name)) arrivedIntact.push(item.name);
      else rewritten.push({ source: item.name, dest: pair.dest.name });
    }
    totals.specialChars.arrived = arrivedIntact.length;
    if (arrivedIntact.length + rewritten.length === 0) {
      push('FAIL', '11.1 Special Characters Replacement',
        `${special.length} source name(s) carry special characters and none of them paired with a `
        + 'destination item, so nothing arrived to inspect.');
    } else if (rewritten.length === 0) {
      push('PASS', '11.1 Special Characters Replacement',
        `${arrivedIntact.length} name(s) with special characters arrived unchanged, which is the `
        + 'expected outcome for a Google destination — it forbids no character and replaces nothing. '
        + `Verified: ${arrivedIntact.slice(0, 3).join(', ')}`);
    } else {
      push('FAIL', '11.1 Special Characters Replacement',
        `${rewritten.length} name(s) were rewritten on the way to Google, which replaces nothing: `
        + rewritten.slice(0, 4).map((r) => `"${r.source}" → "${r.dest}"`).join(' | '));
    }
  }

  /**
   * Feature 12.1 — long folder path, also a NEGATIVE test.
   *
   * Google has no total-path limit (utils/contentTolerance sets Infinity, destinations/googledrive
   * states why), so the expected outcome is that a deep path arrives at the SAME depth with no
   * truncation, no relocation and no placeholder link. A destination that relocated it would be
   * the defect.
   */
  _checkLongPaths(push, sourceTree, cmp, rules, totals) {
    const limit = rules.pathLengthLimit;
    const deepest = sourceTree.reduce(
      (best, i) => (core.segmentsOf(i.path).length > core.segmentsOf(best.path || '').length ? i : best),
      { path: '' }
    );
    const longest = sourceTree.reduce(
      (best, i) => (String(i.path).length > String(best.path || '').length ? i : best),
      { path: '' }
    );
    const depth = core.segmentsOf(deepest.path || '').length;
    if (depth < 5) {
      push('WARN', '12.1 Long-folder path',
        `The deepest source path is only ${depth} level(s) deep, which does not exercise a long `
        + 'path. Seeding builds a 20-level chain under "10-Long-Path" — check that scenario ran.');
      return;
    }
    const relocated = (totals.placeholderLinks || []).length;
    const pair = cmp.matched.get(longest.path);
    totals.longPathEvidence.push({
      sourcePath: longest.path,
      sourceChars: String(longest.path).length,
      depth,
      destPath: pair && pair.dest ? pair.dest.path : null,
      limit: Number.isFinite(limit) ? limit : 'none (Google imposes no path limit)',
    });
    if (!pair || !pair.dest) {
      push('FAIL', '12.1 Long-folder path',
        `The deepest source item (${depth} levels, ${String(longest.path).length} chars) did not `
        + 'pair with a destination item — the long path did not arrive.');
    } else if (relocated > 0) {
      push('FAIL', '12.1 Long-folder path',
        `${relocated} item(s) were relocated or replaced by a placeholder link. Google imposes no `
        + 'path limit, so nothing should be relocated for depth.');
    } else {
      push('PASS', '12.1 Long-folder path',
        `A ${depth}-level path (${String(longest.path).length} chars) arrived intact at `
        + `"${pair.dest.path}" — no truncation and no relocation, which is the expected outcome for `
        + 'a Google destination.');
    }
  }

  /**
   * Features 14.1 and 16.1 — links held INSIDE a migrated document.
   *
   * Both are the same mechanism with different subjects: 14.1 links to another file in the same
   * library, 16.1 crosses into a different library. The seeding agent recorded which document and
   * which source URL, so the expectation is knowable: the destination copy should point at the
   * MIGRATED target, i.e. a Google URL, not back at SharePoint.
   *
   * The destination copy of a .docx is a Google Doc, which cannot be downloaded as a docx — it is
   * exported as HTML and the link targets read out of that. When the export cannot be read, this
   * reports na with the reason rather than a verdict, because "could not look" and "no links found"
   * must never reach a report as the same thing.
   */
  async _checkEmbeddedAndCrossLinks(push, context, cmp, destEmail, totals) {
    const seeded = context.sourceData || context.testDataResult || {};

    // Seeding records the document and the exact URL it wrote, which is the best evidence — the
    // expected destination target is then knowable rather than guessed.
    //
    // A RESUMED run skips seeding (skipTestData), so that record does not exist even though the
    // documents do. Falling back to the paths the seeder always uses keeps both features
    // answerable on a re-validation instead of reporting them unexercised against data that is
    // sitting in the source. The source URL is unknown on that path, so the check asserts only
    // what it can see: whether the migrated document points at Google or still at SharePoint.
    const conventional = (folder, name) => ({
      documentPath: `${folder}/${name}`,
      sourceUrl: '(not recorded — this run did not seed; resumed or seeding skipped)',
    });
    const embedded = seeded.embeddedLinks
      || (context.skipTestData ? conventional('11-Embedded-Links', 'embedded_link_doc.docx') : null);
    const crossed = seeded.crossLinks
      || (context.skipTestData ? conventional('12-CrossLinks', 'cross_link_doc.docx') : null);

    const cases = [
      ['14.1', 'Embedded Links', embedded, totals.embeddedLinkEvidence],
      ['16.1', 'CrossLinks', crossed, totals.crossLinkEvidence],
    ];

    for (const [id, label, info, evidence] of cases) {
      if (!info || !info.documentPath) {
        push('WARN', `${id} ${label}`,
          `No ${label.toLowerCase()} document was recorded by seeding, so this was not exercised. `
          + (id === '16.1'
            ? 'A cross-link needs a second library — set SHAREPOINT_SOURCE_LIBRARY.'
            : 'Seeding writes "11-Embedded-Links/embedded_link_doc.docx".'));
        continue;
      }

      // Find the migrated copy by source path. The name may have gained a Google Doc identity but
      // the tree pairing already resolved that.
      const srcPath = `/${String(info.documentPath).replace(/^\/+/, '')}`;
      const pair = cmp.matched.get(srcPath);
      if (!pair || !pair.dest) {
        push('FAIL', `${id} ${label}`,
          `The document carrying the link (${srcPath}) did not pair with a destination item, so the `
          + 'link could not be inspected.');
        continue;
      }

      let targets = [];
      let readError = null;
      try {
        if (core.isGoogleNative(pair.dest.mimeType)) {
          const html = (await this.readTextLines(pair.dest, destEmail)).join('\n');
          targets = [...String(html).matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
        } else {
          const buf = await this.readContent(pair.dest, destEmail);
          const read = docxLinks.extractDocxLinks(buf);
          // The field is `targets`, and `reason` carries the failure — NOT `links` / `error`.
          //
          // Reading the wrong names made every .docx look empty: `read.links` was undefined, so the
          // check reported "carries no hyperlink at all" for a document whose link was sitting
          // right there, and mis-stated a real finding (the link was not REWRITTEN) as a different
          // one (the link was LOST). Verified against the migrated file directly. Same class of
          // mistake the Dropbox validator hit three times with { grants, links } and
          // { totalVersions } — field shapes here are worth checking against the helper.
          if (read && read.ok) targets = read.targets || [];
          else readError = (read && read.reason) || 'the .docx could not be parsed';
        }
      } catch (err) {
        readError = err.message;
      }

      if (readError && targets.length === 0) {
        push('WARN', `${id} ${label}`,
          `The migrated document exists at "${pair.dest.path}" but its links could not be read `
          + `(${readError}), so no verdict is claimed. The source link was ${info.sourceUrl}.`);
        continue;
      }

      const stillSharePoint = targets.filter((t) => /sharepoint\.com|\/_layouts\//i.test(t));
      const nowGoogle = targets.filter((t) => /(drive|docs)\.google\.com/i.test(t));
      evidence.push({
        documentPath: srcPath,
        destPath: pair.dest.path,
        sourceUrl: info.sourceUrl,
        targets: targets.slice(0, 10),
        rewritten: nowGoogle.length,
        unrewritten: stillSharePoint.length,
      });

      if (targets.length === 0) {
        push('FAIL', `${id} ${label}`,
          `The migrated document at "${pair.dest.path}" carries no hyperlink at all — the source `
          + `document linked to ${info.sourceUrl}, so the link was lost in migration.`);
      } else if (nowGoogle.length > 0 && stillSharePoint.length === 0) {
        push('PASS', `${id} ${label}`,
          `${nowGoogle.length} link(s) in the migrated document point at the Google destination `
          + `copy (${nowGoogle[0]}); none still point back at SharePoint.`);
      } else if (nowGoogle.length > 0) {
        push('WARN', `${id} ${label}`,
          `${nowGoogle.length} link(s) were re-pointed at Google but ${stillSharePoint.length} still `
          + `target SharePoint (${stillSharePoint[0]}). Mixed rewriting — inspect the document.`);
      } else {
        push('FAIL', `${id} ${label}`,
          `${stillSharePoint.length} link(s) still point at the SharePoint source `
          + `(${stillSharePoint[0]}) — they were not re-pointed at the migrated copy.`);
      }
    }
  }

  /**
   * Feature 15.1 — Custom Library.
   *
   * A custom SharePoint library is a SEPARATE drive, so it is not part of any transfer unit's tree
   * and cannot be answered by the per-unit comparison. It is checked on its own: read the library's
   * tree at the source, find the same content under the destination drive, and compare.
   *
   * Only ever compared against what the source actually holds. A library that was never seeded
   * reports "not exercised" — the scope document says custom libraries DO migrate, and asserting
   * that from an empty source would be a pass with no evidence behind it.
   */
  async _checkCustomLibrary(push, context, site, destRoot, rules, bands, totals) {
    const libraryName = (env.SHAREPOINT_SOURCE_LIBRARY || '').trim();
    if (!libraryName) {
      push('WARN', '15.1 Custom Library',
        'SHAREPOINT_SOURCE_LIBRARY is not set, so no custom library was seeded and the feature was '
        + 'not exercised. Set it to the library name to include this scenario.');
      return;
    }
    let drive;
    try {
      drive = await sharepointClient.findDriveByName(site.siteId, libraryName, context.sourceEmail);
    } catch (err) {
      push('WARN', '15.1 Custom Library',
        `Could not list the site's document libraries (${err.message}), so the custom library could `
        + 'not be checked.');
      return;
    }
    if (!drive) {
      push('WARN', '15.1 Custom Library',
        `No library named "${libraryName}" exists on ${site.hostname}${site.sitePath}, so this was `
        + 'not exercised. Seeding creates it when SHAREPOINT_SOURCE_LIBRARY is set.');
      return;
    }

    const opts = { driveId: drive.id };
    let srcTree = [];
    try {
      srcTree = await sharepointClient.buildFolderTree(
        site.siteId, '/', context.sourceEmail, bands.treeDepth || 25, 0, opts
      );
    } catch (err) {
      push('WARN', '15.1 Custom Library',
        `The library "${libraryName}" exists but could not be read (${err.message}).`);
      return;
    }
    if (srcTree.length === 0) {
      push('WARN', '15.1 Custom Library',
        `The library "${libraryName}" is empty at the source, so nothing was expected at the `
        + 'destination and the feature was not exercised.');
      return;
    }

    // Where the library landed. CloudFuze names the destination folder after the library or after
    // the folder inside it, so both are probed — the same dedup-tolerant probe the main tree uses.
    const rootName = core.segmentsOf(srcTree[0].path)[0] || libraryName;
    let migrated = await this.findMigratedRoot(
      destRoot.rootId, destRoot.driveId, '', libraryName, context.destinationEmail
    );
    let comparedFrom = libraryName;
    if (!migrated || migrated.name === '(destination root)') {
      const byFolder = await this.findMigratedRoot(
        destRoot.rootId, destRoot.driveId, '', rootName, context.destinationEmail
      );
      if (byFolder && byFolder.name !== '(destination root)') {
        migrated = byFolder;
        comparedFrom = rootName;
      }
    }
    if (!migrated) {
      push('FAIL', '15.1 Custom Library',
        `The custom library "${libraryName}" holds ${srcTree.length} item(s) at the source, but `
        + `nothing named "${libraryName}" or "${rootName}" exists under ${destRoot.label} — the `
        + 'library did not migrate.');
      totals.customLibrary = { name: libraryName, sourceItems: srcTree.length, destItems: 0, migrated: false };
      return;
    }

    const destTree = await this.readTree(migrated.id, context.destinationEmail, {
      driveId: destRoot.driveId,
      maxDepth: bands.treeDepth || 25,
    });
    // Compare by NAME set rather than by full path: the library's content sits one level deeper or
    // shallower depending on which folder CloudFuze used as the landing root, and a path-based
    // comparison would report every item misplaced for a difference that is not a defect.
    const nameSet = (tree) => new Set(tree.map((i) => `${i.type}:${core.normKey(i.name)}`));
    const srcNames = nameSet(srcTree);
    const destNames = nameSet(destTree);
    const missing = [...srcNames].filter((n) => !destNames.has(n));

    totals.customLibrary = {
      name: libraryName,
      comparedFrom,
      destPath: migrated.path,
      sourceItems: srcTree.length,
      destItems: destTree.length,
      missing: missing.length,
      migrated: true,
    };

    if (missing.length === 0) {
      push('PASS', '15.1 Custom Library',
        `The custom library "${libraryName}" (${srcTree.length} item(s)) arrived under `
        + `"${migrated.path}" in ${destRoot.label} — every item present by name.`);
    } else {
      push('FAIL', '15.1 Custom Library',
        `${missing.length} of ${srcTree.length} item(s) from the custom library "${libraryName}" are `
        + `missing under "${migrated.path}": ${missing.slice(0, 5).join(', ')}`);
    }
  }

  /**
   * Feature 13.1 — suppressed email notifications, on a Google destination.
   *
   * Deliberately NOT claimed as a pass. The SharePoint-destination combinations can answer this by
   * reading the destination user's Outlook mailbox over Graph; the Google equivalent needs Gmail
   * read scope on the destination account, which the content flow does not request. The
   * destination-side agent says the same thing in findSharingNotifications, and this reports it
   * rather than inventing a verdict — a check that always passes is worse than an honest gap.
   */
  _checkNotificationSuppression(push, totals) {
    totals.notificationLeaks = [];
    push('WARN', '13.1 Suppress email notifications',
      'NOT VERIFIED. Confirming that no share notification was sent needs Gmail read scope on the '
      + 'destination account, which the content flow does not request — so this cannot be checked '
      + 'from the Google side and must be confirmed by hand (destination inbox, and the Google '
      + 'admin account, which Google notifies on share by default). Reported as not verified, never '
      + 'as a pass.');
  }

  /** Every documented out-of-scope limitation, recorded as INFO on each run. */
  _recordOutOfScope(push) {
    for (const [name, note] of OUT_OF_SCOPE_NOTES) {
      push('INFO', `Out of scope · ${name}`, note);
    }
  }

  /**
   * The feature checklist. `worst([])` is null, not 'fail' — absence of evidence is `na`, NEVER a
   * pass. A validator reporting SUCCESS having compared nothing is the failure mode this whole
   * suite exists to prevent.
   */
  _buildChecklist(totals, checks) {
    const byName = (pattern) => checks.filter((c) => pattern.test(c.name));
    const worst = (rows) => {
      if (rows.length === 0) return null;
      if (rows.some((r) => r.status === 'FAIL')) return 'fail';
      if (rows.some((r) => r.status === 'WARN')) return 'warn';
      return 'pass';
    };
    const scanned = totals.scannedSourceItems || 0;

    return SHAREPOINT_FEATURES.map((f) => {
      const na = (detail) => ({ ...f, status: 'na', detail });
      if (!totals.enabled) return na('Deep content validation was disabled for this run');
      if (scanned === 0) return na('No source items were read — nothing was validated');

      // 1.1 and 1.2 are the SAME evidence — the structure comparison — read under the run's
      // migration type. Both therefore require that evidence to exist.
      const isDelta = String(totals.migrationType).toUpperCase() === 'DELTA';
      if (f.id === '1.1' || f.id === '1.2') {
        if (f.id === '1.1' && isDelta) return na('This run was a delta migration');
        if (f.id === '1.2' && !isDelta) return na('This run was a one-time migration, not a delta');
        const structure = worst(byName(/2\.1 Preserving File\/Folder structure/));
        if (!structure) return na('The structure comparison did not run — nothing to base this on');
        return {
          ...f,
          status: structure === 'fail' ? 'fail' : structure === 'warn' ? 'na' : 'pass',
          detail: isDelta
            ? 'Delta run compared against the destination'
            : 'One-time migration delivered the source tree',
        };
      }

      // `(^|\] )` rather than `^`: a per-unit check is named "[unit] 3.1 Root Folder Permissions",
      // so the feature id is not at the start of the string. Anchoring with ^ alone matches
      // nothing, and every feature then reports "not exercised" while its own check says PASS.
      const map = {
        '2.1': /(^|\] )2\.1 Preserving/,
        '3.1': /(^|\] )3\.1 Root Folder/,
        '4.1': /(^|\] )4\.1 Root File/,
        '5.1': /(^|\] )5\.1 Sub-folder/,
        '6.1': /(^|\] )6\.1 Inner file/,
        '7.1': /(^|\] )7\.1 Shared links/,
        '8.1': /(^|\] )8\.1 External Shares/,
        '9.1': /(^|\] )9\.1 Metadata/,
        '10.1': /(^|\] )10\.1 Version History/,
        '11.1': /(^|\] )11\.1 Special Characters/,
        '12.1': /(^|\] )12\.1 Long-folder path/,
        '13.1': /(^|\] )13\.1 Suppress/,
        '14.1': /(^|\] )14\.1 Embedded Links/,
        '15.1': /(^|\] )15\.1 Custom Library/,
        '16.1': /(^|\] )16\.1 CrossLinks/,
      };

      const pattern = map[f.id];
      if (!pattern) return na('Not assessed by this validator');
      const rows = byName(pattern);
      const v = worst(rows);
      if (!v) return na('Not exercised by this run');
      return {
        ...f,
        // A WARN means "measured, but not assessable" — na, never a pass.
        status: v === 'fail' ? 'fail' : v === 'warn' ? 'na' : 'pass',
        detail: rows.map((r) => r.detail).join(' | ').slice(0, 400),
      };
    });
  }

  /** Assemble the agent result, matching the shape the orchestrator, PDF and Neutara consume. */
  _buildResult(globalChecks, perUser, totals, context) {
    const flat = [...globalChecks];
    const destLeaf = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
    for (const u of perUser) {
      const tag = destLeaf(u.destinationPath) || u.sourceEmail || 'unit';
      for (const c of u.checks) flat.push({ ...c, name: `[${tag}] ${c.name}` });
    }

    // INFO rows are records, not verdicts: an out-of-scope note must never move the overall status.
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
      totals.outOfScopeNotes = OUT_OF_SCOPE_NOTES.map(([name, note]) => ({ name, note }));
    }

    const infraCheck = /Destination location|Source items scanned|Source site accessible|Deep content validation/i;
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
    const judged = flat.filter((c) => c.status !== 'INFO').length;

    const summary = (() => {
      const tail = `${perUser.length} unit(s); ${scanned} source item(s) scanned, ${paired} paired. `
        + featureSummary.line;
      if (scanned > 0 && paired === 0) {
        return `MIGRATION MOVED NOTHING — 0 of ${scanned} source item(s) reached the destination, so no `
          + `content was compared. ${passed}/${judged} reachability check(s) passed — these say `
          + `nothing about migrated data. ${tail}`;
      }
      return `${passed}/${judged} checks passed across ${tail}`;
    })();

    if (totals) totals.summary = summary;

    return {
      featureChecklist,
      featureSummary,
      mismatches,
      status: overall,
      overallStatus: overall,
      domain: 'content',
      sourceProvider: 'sharepoint',
      destinationProvider: context?.destinationProvider || 'googleshareddrive',
      combination: combinationFor(context),
      checks: flat,
      perUser,
      deepContentValidation: totals,
      summary,
    };
  }
}

module.exports = SharepointToGoogleshareddriveValidationAgent;
module.exports.SHAREPOINT_FEATURES = SHAREPOINT_FEATURES;
module.exports.OUT_OF_SCOPE_NOTES = OUT_OF_SCOPE_NOTES;
module.exports.COMBINATION = DEFAULT_COMBINATION;
module.exports.combinationFor = combinationFor;
module.exports.isBuiltinSiteGroup = isBuiltinSiteGroup;
