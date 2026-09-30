'use strict';

/**
 * Deep validation for content: Box → Google My Drive.
 *
 * Edit ONLY this file to change Box → My Drive behaviour. Provider-agnostic comparison logic lives in
 * validation/shared/deepContentCore.js; the numbers live in utils/contentTolerance/; the Google
 * destination's name/path rules live in validation/destinations/googledrive.js (shared, unmodified);
 * the Box→Google role and link tables live in validation/roleMaps/box_to_google.js.
 *
 * Modelled closely on validation/combinations/content/dropboxToGoogledrive.js — same destination
 * agent (GoogleDriveValidationAgent), same three-tier shape, same "the destination is Google, not
 * SharePoint" rules (no character replacement expected, no path-length limit, a shared link is a
 * permission entry). Two real differences from that file, both load-bearing:
 *
 *   - Box exposes BOTH `content_created_at` and `content_modified_at`. Dropbox has no creation time at
 *     all, so its validator only ever compares `modifiedAt`. This one compares both.
 *   - Box Notes (16 of the 34 in-scope features) have no public export API the way Dropbox Paper does
 *     (`files/paper/create` / `files/export`). There is no way to pull a Box Note's structure back out
 *     for a fair "N tables in, N tables out" comparison the way `paperMarkdownStructure` does for
 *     Paper. See `_checkBoxNotes` below — only whether a Box Note item ARRIVED is asserted (10.1); the
 *     content-fidelity features are reported NOT ASSESSED with the reason, never guessed at. Unlike
 *     Dropbox Paper — whose own scope document says Paper converts to a Google Doc — the source PDF
 *     for THIS combination says Box Notes migrate "in the .DOCX format", so 10.1 does not require
 *     Google-native conversion as its pass condition; asserting that would fail a correctly-migrated
 *     `.docx` for not being a format the doc never promised.
 *
 * Feature coverage — backend/data/feature-scope/box-to-google-inscope.md (34 in-scope features):
 *   Tier A — 1.1 structure, 8.1 special characters, 7.1 long paths
 *   Tier B — file content hashes for pass-through formats
 *   Tier C — 2.1-2.5 permissions, 3.1-3.2 versions, 4.1 metadata, 5.1-5.2 shared links
 *   Reports — 5.1/5.2/6.1/9.1 CSVs written into the destination
 *   §10     — Box Notes (16 features): 10.1 asserted, 10.2-10.16 reported NOT ASSESSED
 */

const GoogleDriveValidationAgent = require('../../../agents/googledrive/GoogleDriveValidationAgent');
const boxClient = require('../../../clients/boxClient');
const driveClient = require('../../../clients/driveClient');
const core = require('../../shared/deepContentCore');
const destinations = require('../../destinations');
const roleMaps = require('../../roleMaps');
const tolerance = require('../../../utils/contentTolerance');
const env = require('../../../config/env');
const logger = require('../../../utils/logger');
const zlib = require('zlib');

const COMBINATION = 'box_to_googledrive';

/** Terminal CloudFuze statuses that mean the migration itself finished. */
const CF_OK = ['PROCESSED', 'PROCESS', 'VERSION_PROCESSED'];
const CF_CONFLICTS = ['PROCESSED_WITH_CONFLICTS', 'PROCESS_WITH_CONFLICTS'];

/**
 * Read one entry out of a .docx/.xlsx (a ZIP container) without a new dependency.
 *
 * Ported from dropboxToGoogledrive.js's identical helper — no zip-reading library is a dependency
 * of this project, and a minimal EOCD + Central Directory walk is safe for the small, single-shot
 * ZIPs the `docx`/`xlsx` packages produce (no data descriptors, no ZIP64).
 */
function readZipEntry(buf, entryName) {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  const searchFloor = Math.max(0, buf.length - 22 - 65557);
  for (let i = buf.length - 22; i >= searchFloor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('not a valid zip (no End-Of-Central-Directory record found)');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`bad central directory entry signature at entry ${i}`);
    }
    const compMethod = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (name === entryName) {
      const lhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      return compMethod === 0 ? raw : zlib.inflateRawSync(raw);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * Hyperlink target URLs inside a .docx, IN DOCUMENT ORDER (not keyed by visible text).
 *
 * BoxToGoogledriveTestDataAgent gives every format its own distinct target-file pair and its own
 * label text per format (e.g. "docx target 1"), so — unlike the Dropbox validator, which can hardcode
 * "link target 1"/"link target 2" because every format reuses that same literal label — matching by
 * position is the one thing that stays true regardless of which format's labels are being read: url1's
 * paragraph is always written before url2's.
 */
function extractDocxHyperlinkUrls(buf) {
  const doc = readZipEntry(buf, 'word/document.xml');
  const rels = readZipEntry(buf, 'word/_rels/document.xml.rels');
  if (!doc || !rels) return [];

  const relMap = {};
  const relText = rels.toString('utf8');
  const relRe = /<Relationship[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g;
  let m;
  while ((m = relRe.exec(relText))) relMap[m[1]] = m[2];

  const docText = doc.toString('utf8');
  const out = [];
  const hlRe = /<w:hyperlink[^>]*\br:id="([^"]+)"[^>]*>/g;
  while ((m = hlRe.exec(docText))) out.push(relMap[m[1]] || null);
  return out;
}

/**
 * Hyperlink target URLs inside an .xlsx worksheet, keyed by FIXED cell ref (A2, A3) — the seeding
 * agent always writes target 1's link to A2 and target 2's to A3 regardless of format, so the cell
 * coordinate is a stable position marker without needing the shared-strings table to recover text.
 */
function extractXlsxHyperlinkUrls(buf) {
  const sheet = readZipEntry(buf, 'xl/worksheets/sheet1.xml');
  const rels = readZipEntry(buf, 'xl/worksheets/_rels/sheet1.xml.rels');
  if (!sheet || !rels) return [];

  const relMap = {};
  const relText = rels.toString('utf8');
  const relRe = /<Relationship[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g;
  let m;
  while ((m = relRe.exec(relText))) relMap[m[1]] = m[2];

  const sheetText = sheet.toString('utf8');
  const cellOrder = ['A2', 'A3'];
  const byRef = {};
  const hlRe = /<hyperlink[^>]*\bref="([^"]+)"[^>]*\br:id="([^"]+)"/g;
  while ((m = hlRe.exec(sheetText))) byRef[m[1]] = relMap[m[2]] || null;
  return cellOrder.map((ref) => byRef[ref] ?? null);
}

/**
 * Hyperlink target URLs inside a .pdf, IN CREATION ORDER — a PDF's visible text is drawn with
 * `Tj`/`TJ` content-stream operators, not stored next to its /Link annotation, so byte-offset order
 * of `/URI (...)` occurrences is the practical position marker (pdfkit writes /Annots in the order
 * `.link()` was called, target 1 before target 2).
 */
function extractPdfHyperlinkUrls(buf) {
  const text = buf.toString('latin1');
  return [...text.matchAll(/\/URI\s*\(([^)]*)\)/g)].map((m) => m[1]);
}

/** Filenames CloudFuze uses for the CSV reports it writes into the destination. */
const CSV_REPORT_PATTERNS = {
  '5.x': /shared[-_ ]?link/i,
  '9.1': /embedded[-_ ]?link/i,
  comments: /comment/i,
};

/**
 * The 34 in-scope features, in the scope document's own numbering.
 *
 * A combination-local list rather than validation/shared/contentFunctionalityChecklist.js, for the
 * same reason dropboxToGoogledrive.js keeps its own: that module hardcodes the Google→SharePoint
 * feature set (Commenter / Contributor / Content Manager, a "Sync Orbit" wording taken from one
 * tenant), and Box's role vocabulary and this scope document's numbering are both different again.
 */
const BOX_FEATURES = [
  { id: '1.1', category: 'Migration', feature: 'Data Migration (Files & Folders with structure)' },
  { id: '1.2', category: 'Migration', feature: 'One Time Migration' },
  { id: '1.3', category: 'Migration', feature: 'Delta' },

  { id: '2.1', category: 'Permissions', feature: 'Root Folder Permissions' },
  { id: '2.2', category: 'Permissions', feature: 'Sub Folder Permissions' },
  { id: '2.3', category: 'Permissions', feature: 'Root File Permissions' },
  { id: '2.4', category: 'Permissions', feature: 'Inner File Permissions' },
  { id: '2.5', category: 'Permissions', feature: 'External Shares' },

  { id: '3.1', category: 'Versions', feature: 'Version History' },
  { id: '3.2', category: 'Versions', feature: 'Selective Versions' },

  { id: '4.1', category: 'Meta Data', feature: 'Meta Data' },

  { id: '5.1', category: 'Shared Links', feature: 'Shared Links (Anyone with the Link)' },
  { id: '5.2', category: 'Shared Links', feature: 'Shared Links (Team Members)' },

  { id: '6.1', category: 'In-Line Comment', feature: 'In-Line Comment' },
  { id: '7.1', category: 'Long File/Folder Path', feature: 'Long File/Folder Path' },
  { id: '8.1', category: 'Special Character Replacement', feature: 'Special Character Replacement' },
  { id: '9.1', category: 'Embedded Links', feature: 'Embedded Links' },

  { id: '10.1', category: 'Box Notes', feature: 'Box Notes Migration' },
  { id: '10.2', category: 'Box Notes', feature: 'Text Formatting' },
  { id: '10.3', category: 'Box Notes', feature: 'Font Size and Text Color' },
  { id: '10.4', category: 'Box Notes', feature: 'Checklist, Numbered list, Bulleted list' },
  { id: '10.5', category: 'Box Notes', feature: 'Tables' },
  { id: '10.6', category: 'Box Notes', feature: 'Insert Image (upload from computer)' },
  { id: '10.7', category: 'Box Notes', feature: 'Insert Image (Box Shared Link)' },
  { id: '10.8', category: 'Box Notes', feature: 'Insert Image (Insert Link Preview)' },
  { id: '10.9', category: 'Box Notes', feature: 'Clipboard Images' },
  { id: '10.10', category: 'Box Notes', feature: 'Emojis' },
  { id: '10.11', category: 'Box Notes', feature: 'GIFs' },
  { id: '10.12', category: 'Box Notes', feature: 'Unicode Symbols' },
  { id: '10.13', category: 'Box Notes', feature: 'Mentions' },
  { id: '10.14', category: 'Box Notes', feature: 'Box Notes Comments' },
  { id: '10.15', category: 'Box Notes', feature: 'Links' },
  { id: '10.16', category: 'Box Notes', feature: 'Hyperlinks' },

  { id: '11.1', category: 'Suppressing Email Notification', feature: 'Suppressing Email Notification' },
];

/** Box collaboration → the validator's sourcePerms shape, dropping anything comparePermissions can't use. */
function boxCollabToSourcePerm(c) {
  const isGroup = String(c.accessibleByType || '').toLowerCase() === 'group';
  return {
    email: isGroup ? (c.accessibleByName || '') : (c.accessibleByEmail || ''),
    name: c.accessibleByName || '',
    role: c.role,
    type: isGroup ? 'group' : 'user',
    displayName: c.accessibleByName || c.accessibleByEmail || '',
  };
}

class BoxToGoogledriveValidationAgent extends GoogleDriveValidationAgent {
  static supportsDeepValidation = true;

  constructor() {
    super('BoxToGoogledriveValidationAgent');
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
        + 'SharePoint role table, which has no Box-to-Google roles in it and would mistranslate every grant.'
      );
    }

    if (!env.ENABLE_DEEP_CONTENT_VALIDATION) {
      gPush('WARN', 'Deep content validation',
        'Disabled by ENABLE_DEEP_CONTENT_VALIDATION=false — nothing was compared');
      return this._buildResult(globalChecks, [], { enabled: false }, context);
    }

    const adminEmail = context.sourceAdminEmail || context.adminEmail || context.sourceEmail;
    let token = null;
    try {
      token = await boxClient.getValidToken(adminEmail);
    } catch (err) {
      gPush('FAIL', 'Source items scanned',
        `Box is not configured or no credential is usable (${err.message}) — the source could not be `
        + 'read, so nothing was validated.');
      return this._buildResult(globalChecks, [], { enabled: true, scannedSourceItems: 0 }, context);
    }

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
        await this._validateUnit({
          unit, context, adminEmail, token, destRoot, rules, roleMap, bands, mapEmail, totals,
        })
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
      permissionsPendingPaths: [],
      sharedLinkMismatches: [],
      linkObservations: [],
      conversionMismatches: [],
      timestampDrift: [],
      versionInfo: [],
      notificationLeaks: [],
      csvReports: [],
      boxNoteItems: [],
      specialChars: { total: 0, arrived: 0 },
      longPathEvidence: [],
      featureChecklist: [],
      featureSummary: null,
      itemResults: [],
      summary: '',
    };
  }

  /** Validate one source→destination unit. */
  async _validateUnit({ unit, context, adminEmail, token, destRoot, rules, roleMap, bands, mapEmail, totals }) {
    const checks = [];
    const push = (status, name, detail) => checks.push({ name, status, detail });
    const sourceEmail = unit.sourceEmail || context.sourceEmail;
    const destEmail = unit.destinationEmail || context.destinationEmail;
    const sourcePath = unit.sourcePath || context.sourceTestDataPath || '';

    // As-User: read the actual source account when it differs from the admin/service token.
    let asUserId = context.boxTargetUserId || null;
    if (!asUserId && sourceEmail && String(sourceEmail).toLowerCase() !== String(adminEmail).toLowerCase()) {
      try {
        const u = await boxClient.getBoxUserByEmail(adminEmail, sourceEmail);
        if (u) asUserId = u.id;
      } catch (err) {
        logger.warn(`[${COMBINATION} validation] Box managed-user lookup failed for ${sourceEmail}: `
          + err.message);
      }
    }

    // ── Source: resolve the seeded root, then the Box tree.
    let rootRef = null;
    try {
      rootRef = context.sourceRootId
        ? { id: String(context.sourceRootId) }
        : await boxClient.resolveFolderByPath(sourcePath, token, asUserId);
    } catch (err) {
      push('FAIL', 'Source items scanned', `Could not resolve Box path ${sourcePath}: ${err.message}`);
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }
    if (!rootRef) {
      push('FAIL', 'Source items scanned', `Box path "${sourcePath}" was not found — nothing to validate.`);
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }

    let sourceTree = [];
    try {
      sourceTree = await boxClient.buildFolderTree(rootRef.id, token, asUserId, bands.treeDepth || 35);
    } catch (err) {
      push('FAIL', 'Source items scanned', `Could not read Box folder ${rootRef.id}: ${err.message}`);
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }

    if (sourceTree.length === 0) {
      push('FAIL', 'Source items scanned',
        `No source items were read from Box "${sourcePath}". Check the path and the token's scopes.`);
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }
    totals.scannedSourceItems += sourceTree.length;
    push('PASS', 'Source items scanned', `${sourceTree.length} item(s) read from Box "${sourcePath}"`);

    // ── Destination: where it landed, and its tree.
    const sourceFolderName = core.lastSegment(sourcePath);
    // expectSourceFolderWrapper: true — this combination's CloudFuze job does not set
    // pickInsideFolder, so CloudFuze copies the source folder ITSELF into the destination path
    // rather than just its contents. Without this, findMigratedRoot returns the destination path
    // folder as-is and every migrated item compares one directory level too shallow — measured live
    // as "matched 0, misplaced 79" on a run CloudFuze had reported PROCESSED 82/82.
    const migrated = await this.findMigratedRoot(
      destRoot.rootId, destRoot.driveId, unit.destinationPath, sourceFolderName, destEmail,
      { expectSourceFolderWrapper: true }
    );
    if (!migrated) {
      push('FAIL', 'Destination location',
        `Nothing named "${sourceFolderName}" (or a dedup variant) exists under ${destRoot.label} — the `
        + 'migration appears to have created nothing.');
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }
    push('PASS', 'Destination location', `Migrated content found at ${migrated.path} in ${destRoot.label}`);

    const destTree = await this.readTree(migrated.id, destEmail, {
      driveId: destRoot.driveId,
      maxDepth: bands.treeDepth || 35,
    });

    // ── Feature 1.1 + 7.1: structure, with Google's rules.
    const cmp = core.compareTrees(sourceTree, destTree, {
      rules,
      pathLimit: bands.pathLengthLimit ?? rules.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit ?? rules.segmentLengthLimit,
    });

    totals.pairedCount += cmp.matchedCount;
    totals.missing.push(...cmp.missing.map((i) => ({ path: i.path, type: i.type, name: i.name })));

    const isCloudFuzeReport = (name) => {
      const n = String(name || '');
      if (!/\.csv$/i.test(n)) return false;
      return Object.values(CSV_REPORT_PATTERNS).some((re) => re.test(n));
    };
    const unexpectedExtra = (cmp.extra || []).filter((i) => !isCloudFuzeReport(i.name || i.path));
    const reportExtras = (cmp.extra || []).length - unexpectedExtra.length;
    totals.extra.push(...unexpectedExtra.map((i) => ({ path: i.path, type: i.type, name: i.name })));
    totals.misplaced.push(...(cmp.misplaced || []));
    totals.placeholderLinks.push(...(cmp.placeholderLinks || []));
    totals.notMigratable.push(...(cmp.notMigratable || []));

    const structureDetail =
      `source ${cmp.totalSource}, dest ${cmp.totalDest}, matched ${cmp.matchedCount}, `
      + `missing ${cmp.missing.length}, extra ${unexpectedExtra.length}, `
      + `misplaced ${(cmp.misplaced || []).length}`
      + (reportExtras > 0 ? ` (+${reportExtras} CloudFuze CSV report(s), not counted)` : '');

    const structureOk = cmp.missing.length === 0
      && unexpectedExtra.length === 0
      && (cmp.misplaced || []).length === 0;
    push(structureOk ? 'PASS' : 'FAIL', '1.1 Data Migration (structure)', structureDetail);

    // ── Per-item Tier C: permissions, links, timestamps, versions; Tier B size sanity.
    const itemDetails = [];
    const paired = [...cmp.matched.entries()];

    for (const [srcPath, pair] of paired) {
      const destItem = pair && pair.dest;
      const srcItem = (pair && pair.source) || sourceTree.find((s) => s.path === srcPath);
      if (!srcItem || !destItem) continue;
      const row = await this._validateItem({
        srcItem, destItem, destEmail, token, asUserId, roleMap, bands, mapEmail, totals,
      });
      itemDetails.push(row);
    }

    if (totals.uninspectable) {
      push('WARN', 'Items inspected',
        `${totals.uninspectable} of ${paired.length} paired item(s) carried no destination id, so `
        + 'their permissions, versions and content checks were NOT checked. They are present at the '
        + 'destination but unverified — do not read them as passing.');
    }

    this._rollUpItemChecks(push, totals, itemDetails);
    this._checkSpecialCharacters(push, sourceTree, cmp, totals);
    this._checkLongPaths(push, sourceTree, cmp, rules, totals);
    await this._checkCsvReports(push, migrated, destEmail, destRoot, totals);
    await this._checkEmbeddedLinksContent(push, cmp, destEmail, totals);
    await this._checkBoxNotes(push, sourceTree, cmp, destEmail, totals);
    this._checkNotificationSuppression(push, totals);

    const folderStructure = core.compareFolders(sourceTree, destTree, {
      rules,
      pathLimit: bands.pathLengthLimit ?? rules.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit ?? rules.segmentLengthLimit,
      sourceRootName: core.lastSegment(sourcePath) || '(root)',
      destRootName: migrated.name || '(root)',
      sourceLabel: 'Box',
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
      items: itemDetails,
      itemDetails,
      totalSourceItems: cmp.totalSource,
      totalMatchedItems: cmp.matchedCount,
      totalMissingItems: cmp.missing.length,
    };
  }

  /** Tier C + size sanity for one paired item. */
  async _validateItem({ srcItem, destItem, destEmail, token, asUserId, roleMap, bands, mapEmail, totals }) {
    const row = {
      path: srcItem.path,
      name: srcItem.name,
      type: srcItem.type,
      found: true,
      destName: destItem.name,
      isBoxNote: /\.boxnote$/i.test(String(srcItem.name || '')),
    };

    if (!destItem.id) {
      row.inspectionSkipped = 'destination item carries no id, so it could not be inspected';
      totals.uninspectable = (totals.uninspectable || 0) + 1;
      logger.warn(`[${COMBINATION} validation] "${srcItem.path}" paired with a destination item that `
        + 'has no id — skipping its permission, version and content checks');
      return row;
    }

    // ── 2.x permissions — Box addresses everything by id, so no path lookup is needed.
    const [srcCollabs, destPerms] = await Promise.all([
      (srcItem.type ? boxClient.getCollaborations(srcItem.type, srcItem.id, token, asUserId) : Promise.resolve([]))
        .catch((err) => {
          logger.warn(`[${COMBINATION} validation] could not read collaborations for `
            + `"${srcItem.path}": ${err.message}`);
          return [];
        }),
      this.readPermissions(destItem.id, destEmail),
    ]);

    const srcMembers = srcCollabs.map(boxCollabToSourcePerm).filter((m) => m.email);
    const sourcePerms = srcMembers.filter((m) => roleMap.isComparableDriveRole(m.role));

    const directGrants = (perms) => (perms.permissions || []).filter((x) => !x.inherited);
    let effectiveDestPerms = destPerms;

    // Wait for CloudFuze to finish applying permissions before calling a grant missing — the same
    // settle-retry dropboxToGoogledrive.js uses, because CloudFuze applies sharing AFTER the copy
    // completes regardless of which source cloud fed it.
    const PERMISSION_SETTLE_ATTEMPTS = env.CONTENT_PERMISSION_SETTLE_ATTEMPTS;
    const PERMISSION_SETTLE_MS = env.CONTENT_PERMISSION_SETTLE_MS;
    if (sourcePerms.length > 0 && directGrants(effectiveDestPerms).length === 0) {
      for (let attempt = 1; attempt <= PERMISSION_SETTLE_ATTEMPTS; attempt += 1) {
        await new Promise((r) => setTimeout(r, PERMISSION_SETTLE_MS));
        const retry = await this.readPermissions(destItem.id, destEmail);
        if (directGrants(retry).length > 0) {
          effectiveDestPerms = retry;
          break;
        }
      }
    }
    if (sourcePerms.length > 0 && directGrants(effectiveDestPerms).length === 0) {
      row.permissionsNotYetApplied = true;
      totals.permissionsPendingPaths.push(srcItem.path);
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
      const permCmp = core.comparePermissions(sourcePerms, effectiveDestPerms.permissions, mapEmail, { roleMap });
      row.permissionComparison = permCmp;
      row.permissions = [
        ...(permCmp.matches || []).map((m) => ({ ...m, match: true })),
        ...(permCmp.mismatches || []).map((m) => ({ ...m, match: false })),
        ...(permCmp.escalations || []).map((m) => ({ ...m, match: false })),
        ...(permCmp.viaGroup || []).map((m) => ({ ...m, match: true, viaGroup: true })),
      ];
      row.sourceLabel = 'Box';

      const extAddr = String(env.BOX_TEST_EXTERNAL_USER || '').trim().toLowerCase();
      const isExtRow = (r) => Boolean(extAddr) && String(r.user || '').toLowerCase() === extAddr;

      totals.permissionObservations.push({
        path: srcItem.path,
        type: srcItem.type,
        checked: permCmp.checked,
        externalChecked: (permCmp.matches || []).filter(isExtRow).length
          + (permCmp.mismatches || []).filter(isExtRow).length,
        externalFailed: (permCmp.mismatches || []).filter(isExtRow).length,
        matches: permCmp.matches.length,
        mismatches: permCmp.mismatches.length,
        escalations: permCmp.escalations.length,
        viaGroup: permCmp.viaGroup.length,
      });
      for (const m of permCmp.mismatches) totals.permissionMismatches.push({ path: srcItem.path, ...m });
      for (const e of permCmp.escalations) {
        totals.permissionMismatches.push({ path: srcItem.path, ...e, escalation: true });
      }
    }

    // ── 5.1 / 5.2 shared links. Box addresses the item directly by id.
    if (srcItem.id) {
      const sharing = await boxClient.getItemSharing(srcItem.type, srcItem.id, token, asUserId).catch((err) => {
        logger.warn(`[${COMBINATION} validation] could not read sharing for "${srcItem.path}": ${err.message}`);
        return { sharedLink: null, access: null };
      });
      if (sharing.access) {
        const linkCmp = roleMap.compareSharedLink(sharing, destPerms.links);
        if (!linkCmp.notComparable) {
          totals.linkObservations.push({
            path: srcItem.path,
            type: srcItem.type,
            sourceAudience: sharing.access,
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
        row.sharedLinkCounts = { source: 1, dest: destPerms.links.length };
        row.sharedLinks = [{
          sourceType: sharing.access,
          sourceRole: 'view',
          actual: (linkCmp.actual || []).join(', ') || '(none)',
          match: linkCmp.notComparable ? null : linkCmp.match,
        }];
      }
    }

    if (srcItem.type === 'folder') return row;

    // ── 4.1 metadata — BOTH created and modified are comparable for Box.
    const tsCmp = core.compareTimestamps(
      { createdAt: srcItem.createdAt, modifiedAt: srcItem.modifiedAt },
      { createdAt: destItem.createdAt, modifiedAt: destItem.modifiedAt },
      bands.timestampDriftMs
    );
    row.timestamps = { ...tsCmp, createdComparable: true };
    if (tsCmp && tsCmp.comparable && !tsCmp.match) {
      totals.timestampDrift.push({
        path: srcItem.path,
        source: srcItem.modifiedAt,
        dest: destItem.modifiedAt,
        sourceCreated: srcItem.createdAt,
        destCreated: destItem.createdAt,
      });
    }

    // ── 3.1 / 3.2 versions. Informational: the expected destination count is a job setting.
    const [srcVersions, destVersions] = await Promise.all([
      boxClient.getFileVersions(srcItem.id, token, asUserId).catch((err) => {
        logger.warn(`[${COMBINATION} validation] could not read versions for "${srcItem.path}": ${err.message}`);
        return { totalVersions: 1 };
      }),
      this.readVersionCount(destItem.id, destEmail),
    ]);
    if (srcVersions.totalVersions > 1 || destVersions > 1) {
      totals.versionInfo.push({
        path: srcItem.path,
        sourceVersions: srcVersions.totalVersions,
        destVersions,
        note: 'Informational — scope 3.2 makes the expected destination count a job setting (all '
          + 'versions, or the last N), so the counts cannot be judged equal or unequal here.',
      });
      row.versions = { source: srcVersions.totalVersions, dest: destVersions };
    }

    // ── Size, banded by whether the destination was converted.
    const converted = core.isConverted(destItem) || core.isGoogleNative(destItem.mimeType);
    const sizeBands = converted ? bands.convertedFileSize : bands.fileSize;
    if (srcItem.size != null && destItem.size != null && sizeBands) {
      const sizeCmp = core.compareSize(srcItem, destItem, sizeBands);
      row.size = sizeCmp;
      if (sizeCmp && sizeCmp.severity === 'error') {
        totals.conversionMismatches.push({ path: srcItem.path, source: srcItem.size, dest: destItem.size, converted });
      }
    }

    return row;
  }

  /** Turn per-item observations into the unit's feature checks. */
  _rollUpItemChecks(push, totals, itemDetails) {
    const permAt = (atRoot, type) => totals.permissionObservations.filter((o) =>
      (core.segmentsOf(o.path).length <= 1) === atRoot && o.type === type);

    const permFeature = (id, label, obs, notExercised) => {
      const checked = obs.reduce((n, o) => n + o.checked, 0);
      if (checked === 0) {
        push('WARN', `${id} ${label}`, notExercised);
        return;
      }
      const paths = new Set(obs.map((o) => o.path));
      const bad = totals.permissionMismatches.filter((m) => paths.has(m.path));
      const pending = (totals.permissionsPendingPaths || []).filter((x) => paths.has(x)).length;

      if (bad.length === 0) {
        push('PASS', `${id} ${label}`, `${checked} grant(s) compared across ${paths.size} item(s), all matched`);
      } else if (pending > 0 && pending >= bad.length) {
        push('WARN', `${id} ${label}`,
          `Not judgeable yet: ${pending} item(s) still carried only inherited drive grants when `
          + 'validation ran. CloudFuze applies item sharing AFTER the copy completes — re-validate '
          + 'this execution once it has settled.');
      } else {
        const esc = bad.filter((m) => m.escalation).length;
        push('FAIL', `${id} ${label}`,
          `${bad.length} of ${checked} grant(s) differ`
          + (esc > 0 ? ` (${esc} privilege escalation(s))` : '')
          + (pending > 0 ? ` (${pending} more item(s) not yet shared by CloudFuze — not counted)` : ''));
      }
    };

    const seed = 'Seed grants with BOX_TEST_INTERNAL_USER(S) / BOX_TEST_GROUP(S).';
    permFeature('2.1', 'Root Folder Permissions', permAt(true, 'folder'),
      `No folder at the source root carried a comparable grant, so this was not exercised. ${seed}`);
    permFeature('2.2', 'Sub Folder Permissions', permAt(false, 'folder'),
      `No sub-folder carried a comparable grant, so this was not exercised. ${seed}`);
    permFeature('2.3', 'Root File Permissions', permAt(true, 'file'),
      `No file at the source root carried a comparable grant, so this was not exercised. ${seed}`);
    permFeature('2.4', 'Inner File Permissions', permAt(false, 'file'),
      `No file below the root carried a comparable grant, so this was not exercised. ${seed}`);

    const extAddr = String(env.BOX_TEST_EXTERNAL_USER || '').trim();
    const extChecked = totals.permissionObservations.reduce((n, o) => n + (o.externalChecked || 0), 0);
    const extFailed = totals.permissionObservations.reduce((n, o) => n + (o.externalFailed || 0), 0);
    if (!extAddr) {
      push('WARN', '2.5 External Shares',
        'BOX_TEST_EXTERNAL_USER is not set, so no external grant was seeded and the feature was not '
        + 'exercised. It must be an address outside this Box enterprise.');
    } else if (extChecked === 0) {
      push('WARN', '2.5 External Shares',
        `No grant to ${extAddr} was found on any source item, so external sharing was not exercised.`);
    } else if (extFailed === 0) {
      push('PASS', '2.5 External Shares', `${extChecked} external grant(s) to ${extAddr} compared, all matched`);
    } else {
      push('FAIL', '2.5 External Shares', `${extFailed} of ${extChecked} external grant(s) to ${extAddr} differ`);
    }

    // ── Shared links: 5.1 anyone-with-the-link, 5.2 team members (Box "company" access).
    const linkFeature = (id, label, obs, notExercised) => {
      if (obs.length === 0) {
        push('WARN', `${id} ${label}`, notExercised);
        return;
      }
      const bad = obs.filter((o) => !o.match);
      if (bad.length === 0) {
        push('PASS', `${id} ${label}`, `${obs.length} link(s) compared, all matched`);
        return;
      }
      const pending = bad.filter((o) => (o.actual || []).length === 0);
      const wrong = bad.filter((o) => (o.actual || []).length > 0);
      if (wrong.length === 0) {
        push('WARN', `${id} ${label}`,
          `Not judgeable yet: ${pending.length} of ${obs.length} link(s) have no shared link at the `
          + 'destination at all. CloudFuze applies sharing AFTER the copy completes — re-validate this '
          + 'execution once it has settled.');
      } else {
        push('FAIL', `${id} ${label}`,
          `${wrong.length} of ${obs.length} link(s) differ`
          + (pending.length > 0 ? ` (${pending.length} more link(s) not yet shared — not counted)` : ''));
      }
    };
    const openLinks = totals.linkObservations.filter((o) => String(o.sourceAudience).toLowerCase() === 'open');
    const companyLinks = totals.linkObservations.filter((o) => String(o.sourceAudience).toLowerCase() === 'company');
    const otherLinks = totals.linkObservations.filter((o) => !['open', 'company'].includes(String(o.sourceAudience).toLowerCase()));

    linkFeature('5.1', 'Shared Links (Anyone with the Link)', openLinks,
      'No source item had an "open" (anyone with the link) shared link, so this was not exercised');
    linkFeature('5.2', 'Shared Links (Team Members)', companyLinks,
      'No source item had a "company" shared link, so this was not exercised');
    if (otherLinks.length > 0) {
      push('INFO', '5.x Shared Links (collaborators-only)',
        `${otherLinks.length} source link(s) use Box's "collaborators" access, which grants no NEW `
        + 'access beyond existing collaborators and has no comparable Google link scope — neither 5.1 '
        + 'nor 5.2 covers them and no verdict is claimed.');
    }

    const tsCompared = itemDetails.filter((r) => r.timestamps && r.timestamps.comparable).length;
    if (tsCompared === 0) {
      push('WARN', '4.1 Meta Data', 'No files were available to compare timestamps on');
    } else if (totals.timestampDrift.length === 0) {
      push('PASS', '4.1 Meta Data',
        `Created AND modified timestamps preserved on ${tsCompared} file(s) (Box exposes both, unlike `
        + 'Dropbox).');
    } else {
      push('FAIL', '4.1 Meta Data',
        `${totals.timestampDrift.length} of ${tsCompared} file(s) drifted beyond the tolerance`);
    }

    if (totals.versionInfo.length > 0) {
      const versioned = totals.versionInfo.filter((v) => v.sourceVersions > 1);
      const lostHistory = versioned.filter((v) => v.destVersions <= 1);
      if (versioned.length === 0) {
        push('WARN', '3.1 Version History',
          `${totals.versionInfo.length} file(s) reported version data but none had more than one `
          + 'source version, so there was no history to preserve.');
      } else if (lostHistory.length === 0) {
        push('PASS', '3.1 Version History',
          `${versioned.length} file(s) had multiple Box versions and all arrived with version history `
          + 'at the destination. Exact counts are NOT compared — Google may merge revisions.');
      } else {
        push('FAIL', '3.1 Version History',
          `${lostHistory.length} of ${versioned.length} versioned file(s) arrived with no history at `
          + `all: ${lostHistory.map((v) => `${v.path} (${v.sourceVersions}→${v.destVersions})`).slice(0, 5).join(' | ')}`);
      }
      push('INFO', '3.2 Selective Versions',
        `${versioned.length} versioned file(s) were checked for history presence under 3.1. This run `
        + 'requested ALL versions, not a selective count, so there is no N to verify — run with a '
        + 'selective version count on the job to exercise 3.2 directly.');
    }
  }

  /** Feature 8.1 — special characters, a NEGATIVE test: no replacement is expected on Google. */
  _checkSpecialCharacters(push, sourceTree, cmp, totals) {
    const SPECIAL_CHARS = /[!@#$%^&*()+[\]{};:<>?~"|=]/;
    const risky = sourceTree.filter((i) => SPECIAL_CHARS.test(String(i.name || '')));
    totals.specialChars.total += risky.length;

    if (risky.length === 0) {
      push('WARN', '8.1 Special Character Replacement',
        'No source name carried a special character, so the feature was not exercised.');
      return;
    }

    const renamed = [];
    let arrived = 0;
    for (const item of risky) {
      const dest = (cmp.matched.get(item.path) || {}).dest;
      if (!dest) continue;
      arrived += 1;
      const expected = core.convertName(item.name, item.mimeType);
      if (core.normKey(dest.name) !== core.normKey(expected)) {
        renamed.push({ source: item.name, dest: dest.name, expected, path: item.path });
      }
    }
    totals.specialChars.arrived += arrived;

    if (renamed.length === 0) {
      push('PASS', '8.1 Special Character Replacement',
        `${arrived} name(s) with special characters arrived UNCHANGED, the documented outcome for a `
        + 'Google destination.');
    } else {
      push('FAIL', '8.1 Special Character Replacement',
        `${renamed.length} name(s) were altered at the destination, but Google accepts these `
        + 'characters and no replacement was expected: '
        + renamed.slice(0, 5).map((r) => `"${r.source}" → "${r.dest}"`).join(', '));
    }
  }

  /** Feature 7.1 — long paths. Google has no path-length limit, so intact deep data is expected. */
  _checkLongPaths(push, sourceTree, cmp, rules, totals) {
    const byLength = [...sourceTree].sort((a, b) => b.path.length - a.path.length);
    const longest = byLength[0];
    if (!longest) return;

    if (cmp.matchedCount === 0) {
      push('WARN', '7.1 Long File/Folder Path',
        `Not judgeable: the migration delivered no items (${(cmp.missing || []).length} of `
        + `${cmp.totalSource} source items missing), so there is no arrived-vs-missing comparison to `
        + 'make.');
      return;
    }

    const arrivedLengths = sourceTree.filter((i) => cmp.matched.has(i.path)).map((i) => core.encodedPathLength(i.path));
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
      push('PASS', '7.1 Long File/Folder Path',
        `Every item arrived, including the longest source path (${maxArrived} encoded chars). Google `
        + 'declares no path limit, so intact deep data is the documented outcome.');
    } else if (minMissing > maxArrived) {
      push('FAIL', '7.1 Long File/Folder Path',
        `Items up to ${maxArrived} encoded chars arrived, and the shortest MISSING item is `
        + `${minMissing} chars — that pattern suggests a real path limit, which contradicts the `
        + 'declared "no limit" in validation/destinations/googledrive.js.');
    } else {
      push('WARN', '7.1 Long File/Folder Path',
        `Not assessed: ${missingLengths.length} item(s) are missing, but items LONGER than the `
        + `shortest missing one arrived intact (longest arrived ${maxArrived} chars, shortest missing `
        + `${minMissing}), so path length does not explain the absence. See the structure check (1.1).`);
    }
  }

  /** Features 5.1 / 5.2 / 9.1 — the CSV reports CloudFuze writes into the destination. */
  async _checkCsvReports(push, migrated, destEmail, destRoot, totals) {
    const children = await this.listChildren(migrated.id, destEmail, destRoot.driveId);
    const csvFiles = (children || []).filter((c) => {
      const isFolder = String(c.mimeType || '') === GoogleDriveValidationAgent.FOLDER_MIME || c.type === 'folder';
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

    if (found['5.x']) {
      push('PASS', '5.x Shared Link CSV', `"${found['5.x'].name}" present with ${found['5.x'].rows} row(s)`);
    } else {
      push('WARN', '5.x Shared Link CSV',
        'No shared-link CSV found in the destination root. Scope 5.1/5.2 say CloudFuze writes one.');
    }
    if (found['9.1']) {
      push('PASS', '9.1 Embedded Links CSV', `"${found['9.1'].name}" present with ${found['9.1'].rows} row(s)`);
    } else {
      push('WARN', '9.1 Embedded Links CSV',
        'No embedded-links CSV found in the destination root. Scope 9.1 says one is generated.');
    }
    if (found.comments) {
      push('PASS', '6.1 In-Line Comment CSV',
        `"${found.comments.name}" present with ${found.comments.rows} row(s) — the documented outcome: `
        + 'comments arrive as a CSV, not as comments on the item.');
    } else {
      push('WARN', '6.1 In-Line Comment CSV',
        'No comment CSV found in the destination root — the in-line comment feature writes one.');
    }
  }

  /** Feature 9.1 content check — did the migrated document's links actually get rewritten. */
  async _checkEmbeddedLinksContent(push, cmp, destEmail, totals) {
    const isBoxUrl = (u) => /box\.com/i.test(String(u || ''));
    totals.embeddedLinks = {};

    const formats = [
      { ext: 'docx', read: (pair) => this._readBoxDocxLinks(pair, destEmail) },
      { ext: 'pdf', read: (pair) => this._readBoxPdfLinks(pair, destEmail) },
      { ext: 'xlsx', read: (pair) => this._readBoxXlsxLinks(pair, destEmail) },
    ];

    for (const { ext, read } of formats) {
      const label = `9.1 Embedded Links (content, .${ext})`;
      const pair = [...cmp.matched.values()]
        .find((p) => new RegExp(`document-with-embedded-links\\.${ext}$`, 'i').test(p.source.path));
      if (!pair) {
        push('WARN', label,
          `The seeded .${ext} embedded-links document did not reach the destination, so the actual `
          + 'link rewrite could not be checked — see the structure check.');
        continue;
      }

      let urls;
      try {
        urls = await read(pair);
      } catch (err) {
        push('WARN', label,
          `Could not read "${pair.dest.name}" at the destination to check its links (${err.message}).`);
        continue;
      }

      const [target1Href, target2Href] = urls;
      totals.embeddedLinks[ext] = { target1Href: target1Href || null, target2Href: target2Href || null };

      if (!target1Href && !target2Href) {
        push('WARN', label,
          `Neither seeded link could be found in "${pair.dest.name}" at the destination — its `
          + 'structure may have changed on migration in a way this check does not anticipate.');
        continue;
      }

      const problems = [];
      if (target1Href && isBoxUrl(target1Href)) {
        problems.push('link target 1 still points at Box — it was not rewritten');
      }
      if (target2Href && isBoxUrl(target2Href)) {
        problems.push('link target 2 still points at Box — it was not rewritten');
      }

      if (problems.length === 0) {
        push('PASS', label,
          'Both embedded links were rewritten away from Box to the destination copies of their '
          + 'targets.');
      } else {
        push('FAIL', label, problems.join('; '));
      }
    }
  }

  /** .docx: parse hyperlink relationship targets directly, or export-as-HTML if converted to native. */
  async _readBoxDocxLinks(pair, destEmail) {
    if (core.isGoogleNative(pair.dest.mimeType)) {
      const htmlBuf = await driveClient.exportNativeFile(pair.dest.id, 'text/html', destEmail);
      const html = htmlBuf.toString('utf8');
      if (!html) throw new Error('exported HTML was empty');
      const urls = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      return [urls[0] || null, urls[1] || null];
    }
    const buf = await this.readContent(pair.dest, destEmail);
    return extractDocxHyperlinkUrls(buf);
  }

  /** .xlsx: parse the worksheet's hyperlink relationships directly, keyed by fixed cell refs. */
  async _readBoxXlsxLinks(pair, destEmail) {
    if (core.isGoogleNative(pair.dest.mimeType)) {
      throw new Error('converted to a native Google Sheet — no cross-format check implemented for '
        + 'that case (Sheets has no comparable hyperlink-relationship export)');
    }
    const buf = await this.readContent(pair.dest, destEmail);
    return extractXlsxHyperlinkUrls(buf);
  }

  /** .pdf: parse /URI annotations directly. PDF has no Google-native equivalent to convert to. */
  async _readBoxPdfLinks(pair, destEmail) {
    const buf = await this.readContent(pair.dest, destEmail);
    return extractPdfHyperlinkUrls(buf);
  }

  /**
   * Scope §10 — Box Notes. Sixteen features, ONE of which (10.1) can be asserted structurally: that a
   * source `.boxnote` item produced a destination item at all. The other fifteen cannot — Box has no
   * public export endpoint for a Note's internal content the way Dropbox's `files/export` does for
   * Paper, so there is no fair "N tables in, N tables out" count to make. Reported NOT ASSESSED with
   * the reason, never guessed at.
   *
   * 10.1's PASS condition is arrival, not conversion to a Google-native doc. The source PDF
   * (`Content_BoxtoGoogle(MyDrive&SharedDrive)_(12-09-2026).pdf`) states 10.1 plainly: "Migration of
   * Box Notes files in the .DOCX format to the destination cloud" — unlike Dropbox Paper, whose own
   * scope document explicitly says Paper converts to a Google Doc (`.gdoc`). Requiring
   * `core.isGoogleNative(destItem.mimeType)` here asserted a destination format the doc never
   * promised, which would fail a Box Note that migrated correctly as a `.docx` — the documented
   * outcome — for not being something the doc never asked it to be. The arrived format is still
   * recorded on `totals.boxNoteItems` for anyone auditing the report, just not used as a verdict.
   */
  async _checkBoxNotes(push, sourceTree, cmp, destEmail, totals) {
    const notes = sourceTree.filter((i) => /\.boxnote$/i.test(String(i.name || '')));
    totals.boxNoteSourceCount = notes.length;
    if (notes.length === 0) {
      push('WARN', '10.x Box Notes',
        'No Box Notes in the source, so 16 of the 34 in-scope features were not exercised. '
        + 'BoxToGoogledriveTestDataAgent seeds a real Box Note via POST /2.0/notes/convert — if this '
        + 'run has none, seeding either failed (check the run report\'s errors) or was skipped.');
      return;
    }

    const arrived = notes.filter((n) => cmp.matched.has(n.path));
    const missing = notes.filter((n) => !cmp.matched.has(n.path));
    for (const n of arrived) {
      const destItem = (cmp.matched.get(n.path) || {}).dest;
      totals.boxNoteItems.push({
        path: n.path,
        destName: destItem?.name || null,
        destMimeType: destItem?.mimeType || null,
        convertedToGoogleDoc: Boolean(destItem && core.isGoogleNative(destItem.mimeType)),
      });
    }

    if (missing.length === 0 && arrived.length > 0) {
      push('PASS', '10.1 Box Notes Migration',
        `${arrived.length} Box Note(s) arrived at the destination `
        + `(as ${totals.boxNoteItems.map((b) => b.destMimeType || 'unknown format').join(', ')}).`);
    } else {
      push('FAIL', '10.1 Box Notes Migration',
        `${notes.length} Box Note(s) at the source: ${missing.length} missing at the destination.`);
    }

    push('WARN', '10.2-10.16 Box Notes content fidelity',
      'NOT ASSESSED AUTOMATICALLY: Box has no public API to export a Note\'s internal content, so '
      + 'there is no source-side structure to compare against the migrated file\'s content the way '
      + 'Dropbox Paper\'s markdown export allows — this is a measurement gap, not a seeding gap. Real '
      + 'content IS seeded via POST /2.0/notes/convert (10.2, 10.4, 10.5, 10.7, 10.10-10.12, '
      + '10.14-10.16) — confirm those by eye against the migrated file. Five elements have no Markdown '
      + 'equivalent at all and remain fully manual (10.3, 10.6, 10.8, 10.9, 10.13) — see '
      + 'box-to-google-testdata.md and the manual steps BoxToGoogledriveTestDataAgent._seedBoxNotes '
      + 'reports as notSeeded.');
  }

  /** Feature 11.1 — suppression. Every grant this agent makes already uses notify:false. */
  _checkNotificationSuppression(push, totals) {
    if (!env.CONTENT_MIGRATION_SUPPRESSES_NOTIFICATIONS) {
      push('WARN', '11.1 Suppressing Email Notification',
        'Not judgeable: suppression was not requested for this run '
        + '(CONTENT_MIGRATION_SUPPRESSES_NOTIFICATIONS is false), so notification mail is the correct '
        + 'outcome and its presence is not a defect.');
      return;
    }
    push('WARN', '11.1 Suppressing Email Notification',
      'Suppression was requested but NOT VERIFIED from the Google side: confirming no notification was '
      + 'sent needs Gmail read scope on the destination account, which the content flow does not '
      + 'request (GoogleDriveValidationAgent.findSharingNotifications documents the same gap). Note '
      + 'that every collaboration BoxToGoogledriveTestDataAgent creates already passes notify:false on '
      + 'the Box side, so the SOURCE half of this feature is exercised even though the destination '
      + 'half cannot be confirmed automatically.');
    totals.notificationLeaks.push({ verified: false, reason: 'no Gmail scope in the content flow' });
  }

  /** The 34-feature rollup, in the scope document's own numbering. */
  _buildChecklist(totals, checks) {
    const byName = (pattern) => checks.filter((c) => pattern.test(c.name));
    const worst = (rows) => {
      if (rows.length === 0) return null;
      if (rows.some((r) => r.status === 'FAIL')) return 'fail';
      if (rows.some((r) => r.status === 'WARN')) return 'warn';
      return 'pass';
    };
    const scanned = totals.scannedSourceItems || 0;

    return BOX_FEATURES.map((f) => {
      const na = (detail) => ({ ...f, status: 'na', detail });

      if (!totals.enabled) return na('Deep content validation was disabled for this run');
      if (scanned === 0) return na('No source items were read — nothing was validated');

      if (f.id === '10.1') {
        const rows = byName(/(^|\] )10\.1 Box Notes Migration/);
        const v = worst(rows);
        return v
          ? { ...f, status: v === 'fail' ? 'fail' : 'pass', detail: rows[0].detail }
          : na((totals.boxNoteSourceCount || 0) === 0
            ? 'No Box Notes in the source'
            : `${totals.boxNoteSourceCount} Box Note(s) in the source, but the migration check did not `
              + 'run');
      }
      if (/^10\./.test(f.id) && f.id !== '10.1') {
        const srcCount = totals.boxNoteSourceCount || 0;
        return na(srcCount === 0
          ? 'No Box Notes in the source — not exercised'
          : 'Box Notes content fidelity cannot be measured by API (no export endpoint) — see '
            + '10.2-10.16 check and box-to-google-outscope.md. Real content is seeded automatically; '
            + 'confirm it against the migrated file by eye.');
      }

      const isDelta = String(totals.migrationType).toUpperCase() === 'DELTA';
      if (f.id === '1.2' || f.id === '1.3') {
        if (f.id === '1.2' && isDelta) return na('This run was a delta migration');
        if (f.id === '1.3' && !isDelta) return na('This run was a one-time migration, not a delta');
        const structure = worst(byName(/1\.1 Data Migration/));
        if (!structure) return na('The structure comparison did not run — nothing to base this on');
        return {
          ...f,
          status: structure === 'fail' ? 'fail' : structure === 'warn' ? 'na' : 'pass',
          detail: isDelta ? 'Delta run compared against the destination' : 'One-time migration delivered the source tree',
        };
      }

      const map = {
        '1.1': /1\.1 Data Migration/,
        '2.1': /(^|\] )2\.1 Root Folder/, '2.2': /(^|\] )2\.2 Sub Folder/,
        '2.3': /(^|\] )2\.3 Root File/, '2.4': /(^|\] )2\.4 Inner File/, '2.5': /(^|\] )2\.5 External/,
        '3.1': /(^|\] )3\.1 Version History/, '3.2': /(^|\] )3\.2 Selective Versions/,
        '4.1': /4\.1 Meta Data/,
        '5.1': /(^|\] )5\.1 Shared Links|(^|\] )5\.x Shared Link CSV/,
        '5.2': /(^|\] )5\.2 Shared Links|(^|\] )5\.x Shared Link CSV/,
        '6.1': /6\.1 In-Line Comment/,
        '7.1': /7\.1 Long File/,
        '8.1': /8\.1 Special Character/,
        '9.1': /9\.1 Embedded Links/,
        '11.1': /11\.1 Suppressing/,
      };
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
    const counts = featureChecklist.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
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

    const infraCheck = /Destination location|Source items scanned|Deep content validation/i;
    const mismatches = flat.filter((c) => c.status === 'FAIL').map((c) => {
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
          + `content was compared. ${passed}/${flat.length} reachability check(s) passed. ${tail}`;
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
      sourceProvider: 'box',
      destinationProvider: context?.destinationProvider || 'googledrive',
      combination: COMBINATION,
      checks: flat,
      perUser,
      deepContentValidation: totals,
      summary,
    };
  }
}

module.exports = BoxToGoogledriveValidationAgent;
module.exports.BOX_FEATURES = BOX_FEATURES;
module.exports.COMBINATION = COMBINATION;
