'use strict';

/**
 * Deep validation for content: Citrix ShareFile → SharePoint Online.
 *
 * Edit ONLY this file to change ShareFile → SharePoint behaviour. Provider-agnostic comparison logic
 * lives in validation/shared/deepContentCore.js; the numbers live in
 * utils/contentTolerance/sharefileToSharepoint.js; the destination side lives in
 * agents/sharepoint/SharePointValidationAgent.js and is reused, never copied.
 *
 * Feature coverage (backend/data/feature-scope/sharefile-to-sharepoint-inscope.md — 11 features):
 *   Tier A — 1.1 structure, 5.1 special characters, 6.1 long paths
 *   Tier B — file content hashes, backing 1.1
 *   Tier C — 3.1 metadata, 4.1 version history, 7.1 suppressed notifications
 *   NOT ASSESSED — 2.1–2.4 permissions. See below.
 *
 * ── Two deliberate differences from every sibling combination ──────────────────────────────────
 *
 * 1. PERMISSIONS ARE NOT ASSESSED. The feature document publishes no ShareFile-role → SharePoint-role
 *    mapping, and ShareFile grants access as independent per-item flags (download / upload / delete /
 *    manage) that do not translate onto Read / Edit / Full Control. Rather than guess,
 *    validation/roleMaps/sharefile_to_sharepoint.js reports every grant as not comparable, and
 *    features 2.1–2.4 come back `na` with the reason. Decided by the combination owner on 2026-09-09.
 *    Read that file's header before changing this.
 *
 * 2. NOTHING CAN BE A KNOWN LIMITATION. No out-of-scope document exists for this combination, so
 *    there is no documented platform behaviour to excuse a mismatch against. Every real mismatch is a
 *    defect or unknown. This errs toward false failures rather than false passes, which is the
 *    correct direction — see sharefile-to-sharepoint-outscope.md.
 *
 * Features NOT in this combination's scope and therefore never validated here: Delta migration,
 * file-level permissions, shared links, embedded links, in-line comments, selective versions, folder
 * display, and file conversion. Do not add one because a sibling combination has it.
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 */

const SharePointValidationAgent = require('../../../agents/sharepoint/SharePointValidationAgent');
const sharefileClient = require('../../../clients/sharefileClient');
const { OUT_OF_SCOPE } = require('../../../agents/sharefile/ShareFileTestDataAgent');
const docxLinks = require('../../../utils/docxLinks');
const core = require('../../shared/deepContentCore');
// Only summarizeChecklist is reused — the 38-feature rollup beside it belongs to a different
// combination's document. See buildShareFileChecklist below.
const { summarizeChecklist } = require('../../shared/contentFunctionalityChecklist');
const tolerance = require('../../../utils/contentTolerance');
const roleMaps = require('../../roleMaps');
const env = require('../../../config/env');
const logger = require('../../../utils/logger');
const executionService = require('../../../services/executionService');

const COMBINATION = 'sharefile_to_sharepoint';

/**
 * Zip-based Office formats. SharePoint rewrites these on ingest; every other format this
 * combination seeds (pdf, png, jpg, csv, txt, zip) arrives byte-identical.
 */
const OOXML_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm']);

/**
 * Did every part the SOURCE document had survive to the destination, byte for byte?
 *
 * An OOXML file is a zip of parts. SharePoint adds its own on ingest and rewrites the two index
 * parts to register them, so the archives differ while the document does not. Comparing the parts
 * the source actually had answers the real question — "is my content intact?" — where a hash of the
 * whole zip cannot.
 *
 * `[Content_Types].xml` and `_rels/.rels` are excluded from the comparison BY NAME and for one
 * reason only: they are indexes, and they necessarily change when parts are added. They are still
 * required to be PRESENT. Every other source part must match exactly.
 *
 * jszip is already a dependency (no new package). A file that will not open as a zip is reported as
 * such rather than silently passing — an unreadable archive is a finding, not an absence of one.
 */
async function compareOoxmlParts(srcBuf, dstBuf) {
  const JSZip = require('jszip');
  /**
   * INDEX parts, not content parts.
   *
   * An OOXML package keeps its part list in `[Content_Types].xml` and its cross-references in
   * `.rels` files — one beside each part that references others: `_rels/.rels`,
   * `word/_rels/document.xml.rels`, `xl/_rels/workbook.xml.rels`,
   * `ppt/_rels/presentation.xml.rels`. When SharePoint adds its customXml parts on ingest it MUST
   * register them in these, so they necessarily differ while the document does not.
   *
   * Matching only the two top-level ones left four files failing: measured on sample-format.xlsx
   * and .pptx, the ONLY altered part was the workbook/presentation rels file, with nothing missing
   * and no worksheet or slide touched. Every `.rels` is therefore treated as an index — and which
   * ones changed is REPORTED, not silently ignored, because a rels file is still the right place to
   * look if a document ever arrives broken.
   */
  const isIndexPart = (name) => name === '[Content_Types].xml'
    || /(^|\/)_rels\/[^/]+\.rels$/.test(name);

  let src;
  let dst;
  try {
    [src, dst] = await Promise.all([JSZip.loadAsync(srcBuf), JSZip.loadAsync(dstBuf)]);
  } catch (err) {
    return { ok: false, reason: `not readable as an Office archive: ${err.message}` };
  }

  const srcNames = Object.keys(src.files).filter((n) => !src.files[n].dir);
  const missing = [];
  const altered = [];
  const indexChanged = [];

  for (const name of srcNames) {
    const destEntry = dst.files[name];
    if (!destEntry || destEntry.dir) {
      missing.push(name);
      continue;
    }
    if (isIndexPart(name)) {
      const [a, b] = await Promise.all([src.files[name].async('nodebuffer'), destEntry.async('nodebuffer')]);
      if (!a.equals(b)) indexChanged.push(name);
      continue;
    }
    const [a, b] = await Promise.all([src.files[name].async('nodebuffer'), destEntry.async('nodebuffer')]);
    if (!a.equals(b)) altered.push(name);
  }

  const added = Object.keys(dst.files)
    .filter((n) => !dst.files[n].dir && !src.files[n]);

  if (missing.length > 0 || altered.length > 0) {
    return {
      ok: false,
      missing,
      altered,
      added,
      reason: [
        missing.length ? `${missing.length} source part(s) missing: ${missing.slice(0, 3).join(', ')}` : '',
        altered.length ? `${altered.length} source part(s) altered: ${altered.slice(0, 3).join(', ')}` : '',
      ].filter(Boolean).join('; '),
    };
  }
  return {
    ok: true,
    added,
    indexChanged,
    srcParts: srcNames.length,
    destParts: Object.keys(dst.files).length,
  };
}

class SharefileToSharepointValidationAgent extends SharePointValidationAgent {
  static supportsDeepValidation = true;

  constructor() {
    super('SharefileToSharepointValidationAgent');
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    const bands = tolerance.forCombination(COMBINATION) || {};
    const rmap = roleMaps.forCombination(COMBINATION);
    const checks = [];
    const push = (status, name, detail) => checks.push({ name, status, detail });

    if (!env.ENABLE_DEEP_CONTENT_VALIDATION) {
      push('WARN', 'Deep content validation',
        'Disabled by ENABLE_DEEP_CONTENT_VALIDATION=false — nothing was compared');
      return buildResult(checks, null);
    }

    // ── Source reachability ───────────────────────────────────────────────────
    // Checked before anything else and reported as its own check: an unreachable source makes every
    // later "missing at destination" row meaningless, and a run that proves nothing must say so
    // rather than emit a wall of failures.
    const srcAccount = context.sourceEmail;
    if (!sharefileClient.isConfigured(srcAccount)) {
      push('FAIL', 'ShareFile source reachable',
        'ShareFile is not usable — set SHAREFILE_CLIENT_ID and SHAREFILE_CLIENT_SECRET in the root '
        + '.env, then connect the account under Connect Clouds → Content → Citrix ShareFile. '
        + 'Nothing was compared.');
      return buildResult(checks, null);
    }

    const probe = await sharefileClient.verifyConnection(srcAccount);
    if (probe.errors.length > 0 || !probe.root) {
      push('FAIL', 'ShareFile source reachable',
        `Could not read the ShareFile account: ${probe.errors.join('; ') || 'no root returned'}. `
        + 'Nothing was compared.');
      return buildResult(checks, null);
    }
    push('PASS', 'ShareFile source reachable',
      `account ${probe.account} on ${probe.host}, root "${probe.root.name}", ${probe.childCount} top-level item(s)`);

    // ── Read the source tree ──────────────────────────────────────────────────
    // The folder this RUN migrated, not a fixed setting — otherwise the validator reads one folder
    // while the migration moved another, and reports every item missing.
    const sourceRootPath = String(
      context.sourceTestDataPath
      || (Array.isArray(context.userFolderMappings) && context.userFolderMappings[0]
        && context.userFolderMappings[0].sourcePath)
      || (Array.isArray(context.contentUserFolders) && context.contentUserFolders[0]
        && context.contentUserFolders[0].sourceFolderName)
      || context.sourceFolderName
      || env.SHAREFILE_TEST_ROOT
      || '/QA-Automation'
    ).trim();
    let sourceItems = [];
    try {
      const root = await sharefileClient.getRoot(srcAccount);
      const seedRootName = sourceRootPath.replace(/^\/+/, '');
      const top = await sharefileClient.listChildren(srcAccount, root.id, '');
      const seedRoot = top.find((i) => i.type === 'folder' && core.namesMatch(i.name, seedRootName));

      if (!seedRoot) {
        push('FAIL', 'ShareFile seeding root resolved',
          `No folder "${seedRootName}" at the ShareFile account root. Available: `
          + `${top.map((i) => i.name).slice(0, 10).join(', ') || '(empty)'}. `
          + 'Check the source folder named in the run, or SHAREFILE_TEST_ROOT as the fallback.');
        return buildResult(checks, null);
      }

      const walk = await sharefileClient.buildFolderTree(srcAccount, seedRoot.id, {
        rootPath: seedRoot.path,
        maxDepth: bands.treeDepth || 25,
      });
      sourceItems = core.relativize(walk.items, seedRoot.path);

      push('PASS', 'ShareFile seeding root resolved', `"${seedRoot.name}" (${sourceItems.length} item(s))`);
      if (walk.truncatedAt.length > 0) {
        // Reported, never silent: a truncated walk makes un-walked items look missing.
        push('WARN', 'Source tree fully walked',
          `Depth cap ${bands.treeDepth || 25} reached at ${walk.truncatedAt.length} path(s) — those `
          + 'subtrees were NOT read and their items are not counted. Raise treeDepth in '
          + 'utils/contentTolerance/sharefileToSharepoint.js.');
      }
    } catch (err) {
      push('FAIL', 'ShareFile seeding root resolved', `Source read failed: ${err.message}`);
      return buildResult(checks, null);
    }

    if (sourceItems.length === 0) {
      push('FAIL', 'Source items scanned',
        `The ShareFile folder "${sourceRootPath}" is empty — there is nothing to validate. `
        + 'Seed it before running.');
      return buildResult(checks, null);
    }

    // ── Resolve the destination ───────────────────────────────────────────────
    let site;
    let destRootPath;
    try {
      // Derive the SharePoint host from the DESTINATION ACCOUNT, not from a fixed setting.
      //
      // resolveSite falls back to env.SHAREPOINT_HOSTNAME, which is a single hardcoded tenant. That
      // silently breaks the moment a run picks a destination account in a different tenant: CloudFuze
      // writes where the chosen cloud lives while the validator reads the configured host, and all
      // 156 items report missing. A catastrophic-looking result from a correct migration.
      //
      // The destination email is the account the user actually chose, so its own tenant is the right
      // place to read. env.SHAREPOINT_HOSTNAME stays the fallback for when Graph cannot tell us.
      if (!context.sharepointHostname && context.destinationEmail) {
        try {
          const sharepointClient = require('../../../clients/sharepointClient');
          const derived = await sharepointClient.resolveTenantHostname(context.destinationEmail);
          if (derived) {
            if (env.SHAREPOINT_HOSTNAME && derived !== env.SHAREPOINT_HOSTNAME) {
              log.info(`[sharefile→sharepoint] destination ${context.destinationEmail} lives on `
                + `${derived}, not the configured ${env.SHAREPOINT_HOSTNAME} — using the account's own `
                + 'tenant so the validator reads where CloudFuze wrote');
            }
            context.sharepointHostname = derived;
          }
        } catch (hostErr) {
          log.warn(`[sharefile→sharepoint] could not derive the SharePoint host for `
            + `${context.destinationEmail} (${hostErr.message}) — falling back to `
            + `${env.SHAREPOINT_HOSTNAME || '(unset)'}`);
        }
      }

      site = await this.resolveSite(context);
      // resolveSite returns { siteId, hostname, sitePath } — NOT `id`. It also returns
      // siteId: null rather than throwing when the site cannot be resolved, so a truthiness check
      // is required: reading `.id` yielded undefined and every later call received undefined as the
      // site, failing far from the cause.
      if (!site?.siteId) {
        push('FAIL', 'SharePoint site accessible',
          `Could not resolve ${site?.hostname || '(no host)'}${site?.sitePath || ''}. `
          + 'Check SHAREPOINT_HOSTNAME and SHAREPOINT_SITE_PATH, and that the destination account '
          + 'can see that site. Nothing was compared.');
        return buildResult(checks, null);
      }
      push('PASS', 'SharePoint site accessible', `${site.hostname}${site.sitePath}`);
    } catch (err) {
      push('FAIL', 'SharePoint site accessible', err.message);
      return buildResult(checks, null);
    }

    try {
      const seedLeaf = sourceRootPath.replace(/^\/+/, '');
      // findMigratedRoot returns { item, path, renameNote } — NOT a path string. Testing the object
      // for falsiness always passed, so a run whose destination folder did not exist reported
      // "Destination location found: PASS" and then handed the OBJECT to readTree as a path. The
      // read silently landed on the drive root and matched a handful of unrelated items, which is
      // the worst possible failure: a wrong answer that looks like a partial success.
      // inDrivePath, NOT the raw destinationPath. CloudFuze content mappings for SharePoint are
      // written as "<Site>/<Library>/<subpath>" — the wizard's "/QA/Documents" names the QA site's
      // Documents LIBRARY, which in Graph is the drive ROOT, not a folder called "QA" holding a
      // folder called "Documents".
      //
      // Passing it raw made this search a folder that does not exist: run 46376fe5 migrated 202 of
      // 202 items successfully and landed "QA-Automation" at the library root, while the report said
      // "Could not locate the migrated QA-Automation folder" and failed the whole run. Reading
      // /QA on the live site returns 0 items and /QA/Documents returns 404, which is what the
      // validator was looking at.
      //
      // CleanupAgent (line ~434) and AgentOrchestrator's pre-create (line ~865) already convert the
      // path this way. This was the only one of the three that did not, so the side that WRITES and
      // the side that READS disagreed about where the data lives.
      const destBase = core.inDrivePath(context.destinationPath || '');
      const found = await this.findMigratedRoot(
        site.siteId, destBase === '/' ? '' : destBase, seedLeaf, context.destinationEmail
      );
      destRootPath = found?.path || null;
      if (!destRootPath) {
        push('FAIL', 'Destination location found',
          `Could not locate the migrated "${seedLeaf}" folder in ${site.hostname}${site.sitePath}. `
          + 'Either the migration moved nothing, or it landed somewhere other than the expected path.');
        return buildResult(checks, null);
      }
      push('PASS', 'Destination location found',
        destRootPath + (found.renameNote ? ` (${found.renameNote})` : ''));
    } catch (err) {
      push('FAIL', 'Destination location found', err.message);
      return buildResult(checks, null);
    }

    // ── Read the destination tree ─────────────────────────────────────────────
    let destItems = [];
    try {
      const raw = await this.readTree(site.siteId, destRootPath, context.destinationEmail, bands.treeDepth || 25);
      destItems = core.relativize(raw, destRootPath);
    } catch (err) {
      push('FAIL', 'Destination tree read', err.message);
      return buildResult(checks, null);
    }

    // ── Feature 1.1 / 5.1 / 6.1 — Tier A structure, names, paths ─────────────
    //
    // compareTrees returns `matched` as a Map<sourcePath, {source, dest}> — NOT an array named
    // `paired`, and there are no `renamed` / `relocated` flags on the entries. Renames and
    // path-limit relocations are surfaced as their own arrays (`misplaced`, `placeholderLinks`,
    // `notMigratable`), which is why each feature below reads its own array rather than filtering
    // one list of pairs.
    const tree = core.compareTrees(sourceItems, destItems, {
      destPrefix: destRootPath,
      pathLimit: bands.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit,
    });
    // ── Reconcile the DOCUMENTED destination renames before anything reads the tree ──────────
    //
    // deepContentCore pairs names by character replacement and format conversion. SharePoint does
    // three more things to a name, and it does all of them correctly — but the pairing does not
    // know the rules, so each renamed item arrived as `missing` AND as `extra` at the same time.
    // Run 46376fe5 migrated 202 of 202 items and the report still failed, claiming 10 items lost
    // and 10 unexplained extras: one cause wearing two contradictory verdicts, which is precisely
    // the trap the Shared Drive field report names.
    //
    // All three rules were MEASURED on the live destination after that run, not assumed:
    //
    //   reserved-underscore   aux → _aux, con → _con, desktop.ini → _desktop.ini,
    //                         and forms → forms_ (SUFFIX, not prefix — the rule is not uniform)
    //   space-trimmed         "trailing-space-file .txt" → "trailing-space-file.txt"
    //   truncated             a 220-character name → 97 characters, extension preserved
    //
    // Each pairing records WHICH rule explained it, so a future destination change shows up as an
    // unexplained item rather than being absorbed silently. Pairing requires the same parent AND
    // the same item type, so a rule cannot reach across the tree and invent a match.
    //
    // Done HERE rather than in deepContentCore, which is shared with box → sharepoint and
    // googledrive → sharepoint.
    const documentedRenames = [];
    {
      const lower = (v) => String(v || '').toLowerCase();
      const parentOf = (v) => String(v || '').replace(/\/[^/]+$/, '');
      const stemOf = (n) => {
        const i = String(n).lastIndexOf('.');
        return i > 0 ? String(n).slice(0, i) : String(n);
      };
      const extOf = (n) => {
        const i = String(n).lastIndexOf('.');
        return i > 0 ? String(n).slice(i) : '';
      };
      const squashSpace = (n) => lower(n).replace(/\s+/g, '');

      const RULES = [
        {
          id: 'reserved-underscore',
          test: (m, e) => core.isReservedName(m.name)
            && (lower(e.name) === `_${lower(m.name)}` || lower(e.name) === `${lower(m.name)}_`),
        },
        {
          id: 'space-trimmed',
          test: (m, e) => m.name !== e.name && squashSpace(m.name) === squashSpace(e.name),
        },
        {
          // The destination's per-segment limit is 255 characters and it truncates rather than
          // dropping. `truncationMatchMin` (60) is the shortest prefix this repo already accepts as
          // "the truncated form of that name", so the same floor is used instead of a new constant.
          id: 'truncated',
          test: (m, e) => lower(extOf(m.name)) === lower(extOf(e.name))
            && stemOf(e.name).length >= (bands.truncationMatchMin || 60)
            && lower(stemOf(m.name)).startsWith(lower(stemOf(e.name)))
            && stemOf(m.name).length > stemOf(e.name).length,
        },
      ];

      const remainingExtra = [...(tree.extra || [])];
      const stillMissing = [];
      for (const miss of tree.missing) {
        let paired = null;
        for (const rule of RULES) {
          const idx = remainingExtra.findIndex(
            (e) => e.type === miss.type
              && lower(parentOf(e.path)) === lower(parentOf(miss.path))
              && rule.test(miss, e)
          );
          if (idx !== -1) {
            paired = { rule: rule.id, dest: remainingExtra.splice(idx, 1)[0] };
            break;
          }
        }
        if (!paired) {
          stillMissing.push(miss);
          continue;
        }
        documentedRenames.push({
          rule: paired.rule, from: miss.name, to: paired.dest.name, path: miss.path,
        });
        tree.matched.set(miss.path, { source: miss, dest: paired.dest });
      }
      tree.missing = stillMissing;
      tree.extra = remainingExtra;
      tree.matchedCount = tree.matched.size;

      if (documentedRenames.length > 0) {
        const byRule = {};
        for (const r of documentedRenames) byRule[r.rule] = (byRule[r.rule] || 0) + 1;
        log.info('[sharefile→sharepoint] paired by documented rename rules — '
          + Object.entries(byRule).map(([k, v]) => `${k}: ${v}`).join(', '));
      }
    }

    const pairs = [...tree.matched.values()];

    push(tree.missing.length === 0 ? 'PASS' : 'FAIL', '1. File/folder structure preserved',
      tree.missing.length === 0
        ? `${tree.matchedCount} of ${tree.totalSource} source item(s) matched, none missing`
        : `${tree.missing.length} of ${tree.totalSource} source item(s) not found at the destination: `
          + `${tree.missing.slice(0, 5).map((m) => m.path).join(', ')}`);

    // Placeholder artifacts are CloudFuze's own .url stubs for relocated content — expected, and
    // separated from genuinely unexplained extras so they are not reported as junk.
    if (tree.extra?.length > 0) {
      push('WARN', '1. No unexpected destination items',
        `${tree.extra.length} destination item(s) with no source counterpart: `
        + `${tree.extra.slice(0, 5).map((m) => m.path).join(', ')}`);
    }
    // Items paired under a DIFFERENT parent than the source path predicted.
    //
    // Reported because they are the arithmetic that makes the structure check add up: 201 scanned
    // and 176 matched is only reassuring once the other 25 are named. Most are the children of a
    // folder the destination renamed — every file under "aux" now lives under "_aux", so its parent
    // path no longer matches and compareTrees files it here rather than under `matched`.
    //
    // The reference to this list was lost when feature 5.1 was rewritten, and with it the only
    // mention of 25 of the 201 items. A validator that silently drops a quarter of the tree is the
    // same failure as one that passes without checking.
    if (tree.misplaced?.length > 0) {
      push('WARN', '1. Items under a renamed parent',
        `${tree.misplaced.length} item(s) were found at the destination under a different parent than `
        + 'their source path predicted. Expected for anything inside a folder the destination renamed '
        + '(a file under "aux" arrives under "_aux"). Verify by eye if the count looks high: '
        + tree.misplaced.slice(0, 3).map((m) => `"${m.source}" → "${m.dest}"`).join('; '));
    }

    if (tree.placeholderArtifacts?.length > 0) {
      push('PASS', '1. Placeholder artifacts recognised',
        `${tree.placeholderArtifacts.length} placeholder link file(s) at the destination — expected `
        + 'for content relocated past the path limit, not counted as unexplained extras.');
    }

    // Feature 5.1 — special character replacement.
    //
    // Both branches of this check used to push PASS, so 5.1 could not fail for any input. That is
    // the same defect the Shared Drive combination shipped on feature 4.1 (a FAIL branch nothing
    // could reach, printing "preserved on 37 files" regardless of the data). A verdict no data can
    // overturn is not a check.
    //
    // The subjects are now COMPUTED rather than assumed, and the computation says something
    // uncomfortable: `03-Special-Characters` cannot exercise this feature at all. Its 19 characters
    // (# % & { } ~ ^ $ @ ! + = ' ; , [ ] ( )) are all ACCEPTED by SharePoint — verified against
    // destinations/sharepoint.js, whose invalid set is " * : < > ? / \ | — while ShareFile strips
    // every character in that invalid set on write (verified on the live tenant). The intersection
    // is EMPTY: no character can be both stored by this source and replaced by this destination.
    // Those files still earn their place as structure and content subjects; they just cannot judge
    // 5.1, and a PASS read off them claimed a check nobody ran.
    //
    // RESERVED NAMES are the part that IS exercisable. `con`, `nul`, `aux`, `prn`, `forms` and
    // `desktop.ini` are stored by ShareFile (probed live on 2026-09-11) and reserved by SharePoint,
    // so a correct migration must rename them. The seeder plants them for exactly this check.
    const renameSubjects = sourceItems.filter(
      (s) => core.expectedDestName(s.name, s.mimeType) !== s.name || core.isReservedName(s.name)
    );

    if (renameSubjects.length === 0) {
      push('WARN', '5. Special character replacement',
        'NOT EXERCISED — no seeded name requires replacement at a SharePoint destination. Every '
        + 'character SharePoint replaces (" * : < > ? / \\ |) is stripped by ShareFile on write, so '
        + 'it can never reach the destination to be replaced. Seed reserved names (con, nul, forms, '
        + 'desktop.ini) to exercise this feature; reporting PASS here would claim a check that had '
        + 'no subject.');
    } else {
      const lost = [];
      const renamed = [];
      const acceptedAsIs = [];
      for (const subject of renameSubjects) {
        const pair = pairs.find((x) => x.source?.path === subject.path);
        if (!pair?.dest) {
          lost.push(subject.path);
          continue;
        }
        const destName = pair.dest.name;
        if (destName !== subject.name) {
          renamed.push(`"${subject.name}" → "${destName}"`);
        } else {
          // Present, unchanged. NOT a defect: it means SharePoint accepted a name our rule set
          // calls illegal, so the rule set is stricter than the platform enforces. Failing here
          // would report a CloudFuze defect against behaviour the scope document never promised —
          // the mistake the Shared Drive combination had to retract on embedded links.
          acceptedAsIs.push(subject.name);
        }
      }

      push(lost.length === 0 ? 'PASS' : 'FAIL', '5. Special character replacement',
        lost.length === 0
          ? `${renameSubjects.length} name(s) needed replacement; all arrived. `
            + (renamed.length > 0
              ? `${renamed.length} renamed as documented: ${renamed.slice(0, 3).join('; ')}. `
              : '')
            + (acceptedAsIs.length > 0
              ? `${acceptedAsIs.length} arrived unchanged (${acceptedAsIs.slice(0, 3).join(', ')}) — `
                + 'SharePoint accepted a name this repo classes as reserved, so our rule set is '
                + 'stricter than the platform. Reported, not a defect.'
              : '')
          : `${lost.length} of ${renameSubjects.length} name(s) needing replacement are ABSENT from `
            + `the destination: ${lost.slice(0, 5).join(', ')}. A name the destination cannot hold `
            + 'must be renamed, never dropped.');
    }

    // Feature 6.1 — long paths.
    //
    // Read `placeholderLinks` carefully before trusting it. In deepContentCore, a source item that
    // is over the path limit AND absent from the destination is moved out of `missing` and into
    // `placeholderLinks` with the reason "a placeholder link URL is expected in its place" — the
    // word is EXPECTED, and nothing verifies one was written. So an over-limit branch that simply
    // never migrated is excluded from `missing` (1.1 then passes) and described here as documented
    // behaviour. Between them the two checks would report the loss of every deep item as correct.
    //
    // That reclassification lives in shared code used by box → sharepoint and googledrive →
    // sharepoint, so it is not changed here. The verification is done in this combination instead:
    // an entry that names no `relocatedTo` is only explained if a placeholder artifact actually
    // exists at the destination.
    const relocated = tree.placeholderLinks || [];
    if (relocated.length === 0) {
      push('WARN', '6. Long file/folder path',
        `NOT EXERCISED — no source path exceeded the ${bands.pathLengthLimit}-character destination `
        + 'limit, so nothing tested the adjustment rule. The seeder plants a 30-level tree for this; '
        + 'if that tree was seeded, its absence here is itself the finding.');
    } else {
      const movedTo = relocated.filter((r) => r.relocatedTo);
      const unexplained = relocated.filter((r) => !r.relocatedTo);
      const artifacts = tree.placeholderArtifacts || [];

      if (unexplained.length > 0 && artifacts.length === 0) {
        push('FAIL', '6. Long file/folder path',
          `${unexplained.length} item(s) over the ${bands.pathLengthLimit}-character limit are absent `
          + 'from the destination AND no placeholder link file was written anywhere in the tree. '
          + 'Over-limit content is documented to be relocated with a placeholder left behind; with '
          + 'neither present the content is simply gone: '
          + unexplained.slice(0, 3).map((r) => `${r.path} (${r.encodedLength} chars)`).join(', '));
      } else {
        // Shared Drive → SharePoint proved relocated content LOSES ITS SHARING (defects 11.1/11b).
        // Permissions are not assessed on this combination, so that check cannot be made here — say
        // so rather than implying relocation was fully verified.
        push('WARN', '6. Long file/folder path',
          `${relocated.length} item(s) over the ${bands.pathLengthLimit}-character limit were handled `
          + `as documented — ${movedTo.length} relocated to a shorter path, `
          + `${unexplained.length} represented by ${artifacts.length} placeholder link file(s). `
          + 'Whether they KEPT THEIR SHARING is not verified here (permissions are not assessed for '
          + 'this combination), and on Shared Drive → SharePoint relocated content was confirmed to '
          + 'lose it. Check by hand: '
          + relocated.slice(0, 3).map((r) => r.path).join(', '));
      }
    }

    if (tree.notMigratable?.length > 0) {
      push('WARN', '6. Items the destination cannot hold',
        `${tree.notMigratable.length} item(s) reported as not migratable: `
        + tree.notMigratable.slice(0, 3).map((n) => n.path || n.name).join(', '));
    }

    // ── Feature 3.1 — Metadata ────────────────────────────────────────────────
    //
    // Uses deepContentCore's own comparator rather than the hand-rolled drift check that was here.
    // Both siblings (googledrive → sharepoint, dropbox → sharepoint) call it, it compares CREATED as
    // well as MODIFIED, and reusing it means one definition of "preserved" across the product.
    //
    // This check reported "not assessed" on every run, and the cause was not the comparison: the
    // SOURCE carried `modifiedAt: null`. ShareFile does not populate `ClientModifiedDate` — it
    // populates `ProgenyEditDate`, verified against the live API — so sharefileClient now falls back
    // to it. Without that fix this block is honest but useless; with it, 3.1 finally has data.
    const tsDrift = [];
    let tsChecked = 0;
    for (const pair of pairs) {
      if (pair.source?.type !== 'file') continue;
      const res = core.compareTimestamps(pair.source, pair.dest, bands.timestampDriftMs || 300000);
      if (!res.comparable) continue;
      tsChecked += 1;
      if (!res.match) {
        tsDrift.push(`${pair.source.path}: `
          + `${res.modifiedOff ? `modified ${res.sourceModified} → ${res.destModified}` : ''}`
          + `${res.modifiedOff && res.createdOff ? '; ' : ''}`
          + `${res.createdOff ? `created ${res.sourceCreated} → ${res.destCreated}` : ''}`);
      }
    }
    if (tsChecked === 0) {
      push('WARN', '3. Metadata (timestamps preserved)',
        'No file carried comparable timestamps on both sides — not assessed');
    } else {
      push(tsDrift.length === 0 ? 'PASS' : 'FAIL', '3. Metadata (timestamps preserved)',
        tsDrift.length === 0
          ? `${tsChecked} file(s) within ${(bands.timestampDriftMs || 300000) / 1000}s on both created `
            + 'and modified'
          : `${tsDrift.length} of ${tsChecked} file(s) outside the allowed drift: `
            + tsDrift.slice(0, 3).join(' | '));
    }

    // ── Feature 4.1 — Version History ─────────────────────────────────────────
    //
    // The source cannot be counted, and that is ShareFile's limit rather than ours. Probed against
    // the live API on 2026-09-11: `/Items(id)/PreviousVersions` and `/Items(id)/Versions` both 404,
    // and `?$expand=Versions` returns no version collection — the only version information ShareFile
    // exposes on this account is the boolean `HasMultipleVersions`. So "source had 11, destination
    // has 20" is not a sentence this combination can honestly write.
    //
    // What it CAN prove is the defect that matters: a file that had history at the source arriving
    // with none. The destination count reads fine (ten-versions.docx → 20, three-versions.txt → 6 —
    // twice the seeded counts, exactly as figure 4.1.1 predicts, because CloudFuze writes a
    // "SharePoint App" placeholder beside each real version).
    //
    // An exact source count is still attempted, so the day ShareFile starts serving one the check
    // upgrades itself from "history present" to a real comparison. Until then the report says which
    // of the two it made — never letting the weaker one read as the stronger.
    const versionRows = [];
    for (const pair of pairs.filter((x) => x.source?.type === 'file')) {
      const srcMulti = pair.source?.raw?.HasMultipleVersions === true;
      let srcCount = null;
      try {
        // ShareFile reports PREVIOUS versions; the current file is the +1.
        srcCount = (await sharefileClient.listVersions(srcAccount, pair.source.id)).length + 1;
      } catch {
        srcCount = null; // expected — see the header above
      }
      let destCount = null;
      try {
        destCount = await this.readVersionCount(
          site.siteId, `${destRootPath}${pair.source.path}`, context.destinationEmail
        );
      } catch (err) {
        versionRows.push({ path: pair.source.path, error: err.message, ok: null });
        continue;
      }

      if (srcCount !== null) {
        // Exact comparison, directional: LOSS fails, EXCESS is documented behaviour.
        const row = core.compareVersions(srcCount, destCount, {
          path: pair.source.path, name: pair.source.name,
        });
        row.srcCount = srcCount;
        row.destCount = destCount;
        row.mode = 'counted';
        row.ok = destCount >= srcCount;
        row.excess = destCount > srcCount;
        versionRows.push(row);
      } else if (srcMulti) {
        // Presence-only: the source says it had history, so the destination must have some too.
        versionRows.push({
          path: pair.source.path,
          name: pair.source.name,
          srcCount: null,
          destCount,
          mode: 'presence',
          ok: destCount > 1,
          excess: false,
        });
      }
      // A single-version source file exercises nothing and is deliberately not counted either way.
    }

    const vChecked = versionRows.filter((r) => r.ok !== null && r.ok !== undefined);
    const vBad = vChecked.filter((r) => !r.ok);
    const counted = vChecked.filter((r) => r.mode === 'counted');
    const presence = vChecked.filter((r) => r.mode === 'presence');

    if (vChecked.length === 0) {
      push('WARN', '4. Version history',
        'No multi-version file was found to compare — not assessed. ShareFile exposes no version '
        + 'list on this account (PreviousVersions and Versions both 404), only HasMultipleVersions.');
    } else if (vBad.length > 0) {
      push('FAIL', '4. Version history',
        `${vBad.length} of ${vChecked.length} file(s) LOST version history: `
        + vBad.slice(0, 3).map((r) => `${r.path} (source ${r.srcCount === null ? 'had history' : r.srcCount}, `
          + `destination ${r.destCount})`).join('; '));
    } else {
      const excess = counted.filter((r) => r.excess);
      push('PASS', '4. Version history',
        `${vChecked.length} file(s) kept their history at the destination`
        + (presence.length > 0
          ? ` — ${presence.length} verified by PRESENCE only: ShareFile serves no version list on `
            + 'this account, so the destination count could not be compared against a source count, '
            + 'only confirmed to be greater than one.'
          : '')
        + (excess.length > 0
          ? ` ${excess.length} file(s) carry more versions than the source, which is expected: `
            + 'CloudFuze writes a "SharePoint App" placeholder version beside each real one '
            + '(figure 4.1.1).'
          : ''));
    }

    // ── Tier B — file CONTENT, with the destination's own rewriting accounted for ─────────────
    //
    // Off by default: two full downloads per file, and this tree carries a 25 MB one. Nothing above
    // reads the data itself — names, paths, sizes and counts cannot tell a correctly migrated file
    // from one whose bytes were replaced.
    //
    // A raw SHA-256 is the wrong question for an OFFICE file arriving at SharePoint, and answering
    // it produced six red FAILs on a healthy migration. Measured on sample-format.docx: the source
    // zip holds 4 parts, the destination 18. SharePoint ADDS customXml/item{1,2,3}.xml with their
    // props and rels, docProps/custom.xml and some [trash]/*.dat, then rewrites [Content_Types].xml
    // and _rels/.rels to index them. Nothing is removed, and `word/document.xml` — the document
    // itself — is byte-identical. That is SharePoint stamping its content-type metadata on ingest,
    // not CloudFuze corrupting anything, and failing it would report the platform behaving as
    // designed as a data-loss defect.
    //
    // So an OOXML mismatch is RE-EXAMINED part by part: every part the SOURCE had must be present
    // and byte-identical at the destination. Added parts are reported, never counted against. That
    // is a stronger check than the hash, not a weaker one — it still catches a truncated or
    // substituted document, and it no longer cries wolf over metadata.
    let tierB = null;
    const ooxmlExplained = new Set();
    const ooxmlBroken = [];

    if (env.CONTENT_DEEP_VALIDATE_FILE_HASH) {
      tierB = await core.tierBHashes(
        pairs,
        (item) => sharefileClient.downloadFile(srcAccount, item.id),
        (item) => this.readContent(site.siteId, `${destRootPath}${item.path}`, context.destinationEmail),
        { maxFiles: 200, log }
      );

      for (const miss of tierB.mismatches) {
        const pair = pairs.find((x) => x.source?.path === miss.path);
        if (!pair || !OOXML_EXTENSIONS.has(core.extensionOf(pair.source.name).replace('.', '').toLowerCase())) continue;
        try {
          const [srcBuf, dstBuf] = await Promise.all([
            sharefileClient.downloadFile(srcAccount, pair.source.id),
            this.readContent(site.siteId, `${destRootPath}${pair.source.path}`, context.destinationEmail),
          ]);
          const verdict = await compareOoxmlParts(srcBuf, dstBuf);
          if (verdict.ok) ooxmlExplained.add(miss.path);
          else ooxmlBroken.push({ path: miss.path, ...verdict });
        } catch (err) {
          // Unreadable is NOT the same as corrupt — leave it in the mismatch list rather than
          // clearing it on a failure to look.
          log.warn(`[sharefile→sharepoint] OOXML re-check failed for ${miss.path}: ${err.message}`);
        }
      }

      const realMismatches = tierB.mismatches.filter((m) => !ooxmlExplained.has(m.path));
      const okCount = tierB.hashed.filter((h) => h.ok !== false).length;

      if (tierB.scanned === 0) {
        push('WARN', '1. File content (Tier B SHA-256)',
          `No hashable file — ${tierB.notHashed.length} skipped (converted, native or capped)`);
      } else if (realMismatches.length === 0) {
        push('PASS', '1. File content (Tier B SHA-256)',
          `${okCount} file(s) byte-identical`
          + (ooxmlExplained.size > 0
            ? `, and ${ooxmlExplained.size} Office file(s) verified part-by-part: every part the source `
              + 'had survived byte-for-byte, with SharePoint adding its own customXml/docProps '
              + 'metadata on ingest (expected, not a defect).'
            : '.')
          + ` ${tierB.notHashed.length} not hashed — reported, not counted as passes`);
      } else {
        push('FAIL', `1. File content (Tier B SHA-256) — ${realMismatches.length} differ`,
          realMismatches.slice(0, 10)
            .map((m) => `${m.path}: ${m.sourceBytes}B → ${m.destBytes}B (hash differs)`).join(' | ')
          + (ooxmlBroken.length > 0
            ? ` | Office files with genuinely altered content: ${ooxmlBroken.slice(0, 3)
              .map((b) => `${b.path} (${b.reason})`).join('; ')}`
            : ''));
      }
    } else {
      push('WARN', '1. File content (Tier B SHA-256)',
        'Not assessed — set CONTENT_DEEP_VALIDATE_FILE_HASH=true to compare file contents. Without '
        + 'it, nothing in this report reads the data itself.');
    }

    // ── File sizes — the cheap half of content fidelity ───────────────────────
    //
    // The structure check compares NAMES, so a file that arrived truncated or empty would be
    // reported as matched. ShareFile stores plain binaries with no native document format, so a
    // correct migration is byte-for-byte and the band is narrow — a mismatch on an ordinary file is
    // a genuine defect.
    //
    // Office files are the exception, for the reason above: SharePoint adds metadata parts, so a
    // .docx legitimately grows ~20%. One whose parts were verified is excluded; one that was never
    // verified (Tier B off) is a WARN naming the reason, never a FAIL — this check cannot tell
    // metadata from corruption on its own, and should not pretend it can.
    const sizeIssues = [];
    const sizeOoxmlUnverified = [];
    let sizeChecked = 0;
    for (const pair of pairs) {
      if (pair.source?.type !== 'file') continue;
      const res = core.compareSize(pair.source, pair.dest, bands);
      if (!res.comparable) continue;
      sizeChecked += 1;
      if (res.status === 'PASS') continue;

      const isOoxml = OOXML_EXTENSIONS.has(core.extensionOf(pair.source.name).replace('.', '').toLowerCase());
      const line = `${pair.source.path}: ${pair.source.size} → ${pair.dest.size}`
        + `${Number.isFinite(res.ratio) ? ` (${res.ratio.toFixed(2)}x)` : ''}`;

      if (isOoxml && ooxmlExplained.has(pair.source.path)) continue;
      if (isOoxml) sizeOoxmlUnverified.push(line);
      else sizeIssues.push({ status: res.status, line });
    }

    if (sizeChecked === 0) {
      push('WARN', '1. File sizes', 'No file had a comparable size on both sides — not assessed');
    } else if (sizeIssues.length === 0 && sizeOoxmlUnverified.length === 0) {
      push('PASS', '1. File sizes',
        `${sizeChecked} file(s) inside the tolerance band`
        + (ooxmlExplained.size > 0
          ? ` (${ooxmlExplained.size} Office file(s) grew from SharePoint's metadata and were verified part-by-part)`
          : ''));
    } else if (sizeIssues.length === 0) {
      push('WARN', `1. File sizes (${sizeOoxmlUnverified.length} Office file(s) larger, unverified)`,
        'SharePoint adds customXml/docProps metadata to Office files on ingest, which grows them by '
        + 'roughly 20%. Whether the CONTENT survived was not checked — enable '
        + 'CONTENT_DEEP_VALIDATE_FILE_HASH to verify part-by-part: '
        + sizeOoxmlUnverified.slice(0, 5).join(' | '));
    } else {
      const sizeFails = sizeIssues.filter((x) => x.status === 'FAIL');
      push(sizeFails.length > 0 ? 'FAIL' : 'WARN',
        `1. File sizes (${sizeIssues.length} of ${sizeChecked} outside the band)`,
        sizeIssues.slice(0, 10).map((x) => `[${x.status}] ${x.line}`).join(' | '));
    }

    // ── OUT OF SCOPE — the negative control ───────────────────────────────────
    //
    // Every other check asks "did it arrive?". This one asks "did something arrive that never
    // should have?", and it is the only check in the file that can fail a migration for doing too
    // much rather than too little.
    //
    // It exists to prove the validator works. A suite of positive checks cannot distinguish a
    // validator that verifies from one that agrees — both report green on a healthy run. The
    // seeder plants a folder BESIDE the migrated root, outside the path mapping, so CloudFuze is
    // never told about it. Anything from it at the destination is a scope violation.
    //
    // The SOURCE decides whether this check runs. If the control was never planted there is
    // nothing to detect, and reporting a pass would be the vacuous kind — green because nothing
    // was looked for. That reads `na` with the reason instead.
    let controlPlanted = false;
    let controlNames = [];
    try {
      const acctRoot = await sharefileClient.getRoot(srcAccount);
      const top = await sharefileClient.listChildren(srcAccount, acctRoot.id, '');
      const ctrl = top.find((i) => i.type === 'folder' && i.name === OUT_OF_SCOPE.root);
      if (ctrl) {
        controlPlanted = true;
        const walk = await sharefileClient.buildFolderTree(srcAccount, ctrl.id, {
          rootPath: `/${OUT_OF_SCOPE.root}`, maxDepth: 5,
        });
        controlNames = walk.items.map((i) => i.name);
      }
    } catch (err) {
      log.warn(`[sharefile→sharepoint] could not read the out-of-scope control: ${err.message}`);
    }

    if (!controlPlanted) {
      push('WARN', '8. Out-of-scope content stayed out',
        `NOT ASSESSED — the negative control "${OUT_OF_SCOPE.root}" is not present at the source, so `
        + 'nothing was planted for the migration to wrongly copy. Re-run with seeding enabled to '
        + 'exercise this check; a pass here without the control would be green for the wrong reason.');
    } else {
      // Matched on NAME across the whole destination tree, not on path. A scope violation does not
      // have to reproduce the source layout — the thing that matters is that the content is there
      // at all, wherever CloudFuze decided to put it.
      const wanted = new Set(controlNames.map((n) => n.toLowerCase()));
      const leaked = destItems.filter((d) => wanted.has(String(d.name).toLowerCase()));

      push(leaked.length === 0 ? 'PASS' : 'FAIL', '8. Out-of-scope content stayed out',
        leaked.length === 0
          ? `${controlNames.length} item(s) outside the migrated folder, none of them at the `
            + 'destination — the migration copied only what it was asked to.'
          : `${leaked.length} item(s) from OUTSIDE the migrated folder reached the destination: `
            + `${leaked.slice(0, 5).map((d) => d.path).join(', ')}. These live in `
            + `"${OUT_OF_SCOPE.root}", which no path mapping names. The migration copied data it `
            + 'was never asked to copy.');
    }

    // ── OUT-OF-SCOPE FEATURE 5 — Shared Links must NOT migrate ────────────────
    //
    // The seeder plants a file carrying a ShareFile shared link INSIDE the migrated folder. The
    // file is in scope and must arrive; the link is on the out-of-scope list and must not. Two
    // independent verdicts about the same item, which is why the control lives in-tree — a file
    // outside the tree could only prove something about paths.
    //
    // Judged from the DESTINATION's own sharing links, not from ours: getItemPermissions returns
    // `links` separately from `permissions` for exactly this.
    const linkCtrl = pairs.find((x) => x.source?.name === OUT_OF_SCOPE.sharedLinkFile);
    if (!linkCtrl) {
      push('WARN', '9. Out-of-scope: shared links did not migrate',
        `NOT EXERCISED — the control file "${OUT_OF_SCOPE.sharedLinkFile}" is not in the compared `
        + 'tree, so no shared link was planted for the migration to wrongly carry.');
    } else {
      let destLinks = null;
      try {
        const dp = await this.readPermissions(
          site.siteId, `${destRootPath}${linkCtrl.source.path}`, context.destinationEmail
        );
        destLinks = (dp?.links) || [];
      } catch (err) {
        log.warn(`[sharefile→sharepoint] could not read links on the control file: ${err.message}`);
      }

      if (destLinks === null) {
        push('WARN', '9. Out-of-scope: shared links did not migrate',
          'Not assessed — the destination copy\'s sharing links could not be read.');
      } else {
        // FAIL = the feature did not reach the destination. Same meaning as everywhere else in
        // this report. Expected here, and the classifier keeps it out of the ticket queue.
        push(destLinks.length === 0 ? 'FAIL' : 'PASS',
          '9. Out-of-scope: shared links did not migrate',
          destLinks.length === 0
            ? 'NOT MIGRATED. The control file carries a shared link at the source and none at the '
              + 'destination. Expected: Shared Links is on the OUT-OF-SCOPE list for this pair, '
              + 'so the job requested it, the tool accepted the request and did not deliver it. '
              + 'Documented behaviour — reported as a failure, not raised as a CloudFuze defect.'
            : `MIGRATED — and it should not have. ${destLinks.length} sharing link(s) on the `
              + `destination copy of "${OUT_OF_SCOPE.sharedLinkFile}". Shared Links is an `
              + 'OUT-OF-SCOPE feature for this combination, so a link here means the migration '
              + 'carried something it should not: '
              + destLinks.slice(0, 3).map((l) => l.linkScope || l.linkType || 'link').join(', '));
      }
    }

    // ── OUT-OF-SCOPE FEATURE 7 — Embedded Links must NOT be rewritten ─────────
    //
    // The seeder plants a .docx carrying TWO hyperlinks into the same ShareFile account:
    //
    //   in-scope target      a file inside the migrated folder — it DOES migrate, so a destination
    //                        URL exists and a rewrite here would be a real one
    //   out-of-scope target  a file in the sibling folder that never migrates — no destination URL
    //                        exists, so this link surviving proves nothing on its own
    //
    // Both must still point at ShareFile, because Embedded Links is on this combination's
    // out-of-scope list.
    //
    // ONE ROW, ONE VERDICT. This check used to push four rows — three of them INFO carrying
    // context, then the verdict — and a reader scanning the report saw "INFO" three times beside
    // "Embedded Links" and could not tell whether the links had migrated or not. The Dropbox
    // combination, which is the reference for this repo, emits exactly one row per feature
    // (dropboxToSharepoint.js `_checkEmbeddedLinks`, feature 9.1) and never emits INFO at all.
    //
    // The context did not become less important — it moved into the verdict's own detail, under
    // "Why:", which is where a reader looking at a red row goes to find out what happened. A
    // separate row cannot be read as the explanation of another row; a sentence inside it can.
    const embeddedCtrl = pairs.find((x) => x.source?.name === OUT_OF_SCOPE.embeddedLinkFile);
    if (!embeddedCtrl) {
      push('WARN', '10. Out-of-scope: embedded links were not rewritten',
        `NOT EXERCISED — the control document "${OUT_OF_SCOPE.embeddedLinkFile}" is not in the `
        + 'compared tree, so no embedded link was planted for the migration to rewrite.');
    } else {
      let destBuf = null;
      try {
        destBuf = await this.readContent(
          site.siteId, `${destRootPath}${embeddedCtrl.source.path}`, context.destinationEmail
        );
      } catch (err) {
        log.warn(`[sharefile→sharepoint] could not download the embedded-link control: ${err.message}`);
      }

      const parsed = destBuf ? docxLinks.extractDocxLinks(destBuf) : { ok: false, reason: 'not downloaded' };

      // Collected, then appended to whichever verdict is reached — never pushed as rows of their own.
      const why = [];

      // What the JOB asked for. Without this the verdict is ambiguous: a link that was never
      // rewritten because nobody requested the feature looks identical to one the migration
      // deliberately left alone. `opt()` in migrationClient defaults to true, so an unset option
      // means the feature WAS requested.
      const askedFor = context.contentOptions?.workbookLinks !== false;
      why.push(askedFor
        ? 'The job was created with embeddedLinks=true, so the transformation WAS requested and '
          + 'still did not happen — which is what makes this evidence rather than an untested option.'
        : 'The job was created with embeddedLinks=false, so nothing was requested; a link left '
          + 'unchanged says nothing about whether the feature is suppressed.');

      if (!parsed.ok) {
        push('WARN', '10. Out-of-scope: embedded links were not rewritten',
          `Not assessed — the destination copy could not be read as a document (${parsed.reason}). `
          + `Unreadable is not the same as unchanged. Why: ${why.join(' ')}`);
      } else {
        why.push(`The destination copy opened as a Word document and its ${parsed.targets.length} `
          + 'link(s) were read from word/_rels/document.xml.rels — no conversion and no HTML export, '
          + 'so these are the addresses the document itself carries.');

        // Classify by TARGET. Anything whose ShareFile item id appears in the migrated tree pointed
        // at in-scope content; anything else pointed outside it.
        const srcIds = new Set(sourceItems.map((i) => String(i.id)).filter(Boolean));
        const idOf = (u) => (String(u).match(/Items\(([^)]+)\)/) || [])[1] || '';
        const rewritten = parsed.targets.filter((t) => /sharepoint\.com|onedrive\.live|1drv\.ms/i.test(String(t)));
        const inScopeLinks = parsed.targets.filter((t) => srcIds.has(idOf(t)));
        const outOfScopeLinks = parsed.targets.filter((t) => idOf(t) && !srcIds.has(idOf(t)));

        if (outOfScopeLinks.length > 0) {
          why.push(`${outOfScopeLinks.length} of the link(s) point OUTSIDE the migrated folder, at `
            + 'content that never migrates — no destination address exists for them, so they are '
            + 'excluded from the verdict rather than counted as unchanged.');
        }

        if (parsed.targets.length === 0) {
          push('WARN', '10. Out-of-scope: embedded links were not rewritten',
            'Not assessed — the destination copy carries no hyperlink at all. That is neither the '
            + 'documented out-of-scope behaviour nor a rewrite; check the control document seeded '
            + `correctly before reading anything into it. Why: ${why.join(' ')}`);
        } else if (inScopeLinks.length === 0 && rewritten.length === 0) {
          push('WARN', '10. Out-of-scope: embedded links were not rewritten',
            'Weak evidence — the document carries links, but none of them points at content that '
            + 'migrated, so none COULD have been rewritten. Treat this as not exercised rather than '
            + `as a pass. Why: ${why.join(' ')}`);
        } else {
          push(rewritten.length === 0 ? 'FAIL' : 'PASS',
            '10. Out-of-scope: embedded links were not rewritten',
            rewritten.length === 0
              ? `NOT MIGRATED: ${inScopeLinks.length} link(s) point at content that DID `
                + 'migrate, and every one still carries its ShareFile address — a rewrite was '
                + 'possible and did not happen. Expected: Embedded Links is on the '
                + 'OUT-OF-SCOPE list for this pair, so the job requested it, the tool accepted it and '
                + 'did not deliver it. Documented behaviour — reported as a failure, not raised as '
                + `a CloudFuze defect. Observed: ${inScopeLinks.slice(0, 2).join(' | ')}. `
                + `Why: ${why.join(' ')}`
              : `MIGRATED — and it should not have: ${rewritten.length} hyperlink(s) were changed to destination `
                + `addresses: ${rewritten.slice(0, 3).join(', ')}. Embedded Links is OUT OF SCOPE `
                + 'for this combination, so rewriting one means the migration did something the '
                + `document says it does not do. Why: ${why.join(' ')}`);
        }
      }
    }

    // ── Features 2.1–2.4 — Permissions ────────────────────────────────────────
    //
    // This block used to read the source grants and then push a flat WARN — no destination read, no
    // comparison. That was correct while no role mapping existed, and it hid a real defect for as
    // long as it stood: group grants present on EVERY source rung and absent from EVERY destination
    // one. Silence on a failing feature is worse than a wrong verdict, because nobody argues with
    // it. The mapping is now measured (see the roleMap header) and this compares against it.
    //
    // `groupFallbackFrom` is the load-bearing argument. comparePermissions lets a destination GROUP
    // grant satisfy a user's own grant — reasonable, except SharePoint attaches its built-in site
    // groups to effectively every item. Measured on this tenant, every single folder carries:
    //
    //     qa members:write | qa owners:owner | qa visitors:read | qa@…onmicrosoft.com:owner
    //
    // Left unfiltered those satisfy any grant at any level, and all four permission features pass
    // no matter what migrated — a green tick that means "SharePoint has site groups". The filter
    // excludes them BY SHAPE (an Owners/Members/Visitors suffix, or a tenant onmicrosoft.com
    // address) rather than by name, so it holds on any tenant rather than this one.
    const rmapMeasured = rmap?.mappingIsMeasured === true;
    const builtInSiteGroup = (d) => {
      const name = String(d?.name || '').trim().toLowerCase();
      const email = String(d?.email || '').trim().toLowerCase();
      if (/\.onmicrosoft\.com$/.test(email)) return true;
      return /\b(owners|members|visitors)$/.test(name);
    };

    // ── Resolve ACL principals to addresses, once ─────────────────────────────
    //
    // ShareFile's AccessControls endpoint returns a Principal carrying an Id and NOTHING ELSE —
    // verified on the live tenant, where every row came back with Name "" and Email "". So the
    // grants read straight off an item are anonymous, comparePermissions drops them all on
    // `if (!sp?.email) continue`, and feature 2.x reported a verdict having compared zero grants
    // while claiming 70 were read.
    //
    // The ids do resolve: e394a204… is alex@filefuze.co in /Accounts/Employees, g172e5d4… is
    // "! Countsq@ %" in /Groups. Both listings are fetched ONCE per run rather than per item —
    // 60 items x 2 listings would be 120 redundant calls against an API that already rotates its
    // token aggressively under load.
    const principalIndex = new Map();
    try {
      for (const u of await sharefileClient.listUsers(srcAccount, { includeClients: true })) {
        if (u.id) principalIndex.set(String(u.id), { email: u.email, name: u.name, type: 'user' });
      }
    } catch (err) {
      log.warn(`[sharefile→sharepoint] could not list users for principal resolution: ${err.message}`);
    }
    try {
      for (const g of await sharefileClient.listGroups(srcAccount)) {
        if (g.id) principalIndex.set(String(g.id), { email: g.email || g.name, name: g.name, type: 'group' });
      }
    } catch (err) {
      log.warn(`[sharefile→sharepoint] could not list groups for principal resolution: ${err.message}`);
    }

    // The account doing the reading holds an inherited owner grant on every item. It is not a
    // migrated permission and has no destination counterpart (it is the SOURCE account), so
    // comparing it would fail every single folder. Drive's `owner` grant is excluded for exactly
    // this reason — see the comment in deepContentCore.comparePermissions.
    let actingEmail = '';
    try {
      actingEmail = String(sharefileClient.resolveAccount(srcAccount)?.email || '').toLowerCase();
    } catch { /* the listings above already reported an unusable connection */ }

    let grantsSeen = 0;
    let permChecked = 0;
    let permInherited = 0;
    let permUnresolved = 0;
    const permMatches = [];
    const permMismatches = [];
    const permEscalations = [];
    const notComparable = [];
    const permUnreadable = [];

    // Capped like every other per-item loop: two API calls per item, and the cap is reported below
    // so a truncated check is never read as a complete one.
    //
    // WHICH items fill the cap is not a detail. `slice(0, 60)` took them in tree-traversal order,
    // and the traversal happened to start with the 21-level `deep-by-count` chain and the format
    // and large-file folders. Those carry no grants, so the cap was spent before the walk ever
    // reached the permission ladder, and the run reported "0 grant(s) compared" — a check that
    // examined nothing while the seeded ladder sat untouched at the destination. Worse, the only
    // confirmed defect in this combination (feature 2.3, group grants dropped) lives in that
    // ladder, so it vanished from the report without anything having been fixed.
    //
    // Order by what the DOCUMENT puts in scope instead of by traversal accident:
    //   - folders before files: folder permissions are in scope for this combination, file-level
    //     permissions are listed out of scope, so a file is the less informative target;
    //   - shallower before deeper: breadth-first reaches every branch of the tree before spending
    //     the budget on one long chain, which is exactly how the ladder was starved.
    // Path breaks ties so the selection is stable between runs and two runs stay comparable.
    const PERM_CAP = 60;
    const permTargets = selectPermissionTargets(pairs, PERM_CAP);

    for (const pair of permTargets) {
      let acl;
      try {
        acl = await sharefileClient.listAccessControls(srcAccount, pair.source.id);
      } catch (err) {
        permUnreadable.push({ path: pair.source.path, side: 'source', error: err.message });
        continue;
      }
      grantsSeen += acl.length;

      const destPerms = await this.readPermissions(
        site.siteId, `${destRootPath}${pair.source.path}`, context.destinationEmail
      );
      const dest = (destPerms?.permissions) || [];

      // Resolve each anonymous grant, and drop the two kinds that are not migrated permissions:
      // the acting account's own inherited ownership, and ids that appear in no listing (ShareFile
      // attaches an internal system group — a "gs"-prefixed id absent from /Groups — to every
      // item). Both are reported in the summary rather than silently discarded.
      const aclForCompare = [];
      for (const a of acl) {
        const pid = String(a.raw?.Principal?.[sharefileClient.FIELD.id] || '');
        const known = principalIndex.get(pid);
        const email = (a.email || known?.email || '').toLowerCase();
        if (!email) {
          permUnresolved += 1;
          continue;
        }
        if (actingEmail && email === actingEmail) {
          permInherited += 1;
          continue;
        }
        aclForCompare.push({ ...a, email, name: a.name || known?.name || '' });
      }

      const cmp = core.comparePermissions(aclForCompare, dest, null, {
        roleMap: rmap,
        groupFallbackFrom: (d) => !builtInSiteGroup(d),
      });
      permChecked += cmp.checked || 0;
      permMatches.push(...(cmp.matches || []));
      permEscalations.push(...(cmp.escalations || []));
      notComparable.push(...(cmp.notComparable || []));
      for (const m of (cmp.mismatches || [])) permMismatches.push({ ...m, path: pair.source.path });
    }

    // Split by principal kind: the document treats them as separate features (2.1/2.2 folder-level,
    // 2.3 group, 2.4 external), and a single combined verdict would let a whole failing kind hide
    // inside a mostly-passing total — which is exactly how the group failure stayed invisible.
    const groupBad = permMismatches.filter((m) => m.principalType === 'group');
    const userBad = permMismatches.filter((m) => m.principalType !== 'group');
    const lossyNote = 'Note: the mapping is LOSSY — SharePoint expresses only Read and Edit, so '
      + 'upload, download, delete and manage-permissions all arrive as Edit and cannot be told '
      + 'apart. Presence and level are verified; delete/admin rights specifically are not.';

    if (!rmapMeasured) {
      push('WARN', '2. Permissions (root folder, sub-folder, group, external)',
        `NOT ASSESSED — ${grantsSeen} source grant(s) read, no mapping available to compare them.`);
    } else if (permChecked === 0) {
      push('WARN', '2. Permissions (root folder, sub-folder, group, external)',
        `Not assessed — ${grantsSeen} source grant(s) were read but none was comparable `
        + `(${permInherited} inherited owner grant(s), ${permUnresolved} principal(s) that resolve `
        + 'to no user or group in this account)'
        + `${permUnreadable.length ? `; ${permUnreadable.length} item(s) unreadable` : ''}.`);
    } else {
      const scope = `${permChecked} grant(s) compared across ${permTargets.length} item(s)`
        + `${pairs.length > PERM_CAP ? ` (capped at ${PERM_CAP} of ${pairs.length})` : ''}`
        + `${permInherited > 0 ? `; ${permInherited} inherited owner grant(s) excluded` : ''}`
        + `${permUnresolved > 0 ? `; ${permUnresolved} unresolvable principal(s) excluded` : ''}`;

      push(userBad.length === 0 ? 'PASS' : 'FAIL',
        '2. Permissions — user grants (features 2.1, 2.2, 2.4)',
        userBad.length === 0
          ? `${scope}; every user grant arrived at or above its source level. ${lossyNote}`
          : `${userBad.length} user grant(s) did not arrive: `
            + userBad.slice(0, 5).map((m) => `${m.path} ${m.user} (source ${m.sourceRole}, `
              + `destination ${m.destRoles.join('+') || 'none'})`).join('; '));

      push(groupBad.length === 0 ? 'PASS' : 'FAIL',
        '2. Permissions — group grants (feature 2.3)',
        groupBad.length === 0
          ? `${scope}; every group grant arrived.`
          : `${groupBad.length} group grant(s) did not arrive at the destination: `
            + groupBad.slice(0, 5).map((m) => `${m.path} "${m.user}" (source ${m.sourceRole}, `
              + `destination ${m.destRoles.join('+') || 'NONE'})`).join('; ')
            + '. The document states group migration transfers groups, memberships and permissions.');

      if (permEscalations.length > 0) {
        push('WARN', '2. Permissions — destination grants more than the source',
          `${permEscalations.length} grant(s) arrived at a HIGHER level than the source held: `
          + permEscalations.slice(0, 3).map((e) => `${e.user} ${e.sourceRole} → ${e.destRoles.join('+')}`).join('; '));
      }
    }

    if (permUnreadable.length > 0) {
      push('WARN', '2. Permissions — items whose grants could not be read',
        `${permUnreadable.length} item(s): ${permUnreadable.slice(0, 3).map((u) => u.path).join(', ')}`);
    }

    // ── Feature 7.1 — Suppressed email notifications ──────────────────────────
    if (env.CONTENT_DEEP_VALIDATE_NOTIFICATIONS) {
      // Returns { ok, leaks, error } — not an array. Reading `.length` off it produced
      // "undefined sharing notification(s) arrived" and a FAIL on a check that never ran.
      // `ok: false` means the mailbox could not be read, which is NOT ASSESSED, never a defect:
      // failing 7.1 because we lack mailbox access would blame the migration for our own gap.
      //
      // A TIME WINDOW IS REQUIRED, and establishing one is this combination's job.
      //
      // findSharingNotifications counts EVERY sharing mail in the inbox when it cannot parse a
      // start time — SharePointValidationAgent line ~337, `if (!startedAt) return true`. And
      // `context.startedAt` is set NOWHERE in this codebase: it exists only on BaseAgent
      // instances, never on a run context. So the argument was always undefined and 7.1 judged the
      // run against the mailbox's entire history.
      //
      // It failed on two notifications dated 2026-09-09 — two days before the run — naming a
      // "Book.xlsx" shared with people this combination never touches. Left alone, 7.1 could never
      // pass again for any destination mailbox that had ever received one sharing mail.
      //
      // The execution record's own `createdAt` is the real start of the run and is used when the
      // context carries nothing. If neither exists the check is NOT RUN: "not assessed" is honest,
      // where scanning the whole mailbox blames the migration for someone else's history.
      const runStart = context.startedAt
        || (context.executionId ? executionService.get(context.executionId)?.createdAt : null)
        || null;

      if (!runStart) {
        push('WARN', '7. Suppress email notifications',
          'Not assessed — the run\'s start time could not be established. Without a window, every '
          + 'sharing mail the destination mailbox has ever received would count against this run.');
      } else {
        const notif = await this.findSharingNotifications(context.destinationEmail, runStart);
        if (!notif?.ok) {
          push('WARN', '7. Suppress email notifications',
            `Not assessed — could not read ${context.destinationEmail}'s mailbox`
            + `${notif?.error ? `: ${notif.error}` : ''}`);
        } else {
          const leaks = notif.leaks || [];
          push(leaks.length === 0 ? 'PASS' : 'FAIL', '7. Suppress email notifications',
            leaks.length === 0
              ? `No sharing notification arrived at ${context.destinationEmail} since the run began `
                + `(${runStart})`
              : `${leaks.length} sharing notification(s) arrived since ${runStart} — they should have `
                + `been suppressed: ${leaks.slice(0, 3).join('; ')}`);
        }
      }
    } else {
      push('WARN', '7. Suppress email notifications',
        'Not assessed — set CONTENT_DEEP_VALIDATE_NOTIFICATIONS=true to check the destination mailbox');
    }

    // ── The "Source vs Destination Comparison" panel ────────────────────────────────────────
    //
    // ResultsView renders it only when `validation.perUser` is non-empty, and this combination
    // returned a hardcoded `perUser: []` — so the panel that answers the first question anyone asks
    // ("did my data arrive?") was simply absent for ShareFile → SharePoint while every sibling
    // combination showed it.
    //
    // The shape is ContentComparison's, not one of ours: it groups `items` by the first path
    // segment, counts `found`, treats `placeholder` as arrived-as-documented rather than missing,
    // and reads `folderStructure.{missing,extra,misplaced}` for the cards. Matching it exactly is
    // the point — a near-miss renders an empty or, worse, a wrong panel.
    //
    // `found` deliberately includes MISPLACED items. They are at the destination, just under a
    // renamed parent; counting them as not-found would show 22 items missing on a run where every
    // one of them is present and correct.
    const placeholderPaths = new Set((tree.placeholderLinks || []).map((r) => r.path));
    const misplacedByPath = new Map((tree.misplaced || []).map((m) => [m.source, m.dest]));
    const comparisonUnit = {
      sourceEmail: srcAccount || context.sourceEmail || '',
      destinationEmail: context.destinationEmail || '',
      items: sourceItems.map((item) => {
        const pair = tree.matched.get(item.path);
        const movedTo = misplacedByPath.get(item.path);
        return {
          path: item.path,
          name: item.name,
          type: item.type,
          found: Boolean(pair || movedTo),
          destName: pair?.dest?.name
            || (movedTo ? String(movedTo).split('/').filter(Boolean).pop() : undefined),
          placeholder: placeholderPaths.has(item.path),
        };
      }),
      /**
       * Derived from the RECONCILED tree, not from a second raw comparison.
       *
       * It called core.compareFolders, which runs its own compareTrees over the folders alone. That
       * helper knows nothing about the rename rules this combination reconciles a few hundred lines
       * above — reserved-underscore, space-trimmed and truncated — so it counted every renamed
       * folder twice: once as missing under its source name, once as extra under its destination
       * one. Measured on live data: the panel reported FAIL, 7 missing and 7 extra, on the same page
       * where the structure check reported "176 matched, none missing". Both were reading the same
       * clouds.
       *
       * A report that contradicts itself is worse than one that stays quiet, because the
       * disagreement is what gets a real finding waved away. So the panel is built from `tree` — the
       * same object every other check in this file reads — and the two can no longer disagree by
       * construction rather than by care.
       *
       * The shape is still compareFolders': totalSource / totalDest / matched / missing / extra /
       * misplaced / status, plus the path lists and labels that drive the ASCII trees. pdfGenerator
       * reads all of them, and a missing field renders as the word "undefined".
       */
      folderStructure: (() => {
        const isFolder = (x) => x && x.type === 'folder';
        const srcFolders = sourceItems.filter(isFolder);
        const dstFolders = destItems.filter(isFolder);

        const matchedFolders = [...tree.matched.values()].filter((pair) => isFolder(pair.source));
        const missingFolders = (tree.missing || []).filter(isFolder).map((x) => x.path);
        const extraFolders = (tree.extra || []).filter(isFolder).map((x) => x.path);
        const misplacedFolders = (tree.misplaced || []).filter((m) => m.type === 'folder');

        return {
          totalSource: srcFolders.length,
          totalDest: dstFolders.length,
          matched: matchedFolders.length,
          missing: missingFolders,
          extra: extraFolders,
          misplaced: misplacedFolders,
          placeholderLinks: (tree.placeholderLinks || []).filter((x) => x.type === 'folder'),
          notMigratable: (tree.notMigratable || []).filter((x) => x.type === 'folder'),
          // Same rule the structure check uses: a folder paired under a renamed parent is present,
          // not missing. Only genuine absence or an unexplained extra fails.
          status: missingFolders.length === 0 && extraFolders.length === 0 ? 'PASS' : 'FAIL',
          sourceFolderPaths: srcFolders.map((x) => x.path).sort(),
          destFolderPaths: dstFolders.map((x) => x.path).sort(),
          sourceRootName: sourceRootPath.replace(/^\/+/, '') || '(root)',
          destRootName: destRootPath.replace(/^\/+/, '') || '(root)',
          sourceLabel: 'ShareFile',
          destLabel: 'SharePoint',
        };
      })(),
    };

    const totals = {
      comparisonUnit,
      combination: COMBINATION,
      migrationType: context.migrationType,
      scannedSourceItems: sourceItems.length,
      pairedCount: tree.matchedCount,
      missingCount: tree.missing.length,
      treeComparison: tree,
      versionRows,
      sizeIssues,
      tierB,
      permissionsNotAssessed: !rmapMeasured,
      permissionNotComparable: notComparable,
      permissionMatches: permMatches.length,
      permissionMismatches: permMismatches,
      permissionEscalations: permEscalations,
      enabled: true,
    };

    // "permissions not assessed" used to be hardcoded here, from when the role map compared nothing.
    // It outlived that: the run this line was copied from FAILED feature 2.3 on ten group grants
    // while the log underneath it announced permissions were not assessed. A log that contradicts
    // the verdict it accompanies is how a real finding gets read as noise, so the counts now come
    // from what the run actually did.
    const permSummary = rmapMeasured
      ? `${permChecked} permission grant(s) compared`
        + `${permMismatches.length > 0 ? `, ${permMismatches.length} did not arrive` : ', all arrived'}`
      : 'permissions not assessed (no role mapping available)';
    log.info(`ShareFile → SharePoint: ${sourceItems.length} scanned, ${tree.matchedCount} paired, `
      + `${tree.missing.length} missing, ${permSummary}`);

    return buildResult(checks, totals);
  }
}

/**
 * The ELEVEN features this combination's document defines, and only those.
 *
 * `validation/shared/contentFunctionalityChecklist.js` is deliberately NOT used here. It emits a
 * fixed list of 38 features taken from the Google Shared Drive → SharePoint document and ignores the
 * combination passed to it — verified by calling it with `combination: 'sharefile_to_sharepoint'`
 * and receiving all 38 rows, led by "Delta Migration". Reporting those against this combination
 * would claim assessment of Delta, Shared Links, Embedded Links, Selective Versions and Folder
 * Display: five features the ShareFile → SharePoint document does not list at all. A report naming
 * features that were never in scope is worse than one naming none, because every one of them would
 * read as covered.
 *
 * Feature ids and titles are taken verbatim from
 * `data/feature-scope/sharefile-to-sharepoint-inscope.md`.
 *
 * Verdicts derive from the checks the validator actually pushed, so the checklist can never claim a
 * feature passed on the strength of a check that did not run.
 */
const SHAREFILE_FEATURES = [
  { id: '1.1', category: 'Migration', feature: 'Preserving File/Folder structure', match: /structure preserved/i },
  { id: '1.2', category: 'Migration', feature: 'Onetime', match: /Destination location found/i },
  // Each permission feature matches its OWN check. They all used to share /^2\. Permissions/, and
  // buildShareFileChecklist takes the FIRST match — so once user grants and group grants became
  // separate verdicts, feature 2.3 would have reported the USER result and a failing group
  // migration would have shown up as four green ticks.
  { id: '2.1', category: 'Permissions', feature: 'Root Folder Permissions', match: /^2\. Permissions — user grants/i },
  { id: '2.2', category: 'Permissions', feature: 'Sub-folder permissions', match: /^2\. Permissions — user grants/i },
  { id: '2.3', category: 'Permissions', feature: 'Group Permissions', match: /^2\. Permissions — group grants/i },
  { id: '2.4', category: 'Permissions', feature: 'External Shares', match: /^2\. Permissions — user grants/i },
  { id: '3.1', category: 'Metadata', feature: 'Metadata', match: /^3\. Metadata/i },
  { id: '4.1', category: 'Version History', feature: 'Version History', match: /^4\. Version history/i },
  { id: '5.1', category: 'Special Characters', feature: 'Special Characters Replacement', match: /^5\. Special character/i },
  { id: '6.1', category: 'Long Path', feature: 'Long-File/folder path', match: /^6\. Long file\/folder path/i },
  { id: '7.1', category: 'Notifications', feature: 'Suppress email notifications', match: /^7\. Suppress email/i },
];

/**
 * The SEVEN out-of-scope features, from the feature repository's own list for this combination.
 *
 * Recorded in data/feature-scope/sharefile-to-sharepoint-outscope.md. They are reported ALONGSIDE
 * the eleven in-scope features rather than folded into them, because the two ask opposite
 * questions: an in-scope feature passes when its content ARRIVES, an out-of-scope one passes when
 * its content STAYS AWAY. Merging them into a single list would make "pass" mean two different
 * things in the same table.
 *
 * `seedable: false` is not a shrug — each carries the measured reason it cannot be exercised, and
 * such a row can only ever report `na`. A negative control that was never planted proves nothing,
 * and showing it green would be the vacuous pass this file keeps having to design against.
 */
const SHAREFILE_OUT_OF_SCOPE_FEATURES = [
  {
    id: 'X1',
    category: 'Migration',
    feature: 'Delta',
    seedable: false,
    reason: 'Delta is a second migration pass over changed content, not data that can be planted. '
      + 'Exercised by HOW a migration is requested, so this run cannot test it either way.',
  },
  {
    id: 'X2',
    category: 'Permissions',
    feature: 'Root File Permissions',
    seedable: false,
    reason: 'ShareFile refuses a grant on a FILE from this account — HTTP 403 "Authorization '
      + 'failed: ItemUser", measured on the live tenant. Nothing can be planted to migrate, so '
      + 'the absence of file permissions at the destination proves nothing.',
  },
  {
    id: 'X3',
    category: 'Permissions',
    feature: 'Inner File Permissions',
    seedable: false,
    reason: 'Same 403 as X2 — file-level grants cannot be created from this account.',
  },
  {
    id: 'X4',
    category: 'In Line comment',
    feature: 'In Line comment',
    seedable: false,
    reason: 'ShareFile exposes no per-file comment stream to seed.',
  },
  {
    id: 'X5',
    category: 'Shared Links',
    feature: 'Shared Links',
    seedable: true,
    match: /^9\. Out-of-scope: shared links/i,
  },
  {
    id: 'X6',
    category: 'Selective Versions',
    feature: 'Selective Versions',
    seedable: false,
    reason: 'A job setting — "migrate the last N versions" — not data. Exercised by requesting a '
      + 'version count, which this run does not do.',
  },
  {
    id: 'X7',
    category: 'Embedded Links',
    feature: 'Embedded Links',
    seedable: true,
    match: /^10\. Out-of-scope: embedded links/i,
  },
];

/**
 * Choose which paired items have their permissions read, when there are more pairs than the budget.
 *
 * Folders first, then shallowest first, then by path. Exported so the ordering is asserted directly:
 * it is the difference between a permission check that examines the seeded ladder and one that
 * reports "0 grant(s) compared" after spending its whole budget on a folder chain holding no grants.
 */
function selectPermissionTargets(pairs, cap) {
  const depthOf = (pth) => String(pth || '').split('/').filter(Boolean).length;
  return (pairs || [])
    .filter((x) => x && x.source && x.dest)
    .slice()
    .sort((a, b) => {
      const af = a.source.type === 'folder' ? 0 : 1;
      const bf = b.source.type === 'folder' ? 0 : 1;
      if (af !== bf) return af - bf;
      const ad = depthOf(a.source.path);
      const bd = depthOf(b.source.path);
      if (ad !== bd) return ad - bd;
      return String(a.source.path).localeCompare(String(b.source.path));
    })
    .slice(0, cap);
}

/**
 * Roll the out-of-scope features up the same way the in-scope ones are rolled up.
 *
 * `pass` here means the feature did NOT migrate. `fail` means it did — an out-of-scope feature
 * reaching the destination is a defect in the other direction, and the only check in this file that
 * can fail a migration for doing too much.
 */
function buildOutOfScopeChecklist(checks) {
  const rows = SHAREFILE_OUT_OF_SCOPE_FEATURES.map((f) => {
    if (!f.seedable) {
      return { ...f, status: 'na', detail: `NOT EXERCISED — ${f.reason}`, expected: 'not migrated' };
    }
    const hit = checks.find((c) => f.match && f.match.test(c.name));
    if (!hit) {
      return { ...f, status: 'na', expected: 'not migrated',
        detail: 'not exercised — the validator did not reach this check' };
    }
    if (hit.status === 'WARN') return { ...f, status: 'na', detail: hit.detail, expected: 'not migrated' };

    // ONE MEANING FOR FAIL, ACROSS THE WHOLE REPORT: the feature did not reach the destination.
    //
    // This table used to read backwards — a feature that correctly stayed behind was "pass", so
    // FAIL meant "arrived" here and "did not arrive" everywhere else. Two opposite meanings for one
    // word in one document, and no reader should have to hold that in their head.
    //
    // The verdict now answers the same question the rest of the report answers: did the migration
    // deliver this? The job requests every one of these features — embeddedLinks=true,
    // withPermissions=true and the rest are all set on the CloudFuze job — so the tool accepts the
    // request and then does not deliver it. That is a FAIL in the plain sense of the word.
    //
    // Whether a FAIL is a DEFECT is a separate axis, carried by `expected` and by the bug
    // classifier: a documented out-of-scope feature failing is expected and raises no ticket
    // (bugStatus 'known_limitation'), while one that migrates anyway still raises one.
    // Read the DIRECTION off the detail, not off the status. The status convention has now been
    // inverted once already; a rollup that infers direction from it silently flips with it, and the
    // table would claim the opposite of the check it summarises. The detail states what happened in
    // words, so it stays correct whichever way the status convention goes.
    const migrated = /^MIGRATED/.test(String(hit.detail || ''));
    return {
      ...f,
      status: migrated ? 'pass' : 'fail',
      expected: 'not migrated',
      unexpected: migrated,
      detail: hit.detail,
    };
  });

  return {
    rows,
    coverage: {
      total: rows.length,
      pass: rows.filter((r) => r.status === 'pass').length,
      fail: rows.filter((r) => r.status === 'fail').length,
      na: rows.filter((r) => r.status === 'na').length,
    },
  };
}

/**
 * Roll the pushed checks up into the 11 documented features.
 *
 * States follow the shared convention: a feature whose check did not run, or ran and could not be
 * judged, is `na` WITH ITS REASON — never `pass`. Reporting an unexercised feature as passing is the
 * failure this whole rollup exists to avoid.
 */
function buildShareFileChecklist(checks, totals) {
  const rows = SHAREFILE_FEATURES.map((f) => {
    const hit = checks.find((c) => f.match.test(c.name));
    if (!hit) {
      return { ...f, status: 'na', detail: 'not assessed — the validator did not reach this check' };
    }
    // Permissions used to be structurally not-assessed here — a hard override that returned `na`
    // for 2.1-2.4 whatever the checks said, because no role mapping existed to compare against.
    //
    // A measured mapping now exists, and the override outlived it: the run that first compared
    // permissions correctly FAILED feature 2.3 with nine named group grants that never arrived, and
    // this line turned that into four grey "not assessed" rows. A verdict the checklist refuses to
    // print is worse than one it never computed.
    //
    // Gated on the run's own flag rather than deleted, so a combination or account without a usable
    // mapping still reports `na` instead of a fabricated pass.
    if (f.id.startsWith('2.') && totals?.permissionsNotAssessed) {
      return { ...f, status: 'na', detail: hit.detail };
    }
    if (hit.status === 'FAIL') return { ...f, status: 'fail', detail: hit.detail };
    if (hit.status === 'WARN') return { ...f, status: 'na', detail: hit.detail };
    // A PASS whose detail says the case was never exercised is `na`, not `pass`.
    if (/not exercised|not assessed|NOT ASSESSED/i.test(hit.detail || '')) {
      return { ...f, status: 'na', detail: hit.detail };
    }
    return { ...f, status: 'pass', detail: hit.detail };
  });

  const coverage = {
    total: rows.length,
    pass: rows.filter((r) => r.status === 'pass').length,
    fail: rows.filter((r) => r.status === 'fail').length,
    na: rows.filter((r) => r.status === 'na').length,
    scanned: totals?.scannedSourceItems || 0,
  };
  return { rows, coverage };
}

function buildResult(checks, totals) {
  // Out-of-scope features are reported as FAIL when they do not arrive — the job asked, the tool
  // did not deliver — but that is the documented outcome and must not drag the RUN to FAIL. If it
  // did, every correct migration would be red and the overall verdict would stop meaning anything.
  // A leak (an out-of-scope feature that DID migrate) is not excused: its detail starts "MIGRATED".
  const isExpectedOutOfScopeFailure = (c) => /^(9|10)\. Out-of-scope/i.test(String(c.name || ''))
    && c.status === 'FAIL'
    && !/^MIGRATED/.test(String(c.detail || ''));

  const isLeak = (c) => /^(8|9|10)\. Out-of-scope/i.test(String(c.name || ''))
    && /^MIGRATED/.test(String(c.detail || ''));

  const hasFail = checks.some((c) => isLeak(c))
    || checks.some((c) => c.status === 'FAIL' && !isExpectedOutOfScopeFailure(c));
  const hasWarn = checks.some((c) => c.status === 'WARN')
    || checks.some(isExpectedOutOfScopeFailure);
  const overall = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';

  const { rows: featureChecklist, coverage } = buildShareFileChecklist(checks, totals);
  const featureSummary = summarizeChecklist(featureChecklist, coverage);

  // Both halves of the scope, side by side. A report that names only what must arrive cannot show
  // that the migration stayed inside its boundaries — which is the question the out-of-scope list
  // exists to answer.
  const { rows: outOfScopeChecklist, coverage: outOfScopeCoverage } = buildOutOfScopeChecklist(checks);
  // Counts follow the same meaning as the rows: `fail` = did not migrate, `pass` = migrated.
  const outOfScopeSummary = `Out of scope: ${outOfScopeCoverage.fail} FAILED to migrate `
    + `(expected — documented as out of scope, no ticket raised), `
    + `${outOfScopeCoverage.pass} MIGRATED (unexpected — raised), `
    + `${outOfScopeCoverage.na} not exercised (of ${outOfScopeCoverage.total})`;

  if (totals) {
    totals.featureChecklist = featureChecklist;
    totals.featureSummary = featureSummary;
    totals.outOfScopeChecklist = outOfScopeChecklist;
    totals.outOfScopeCoverage = outOfScopeCoverage;
    totals.outOfScopeSummary = outOfScopeSummary;
  }

  const infraCheck = /reachable|site accessible|seeding root|Destination location|Destination tree|Source items/i;

  /**
   * Classify every finding against the DOCUMENT, not against how bad it looks.
   *
   * neutaraClient raises a Neutara ticket for each mismatch unless it carries
   * `bugStatus: 'known_limitation'` — and this combination never set the field, so every finding
   * was filed as a Bug. That is how the Shared Drive combination came to file four tickets against
   * behaviour that was working as documented, and had to retract them.
   *
   * Three kinds, and they mean genuinely different things to whoever reads the ticket:
   *
   *   bug                an IN-SCOPE feature did not do what the document says it does. This is
   *                      the only kind CloudFuze should be asked to fix.
   *   out-of-scope ran   an OUT-OF-SCOPE feature happened anyway. Still a deviation worth raising,
   *                      but it is the product doing MORE than documented, not losing data —
   *                      a reader must not confuse the two.
   *   known limitation   documented behaviour that merely looks like a failure. Never a bug, and
   *                      neutaraClient skips ticket creation when a run produces only these.
   *
   * `infrastructure` stays separate: the validator could not run. That is our gap, not CloudFuze's,
   * and decideType already turns an all-infrastructure run into a Task rather than a Bug.
   */
  const IN_SCOPE_FEATURE = (name) => SHAREFILE_FEATURES.find((f) => f.match.test(name));
  const OUT_OF_SCOPE_CHECK = /^(8|9|10)\. Out-of-scope/i;

  /**
   * Documented behaviours that can surface as a FAIL without being a defect. Each entry cites what
   * makes it documented — an entry with no citation is a guess, and a guess here silences a real
   * finding.
   */
  const KNOWN_LIMITATIONS = [
    {
      match: /placeholder|over the .* limit|relocat/i,
      why: 'content past SharePoint\'s ~400-character path limit is relocated with a placeholder '
        + 'link — in-scope feature 6.1 describes this as the documented adjustment',
    },
    {
      match: /SharePoint App|more versions at the destination/i,
      why: 'CloudFuze writes a "SharePoint App" placeholder version beside each real one '
        + '(figure 4.1.1), so a correct migration lands roughly twice the source count',
    },
    {
      match: /customXml|docProps|Office file\(s\) larger/i,
      why: 'SharePoint stamps its own customXml/docProps parts onto OOXML files on ingest, which '
        + 'grows them by roughly 20% without altering the document',
    },
  ];

  // A finding is a FAIL *or* an out-of-scope feature that MIGRATED. The latter now pushes PASS —
  // it did reach the destination, which is what PASS means — so filtering on status alone would
  // drop the single defect the out-of-scope controls exist to catch.
  const isOutOfScopeLeak = (c) => /^(8|9|10)\. Out-of-scope/i.test(String(c.name || ''))
    && /^MIGRATED/.test(String(c.detail || ''));

  const mismatches = checks
    .filter((c) => c.status === 'FAIL' || isOutOfScopeLeak(c))
    .map((c) => {
      const infra = infraCheck.test(c.name);
      const text = `${c.name} ${c.detail || ''}`;
      const limitation = KNOWN_LIMITATIONS.find((l) => l.match.test(text));
      const outOfScopeRan = OUT_OF_SCOPE_CHECK.test(c.name);
      const feature = IN_SCOPE_FEATURE(c.name);

      let bugStatus = 'bug';
      let kindLabel = 'Content comparison';
      let scopeNote = '';

      if (infra) {
        bugStatus = 'unknown';
        kindLabel = 'Validation could not run';
        scopeNote = 'The validator could not complete this check, so nothing is claimed about the '
          + 'migration. This is a gap in the QA run, not a CloudFuze defect.';
      } else if (limitation) {
        bugStatus = 'known_limitation';
        kindLabel = 'Known limitation — documented behaviour';
        scopeNote = `NOT A BUG: ${limitation.why}.`;
      } else if (outOfScopeRan) {
        // Two different things land here now that FAIL means "did not migrate" everywhere:
        //
        //   NOT MIGRATED  the documented outcome for an out-of-scope feature. Shown as a failure
        //                 because the job asked for it and the tool did not deliver — but it is
        //                 not a CloudFuze defect, so it must not become a ticket.
        //   MIGRATED      the product did MORE than the document describes. Still raised.
        const didMigrate = /^MIGRATED/.test(String(c.detail || ''));
        if (didMigrate) {
          bugStatus = 'bug';
          kindLabel = 'Out-of-scope feature migrated';
          scopeNote = 'An OUT-OF-SCOPE feature reached the destination. The product did MORE than '
            + 'the document says it does — worth raising, but it is not data loss.';
        } else {
          bugStatus = 'known_limitation';
          kindLabel = 'Out of scope — not delivered, as documented';
          scopeNote = 'NOT A BUG: this feature is on the out-of-scope list for this combination. '
            + 'It is reported as a failure because the job requested it and the destination did '
            + 'not receive it, but the document says it is not delivered, so no ticket is raised.';
        }
      } else if (feature) {
        bugStatus = 'bug';
        kindLabel = `In-scope feature ${feature.id} failed`;
        scopeNote = `IN SCOPE: the document lists "${feature.feature}" as a delivered feature for `
          + 'this combination, and it did not behave as described.';
      } else {
        // Unmapped: a failing check that matches no documented feature. Left as a bug rather than
        // quietly downgraded — silence on something nobody classified is how findings get lost.
        bugStatus = 'bug';
        scopeNote = 'This check maps to no documented feature; classified as a defect pending '
          + 'someone deciding where it belongs.';
      }

      return {
        category: 'content',
        kind: infra ? 'infrastructure' : 'content',
        kindLabel,
        bugStatus,
        featureId: feature ? feature.id : null,
        scope: infra ? 'infrastructure' : (outOfScopeRan ? 'out-of-scope' : (feature ? 'in-scope' : 'unmapped')),
        scopeNote,
        field: c.name,
        expected: 'source and destination identical',
        actual: c.detail || '(no detail)',
        summaryLine: `${c.name}: ${c.detail || '(no detail)'}`.slice(0, 300),
        severity: infra ? 'critical' : (bugStatus === 'known_limitation' ? 'info' : 'error'),
      };
    });

  const scanned = totals?.scannedSourceItems || 0;
  const paired = totals?.pairedCount || 0;

  return {
    featureChecklist,
    featureSummary,
    /** The 7 out-of-scope features — pass means it stayed out, fail means it migrated. */
    outOfScopeChecklist,
    outOfScopeCoverage,
    outOfScopeSummary,
    mismatches,
    status: overall,
    overallStatus: overall,
    domain: 'content',
    sourceProvider: 'sharefile',
    destinationProvider: 'sharepoint',
    combination: COMBINATION,
    checks,
    // Non-empty only when the comparison actually ran: the early returns pass `totals: null`, and a
    // unit built from nothing would render a panel reading "0 of 0 items found — Match".
    perUser: totals?.comparisonUnit ? [totals.comparisonUnit] : [],
    deepContentValidation: totals,
    summary: (() => {
      const passed = checks.filter((c) => c.status === 'PASS').length;
      // This sentence used to be a constant: "Permissions (features 2.1-2.4) are NOT assessed on
      // this combination — no documented role mapping." It outlived the mapping. A measured role
      // map now exists, and the run that first reached the permission ladder printed that sentence
      // directly beside a FAIL naming ten dropped group grants — a summary telling the reader to
      // disregard the only real finding in the report. Derive it from what the checks actually say.
      const permChecks = checks.filter((c) => /^2\. Permissions/.test(String(c.name || '')));
      const permJudged = permChecks.filter((c) => c.status === 'PASS' || c.status === 'FAIL');
      const permFailed = permChecks.filter((c) => c.status === 'FAIL');
      const permNote = permJudged.length === 0
        ? 'Permissions (features 2.1-2.4) were NOT assessed in this run — see the permission check '
          + 'for the reason.'
        : permFailed.length === 0
          ? `Permissions (features 2.1-2.4) were assessed: ${permJudged.length} check(s), all passed.`
          : `Permissions (features 2.1-2.4) were assessed and ${permFailed.length} FAILED: `
            + `${permFailed.map((c) => c.name.replace(/^2\. Permissions — /, '')).join('; ')}.`;
      const tail = `${scanned} source item(s) scanned, ${paired} paired. ${featureSummary.line} `
        + `${outOfScopeSummary}. ${permNote}`;
      if (scanned > 0 && paired === 0) {
        return `MIGRATION MOVED NOTHING — 0 of ${scanned} source item(s) reached the destination, so no `
          + `content was compared. ${passed}/${checks.length} reachability check(s) passed — these say `
          + `nothing about migrated data. ${tail}`;
      }
      const bugs = mismatches.filter((m) => m.bugStatus === 'bug').length;
      const limits = mismatches.filter((m) => m.bugStatus === 'known_limitation').length;
      const split = mismatches.length > 0
        ? ` ${bugs} defect(s), ${limits} known limitation(s).`
        : '';
      return `${passed}/${checks.length} checks passed.${split} ${tail}`;
    })(),
  };
}

module.exports = SharefileToSharepointValidationAgent;
/**
 * Exported for the test that asserts every feature able to report PASS is also able to report FAIL.
 * The list is the checklist's own definition, so the test cannot drift from what the report uses.
 */
module.exports.SHAREFILE_FEATURES = SHAREFILE_FEATURES;
/** Exported alongside, so a test can assert both halves of the scope stay in the report. */
module.exports.SHAREFILE_OUT_OF_SCOPE_FEATURES = SHAREFILE_OUT_OF_SCOPE_FEATURES;
/**
 * Exported for the test that pins bug-vs-limitation classification. Exercised through the real
 * function rather than a copy: a reimplementation in the test would keep passing while the
 * classifier that actually files tickets drifted.
 */
module.exports.buildResultForTest = buildResult;
/**
 * Exported so the permission-budget ordering is asserted directly rather than inferred from a run.
 * A wrong order here does not fail loudly — it produces a permission check that compared nothing.
 */
module.exports.selectPermissionTargets = selectPermissionTargets;
