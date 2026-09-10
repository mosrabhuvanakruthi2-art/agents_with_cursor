'use strict';

/**
 * Deep validation for content: Dropbox → SharePoint Online.
 *
 * Edit ONLY this file to change Dropbox → SharePoint behaviour. Provider-agnostic comparison logic
 * lives in validation/shared/deepContentCore.js; the numbers live in utils/contentTolerance/
 * dropboxToSharepoint.js; the SharePoint destination's name/path rules live in
 * validation/destinations/sharepoint.js; the Dropbox→SharePoint role and link tables live in
 * validation/roleMaps/dropbox_to_sharepoint.js.
 *
 * Feature coverage — backend/data/feature-scope/dropbox-to-sharepoint-inscope.md (36 features):
 *   Tier A — 1.1 structure, 7.1 special characters, 8.1 long paths
 *   Tier B — file content hashes for pass-through formats
 *   Tier C — 3.x versions, 4.1–4.5 permissions, 5.1–5.2 shared links, 6.1 metadata
 *   Reports — the CSVs CloudFuze writes at the destination (5.1, 5.2, 8.1, 9.1)
 *   §11    — Dropbox Paper (19 features): converted to Word (.docx)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE FILE FROM dropboxToGoogledrive.js
 *
 * Same source cloud, so the temptation is to share. The two must stay independent, for a reason
 * that is about the DOCUMENTS, not the code: `dropbox-to-google-inscope.md` and
 * `dropbox-to-sharepoint-inscope.md` are different documents with different feature numbering
 * (Google has no Folder Display; Versions is §9 there and §3 here; Paper is §10 there and §11 here)
 * and INVERTED destination rules. Google rejects almost no characters and imposes no path limit;
 * SharePoint replaces characters and enforces 400. A change to one combination's scope must not be
 * able to move the other's verdicts.
 *
 * The actual Dropbox API reading is not duplicated — it lives in clients/dropboxClient.js, which is
 * destination-agnostic and shared by design. What is deliberately not shared is the verdict logic,
 * which is exactly the part that differs.
 *
 * THE DESTINATION IS SHAREPOINT, NOT GOOGLE. Three rules flip, and getting any of them wrong
 * produces confident false failures rather than quiet gaps:
 *
 *   - SharePoint rejects `" * : < > ? / \ |` and CloudFuze replaces each with `_` or `-`
 *     (feature 7.1). `~ # % & { }` are VALID and arrive unchanged — predicting them replaced
 *     produced four wrong findings on run 6a8d53d2.
 *   - SharePoint enforces a 400-character ENCODED path limit with 255-character segments. Over it,
 *     a placeholder link is the DOCUMENTED expected outcome (feature 8.1), not a missing item.
 *   - Dropbox Paper converts to Word `.docx` here, not to a Google Doc.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const SharePointValidationAgent = require('../../../agents/sharepoint/SharePointValidationAgent');
const dropboxClient = require('../../../clients/dropboxClient');
const core = require('../../shared/deepContentCore');
const docxLinks = require('../../../utils/docxLinks');
const destinations = require('../../destinations');
const roleMaps = require('../../roleMaps');
const tolerance = require('../../../utils/contentTolerance');
const env = require('../../../config/env');
const logger = require('../../../utils/logger');

const COMBINATION = 'dropbox_to_sharepoint';

/** Terminal CloudFuze statuses that mean the migration itself finished. */
const CF_OK = ['PROCESSED', 'PROCESS', 'VERSION_PROCESSED'];
const CF_CONFLICTS = ['PROCESSED_WITH_CONFLICTS', 'PROCESS_WITH_CONFLICTS'];

/**
 * CloudFuze applies sharing to the destination MINUTES after the job reports PROCESSED, so a
 * permission read immediately after the migration legitimately returns nothing. Retry before
 * concluding a grant is missing — measured on the Dropbox→Google pair, same CloudFuze behaviour.
 */
const PERMISSION_SETTLE_ATTEMPTS = 3;
const PERMISSION_SETTLE_MS = 20000;

/**
 * The 36 in-scope features, in THIS document's own numbering.
 *
 * A combination-local list rather than validation/shared/contentFunctionalityChecklist.js: that
 * module hardcodes the Google Shared Drive→SharePoint feature set — `buildIds()` returns a literal
 * 38-row array with no injection point, and it carries Commenter / Content Manager roles that do not
 * exist in Dropbox. Using it would produce a report whose feature ids do not match the document a
 * reviewer is holding. Editing it would change both live SharePoint combinations, which CONTRIBUTING
 * forbids.
 */
const DROPBOX_SP_FEATURES = [
  { id: '1.1', category: 'Migration', feature: 'One time migration' },
  { id: '1.2', category: 'Migration', feature: 'Delta' },

  { id: '2.1', category: 'Folder Display', feature: 'Folder Display' },

  { id: '3.1', category: 'Versions', feature: 'Versions' },
  { id: '3.2', category: 'Versions', feature: 'Selective Versions' },

  { id: '4.1', category: 'Permissions', feature: 'Root Folder Permissions' },
  { id: '4.2', category: 'Permissions', feature: 'Sub Folder Permissions' },
  { id: '4.3', category: 'Permissions', feature: 'Root File Permissions' },
  { id: '4.4', category: 'Permissions', feature: 'Inner File Permissions' },
  { id: '4.5', category: 'Permissions', feature: 'External Shares' },

  { id: '5.1', category: 'Shared Links', feature: 'Shared Links (Anyone with the Link)' },
  { id: '5.2', category: 'Shared Links', feature: 'Shared Links (Team Members)' },

  { id: '6.1', category: 'Metadata', feature: 'Metadata' },
  { id: '7.1', category: 'Special Character Replacement', feature: 'Special Character Replacement' },
  { id: '8.1', category: 'Long Folder/File path', feature: 'Long Folder/File path' },
  { id: '9.1', category: 'Embedded Links', feature: 'Embedded Links' },
  { id: '10.1', category: 'Suppress Email Notification', feature: 'Suppress Email Notification' },

  { id: '11.1', category: 'Dropbox Papers', feature: 'Dropbox Papers Migration' },
  { id: '11.2', category: 'Dropbox Papers', feature: 'Text Formatting' },
  { id: '11.3', category: 'Dropbox Papers', feature: 'Inserted Images' },
  { id: '11.4', category: 'Dropbox Papers', feature: 'Inserted Media' },
  { id: '11.5', category: 'Dropbox Papers', feature: 'Clipboard Images' },
  { id: '11.6', category: 'Dropbox Papers', feature: 'GIFs' },
  { id: '11.7', category: 'Dropbox Papers', feature: 'Links' },
  { id: '11.8', category: 'Dropbox Papers', feature: 'Inserted Dropbox Files' },
  { id: '11.9', category: 'Dropbox Papers', feature: 'Tables' },
  { id: '11.10', category: 'Dropbox Papers', feature: 'Inserted Time Line' },
  { id: '11.11', category: 'Dropbox Papers', feature: 'TO-DO List' },
  { id: '11.12', category: 'Dropbox Papers', feature: 'Bulleted List' },
  { id: '11.13', category: 'Dropbox Papers', feature: 'Numbered List' },
  { id: '11.14', category: 'Dropbox Papers', feature: 'Section Breaks' },
  { id: '11.15', category: 'Dropbox Papers', feature: 'Code Block' },
  { id: '11.16', category: 'Dropbox Papers', feature: 'Emojis' },
  { id: '11.17', category: 'Dropbox Papers', feature: 'Mentions' },
  { id: '11.18', category: 'Dropbox Papers', feature: 'Comments' },
  { id: '11.19', category: 'Dropbox Papers', feature: 'Versions for Dropbox Papers' },
];

/**
 * The eight Paper behaviours the in-scope document records as NOT migrating as expected, with its
 * own wording.
 *
 * They appear in the IN-scope document, yet the out-of-scope document lists only the in-line comment
 * CSV. Until the combination owner rules, each is reported at INFO carrying the document's wording —
 * neither hiding a defect nor inventing one.
 *
 * Do NOT convert these to failures or to passes without that ruling. The Google pair's scope document
 * records what guessing cost on the sibling combination: one guessed rule failed 92 ordinary
 * notification emails, another printed "handled as documented" directly above a FAIL for the same
 * thing.
 */
const PAPER_DOCUMENTED = {
  '11.2': 'Minor variations were observed, particularly with text highlight colors, which were not preserved after the migration.',
  '11.6': 'GIFs were not transferred as expected. In the destination document, they appear as unsupported elements and are not displayed correctly.',
  '11.11': 'To-Do list elements were not preserved in their original structured format. Checklist items converted into plain text, resulting in the loss of their original structure and usability as checklist entries.',
  '11.14': 'Section breaks were not carried over. No equivalent formatting or visual separators are present in the destination document.',
  '11.15': 'The content within code blocks was transferred successfully. However, the original code block formatting — background styling, borders, and structured layout — was not fully preserved, resulting in a plain text representation.',
  '11.17': 'User mentions were not migrated as expected. They are displayed as plain text (editable) at the destination rather than proper mentions, and the link appears as an invalid link.',
  '11.18': 'Comments were not migrated as expected. The destination item does not contain any of the original comments from the source.',
  '11.19': 'Version history for Dropbox Paper files is not visible at the source. At the destination, version history is present in the UI; however, these versions appear to be created/updated at the API level during migration rather than preserving the original version history from the source.',
};

/**
 * SharePoint's own site groups, which exist on every item and are NOT migrated permissions.
 *
 * Counting them as destination grants makes every comparison meaningless: run 39b7813b's
 * destination carried exactly `QA Members` / `QA Owners` / `QA Visitors` /
 * `qa@trydemos.onmicrosoft.com` on every folder and file, and nothing else. Comparing three real
 * Dropbox grants against those four produced noise rather than a verdict.
 *
 * `googledriveToSharepoint.js` has the same filter for the same reason; this is a local copy
 * because that file belongs to another combination.
 */
function isBuiltinSiteGroup(principal) {
  const n = String(principal || '').toLowerCase().trim();
  if (!n) return false;
  if (/\.onmicrosoft\.com$/.test(n)) return true;
  return /\s(owners|members|visitors)$/.test(n);
}

/**
 * The name an item is expected to carry at a SharePoint destination.
 *
 * Two rewrites that `deepContentCore` cannot predict for this pair, both confirmed against run
 * 39b7813b's destination. Handled here rather than in the shared module because the shared module
 * is imported by every content combination:
 *
 *   1. **Paper → Word.** Scope §11.1: a `.paper` document arrives as `.docx`. deepContentCore's
 *      `DROPBOX_PAPER_CONVERSION` maps `.paper → .html`, which is the GOOGLE outcome — correct for
 *      dropbox→googledrive, wrong here. Editing that table would change both Google combinations.
 *      Observed: source `qa-paper-full-….paper`, destination `qa-paper-full-….docx`, reported as
 *      one missing + one extra.
 *   2. **Reserved names get a prefix.** `sanitizeName()` replaces invalid CHARACTERS but leaves a
 *      reserved NAME untouched, so we predicted `CON` while the destination holds `_CON`. Observed
 *      for all four of CON, PRN, AUX, NUL — four missing + four extra from one rule.
 *
 * Returns the rewritten name, or null when no rewrite applies.
 */
function predictedDestName(item, rules) {
  const name = String(item?.name || '');
  if (!name) return null;

  const paper = /\.papert?$/i.test(name) || item.isPaper;
  if (paper) return name.replace(/\.papert?$/i, '.docx');

  if (rules && rules.isReservedName && rules.isReservedName(name)) return `_${name}`;
  return null;
}

/** Emoji, counted by code point so a surrogate pair is one emoji rather than two characters. */
function countEmoji(text) {
  const m = String(text || '').match(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F0FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu
  );
  return m ? m.length : 0;
}

/**
 * Structural counts of a Dropbox Paper document, read from its own markdown export.
 *
 * Same shape as the Dropbox→Google pair's parser, and the two non-obvious rules are copied
 * deliberately because both were established by reading real exports:
 *
 *   - A table is identified by its header SEPARATOR row, one per table. Counting `|` rows counts
 *     every row of every table instead. And the separator must allow a SINGLE dash (`| - | - |`),
 *     which is what Paper's own export writes — requiring `---` counted zero tables in a document
 *     that demonstrably had one.
 *   - Lists are counted as ITEMS, not blocks. Converters emit one list element per item as often
 *     as one per block, so item counts compare stably and block counts do not.
 */
function paperMarkdownStructure(md) {
  const text = String(md || '');
  const lines = text.split('\n');
  const count = (re) => (text.match(re) || []).length;
  return {
    tables: lines.filter((l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l)).length,
    bulleted: lines.filter((l) => /^\s*[-*+]\s+/.test(l)).length,
    numbered: lines.filter((l) => /^\s*\d+[.)]\s+/.test(l)).length,
    todo: lines.filter((l) => /^\s*[-*+]\s+\[[ xX]\]/.test(l)).length,
    // Images first: an image is a link with a leading `!`, so links must exclude them.
    images: count(/!\[[^\]]*\]\([^)]*\)/g),
    links: count(/(^|[^!])\[[^\]]*\]\([^)]*\)/g),
    emojis: countEmoji(text),
    codeBlocks: count(/```/g) >> 1,
  };
}

/**
 * The same counts read from the destination Word document's own markup.
 *
 * Counted from `word/document.xml` rather than the stripped text, because every structural element
 * disappears when tags are removed. WordprocessingML names each one:
 *
 *   <w:tbl>      a table
 *   <w:numPr>    a paragraph that is a list item (numbered OR bulleted — the distinction lives in
 *                the numbering part, so both are counted together and compared as a total)
 *   <w:drawing>  an embedded image or media object
 */
/**
 * An emoji, rasterised into the document as a picture.
 *
 * The converter does not carry an emoji across as a character. It renders each one to a small
 * square image and gives the drawing the emoji's CLDR name as its description. Read off the real
 * destination document (run 9aca0737):
 *
 *   descr="party popper"  152400 x 152400      descr="rocket"    152400 x 152400
 *   descr="thumbs up"     152400 x 152400      (no descr)       5238750 x 3505200
 *
 * So counting emoji from the stripped TEXT returns 0 however well the migration ran, and the same
 * rasters inflate the image count. Both verdicts were wrong in opposite directions: feature 11.16
 * read "3 in the source but only 0 at the destination — lost in conversion" (nothing was lost) and
 * 11.3 read "1 in the source, 4 at the destination" (nothing was added).
 *
 * The Dropbox→Google pair hit exactly this, with the same arithmetic — `paperEmojiAsImage.test.js`
 * records `qa-paper-full  emoji 3 -> 0  images 1 -> 4`. Detected here by GEOMETRY rather than by
 * the description text: a square extent at emoji size. A CLDR name list would need maintaining and
 * would miss any emoji whose name the converter spells differently.
 */
const EMOJI_EMU_MAX = 400000; // ~0.44in. The observed rasters are 152400 EMU (12pt); real images are 10x that.

function isEmojiDrawing(block) {
  const m = String(block).match(/<wp:extent\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
  if (!m) return false;
  const cx = Number(m[1]);
  const cy = Number(m[2]);
  return cx === cy && cx > 0 && cx <= EMOJI_EMU_MAX;
}

function docxStructure(xml) {
  const s = String(xml || '');
  const n = (re) => (s.match(re) || []).length;
  const text = s.replace(/<[^>]+>/g, ' ');

  const drawings = s.match(/<w:drawing[\s>][\s\S]*?<\/w:drawing>/g) || [];
  const emojiDrawings = drawings.filter(isEmojiDrawing).length;

  return {
    tables: n(/<w:tbl[\s>]/g),
    listItems: n(/<w:numPr[\s>]/g),
    // Real pictures only — the emoji rasters are counted as emoji, not as images.
    images: drawings.length - emojiDrawings,
    emojis: countEmoji(text) + emojiDrawings,
    emojiDrawings,
    textLength: text.replace(/\s+/g, ' ').trim().length,
  };
}

/** Feature 2.1 cannot be observed from the destination cloud at all — see the scope document. */
const FOLDER_DISPLAY_NA =
  'Folder Display is a property of the CloudFuze web app (visual source/destination folder '
  + 'selection), not of the migrated data. Nothing about it can be observed by reading the '
  + 'destination cloud, so this run cannot assess it. Verify manually in the CloudFuze UI.';

class DropboxToSharepointValidationAgent extends SharePointValidationAgent {
  static supportsDeepValidation = true;

  constructor() {
    super('DropboxToSharepointValidationAgent');
  }

  async execute(context) {
    const bands = tolerance.forCombination(COMBINATION) || {};
    const rules = destinations.forDestination('sharepoint');
    const roleMap = roleMaps.forCombination(COMBINATION);
    const globalChecks = [];
    const gPush = (status, name, detail) => globalChecks.push({ name, status, detail });

    if (!rules) {
      throw new Error(
        'validation/destinations/sharepoint.js is not registered — the SharePoint destination rules '
        + 'are required. Without them this validator cannot predict which characters are replaced or '
        + 'which paths are relocated, and every 7.1 and 8.1 verdict would be invented.'
      );
    }
    if (!roleMap) {
      throw new Error(
        `validation/roleMaps has no map covering "${COMBINATION}". Refusing to fall back to the `
        + 'Box/Drive→SharePoint role table, which has no Dropbox roles in it and would mark every '
        + 'grant non-comparable while still reporting a verdict.'
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
    const mapEmail = (e) => {
      const key = String(e || '').toLowerCase();
      return emailMap[key] || key;
    };
    /**
     * Does this source principal have a destination identity at all?
     *
     * This is the whole difference between this combination and dropbox → googleshareddrive, and it
     * is a CONFIGURATION fact, not a product one. Shared Drive migrates into erik@filefuze.co's own
     * drive, so `ben@filefuze.co` exists on both sides and a grant to him lands at the same address.
     * SharePoint migrates into the gajha.com tenant, where the run maps only
     * `erik@filefuze.co → granger@gajha.com`. `ben`, `mia`, `alex` and the three groups have no
     * destination identity, so CloudFuze has nobody to grant to and cannot migrate those grants.
     *
     * Reporting that as "0/12 grants preserved" blames the product for a missing mapping. An
     * unmapped grantee makes the feature UNTESTABLE on this run — the same category as feature 4.5,
     * which cannot be tested while the Dropbox team blocks external sharing.
     */
    const hasDestinationIdentity = (e) => Boolean(emailMap[String(e || '').toLowerCase()]);
    const units = core.resolveUnits(context);
    logger.info(`[${COMBINATION} validation] validating ${units.length} user unit(s)`);

    // ── Destination site.
    //
    // The hint comes from the destination paths the migration actually used, not from
    // SHAREPOINT_SITE_PATH: a run may land in a different site than the env default, and validating
    // the configured site instead would compare against the wrong place while reporting cleanly.
    const siteNames = [...new Set(
      units.map((u) => core.siteSegmentOf(u.destinationPath)).filter(Boolean)
    )];
    if (siteNames.length > 1) {
      gPush('WARN', 'Destination site',
        `Units name ${siteNames.length} different sites (${siteNames.join(', ')}) — validating the first.`);
    }
    const site = await this.resolveSite(context, siteNames[0] || null);
    globalChecks.push(site.check);

    const totals = this._emptyTotals(context);
    const perUser = [];

    // Guard everything on a resolved site: resolveSite returns siteId null with a FAIL check rather
    // than throwing, and continuing past it would compare an empty destination against a real source
    // and report every item missing.
    if (site.siteId) {
      for (const unit of units) {
        try {
          perUser.push(await this._validateUnit({
            unit, context, siteId: site.siteId, rules, roleMap, bands, mapEmail, hasDestinationIdentity, totals,
          }));
        } catch (err) {
          logger.warn(`[${COMBINATION} validation] unit ${unit.sourceEmail} failed: ${err.message}`);
          perUser.push({
            sourceEmail: unit.sourceEmail,
            destinationPath: unit.destinationPath,
            checks: [{ name: 'Unit validation', status: 'FAIL', detail: err.message }],
            itemDetails: [],
          });
        }
      }
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
    const cfError = String(report?.errorDescription || '').trim();

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
      // CloudFuze records its real reason on the workspace record, not on the job response. Six
      // Dropbox runs were debugged blind before anything read it.
      gPush('FAIL', 'CloudFuze migration status',
        `${cfStatus} — expected PROCESSED${cfError ? `; CloudFuze says: "${cfError}"` : ''}`);
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
      unmappedGrantees: [],
      externalShares: [],
      sharedLinkMismatches: [],
      linkObservations: [],
      timestampDrift: [],
      versionInfo: [],
      versionsOutsideWindow: [],
      notificationLeaks: [],
      notificationsChecked: false,
      csvReports: [],
      paperItems: [],
      paperSourceCount: 0,
      specialChars: { total: 0, arrived: 0 },
      longPathEvidence: [],
      featureChecklist: [],
      featureSummary: null,
      itemResults: [],
      summary: '',
    };
  }

  /** Validate one source→destination unit. */
  async _validateUnit({ unit, context, siteId, rules, roleMap, bands, mapEmail, hasDestinationIdentity, totals }) {
    const checks = [];
    const push = (status, name, detail) => checks.push({ name, status, detail });
    const sourceEmail = unit.sourceEmail || context.sourceEmail;
    const destEmail = unit.destinationEmail || context.destinationEmail;
    const sourcePath = dropboxClient.dbxPath(unit.sourcePath || context.sourcePath || env.DROPBOX_TEST_ROOT);
    const itemDetails = new Map();
    let unitFolderStructure = null;

    // ── Source: the Dropbox tree, read in the right member's account.
    //
    // A Business admin token with no member selected reads the ADMIN's own Dropbox. That succeeds and
    // validates the wrong account, so say so loudly when the member does not resolve.
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

      // Relativize against the root's DISPLAY path, not the path we asked for. Dropbox is
      // case-insensitive on lookup but returns `path_display` in the tree, while core.relativize
      // strips a case-SENSITIVE prefix — so asking for "/qa-automation" against a tree of
      // "/QA-Automation/…" strips nothing and every item reads as misplaced.
      const rootMeta = await dropboxClient.getMetadata(sourcePath, dbxOpts).catch(() => null);
      const rootPath = (rootMeta && rootMeta.path) || sourcePath;

      // Keep each item's ABSOLUTE Dropbox path before relativizing: the per-item source lookups
      // (listItemMembers, listSharedLinks, listRevisions, downloadFile) hand the path back to
      // Dropbox, where the relativized form does not exist. relativize spreads the item, so this
      // field survives it.
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

    // ── Destination: where it landed.
    const sourceFolderName = core.lastSegment(sourcePath);
    const destBase = core.inDrivePath(unit.destinationPath);
    const migrated = await this.findMigratedRoot(siteId, destBase, sourceFolderName, destEmail);
    if (!migrated || !migrated.item) {
      push('FAIL', 'Destination location',
        `Nothing named "${sourceFolderName}" (or a sanitized/dedup variant) exists under `
        + `${destBase || '/'} — the migration appears to have created nothing.`);
      return { sourceEmail, destinationPath: unit.destinationPath, checks, itemDetails: [] };
    }
    const spRootPath = migrated.path;
    push('PASS', 'Destination location',
      `Migrated content found at ${spRootPath}${migrated.renameNote ? ` (${migrated.renameNote})` : ''}`);

    // readTree relativizes to the root it is given — do not relativize again.
    const destTree = await this.readTree(siteId, spRootPath, destEmail, bands.treeDepth || 25);

    // ── Predict the two renames deepContentCore cannot, BEFORE pairing.
    //
    // `dbxPath` already holds each item's absolute Dropbox path and is what every per-item source
    // read uses, so rewriting `name`/`path` here is safe — the source is still addressable.
    const renamed = [];
    for (const item of sourceTree) {
      const predicted = predictedDestName(item, rules);
      if (!predicted || predicted === item.name) continue;
      renamed.push({ from: item.name, to: predicted, path: item.path });
      const parent = core.parentOf(item.path);
      item.name = predicted;
      item.path = core.joinPath(parent, predicted);
    }
    if (renamed.length) {
      push('PASS', 'Expected destination renames',
        `${renamed.length} item(s) are expected to arrive renamed: `
        + renamed.slice(0, 6).map((r) => `${r.from} → ${r.to}`).join(', ')
        + (renamed.length > 6 ? ` (+${renamed.length - 6} more)` : ''));
    }

    // ── Feature 1.1 + 8.1: structure, with SHAREPOINT's rules.
    const cmp = core.compareTrees(sourceTree, destTree, {
      destPrefix: spRootPath || destBase,
      pathLimit: bands.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit,
      rules,
    });
    // An item over the 400-character limit is RELOCATED by the X-Change engine (scope §8.1), so it
    // legitimately arrives under a different parent. compareTrees can only see "same name, different
    // parent" and calls that misplaced. Reclassify those into feature 8.1, where they belong.
    //
    // Measured on run 39b7813b: all three "misplaced" items were inside /08-Long-Paths at depth 5–6,
    // right at the boundary — reported as a structure defect against documented behaviour.
    // SharePoint measures its 400 characters against the FULL URL, not the drive-relative path:
    //   https://<tenant>.sharepoint.com/sites/<site>/Shared Documents/<path>
    // That prefix is ~60 characters, and omitting it made us under-measure every path by that much.
    // Measured on run 39b7813b: three items in /08-Long-Paths sat at ~346 relative characters — under
    // 400 by our reckoning, over it by SharePoint's — so CloudFuze relocated them and we reported
    // the relocation as a structure defect.
    const limit = bands.pathLengthLimit || 400;
    const urlPrefix = `https://${context.sharepointHostname || env.SHAREPOINT_HOSTNAME || ''}`
      + `${context.sharepointSitePath || env.SHAREPOINT_SITE_PATH || ''}/Shared Documents`;
    // `>=`, not `>`. Scope §8.1 calls 400 the "maximum", and the boundary item proves it: the
    // depth-5 checkpoint measures EXACTLY 400 with the prefix and CloudFuze relocated it, while
    // core.exceedsPathLimit uses a strict `>` and so called it fine.
    const encodedFull = (p) => core.encodedPathLength(urlPrefix + core.joinPath(spRootPath, p || ''));
    const pathOver = (p) => encodedFull(p) >= limit;

    // A FOLDER can be relocated while itself under the limit, because its CHILDREN are over it and
    // the X-Change engine restructures the whole branch. Measured: `…-path-05` is 373 encoded
    // characters — comfortably legal — yet it moved, because everything beneath it was not.
    // Judging the folder on its own length alone reported that restructuring as a defect.
    const overLimit = (p) => {
      const path = String(p || '');
      if (pathOver(path)) return true;
      const prefixPath = path.endsWith('/') ? path : `${path}/`;
      return sourceTree.some((i) => String(i.path || '').startsWith(prefixPath) && pathOver(i.path));
    };
    const relocated = (cmp.misplaced || []).filter((m) => overLimit(m.source || m.path));
    const trulyMisplaced = (cmp.misplaced || []).filter((m) => !overLimit(m.source || m.path));

    totals.pairedCount += cmp.matchedCount;
    totals.missing.push(...cmp.missing);
    totals.extra.push(...cmp.extra);
    totals.misplaced.push(...trulyMisplaced);
    totals.placeholderLinks.push(...cmp.placeholderLinks);
    totals.notMigratable.push(...(cmp.notMigratable || []));
    totals.longPathRelocated = (totals.longPathRelocated || 0) + relocated.length;

    // Placeholders and relocations are documented outcomes, not losses, so they must not drag the
    // structure verdict down. What fails 1.1 is an item that is genuinely absent, unexpected, or
    // moved for no documented reason.
    const structureOk = cmp.missing.length === 0 && cmp.extra.length === 0 && trulyMisplaced.length === 0;
    const accounted = cmp.matchedCount + cmp.placeholderLinks.length + relocated.length;
    push(structureOk ? 'PASS' : 'FAIL', '1.1 One time migration (structure)',
      `${accounted}/${cmp.totalSource} source item(s) accounted for `
      + `(${cmp.matchedCount} paired, ${cmp.placeholderLinks.length} placeholder link(s), `
      + `${relocated.length} relocated past the ${limit}-char limit); `
      + `${cmp.missing.length} missing, ${cmp.extra.length} extra, ${trulyMisplaced.length} misplaced`);

    // ── Rows for the items _validateItem never reaches.
    //
    // It only runs on MATCHED pairs (and stops at DEEP_CONTENT_MAX_FILES), so the report's folder
    // table saw a fraction of the tree and counted the rest as absent. Every source item needs a
    // row carrying whether it arrived, or the comparison view understates what migrated.
    const placeholderPaths = new Set((cmp.placeholderLinks || []).map((p) => (typeof p === 'string' ? p : p.path)));
    const relocatedPaths = new Set(relocated.map((m) => m.source || m.path));
    for (const s of sourceTree) {
      if (itemDetails.has(s.path)) continue;
      const isPlaceholder = placeholderPaths.has(s.path);
      const isRelocated = relocatedPaths.has(s.path);
      itemDetails.set(s.path, {
        path: s.path,
        name: s.name,
        type: s.type,
        // A placeholder link and a documented relocation both mean the item WAS handled — counting
        // either as absent turns documented behaviour into a shortfall in the report.
        found: cmp.matched.has(s.path) || isRelocated,
        placeholder: isPlaceholder,
        relocated: isRelocated,
      });
    }

    // The folder-level roll-up the comparison view reads for its missing/extra/misplaced columns.
    unitFolderStructure = core.compareFolders(sourceTree, destTree, {
      destPrefix: spRootPath || destBase,
      rules,
    });

    this._checkSpecialCharacters(push, sourceTree, cmp, rules, totals);
    this._checkLongPaths(push, sourceTree, cmp, spRootPath, bands, totals);

    // ── Per-item Tier B / Tier C.
    if (env.CONTENT_DEEP_VALIDATE_METADATA) {
      const maxItems = env.DEEP_CONTENT_MAX_FILES;
      let done = 0;
      for (const [, pair] of cmp.matched) {
        if (maxItems && done >= maxItems) break;
        done += 1;
        await this._validateItem({
          srcItem: pair.source, destItem: pair.dest, siteId, destEmail, spRootPath,
          dbxOpts, roleMap, bands, mapEmail, hasDestinationIdentity, totals, itemDetails,
        });
      }
      this._rollUpItemChecks(push, totals);
    } else {
      push('WARN', '4.1 Root Folder Permissions',
        'CONTENT_DEEP_VALIDATE_METADATA=false — permissions, links, versions and metadata were not compared');
    }

    await this._checkEmbeddedLinks(push, sourceTree, siteId, destEmail, spRootPath, totals);
    await this._checkCsvReports(push, siteId, destEmail, sourcePath, totals);
    this._checkPaper(push, sourceTree, cmp, totals);
    // Paper content fidelity (§11.3, 11.9, 11.12/13, 11.16) — only meaningful once the document paired.
    // `.docx` too: predictedDestName has already rewritten the source name to what SharePoint holds,
    // so the original `.paper` extension is gone by this point. `isPaper` is the reliable marker —
    // it is stamped by dropboxClient and survives the rename.
    const paperSrc = sourceTree.find((i) => i.isPaper || /\.papert?$/i.test(String(i.name || '')));
    if (paperSrc && cmp.matched.has(paperSrc.path)) {
      const paperDest = core.joinPath(spRootPath, String(paperSrc.path || '').replace(/^\/+/, ''));
      await this._comparePaperContent(push, paperSrc, siteId, destEmail, paperDest, dbxOpts, totals);
    }

    // ── Feature 10.1: suppressed notifications.
    if (env.CONTENT_DEEP_VALIDATE_NOTIFICATIONS) {
      const res = await this.findSharingNotifications(destEmail, context.startTime).catch(() => null);
      if (res && res.ok) {
        totals.notificationsChecked = true;
        totals.notificationLeaks.push(...(res.leaks || []));
        push(res.leaks.length === 0 ? 'PASS' : 'FAIL', '10.1 Suppress Email Notification',
          res.leaks.length === 0
            ? 'No sharing notifications reached the destination mailbox'
            : `${res.leaks.length} sharing notification(s) reached ${destEmail}`);
      } else {
        push('WARN', '10.1 Suppress Email Notification',
          `The destination mailbox could not be read${res?.error ? ` (${res.error})` : ''} — not assessed`);
      }
    }

    const status = checks.some((c) => c.status === 'FAIL') ? 'FAIL'
      : checks.some((c) => c.status === 'WARN') ? 'WARN' : 'PASS';

    return {
      sourceEmail,
      destinationEmail: destEmail,
      sourcePath,
      destinationPath: spRootPath || unit.destinationPath,
      status,
      summary: `${checks.filter((c) => c.status === 'PASS').length}/${checks.length} checks passed`,
      checks,
      folderStructure: unitFolderStructure,
      items: [...itemDetails.values()].sort((a, b) => String(a.path).localeCompare(String(b.path))),
      itemDetails: [...itemDetails.values()],
    };
  }

  /** One matched source→destination pair: permissions, links, metadata, versions, size. */
  async _validateItem({ srcItem, destItem, siteId, destEmail, spRootPath, dbxOpts, roleMap, bands,
    mapEmail, hasDestinationIdentity, totals, itemDetails }) {
    // The absolute Dropbox path — the relativized one does not exist at the source.
    const srcRef = { ...srcItem, path: srcItem.dbxPath || srcItem.path };
    const destPath = core.joinPath(spRootPath, String(destItem.path || '').replace(/^\/+/, ''));
    // `found` / `destName` are what ResultsView.ContentComparison renders. Without `found` every
    // paired item showed as "0 found at destination" beside "0 missing" — two boxes contradicting
    // each other, on a run where all 75 items were accounted for.
    const row = {
      path: srcItem.path,
      name: srcItem.name,
      type: srcItem.type,
      found: true,
      destName: destItem.name || null,
      destPath,
    };

    // Paper is a CONVERTED item (scope §11.1: Paper → Word .docx). Its bytes, size, timestamps and
    // version count are all products of the converter, so none of them can be compared against the
    // source. Record it for the §11 rollup and stop.
    if (srcItem.isPaper) {
      totals.paperItems.push({ path: srcItem.path, name: srcItem.name, destPath, paired: true });
      row.paper = true;
      itemDetails.set(srcItem.path, row);
      return;
    }

    const [srcMembers, destPerms] = await Promise.all([
      dropboxClient.listItemMembers(srcRef, dbxOpts).catch((err) => {
        logger.warn(`[${COMBINATION}] source members for ${srcRef.path}: ${err.message}`);
        return null;
      }),
      this.readPermissions(siteId, destPath, destEmail),
    ]);

    // ── Features 4.1–4.5: permissions.
    if (Array.isArray(srcMembers)) {
      const comparable = srcMembers.filter((m) => roleMap.isComparableDriveRole(m.role));
      for (const m of srcMembers) {
        if (!roleMap.isComparableDriveRole(m.role)) {
          totals.notComparable.push({
            path: srcItem.path, principal: m.email, role: m.role,
            reason: roleMap.nonComparableReason(m.role),
          });
        }
      }

      const sourcePerms = comparable.map((m) => ({
        email: m.email, role: m.role, type: m.type || 'user', displayName: m.displayName,
      }));

      // readPermissions NEVER throws — an unreadable item comes back with an empty list. Treating
      // that as "no permissions" turns an unreadable item into a clean pass, so retry first and
      // report it as pending rather than as a difference. CloudFuze applies sharing minutes after
      // PROCESSED; a read immediately after the job legitimately finds nothing.
      // Strip SharePoint's own site groups before comparing. They sit on every item, are not
      // migrated grants, and comparing real Dropbox grants against them yields noise rather than a
      // verdict. What remains is what the migration actually created — so an empty list here means
      // "no permission migrated", which is a real finding, not a read failure.
      const migratedOnly = (p) => ({
        ...p,
        permissions: (p.permissions || []).filter((x) => !isBuiltinSiteGroup(x.email || x.displayName)),
      });

      let perms = migratedOnly(destPerms);
      if (sourcePerms.length > 0 && (perms.permissions || []).length === 0) {
        for (let attempt = 1; attempt < PERMISSION_SETTLE_ATTEMPTS; attempt += 1) {
          await new Promise((r) => setTimeout(r, PERMISSION_SETTLE_MS));
          perms = migratedOnly(await this.readPermissions(siteId, destPath, destEmail));
          if ((perms.permissions || []).length > 0) break;
        }
      }

      if (sourcePerms.length > 0 && (perms.permissions || []).length === 0) {
        totals.permissionsPendingPaths.push(srcItem.path);
        row.permissionsNotYetApplied = true;
        // Record one observation AND one mismatch per source grant, at this item's position.
        //
        // Without this the positional rollup saw no observations and reported features 4.1–4.4 as
        // "not exercised by this run" — which is false and, worse, understates a real defect: the
        // grants WERE exercised at the source, they simply did not arrive. A feature that was tested
        // and lost must read FAIL, never `na`. `na` is for a feature the run could not assess.
        const scope = core.scopeOf(srcItem);
        for (const p of sourcePerms) {
          // A grantee with no destination identity cannot be migrated by anyone — CloudFuze has no
          // principal to grant to. That is a gap in the run's user mapping, not a lost permission,
          // and calling it a failure blames the product for a configuration the run did not supply.
          if (!hasDestinationIdentity(p.email)) {
            totals.unmappedGrantees.push({
              path: srcItem.path, scope, principal: p.email, sourceRole: p.role,
              reason: 'no destination identity — the run maps no equivalent for this principal in '
                + 'the destination tenant, so there is nobody for CloudFuze to grant to',
            });
            continue;
          }
          const row2 = {
            path: srcItem.path, scope, principal: p.email, sourceRole: p.role,
            expected: roleMap.expectedSpLabel(p.role), actual: null,
            detail: 'no grant of any kind reached the destination item',
          };
          totals.permissionObservations.push(row2);
          totals.permissionMismatches.push(row2);
        }
      } else if (sourcePerms.length > 0) {
        const res = core.comparePermissions(sourcePerms, perms.permissions, mapEmail, { roleMap });
        const scope = core.scopeOf(srcItem);
        // Every compared grant is an observation — matches AND mismatches — because the 4.1–4.4
        // rollup needs to know a position was exercised at all before it can report on it.
        totals.permissionObservations.push(
          ...[...(res.matches || []), ...(res.mismatches || [])]
            .map((o) => ({ ...o, path: srcItem.path, scope }))
        );
        totals.permissionMismatches.push(
          ...(res.mismatches || []).map((m) => ({ ...m, path: srcItem.path, scope }))
        );
        totals.notComparable.push(
          ...(res.notComparable || []).map((n) => ({ ...n, path: srcItem.path }))
        );
        row.permissions = res;

        // Feature 4.5: a grant to a principal outside the source team.
        const external = String(env.DROPBOX_TEST_EXTERNAL_USER || '').toLowerCase();
        if (external && sourcePerms.some((p) => String(p.email).toLowerCase() === external)) {
          totals.externalShares.push({
            path: srcItem.path, principal: external,
            migrated: (perms.permissions || []).some((d) => String(d.email || '').toLowerCase() === mapEmail(external)),
          });
        }
      }

      // ── Features 5.1 / 5.2: shared links, both axes.
      if (env.CONTENT_DEEP_VALIDATE_LINKS) {
        const srcLinks = await dropboxClient.listSharedLinks(srcRef.path, dbxOpts).catch(() => []);
        for (const link of srcLinks || []) {
          const verdict = roleMap.compareSharedLink(link, perms.links);
          const obs = { path: srcItem.path, ...verdict, source: `${link.type || link.audience}/${link.role}` };
          totals.linkObservations.push(obs);
          if (!verdict.match) totals.sharedLinkMismatches.push(obs);
        }
        if ((srcLinks || []).length) row.sharedLinks = srcLinks.length;
      }
    }

    // ── Feature 6.1: metadata. ModifiedTime ONLY.
    //
    // Two independent reasons, either sufficient: Dropbox exposes no creation time on file metadata
    // (dropboxClient.toItem sets createdAt: null), and scope §6.1 states the Graph API supports only
    // ModifiedTime by default — CreatedBy, ModifiedBy and CreatedTime are NOT preserved. Comparing
    // them and failing reports a defect against documented behaviour.
    if (srcItem.type !== 'folder') {
      const ts = core.compareTimestamps(
        { modifiedAt: srcItem.modifiedAt, createdAt: null },
        { modifiedAt: destItem.modifiedAt, createdAt: null },
        bands.timestampDriftMs
      );
      row.timestamps = { ...ts, createdComparable: false };
      if (ts.comparable && ts.modifiedOff) {
        totals.timestampDrift.push({ path: srcItem.path, ...ts });
      }
    }

    // ── Features 3.1 / 3.2: versions.
    if (srcItem.type !== 'folder') {
      const revs = await dropboxClient.listRevisions(srcRef.path, dbxOpts).catch(() => []);
      const destCount = await this.readVersionCount(siteId, destPath, destEmail);

      // Scope §3.1: only versions from the last 180 days migrate, plus the latest regardless of age.
      // A revision older than the window is expected ABSENT — counting it missing fails a correct
      // migration.
      const windowMs = (bands.versionWindowDays || 180) * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - windowMs;
      const inWindow = (revs || []).filter((r) => {
        const t = Date.parse(r.modifiedAt || r.server_modified || '');
        return !Number.isFinite(t) || t >= cutoff;
      });
      const outside = (revs || []).length - inWindow.length;
      if (outside > 0) {
        totals.versionsOutsideWindow.push({ path: srcItem.path, outside, window: bands.versionWindowDays || 180 });
      }

      // Scope §3.1 says "an extra version MAY appear with the migration date/time". Measured, it is
      // not exactly one: `02-root-file-editor.txt` has 3 Dropbox revisions and 6 SharePoint
      // versions, because SharePoint stamps a version for each property write the migration makes
      // (content, then metadata, then permissions). Requiring exactly +1 failed 26 of 26 files on
      // run 39b7813b — every one of which had MORE history at the destination, not less.
      //
      // So the rule is loss-only: fewer versions than the source is a finding, a surplus is the
      // documented system-generated entry and is reported at INFO. That also matches how
      // deepContentCore.compareVersions already treats this — informational, never a verdict.
      const info = core.compareVersions(inWindow.length, destCount, { path: srcItem.path, name: srcItem.name });
      info.expectedExtra = bands.versionExtraAllowed ?? 1;
      info.withinExpected = destCount >= inWindow.length;
      info.surplus = Math.max(0, destCount - inWindow.length);
      totals.versionInfo.push(info);
      row.versions = { source: inWindow.length, dest: destCount, outsideWindow: outside };
    }

    // ── Size.
    if (srcItem.type !== 'folder') {
      const converted = core.isConverted(destItem) || srcItem.isPaper;
      const band = converted ? bands.convertedFileSize : bands.fileSize;
      row.size = core.compareSize(srcItem, destItem, band);
    }

    itemDetails.set(srcItem.path, row);
  }

  /** Turn the per-item accumulations into the named feature checks the checklist matches on. */
  _rollUpItemChecks(push, totals) {
    const permFails = totals.permissionMismatches.length;
    const permSeen = totals.permissionObservations.length;

    // Features 4.1–4.4 are POSITIONS, not one aggregate. A run that only checks the root proves
    // nothing about inheritance, which is why the scope document separates them.
    const byScope = { rootFolder: '4.1', subFolder: '4.2', rootFile: '4.3', innerFile: '4.4' };
    for (const [scope, id] of Object.entries(byScope)) {
      const seen = totals.permissionObservations.filter((o) => o.scope === scope);
      const bad = totals.permissionMismatches.filter((o) => o.scope === scope);
      const label = `${id} ${DROPBOX_SP_FEATURES.find((f) => f.id === id).feature}`;
      const unmapped = (totals.unmappedGrantees || []).filter((o) => o.scope === scope);
      if (seen.length === 0 && unmapped.length > 0) {
        // The distinguishing fact between this pair and dropbox → googleshareddrive. There the
        // destination is the source user's own Google account, so every grantee already exists and
        // the grants land at the same address. Here the destination is a different tenant, and a
        // grantee the run does not map has no identity to receive anything.
        push('WARN', label,
          `Not assessable: ${unmapped.length} source grant(s) at this position name principals with `
          + `no destination identity (${[...new Set(unmapped.map((u) => u.principal))].slice(0, 3).join(', ')}). `
          + 'Add them to the run\'s user mapping to make this feature testable.');
      } else if (seen.length === 0) {
        push('WARN', label, 'No grant at this position was exercised by this run — not assessed');
      } else {
        push(bad.length === 0 ? 'PASS' : 'FAIL', label,
          `${seen.length - bad.length}/${seen.length} grant(s) preserved`);
      }
    }

    if (totals.externalShares.length === 0) {
      push('WARN', '4.5 External Shares',
        'No external grant was present in the source — not assessed. The Dropbox team policy '
        + '"share outside the team" blocks seeding one (cant_share_outside_team).');
    } else {
      const lost = totals.externalShares.filter((e) => !e.migrated);
      push(lost.length === 0 ? 'PASS' : 'FAIL', '4.5 External Shares',
        `${totals.externalShares.length - lost.length}/${totals.externalShares.length} external grant(s) preserved`);
    }

    // "Still settling" is the right reading when SOME items have grants and others do not — CloudFuze
    // applies sharing minutes after PROCESSED. It is the wrong reading when EVERY item came back
    // empty: that is not a race, it is permissions never arriving, and calling it pending hides the
    // most important finding a permissions-focused QA run can produce.
    //
    // Measured on run 39b7813b: every destination item carried only SharePoint's own site groups
    // (QA Members / Owners / Visitors) and not one migrated grant, 40 minutes after the job
    // completed, with withPermissions=true on the job.
    if (totals.permissionsPendingPaths.length && permSeen > 0) {
      push('WARN', 'Permissions still settling',
        `${totals.permissionsPendingPaths.length} item(s) had no destination grants after `
        + `${PERMISSION_SETTLE_ATTEMPTS} attempts, while others did — CloudFuze applies sharing `
        + 'minutes after PROCESSED. Reported as pending, not as a difference.');
    } else if (totals.permissionsPendingPaths.length && permSeen === 0
      && (totals.unmappedGrantees || []).length > 0) {
      // Every grant on those items names a principal with no destination identity, which the 4.1–4.4
      // rows above already report as not assessable. Failing here as well contradicted them in the
      // same report — one line saying "no permission reached the destination", the next saying the
      // feature could not be assessed. Nothing was lost; there was nobody to grant to.
      push('WARN', 'Permissions migrated',
        `Not assessable: all ${(totals.unmappedGrantees || []).length} source grant(s) name principals `
        + 'with no identity in the destination tenant, so CloudFuze had nobody to grant to. Add them '
        + 'to the run\'s user mapping to make features 4.1–4.4 testable.');
    } else if (totals.permissionsPendingPaths.length && permSeen === 0) {
      push('FAIL', 'Permissions migrated',
        `NO permission reached the destination on any of the ${totals.permissionsPendingPaths.length} `
        + 'item(s) that carry grants at the source. Every destination item holds only SharePoint\'s own '
        + 'site groups. This is not settling — with grants present at the source and none at the '
        + 'destination, the migration did not carry permissions.');
    }
    if (permSeen === 0 && totals.permissionsPendingPaths.length === 0) {
      push('WARN', 'Permissions compared', 'No comparable source permissions were found');
    }

    // Features 5.1 / 5.2, split by audience the way the document splits them.
    for (const [id, scope, label] of [
      ['5.1', 'anonymous', 'Shared Links (Anyone with the Link)'],
      ['5.2', 'organization', 'Shared Links (Team Members)'],
    ]) {
      const seen = totals.linkObservations.filter((o) => o.expectedScope === scope);
      const bad = seen.filter((o) => !o.match);
      if (seen.length === 0) {
        push('WARN', `${id} ${label}`, 'No link of this audience was present in the source — not assessed');
      } else {
        push(bad.length === 0 ? 'PASS' : 'FAIL', `${id} ${label}`,
          `${seen.length - bad.length}/${seen.length} link(s) preserved with the right scope and type`);
      }
    }

    // Feature 6.1 — modified only, and say so.
    const drift = totals.timestampDrift.length;
    push(drift === 0 ? 'PASS' : 'FAIL', '6.1 Metadata',
      `Modified timestamps: ${drift === 0 ? 'preserved' : `${drift} outside tolerance`}. `
      + 'CreatedTime / CreatedBy / ModifiedBy are not compared — the Graph API does not preserve them '
      + 'by default (scope §6.1) and Dropbox exposes no file creation time.');

    // Features 3.1 / 3.2 — informational, per the document's own caveats.
    const versioned = totals.versionInfo.filter((v) => v.sourceVersions > 1);
    if (versioned.length === 0) {
      push('WARN', '3.1 Versions', 'No multi-version file was exercised by this run — not assessed');
    } else {
      const lost = versioned.filter((v) => !v.withinExpected);
      const surplus = versioned.filter((v) => v.surplus > 0).length;
      push(lost.length === 0 ? 'PASS' : 'FAIL', '3.1 Versions',
        `${versioned.length - lost.length}/${versioned.length} file(s) kept at least their source `
        + `version count. ${surplus} file(s) carry extra SharePoint versions stamped by the migration `
        + '(documented in scope §3.1 as system-generated, not duplicates). '
        + (totals.versionsOutsideWindow.length
          ? `${totals.versionsOutsideWindow.length} file(s) had revisions older than the 180-day window, expected absent.`
          : ''));
    }

    if (totals.hashedCount > 0) {
      push(totals.hashMismatches.length === 0 ? 'PASS' : 'FAIL', 'File content (Tier B)',
        `${totals.hashedCount} file(s) hashed, ${totals.hashMismatches.length} mismatch(es)`);
    }
  }

  /**
   * Feature 9.1 — Embedded Links.
   *
   * The seeder writes `09-Embedded-Links/document-with-embedded-links.html` holding TWO links:
   * one to a file inside the migration scope, one to a file outside it. Scope §9.1 (and §11.8,
   * which states the condition explicitly) say a link is rewritten to the destination **only when
   * the referenced file was itself migrated** — so the out-of-scope link legitimately still points
   * at Dropbox, and reporting that as a failure would fail a correct migration.
   *
   * HTML is a pass-through format, so the destination file keeps its `.html` extension and its
   * hrefs can be read directly. No docx parsing is needed here, unlike the Drive→SharePoint pair
   * whose equivalent document is a `.docx`.
   */
  async _checkEmbeddedLinks(push, sourceTree, siteId, destEmail, spRootPath, totals) {
    const doc = sourceTree.find((i) => /document-with-embedded-links\.html$/i.test(String(i.path || '')));
    if (!doc) {
      push('WARN', '9.1 Embedded Links', 'No embedded-link document in the source — not assessed');
      return;
    }
    const destPath = core.joinPath(spRootPath, String(doc.path || '').replace(/^\/+/, ''));

    let lines;
    try {
      lines = await this.readTextLines(siteId, destPath, destEmail);
    } catch (err) {
      push('WARN', '9.1 Embedded Links',
        `${destPath} could not be read (${err.message}) — whether its links were rewritten is `
        + 'unverified. Reported rather than assumed either way.');
      return;
    }
    if (!lines || lines.length === 0) {
      push('WARN', '9.1 Embedded Links',
        `${destPath} is empty or unreadable — nothing about its links was observed, so this is not a pass.`);
      return;
    }

    const hrefs = [];
    for (const line of lines) {
      for (const m of String(line).matchAll(/href\s*=\s*["']([^"']+)["']/gi)) hrefs.push(m[1]);
    }
    totals.embeddedLinkTargets = hrefs;

    if (hrefs.length === 0) {
      push('FAIL', '9.1 Embedded Links',
        `${destPath} arrived but holds no hyperlink at all — the source document links to both an `
        + 'in-scope and an out-of-scope target, so the links were dropped in migration.');
      return;
    }

    const stale = hrefs.filter((t) => /dropbox\.com/i.test(t));
    const rewritten = hrefs.filter((t) => /sharepoint\.com/i.test(t) || t.includes('/sites/'));

    if (rewritten.length > 0 && stale.length <= 1) {
      // One surviving Dropbox link is the documented out-of-scope case, not a defect.
      push('PASS', '9.1 Embedded Links',
        `${rewritten.length} link(s) rewritten to the destination`
        + (stale.length ? `; ${stale.length} still points at Dropbox, which is the documented `
          + 'out-of-scope target (its file was not part of the migration)' : ''));
    } else if (rewritten.length === 0) {
      push('FAIL', '9.1 Embedded Links',
        `${destPath} migrated but none of its ${hrefs.length} link(s) were rewritten — a reader is `
        + `sent back to Dropbox instead of the SharePoint copy: ${stale.slice(0, 2).join(' | ')}`);
    } else {
      push('WARN', '9.1 Embedded Links',
        `${rewritten.length} rewritten but ${stale.length} still point at Dropbox, more than the one `
        + 'out-of-scope target the seeder creates. Reported for a human to judge.');
    }
  }

  /**
   * The CSV reports CloudFuze writes into the destination library root.
   *
   * Scope §5.1, §5.2, §8.1 and §9.1 each say a CSV is produced at the destination, and the
   * out-of-scope document says in-line comments arrive the same way. Those files ARE the evidence
   * for those features — the Google pair reads them and this combination did not, which is the
   * mistake the out-of-scope document itself records costing months ("marked not automated — no
   * API for the CSV" while the files sat in the destination the whole time).
   *
   * Three things learned by reading the real files, all of which a naive reader gets wrong:
   *
   *   1. They live at the LIBRARY ROOT, not inside the migrated folder.
   *   2. They are named for the Dropbox member's DISPLAY name ("Erik E shared links.csv",
   *      "Erik E-EmbeddedLinks.csv"), not the account email.
   *   3. **Every combination appends to the same file.** The shared-links CSV held 7,044 rows,
   *      almost all of them `/QA_TeamDrive/…` from the Shared Drive pair. Counting rows without
   *      filtering to this run's source path reports another combination's work as ours.
   */
  async _checkCsvReports(push, siteId, destEmail, sourcePath, totals) {
    let rootItems;
    try {
      rootItems = await this.listChildren(siteId, '/', destEmail);
    } catch (err) {
      push('WARN', 'CloudFuze CSV reports',
        `The destination library root could not be listed (${err.message}) — the CSV evidence for `
        + 'features 5.1, 5.2, 8.1 and 9.1 was not read.');
      return;
    }

    const csvs = (rootItems || []).filter((i) => /\.csv$/i.test(String(i.name || '')));
    if (csvs.length === 0) {
      push('WARN', 'CloudFuze CSV reports',
        'No CSV report was found at the destination library root. Scope §5.1/§5.2/§8.1/§9.1 each '
        + 'say one is written there, so either the migration produced none or they are elsewhere.');
      return;
    }

    // Rows belonging to THIS run: the source path appears in one of the path columns.
    const mine = (lines, needle) => lines.filter((l) => String(l).toLowerCase().includes(needle));
    const needle = String(sourcePath || '').toLowerCase();

    const reports = [
      { match: /shared ?links?\.csv$/i, id: '5.1/5.2', label: 'Shared Links CSV' },
      { match: /embeddedlinks\.csv$/i, id: '9.1', label: 'Embedded Links CSV' },
      { match: /long file names\.csv$/i, id: '8.1', label: 'Long File Names CSV' },
    ];

    for (const r of reports) {
      const hit = csvs.find((c) => r.match.test(String(c.name || '')));
      if (!hit) {
        push('WARN', `${r.id} ${r.label}`,
          `No ${r.label} at the destination root. Present: ${csvs.map((c) => c.name).join(', ')}`);
        continue;
      }
      let lines = [];
      try {
        lines = await this.readTextLines(siteId, `/${hit.name}`, destEmail);
      } catch (err) {
        push('WARN', `${r.id} ${r.label}`, `${hit.name} could not be read (${err.message})`);
        continue;
      }
      const ours = mine(lines.slice(1), needle);
      totals.csvReports.push({ id: r.id, name: hit.name, totalRows: Math.max(0, lines.length - 1), ourRows: ours.length });
      push(ours.length > 0 ? 'PASS' : 'WARN', `${r.id} ${r.label}`,
        ours.length > 0
          ? `${hit.name}: ${ours.length} row(s) for this run (${lines.length - 1} rows total across all combinations)`
          : `${hit.name} exists but holds no row naming ${sourcePath} — this run's items are not in it. `
            + `${lines.length - 1} row(s) belong to other combinations.`);
    }
  }

  /** Feature 7.1 — SharePoint replaces its invalid set; ~ # % & { } are valid and preserved. */
  _checkSpecialCharacters(push, sourceTree, cmp, rules, totals) {
    // Ask the destination rules module directly. core.needsSanitizing() takes no rules argument —
    // it always uses the module default — which happens to be SharePoint and would therefore be
    // right here by accident. Going through `rules` keeps it right on purpose.
    const affected = sourceTree.filter((i) => rules.needsSanitizing(i.name));
    totals.specialChars.total = affected.length;
    if (affected.length === 0) {
      push('WARN', '7.1 Special Character Replacement',
        'No source name contained a character SharePoint replaces — not assessed');
      return;
    }
    const arrived = affected.filter((i) => cmp.matched.has(i.path));
    totals.specialChars.arrived = arrived.length;
    push(arrived.length === affected.length ? 'PASS' : 'FAIL', '7.1 Special Character Replacement',
      `${arrived.length}/${affected.length} name(s) with replaceable characters arrived under their `
      + 'sanitized name. Note ~ # % & { } are VALID in SharePoint and are expected unchanged.');
  }

  /** Feature 8.1 — over 400 encoded characters a placeholder link is the expected outcome. */
  _checkLongPaths(push, sourceTree, cmp, spRootPath, bands, totals) {
    const limit = bands.pathLengthLimit || 400;
    const over = sourceTree.filter((i) =>
      core.exceedsPathLimit(core.joinPath(spRootPath, i.path), limit));
    if (over.length === 0) {
      push('WARN', '8.1 Long Folder/File path',
        `No source item exceeded the ${limit}-character encoded path limit — not assessed`);
      return;
    }
    totals.longPathEvidence = over.map((i) => ({
      path: i.path,
      encodedLength: core.encodedPathLength(core.joinPath(spRootPath, i.path)),
    }));
    const asPlaceholder = over.filter((i) => cmp.placeholderLinks.some((p) => p.path === i.path)).length;
    push(asPlaceholder === over.length ? 'PASS' : 'WARN', '8.1 Long Folder/File path',
      `${over.length} item(s) exceed ${limit} encoded characters; ${asPlaceholder} arrived as the `
      + 'documented placeholder link. CloudFuze also creates a "Long File Names Folder" listing them.');
  }

  /**
   * §11 content fidelity — compare the source Paper against the migrated Word document.
   *
   * Without this, eighteen of the nineteen Paper features reported `na` and nothing was ever
   * inspected. They could not report a false pass, but they were not testing anything either, and
   * Paper is more than half this combination's feature set.
   *
   * Counts, not prose: a converter legitimately rewrites wording and styling, so comparing text
   * would fail every correct migration. What must survive conversion is STRUCTURE — the number of
   * tables, list items, images and emoji. Those are what §11.3, §11.9, §11.12, §11.13 and §11.16
   * describe, and they are stable across a converter.
   */
  async _comparePaperContent(push, paperItem, siteId, destEmail, destPath, dbxOpts, totals) {
    const srcRef = { ...paperItem, path: paperItem.dbxPath || paperItem.path };

    let md = null;
    try {
      md = await dropboxClient.exportPaper(srcRef.path, 'markdown', dbxOpts);
    } catch (err) {
      push('WARN', '11.1b Paper content',
        `The source Paper could not be exported (${err.message}) — its content was not compared. `
        + 'Reported rather than assumed either way.');
      return;
    }

    let buf = null;
    try {
      buf = await this.readContent(siteId, destPath, destEmail);
    } catch (err) {
      push('WARN', '11.1b Paper content',
        `The migrated document at ${destPath} could not be downloaded (${err.message}) — its `
        + 'content was not compared.');
      return;
    }

    const parsed = docxLinks.extractDocxXml(buf);
    if (!parsed.ok) {
      push('WARN', '11.1b Paper content',
        `${destPath} downloaded but could not be read as a Word document (${parsed.reason}). `
        + 'Not a pass: nothing about its content was observed.');
      return;
    }

    const src = paperMarkdownStructure(md);
    const dst = docxStructure(parsed.xml);
    totals.paperStructure = { source: src, dest: dst };

    // Bulleted and numbered collapse into one destination count: WordprocessingML marks both with
    // <w:numPr> and keeps the distinction in a separate numbering part. Comparing the total is
    // honest; claiming to tell them apart from this markup would not be.
    const srcListItems = src.bulleted + src.numbered;

    const rows = [
      ['11.3 Inserted Images', src.images, dst.images],
      ['11.9 Tables', src.tables, dst.tables],
      // Reported under both ids: Word marks bulleted and numbered items with the same <w:numPr>,
      // so the destination total is the only honest comparison, and each feature says so.
      ['11.12 Bulleted List', srcListItems, dst.listItems],
      ['11.13 Numbered List', srcListItems, dst.listItems],
      ['11.16 Emojis', src.emojis, dst.emojis],
    ];
    for (const [label, s, d] of rows) {
      if (s === 0) {
        push('WARN', label, `The source Paper contains none — not assessed`);
      } else if (d >= s) {
        push('PASS', label, `${s} in the source, ${d} at the destination`);
      } else {
        push('FAIL', label, `${s} in the source but only ${d} at the destination — lost in conversion`);
      }
    }

    push(dst.textLength > 0 ? 'PASS' : 'FAIL', '11.1b Paper content',
      dst.textLength > 0
        ? `The migrated Word document holds ${dst.textLength} characters of text`
        : 'The migrated Word document is EMPTY. Note the seeder records a CloudFuze defect where a '
          + 'Paper doc deleted and recreated at the same path arrives empty with a correct filename.');
  }

  /** §11 — Paper. Converted to Word (.docx) here, not to a Google Doc. */
  _checkPaper(push, sourceTree, cmp, totals) {
    const papers = sourceTree.filter((i) => i.isPaper);
    totals.paperSourceCount = papers.length;

    if (papers.length === 0) {
      push('WARN', '11.1 Dropbox Papers Migration',
        'No Dropbox Paper document was present in the source — §11 not assessed');
      return;
    }
    const paired = papers.filter((p) => cmp.matched.has(p.path));
    push(paired.length === papers.length ? 'PASS' : 'FAIL', '11.1 Dropbox Papers Migration',
      `${paired.length}/${papers.length} Paper document(s) arrived. Scope §11.1: Paper converts to `
      + 'Microsoft Word (.docx), so the destination name carries that extension and the bytes are a '
      + 'conversion product — never hashed against the source.');
  }

  /**
   * Roll the named checks up into the document's 36 features.
   *
   * Matches feature ids by regex over the flattened check names, the same approach
   * dropboxToGoogledrive.js uses. The `(^|\] )` anchor matters: _buildResult prefixes each unit's
   * checks with "[tag] ", so an unanchored `^` would match nothing.
   *
   * Two honesty rules, both load-bearing:
   *   WARN never becomes 'pass' — it becomes 'na'.
   *   A feature with no matching check is 'na' with "Not exercised by this run", never 'pass'.
   */
  _buildChecklist(totals, checks) {
    const byName = checks.map((c) => ({ name: String(c.name || ''), status: String(c.status || '') }));
    const worstFor = (re) => {
      const hits = byName.filter((c) => re.test(c.name));
      if (hits.length === 0) return null;
      if (hits.some((h) => h.status === 'FAIL')) return 'fail';
      if (hits.some((h) => h.status === 'WARN')) return 'na';
      return 'pass';
    };
    const anchored = (id) => new RegExp(`(^|\\] )${id.replace('.', '\\.')} `);

    const scanned = totals.scannedSourceItems || 0;

    return DROPBOX_SP_FEATURES.map((f) => {
      // Nothing was read: no feature can be claimed either way.
      if (!scanned) {
        return { ...f, status: 'na', detail: 'No source items were read — nothing was assessed' };
      }

      // 2.1 is not observable from the destination cloud at all.
      if (f.id === '2.1') return { ...f, status: 'na', detail: FOLDER_DISPLAY_NA };

      // 1.2 Delta is a separate migration pass, not part of a one-time run.
      if (f.id === '1.2') {
        return totals.migrationType === 'DELTA'
          ? { ...f, status: worstFor(anchored('1.1')) || 'na', detail: 'Judged by the structure comparison of this delta run' }
          : { ...f, status: 'na', detail: 'This was a one-time migration — delta is a separate pass' };
      }

      // 3.2 Selective Versions: the version count is a job setting, not something the destination
      // reveals. Reported from the version rows rather than judged.
      if (f.id === '3.2') {
        return { ...f, status: 'na',
          detail: 'The number of versions to migrate is a CloudFuze job setting; the destination '
            + 'cannot show which selection was requested. Verify against the job configuration.' };
      }

      // The eight documented Paper deviations carry the document's own wording at INFO.
      if (PAPER_DOCUMENTED[f.id]) {
        return { ...f, status: 'info', detail: PAPER_DOCUMENTED[f.id] };
      }

      // A §11 element THIS run actually compared wins over the generic fallback below. Without
      // this the structural comparison was computed and then thrown away — every 11.x row returned
      // `na` because the fallback ran first.
      if (f.id.startsWith('11.') && f.id !== '11.1') {
        const own = worstFor(anchored(f.id));
        if (own) {
          return { ...f, status: own,
            detail: byName.filter((c) => anchored(f.id).test(c.name)).map((c) => c.name).join('; ') };
        }
      }

      // The remaining §11 rows depend on Paper having paired at all.
      if (f.id.startsWith('11.') && f.id !== '11.1') {
        if (!totals.paperSourceCount) {
          return { ...f, status: 'na', detail: 'No Paper document in the source — not assessed' };
        }
        const paperStatus = worstFor(anchored('11.1'));
        return { ...f, status: 'na',
          detail: paperStatus === 'pass'
            ? 'The Paper document migrated; this element was not individually compared by this run. '
              + 'Verify in the destination .docx.'
            : 'The Paper document did not pair, so its elements could not be assessed' };
      }

      const status = worstFor(anchored(f.id));
      return status
        ? { ...f, status, detail: byName.filter((c) => anchored(f.id).test(c.name)).map((c) => c.name).join('; ') }
        : { ...f, status: 'na', detail: 'Not exercised by this run' };
    });
  }

  /** The agent result the orchestrator, PDF generator and UI all read. */
  _buildResult(globalChecks, perUser, totals, context) {
    const flat = [
      ...globalChecks,
      ...perUser.flatMap((u) => {
        const tag = u.sourceEmail || 'unit';
        return (u.checks || []).map((c) => ({ ...c, name: `[${tag}] ${c.name}` }));
      }),
    ];

    const featureChecklist = totals.enabled ? this._buildChecklist(totals, flat) : [];
    const tally = featureChecklist.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    totals.featureChecklist = featureChecklist;
    totals.featureSummary = featureChecklist.length
      ? `${tally.pass || 0} pass · ${tally.fail || 0} fail · ${tally.na || 0} na · ${tally.info || 0} info`
      : null;
    totals.summary = `${totals.scannedSourceItems || 0} source items scanned, ${totals.pairedCount || 0} paired`;

    // A run that paired nothing is a FAILURE, whatever CloudFuze said and whatever the checks show.
    // This is the guard the whole repo exists for: "the run completed" is never a pass.
    const pairedNothing = Boolean(totals.enabled) && !(totals.pairedCount > 0);
    const overallStatus = pairedNothing || flat.some((c) => c.status === 'FAIL')
      ? 'FAIL'
      : flat.some((c) => c.status === 'WARN') ? 'WARN' : 'PASS';

    if (pairedNothing) {
      flat.push({
        name: 'Migration outcome',
        status: 'FAIL',
        detail: 'No source item was paired to a destination item — nothing was validated. '
          + 'No feature can be reported as passing on this run.',
      });
    }

    return {
      status: overallStatus,
      overallStatus,
      domain: 'content',
      sourceProvider: 'dropbox',
      destinationProvider: context?.destinationProvider || 'sharepoint',
      combination: COMBINATION,
      checks: flat,
      perUser,
      featureChecklist,
      featureSummary: totals.featureSummary,
      deepContentValidation: totals,
      summary: totals.summary,
    };
  }
}

module.exports = DropboxToSharepointValidationAgent;
module.exports.DROPBOX_SP_FEATURES = DROPBOX_SP_FEATURES;
module.exports.PAPER_DOCUMENTED = PAPER_DOCUMENTED;
module.exports.COMBINATION = COMBINATION;
