'use strict';

/**
 * Deep validation for content: Google Shared Drive → SharePoint.
 *
 * Edit ONLY this file to change Shared Drive → SharePoint behaviour. Provider-agnostic comparison logic
 * lives in validation/shared/deepContentCore.js; the numbers live in utils/contentTolerance/.
 *
 * Feature coverage (backend/data/feature-scope/google-shared-drive-to-sharepoint-inscope.md):
 *   Tier A — 2.1 file types, 3.1 structure, 7.1 special characters, 11.1 long paths, 12.1 conversion
 *   Tier C — 4.x permissions, 5.2–5.15 shared links, 8.1 versions (informational), 10.1 metadata
 *   Tier B — file content hashes, backing 2.1 and 12.1
 *
 * Out of scope (…-outscope.md): version counts and version timestamps cannot match, because the Google
 * API merges revisions. Those are reported as INFO and never fail a run.
 */

const SharePointValidationAgent = require('../../../agents/sharepoint/SharePointValidationAgent');
const driveClient = require('../../../clients/driveClient');
const core = require('../../shared/deepContentCore');
const {
  computeContentFunctionalityChecklist,
  summarizeChecklist,
} = require('../../shared/contentFunctionalityChecklist');
const tolerance = require('../../../utils/contentTolerance');
const env = require('../../../config/env');
const logger = require('../../../utils/logger');

const COMBINATION = 'googledrive_to_sharepoint';

/** Terminal CloudFuze statuses that mean the migration itself finished. */
const CF_OK = ['PROCESSED', 'PROCESS', 'VERSION_PROCESSED'];
const CF_CONFLICTS = ['PROCESSED_WITH_CONFLICTS', 'PROCESS_WITH_CONFLICTS'];

class GoogledriveToSharepointValidationAgent extends SharePointValidationAgent {
  static supportsDeepValidation = true;

  constructor() {
    super('GoogledriveToSharepointValidationAgent');
  }

  async execute(context) {
    const bands = tolerance.forCombination(COMBINATION) || {};
    const globalChecks = [];
    const gPush = (status, name, detail) => globalChecks.push({ name, status, detail });

    if (!env.ENABLE_DEEP_CONTENT_VALIDATION) {
      gPush('WARN', 'Deep content validation', 'Disabled by ENABLE_DEEP_CONTENT_VALIDATION=false — nothing was compared');
      return buildResult(globalChecks, [], { enabled: false });
    }

    // ── CloudFuze's own report. Recorded, never trusted as the verdict: the destination is what counts.
    const report = context.contentMigrationReport || context.migrationJobDetails;
    const cfStatus = String(report?.status || report?.cfStatus || '').toUpperCase();
    const processed = Number(report?.processedCount) || 0;
    const total = Number(report?.totalCount) || 0;
    const hasCounts = report?.totalCount != null || report?.processedCount != null;
    if (CF_OK.includes(cfStatus) && !hasCounts) {
      // A terminal status with no item counts is not evidence anything moved — a job that registers
      // no work still reports PROCESSED in seconds. Only the destination check can settle it.
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

    const skipped = Array.isArray(context.skippedUsers) ? context.skippedUsers : [];
    if (skipped.length > 0) {
      gPush('WARN', `Skipped pairs (${skipped.length})`,
        skipped.map((s) => `${s.sourceEmail} "${s.sourcePath}" — ${s.reason || 'not migrated'}`).join(' | '));
    }

    const emailMap = core.buildEmailMap(context);
    // With { detail: true } the caller learns whether a mapping actually existed, instead of
    // silently receiving the input back and comparing it against a tenant it cannot belong to.
    const mapEmail = (e, opts) => {
      const key = String(e || '').toLowerCase();
      const hit = emailMap[key];
      if (opts && opts.detail) return { email: hit || key, mapped: Boolean(hit) };
      return hit || key;
    };
    const units = core.resolveUnits(context);
    logger.info(`[GoogledriveToSharepoint validation] validating ${units.length} user unit(s)`);

    // ── Destination site (destination-side agent owns how SharePoint is read). The site comes from
    // the destination paths the migration actually used; SHAREPOINT_SITE_PATH is only the default.
    const siteNames = [...new Set(units.map((u) => core.siteSegmentOf(u.destinationPath)).filter(Boolean))];
    if (siteNames.length > 1) {
      gPush('WARN', 'Destination site', `Units span ${siteNames.length} sites (${siteNames.join(', ')}) — validating "${siteNames[0]}"`);
    }
    const site = await this.resolveSite(context, siteNames[0] || null);
    const siteId = site.siteId;
    globalChecks.push(site.check);

    // ── Source Shared Drive. A named drive is resolved to its id (the drive id doubles as its root
    // folder id); with no name configured the walk starts from My Drive root, which still works for a
    // My Drive source but is reported so the discrepancy is visible.
    let sharedDrive = null;
    const driveName = context.sourceSharedDriveName || env.GOOGLE_SHARED_DRIVE_NAME;
    if (driveName) {
      try {
        sharedDrive = await driveClient.resolveSharedDriveByName(driveName, context.sourceEmail);
        gPush(sharedDrive ? 'PASS' : 'FAIL', 'Source Shared Drive resolved',
          sharedDrive ? `"${sharedDrive.name}" (${sharedDrive.id})` : `No Shared Drive named "${driveName}" is visible to ${context.sourceEmail}`);
      } catch (err) {
        gPush('FAIL', 'Source Shared Drive resolved', err.message);
      }
    } else if (/SHARED_DRIVE/i.test(String(context.sourceCloudName || ''))) {
      // Nothing in the run names the Shared Drive: the wizard has no field for it and the env var is
      // optional. Reading My Drive instead compares the wrong tree — it finds nothing and every check
      // downstream reports on data that was never in scope. So find the drive the way the other
      // content combinations find their source: by the folder the run was told to migrate.
      const discovered = await discoverSharedDrive(units);
      sharedDrive = discovered.drive;
      gPush(discovered.drive ? 'PASS' : 'FAIL', 'Source Shared Drive resolved', discovered.detail);
    } else {
      gPush('WARN', 'Source Shared Drive resolved',
        'No Shared Drive name configured (GOOGLE_SHARED_DRIVE_NAME) — reading from My Drive root instead');
    }

    const perUser = [];
    const totals = {
      enabled: true, scannedSourceItems: 0, pairedCount: 0,
      missing: [], extra: [], misplaced: [], placeholderLinks: [],
      hashedCount: 0, notHashedCount: 0, hashMismatches: [],
      permissionMismatches: [], sharedLinkMismatches: [], versionInfo: [], timestampDrift: [],
      notMigratable: [], notComparable: [],
      conversionMismatches: [], permissionObservations: [], linkObservations: [], externalShares: [],
      fileTypes: [], specialChars: { total: 0, arrived: 0 }, notificationLeaks: [],
      notificationsChecked: env.CONTENT_DEEP_VALIDATE_NOTIFICATIONS,
      hashChecked: env.CONTENT_DEEP_VALIDATE_FILE_HASH,
      metadataChecked: env.CONTENT_DEEP_VALIDATE_METADATA,
      linksChecked: env.CONTENT_DEEP_VALIDATE_LINKS,
      migrationType: String(context.migrationType || 'FULL').toUpperCase(),
      // Set true by a unit that found the destination refuses anonymous sharing AND the policy is
      // declared via CONTENT_DEST_ANONYMOUS_SHARING=blocked. Consumed by the feature checklist.
      anonymousBlocked: false,
    };

    if (siteId) {
      for (const unit of units) {
        try {
          const res = await validateUnit(unit, { agent: this, context, siteId, sharedDrive, bands, mapEmail });
          perUser.push(res);
          accumulate(totals, res);
        } catch (err) {
          logger.error(`[GoogledriveToSharepoint validation] unit failed: ${err.message}`);
          perUser.push({
            sourceEmail: unit.sourceEmail,
            destinationEmail: unit.destinationEmail,
            sourcePath: unit.sourcePath,
            destinationPath: unit.destinationPath,
            mapping: {
              sourceEmail: unit.sourceEmail, sourceLocation: unit.sourcePath,
              destEmail: unit.destinationEmail, destLocation: unit.destinationPath,
            },
            status: 'FAIL',
            summary: 'Validation error',
            checks: [{ name: 'Validation error', status: 'FAIL', detail: err.message }],
          });
        }
      }
    }

    return buildResult(globalChecks, perUser, totals);
  }
}

/**
 * Validate one source→destination transfer unit.
 * Every check pushes a row; the unit's status is the worst row.
 */
async function validateUnit(unit, deps) {
  const { agent, context, siteId, sharedDrive, bands, mapEmail } = deps;
  const checks = [];
  const push = (status, name, detail) => checks.push({ name, status, detail });
  const itemDetails = new Map();
  const found = {
    missing: [], extra: [], misplaced: [], placeholderLinks: [],
    hashed: [], notHashed: [], hashMismatches: [],
    permissionMismatches: [], sharedLinkMismatches: [], versionInfo: [], timestampDrift: [],
    conversionMismatches: [], scannedSourceItems: 0, pairedCount: 0,
    // Per-feature evidence. A role or link type we never saw in the source cannot be reported as
    // passing — the checklist marks it "not applicable" instead, with that reason.
    permissionObservations: [], linkObservations: [], externalShares: [],
    fileTypes: [], specialChars: { total: 0, arrived: 0 }, notificationLeaks: [],
  };

  const sourceFolderName = core.lastSegment(unit.sourcePath);
  const destBase = core.inDrivePath(unit.destinationPath || '/');
  const treeDepth = bands.treeDepth || 25;
  const pathLimit = bands.pathLengthLimit || core.PATH_LENGTH_LIMIT;
  const segmentLimit = bands.segmentLengthLimit || core.SEGMENT_LENGTH_LIMIT;

  // ── Feature 3.1 / 11.1: locate the migrated root folder. The destination agent owns the probe
  // (rename variants + CloudFuze's dedup counter) so every SharePoint combination resolves it alike.
  const rootProbe = await agent.findMigratedRoot(siteId, destBase, sourceFolderName, unit.destinationEmail);
  const spRootItem = rootProbe.item;
  const spRootPath = rootProbe.path;
  const renameNote = rootProbe.renameNote;

  if (spRootItem && spRootPath) {
    push('PASS', '1. Destination location',
      `"${sourceFolderName || '(root)'}" found at ${spRootPath}${renameNote}`);
  } else {
    push('FAIL', '1. Destination location',
      `"${sourceFolderName}" not found under ${destBase} in SharePoint`);
  }

  if (sourceFolderName) {
    if (spRootItem && core.namesMatch(sourceFolderName, spRootItem.name)) {
      push('PASS', '2. Folder name preserved', `"${spRootItem.name}" matches source "${sourceFolderName}"${renameNote}`);
    } else if (spRootItem) {
      push('WARN', '2. Folder name preserved', `Source "${sourceFolderName}" → SharePoint "${spRootItem.name}"`);
    } else {
      push('FAIL', '2. Folder name preserved', `Source "${sourceFolderName}" not found in destination`);
    }
  }

  // ── Build both trees
  let sourceTree = [];
  let sourceRootId = null;
  try {
    const rootId = sharedDrive?.id || 'root';
    const resolved = unit.sourcePath
      ? await driveClient.resolveFolderByPath(unit.sourcePath, unit.sourceEmail, {
        rootId, driveId: sharedDrive?.id || null,
      })
      : { id: rootId, name: sharedDrive?.name || '(root)' };

    if (!resolved) {
      push('WARN', 'Drive source tree', `Source path "${unit.sourcePath}" not found — skipping content comparison`);
    } else {
      sourceRootId = resolved.id;
      sourceTree = await driveClient.buildFolderTree(sourceRootId, unit.sourceEmail, {
        maxDepth: treeDepth, driveId: sharedDrive?.id || null,
      });
    }
  } catch (err) {
    push('WARN', 'Drive source tree', `Could not read the Drive source: ${err.message}`);
  }

  let destTree = [];
  if (spRootItem && spRootPath) {
    try {
      destTree = await agent.readTree(siteId, spRootPath, unit.destinationEmail, treeDepth);
    } catch (err) {
      push('WARN', 'SharePoint destination tree', `Could not read the SharePoint tree: ${err.message}`);
    }
  }

  found.scannedSourceItems = sourceTree.length;

  // A tree we could not read must never look like a pass.
  if (sourceTree.length === 0) {
    push('FAIL', 'Source items scanned',
      'No source items were read — nothing was validated. Check the Shared Drive name, the source path, and Drive access.');
    return finishUnit(unit, checks, found, itemDetails, spRootPath, destBase, sourceFolderName, spRootItem);
  }
  push('PASS', 'Source items scanned', `${sourceTree.length} item(s) read from the source`);

  // ── Feature 3.1 + 11.1: structure
  const cmp = core.compareTrees(sourceTree, destTree, {
    destPrefix: spRootPath || destBase, pathLimit, segmentLimit,
  });
  found.pairedCount = cmp.matchedCount;
  found.missing = cmp.missing.map((i) => ({ path: i.path, type: i.type, name: i.name }));
  found.extra = cmp.extra.map((i) => ({ path: i.path, type: i.type, name: i.name }));
  found.misplaced = cmp.misplaced;
  found.placeholderLinks = cmp.placeholderLinks;
  found.notMigratable = cmp.notMigratable;

  const structureDetail = `source ${cmp.totalSource}, dest ${cmp.totalDest}, matched ${cmp.matchedCount}, `
    + `missing ${cmp.missing.length}, extra ${cmp.extra.length}, misplaced ${cmp.misplaced.length}`;
  if (cmp.status === 'PASS') {
    push('PASS', '3. File/folder structure (feature 3.1)', `Identical — ${structureDetail}`);
  } else {
    const diffs = [];
    if (cmp.missing.length) diffs.push(`MISSING: ${cmp.missing.slice(0, 15).map((i) => i.path).join(', ')}`);
    if (cmp.extra.length) diffs.push(`EXTRA: ${cmp.extra.slice(0, 15).map((i) => i.path).join(', ')}`);
    if (cmp.misplaced.length) {
      diffs.push(`MISPLACED: ${cmp.misplaced.slice(0, 15).map((m) => `${m.source}→${m.dest}`).join(', ')}`);
    }
    push('FAIL', '3. File/folder structure (feature 3.1)', `${structureDetail} | ${diffs.join(' | ')}`);
  }

  const folderStructure = core.compareFolders(sourceTree, destTree, {
    destPrefix: spRootPath || destBase, pathLimit, segmentLimit,
    sourceRootName: sourceFolderName || sharedDrive?.name || '(root)',
    destRootName: spRootItem?.name || '(root)',
    sourceLabel: 'Google Shared Drive',
    destLabel: 'SharePoint',
  });

  // Feature 11.1 — over-limit items are expected as placeholder links, reported but not failed
  if (cmp.placeholderLinks.length > 0) {
    push('WARN', `11. Long paths — placeholder links (${cmp.placeholderLinks.length})`,
      cmp.placeholderLinks.slice(0, 10)
        .map((p) => `${p.path} (${p.encodedLength} encoded chars)`).join(' | ')
        + ' — a Folder/File Path Link URL is the documented outcome above 400 characters');
  }

  // ── Feature 2.1: every source file type arrived
  const byExtension = new Map();
  // Items over the path limit are absent by design (feature 11.1) — counting them as a missing file
  // type would fail this feature for behaviour the documentation calls correct.
  const placeholderPaths = new Set(cmp.placeholderLinks.map((p) => p.path));
  // Google-only types have nothing to convert into, so they are excluded here too.
  const notMigratablePaths = new Set(cmp.notMigratable.map((n) => n.path));
  for (const item of sourceTree.filter((i) => i.type === 'file')) {
    if (placeholderPaths.has(item.path) || notMigratablePaths.has(item.path)) continue;
    const ext = core.isGoogleNative(item.mimeType) ? '(Google native)' : (core.extensionOf(item.name) || '(no extension)');
    const bucket = byExtension.get(ext) || { total: 0, paired: 0 };
    bucket.total++;
    if (cmp.matched.has(item.path)) bucket.paired++;
    byExtension.set(ext, bucket);
  }
  found.fileTypes = [...byExtension.entries()].map(([ext, v]) => ({ ext, total: v.total, paired: v.paired }));
  const typeGaps = [...byExtension.entries()].filter(([, v]) => v.paired < v.total);
  const typeSummary = [...byExtension.entries()].map(([k, v]) => `${k} ${v.paired}/${v.total}`).join(', ');
  push(typeGaps.length === 0 ? 'PASS' : 'FAIL', '4. File types migrated (feature 2.1)', typeSummary || 'no files in source');

  // ── Feature 7.1: special characters
  const needSanitizing = sourceTree.filter((i) => core.needsSanitizing(i.name));
  if (needSanitizing.length === 0) {
    push('PASS', '5. Special characters (feature 7.1)', 'No items carry characters SharePoint rejects');
  } else {
    // Absent-by-design items cannot be "found after rename"; counting them would fail documented
    // behaviour (outscope: must never fail a run).
    const expectedPresent = needSanitizing.filter(
      (i) => !placeholderPaths.has(i.path) && !notMigratablePaths.has(i.path)
    );
    const arrived = expectedPresent.filter((i) => cmp.matched.has(i.path));
    found.specialChars = { total: expectedPresent.length, arrived: arrived.length };
    const sample = needSanitizing.slice(0, 8)
      .map((i) => `"${i.name}" → "${core.sanitizeForSharePoint(i.name)}"`).join(' | ');
    const skippedByDesign = needSanitizing.length - expectedPresent.length;
    push(arrived.length === expectedPresent.length ? 'PASS' : 'FAIL',
      `5. Special characters (feature 7.1) — ${expectedPresent.length} item(s)`,
      `${arrived.length}/${expectedPresent.length} found after replacement`
      + (skippedByDesign > 0 ? `; ${skippedByDesign} excluded (over the path limit or a Google-only type)` : '')
      + `. e.g. ${sample}`);
  }
  const reserved = sourceTree.filter((i) => core.isReservedName(i.name));
  if (reserved.length > 0) {
    push('WARN', `5b. Reserved names (${reserved.length})`,
      `${reserved.slice(0, 8).map((i) => i.name).join(', ')} — SharePoint reserves these; confirm CloudFuze's rewrite manually`);
  }

  // ── Destination files still checked out are invisible to the destination user ──────────
  // Found the hard way: a run delivered 41 files, our app-only reads listed all 41, and the
  // destination user saw an empty folder in SharePoint because every file was checked out to the
  // uploading app and never checked in. Presence is not the same as availability, so check both.
  {
    const destFiles = destTree.filter((d) => d.type === 'file');
    const stuck = destFiles.filter((d) => d.checkedOut);
    if (destFiles.length === 0) {
      push('INFO', '1b. Destination files available to the user', 'No destination files to assess');
    } else if (stuck.length === 0) {
      push('PASS', '1b. Destination files available to the user',
        `all ${destFiles.length} file(s) are checked in and visible`);
    } else {
      const who = [...new Set(stuck.map((d) => d.checkedOutBy).filter(Boolean))];
      push('FAIL', `1b. Destination files available to the user — ${stuck.length} invisible`,
        `${stuck.length} of ${destFiles.length} destination file(s) are checked out and therefore `
        + 'invisible to the destination user in SharePoint, even though the bytes are present. '
        + `Checked out by: ${who.join(', ') || 'unknown'}. `
        + 'Fix at the destination: Library settings → Versioning settings → '
        + '"Require documents to be checked out" = No, then check the existing files in.');
    }
  }

  // ── Feature 12.1: conversion produced the right extension
  const convertibles = sourceTree.filter((i) => i.type === 'file' && core.isConverted(i));
  if (convertibles.length === 0) {
    push('PASS', '6. File conversion (feature 12.1)', 'No files needed conversion');
  } else {
    const wrong = [];
    const notConverted = [];
    // Destination paths that found no source partner, indexed for the lookup below.
    const extraByPath = new Map(cmp.extra.map((i) => [String(i.path || '').toLowerCase(), i]));
    for (const item of convertibles) {
      const pair = cmp.matched.get(item.path);
      const expected = core.expectedDestExtension(item.name, item.mimeType);
      if (!pair) {
        // `continue` here was a FALSE PASS. A convertible file that was NOT converted cannot pair:
        // pairing looks for the converted name (.pptx) while the destination holds the original
        // (.ppt), so the source side counts as missing and the destination side as extra — and this
        // check saw neither and reported "all converted". Run 6a8d53d2 passed feature 12.1 while all
        // six legacy Office files sat unconverted at the destination.
        //
        // Distinguish the two cases, because they are different defects: the file arrived with its
        // original extension (conversion did not run), or it never arrived at all.
        const sameName = extraByPath.get(String(item.path).toLowerCase());
        if (sameName) {
          notConverted.push(`${item.path}: still ${core.extensionOf(item.name) || '(none)'}`
            + `${expected ? `, expected ${expected}` : ''}`);
        } else {
          wrong.push(`${item.path}: absent from the destination (expected ${expected || 'a converted copy'})`);
        }
        continue;
      }
      const actual = core.extensionOf(pair.dest.name);
      if (expected && actual !== expected) {
        wrong.push(`${item.path}: expected ${expected}, got ${actual || '(none)'}`);
      }
    }
    found.conversionMismatches = wrong.concat(notConverted);
    found.notConverted = notConverted;
    const allIssues = notConverted.concat(wrong);
    push(allIssues.length === 0 ? 'PASS' : 'FAIL',
      `6. File conversion (feature 12.1) — ${convertibles.length} file(s)`,
      allIssues.length === 0
        ? 'All converted to the expected format (.doc→.docx, .xls→.xlsx, .ppt→.pptx, Google native → Office)'
        : `${notConverted.length} arrived unconverted, ${wrong.length} wrong or absent — `
          + allIssues.slice(0, 15).join(' | '));
  }

  // ── Sizes
  const sizeIssues = [];
  for (const { source, dest } of cmp.matched.values()) {
    if (source.type !== 'file') continue;
    const res = core.compareSize(source, dest, bands);
    if (res.comparable && res.status !== 'PASS') {
      sizeIssues.push({ status: res.status, line: `${source.path}: ${source.size} → ${dest.size} (${res.ratio.toFixed(2)}×)` });
    }
  }
  const sizeFails = sizeIssues.filter((s) => s.status === 'FAIL');
  if (sizeIssues.length === 0) {
    push('PASS', '7. File sizes', 'All matched files are inside the tolerance band for their type');
  } else {
    push(sizeFails.length > 0 ? 'FAIL' : 'WARN', `7. File sizes (${sizeIssues.length} outside the band)`,
      sizeIssues.slice(0, 15).map((s) => `[${s.status}] ${s.line}`).join(' | '));
  }

  // Seed the per-item report rows (drives the tree printed in the PDF).
  // An item over SharePoint's 400-character path limit is NOT absent: the destination creates a
  // Folder/File Path Link URL in its place (combination document #37), which is why check 11 and
  // the structure comparison already exclude it. The per-item rows did not know that, so a
  // deliberately over-length test path printed three red "Missing" rows for documented behaviour.
  itemDetails.set('/', {
    path: '/', name: sourceFolderName || '(root)', type: 'folder', depth: 0,
    found: Boolean(spRootItem), destName: spRootItem?.name || null, permissions: [],
  });
  for (const item of sourceTree) {
    const pair = cmp.matched.get(item.path);
    itemDetails.set(item.path, {
      path: item.path, name: item.name, type: item.type,
      depth: core.segmentsOf(item.path).length,
      found: Boolean(pair), destName: pair?.dest?.name || null,
      // Reported as the documented placeholder outcome rather than as a missing item.
      placeholder: !pair && placeholderPaths.has(item.path),
      mimeType: item.mimeType, permissions: [],
    });
  }

  // Full destination path of a source item, for the by-path Graph calls.
  // The destination path of a MATCHED item, taken from the destination side of the pair — never
  // rebuilt from the source path, because renames (feature 7.1) and conversions (feature 12.1) mean
  // the two differ. destTree was relativized to spRootPath, so re-prefix it here.
  const destPathOf = (destItem) => `${spRootPath || destBase}${destItem.path}`;
  const maxItems = env.DEEP_CONTENT_MAX_FILES;

  // ══ Tier C ═══════════════════════════════════════════════════════════════════
  // Permissions (features 4.x), shared links (5.2–5.15), versions (8.1, informational only),
  // metadata timestamps (10.1). Two API calls per item, so the same cap as Tier B applies and
  // anything skipped is reported rather than quietly dropped.
  if (env.CONTENT_DEEP_VALIDATE_METADATA) {
    const rootPair = spRootItem && spRootPath
      ? { source: { id: sourceRootId, path: '/', name: sourceFolderName || '(root)', type: 'folder' },
        destPath: spRootPath }
      : null;
    const pairs = [...cmp.matched.values()].map((p) => ({ source: p.source, destPath: destPathOf(p.dest) }));
    const targets = (rootPair && sourceRootId ? [rootPair] : []).concat(pairs);

    let permChecked = 0;
    let linkChecked = 0;
    let permSkipped = 0;
    let permReadFailed = 0;
    const notComparable = [];
    const unmappedPrincipals = [];
    const permMismatches = [];
    const escalations = [];
    const linkMismatches = [];

    for (const target of targets) {
      if (permChecked >= maxItems) { permSkipped++; continue; }

      const sourcePerms = await driveClient.listPermissions(target.source.id, unit.sourceEmail)
        .catch((err) => {
          logger.warn(`[GoogledriveToSharepoint] source permissions unavailable for ${target.source.path}: ${err.message}`);
          return null;
        });
      if (!sourcePerms) { permReadFailed++; continue; }

      const hasGrants = sourcePerms.grants.length > 0;
      const hasLinks = sourcePerms.links.length > 0;
      if (!hasGrants && !hasLinks) continue;

      permChecked++;
      const destPerms = await agent.readPermissions(siteId, target.destPath, unit.destinationEmail);
      const detail = itemDetails.get(target.source.path);

      // Features 4.1–4.8 — per-user access through the mapping
      if (hasGrants) {
        const res = core.comparePermissions(sourcePerms.grants, destPerms.permissions, mapEmail);
        if (detail) {
          detail.permissions = [...res.matches, ...res.mismatches].map((r) => ({
            user: r.user, mappedTo: r.mappedTo, sourceRole: r.sourceRole,
            destRoles: r.destRoles, match: r.match,
          }));
        }
        // Record what role was seen on what kind of item, so features 4.2–4.8 can each report
        // honestly instead of all sharing one aggregate verdict.
        const sourceDomain = String(unit.sourceEmail || '').split('@')[1]?.toLowerCase() || '';
        for (const r of [...res.matches, ...res.mismatches]) {
          found.permissionObservations.push({
            itemType: target.source.type,
            // The QA suite reports permissions by principal (user vs group) and by scope
            // (root folder / root file / sub folder / inner file), so both travel with the row.
            principalType: r.principalType || 'user',
            scope: core.scopeOf(target.source),
            viaGroup: Boolean(r.viaGroup),
            role: r.sourceRole,
            match: r.match,
            path: target.source.path,
          });
          const granteeDomain = String(r.user || '').split('@')[1]?.toLowerCase() || '';
          if (granteeDomain && sourceDomain && granteeDomain !== sourceDomain) {
            found.externalShares.push({ user: r.user, role: r.sourceRole, match: r.match, path: target.source.path });
          }
        }
        for (const m of res.mismatches) {
          permMismatches.push(`${target.source.path} — ${m.user}${m.mappedTo !== String(m.user).toLowerCase() ? ` → ${m.mappedTo}` : ''}: `
            + `Drive "${m.sourceRole}" (expect ${m.expected}) → SharePoint ${m.destRoles.join('/') || 'no access'}`);
        }
        for (const n of res.notComparable) {
          notComparable.push(`${target.source.path} — ${n.user}: "${n.sourceRole}" — ${n.reason}`);
        }
        for (const u of (res.unmappedPrincipals || [])) {
          unmappedPrincipals.push(`${u.user} (${u.principalType}, "${u.sourceRole}")`);
        }
        for (const e of res.escalations) {
          escalations.push(`${target.source.path} — ${e.user}: Drive "${e.sourceRole}" (expect ${e.expected}) `
            + `→ SharePoint ${e.destRoles.join('/')}`);
        }
      }

      // Features 5.2–5.15 — link scope AND link type must both survive
      if (hasLinks && env.CONTENT_DEEP_VALIDATE_LINKS) {
        linkChecked++;
        const res = core.compareSharedLinks(sourcePerms.links, destPerms.links);
        if (detail) detail.sharedLinks = res.results;
        for (const r of res.results) {
          found.linkObservations.push({
            itemType: target.source.type, linkType: r.sourceType, role: r.sourceRole,
            scope: core.scopeOf(target.source), match: r.match, path: target.source.path,
          });
        }
        for (const m of res.mismatches) {
          linkMismatches.push({
            text: `${target.source.path} — Drive ${m.sourceType}/${m.sourceRole} `
              + `(expect ${m.expected}) → ${m.actual}: ${m.reason}`,
            // Carried as a FACT from the comparison rather than re-derived from the text above.
            anonExcusable: Boolean(m.anonymousExcusable),
          });
        }
      }
    }

    found.permissionMismatches = permMismatches;
    found.notComparable = notComparable;
    found.unmappedPrincipals = unmappedPrincipals;

    // Principals with no destination mapping are a configuration gap, not a migration defect:
    // CloudFuze has nobody to re-grant their access to. Reported on their own row so the
    // permission verdict below is about grants that actually should have migrated.
    if (unmappedPrincipals.length > 0) {
      const distinct = [...new Set(unmappedPrincipals)];
      push('INFO', `8b. Permissions not migratable — ${distinct.length} unmapped principal(s)`,
        `${distinct.slice(0, 12).join(' | ')}`
        + (distinct.length > 12 ? ` | +${distinct.length - 12} more` : '')
        + '. Map these under Map Users to bring their permissions into scope.');
    }
    found.sharedLinkMismatches = linkMismatches.map((m) => m.text);

    if (permChecked === 0) {
      push('WARN', '8. Permissions (features 4.1–4.8)', 'No shared items on the source to verify');
    } else if (permMismatches.length === 0) {
      push('PASS', '8. Permissions (features 4.1–4.8)',
        `${permChecked} shared item(s) verified — roles mapped correctly (Viewer/Commenter → view, Contributor/Content Manager → edit)`);
    } else {
      push('FAIL', `8. Permissions (features 4.1–4.8) — ${permMismatches.length} mismatch`,
        permMismatches.slice(0, 20).join(' | '));
    }

    // Over-granting is a privilege escalation, not a "close enough" pass.
    if (escalations.length > 0) {
      push('FAIL', `8b. Permission escalation (${escalations.length})`,
        `Destination grants MORE access than the source: ${escalations.slice(0, 15).join(' | ')}`);
    }

    if (env.CONTENT_DEEP_VALIDATE_LINKS) {
      // A destination that refuses anonymous sharing cannot receive an "anyone with the link"
      // grant, and the combination document is explicit that this is expected rather than a
      // defect: "If external sharing is restricted or disabled in SharePoint, those permissions
      // may not be applied in the destination" (Shared Drive to SharePoint, #13 External Shares).
      //
      // Split the two cases so a blocked tenant policy is not reported as a migration failure
      // while genuine organization-scope losses still are.
      //
      // The policy is DECLARED, not inferred. An earlier version concluded "the site blocks
      // anonymous sharing" whenever no anonymous link matched — but one genuinely failed link
      // produces that same shape, so a real defect would have been reported as expected
      // behaviour. Verify the destination (Graph createLink with scope=anonymous returns
      // "notAllowed: sharing has been disabled on this site" when blocked) and set
      // CONTENT_DEST_ANONYMOUS_SHARING=blocked. Unset, these stay failures.
      // Only "nothing arrived at all" is consistent with the site refusing anonymous sharing. A link
      // that arrived NARROWED to organization scope is data loss: the destination demonstrably can
      // hold a link, it just holds a weaker one. The first version of this check matched on the word
      // "anonymous" alone and so excused those downgrades — contentCombinationSuite.test.js caught
      // it via its 'a public link narrowed to the organization fails the run' negative case.
      // The comparison decides which anonymous losses are consistent with a blocked destination
      // (see compareSharedLinks); this only applies the DECLARED policy to them.
      const anonMismatches = linkMismatches.filter((m) => m.anonExcusable);
      const anonymousBlocked = anonMismatches.length > 0
        && String(env.CONTENT_DEST_ANONYMOUS_SHARING || '').toLowerCase() === 'blocked';
      // The feature rows (5.2-5.5, 5.10-5.12) must reach the SAME verdict as check 9b below.
      // Without this they failed 7 anonymous rows that 9b had just reported as not applicable,
      // which is how one run showed 4 failing checks beside 16 failing features.
      found.anonymousBlocked = anonymousBlocked;
      // Only excused when the policy is declared. Otherwise a missing anonymous link is a failure
      // like any other — excusing it unconditionally would have hidden real defects.
      const otherMismatches = anonymousBlocked
        ? linkMismatches.filter((m) => !m.anonExcusable)
        : linkMismatches;

      if (anonymousBlocked) {
        push('INFO', `9b. Anonymous links not applicable — ${anonMismatches.length} item(s)`,
          `The destination site does not permit anonymous ("anyone with the link") sharing, so `
          + 'these links cannot be recreated. Per the combination document (#13 External Shares): '
          + '"If external sharing is restricted or disabled in SharePoint, those permissions may '
          + 'not be applied in the destination." Organization-scope links are still validated below.');
      }

      if (linkChecked === 0) {
        push('WARN', '9. Shared links (features 5.2–5.15)', 'No shared links on the source to verify');
      } else if (otherMismatches.length === 0) {
        push('PASS', '9. Shared links (features 5.2–5.15)',
          `${linkChecked} item(s) with links verified — scope and access level both preserved`
          + (anonymousBlocked ? ` (${anonMismatches.length} anonymous link(s) not applicable — see 9b)` : ''));
      } else {
        push('FAIL', `9. Shared links (features 5.2–5.15) — ${otherMismatches.length} mismatch`,
          // List the SAME set the count is about. Reporting the full list under a filtered
          // count put two contradicting numbers in one row: "7 mismatch" above eighty anonymous
          // lines that had just been excused.
          otherMismatches.slice(0, 20).map((m) => m.text).join(' | '));
      }
    }

    if (notComparable.length > 0) {
      push('WARN', `8c. Permissions not comparable (${notComparable.length})`,
        notComparable.slice(0, 10).join(' | '));
    }

    if (permReadFailed > 0) {
      push('WARN', `8d. Source permissions unreadable (${permReadFailed} item(s))`,
        'Their permissions could NOT be checked — this is not the same as "no permissions to check". '
        + 'Verify Drive access for the source account.');
    }

    if (permSkipped > 0) {
      push('WARN', 'Permission checks skipped', `${permSkipped} item(s) beyond the ${maxItems}-item cap were not checked`);
    }

    // ── Feature 10.1: created / modified timestamps
    const drift = [];
    let tsChecked = 0;
    for (const { source, dest } of cmp.matched.values()) {
      if (source.type !== 'file') continue;
      const res = core.compareTimestamps(source, dest, bands.timestampDriftMs || 5 * 60 * 1000);
      if (!res.comparable) continue;
      tsChecked++;
      const detail = itemDetails.get(source.path);
      if (detail) detail.timestamps = res;
      if (!res.match) {
        drift.push(`${source.path}: ${res.modifiedOff ? `modified ${res.sourceModified} → ${res.destModified}` : ''}`
          + `${res.modifiedOff && res.createdOff ? '; ' : ''}`
          + `${res.createdOff ? `created ${res.sourceCreated} → ${res.destCreated}` : ''}`);
      }
    }
    found.timestampDrift = drift;
    if (tsChecked === 0) {
      push('WARN', '10. Metadata — created/modified (feature 10.1)', 'No comparable timestamps on matched files');
    } else if (drift.length === 0) {
      push('PASS', '10. Metadata — created/modified (feature 10.1)',
        `${tsChecked} file(s) — created and modified times preserved within tolerance`);
    } else {
      push('WARN', `10. Metadata — created/modified (feature 10.1) — ${drift.length} outside tolerance`,
        drift.slice(0, 15).join(' | '));
    }

    // ── Feature 8.1: versions. INFORMATIONAL by design — see the out-of-scope doc. Google merges
    // revisions when listing and SharePoint may add one for the migration timestamp, so a count
    // difference is documented platform behaviour and cannot fail the run.
    const versionInfo = [];
    let versionedFiles = 0;
    let versionsChecked = 0;
    // Both formats are checked: the QA suite exercises version history on Google-format files
    // (Docs/Sheets/Slides) as well as uploaded Microsoft-format files. Google-format revisions are
    // the ones the API merges most aggressively, which is exactly why the comparison is
    // informational rather than a pass/fail on counts.
    for (const { source, dest } of cmp.matched.values()) {
      if (source.type !== 'file') continue;
      if (versionsChecked >= maxItems) break;
      const src = await driveClient.listRevisions(source.id, unit.sourceEmail)
        .catch(() => ({ totalVersions: 0 }));
      if (src.totalVersions <= 1) continue;
      versionsChecked++;
      versionedFiles++;
      const dst = { totalVersions: await agent.readVersionCount(siteId, destPathOf(dest), unit.destinationEmail) };
      const row = core.compareVersions(src.totalVersions, dst.totalVersions, {
        path: source.path, name: source.name,
      });
      row.format = core.isGoogleNative(source.mimeType) ? 'google' : 'microsoft';
      versionInfo.push(row);
      const detail = itemDetails.get(source.path);
      if (detail) detail.versions = { source: src.totalVersions, dest: dst.totalVersions };
    }
    found.versionInfo = versionInfo;

    const noHistory = versionInfo.filter((v) => v.destVersions === 0);
    if (versionedFiles === 0) {
      push('WARN', '11. Version history (feature 8.1)', 'No multi-version files among the matched files');
    } else if (noHistory.length > 0) {
      // No history at all is worth flagging: it usually means versioning is off on the library.
      push('WARN', `11. Version history (feature 8.1) — ${noHistory.length} file(s) with no destination history`,
        `${noHistory.slice(0, 10).map((v) => v.path).join(', ')} — check that versioning is enabled on the document library`);
    } else {
      push('PASS', `11. Version history (feature 8.1) — ${versionedFiles} versioned file(s)`,
        `History present on the destination. Counts are reported for information only: the Google API `
        + `merges smaller revisions and SharePoint may add a version for the migration timestamp, so `
        + `counts are not expected to match (documented limitation).`);
    }
  }

  // ══ Tier B ═══════════════════════════════════════════════════════════════════
  // File bytes. Off by default — two full downloads per file. Converted and Google native files
  // cannot hash equal (a converter produced the destination), so they are reported as NOT hashed
  // with the reason and never counted as hash passes.
  if (env.CONTENT_DEEP_VALIDATE_FILE_HASH) {
    const result = await core.tierBHashes(
      cmp.matched.values(),
      (item) => driveClient.downloadFile(item.id, unit.sourceEmail),
      (item) => agent.readContent(siteId, `${spRootPath || destBase}${item.path}`, unit.destinationEmail),
      { maxFiles: maxItems, log: logger }
    );
    found.hashed = result.hashed;
    found.notHashed = result.notHashed;
    found.hashMismatches = result.mismatches;

    for (const h of result.hashed) {
      const detail = itemDetails.get(h.path);
      if (detail) detail.contentHash = { sha256: h.sha256, ok: h.ok !== false };
    }

    const okCount = result.hashed.filter((h) => h.ok !== false).length;
    if (result.scanned === 0) {
      push('WARN', '12. File content hashes (Tier B)',
        `No hashable files — ${result.notHashed.length} file(s) are converted or native and cannot be byte-compared`);
    } else if (result.mismatches.length === 0) {
      push('PASS', '12. File content hashes (Tier B)',
        `${okCount} file(s) byte-identical (SHA-256). ${result.notHashed.length} not hashed (converted/native/capped) — reported separately, not counted as passes`);
    } else {
      push('FAIL', `12. File content hashes (Tier B) — ${result.mismatches.length} corrupted`,
        result.mismatches.slice(0, 15)
          .map((m) => `${m.path}: ${m.sourceBytes}B → ${m.destBytes}B (hash differs)`).join(' | '));
    }
  }

  // ══ Features 9.1 / 9.2 — suppress email notifications ════════════════════════
  // After a migration with suppression on, the destination user must have received NO SharePoint
  // sharing or invitation mail. Mail from the SOURCE side (sent when the permission was originally
  // granted) is expected and is not a suppression failure, so only destination-side notifications
  // count. Off by default because it needs mailbox access for the destination user.
  if (env.CONTENT_DEEP_VALIDATE_NOTIFICATIONS) {
    const res = await agent.findSharingNotifications(unit.destinationEmail, context?.startTime || context?.startedAt);
    found.notificationLeaks = res.leaks;
    if (!res.ok) {
      push('WARN', '13. Suppress email notifications (features 9.1/9.2)',
        `Could not read ${unit.destinationEmail}'s mailbox: ${res.error} — verify manually`);
    } else if (res.leaks.length === 0) {
      push('PASS', '13. Suppress email notifications (features 9.1/9.2)',
        `No SharePoint sharing or invitation mail reached ${unit.destinationEmail} — suppression held`);
    } else {
      push('FAIL', `13. Suppress email notifications (features 9.1/9.2) — ${res.leaks.length} leaked`,
        res.leaks.slice(0, 10).join(' | '));
    }
  }

  return finishUnit(unit, checks, found, itemDetails, spRootPath, destBase, sourceFolderName,
    spRootItem, folderStructure);
}

function finishUnit(unit, checks, found, itemDetails, spRootPath, destBase, sourceFolderName,
  spRootItem, folderStructure = null) {
  const status = checks.some((c) => c.status === 'FAIL')
    ? 'FAIL'
    : checks.some((c) => c.status === 'WARN') ? 'WARN' : 'PASS';

  const destLocationLabel = `${unit.destinationPath || '/'}`
    + (sourceFolderName ? ` → ${spRootPath || '(not found)'}` : '');

  return {
    sourceEmail: unit.sourceEmail,
    destinationEmail: unit.destinationEmail,
    sourcePath: unit.sourcePath,
    destinationPath: spRootPath || unit.destinationPath,
    mapping: {
      sourceEmail: unit.sourceEmail, sourceLocation: unit.sourcePath,
      destEmail: unit.destinationEmail, destLocation: destLocationLabel,
    },
    status,
    summary: `${checks.filter((c) => c.status === 'PASS').length}/${checks.length} checks passed`,
    checks,
    folderStructure,
    found,
    items: [...itemDetails.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Roll a unit's findings into the run totals. */
function accumulate(totals, unitResult) {
  const f = unitResult?.found;
  if (!f) return;
  totals.scannedSourceItems += f.scannedSourceItems || 0;
  totals.pairedCount += f.pairedCount || 0;
  for (const key of ['missing', 'extra', 'misplaced', 'placeholderLinks', 'hashMismatches',
    'permissionMismatches', 'sharedLinkMismatches', 'versionInfo', 'timestampDrift',
    'conversionMismatches', 'notMigratable', 'notComparable', 'permissionObservations', 'linkObservations', 'externalShares',
    'fileTypes', 'notificationLeaks']) {
    if (Array.isArray(f[key])) totals[key].push(...f[key]);
  }
  totals.hashedCount += (f.hashed || []).length;
  totals.notHashedCount += (f.notHashed || []).length;
  totals.specialChars.total += f.specialChars?.total || 0;
  totals.specialChars.arrived += f.specialChars?.arrived || 0;
  // Declared destination policy, not a per-unit measurement: if any unit saw the site refuse
  // anonymous sharing, the feature rows for anonymous links are not applicable for the run.
  if (f.anonymousBlocked) totals.anonymousBlocked = true;
}

/**
 * Find the Shared Drive a run reads from when nothing names it.
 *
 * The run identifies its source as a folder ("Agent Box Data"), not a drive, so the drive is whichever
 * one actually contains that folder. Guessing wrong is worse than failing: a drive without the folder
 * yields an empty source tree, and an empty tree compared against an empty destination looks clean.
 * A single unambiguous match is therefore required — zero and several are both reported as failures.
 *
 * @returns {{ drive: object|null, detail: string }}
 */
async function discoverSharedDrive(units) {
  const email = units[0]?.sourceEmail;
  const folderName = core.lastSegment(units[0]?.sourcePath || '');

  // Without a folder there is nothing to search on, and a QA admin account can be a member of a
  // thousand Shared Drives — picking one would be a coin toss.
  if (!folderName) {
    return {
      drive: null,
      detail: `The run migrates the whole root, so there is no folder to identify the Shared Drive by. `
        + 'Name it with GOOGLE_SHARED_DRIVE_NAME (or the run\'s sourceSharedDriveName).',
    };
  }

  let hits;
  try {
    hits = await driveClient.findFoldersByName(folderName, email);
  } catch (err) {
    return { drive: null, detail: `Could not search Drive for "${folderName}" as ${email}: ${err.message}` };
  }

  if (!hits.length) {
    return {
      drive: null,
      detail: `No folder named "${folderName}" exists anywhere ${email} can see — not in My Drive and not `
        + 'in any Shared Drive. Either the source data was never seeded or the run names the wrong folder.',
    };
  }

  // A hit with no driveId lives in My Drive. Reporting that as "not found" would send someone hunting
  // for a missing folder that is really just in the wrong place for a Shared Drive run.
  const inSharedDrives = hits.filter((h) => h.driveId);
  if (!inSharedDrives.length) {
    return {
      drive: null,
      detail: `"${folderName}" exists in ${email}'s My Drive but in no Shared Drive. This run is configured `
        + 'with a Shared Drive source — either move the data into a Shared Drive or run the My Drive source.',
    };
  }

  const driveIds = [...new Set(inSharedDrives.map((h) => h.driveId))];
  if (driveIds.length > 1) {
    return {
      drive: null,
      detail: `"${folderName}" exists in ${driveIds.length} Shared Drives — ambiguous. `
        + 'Set GOOGLE_SHARED_DRIVE_NAME to say which one.',
    };
  }

  try {
    const drive = await driveClient.getSharedDriveById(driveIds[0], email);
    if (drive?.id) {
      return { drive, detail: `"${drive.name}" (${drive.id}) — the only Shared Drive containing "${folderName}"` };
    }
  } catch (err) {
    return { drive: null, detail: `Shared Drive ${driveIds[0]} could not be read: ${err.message}` };
  }
  return { drive: null, detail: `Shared Drive ${driveIds[0]} could not be read` };
}

function buildResult(globalChecks, perUser, totals) {
  const flat = [...globalChecks];
  for (const u of perUser) {
    const tag = u.sourceEmail || u.sourcePath || 'user';
    for (const c of u.checks) flat.push({ ...c, name: `[${tag}] ${c.name}` });
  }
  const hasFail = flat.some((c) => c.status === 'FAIL');
  const hasWarn = flat.some((c) => c.status === 'WARN');
  const overall = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';

  // Per-feature rollup against the 38 documented features. A feature that was never exercised reports
  // "not assessed" with its reason — it is never counted as passing.
  const { rows: featureChecklist, coverage } = computeContentFunctionalityChecklist(totals, {
    migrationType: totals?.migrationType,
  });
  const featureSummary = summarizeChecklist(featureChecklist, coverage);
  if (totals) {
    totals.featureChecklist = featureChecklist;
    totals.featureSummary = featureSummary;
  }

  const scanned = totals?.scannedSourceItems || 0;

  // Neutara builds the ticket (priority, type, description) from `mismatches`. Without it a failing
  // content run raised an empty low-priority ticket naming no defect, so every FAIL check is carried
  // through as one. Checks that mean "nothing could be compared" are infrastructure — they are the
  // most urgent kind, because the run proved nothing at all.
  const infraCheck = /site accessible|Shared Drive resolved|Source items scanned|Destination location/i;
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

  return {
    featureChecklist,
    mismatches,
    featureSummary,
    status: overall,
    overallStatus: overall,
    domain: 'content',
    sourceProvider: 'googledrive',
    destinationProvider: 'sharepoint',
    combination: COMBINATION,
    checks: flat,
    perUser,
    deepContentValidation: totals,
    // Leading with a pass ratio reads as partial success. On a run that moved nothing the passing
    // checks are all infrastructure — "site accessible", "Shared Drive resolved" — which are true but
    // say nothing about migrated content, while the feature checklist correctly shows 0 pass. Those
    // two numbers side by side ("7/16 checks passed … Features: 0 pass") read as a contradiction, so
    // when nothing paired the summary states that first and labels the rest as reachability only.
    summary: (() => {
      const passed = flat.filter((c) => c.status === 'PASS').length;
      const paired = totals?.pairedCount || 0;
      const tail = `${perUser.length} unit(s); ${scanned} source item(s) scanned, ${paired} paired. `
        + featureSummary.line;
      if (scanned > 0 && paired === 0) {
        return `MIGRATION MOVED NOTHING — 0 of ${scanned} source item(s) reached the destination, so no `
          + `content was compared. ${passed}/${flat.length} reachability check(s) passed (source and `
          + `destination readable) — these say nothing about migrated data. ${tail}`;
      }
      return `${passed}/${flat.length} checks passed across ${tail}`;
    })(),
  };
}

module.exports = GoogledriveToSharepointValidationAgent;
