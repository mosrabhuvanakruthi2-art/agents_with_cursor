/**
 * Google Shared Drive → OneDrive for Business — deep content validation.
 *
 * Eight features, and only eight. Four migration (1.1 one-time, 1.2 delta, 1.3 files & folders,
 * 1.4 structure) and four permissions (2.1 root folder, 2.2 sub-folder, 2.3 root file, 2.4 inner
 * file). Versions, shared links, timestamps and external shares are OUT of scope for this pair —
 * see `data/feature-scope/google-shared-drive-to-onedrive-outscope.md`.
 *
 * That narrowness is the most important thing about this file. The sibling
 * `googledriveToSharepoint` validator judges versions and links because ITS document promises them;
 * carrying those checks across would report a defect against a promise nobody made here, which is
 * the way this project has most often produced a wrong verdict. Out-of-scope observations are
 * reported at INFO and never contribute to a failure.
 *
 * DESTINATION NOTE. OneDrive is a personal drive, not a site library, so it is read through
 * `clients/onedriveClient` (`/users/{upn}/drive`) rather than sharepointClient. Underneath it is
 * still SharePoint Online, so SharePoint's naming and path rules apply unchanged — in-scope feature
 * 1.4 says so explicitly, and `validation/destinations/sharepoint.js` owns those rules.
 */
const ContentReportValidationAgent = require('../../../agents/content/ContentReportValidationAgent');
const driveClient = require('../../../clients/driveClient');
const onedriveClient = require('../../../clients/onedriveClient');
const core = require('../../shared/deepContentCore');
const roleMap = require('../../contentRoleMap');
const tolerance = require('../../../utils/contentTolerance');
// The Results screen reads u.items and u.folderStructure off each perUser entry; this builds both.
const { buildUnitResult } = require('../../shared/contentResultShape');
const logger = require('../../../utils/logger');
const env = require('../../../config/env');
const fs = require('fs');
const path = require('path');

const COMBINATION = 'googleshareddrive_to_onedrive';

/** The four permission positions the scope document names, and how an item is assigned to one. */
const POSITIONS = [
  { id: '2.1', label: 'Root Folder Permissions', type: 'folder', root: true },
  { id: '2.2', label: 'Subfolder Permissions', type: 'folder', root: false },
  { id: '2.3', label: 'Root File Permissions', type: 'file', root: true },
  { id: '2.4', label: 'Inner file permissions', type: 'file', root: false },
];

/**
 * A misplaced entry in words, whatever shape the comparator used.
 *
 * compareTrees reports a misplaced item as `{ source, dest }` (the two paths), not as a bare
 * `{ path }`. Reading `m.path || m` therefore fell through to the object itself and the report
 * printed "[object Object], [object Object], [object Object], [object Object]" — a failure detail
 * naming nothing the reader could open.
 */
function describeMisplaced(m) {
  if (!m || typeof m !== 'object') return String(m);
  const src = m.source && (m.source.path || m.source.name);
  const dst = m.dest && (m.dest.path || m.dest.name);
  if (src && dst) return `"${src}" → "${dst}"`;
  const one = m.path || m.name || src || dst;
  if (one) return `"${one}"`;
  return `(unrecognised shape: ${Object.keys(m).join(', ')})`;
}

/**
 * Pair the items compareTrees left over, using THIS destination's real rename rules.
 *
 * `deepContentCore.namesMatch` hardcodes `sanitizeForSharePoint` for an item's OWN name — the rules
 * object only reaches the ANCESTOR path candidates. So a folder CloudFuze renamed by replacing a
 * character SharePoint permits (`$ % &`) never pairs, and reports as one missing plus one extra.
 * Its children pair fine, because their ancestor path IS rules-aware. That asymmetry produced
 * "missing 1, extra 1" on run 7fadbadc for a folder sitting correctly at the destination.
 *
 * namesMatch is shared by every content combination, so it is left alone and the leftovers are
 * reconciled here instead.
 *
 * Deliberately conservative: a leftover pair is only accepted when the destination name is EXACTLY
 * the source name with invalid characters replaced, at the same depth and of the same type. A
 * looser rule would pair genuinely different folders and turn a real loss into a pass.
 */
function reconcileRenames(cmp, rules) {
  const missing = cmp.missing || [];
  const extra = cmp.extra || [];
  if (missing.length === 0 || extra.length === 0) return { renamed: [] };

  const depthOf = (p) => core.segmentsOf(String(p || '')).length;
  const renamed = [];
  const takenExtra = new Set();

  for (const m of missing) {
    const candidates = [rules.sanitizeName(m.name, '-'), rules.sanitizeName(m.name, '_')]
      .map((n) => core.normKey(n));
    const hit = extra.find((e) => !takenExtra.has(e)
      && e.type === m.type
      && depthOf(e.path) === depthOf(m.path)
      && candidates.includes(core.normKey(e.name)));
    if (!hit) continue;
    takenExtra.add(hit);
    renamed.push({ source: m.path, dest: hit.path, name: m.name, destName: hit.name });
    // Fold into the comparison so every downstream count agrees — a reconciliation that only
    // changed the wording would leave 1.4's numbers contradicting its own explanation.
    cmp.matched.set(m.path, { source: m, dest: hit });
    cmp.matchedCount = (cmp.matchedCount || 0) + 1;
  }
  cmp.missing = missing.filter((m) => !renamed.some((r) => r.source === m.path));
  cmp.extra = extra.filter((e) => !takenExtra.has(e));
  return { renamed };
}

/**
 * Find a source grant's principal among a destination item's permissions.
 *
 * THE DESTINATION IDENTITY IS NOT ALWAYS THE SOURCE ADDRESS. CloudFuze resolves each grantee to the
 * matching account in the destination tenant, and that account may sit on a different domain.
 * Measured on run 7fadbadc:
 *
 *   source grant  mia@filefuze.co   ->  destination  mia@cloudfuze.com   (read)
 *   source grant  alex@filefuze.co  ->  destination  alex@filefuze.co    (write)
 *
 * Matching on the exact address alone reported "no grant for this principal" for mia on every item
 * she was granted, failing 2.2 and 2.4 on permissions that had migrated correctly — with the right
 * role, including the documented commenter -> read collapse.
 *
 * Exact address, then display name, then the local part. The local-part fallback is last and the
 * caller records which rule matched, so a reader can see when a match was inferred rather than
 * exact. Link grants are never a principal match — a link is not a person.
 *
 * One function rather than two copies: the in-scope permission features and the out-of-scope
 * external-share observation must not disagree about whether a grantee arrived.
 *
 * @returns {{ grant: object, matchedBy: string } | null}
 */
function matchPrincipal(permissions, g) {
  const perms = Array.isArray(permissions) ? permissions.filter((p) => !p.isLink) : [];
  const wantEmail = String(g.email || '').toLowerCase();
  const wantName = String(g.name || '').toLowerCase();
  const localPart = (e) => String(e || '').toLowerCase().split('@')[0];

  if (wantEmail) {
    const hit = perms.find((p) => String(p.email || '').toLowerCase() === wantEmail);
    if (hit) return { grant: hit, matchedBy: 'email' };
  }
  if (wantName) {
    const hit = perms.find((p) => String(p.name || '').toLowerCase() === wantName);
    if (hit) return { grant: hit, matchedBy: 'display name' };
  }
  // A MIGRATED GROUP HAS NO EMAIL AT THE DESTINATION — only a display name.
  //
  // Measured on run fee5db73, reading `/00-OneDrive-Perms` raw:
  //
  //   {"email":"alex@gajha.com","name":"alex",      "roles":["write"]}
  //   {"email":null,            "name":"qa-group-view","roles":["write"]}
  //
  // The source grant is `qa-group-view@filefuze.co`, an email with no name; the destination entry
  // is a name with no email. None of the rules above can bridge that, so all three migrated groups
  // read as "no grant for this principal" — and the fallback then compared them against whoever
  // `group-mapping.csv` named, reporting `fileOrganizer -> read (expected Edit)` against mia while
  // `qa-group-view:write` sat on the very same item. Four features failed on a migration that was
  // in fact correct.
  //
  // Placed after the exact rules and before the email local-part rule: it is a name comparison, so
  // it must not win over a real address match.
  if (wantEmail) {
    const local = localPart(wantEmail);
    const hit = perms.find((p) => !p.email && String(p.name || '').toLowerCase() === local);
    if (hit) return { grant: hit, matchedBy: `group name (${wantEmail} -> "${hit.name}")` };
  }
  if (wantEmail) {
    const hit = perms.find((p) => localPart(p.email) && localPart(p.email) === localPart(wantEmail));
    if (hit) return { grant: hit, matchedBy: `local part (${wantEmail} -> ${hit.email})` };
  }
  return null;
}

/**
 * Source -> destination pairs the QA team maintains by hand, from `group-mapping.csv`.
 *
 * A GROUP MAPS TO A USER, which local-part matching can never discover: nothing in the
 * destination tenant is called "qa-group-view". The seeding agent already reads this file, and
 * the validator has to read the same one or the two disagree about who was mapped — which is
 * exactly what happened on run 0fa8ae2c.
 *
 * Cached per process: it is read once per run and never changes mid-run.
 */
let explicitMappingCache = null;
function readExplicitMapping() {
  if (explicitMappingCache) return explicitMappingCache;
  const out = new Map();
  const file = path.join(__dirname, '..', '..', '..', '..', '..', 'group-mapping.csv');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
      const [src, dst] = line.split(',').map((x) => String(x || '').trim().toLowerCase());
      if (src && dst) out.set(src, dst);
    }
  } catch {
    // Absent is not an error: local-part matching is right for ordinary users.
  }
  explicitMappingCache = out;
  return out;
}

/** An item is "root" when it sits directly under the migrated root — one path segment deep. */
function isRootLevel(relPath) {
  return core.segmentsOf(String(relPath || '')).length === 1;
}

/**
 * The file types in-scope feature 1.3 names. A run that moved only .txt files has not exercised
 * 1.3 however many items it moved, so the population is checked rather than assumed.
 */
const NAMED_TYPES = ['pdf', 'docx', 'xlsx', 'pptx'];
const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
const extOf = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};

class GoogleshareddriveToOnedriveValidationAgent extends ContentReportValidationAgent {
  static supportsDeepValidation = true;

  constructor(name = 'GoogleshareddriveToOnedriveValidationAgent') {
    super(name);
  }

  async execute(context) {
    const checks = [];
    const push = (status, name, detail) => checks.push({ status, name, detail });
    const bands = tolerance.forCombination(COMBINATION) || {};
    const totals = {
      combination: COMBINATION,
      enabled: true,
      sourceCount: 0,
      destCount: 0,
      matched: 0,
      missing: [],
      extra: [],
      foreignExtra: [],
      permissionObservations: [],
      // Grants that could not be judged, with the reason — kept separate from failures so a
      // gap in OUR data never reads as a defect in the product.
      notJudged: [],
      // The four OUT-of-scope features, observed and never judged. One bucket each, so the
      // checklist can print a row per documented feature instead of one lumped INFO line that
      // reads as 'we did not look'.
      outOfScope: {
        externalSource: [], externalDest: [], linksSource: [], linksDest: [],
        tsCompared: 0, tsCreatedDrift: [], tsModifiedDrift: [], versions: null,
      },
    };

    const sourceEmail = context.sourceEmail || context.sourceUser || '';
    const destEmail = context.destinationEmail || context.destinationUser || '';
    // The env default is part of the contract, not a convenience.
    //
    // The run wizard does not yet collect a Shared Drive name for this combination — run 427d0630
    // arrived with sourceSharedDriveName, sourceFolderName and destinationPath all undefined, and
    // the seeder still worked because it falls back to GOOGLE_SHARED_DRIVE_NAME. A validator that
    // did NOT fall back the same way would report "no Shared Drive" on a run that had just seeded
    // and migrated one, so the two must read the same source of truth.
    const driveName = context.sourceSharedDriveName || context.sourceFolder
      || env.GOOGLE_SHARED_DRIVE_NAME || '';

    // ── Source: the Shared Drive ────────────────────────────────────────────────────────
    let sharedDrive = null;
    try {
      sharedDrive = await driveClient.resolveSharedDriveByName(driveName, sourceEmail);
    } catch (err) {
      push('FAIL', 'Source location', `Shared Drive lookup failed: ${err.message}`);
    }
    if (!sharedDrive) {
      push('FAIL', 'Source location',
        `Shared Drive "${driveName}" is not visible to ${sourceEmail}. Nothing can be compared, so `
        + 'no feature is judged — a missing source is not evidence about the migration.');
      return this._result(checks, totals, context);
    }
    const driveId = sharedDrive.id || sharedDrive;
    totals.sourceLabel = `${sharedDrive.name || driveName}`;
    push('PASS', 'Source location', `Shared Drive "${sharedDrive.name || driveName}" resolved`);

    // ── Destination: the user's OneDrive ────────────────────────────────────────────────
    let destDrive = null;
    try {
      destDrive = await onedriveClient.resolveDrive(destEmail);
    } catch (err) {
      // resolveDrive already distinguishes "no permission" from "no OneDrive" in its message,
      // because Graph reports both as 404 and the two need different fixes.
      push('FAIL', 'Destination location', err.message);
      return this._result(checks, totals, context);
    }
    push('PASS', 'Destination location',
      `OneDrive for ${destEmail} resolved (${destDrive.driveType}, owner ${destDrive.owner || '?'})`);

    // ── Read both trees ─────────────────────────────────────────────────────────────────
    // The seeded tree lives in a FOLDER inside the drive, not at the drive root.
    //
    // DriveTestDataAgent creates `<sourceFolderName>` under the resolved drive and seeds into that.
    // Reading from the drive root instead would pull in every other folder the drive holds —
    // QA_Team1 also contains "Agent Shared Drive" and "qa-automation" from other work — and every
    // one of them would count as an extra item, failing 1.4 on a correct migration. Same class of
    // bug as the /tosharedrive foreign-content failure on the Dropbox pair.
    const sourceFolderName = context.sourceFolderName || sharedDrive.name || driveName;
    const seededRoot = await driveClient.findByName(sourceFolderName, driveId, sourceEmail)
      .catch(() => null);
    if (!seededRoot) {
      push('FAIL', 'Source location',
        `Shared Drive "${sharedDrive.name || driveName}" resolved, but it holds no folder named `
        + `"${sourceFolderName}" — the seeded tree could not be found, so nothing can be compared. `
        + 'Seeding creates that folder, so an absence here means seeding did not run or used a '
        + 'different name.');
      return this._result(checks, totals, context);
    }
    const sourceTree = await this._readSourceTree(seededRoot.id, driveId, sourceEmail, bands);
    totals.sourceCount = sourceTree.length;
    push(sourceTree.length > 0 ? 'PASS' : 'FAIL', 'Source items scanned',
      `${sourceTree.length} item(s) read from Shared Drive "${sharedDrive.name || driveName}"`);
    if (sourceTree.length === 0) return this._result(checks, totals, context);

    // The migrated tree lands in a folder named after the source drive. The destination is a
    // PERSONAL OneDrive that already held hundreds of unrelated items before this combination ever
    // ran, so the comparison is scoped to that folder — everything else is another run's content
    // and must not be counted as this run's "extra".
    // THE SEEDED FOLDER NAME IS PART OF THE DESTINATION PATH, and leaving it off costs everything.
    //
    // `destinationPath` is the CONTAINER the wizard sends (e.g.
    // "QA-SharedDrive-dest/QA-SharedDrive-To-OneDrive"); the migrated tree arrives as
    // `<container>/<sourceFolderName>` inside it, because the seeded folder travels as a folder.
    //
    // Reading from the container instead put every destination path one level deeper than its
    // source counterpart — run 7fadbadc migrated 99/99 items successfully and the comparison still
    // reported "matched 0, misplaced 95", failing 1.1 and 1.4 and leaving all four permission
    // features unexercised because nothing paired. A clean migration read as a total failure.
    //
    // The container is tried as a fallback for a run whose destination genuinely is the tree root.
    const destContainer = String(context.destinationPath || '').replace(/^\/+|\/+$/g, '');
    const destFound = await this._findMigratedRoot(
      destDrive.id, destContainer, sourceFolderName, destEmail, sharedDrive.name || driveName
    );
    const destRootName = destFound ? destFound.path : (destContainer || sourceFolderName);
    const destRootItem = destFound ? destFound.item : null;
    if (destFound && destFound.siblings) {
      push('WARN', 'Destination location — more than one migrated copy',
        `The destination holds ${destFound.siblings.length} folders that could be this run's `
        + `migrated tree: ${destFound.siblings.join(', ')}. "${destFound.item.name}" was used, `
        + 'chosen by last-modified time — but they carry the same creation timestamp, so the choice '
        + 'is not certain. Every verdict below describes THAT copy. Clear the destination between '
        + 'runs so a report cannot silently describe an earlier run\'s data.');
    }
    if (destFound && destFound.dedup) {
      // Named, because it changes what "extra" means at the destination: the previous run's copy is
      // still sitting beside this one.
      push('INFO', 'Destination location — dedup suffix',
        `The migrated tree arrived as "${destFound.item.name}" rather than "${sourceFolderName}", `
        + 'because a folder of that name already existed from an earlier run. This run is validated '
        + 'against the NEW copy. Clear the destination between runs to avoid the pile-up.');
    }
    if (!destRootItem) {
      const roots = (await onedriveClient.listChildren(destDrive.id, '', destEmail).catch(() => []))
        .filter((k) => k.folder).slice(0, 15).map((k) => k.name);
      push('FAIL', 'Destination location',
        `No folder named "${destRootName}" exists in ${destEmail}'s OneDrive, so the migrated tree `
        + `could not be found. Folders present at the root include: ${roots.join(', ') || '(none)'}.`);
      return this._result(checks, totals, context);
    }

    totals.destLabel = destRootName;
    const destTree = await onedriveClient.buildFolderTree(destDrive.id, destRootName, destEmail, {
      maxDepth: bands.treeDepth || 25,
    });
    totals.destCount = destTree.length;
    push('PASS', 'Destination tree read',
      `${destTree.length} item(s) read from OneDrive under "${destRootName}"`);

    // ── 1.3 / 1.4 structure ─────────────────────────────────────────────────────────────
    const destRules = require('../../destinations/onedriveViaCloudfuze');
    const cmp = core.compareTrees(sourceTree, destTree, {
      // CloudFuze sanitises MORE than SharePoint requires — see onedriveViaCloudfuze.
      rules: destRules,
      pathLimit: bands.pathLengthLimit,
      segmentLimit: bands.segmentLengthLimit,
    });
    // Pair what compareTrees could not, then drop the items the destination legitimately
    // replaced with a link rather than losing.
    const { renamed } = reconcileRenames(cmp, destRules);
    totals.renamed = renamed;
    totals.placeholderLinks = cmp.placeholderLinks || [];
    // An item is expected-absent when the destination substituted a link ANYWHERE UNDER IT.
    //
    // Matching placeholder paths exactly missed every case: the placeholder entries are the deep
    // leaves (504 characters) while the items reported missing are their ANCESTORS (260 and 382) —
    // once a branch goes over the path limit the destination cannot create the intermediate folders
    // either, so the whole branch is absent by design. Feature 1.4 allows exactly this ("subject to
    // SharePoint Online path length and naming limitations"), so failing on it would report the
    // documented behaviour as a defect.
    //
    // THE PLACEHOLDER CAN SIT ABOVE OR BELOW THE MISSING ITEM, and both directions are real.
    //
    //   above  /Over Limit Path/L1/L2/L3          <- placeholder written here
    //          /Over Limit Path/L1/L2/L3/L4       <- cannot exist, its parent is a link
    //          /Over Limit Path/…/over_limit_target.txt
    //
    //   below  /Long…/A (260 chars)               <- missing, cannot be created
    //          /Long…/A/B/C (504 chars)           <- placeholder written here
    //
    // Testing only one direction left the other reading as data loss. The `above` case is what the
    // Results screen showed as "Over Limit Path  6 -> 3  Mismatch": the validator had already
    // excused the branch for feature 1.4 (missing 0), while two of its items still reached the
    // screen as Missing, so the folder table contradicted the verdict two sections above it.
    //
    // Only the branch that actually produced a placeholder is excused; an unrelated missing item is
    // still a real loss.
    const placeholderPaths = totals.placeholderLinks.map((x) => String(x.path || x));
    const underPlaceholder = (p) => {
      const path = String(p || '');
      return placeholderPaths.some((ph) => ph === path
        || ph.startsWith(`${path}/`)
        || path.startsWith(`${ph}/`));
    };
    const expectedAbsent = (cmp.missing || []).filter((m) => underPlaceholder(m.path));
    totals.expectedAbsent = expectedAbsent;
    cmp.missing = (cmp.missing || []).filter((m) => !underPlaceholder(m.path));
    totals.matched = cmp.matchedCount;
    totals.missing = cmp.missing || [];
    totals.extra = cmp.extra || [];

    // The Results screen needs the per-item rows, not just the feature verdicts.
    totals.unitResult = buildUnitResult(sourceTree, cmp, {
      placeholderPaths: new Set(expectedAbsent.map((m) => m.path)),
      // Named, or the shared renderer falls back to "Box" and "SharePoint" — two clouds this
      // combination does not touch, printed as the tree headings on run e8fc456e.
      sourceLabel: 'Google Shared Drive',
      destLabel: 'OneDrive',
      sourceRootName: sharedDrive.name || driveName,
      destRootName,
      destTree,
      destCount: destTree.length,
    });

    this._checkFilesAndFolders(push, sourceTree, cmp, totals);
    this._checkStructure(push, sourceTree, destTree, cmp, totals);

    // ── 1.1 / 1.2 migration type ────────────────────────────────────────────────────────
    this._checkMigrationType(push, context, cmp);

    // ── 2.1–2.4 permissions ─────────────────────────────────────────────────────────────
    await this._checkPermissions(push, sourceTree, cmp, destDrive, destEmail, sourceEmail,
      totals, context, driveId);

    // ── Out-of-scope observations, reported and never failed ────────────────────────────
    // Timestamps come off the two trees that were already read, so observing them costs nothing.
    this._observeTimestamps(cmp, totals);
    this._reportOutOfScope(push, totals);

    return this._result(checks, totals, context);
  }

  /**
   * Find the migrated tree at the destination by SEARCHING for it, not by guessing its path.
   *
   * Two things defeat a constructed path, and run 65aa3d8f hit both at once:
   *
   *   1. The destination is `<container>/<sourceDriveName>/<sourceFolderName>` — TWO levels are
   *      appended, because the wizard derives "Destination drive + drive name" and CloudFuze then
   *      places the source folder inside that. Reading `<container>/<sourceFolderName>` missed it
   *      and fell back to the container, so the comparison saw 8 destination items against 98
   *      source items and reported "matched 0, missing 92" on a 99/99 migration.
   *
   *   2. CloudFuze appends a DEDUP SUFFIX when the folder already exists. The same destination held
   *      "QA-Source" from the previous run and "QA-Source 1" from this one, so even the correct
   *      path pointed at the OLDER copy — a run would be validated against its predecessor's data.
   *
   * So the container is walked and every folder whose name is the seeded name, or that name plus a
   * numeric dedup suffix, is collected. The NEWEST is chosen, because that is this run's copy.
   *
   * @returns {{ path, item, dedup } | null}
   */
  async _findMigratedRoot(driveId, container, folderName, upn, driveName = null) {
    const wanted = core.normKey(folderName);
    // "QA-Source 1", "QA-Source (1)" and "QA-Source" all count; "QA-Source-old" does not.
    const isCandidate = (name) => {
      const n = core.normKey(name);
      if (n === wanted) return true;
      return new RegExp(`^${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ _-]*\\(?\\d+\\)?$`).test(n);
    };

    const hits = [];
    const walk = async (path, depth) => {
      if (depth > 3 || hits.length > 20) return;
      const kids = await onedriveClient.listChildren(driveId, path, upn).catch(() => []);
      for (const k of kids) {
        if (!k.folder) continue;
        const childPath = path ? `${path}/${k.name}` : k.name;
        if (isCandidate(k.name)) { hits.push({ path: childPath, item: k }); continue; }
        // Only descend past a non-match — a match is the root we want, not a container.
        await walk(childPath, depth + 1);
      }
    };
    await walk(container, 0);
    if (hits.length === 0) return null;

    // Newest wins: on a re-run the dedup copy is this run's, and the plain name is the last one's.
    //
    // `createdDateTime` is the RAW Graph field. listChildren returns Graph items untouched — only
    // buildFolderTree renames it to `createdAt` — so sorting on `createdAt` here compared undefined
    // against undefined, left the order untouched, and picked whichever folder Graph listed first.
    // On a destination holding "QA-Source" and "QA-Source 1" that is a coin toss between this run's
    // data and the previous run's.
    // THE DEDUP SUFFIX IS THE ONLY RELIABLE "NEWEST" SIGNAL, so it outranks the expected path.
    //
    // CloudFuze writes to `<container>/<sourceDriveName>/<sourceFolderName>` and, when that name
    // is taken, appends a number — so `QA-Source 1` is by construction newer than `QA-Source`.
    // Preferring the bare expected path would therefore pick the PREVIOUS run every time a copy
    // survives, which is exactly the state run e8fc456e found: its own data landed in
    // `QA-Source 1` while `QA-Source` still held run fac87df0's. The two happened to be
    // identical that day, so the wrong choice cost nothing — it will not stay that way.
    //
    // Timestamps rank last because they cannot separate copies at all: CloudFuze preserves the
    // source folder's own dates, so every copy reports the same created AND modified time
    // (measured: 2026-09-17T09:59:12Z on both).
    const dedupNumber = (name) => {
      const n = core.normKey(name);
      const base = core.normKey(folderName);
      if (n === base) return 0;
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`^${escaped}[ _-]*\\(?(\\d+)\\)?$`).exec(n);
      return m ? Number(m[1]) : 0;
    };
    const preferred = [
      driveName ? `${container}/${driveName}/${folderName}` : null,
      `${container}/${folderName}`,
    ].filter(Boolean).map((x) => x.replace(/^\/+|\/+$/g, ''));
    const rank = (h) => preferred.indexOf(h.path.replace(/^\/+|\/+$/g, ''));
    const stamp = (it) => `${it.lastModifiedDateTime || ''}|${it.createdDateTime || it.createdAt || ''}`;

    hits.sort((a, b) => {
      const d = dedupNumber(b.item.name) - dedupNumber(a.item.name);
      if (d !== 0) return d;
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
      return stamp(b.item).localeCompare(stamp(a.item));
    });
    const chosen = hits[0];
    return {
      ...chosen,
      dedup: core.normKey(chosen.item.name) !== wanted,
      // Reported rather than resolved silently. When two copies are indistinguishable the choice is
      // a guess, and a guess that decides which run's data gets validated must be visible — the
      // alternative is a report that looks authoritative while describing the previous run.
      siblings: hits.length > 1 ? hits.map((h) => h.item.name) : null,
    };
  }

  /** Flatten the Shared Drive into the same shape the comparator expects from the destination. */
  async _readSourceTree(rootId, driveId, email, bands) {
    const out = [];
    const walk = async (parentId, relPath, depth) => {
      if (depth > (bands.treeDepth || 25)) return;
      const kids = await driveClient.listChildrenDetailed(parentId, email, driveId).catch(() => []);
      for (const k of kids) {
        const isFolder = k.mimeType === driveClient.FOLDER_MIME;
        const path = `${relPath}/${k.name}`;
        out.push({
          id: k.id,
          name: k.name,
          path,
          type: isFolder ? 'folder' : 'file',
          size: k.size ? Number(k.size) : null,
          mimeType: k.mimeType || null,
          createdAt: k.createdTime || null,
          modifiedAt: k.modifiedTime || null,
        });
        if (isFolder) await walk(k.id, path, depth + 1);
      }
    };
    await walk(rootId, '', 0);
    return out;
  }

  /**
   * 1.3 — the document NAMES the file types, so they are the population.
   *
   * A run that moved a thousand .txt files has not exercised this feature. Reported as not
   * exercised rather than passed when none of the named types is present, because a pass here would
   * claim coverage the run does not have.
   */
  _checkFilesAndFolders(push, sourceTree, cmp, totals) {
    const files = sourceTree.filter((i) => i.type === 'file');
    const folders = sourceTree.filter((i) => i.type === 'folder');
    const present = new Set(files.map((f) => extOf(f.name)).filter(Boolean));
    const named = NAMED_TYPES.filter((t) => present.has(t));
    const images = IMAGE_TYPES.filter((t) => present.has(t));
    const covered = [...named, ...(images.length ? ['image'] : [])];

    const missingFiles = (cmp.missing || []).filter((i) => i.type === 'file');
    if (files.length === 0 || folders.length === 0) {
      push('WARN', '1.3 Files & Folder Migration',
        `Not exercised: the source holds ${files.length} file(s) and ${folders.length} folder(s), `
        + 'and the feature is about migrating both.');
      return;
    }
    if (covered.length === 0) {
      push('WARN', '1.3 Files & Folder Migration',
        `${files.length} file(s) and ${folders.length} folder(s) migrated, but NONE of the types `
        + `the scope document names (${NAMED_TYPES.join(', ')}, images) is present in the source — `
        + `only ${[...present].join(', ') || 'none'}. The feature is not exercised by this data, so `
        + 'it is not claimed as passing.');
      return;
    }
    if (missingFiles.length === 0) {
      push('PASS', '1.3 Files & Folder Migration',
        `${files.length} file(s) and ${folders.length} folder(s) migrated with none missing, `
        + `covering the named types: ${covered.join(', ')}.`);
    } else {
      push('FAIL', '1.3 Files & Folder Migration',
        `${missingFiles.length} of ${files.length} file(s) did not arrive: `
        + missingFiles.slice(0, 5).map((i) => i.path).join(', '));
    }
  }

  /**
   * 1.4 — hierarchy preserved, subject to SharePoint Online limits.
   *
   * That qualifier is the feature, not a footnote: a renamed or relocated item is correct when
   * SharePoint's rules required it, and a defect otherwise. `core.compareTrees` already applies
   * those rules through `destinations/sharepoint`, so a rename it EXPECTED pairs rather than
   * showing up as missing-plus-extra.
   */
  _checkStructure(push, sourceTree, destTree, cmp, totals) {
    // Content already in the destination before this run is not this run's "extra". A personal
    // OneDrive is shared with everything else its owner does, and the migrated tree is only one
    // folder in it — the comparison is already scoped to that folder, so anything extra here really
    // is inside our own tree and worth reporting.
    const misplaced = cmp.misplaced || [];
    const folders = sourceTree.filter((i) => i.type === 'folder');
    const deepest = sourceTree.reduce((n, i) => Math.max(n, core.segmentsOf(i.path).length), 0);

    const detail = `source ${sourceTree.length}, dest ${destTree.length}, matched ${cmp.matchedCount}, `
      + `missing ${(cmp.missing || []).length}, extra ${(cmp.extra || []).length}, `
      + `misplaced ${misplaced.length}; ${folders.length} folder(s), deepest ${deepest} level(s)`;

    if ((cmp.missing || []).length === 0 && misplaced.length === 0 && (cmp.extra || []).length === 0) {
      push('PASS', '1.4 Preserving File/Folder structure', detail);
    } else if (misplaced.length > 0) {
      push('FAIL', '1.4 Preserving File/Folder structure',
        // `m.path || m` printed "[object Object]" four times in the report, because a misplaced
        // entry carries its paths on `source`/`dest` rather than a bare `path`. A detail that names
        // nothing is worse than a count — the reader cannot act on it. Every shape is unpacked
        // here, and an unrecognised one prints its keys rather than falling back to String(object).
        `${detail}. Misplaced items are the structure defect this feature exists to catch: `
        + misplaced.slice(0, 4).map(describeMisplaced).join('; '));
    } else {
      push('FAIL', '1.4 Preserving File/Folder structure', detail);
    }
  }

  /**
   * 1.1 and 1.2 are about the RUN TYPE, not about the data.
   *
   * A one-time run cannot exercise delta and a delta run cannot exercise one-time, so each reports
   * the other as not exercised. Passing 1.2 on a one-time run would be the unfalsifiable-pass
   * failure this project exists to avoid.
   */
  _checkMigrationType(push, context, cmp) {
    const isDelta = String(context.migrationType || '').toUpperCase() === 'DELTA';
    if (isDelta) {
      push('WARN', '1.1 One Time Migration',
        'This run was a DELTA migration, so the one-time path was not exercised.');
      push(cmp.matchedCount > 0 ? 'PASS' : 'FAIL', '1.2 Delta Migration',
        cmp.matchedCount > 0
          ? `Delta migration delivered ${cmp.matchedCount} matched item(s).`
          : 'Delta migration delivered nothing that paired with the source.');
      return;
    }
    push(cmp.matchedCount > 0 ? 'PASS' : 'FAIL', '1.1 One Time Migration',
      cmp.matchedCount > 0
        ? `One-time migration delivered the source tree (${cmp.matchedCount} item(s) matched).`
        : 'One-time migration delivered nothing that paired with the source.');
    push('WARN', '1.2 Delta Migration',
      'This run was a one-time migration, not a delta, so incremental changes were never exercised. '
      + 'Run the wizard with Migration type = Delta to cover it.');
  }

  /**
   * Wait for CLOUDFUZE'S PERMISSION PHASE, which runs after the copy and is a different scheduler.
   *
   * This is the piece the first four runs were missing, and CloudFuze's own Content scheduler model
   * says why. Permissions are not applied by the file movers:
   *
   *   MoveSmallFileScheduler / MoveLargeFileScheduler
   *       move the file, then CREATE an entry in the `CollabarationDetails` collection
   *   StatusModuleScheduler            (profile `stalejob`)
   *       triggered AFTER file/folder migration completes; generates the `PermissionQueue`
   *       so InvitePermissionScheduler can begin, then WAITS for permissions and hyperlinks
   *       before updating the workspace status
   *   InvitePermissionScheduler        (profile `invitePermJob`)
   *       picks NOT_PROCESSED entries from `CollabarationDetails`, fetches source and destination
   *       permissions, compares, and migrates the missing ones onto each file/folder
   *
   * So a workspace reporting `PROCESSED  totalCount 99  processedCount 99` means the FILES are
   * done. The grants are queued at that moment and applied afterwards, on the permission
   * scheduler's own cron — and a conflicted entry retries on exponential backoff (5, 15, 45 min).
   * Reading the destination the instant the copy finishes therefore measures the gap, not the
   * product. Runs 27a74447, 708f4eca and 8bacd461 all did exactly that.
   *
   * ADAPTIVE, NOT A FIXED WAIT. It returns the moment grants appear and stop changing across two
   * consecutive polls, so a healthy run pays only the time the phase actually takes. The budget is
   * a ceiling for a broken one, not a sleep — the alternative, a flat delay, wastes time on every
   * good run and was rejected for exactly that reason.
   *
   * Returning `false` does NOT excuse a missing grant. It records that the wait was exhausted so
   * the verdict can say "nothing arrived in N minutes" rather than implying we did not look.
   *
   * @returns {{ settled: boolean, waitedMs: number, grants: number }}
   */
  async _awaitPermissionsApplied(destDrive, destEmail, sampleIds, totals) {
    const budgetMs = env.SHAREDDRIVE_PERMISSION_SETTLE_MS;
    const pollMs = Math.max(15000, env.SHAREDDRIVE_PERMISSION_POLL_MS);
    const started = Date.now();
    const result = { settled: false, waitedMs: 0, grants: 0 };
    if (budgetMs <= 0 || sampleIds.length === 0) return result;

    const countGrants = async () => {
      let n = 0;
      for (const id of sampleIds) {
        const p = await onedriveClient.getPermissionsById(destDrive.id, id, destEmail)
          .catch(() => ({ readable: false, permissions: [] }));
        if (!p.readable) continue;
        // The destination account owns every migrated item, so its own entry is not evidence that
        // anything was replicated. Only a grant to somebody else counts.
        n += (p.permissions || []).filter((x) => x.isLink
          || String(x.email || '').toLowerCase() !== String(destEmail).toLowerCase()).length;
      }
      return n;
    };

    // GIVE UP EARLY WHEN NOTHING HAS STARTED, rather than spending the whole budget on silence.
    //
    // The phase either begins promptly or not at all. Measured across four runs: 0fa8ae2c saw its
    // first grants well inside 168s and settled there; fac87df0 and e8fc456e saw ZERO, and a
    // hand check found the destination still bare 1h45m later. So once several polls in a row have
    // produced nothing at all, the remaining minutes buy no information and only cost the run.
    //
    // The bail is on "never started", never on "still arriving": any non-zero count keeps the full
    // budget available, because a slow phase is exactly what the wait exists for.
    const EMPTY_POLLS_BEFORE_GIVING_UP = 5;
    let emptyPolls = 0;
    let last = -1;
    let stable = 0;
    while (Date.now() - started < budgetMs) {
      const now = await countGrants();
      result.grants = now;
      if (now === 0) {
        emptyPolls += 1;
        if (emptyPolls >= EMPTY_POLLS_BEFORE_GIVING_UP) {
          result.waitedMs = Date.now() - started;
          result.gaveUpEarly = true;
          logger.warn('[googleshareddrive→onedrive] permission phase never started — '
            + `no grant at all after ${emptyPolls} polls (${Math.round(result.waitedMs / 1000)}s). `
            + 'Not waiting out the rest of the budget: a phase that has not begun by now has not '
            + 'begun at all on this job.');
          totals.permissionWaitExhausted = true;
          return result;
        }
      } else {
        emptyPolls = 0;
      }
      if (now > 0 && now === last) {
        stable += 1;
        // Two agreeing polls, because the phase writes grants item by item and a single reading
        // mid-write looks settled while more are still arriving.
        if (stable >= 2) {
          result.settled = true;
          result.waitedMs = Date.now() - started;
          logger.info(`[googleshareddrive→onedrive] permission phase settled after `
            + `${Math.round(result.waitedMs / 1000)}s with ${now} grant(s) on the sample`);
          return result;
        }
      } else {
        stable = 0;
      }
      last = now;
      await new Promise((r) => setTimeout(r, pollMs));
    }

    result.waitedMs = Date.now() - started;
    logger.warn(`[googleshareddrive→onedrive] permission phase did NOT settle within `
      + `${Math.round(budgetMs / 60000)} min — ${result.grants} grant(s) on the sample`);
    totals.permissionWaitExhausted = true;
    return result;
  }

  /**
   * WHAT ACTUALLY MIGRATES FROM A SHARED DRIVE IS THE DRIVE'S MEMBERSHIP.
   *
   * This replaced a model that looked for DIRECT, non-inherited grants on each item — and that
   * model cannot work on a Shared Drive. Measured on QA-SharedDrive-To-OneDrive:
   *
   *   before adding members   /00-OneDrive-Perms   alex@filefuze.co writer   inherited=false
   *   after  adding members   /00-OneDrive-Perms   alex@filefuze.co fileOrganizer inherited=TRUE
   *                                                mia@filefuze.co  reader        inherited=TRUE
   *
   * Google absorbs an item-level grant into drive membership the moment the grantee becomes a
   * member, so on a properly populated drive there are NO direct item grants left to compare. And a
   * grant to a NON-member does not migrate at all: two full runs (27a74447, 708f4eca) seeded direct
   * grants to non-members, the jobs reported PROCESSED 99/99 with every permission option enabled
   * and the mapping forced to destination identities, and every migrated item arrived carrying
   * `granger@gajha.com:owner` and nothing else.
   *
   * The QA team's own hand-run migrations show what does arrive. In the same OneDrive,
   * `/premissions_data/sub-folder-premissionss` carries `alex@gajha.com:write mia@gajha.com:read`
   * — and on the source drives those two are members at `fileOrganizer` and `reader`. Their DRIVE
   * roles, mapped through the role table, applied to each migrated item. That is the contract.
   *
   * So each position is judged by asking whether the drive's membership reached an item at that
   * position, which is exactly what in-scope 2.1-2.4 promise ("preserves all root folder / subfolder
   * / root file / inner file permissions along with access levels") for this source.
   *
   * Sampled rather than exhaustive: up to SAMPLE_PER_POSITION items per position, because the
   * membership is drive-wide and reading all 98 items would make ~98 Graph calls to re-answer the
   * same question. A disagreement between sampled items is itself worth seeing, which is why more
   * than one is read.
   */
  async _checkMembershipAtPositions(push, sourceTree, cmp, destDrive, destEmail, driveId,
    sourceEmail, totals, mappedSources) {
    const SAMPLE_PER_POSITION = 3;

    const drivePerms = await driveClient.listPermissions(driveId, sourceEmail)
      .catch((err) => ({ grants: [], err: err.message }));
    const members = (drivePerms.grants || []).filter((g) => g.email || g.name);
    totals.driveMembership = members.map((g) => ({
      email: g.email || g.name, role: g.role, type: g.type,
    }));

    if (members.length === 0) {
      push('WARN', 'Source Shared Drive membership',
        'The Shared Drive lists no members, so there is no permission to migrate and none of '
        + '2.1-2.4 can be exercised. A Shared Drive migrates its MEMBERSHIP — add the test '
        + 'collaborators as drive members (the working drives QA_Team1 and QA_Team2 carry '
        + 'mia:reader, alex:fileOrganizer, qa-group-view:fileOrganizer, qa-group-edit:writer).');
      return;
    }

    // The source account maps to the destination account, which OWNS the copy. `owner` is
    // deliberately not comparable — the destination account has nothing to map onto.
    const srcLc = String(sourceEmail || '').toLowerCase();
    const explicit = readExplicitMapping();
    const expected = [];
    for (const m of members) {
      const who = String(m.email || m.name || '').toLowerCase();
      if (!who || who === srcLc) continue;
      if (!roleMap.isComparableDriveRole(m.role)) continue;

      // THE SAME EXPLICIT MAPPING THE SEEDER USES, or this contradicts itself. Run 0fa8ae2c
      // passed 2.1-2.4 while every row still carried "3 drive member(s) have no principal with
      // the same local part in the destination tenant, so their access cannot arrive:
      // qa-group-view/edit/manage". Reading the destination by hand showed all three HAD
      // arrived, as groups, with the right roles. The warning was false, and worse, those three
      // members were dropped from the comparison — so a PASS covering 2 of 5 comparable
      // principals was presented as if it covered them all.
      // A COUNTERPART IS A HINT, NOT A GATE — the item itself is the evidence.
      //
      // This used to refuse to judge a member without a resolvable destination identity, and to
      // prefer `group-mapping.csv` when one existed. Both were wrong, and the second was worse:
      //
      //   - `qa-group-view@filefuze.co` has no principal of that local part in the destination
      //     tenant, so it was dropped as "no counterpart" — while `qa-group-view` sat on every
      //     migrated item holding exactly the role the feature wanted (run fee5db73).
      //   - group-mapping.csv maps that group to `mia@gajha.com`, so when the gate was removed the
      //     expectation became mia's `read` and the group's correct `write` read as a mismatch.
      //
      // CloudFuze migrates these groups AS GROUPS, under the same name. So the counterpart is only
      // used to report an expected address and as a fallback lookup; `matchPrincipal` finds the
      // real entry by name. A member that genuinely never arrives still fails, on the item's own
      // evidence rather than on a directory lookup guessing wrong beforehand.
      const counterpart = await onedriveClient.resolveCounterpart(who, destEmail).catch(() => null);
      const hinted = counterpart ? counterpart.address : (explicit.get(who) || null);
      if (!counterpart && !mappedSources.has(who)) {
        // Recorded, not skipped: the comparison still runs below.
        totals.notJudged.push({ path: '(drive membership)', email: who, role: m.role,
          why: 'no-counterpart-hint' });
      }
      expected.push({ source: who, role: m.role, type: m.type, dest: hinted });
    }

    totals.expectedMembers = expected;
    push(expected.length > 0 ? 'PASS' : 'WARN', 'Source Shared Drive membership',
      `${members.length} member(s) on the drive; ${expected.length} judgeable at the destination: `
      + (expected.map((e) => `${e.source} ${e.role} -> `
        + `${roleMap.compareDriveAccess(e.role, []).expectedSpLabel}`
        + `${e.dest ? ` (expected as ${e.dest})` : ' (matched on the destination item itself)'}`)
        .join('; ') || 'none'));
    if (expected.length === 0) return;

    // Chosen BEFORE the wait, so the wait watches exactly the items the verdicts are built from.
    const samples = new Map();
    for (const pos of POSITIONS) {
      samples.set(pos.id, sourceTree.filter((i) => i.type === pos.type
        && isRootLevel(i.path) === pos.root
        && cmp.matched.get(i.path)?.dest?.id).slice(0, SAMPLE_PER_POSITION));
    }
    const sampleIds = [...samples.values()].flat().map((i) => cmp.matched.get(i.path).dest.id);
    totals.permissionWait = await this._awaitPermissionsApplied(destDrive, destEmail,
      sampleIds, totals);

    // ONE LOST FILE APPEARS TO TAKE THE WHOLE PERMISSION PHASE WITH IT.
    //
    // Measured across five runs of identical data and identical job options:
    //
    //   0fa8ae2c  every file arrived      -> 88 grants in 168s
    //   fee5db73  every file arrived      -> 88 grants in 175s
    //   fac87df0  macro_workbook.xlsm lost -> no grant, ever
    //   e8fc456e  macro_workbook.xlsm lost -> no grant, ever
    //   2131e548  macro_workbook.xlsm lost -> no grant after 3 hours
    //
    // Five for five. CloudFuze's own Content scheduler model explains it: a file the movers cannot
    // write is marked `conflict`, `StatusModuleScheduler` only generates the PermissionQueue once
    // file migration for the workspace is COMPLETE, and `InvitePermissionScheduler` reads that
    // queue. A workspace holding one conflicted file therefore never reaches the permission stage
    // at all — which is why the loss is total rather than partial.
    //
    // Said once, on the run where it applies, so a reader sees six failures with ONE cause instead
    // of six independent ones. It is an observation, not a verdict: the permission features below
    // still fail on their own evidence.
    const lostFiles = (totals.missing || []).filter((m) => m && m.type !== 'folder');
    if (!totals.permissionWait.settled && lostFiles.length > 0) {
      push('INFO', 'Permission phase — likely blocked by an unmigrated file',
        `No permission arrived, and ${lostFiles.length} file(s) also failed to migrate `
        + `(${lostFiles.slice(0, 3).map((m) => m.path || m).join(', ')}). Across five runs of this `
        + 'combination the two always occurred together: both runs where every file arrived got '
        + 'their grants within ~170s, and all three runs that lost a file got no grant at all. '
        + 'CloudFuze generates the permission queue only once file migration for the workspace is '
        + 'complete, so a single conflicted file appears to stop the permission phase from '
        + 'starting. Fixing the file is likely to fix 2.1-2.4 with it.');
    }

    for (const pos of POSITIONS) {
      const sample = samples.get(pos.id) || [];
      for (const item of sample) {
        const destItem = cmp.matched.get(item.path).dest;
        const destPerms = await onedriveClient
          .getPermissionsById(destDrive.id, destItem.id, destEmail)
          .catch(() => ({ readable: false, permissions: [] }));
        if (!destPerms.readable) {
          totals.permissionObservations.push({ path: item.path, readable: false });
          continue;
        }
        for (const e of expected) {
          const matched = matchPrincipal(destPerms.permissions, { email: e.source, name: e.source })
            || matchPrincipal(destPerms.permissions, { email: e.dest, name: e.dest });
          const destGrant = matched && matched.grant;
          const cmpRes = roleMap.compareDriveAccess(e.role, (destGrant && destGrant.roles) || []);
          totals.permissionObservations.push({
            path: item.path,
            type: item.type,
            root: isRootLevel(item.path),
            readable: true,
            email: e.source,
            principalType: e.type,
            sourceRole: e.role,
            expected: cmpRes.expectedSpLabel,
            actual: destGrant ? (destGrant.roles || []).join('/') : 'no grant for this principal',
            match: Boolean(cmpRes.match),
            matchedBy: matched ? matched.matchedBy : null,
            via: 'drive membership',
          });
        }
      }
    }
  }

  /**
   * Which source principals the RUN told CloudFuze how to translate.
   *
   * A grant can only arrive if the migration knows what its grantee becomes at the destination.
   * CloudFuze reads that from the permission-mapping CSV, which migrationClient builds from
   * `context.userEmailMappings`. Anything absent from it has no destination identity, so the grant
   * is dropped — and a validator that does not know which principals were mapped reports that drop
   * as a product defect.
   *
   * That is exactly what happened on run 27a74447: the mapping carried one pair
   * (erik@filefuze.co -> granger@gajha.com) while the seeded tree carried grants for alex@, mia@,
   * warner@ and two groups. All 21 grants read "no grant for this principal" and all four
   * permission features failed, on a job that had requested every permission flag and a source
   * that genuinely held the grants.
   *
   * Three sources are merged because each can be the only one populated: the Map-Users pairs the
   * run was started with, the pairs the migration reported back, and the mapping CloudFuze resolved
   * for itself. `migratedUsers` and `permissionMapping` are read the same way boxToSharepoint reads
   * them, so the two combinations agree on what "mapped" means.
   */
  _mappedSources(context) {
    const out = new Set();
    const add = (v) => { const s = String(v || '').toLowerCase().trim(); if (s) out.add(s); };

    for (const m of (context.userEmailMappings || [])) add(m?.sourceEmail);
    for (const m of (context.migratedUsers || [])) add(m?.sourceEmail);
    const pm = context.permissionMapping;
    if (Array.isArray(pm)) {
      for (const m of pm) add(m?.sourceEmail || m?.fromMailId || m?.from);
    } else if (pm && typeof pm === 'object') {
      for (const k of Object.keys(pm)) add(k);
    }
    // The source account itself is always mapped — it is the migrating pair.
    add(context.sourceEmail);
    return out;
  }

  /**
   * 2.1–2.4 — the same comparison at four positions.
   *
   * Split by position deliberately: a run that only checks the root proves nothing about
   * inheritance, which is why the scope document names four features rather than one.
   */
  async _checkPermissions(push, sourceTree, cmp, destDrive, destEmail, sourceEmail, totals,
    context = {}, driveId = null) {
    const mappedSources = this._mappedSources(context);

    // The primary evidence for 2.1-2.4 on a Shared Drive source. Runs FIRST so the positional
    // rollup below sees its observations; the per-item pass that follows only adds direct grants,
    // which a populated Shared Drive will not have any of.
    if (driveId) {
      await this._checkMembershipAtPositions(push, sourceTree, cmp, destDrive, destEmail,
        driveId, sourceEmail, totals, mappedSources);
    }
    for (const item of sourceTree) {
      const pair = cmp.matched.get(item.path);
      const dest = pair && pair.dest;
      if (!dest || !dest.id) continue;

      const srcPerms = await driveClient.listPermissions(item.id, sourceEmail).catch(() => null);
      const grants = (srcPerms && srcPerms.grants) || [];
      // A grant is JUDGED only when it could have migrated at all. Two grants cannot, and
      // reporting either as a product defect is the wrong verdict:
      //
      //   unmappable — the run never told CloudFuze what this grantee becomes at the
      //                destination, so there was nobody to grant to. Our data-creation gap,
      //                measured on run 27a74447 where a 1-pair permission mapping lost all 21
      //                grants. The seeding agent now publishes these pairs; this is the guard
      //                that keeps a future gap from reading as a FAIL again.
      //
      //   external   — an out-of-scope mechanism for this combination. It is observed under
      //                OS 1.1 and must not also decide an in-scope position, or 2.x would be
      //                exercised through a promise this document does not make.
      // Classified FIRST: the judging below and the out-of-scope observation below that both
      // read it, so it cannot be declared between them.
      // Classified FIRST: the judging below and the out-of-scope observation below that both
      // read it, so it cannot be declared between them.
      const osSource = this._classifyOutOfScopeGrants(grants, sourceEmail,
        (srcPerms && srcPerms.links) || []);
      const allComparable = grants.filter((g) => !g.inherited
        && roleMap.isComparableDriveRole(g.role));
      const externalSet = new Set(osSource.external);
      const comparable = [];
      for (const g of allComparable) {
        const who = String(g.email || g.name || '').toLowerCase();
        if (externalSet.has(g)) {
          totals.notJudged.push({ path: item.path, email: who, role: g.role, why: 'external' });
          continue;
        }
        if (who && !mappedSources.has(who)) {
          totals.notJudged.push({ path: item.path, email: who, role: g.role, why: 'unmapped' });
          continue;
        }
        comparable.push(g);
      }

      // OUT-OF-SCOPE OBSERVATION, from the classification above — the grants for this item were
      // already fetched for 2.1-2.4, so recording them costs no extra call. External shares and
      // shared links are out of scope here, but 'out of scope' must not become 'never looked'.
      for (const g of osSource.external) {
        totals.outOfScope.externalSource.push({ path: item.path, email: g.email || g.name, role: g.role });
      }
      for (const g of osSource.links) {
        totals.outOfScope.linksSource.push({ path: item.path, audience: g.type, role: g.role });
      }

      // The destination read is worth making for an item that carries ONLY an out-of-scope grant:
      // without it the report could say a link existed at the source and nothing about whether it
      // arrived, which is the half-observation the out-scope document asks us not to produce.
      const hasOutOfScope = osSource.external.length > 0 || osSource.links.length > 0;
      if (comparable.length === 0 && !hasOutOfScope) continue;

      const destPerms = await onedriveClient.getPermissionsById(destDrive.id, dest.id, destEmail)
        .catch(() => ({ readable: false, permissions: [] }));
      if (destPerms.readable && hasOutOfScope) {
        // WHETHER AN EXTERNAL GRANT ARRIVED IS ASKED PER PRINCIPAL, not by domain-guessing the
        // destination. CloudFuze re-resolves each grantee inside the destination tenant, and the
        // resolved account can sit on a third domain — mia@filefuze.co arrived as
        // mia@cloudfuze.com on run 7fadbadc. A domain test would have called that external, so
        // the same identity matching the in-scope features use is reused here.
        for (const g of osSource.external) {
          const hit = matchPrincipal(destPerms.permissions, g);
          totals.outOfScope.externalDest.push({
            path: item.path,
            email: g.email || g.name,
            arrived: Boolean(hit),
            as: hit
              ? `${hit.grant.email || hit.grant.name} (${(hit.grant.roles || []).join('/')})`
              : null,
          });
        }
        for (const pm of destPerms.permissions || []) {
          if (pm.isLink) totals.outOfScope.linksDest.push({ path: item.path, scope: pm.linkScope || 'link' });
        }
      }
      if (comparable.length === 0) continue;
      if (!destPerms.readable) {
        // "Could not read" is not "no permissions" — recorded so a feature is never failed on it.
        totals.permissionObservations.push({ path: item.path, readable: false });
        continue;
      }

      for (const g of comparable) {
        // Find the SAME PRINCIPAL at the destination first, then compare only that grant's roles.
        //
        // compareDriveAccess(driveRole, spRoles) takes an array of ROLE STRINGS, not a list of
        // permission objects. Passing the whole permission list made spRolesLevel read nothing, so
        // every grant compared as "→ none (expected undefined)" and all four permission features
        // failed on a migration whose permissions had actually arrived.
        //
        // Identity matching — exact address, then display name, then local part — lives in
        // `matchPrincipal` at the top of this file, with the measured remap that forced each rule.
        // It is one function because the out-of-scope external-share observation asks the same
        // question, and two copies of "did this grantee arrive?" would eventually disagree.
        const matched = matchPrincipal(destPerms.permissions, g);
        const destGrant = matched && matched.grant;
        const matchedBy = matched && matched.matchedBy;

        const cmpRes = roleMap.compareDriveAccess(g.role, (destGrant && destGrant.roles) || []);
        totals.permissionObservations.push({
          path: item.path,
          type: item.type,
          root: isRootLevel(item.path),
          readable: true,
          email: g.email || g.name,
          principalType: g.type,
          sourceRole: g.role,
          expected: cmpRes.expectedSpLabel,
          actual: destGrant ? (destGrant.roles || []).join('/') : 'no grant for this principal',
          match: Boolean(cmpRes.match),
          matchedBy: destGrant ? matchedBy : null,
        });
      }
    }

    for (const pos of POSITIONS) {
      const rows = totals.permissionObservations.filter(
        (o) => o.readable && o.type === pos.type && o.root === pos.root
      );
      const unreadable = totals.permissionObservations.filter((o) => !o.readable).length;

      // Grants at this position that were never judgeable, and why. Printed alongside the verdict
      // rather than hidden, because "we did not map this grantee" and "the product lost the grant"
      // are opposite findings and only one of them is a bug in CloudFuze.
      const skipped = totals.notJudged.filter((n) => {
        // Drive-level entries apply to EVERY position, because membership is drive-wide — a
        // member with no destination counterpart is missing from the root folder and the inner
        // file alike, and mentioning it on only one position would read as a local oddity.
        if (n.path === '(drive membership)') return true;
        const item = sourceTree.find((i) => i.path === n.path);
        return item && item.type === pos.type && isRootLevel(n.path) === pos.root;
      });
      const unmapped = skipped.filter((n) => n.why === 'unmapped');
      const external = skipped.filter((n) => n.why === 'external');
      const noCounterpart = skipped.filter((n) => n.why === 'no-counterpart-hint');
      // A permission verdict that does not say how long we waited is unreadable: 'no grant'
      // after 20 minutes and 'no grant' read the instant the copy ended are different findings.
      const w = totals.permissionWait || {};
      const waited = w.waitedMs
        ? ` Waited ${Math.round(w.waitedMs / 1000)}s for CloudFuze's permission phase`
          // NO EM DASH IN A FAILURE DETAIL. The report's Failure Index derives a check's root cause
        // by taking the text after the LAST em dash, on the convention that a detail reads
        // "<path> — <reason>". These asides are prose, so on run e8fc456e every permission row in
        // the index read "external shares are out of scope ... reported under OS 1.1" instead of
        // the mismatch that actually failed it. Semicolons keep the sentence and the index honest.
        + `${w.settled ? ' (settled)' : ' (NOT settled; the budget ran out)'}.`
        : '';
      const aside = waited + (external.length
        ? ` ${external.length} external grant(s) were not judged here; external shares are out of `
          + 'scope for this combination and are reported under OS 1.1.'
        : '')
        // Stated as what it is — a lookup that found nothing — not as a prediction that the access
        // cannot arrive. It said the latter on run fee5db73 about three groups that had all
        // arrived correctly, which made a clean migration read as a defect.
        + (noCounterpart.length
          ? ` ${noCounterpart.length} member(s) have no principal of the same local part in the `
            + 'destination tenant, so their expected address could not be predicted; they are '
            + 'still compared against the destination item itself: '
            + `${[...new Set(noCounterpart.map((n) => n.email))].join(', ')}.`
          : '')
        + (unmapped.length
          ? ` ${unmapped.length} grant(s) could not migrate at all because the run did not map `
            + `their grantee to a destination identity: `
            + `${[...new Set(unmapped.map((u) => u.email))].join(', ')}.`
          : '');

      if (rows.length === 0) {
        // NOT A FAILURE. A position with nothing judgeable is unexercised, and the reason decides
        // what the reader should do about it — seed a grant, or map the grantee. Failing here would
        // report our own test-data gap as a defect in the migration, which run 27a74447 did for all
        // four positions on a source that genuinely carried the grants.
        push('WARN', `${pos.id} ${pos.label}`,
          `Not exercised: no ${pos.root ? 'root-level' : 'nested'} ${pos.type} carried a judgeable `
          + 'grant at the source.'
          + (unmapped.length
            ? ' The grants that exist are held by principals with no destination counterpart, so '
              + 'CloudFuze had nobody to grant to; add them to the run\'s Map Users pairs, or '
              + 'create matching accounts in the destination tenant.'
            : ' Seed one to cover this position.')
          + aside
          + (unreadable ? ` (${unreadable} item(s) had unreadable destination permissions.)` : ''));
        continue;
      }
      const bad = rows.filter((r) => !r.match);
      if (bad.length === 0) {
        push('PASS', `${pos.id} ${pos.label}`,
          `${rows.length} grant(s) compared across ${new Set(rows.map((r) => r.path)).size} `
          + `item(s), all matched.${aside}`);
      } else {
        push('FAIL', `${pos.id} ${pos.label}`,
          `${bad.length} of ${rows.length} grant(s) differ: `
          + bad.slice(0, 3).map((b) => `${b.path} ${b.email || b.principalType} `
            + `${b.sourceRole}→${b.actual || 'none'} (expected ${b.expected})`).join('; ')
          + `.${aside}`);
      }
    }
  }

  /**
   * Split one item's source grants into the two OUT-of-scope buckets.
   *
   * External share  = a grant to a principal outside the source account's own domain. The scope
   *                   document puts these out of scope, so they are observed and never judged.
   * Shared link     = a grant whose audience is a link rather than a person. Google reports those
   *                   as type `anyone` (anyone with the link) or `domain` (organisation-scoped),
   *                   which is exactly the "type of link" the out-scope document mentions.
   *
   * Inherited grants are excluded from both. On a Shared Drive every member's access is inherited
   * from the drive, so counting them would report the drive's whole membership as an external share
   * on every single item.
   */
  _classifyOutOfScopeGrants(grants, sourceEmail, links = []) {
    const ownDomain = String(sourceEmail || '').toLowerCase().split('@')[1] || '';
    const external = [];
    // LINKS ARE NOT IN `grants`. driveClient.listPermissions filters `grants` to type user or
    // group and returns anyone/domain separately on `links`, so scanning `grants` for a link
    // could never match. Run 0fa8ae2c reported "0 link grant(s) at the source; 22 at the
    // destination" on a source whose Shared Link Matrix holds fourteen of them — the source side
    // was structurally unable to see one, which made an INFO row quietly untrue.
    const linkGrants = (links || []).map((l) => ({ ...l, audience: l.type }));
    for (const g of grants || []) {
      if (g.inherited) continue;
      const dom = String(g.email || '').toLowerCase().split('@')[1] || '';
      if (dom && ownDomain && dom !== ownDomain) external.push(g);
    }
    return { external, links: linkGrants };
  }

  /**
   * Timestamps — observed for every matched pair, judged for none of them.
   *
   * Free: both trees were already read and both carry createdAt/modifiedAt, so this is arithmetic
   * on data in hand rather than another pass over two clouds. Out of scope means the numbers must
   * not decide a verdict; it does not mean the report should be silent about them, because "we did
   * not look" and "we looked and they drifted, which this document allows" are different answers.
   *
   * A minute of tolerance, because the two clouds round differently and a second of difference is
   * not drift worth printing.
   */
  _observeTimestamps(cmp, totals) {
    const TOLERANCE_MS = 60 * 1000;
    const ms = (v) => {
      const t = Date.parse(String(v || ''));
      return Number.isFinite(t) ? t : null;
    };
    for (const [path, pair] of (cmp.matched || new Map())) {
      const src = pair && pair.source;
      const dst = pair && pair.dest;
      if (!src || !dst) continue;
      totals.outOfScope.tsCompared += 1;
      const sc = ms(src.createdAt);
      const dc = ms(dst.createdAt);
      if (sc !== null && dc !== null && Math.abs(sc - dc) > TOLERANCE_MS) {
        totals.outOfScope.tsCreatedDrift.push({ path, source: src.createdAt, dest: dst.createdAt });
      }
      const sm = ms(src.modifiedAt);
      const dm = ms(dst.modifiedAt);
      if (sm !== null && dm !== null && Math.abs(sm - dm) > TOLERANCE_MS) {
        totals.outOfScope.tsModifiedDrift.push({
          path, source: src.modifiedAt, dest: dst.modifiedAt,
        });
      }
    }
  }

  /**
   * The four out-of-scope features, each reported as its own INFO check, never judged.
   *
   * ONE LUMPED LINE WAS NOT ENOUGH. This used to push a single INFO check naming all four, and the
   * Feature Checklist — which is built from the eight in-scope rows — showed none of them. A reader
   * comparing the report against the two scope documents saw twelve documented features and eight
   * rows, with no way to tell a deliberately unjudged feature from a forgotten one. Four rows, each
   * carrying what was actually observed, is the difference between "out of scope" and "never looked
   * at", and only one of those is true here.
   *
   * The numbering is the OUT-SCOPE document's own (1.1 External shares, 2.1 Timestamps,
   * 3.1 SharedLinks, 4.1 Versions) prefixed `OS` — unprefixed it would collide with in-scope 1.1
   * and 2.1, and the checklist matches a check to a feature by its id prefix.
   */
  _reportOutOfScope(push, totals) {
    const os = totals.outOfScope;
    const NOTE = 'Out of scope per google-shared-drive-to-onedrive-outscope.md — observed, not '
      + 'judged; no difference here can fail this run.';

    // OS 1.1 — external shares.
    if (os.externalSource.length === 0) {
      push('INFO', 'OS 1.1 External shares',
        `${NOTE} No grant to a principal outside the source domain existed on any migrated item, `
        + 'so there was nothing to observe. External shares are deliberately NOT seeded for this '
        + 'combination — 2.1-2.4 are exercised with internal principals, so the in-scope features '
        + 'never depend on an out-of-scope mechanism.');
    } else {
      const arrived = os.externalDest.filter((e) => e.arrived);
      const sample = os.externalDest.slice(0, 3)
        .map((e) => `${e.path} ${e.email} -> ${e.arrived ? e.as : 'not present'}`)
        .join('; ');
      push('INFO', 'OS 1.1 External shares',
        `${NOTE} ${os.externalSource.length} external grant(s) at the source; ${arrived.length} `
        + `found at the destination. ${sample}`);
    }

    // OS 2.1 — timestamps.
    if (os.tsCompared === 0) {
      push('INFO', 'OS 2.1 Timestamps',
        `${NOTE} No matched pair was available, so no timestamp was read.`);
    } else {
      const cd = os.tsCreatedDrift.length;
      const md = os.tsModifiedDrift.length;
      const sample = os.tsModifiedDrift[0] || os.tsCreatedDrift[0];
      push('INFO', 'OS 2.1 Timestamps',
        `${NOTE} ${os.tsCompared} matched pair(s) read: created differs on ${cd}, modified differs `
        + `on ${md} (60s tolerance).`
        + (sample ? ` e.g. ${sample.path}: source ${sample.source} -> dest ${sample.dest}.` : '')
        + (cd + md > 0
          ? ' A destination date of the migration time is the expected outcome when timestamp '
            + 'preservation was never requested on the job.'
          : ' Both sides agree, which is more than this document asks for.'));
    }

    // OS 3.1 — shared links.
    if (os.linksSource.length === 0 && os.linksDest.length === 0) {
      push('INFO', 'OS 3.1 SharedLinks',
        `${NOTE} No anonymous or organisation-scoped link existed on any migrated item at either `
        + 'side, so there was nothing to observe. Links are not seeded for this combination.');
    } else {
      const srcKinds = [...new Set(os.linksSource.map((l) => l.audience))].join(', ') || 'n/a';
      const destKinds = [...new Set(os.linksDest.map((l) => l.scope))].join(', ') || 'none';
      push('INFO', 'OS 3.1 SharedLinks',
        `${NOTE} ${os.linksSource.length} link grant(s) at the source (${srcKinds}); `
        + `${os.linksDest.length} at the destination (${destKinds}).`);
    }

    // OS 4.1 — versions.
    //
    // Reported as NOT MEASURED rather than dressed up as an observation. Reading version history
    // costs one call per file on each side, and this document does not compare the counts —
    // spending that on a number nobody judges would be dishonest about why the call was made.
    push('INFO', 'OS 4.1 Versions',
      `${NOTE} Version counts were NOT read on either side: the comparison is not made, so the `
      + 'calls are not spent. Worth raising with the combination owner rather than assuming — '
      + 'version history IS judged for google-shared-drive-to-sharepoint, and OneDrive runs on the '
      + 'same SharePoint Online storage, so if versions were meant to be judged here it is the '
      + 'in-scope document that needs changing, not this validator.');
  }

  /** The shape the orchestrator and the report generator expect. */
  _result(checks, totals, context) {
    const featureChecklist = this._buildChecklist(checks);
    const pass = featureChecklist.filter((f) => f.status === 'pass').length;
    const fail = featureChecklist.filter((f) => f.status === 'fail').length;
    const na = featureChecklist.filter((f) => f.status === 'na').length;
    // The denominator is the EIGHT judged features, not the twelve rows.
    //
    // The checklist now also carries the four out-of-scope features as INFO rows, so a reader can
    // see they were considered rather than forgotten. Counting them in the total would print
    // "6 pass, 1 fail, 1 not assessed (of 12)" and invite the reader to treat four deliberately
    // unjudged features as four missing verdicts — the opposite of what adding the rows is for.
    const judged = featureChecklist.filter((f) => f.status !== 'info');
    const info = featureChecklist.length - judged.length;
    const overall = fail > 0 ? 'FAIL' : (pass > 0 ? 'PASS' : 'FAIL');
    const summaryLine = `Features: ${pass} pass, ${fail} fail, ${na} not assessed `
      + `(of ${judged.length} in scope)`
      + (info ? `; ${info} out of scope, observed and not judged` : '');
    logger.info(`[googleshareddrive→onedrive] ${summaryLine}`);

    return {
      status: overall,
      overallStatus: overall,
      domain: 'content',
      sourceProvider: 'googleshareddrive',
      destinationProvider: 'onedrive',
      combination: COMBINATION,
      checks,
      // The report's per-user header reads status, sourcePath and destinationPath — NOT the
      // top-level result. Omitting them printed "User 1 undefined ·" with both Location columns
      // showing "—", on a run whose source and destination had both resolved and were named
      // correctly two rows above. A header that contradicts the checks under it costs the reader
      // more than a missing one.
      perUser: [{
        sourceEmail: context.sourceEmail || '',
        destinationEmail: context.destinationEmail || '',
        status: overall,
        summary: `${pass} pass, ${fail} fail, ${na} not assessed`,
        sourcePath: totals.sourceLabel || '',
        destinationPath: totals.destLabel || '',
        checks,
        itemDetails: [],
        ...(totals.unitResult || { items: [], folderStructure: {} }),
      }],
      featureChecklist,
      featureSummary: {
        pass, fail, notAssessed: na, total: judged.length, outOfScope: info,
        line: summaryLine,
      },
      deepContentValidation: totals,
      summary: summaryLine,
    };
  }

  /**
   * The eight documented features, in the document's own numbering.
   *
   * A WARN is `na`, never a pass: "measured but not assessable" and "correct" are different answers
   * and a checklist that blurs them is how an unexercised feature reaches a report as green.
   */
  _buildChecklist(checks) {
    const FEATURES = [
      { id: '1.1', category: 'Migration', feature: 'One Time Migration' },
      { id: '1.2', category: 'Migration', feature: 'Delta Migration' },
      { id: '1.3', category: 'Migration', feature: 'Files & Folder Migration' },
      { id: '1.4', category: 'Migration', feature: 'Preserving File/Folder structure' },
      { id: '2.1', category: 'Permissions', feature: 'Root Folder Permissions' },
      { id: '2.2', category: 'Permissions', feature: 'Subfolder Permissions' },
      { id: '2.3', category: 'Permissions', feature: 'Root File Permissions' },
      { id: '2.4', category: 'Permissions', feature: 'Inner file permissions' },
    ];
    // The out-scope document's four, listed so the checklist covers every DOCUMENTED feature.
    //
    // They are pinned to `info` regardless of what their check said: an out-of-scope row must not
    // be able to reach the pass/fail counts, whatever a future edit to `_reportOutOfScope` does.
    const OUT_OF_SCOPE = [
      { id: 'OS 1.1', category: 'Out of scope — observed, never judged', feature: 'External shares' },
      { id: 'OS 2.1', category: 'Out of scope — observed, never judged', feature: 'Timestamps' },
      { id: 'OS 3.1', category: 'Out of scope — observed, never judged', feature: 'SharedLinks' },
      { id: 'OS 4.1', category: 'Out of scope — observed, never judged', feature: 'Versions' },
    ];

    const rowFor = (f) => checks.find((c) => c.name.startsWith(`${f.id} `));
    const inScope = FEATURES.map((f) => {
      const row = rowFor(f);
      if (!row) {
        return { ...f, status: 'na', detail: 'No check produced a verdict for this feature.' };
      }
      const status = row.status === 'PASS' ? 'pass' : row.status === 'FAIL' ? 'fail' : 'na';
      return { ...f, status, detail: row.detail };
    });
    const outScope = OUT_OF_SCOPE.map((f) => {
      const row = rowFor(f);
      return {
        ...f,
        status: 'info',
        inScope: false,
        detail: row ? row.detail
          : 'Out of scope for this combination; this run produced no observation for it.',
      };
    });
    return [...inScope, ...outScope];
  }
}

module.exports = GoogleshareddriveToOnedriveValidationAgent;
module.exports.COMBINATION = COMBINATION;
module.exports.POSITIONS = POSITIONS;
module.exports.isRootLevel = isRootLevel;
// Exported for tests: the destination-identity rules are where four features were lost.
module.exports.matchPrincipal = matchPrincipal;
module.exports.NAMED_TYPES = NAMED_TYPES;
