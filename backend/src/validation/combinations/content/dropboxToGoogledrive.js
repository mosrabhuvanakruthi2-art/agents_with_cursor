'use strict';

/**
 * Deep validation for content: Dropbox → Google My Drive.
 *
 * Edit ONLY this file to change Dropbox → My Drive behaviour. Provider-agnostic comparison logic
 * lives in validation/shared/deepContentCore.js; the numbers live in utils/contentTolerance/; the
 * Google destination's name/path rules live in validation/destinations/googledrive.js; the
 * Dropbox→Google role and link tables live in validation/roleMaps/dropbox_to_google.js.
 *
 * Feature coverage — backend/data/feature-scope/dropbox-to-google-inscope.md (36 in-scope features):
 *   Tier A — 1.1 structure, 5.1 special characters, 7.1 long paths
 *   Tier B — file content hashes for pass-through formats
 *   Tier C — 2.1–2.5 permissions, 3.1–3.2 shared links, 4.1 metadata, 9.1–9.2 versions
 *   Reports — 3.1/3.2/8.1 CSVs written into the destination
 *   §10     — Dropbox Paper (19 features): reported, not judged. See PAPER_DISPUTED below.
 *
 * THE DESTINATION IS GOOGLE, NOT SHAREPOINT. That single fact changes three rules, and getting any
 * of them wrong produces confident false failures rather than quiet gaps:
 *
 *   - Google rejects almost no characters, so feature 5.1's expected outcome is NO replacement.
 *     Applying SharePoint's character set here predicts a renamed folder that never occurs, then
 *     reports it missing, reports its real name extra, and reports every child misplaced.
 *   - Google imposes no total-path limit, so no placeholder link is ever the expected outcome for
 *     feature 7.1. Expecting one reports intact deep data as wrongly handled.
 *   - A shared LINK in Drive is a permission entry (type 'anyone' / 'domain'), not a separate
 *     object. Left in the user list it makes every link look like a grant to an unknown principal.
 *
 * All three are handled by passing the Google destination rules into the shared comparison rather
 * than by branching here, so there is one place that says what Google does.
 */

const GoogleDriveValidationAgent = require('../../../agents/googledrive/GoogleDriveValidationAgent');
const dropboxClient = require('../../../clients/dropboxClient');
const core = require('../../shared/deepContentCore');
const destinations = require('../../destinations');
const roleMaps = require('../../roleMaps');
const tolerance = require('../../../utils/contentTolerance');
const env = require('../../../config/env');
const logger = require('../../../utils/logger');

const COMBINATION = 'dropbox_to_googledrive';

/**
 * How long to wait for CloudFuze's permission phase before calling a grant missing.
 *
 * Only used when the source has grants and the destination reports none — see the note in
 * _validateItem. Two attempts at 8s keeps the worst case bounded (16s per affected item) while
 * covering the delay actually observed.
 */
const PERMISSION_SETTLE_ATTEMPTS = 2;
const PERMISSION_SETTLE_MS = 8000;

/** Terminal CloudFuze statuses that mean the migration itself finished. */
const CF_OK = ['PROCESSED', 'PROCESS', 'VERSION_PROCESSED'];
const CF_CONFLICTS = ['PROCESSED_WITH_CONFLICTS', 'PROCESS_WITH_CONFLICTS'];

/**
 * The 36 in-scope features, in the scope document's own numbering.
 *
 * A combination-local list rather than validation/shared/contentFunctionalityChecklist.js: that
 * module hardcodes the Google→SharePoint feature set, including Commenter / Contributor / Content
 * Manager roles that do not exist in Dropbox and a "Sync Orbit" wording taken from one tenant. Using
 * it here would produce a report whose feature ids do not match the document a reviewer is holding.
 * Editing it would change both live SharePoint combinations, which CONTRIBUTING forbids.
 */
const DROPBOX_FEATURES = [
  { id: '1.1', category: 'Migration', feature: 'Data Migration (Files & Folders with structure)' },
  { id: '1.2', category: 'Migration', feature: 'One Time Migration' },
  { id: '1.3', category: 'Migration', feature: 'Delta Migration' },

  { id: '2.1', category: 'Permissions', feature: 'Root Folder Permissions' },
  { id: '2.2', category: 'Permissions', feature: 'Root File Permissions' },
  { id: '2.3', category: 'Permissions', feature: 'Sub-folder permissions' },
  { id: '2.4', category: 'Permissions', feature: 'Inner file permissions' },
  { id: '2.5', category: 'Permissions', feature: 'External Shares' },

  { id: '3.1', category: 'Shared Links', feature: 'Shared Links (Anyone with the Link)' },
  { id: '3.2', category: 'Shared Links', feature: 'Shared Links (Team Members)' },

  { id: '4.1', category: 'Metadata', feature: 'Metadata (timestamps)' },
  { id: '5.1', category: 'Special Characters Replacement', feature: 'Special Characters Replacement' },
  { id: '6.1', category: 'Suppressing email notifications', feature: 'Suppressing email notifications' },
  { id: '7.1', category: 'Long-File/folder path', feature: 'Long-File/folder path' },
  { id: '8.1', category: 'Embedded Links', feature: 'Embedded Links' },

  { id: '9.1', category: 'Versions', feature: 'Version History' },
  { id: '9.2', category: 'Versions', feature: 'Selective Versions' },

  { id: '10.1', category: 'Dropbox Papers', feature: 'Dropbox Papers Migration' },
  { id: '10.2', category: 'Dropbox Papers', feature: 'Text Formatting' },
  { id: '10.3', category: 'Dropbox Papers', feature: 'Inserted Images' },
  { id: '10.4', category: 'Dropbox Papers', feature: 'Inserted Media' },
  { id: '10.5', category: 'Dropbox Papers', feature: 'Clipboard Images' },
  { id: '10.6', category: 'Dropbox Papers', feature: 'GIFs' },
  { id: '10.7', category: 'Dropbox Papers', feature: 'Links' },
  { id: '10.8', category: 'Dropbox Papers', feature: 'Insert Dropbox Files' },
  { id: '10.9', category: 'Dropbox Papers', feature: 'Tables' },
  { id: '10.10', category: 'Dropbox Papers', feature: 'Inserted Timeline' },
  { id: '10.11', category: 'Dropbox Papers', feature: 'TO-DO list' },
  { id: '10.12', category: 'Dropbox Papers', feature: 'Bulleted List' },
  { id: '10.13', category: 'Dropbox Papers', feature: 'Numbered List' },
  { id: '10.14', category: 'Dropbox Papers', feature: 'Section Break' },
  { id: '10.15', category: 'Dropbox Papers', feature: 'Code Block' },
  { id: '10.16', category: 'Dropbox Papers', feature: 'Emojis' },
  { id: '10.17', category: 'Dropbox Papers', feature: 'Mentions' },
  { id: '10.18', category: 'Dropbox Papers', feature: 'Comments' },
  { id: '10.19', category: 'Dropbox Papers', feature: 'Versions of Dropbox Papers' },
];

/**
 * The six Paper features the scope document records as NOT migrating, with its own wording.
 *
 * These are the open question the scope and out-of-scope documents both flag: they appear in the
 * IN-scope document, yet the out-of-scope document lists only the in-line comment CSV. Until the
 * combination owner rules, each is reported at INFO carrying the document's wording — neither hiding
 * a defect nor inventing one.
 *
 * Do NOT convert these to failures or to passes without that ruling. The scope document records what
 * guessing cost on the sibling combination: one guessed rule failed 92 ordinary notification emails,
 * another printed "handled as documented" directly above a FAIL for the same thing.
 */
const PAPER_DISPUTED = {
  '10.2': 'Minor differences, such as highlight colours, are not migrated.',
  '10.6': 'GIFs are not properly migrated and appear as unsupported elements in the destination document.',
  '10.14': 'Section breaks are not migrated — no corresponding formatting or separators are present at the destination.',
  '10.15': 'The code block formatting (background, borders, structured layout) is not fully preserved, resulting in plain text representation.',
  '10.17': 'User mentions are not migrated as expected. They appear as plain, editable text at the destination, and the link appears as an invalid link.',
  '10.18': 'Comments are not migrated. The destination item does not contain any of the original comments from the source.',
};

/** Filenames CloudFuze uses for the CSV reports it writes into the destination. */
const CSV_REPORT_PATTERNS = {
  '3.1': /shared[-_ ]?link/i,
  '8.1': /embedded[-_ ]?link/i,
  comments: /comment/i,
};

class DropboxToGoogledriveValidationAgent extends GoogleDriveValidationAgent {
  static supportsDeepValidation = true;

  constructor() {
    super('DropboxToGoogledriveValidationAgent');
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
        + 'required. Without them this validator would silently fall back to SharePoint\'s rules and '
        + 'report false renames and false path-limit relocations.'
      );
    }
    if (!roleMap) {
      throw new Error(
        `validation/roleMaps has no map covering "${COMBINATION}". Refusing to fall back to the `
        + 'SharePoint role table, which has no Dropbox roles in it and would mistranslate every grant.'
      );
    }

    if (!env.ENABLE_DEEP_CONTENT_VALIDATION) {
      gPush('WARN', 'Deep content validation',
        'Disabled by ENABLE_DEEP_CONTENT_VALIDATION=false — nothing was compared');
      return this._buildResult(globalChecks, [], { enabled: false }, context);
    }
    if (!dropboxClient.isConfigured()) {
      gPush('FAIL', 'Source items scanned',
        'Dropbox is not configured (DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN) — '
        + 'the source could not be read, so nothing was validated.');
      return this._buildResult(globalChecks, [], { enabled: true, scannedSourceItems: 0 }, context);
    }

    // ── CloudFuze's own report. Recorded, never trusted as the verdict.
    this._recordCloudFuzeStatus(context, gPush);

    const emailMap = core.buildEmailMap(context);
    const mapEmail = (e, opts) => {
      const key = String(e || '').toLowerCase();
      const hit = emailMap[key];
      if (opts && opts.detail) return { email: hit || key, mapped: Boolean(hit) };
      return hit || key;
    };
    const units = core.resolveUnits(context);
    logger.info(`[${COMBINATION} validation] validating ${units.length} user unit(s)`);

    // ── Destination root (the destination-side agent owns how Google is read).
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
      perUser.push(
        await this._validateUnit({ unit, context, destRoot, rules, roleMap, bands, mapEmail, totals })
      );
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
      combination: COMBINATION,
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
      // Items whose grants CloudFuze had not applied yet when validation ran. Initialised here so
      // the roll-up can compare it against permissionMismatches without an undefined check.
      permissionsPending: 0,
      sharedLinkMismatches: [],
      linkObservations: [],
      conversionMismatches: [],
      timestampDrift: [],
      versionInfo: [],
      notificationLeaks: [],
      csvReports: [],
      paperItems: [],
      specialChars: { total: 0, arrived: 0 },
      longPathEvidence: [],
      featureChecklist: [],
      featureSummary: null,
      itemResults: [],
      summary: '',
    };
  }

  /** Validate one source→destination unit. */
  async _validateUnit({ unit, context, destRoot, rules, roleMap, bands, mapEmail, totals }) {
    const checks = [];
    const push = (status, name, detail) => checks.push({ name, status, detail });
    const sourceEmail = unit.sourceEmail || context.sourceEmail;
    const destEmail = unit.destinationEmail || context.destinationEmail;
    const sourcePath = dropboxClient.dbxPath(unit.sourcePath || context.sourcePath || env.DROPBOX_TEST_ROOT);

    // ── Source: the Dropbox tree.
    const asMemberId = await dropboxClient.resolveTeamMemberId(sourceEmail).catch(() => null);
    if (!asMemberId) {
      push('WARN', 'Source account context',
        `${sourceEmail} did not resolve to a Dropbox team member — reading the token's own Dropbox. `
        + 'On a Business team that is probably the admin account, not the intended source.');
    }
    const dbxOpts = { asMemberId };

    let sourceTree = [];
    try {
      sourceTree = await dropboxClient.buildFolderTree(sourcePath, {
        ...dbxOpts,
        maxDepth: bands.treeDepth || 25,
      });
      // Relativize against the root's DISPLAY path, not the path we asked for.
      //
      // Dropbox is case-insensitive on lookup but returns `path_display` in the tree, so asking for
      // "/qa-automation" (which is what the seeding agent reports, deliberately lower-cased) yields
      // items at "/QA-Automation/…". core.relativize strips a case-SENSITIVE prefix, so it stripped
      // nothing: every source path kept its "/QA-Automation" prefix while the destination tree was
      // relative to the migrated root, and the comparison read
      //   source 67, dest 68, matched 0, missing 0, extra 1, misplaced 67
      // on a migration where all 67 items had in fact arrived. Everything keyed on item paths went
      // with it — permissions reported "no comparable source permissions" against grants that were
      // demonstrably present, and the long-path check reported "0 encoded chars".
      //
      // Fixed here rather than in core.relativize: that helper is shared by every content
      // combination, and a case-insensitive strip there would change Box→SharePoint and
      // Drive→SharePoint behaviour too. Dropbox is the only source whose reported path case can
      // differ from its tree.
      const rootMeta = await dropboxClient.getMetadata(sourcePath, dbxOpts).catch(() => null);
      const rootPath = (rootMeta && rootMeta.path) || sourcePath;
      if (rootPath !== sourcePath) {
        logger.info(`[dropbox_to_googledrive validation] source root "${sourcePath}" has display `
          + `path "${rootPath}" — relativizing against the display form`);
      }
      // Keep each item's ABSOLUTE Dropbox path before relativizing.
      //
      // Relativizing rewrites `path` to "/01-Root-Folder-Permissions", which is what the tree
      // comparison needs — but the per-item source lookups (listItemMembers, listSharedLinks) hand
      // that same string back to Dropbox, where it does not exist. Both calls end `.catch(() => [])`,
      // so the failure surfaced as "No comparable source permissions were found" and "No source
      // shared links were found" against a source that demonstrably had 9 grants and 2 links.
      //
      // relativize spreads the item (`{ ...i, path }`), so this field survives it.
      for (const item of sourceTree) item.dbxPath = item.path;
      sourceTree = core.relativize(sourceTree, rootPath);
    } catch (err) {
      push('FAIL', 'Source items scanned', `Could not read Dropbox ${sourcePath}: ${err.message}`);
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }

    if (sourceTree.length === 0) {
      push('FAIL', 'Source items scanned',
        `No source items were read from Dropbox ${sourcePath}. Check the path and the app's scopes.`);
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }
    totals.scannedSourceItems += sourceTree.length;
    push('PASS', 'Source items scanned', `${sourceTree.length} item(s) read from Dropbox ${sourcePath}`);

    // ── Destination: where it landed, and its tree.
    const sourceFolderName = core.lastSegment(sourcePath);
    const migrated = await this.findMigratedRoot(
      destRoot.rootId, destRoot.driveId, unit.destinationPath, sourceFolderName, destEmail
    );
    if (!migrated) {
      push('FAIL', 'Destination location',
        `Nothing named "${sourceFolderName}" (or a dedup variant) exists under ${destRoot.label} — `
        + 'the migration appears to have created nothing.');
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }
    push('PASS', 'Destination location', `Migrated content found at ${migrated.path} in ${destRoot.label}`);

    const destTree = await this.readTree(migrated.id, destEmail, {
      driveId: destRoot.driveId,
      maxDepth: bands.treeDepth || 25,
    });

    // ── Feature 1.1 + 7.1: structure, with GOOGLE's rules.
    const cmp = core.compareTrees(sourceTree, destTree, {
      rules,
      pathLimit: bands.pathLengthLimit ?? rules.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit ?? rules.segmentLengthLimit,
    });

    totals.pairedCount += cmp.matchedCount;
    totals.missing.push(...cmp.missing.map((i) => ({ path: i.path, type: i.type, name: i.name })));
    // CloudFuze's own CSV reports are filtered out below before the 1.1 verdict; keep them out of
    // the run totals too, or the failure index and the check detail disagree about the same run.
    totals.extra.push(...cmp.extra
      .filter((i) => !(/\.csv$/i.test(String(i.name || i.path || ''))
        && Object.values(CSV_REPORT_PATTERNS).some((re) => re.test(String(i.name || i.path || '')))))
      .map((i) => ({ path: i.path, type: i.type, name: i.name })));
    totals.misplaced.push(...(cmp.misplaced || []));
    totals.placeholderLinks.push(...(cmp.placeholderLinks || []));
    totals.notMigratable.push(...(cmp.notMigratable || []));

    // CloudFuze's own CSV reports are not "extra" content.
    //
    // The migration writes its Shared Links and Embedded Links CSVs into the destination root.
    // Features 3.1 and 8.1 read those files as PROOF the feature worked — 8.1 passes on
    // "Erik E-EmbeddedLinks.csv present" — while the structure comparison counted the very same
    // files as unexpected items and failed 1.1 on them. A run where all 67 items arrived
    // correctly read "extra 2 … FAIL", and 1.2 inherited it. One report cannot call the same file
    // evidence of success and evidence of failure.
    //
    // Matched by the same patterns the CSV check uses, so the two can never disagree about what
    // counts as a CloudFuze report. Anything else extra at the destination is still a finding.
    const isCloudFuzeReport = (name) => {
      const n = String(name || '');
      if (!/\.csv$/i.test(n)) return false;
      return Object.values(CSV_REPORT_PATTERNS).some((re) => re.test(n));
    };
    const unexpectedExtra = (cmp.extra || []).filter((i) => !isCloudFuzeReport(i.name || i.path));
    const reportExtras = (cmp.extra || []).length - unexpectedExtra.length;

    const structureDetail =
      `source ${cmp.totalSource}, dest ${cmp.totalDest}, matched ${cmp.matchedCount}, `
      + `missing ${cmp.missing.length}, extra ${unexpectedExtra.length}, `
      + `misplaced ${(cmp.misplaced || []).length}`
      + (reportExtras > 0 ? ` (+${reportExtras} CloudFuze CSV report(s), not counted)` : '');

    // Re-derive the verdict from what is actually wrong, rather than reusing cmp.status, which
    // was computed before the reports were excluded.
    const structureOk = cmp.missing.length === 0
      && unexpectedExtra.length === 0
      && (cmp.misplaced || []).length === 0;
    push(structureOk ? 'PASS' : 'FAIL', '1.1 Data Migration (structure)', structureDetail);

    // ── Per-item Tier C: permissions, links, timestamps, versions; Tier B hashes.
    const itemDetails = [];
    const paired = [...cmp.matched.entries()];

    // `cmp.matched` maps source path → { source, dest }, NOT → the destination item.
    //
    // This loop read the value as the destination item itself, so `destItem.id` and `destItem.name`
    // were undefined for every pair. Once the relativize fix made items actually pair, that turned
    // into "67 of 67 paired item(s) carried no destination id" and every per-item check — Tier B
    // hashes, permissions, versions, timestamps — was skipped on content that had migrated fine.
    // Before the relativize fix nothing paired, so the mistake was unreachable and invisible.
    //
    // deepContentCore.js:452 sets the shape, and the sibling combination reads it correctly as
    // `for (const { source, dest } of cmp.matched.values())` — matched here rather than changing the
    // shared helper.
    for (const [srcPath, pair] of paired) {
      const destItem = pair && pair.dest;
      const srcItem = (pair && pair.source) || sourceTree.find((s) => s.path === srcPath);
      if (!srcItem || !destItem) continue;
      const row = await this._validateItem({
        srcItem, destItem, destEmail, dbxOpts, roleMap, bands, mapEmail, totals,
      });
      itemDetails.push(row);
    }

    // Items that could not be inspected are reported, not dropped. Without this the run would show
    // a clean per-item table whose rows were never actually examined — the same vacuous pass the
    // "Match" cards used to give on zero comparisons.
    if (totals.uninspectable) {
      push('WARN', 'Items inspected',
        `${totals.uninspectable} of ${paired.length} paired item(s) carried no destination id, so `
        + 'their permissions, versions and content hashes were NOT checked. They are present at the '
        + 'destination but unverified — do not read them as passing.');
    }

    this._rollUpItemChecks(push, totals, itemDetails);
    this._checkSpecialCharacters(push, sourceTree, cmp, rules, totals);
    this._checkLongPaths(push, sourceTree, cmp, rules, totals);
    await this._checkCsvReports(push, migrated, destEmail, destRoot, totals);
    this._checkPaper(push, sourceTree, cmp, totals);
    this._checkNotificationSuppression(push, totals);

    // The per-user shape the report renderers actually read.
    //
    // pdfGenerator draws "Per-item validation" from `u.items` and "Folder structure validation"
    // from `u.folderStructure`, and ResultsView.jsx reads those same two fields for its Source
    // Items / Found / Folders Compared cards. This unit returned `itemDetails` and no
    // folderStructure, so BOTH report surfaces silently dropped everything: the PDF had no
    // per-item section and no tree diagram, and the UI showed 0 / 0 / 0 / 0 beside a run that had
    // verified 67 items. The sibling combination supplies all of these (see its finishUnit), which
    // is the whole reason its report reads end-to-end and this one looked empty.
    //
    // `mapping` and `status` are the same story in miniature: without them the PDF header printed
    // "User 1 undefined ·" with "—" for both locations.
    const folderStructure = core.compareFolders(sourceTree, destTree, {
      rules,
      pathLimit: bands.pathLengthLimit ?? rules.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit ?? rules.segmentLengthLimit,
      sourceRootName: core.lastSegment(sourcePath) || '(root)',
      destRootName: migrated.name || '(root)',
      sourceLabel: 'Dropbox',
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
        sourceLocation: sourcePath,
        destEmail,
        destLocation: `${unit.destinationPath || '/'}`
          + (migrated.path && migrated.path !== '/' ? ` → ${migrated.path}` : ''),
      },
      status: failed > 0 ? 'FAIL' : 'PASS',
      summary: `${passed}/${checks.length} checks passed`,
      checks,
      folderStructure,
      // Both names: `items` is what the PDF and the UI read, `itemDetails` is what this file's own
      // roll-up helpers already consume. Keeping one and renaming the other would break whichever
      // reader was not updated.
      items: itemDetails,
      itemDetails,
    };
  }

  /** Tier C + Tier B for one paired item. */
  async _validateItem({ srcItem, destItem, destEmail, dbxOpts, roleMap, bands, mapEmail, totals }) {
    const row = {
      path: srcItem.path,
      name: srcItem.name,
      type: srcItem.type,
      found: true,
      destName: destItem.name,
      isPaper: Boolean(srcItem.isPaper),
    };

    // A paired destination item with no id cannot be inspected, and asking anyway is expensive and
    // silent-by-default: every Drive call rejects with "Missing required parameters: fileId", which
    // retry.js treats as retryable and re-attempts four times with 1+2+4+8s backoff. Two such calls
    // per item is ~30s of guaranteed-doomed waiting each, on an error that can never succeed on a
    // retry. This only became reachable once the relativize fix made items pair at all, so it was
    // latent rather than new.
    //
    // Counted and surfaced, never swallowed: an item we could not inspect is not an item that
    // passed, and this validator's whole purpose is refusing to report unexamined data as good.
    if (!destItem.id) {
      row.inspectionSkipped = 'destination item carries no id, so it could not be inspected';
      totals.uninspectable = (totals.uninspectable || 0) + 1;
      logger.warn(`[dropbox_to_googledrive validation] "${srcItem.path}" paired with a destination `
        + 'item that has no id — skipping its permission, version and hash checks rather than '
        + 'issuing calls that cannot succeed');
      return row;
    }

    // Paper is converted to a Google Doc: its bytes, size, timestamps and version history are all
    // products of the conversion, so none of them can be compared. Recorded and skipped.
    if (srcItem.isPaper) {
      totals.paperItems.push({ path: srcItem.path, destPath: destItem.path, destName: destItem.name });
      row.note = 'Dropbox Paper — converted to a Google Doc; bytes, size, timestamps and version '
        + 'history are conversion products and are not comparable (scope 10.1, 10.19)';
      return row;
    }

    // ── 2.x permissions and 3.x links.
    //
    // `dbxPath` is the item's absolute Dropbox path, stamped before the tree was relativized.
    // Passing the relativized `path` here looked up a path that does not exist, and the swallowing
    // catch turned that into "no source permissions" rather than an error.
    const srcRef = { ...srcItem, path: srcItem.dbxPath || srcItem.path };
    let destPerms;
    let srcMembers;
    [srcMembers, destPerms] = await Promise.all([
      dropboxClient.listItemMembers(srcRef, dbxOpts).catch((err) => {
        // Logged, not silent: an unreadable source is not the same as an unshared one, and
        // treating it as "none" is how a permission gap becomes an invisible pass.
        logger.warn(`[dropbox_to_googledrive validation] could not read source members for `
          + `"${srcRef.path}": ${err.message}`);
        return [];
      }),
      this.readPermissions(destItem.id, destEmail),
    ]);

    // Wait for CloudFuze to finish applying permissions before calling a grant missing.
    //
    // CloudFuze copies the items first and applies sharing AFTER, so a validator that starts the
    // moment the job reports PROCESSED races that phase. Measured on run dbx-gsd-1788417784387:
    // 01-Root-Folder-Permissions and its four descendants all reported destRoles=[] and "5 of 6
    // grant(s) differ", while a direct read ~25 minutes later showed every grant present and
    // correct (ben:fileorganizer, qa_automation:reader, plus the inherited copies on the
    // children). The item at the root, 02-root-file-viewer.txt, matched in the same run because
    // its grant had already landed — which is why this failure came and went between runs and
    // looked like a real defect twice.
    //
    // Retry only in the one situation that is suspicious: the SOURCE has comparable grants and
    // the destination reports none at all. A destination with some grants, or a source with none,
    // is answered immediately, so the happy path is not slowed.
    // NOTE ON ORDER: the settle-retry sits AFTER sourcePerms is built, because it needs to know
    // whether the source had any comparable grants at all. Placing it above the declaration threw
    // a temporal-dead-zone ReferenceError at run time that `node --check` cannot see.
    const sourcePerms = srcMembers
      .filter((m) => roleMap.isComparableDriveRole(m.role))
      .map((m) => ({
        email: m.email,
        role: m.role,
        type: m.type,
        displayName: m.displayName,
      }));

    // Has CloudFuze applied the item-level grants yet?
    //
    // The first version of this asked "does the destination have ZERO grants" — and never fired,
    // because a Shared Drive item ALWAYS carries the drive's own grant by inheritance
    // (erik:organizer, inherited: true). So the list was never empty even when none of the expected
    // grants had arrived.
    //
    // The right question is whether any DIRECT (non-inherited) grant exists. CloudFuze re-grants
    // per item, so a migrated item that has been processed carries at least one direct grant; one
    // that has not carries only inherited ones.
    const directGrants = (perms) => (perms.permissions || []).filter((x) => !x.inherited);

    if (sourcePerms.length > 0 && directGrants(destPerms).length === 0) {
      for (let attempt = 1; attempt <= PERMISSION_SETTLE_ATTEMPTS; attempt += 1) {
        await new Promise((r) => setTimeout(r, PERMISSION_SETTLE_MS));
        const retry = await this.readPermissions(destItem.id, destEmail);
        if (directGrants(retry).length > 0) {
          logger.info(`[dropbox_to_googledrive validation] "${srcItem.path}" had no direct `
            + `destination grants on the first read; ${directGrants(retry).length} appeared after `
            + `${attempt * (PERMISSION_SETTLE_MS / 1000)}s — CloudFuze was still applying sharing`);
          destPerms = retry;
          break;
        }
      }
    }

    // Still nothing item-specific: the sharing phase has not run for this item YET.
    //
    // Measured across three runs: the grants appear tens of MINUTES after the job reports
    // PROCESSED, not seconds. Run dbx-gsd-1788417784387 reported "5 of 6 grant(s) differ" and a
    // direct read ~25 minutes later showed every grant present and correct; run
    // dbx-gsd-1788421910278 failed the same way and a read 5 minutes later still showed only the
    // inherited drive grant. No inline wait can cover that.
    //
    // So this is marked NOT YET JUDGEABLE rather than failed. A validator that reports a defect
    // because it measured too early is worse than one that says "I could not tell yet": it filed
    // four Neutara tickets (QT-63, QT-67, CF-30684, CF-30695) against permissions that were
    // correct. The roll-up turns this into a WARN naming the re-validation step.
    if (sourcePerms.length > 0 && directGrants(destPerms).length === 0) {
      row.permissionsNotYetApplied = true;
      totals.permissionsPending = (totals.permissionsPending || 0) + 1;
      logger.warn(`[dropbox_to_googledrive validation] "${srcItem.path}" still carries only `
        + `inherited drive grants after ${PERMISSION_SETTLE_ATTEMPTS * (PERMISSION_SETTLE_MS / 1000)}s `
        + '— CloudFuze has not applied item sharing yet. Reported as pending, NOT as a difference.');
    }

    for (const m of srcMembers.filter((x) => !roleMap.isComparableDriveRole(x.role))) {
      totals.notComparable.push({
        path: srcItem.path,
        principal: m.email || m.displayName,
        role: m.role,
        reason: roleMap.nonComparableReason(m.role),
      });
    }

    if (sourcePerms.length > 0) {
      // Pass the DROPBOX role map. deepContentCore otherwise falls back to the Box/Drive to
      // SharePoint tables, which classify Dropbox's 'editor' and 'viewer' as not-comparable and
      // skip every grant — which is exactly what produced "No comparable source permissions were
      // found" on a tree with 9 of them.
      const permCmp = core.comparePermissions(sourcePerms, destPerms.permissions, mapEmail,
        { roleMap });

      // `row.permissions` must be the per-grant ARRAY the report renders, not the comparison
      // object.
      //
      // pdfGenerator does `for (const p of (it.permissions || []))`, so handing it the
      // comparePermissions result — { checked, matches, mismatches, … } — threw
      //   "object is not iterable (cannot read property Symbol(Symbol.iterator))"
      // and the whole PDF endpoint answered HTTP 500 ("Failed to download PDF"). It only
      // surfaced once `items` started being rendered at all; before that this section was
      // skipped and the bad shape sat there unnoticed.
      //
      // Field names match what the renderer reads: user, mappedTo, principalType, sourceRole,
      // destRoles, viaGroup, match. The comparison object is kept under its own key for the
      // roll-up helpers.
      row.permissionComparison = permCmp;
      row.permissions = [
        ...(permCmp.matches || []).map((m) => ({ ...m, match: true })),
        ...(permCmp.mismatches || []).map((m) => ({ ...m, match: false })),
        ...(permCmp.escalations || []).map((m) => ({ ...m, match: false })),
        ...(permCmp.viaGroup || []).map((m) => ({ ...m, match: true, viaGroup: true })),
      ];
      row.sourceLabel = 'Dropbox';
      totals.permissionObservations.push({
        path: srcItem.path,
        type: srcItem.type,
        checked: permCmp.checked,
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
        totals.permissionMismatches.push({
          path: srcItem.path, ...e, escalation: true,
        });
      }
    }

    // ── 3.1 / 3.2 shared links.
    const srcLinks = await dropboxClient.listSharedLinks(srcRef.path, dbxOpts).catch((err) => {
      logger.warn(`[dropbox_to_googledrive validation] could not read source links for `
        + `"${srcRef.path}": ${err.message}`);
      return [];
    });
    if (srcLinks.length > 0) {
      for (const link of srcLinks) {
        const linkCmp = roleMap.compareSharedLink(link, destPerms.links);
        totals.linkObservations.push({
          path: srcItem.path,
          type: srcItem.type,
          sourceAudience: link.type,
          sourceRole: link.role,
          expectedScope: linkCmp.expectedScope,
          expectedType: linkCmp.expectedType,
          match: linkCmp.match,
          actual: linkCmp.actual,
        });
        if (!linkCmp.match) {
          totals.sharedLinkMismatches.push({
            path: srcItem.path,
            expected: `${linkCmp.expectedScope}/${linkCmp.expectedType}`,
            actual: linkCmp.actual.join(', ') || '(no link permission at the destination)',
          });
        }
      }
      // Per-link ARRAY, not a counts object.
      //
      // pdfGenerator does `for (const l of (it.sharedLinks || []))` and reads sourceType /
      // sourceRole / actual / match off each entry. A { source, dest } summary is not iterable, so
      // it threw the same "object is not iterable" that the permissions field did and took the
      // whole PDF down with a 500. Counts kept alongside for the roll-up.
      row.sharedLinkCounts = { source: srcLinks.length, dest: destPerms.links.length };
      row.sharedLinks = srcLinks.map((link) => {
        const cmp = roleMap.compareSharedLink(link, destPerms.links);
        return {
          sourceType: link.type,
          sourceRole: link.role,
          actual: (cmp.actual || []).join(", ") || "(none)",
          match: cmp.match,
        };
      });
    }

    if (srcItem.type === 'folder') return row;

    // ── 4.1 metadata. Only the MODIFIED half is comparable: Dropbox exposes no creation time, so
    // there is no source created-date. Reporting that as a mismatch would invent a defect.
    const tsCmp = core.compareTimestamps(
      { createdAt: null, modifiedAt: srcItem.modifiedAt },
      { createdAt: null, modifiedAt: destItem.modifiedAt },
      bands.timestampDriftMs
    );
    row.timestamps = { ...tsCmp, createdComparable: false };
    if (tsCmp && tsCmp.drifted) {
      totals.timestampDrift.push({
        path: srcItem.path,
        source: srcItem.modifiedAt,
        dest: destItem.modifiedAt,
        field: 'modifiedAt',
      });
    }

    // ── 9.1 / 9.2 versions. Informational: the expected destination count is a JOB SETTING
    // (scope 9.2), so a count alone cannot be judged without knowing what the job requested.
    const [srcRevs, destVersions] = await Promise.all([
      // Absolute path, like the permission and link reads above. Using the relativized
      // srcItem.path meant Dropbox never found the file, srcRevs was always empty, versionInfo
      // stayed empty and features 9.1/9.2 fell to "Not exercised by this run" on a source that
      // had 6 version uploads seeded.
      dropboxClient.listRevisions(srcRef.path, dbxOpts).catch((err) => {
        logger.warn(`[dropbox_to_googledrive validation] could not read revisions for `
          + `"${srcRef.path}": ${err.message}`);
        return [];
      }),
      this.readVersionCount(destItem.id, destEmail),
    ]);
    if (srcRevs.length > 1 || destVersions > 1) {
      totals.versionInfo.push({
        path: srcItem.path,
        sourceVersions: srcRevs.length,
        destVersions,
        note: 'Informational — scope 9.2 makes the expected destination count a job setting '
          + '(all versions, or the last N), so the counts cannot be judged equal or unequal here.',
      });
      row.versions = { source: srcRevs.length, dest: destVersions };
    }

    // ── Size, banded by whether the destination was converted.
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
    const permChecked = totals.permissionObservations.reduce((n, o) => n + o.checked, 0);
    if (permChecked === 0) {
      push('WARN', '2.x Permissions',
        'No comparable source permissions were found, so permissions were not validated. Seed grants '
        + 'with DROPBOX_TEST_INTERNAL_USER / DROPBOX_TEST_GROUP / DROPBOX_TEST_EXTERNAL_USER.');
    } else if (totals.permissionMismatches.length === 0) {
      push('PASS', '2.x Permissions', `${permChecked} grant(s) compared, all matched`);
    } else if (totals.permissionsPending > 0
      && totals.permissionsPending >= totals.permissionMismatches.length) {
      // Every difference sits on an item CloudFuze had not finished sharing. Not judgeable yet —
      // and specifically NOT a failure.
      //
      // This is the "report NOT RUN, never as passed" rule applied to its mirror image: a result
      // that is not yet knowable must not be reported as a defect either. Reporting it as FAIL
      // filed four Neutara tickets against permissions that a later read showed were correct.
      push('WARN', '2.x Permissions',
        `Not judgeable yet: ${totals.permissionsPending} item(s) still carried only inherited drive `
        + 'grants when validation ran. CloudFuze applies item sharing AFTER the copy completes, and '
        + 'measurements put that tens of minutes behind the PROCESSED status — so this run measured '
        + 'too early rather than finding a defect. Re-validate this execution once the job has '
        + 'settled to get a real verdict on 2.1-2.5.');
    } else {
      const esc = totals.permissionMismatches.filter((m) => m.escalation).length;
      const pending = totals.permissionsPending > 0
        ? ` (${totals.permissionsPending} more item(s) not yet shared by CloudFuze — not counted)` : '';
      push('FAIL', '2.x Permissions',
        `${totals.permissionMismatches.length} of ${permChecked} grant(s) differ`
        + (esc > 0 ? ` (${esc} privilege escalation(s))` : '') + pending);
    }

    if (totals.linkObservations.length === 0) {
      push('WARN', '3.x Shared Links', 'No source shared links were found, so links were not validated');
    } else if (totals.sharedLinkMismatches.length === 0) {
      push('PASS', '3.x Shared Links', `${totals.linkObservations.length} link(s) compared, all matched`);
    } else {
      push('FAIL', '3.x Shared Links',
        `${totals.sharedLinkMismatches.length} of ${totals.linkObservations.length} link(s) differ`);
    }

    const tsCompared = itemDetails.filter((r) => r.timestamps).length;
    if (tsCompared === 0) {
      push('WARN', '4.1 Metadata', 'No files were available to compare timestamps on');
    } else if (totals.timestampDrift.length === 0) {
      push('PASS', '4.1 Metadata',
        `Modified timestamps preserved on ${tsCompared} file(s). Created dates NOT compared — `
        + 'Dropbox exposes no creation time, so there is no source value.');
    } else {
      push('FAIL', '4.1 Metadata',
        `${totals.timestampDrift.length} of ${tsCompared} file(s) drifted beyond the tolerance`);
    }

    // 9.1 Version History — a real verdict, not an unjudged note.
    //
    // 9.1 asks whether history ARRIVED, which is answerable: a file that had multiple revisions
    // in Dropbox should have more than one version at the destination. That is independent of
    // 9.2, which asks whether the COUNT matches what the job requested — and the job sends
    // versioning=true (all versions), while Google merges revisions on its side, so exact counts
    // legitimately differ. Conflating the two is why both features read N/A while 6 seeded
    // version uploads sat in the source unexamined.
    if (totals.versionInfo.length > 0) {
      const versioned = totals.versionInfo.filter((v) => v.sourceVersions > 1);
      const lostHistory = versioned.filter((v) => v.destVersions <= 1);

      if (versioned.length === 0) {
        push('WARN', '9.1 Version History',
          `${totals.versionInfo.length} file(s) reported version data but none had more than one `
          + 'source revision, so there was no history to preserve. Seed multiple uploads of the '
          + 'same file to exercise this.');
      } else if (lostHistory.length === 0) {
        push('PASS', '9.1 Version History',
          `${versioned.length} file(s) had multiple Dropbox revisions and all of them arrived with `
          + 'version history at the destination. Exact counts are NOT compared — Google merges '
          + `revisions, so a lower number is expected behaviour (e.g. `
          + `${versioned.map((v) => `${core.lastSegment(v.path)} ${v.sourceVersions}→${v.destVersions}`).slice(0, 4).join(
)}).`);
      } else {
        push('FAIL', '9.1 Version History',
          `${lostHistory.length} of ${versioned.length} versioned file(s) arrived with no history at `
          + `all: ${lostHistory.map((v) => `${v.path} (${v.sourceVersions}→${v.destVersions})`).slice(0, 5).join(' | ')}`);
      }

      // 9.2 Selective Versions — judged against what the job actually requested.
      //
      // The job options send versioning=true, i.e. ALL versions. So the expectation is history
      // present on every versioned file, which is what 9.1 measured. A selective-count run (last
      // N) would need the job to request it; until a run does, say so rather than scoring it.
      push('INFO', '9.2 Selective Versions',
        `This run requested ALL versions (job option versioning=true), not a selective count, so `
        + 'there is no N to verify. ' + `${versioned.length} versioned file(s) were checked for `
        + 'history presence under 9.1. To exercise 9.2, run with a selective version count set on '
        + 'the job and re-check.');
    }
  }

  /**
   * Feature 5.1 — special characters, as a NEGATIVE test.
   *
   * On a Google destination the expected outcome is no replacement at all. So this asserts the names
   * arrived UNCHANGED; a sanitized name here is the defect, which is the reverse of the SharePoint
   * combinations.
   */
  _checkSpecialCharacters(push, sourceTree, cmp, rules, totals) {
    // The interesting population is names carrying SPECIAL CHARACTERS — not specifically the ones
    // SharePoint rejects.
    //
    // This filtered on SharePoint's needsSanitizing(), which accepts ~ ! @ # $ % ^ & ( ) + [ ] { } ;
    // — every character in the seeded name "Special ~!@#$%^&()_+[]{};,.= chars". So `risky` was
    // always empty, the check reported "no source names … would rewrite", and feature 5.1 sat at
    // N/A on every run while a purpose-built special-character folder existed in the source.
    //
    // The scope document names the population directly: its own figure shows `!@#$%^&*()_+[]{};:,.<>?`
    // arriving UNCHANGED at Google, and states the expected outcome for this combination is no
    // replacement at all. So the test is: names with special characters must survive intact.
    // Ordinary . _ - and spaces are excluded — every filename has a dot, and matching on that
    // would make the whole tree "risky" and the check meaningless.
    const SPECIAL_CHARS = /[!@#$%^&*()+[\]{};:<>?~"|=]/;
    const risky = sourceTree.filter((i) => SPECIAL_CHARS.test(String(i.name || '')));
    totals.specialChars.total += risky.length;

    if (risky.length === 0) {
      push('WARN', '5.1 Special Characters Replacement',
        'No source name carried a special character, so the feature was not exercised. Seed a name '
        + 'containing characters such as ! @ # $ % ^ & ( ) [ ] { } ; = to cover it.');
      return;
    }

    const renamed = [];
    let arrived = 0;
    for (const item of risky) {
      // cmp.matched holds { source, dest } pairs, not destination items. Reading .name straight off
      // the pair gave undefined, so every special-character name looked "altered at the
      // destination" and 5.1 failed with: "Special ~!@#$%^&()_+[]{};,.= chars" → "undefined".
      const dest = (cmp.matched.get(item.path) || {}).dest;
      if (!dest) continue;
      arrived += 1;
      if (core.normKey(dest.name) !== core.normKey(item.name)) {
        renamed.push({ source: item.name, dest: dest.name, path: item.path });
      }
    }
    totals.specialChars.arrived += arrived;

    if (renamed.length === 0) {
      push('PASS', '5.1 Special Characters Replacement',
        `${arrived} name(s) with special characters arrived UNCHANGED, which is the documented `
        + 'outcome for a Google destination — Google accepts characters SharePoint rejects.');
    } else {
      push('FAIL', '5.1 Special Characters Replacement',
        `${renamed.length} name(s) were altered at the destination, but Google accepts these `
        + `characters and no replacement was expected: `
        + renamed.slice(0, 5).map((r) => `"${r.source}" → "${r.dest}"`).join(', '));
    }
  }

  /**
   * Feature 7.1 — long paths.
   *
   * The condition ("if the destination cloud has a long folder path limitation") is not met on
   * Google, so intact deep data is the expected outcome and no placeholder link should exist.
   *
   * This deliberately reports EVIDENCE rather than asserting a limit, because the test-data document
   * records an unresolved contradiction: 144 QA cases exercise a "breaking point" while
   * destinations/googledrive.js declares no limit. The longest path that arrived, and the longest
   * that did not, are exactly the two numbers needed to settle it.
   */
  _checkLongPaths(push, sourceTree, cmp, rules, totals) {
    const byLength = [...sourceTree].sort((a, b) => b.path.length - a.path.length);
    const longest = byLength[0];
    if (!longest) return;

    // Nothing arrived at all: this feature cannot be judged, and guessing is worse than saying so.
    //
    // The inference below compares the longest path that ARRIVED against the shortest that did
    // NOT, which is only meaningful when the migration actually delivered something. Run
    // ade2a3d0 moved 0 items (CloudFuze returned CONFLICT / "Migration not Allowed for wrong CSV
    // paths"), so every source item was "missing" — and the check concluded
    //   "Items up to 0 encoded chars arrived, and the shortest MISSING item is 12 chars. That
    //    pattern suggests a real path limit"
    // i.e. it read a 12-character path as evidence of a length limit, and contradicted
    // destinations/googledrive.js on the strength of a migration that never ran. A failed
    // migration must not be able to manufacture a platform finding.
    if (cmp.matchedCount === 0) {
      push('WARN', '7.1 Long-File/folder path',
        `Not judgeable: the migration delivered no items (${(cmp.missing || []).length} of `
        + `${cmp.totalSource} source items missing), so there is no arrived-vs-missing length `
        + 'comparison to make. Re-run once the migration completes — the open question in '
        + 'dropbox-to-google-testdata.md needs a run that actually moved data.');
      return;
    }

    const arrivedLengths = sourceTree
      .filter((i) => cmp.matched.has(i.path))
      .map((i) => core.encodedPathLength(i.path));
    const missingLengths = (cmp.missing || []).map((i) => core.encodedPathLength(i.path));

    const maxArrived = arrivedLengths.length ? Math.max(...arrivedLengths) : 0;
    const minMissing = missingLengths.length ? Math.min(...missingLengths) : null;

    totals.longPathEvidence.push({
      longestSourcePath: longest.path,
      longestSourcePathEncodedLength: core.encodedPathLength(longest.path),
      longestArrivedEncodedLength: maxArrived,
      shortestMissingEncodedLength: minMissing,
      declaredLimit: rules.pathLengthLimit === Infinity ? 'none (Infinity)' : rules.pathLengthLimit,
    });

    if (minMissing == null) {
      push('PASS', '7.1 Long-File/folder path',
        `Every item arrived, including the longest source path (${maxArrived} encoded chars). Google `
        + 'declares no path limit, so intact deep data is the documented outcome and no placeholder '
        + 'link was expected.');
    } else if (minMissing > maxArrived) {
      // Everything short arrived and everything long did not — that is the signature of a real limit.
      push('FAIL', '7.1 Long-File/folder path',
        `Items up to ${maxArrived} encoded chars arrived, and the shortest MISSING item is `
        + `${minMissing} chars. That pattern suggests a real path limit between the two, which `
        + 'contradicts the declared "no limit" in validation/destinations/googledrive.js — the open '
        + 'question in dropbox-to-google-testdata.md. Confirm before treating either as settled.');
    } else {
      push('FAIL', '7.1 Long-File/folder path',
        `${missingLengths.length} item(s) are missing but their lengths overlap items that arrived `
        + `(longest arrived ${maxArrived}, shortest missing ${minMissing}), so path length does not `
        + 'explain the absence — see the structure check.');
    }
  }

  /**
   * Features 3.1 / 3.2 / 8.1 — the CSV reports CloudFuze writes into the destination.
   *
   * These are ordinary files. There is no special API for them, which is worth restating: two
   * features on the sibling combination were marked "not automated — no API for the CSV" for months
   * while the files sat in the destination the whole time.
   */
  async _checkCsvReports(push, migrated, destEmail, destRoot, totals) {
    const children = await this.listChildren(migrated.id, destEmail, destRoot.driveId);

    // Match only CSV FILES, never folders.
    //
    // The patterns are substring matches, and the seeded tree contains folders named
    // "04-Shared-Links" and "09-Embedded-Links" that match them exactly as well as the real reports
    // do. `.find()` returned whichever came first in the listing — the folder — so both features
    // reported PASS on a directory, "present with 0 row(s)", while "Erik E shared links.csv" sat
    // beside it unread. Two documented features passing on the wrong evidence is worse than either
    // failing honestly.
    const csvFiles = (children || []).filter((c) => {
      // FOLDER_MIME comes off the parent agent's exports — it is not a local binding here, and
      // referencing it bare passed `node --check` while being a ReferenceError at run time.
      const isFolder = String(c.mimeType || '') === GoogleDriveValidationAgent.FOLDER_MIME
        || c.type === 'folder';
      return !isFolder && /\.csv$/i.test(String(c.name || ''));
    });

    const found = {};
    for (const [feature, pattern] of Object.entries(CSV_REPORT_PATTERNS)) {
      const hit = csvFiles.find((c) => pattern.test(String(c.name || '')));
      if (hit) {
        const lines = await this.readTextLines({ id: hit.id, mimeType: hit.mimeType }, destEmail);
        found[feature] = { name: hit.name, rows: Math.max(0, lines.length - 1) };
        totals.csvReports.push({ feature, name: hit.name, rows: Math.max(0, lines.length - 1) });
      }
    }

    if (found['3.1']) {
      push('PASS', '3.x Shared Link CSV', `"${found['3.1'].name}" present with ${found['3.1'].rows} row(s)`);
    } else {
      push('WARN', '3.x Shared Link CSV',
        'No shared-link CSV found in the destination root. Scope 3.1/3.2 say CloudFuze writes one, '
        + 'so either none was produced or it landed elsewhere.');
    }
    if (found['8.1']) {
      push('PASS', '8.1 Embedded Links CSV', `"${found['8.1'].name}" present with ${found['8.1'].rows} row(s)`);
    } else {
      push('WARN', '8.1 Embedded Links CSV',
        'No embedded-links CSV found in the destination root. Scope 8.1 says one is generated; '
        + 'without it the URL transformation cannot be confirmed from the destination alone.');
    }
    if (found.comments) {
      push('PASS', 'In-line comments CSV (out of scope)',
        `"${found.comments.name}" present with ${found.comments.rows} row(s) — the documented outcome: `
        + 'comments arrive as a CSV, not as comments on the item.');
    }
  }

  /**
   * Scope §10 — Dropbox Paper. Nineteen features, reported and not judged.
   *
   * What CAN be asserted automatically is narrow: that each source Paper produced a destination item,
   * and that it is a Google Doc. Everything inside the document — formatting, tables, mentions,
   * comments — needs the document opened, which no API comparison here does.
   *
   * The six features the scope document records as NOT migrating are surfaced at INFO with the
   * document's own wording, because whether each is an accepted limitation or an open defect is the
   * unresolved question both scope files flag. This is the honest position: it neither hides a defect
   * nor invents one.
   */
  _checkPaper(push, sourceTree, cmp, totals) {
    const papers = sourceTree.filter((i) => i.isPaper);
    if (papers.length === 0) {
      push('WARN', '10.x Dropbox Papers',
        'No Dropbox Paper documents in the source, so 19 of the 36 in-scope features were not '
        + 'exercised. Paper cannot be seeded by API — see the manual steps in DropboxTestDataAgent.');
      return;
    }

    const arrived = papers.filter((p) => cmp.matched.has(p.path));
    const missing = papers.filter((p) => !cmp.matched.has(p.path));

    if (missing.length === 0) {
      push('PASS', '10.1 Dropbox Papers Migration',
        `${arrived.length} Paper document(s) produced a destination item`);
    } else {
      push('FAIL', '10.1 Dropbox Papers Migration',
        `${missing.length} of ${papers.length} Paper document(s) have no destination item: `
        + missing.slice(0, 5).map((p) => p.path).join(', '));
    }

    push('WARN', '10.2–10.19 Paper content fidelity',
      `${arrived.length} Paper document(s) arrived, but their CONTENT was not compared — formatting, `
      + 'images, tables, timelines, lists, code blocks, emojis, mentions and comments all require the '
      + 'document to be opened. These 18 features must be confirmed manually.');

    for (const [id, wording] of Object.entries(PAPER_DISPUTED)) {
      totals.paperDisputed = totals.paperDisputed || [];
      totals.paperDisputed.push({ id, wording });
    }
    push('WARN', '10.x documented non-migrations (6 features)',
      'The scope document records six Paper elements as not migrating — 10.2 highlight colours, '
      + '10.6 GIFs, 10.14 section breaks, 10.15 code block formatting, 10.17 mentions, 10.18 '
      + 'comments — yet the out-of-scope document lists only the in-line comment CSV. Reported at '
      + 'INFO with the document\'s wording; the combination owner must rule whether each is an '
      + 'accepted limitation or an open defect.');
  }

  /** Feature 6.1 — suppression, which cannot be verified from the Google side. */
  _checkNotificationSuppression(push, totals) {
    if (!env.CONTENT_MIGRATION_SUPPRESSES_NOTIFICATIONS) {
      push('WARN', '6.1 Suppressing email notifications',
        'Not judgeable: suppression was not requested for this run '
        + '(CONTENT_MIGRATION_SUPPRESSES_NOTIFICATIONS is false), so notification mail is the correct '
        + 'outcome and its presence is not a defect.');
      return;
    }
    // The destination-side agent explains why this is not automated for Google.
    push('WARN', '6.1 Suppressing email notifications',
      'Suppression was requested but NOT VERIFIED: confirming it on a Google destination needs Gmail '
      + 'read scope on the destination account, which the content flow does not request. Confirm '
      + 'manually — reported as not verified rather than as a pass.');
    totals.notificationLeaks.push({ verified: false, reason: 'no Gmail scope in the content flow' });
  }

  /**
   * The 36-feature rollup, in the scope document's numbering.
   *
   * A feature that was never exercised is `na` with its reason — never counted as passing. That rule
   * is the whole point of the checklist: the sibling combination once reported "handled as
   * documented" directly above a FAIL for the same thing.
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

    return DROPBOX_FEATURES.map((f) => {
      const na = (detail) => ({ ...f, status: 'na', detail });

      if (!totals.enabled) return na('Deep content validation was disabled for this run');
      if (scanned === 0) return na('No source items were read — nothing was validated');

      // Paper features: 10.1 is assertable, the rest are not.
      if (f.id === '10.1') {
        const rows = byName(/^10\.1 Dropbox Papers Migration/);
        const v = worst(rows);
        return v
          ? { ...f, status: v === 'fail' ? 'fail' : 'pass', detail: rows[0].detail }
          : na('No Dropbox Paper documents in the source');
      }
      if (f.id.startsWith('10.')) {
        const disputed = PAPER_DISPUTED[f.id];
        return na(
          (totals.paperItems.length === 0
            ? 'No Dropbox Paper documents in the source — not exercised. '
            : 'Paper arrived, but document content is not compared by API — manual check required. ')
          + (disputed ? `Scope document records: "${disputed}" — owner ruling pending.` : '')
        );
      }

      const map = {
        '1.1': /1\.1 Data Migration/,
        '2.1': /2\.x Permissions/, '2.2': /2\.x Permissions/,
        '2.3': /2\.x Permissions/, '2.4': /2\.x Permissions/, '2.5': /2\.x Permissions/,
        '3.1': /3\.x Shared Links|3\.x Shared Link CSV/,
        '3.2': /3\.x Shared Links|3\.x Shared Link CSV/,
        '4.1': /4\.1 Metadata/,
        '5.1': /5\.1 Special Characters/,
        '6.1': /6\.1 Suppressing/,
        '7.1': /7\.1 Long-File/,
        '8.1': /8\.1 Embedded Links CSV/,
        // Separate patterns now that 9.1 and 9.2 are separate checks. Sharing one pattern meant
        // both features inherited whichever check matched first, so a real 9.1 verdict could not
        // reach the checklist independently of 9.2's informational note.
        '9.1': /9\.1 Version History/, '9.2': /9\.2 Selective Versions/,
      };

      // 1.2 and 1.3 are the SAME evidence — the structure comparison — read under the run's
      // migration type. Both therefore require that evidence to exist.
      //
      // `worst([])` is null, not 'fail', so an earlier version of this fell through to 'pass' and
      // reported One Time Migration as passing on a run where nothing had been compared. That is the
      // exact defect these documents were written around: a validator reporting SUCCESS having
      // validated nothing. Absence of evidence is `na`, never a pass.
      const isDelta = String(totals.migrationType).toUpperCase() === 'DELTA';
      if (f.id === '1.2' || f.id === '1.3') {
        if (f.id === '1.2' && isDelta) return na('This run was a delta migration');
        if (f.id === '1.3' && !isDelta) return na('This run was a one-time migration, not a delta');
        const structure = worst(byName(/1\.1 Data Migration/));
        if (!structure) return na('The structure comparison did not run — nothing to base this on');
        return {
          ...f,
          status: structure === 'fail' ? 'fail' : structure === 'warn' ? 'na' : 'pass',
          detail: isDelta
            ? 'Delta run compared against the destination'
            : 'One-time migration delivered the source tree',
        };
      }

      const pattern = map[f.id];
      if (!pattern) return na('Not assessed by this validator');
      const rows = byName(pattern);
      const v = worst(rows);
      if (!v) return na('Not exercised by this run');
      return {
        ...f,
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
      const tag = u.sourceDriveName || destLeaf(u.destinationPath) || u.sourceEmail || 'unit';
      for (const c of u.checks) flat.push({ ...c, name: `[${tag}] ${c.name}` });
    }

    const hasFail = flat.some((c) => c.status === 'FAIL');
    const hasWarn = flat.some((c) => c.status === 'WARN');
    const overall = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';

    const featureChecklist = this._buildChecklist(totals, flat);
    const counts = featureChecklist.reduce(
      (acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; },
      {}
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

    const infraCheck = /Destination location|Source items scanned|Source account context|Deep content validation/i;
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
      sourceProvider: 'dropbox',
      destinationProvider: context?.destinationProvider || 'googledrive',
      combination: COMBINATION,
      checks: flat,
      perUser,
      deepContentValidation: totals,
      summary,
    };
  }
}

module.exports = DropboxToGoogledriveValidationAgent;
module.exports.DROPBOX_FEATURES = DROPBOX_FEATURES;
module.exports.PAPER_DISPUTED = PAPER_DISPUTED;
module.exports.COMBINATION = COMBINATION;
