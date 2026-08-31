'use strict';

/**
 * Deep source↔destination CONTENT validation (files and folders).
 *
 * The content counterpart of deepMailCore, organised in the same three tiers:
 *   Tier A — listing metadata: every source item present at the right destination path, right parent,
 *            right name after the destination's rename rules, size within tolerance
 *   Tier B — file bytes: SHA-256 of the content downloaded from both clouds
 *   Tier C — the facts around the file: permissions, shared links, versions, timestamps, authors
 *
 * Everything here is either pure or takes its cloud access as an injected callback, so each function is
 * unit-testable with node+assert and every combination plugs in its own clients without editing this
 * file. Provider-specific rules (which mime types a source has, how its roots resolve) belong in
 * validation/combinations/content/<combo>.js — not here.
 *
 * Scope reference: backend/data/feature-scope/google-shared-drive-to-sharepoint-*.md
 */

// sha256Hex is the existing helper — reused rather than reimplemented. The module is mail-named but the
// function is generic, and it is already resident in-process (deepMailCore requires it).
const { sha256Hex } = require('../../utils/mailMigrationComparator');
const { intEnv, boolEnv } = require('./deepMailCore');
const roleMap = require('../contentRoleMap');

/* ── Names ──────────────────────────────────────────────────────────────────
 * SharePoint Online / OneDrive reject `" * : < > ? / \ |` outright, disallow leading and trailing
 * spaces, and reserve a set of names. Some tenants additionally reject `#` and `%`. CloudFuze replaces
 * unsupported characters with `_` or `-` (in-scope feature 7.1), so a destination name is matched
 * against BOTH replacements rather than assuming one.
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * The character set CloudFuze replaces — a superset of Microsoft's official list.
 *
 * Returned as a FRESH regex each call rather than a shared `/g` constant: a global regex carries
 * `lastIndex` between `.test()` calls, so a shared instance makes results depend on call order.
 */
/**
 * Characters SharePoint Online actually rejects in a file or folder name:  " * : < > ? /  |
 *
 * The set used to also include ~ # % & { }. Those have been permitted since the 2017 special-character
 * update, and treating them as invalid made the validator predict a destination name that never occurs.
 * Observed on run 6a8d53d2: source "Special !@#$%^&*()-_+=[] Folder" arrived as
 * "Special !@#$%^&-()-_+=[] Folder" — # % & all preserved, only * replaced — while the validator
 * expected "Special !@_$_^__()-_+=[] Folder" and so reported the folder missing, its real name extra,
 * and every child misplaced. One wrong character class, four wrong findings.
 *
 * A leading ~ is handled by isReservedName(), not here, because only its position is a problem.
 */
function spInvalidChars() {
  return /["*:<>?/\\|]/g;
}

/** Names SharePoint refuses regardless of characters. */
const SP_RESERVED_NAMES = new Set([
  '.lock', 'con', 'prn', 'aux', 'nul', 'desktop.ini', 'forms',
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);

/** Longest name SharePoint keeps intact; beyond this the destination may truncate. */
const TRUNCATION_MATCH_MIN = 60;

/**
 * The name SharePoint should end up with: unsupported characters replaced, surrounding spaces trimmed.
 * Case is preserved. `replacement` is '_' or '-' (feature 7.1 allows either).
 */
function sanitizeForSharePoint(name, replacement = '_') {
  return String(name || '').replace(spInvalidChars(), replacement).trim();
}

/** True when the name is reserved by SharePoint and cannot be created as-is. */
function isReservedName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  if (SP_RESERVED_NAMES.has(n)) return true;
  if (n.startsWith('~$')) return true;
  if (n.includes('_vti_')) return true;
  // Leading "゛" / "ဧ" are rejected as the first character of a folder name.
  return /^[゛ဗ]/.test(n);
}

/** True when the name carries characters or spacing SharePoint will not accept unchanged. */
function needsSanitizing(name) {
  const raw = String(name || '');
  return spInvalidChars().test(raw) || raw !== raw.trim();
}

/** Normalised key for matching — case and surrounding whitespace only. */
function normKey(name) {
  return String(name || '').toLowerCase().trim();
}

/**
 * Does a destination name correspond to this source name?
 * Accepts the unchanged name, either sanitized form, and the destination's truncation of a very long
 * name (prefix match of at least TRUNCATION_MATCH_MIN characters).
 */
function namesMatch(sourceName, destName) {
  const dest = normKey(destName);
  if (!dest) return false;

  const candidates = [
    normKey(sourceName),
    normKey(sanitizeForSharePoint(sourceName, '_')),
    normKey(sanitizeForSharePoint(sourceName, '-')),
  ];
  if (candidates.includes(dest)) return true;

  // Truncation is one-directional: the DESTINATION is the side that gets shortened. Comparing
  // symmetrically let two long source names sharing a 60-character prefix pair with each other.
  for (const cand of candidates) {
    if (!cand) continue;
    if (dest.length >= TRUNCATION_MATCH_MIN && dest.length < cand.length && cand.startsWith(dest)) {
      return true;
    }
  }
  return false;
}

/* ── Paths ──────────────────────────────────────────────────────────────────
 * SharePoint's limit is 400 characters for the whole path, measured on the URL-ENCODED form — a space
 * costs 3 characters, not 1 — with each segment capped at 255. Over the limit CloudFuze creates a
 * placeholder link URL in place of the item (feature 11.1), so such items are expected to be absent and
 * must not be reported missing.
 * ───────────────────────────────────────────────────────────────────────────*/

const PATH_LENGTH_LIMIT = 400;
const SEGMENT_LENGTH_LIMIT = 255;

function segmentsOf(path) {
  return String(path || '').split('/').map((s) => s.trim()).filter(Boolean);
}

/** Length of the path as SharePoint counts it — percent-encoded, segments rejoined with '/'. */
function encodedPathLength(path) {
  const segs = segmentsOf(path);
  if (segs.length === 0) return 1; // '/'
  return segs.map((s) => encodeURIComponent(s)).join('/').length + 1; // + leading '/'
}

function exceedsPathLimit(path, limit = PATH_LENGTH_LIMIT) {
  return encodedPathLength(path) > limit;
}

/** Segments too long for SharePoint, if any. */
function oversizedSegments(path, limit = SEGMENT_LENGTH_LIMIT) {
  return segmentsOf(path).filter((s) => s.length > limit);
}

/**
 * True when CloudFuze is expected to substitute a placeholder link for this item rather than migrate it.
 * `prefix` is the destination root the item will live under, since the limit applies to the full
 * destination path, not the source-relative one.
 */
function expectPlaceholderLink(path, opts = {}) {
  const { prefix = '', limit = PATH_LENGTH_LIMIT, segmentLimit = SEGMENT_LENGTH_LIMIT } = opts;
  const full = prefix ? joinPath(prefix, path) : path;
  return exceedsPathLimit(full, limit) || oversizedSegments(full, segmentLimit).length > 0;
}

function lastSegment(path) {
  const segs = segmentsOf(path);
  return segs[segs.length - 1] || '';
}

function joinPath(parent, child) {
  const p = `/${String(parent || '').replace(/^\/+|\/+$/g, '')}`;
  const c = String(child || '').replace(/^\/+|\/+$/g, '');
  return (p === '/' ? '' : p) + (c ? `/${c}` : '') || '/';
}

function parentOf(path) {
  const p = String(path || '');
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

/**
 * A CloudFuze destination path ("/SANITY DATAA/Documents[/sub]") reduced to a path WITHIN the Graph
 * default drive. The default drive IS the Documents library, so everything up to and including
 * "Documents" collapses to the drive root.
 */
function inDrivePath(destinationPath) {
  const segs = segmentsOf(destinationPath);
  const docIdx = segs.findIndex((s) => /^documents$/i.test(s));
  const sub = docIdx >= 0 ? segs.slice(docIdx + 1) : segs;
  return `/${sub.join('/')}`;
}

/**
 * The site name a destination path names, if any. CloudFuze content mappings are written as
 * "<Site>/Documents/<subpath>", so the segment before the library is the site the data landed in —
 * which is not necessarily the site in SHAREPOINT_SITE_PATH.
 * Returns null when the path carries no site segment (e.g. "/Documents/x" or "/x").
 */
function siteSegmentOf(destinationPath) {
  const segs = segmentsOf(destinationPath);
  const docIdx = segs.findIndex((s) => /^documents$/i.test(s));
  return docIdx > 0 ? segs[docIdx - 1] : null;
}

/** Strip a leading prefix from each item.path so two trees compare on a common relative root. */
function relativize(items, prefix) {
  const pfx = String(prefix || '').replace(/\/+$/, '');
  return (items || []).map((i) => {
    let rel = i.path;
    if (pfx && rel.startsWith(pfx)) rel = rel.slice(pfx.length) || '/';
    return { ...i, path: rel.startsWith('/') ? rel : `/${rel}` };
  });
}

/* ── File types and conversion (feature 12.1) ───────────────────────────────*/

const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

/** Google native formats have no bytes to download — they are exported to these Office formats. */
const GOOGLE_NATIVE_EXPORT = {
  'application/vnd.google-apps.document': '.docx',
  'application/vnd.google-apps.spreadsheet': '.xlsx',
  'application/vnd.google-apps.presentation': '.pptx',
};

/**
 * Google native types with NO export path to SharePoint. They are Google-only constructs — there is no
 * Microsoft 365 equivalent to convert them into — so they do not arrive at the destination at all.
 *
 * An item of one of these types is therefore expected to be absent. Counting it as "missing" would fail
 * every run that has a Form or a Site anywhere in the tree, so compareTrees routes them to their own
 * bucket instead. They are still reported, with the reason, because "absent" and "silently ignored" are
 * not the same thing — and because a combination's own out-of-scope document is the authority on which
 * types it excludes.
 */
const GOOGLE_NATIVE_NO_EXPORT = {
  'application/vnd.google-apps.form': 'Google Form — no Microsoft 365 equivalent; must be rebuilt in Microsoft Forms',
  'application/vnd.google-apps.site': 'Google Site — no direct conversion to a SharePoint page',
  'application/vnd.google-apps.map': 'Google My Map — no Microsoft 365 equivalent',
  'application/vnd.google-apps.jam': 'Jamboard file — no Microsoft 365 equivalent',
  'application/vnd.google-apps.script': 'Apps Script project — not migrated as content',
  'application/vnd.google-apps.fusiontable': 'Fusion Table — retired Google type',
  'application/vnd.google-apps.drawing': 'Google Drawing — exportable only as a static image, on a best-effort basis',
  'application/vnd.google-apps.shortcut': 'Drive shortcut — a pointer, not content; its target migrates on its own',
};

/** Legacy Office formats CloudFuze upgrades on migration. */
const LEGACY_OFFICE_CONVERSION = { '.doc': '.docx', '.xls': '.xlsx', '.ppt': '.pptx' };

/** Formats migrated byte-for-byte, so Tier B applies to them. */
const PASSTHROUGH_EXTENSIONS = new Set([
  '.xlsm', '.docm', '.pptm', '.one', '.vsdx', '.pdf', '.txt', '.csv', '.xml',
  '.json', '.jpg', '.png', '.mp4', '.mp3', '.zip', '.rar',
]);

function isGoogleNative(mimeType) {
  return String(mimeType || '').startsWith(GOOGLE_NATIVE_PREFIX);
}

function isShortcut(mimeType) {
  return String(mimeType || '') === 'application/vnd.google-apps.shortcut';
}

/** True when this Google type has no export path to the destination and so will not arrive. */
function isUnmigratableNative(mimeType) {
  return Object.prototype.hasOwnProperty.call(GOOGLE_NATIVE_NO_EXPORT, String(mimeType || ''));
}

/** Why an item of this type is not expected at the destination. */
function unmigratableReason(mimeType) {
  return GOOGLE_NATIVE_NO_EXPORT[String(mimeType || '')] || null;
}

function extensionOf(name) {
  const n = String(name || '');
  const idx = n.lastIndexOf('.');
  return idx > 0 ? n.slice(idx).toLowerCase() : '';
}

/**
 * The extension this item should carry in SharePoint.
 * Google native → its export format; legacy Office → its modern format; everything else unchanged.
 */
function expectedDestExtension(name, mimeType) {
  if (isGoogleNative(mimeType)) return GOOGLE_NATIVE_EXPORT[String(mimeType)] || extensionOf(name);
  const ext = extensionOf(name);
  return LEGACY_OFFICE_CONVERSION[ext] || ext;
}

/**
 * Apply only the FORMAT conversion, leaving the characters alone.
 *
 * Kept separate from sanitizing because the two rules compose in one direction only: matching has to
 * try both replacement characters, so a name may not be pre-sanitized with one of them before it
 * reaches namesMatch.
 */
function convertName(name, mimeType) {
  const raw = String(name || '');
  if (isGoogleNative(mimeType)) {
    const ext = GOOGLE_NATIVE_EXPORT[String(mimeType)];
    // Native files carry no extension in Drive; the export adds one.
    return ext && !raw.toLowerCase().endsWith(ext) ? `${raw}${ext}` : raw;
  }
  const from = extensionOf(raw);
  const to = LEGACY_OFFICE_CONVERSION[from];
  return to ? `${raw.slice(0, raw.length - from.length)}${to}` : raw;
}

/** The full name this item should carry in SharePoint: converted, then sanitized. */
function expectedDestName(name, mimeType, replacement = '_') {
  return sanitizeForSharePoint(convertName(name, mimeType), replacement);
}

/** True when the item was converted, so its destination bytes legitimately differ from the source. */
function isConverted(item) {
  if (isGoogleNative(item?.mimeType)) return true;
  return Boolean(LEGACY_OFFICE_CONVERSION[extensionOf(item?.name)]);
}

/**
 * True when a byte-for-byte hash comparison is meaningful for this item.
 * Folders have no content; converted files are produced by a converter and can never hash equal.
 */
function isHashable(item) {
  if (!item || item.type !== 'file') return false;
  if (isShortcut(item.mimeType)) return false;
  return !isConverted(item);
}

/** Why an item was not hashed — surfaced in the report so a skip is never read as a pass. */
function notHashableReason(item) {
  if (!item || item.type !== 'file') return 'not a file';
  if (isShortcut(item.mimeType)) return 'Drive shortcut — no content of its own';
  if (isGoogleNative(item.mimeType)) {
    return `Google native file exported to ${GOOGLE_NATIVE_EXPORT[String(item.mimeType)] || 'Office format'} — converted bytes cannot match`;
  }
  const ext = extensionOf(item.name);
  if (LEGACY_OFFICE_CONVERSION[ext]) {
    return `converted ${ext} → ${LEGACY_OFFICE_CONVERSION[ext]} — converted bytes cannot match`;
  }
  return 'not hashable';
}

/* ── Tier A: structure ──────────────────────────────────────────────────────*/

/**
 * Pair two item trees and classify every difference.
 *
 * Items on both sides are `{ id, name, type: 'file'|'folder', path, size, mimeType, createdAt,
 * modifiedAt, createdBy, modifiedBy }` with `path` relative to each side's root.
 *
 * @param {Array} sourceItems
 * @param {Array} destItems              already relativized to the destination root
 * @param {object} opts                  { destPrefix, pathLimit, segmentLimit }
 * @returns {{ matched: Map, matchedCount, totalSource, totalDest, missing, extra, misplaced,
 *            placeholderLinks, status }}
 *   missing          — in source, absent from destination, and NOT explained by the path limit
 *   placeholderLinks — in source, absent from destination, but over the path limit, so a placeholder
 *                      link is the documented expected outcome (feature 11.1)
 *   misplaced        — present on both sides under different parents
 */
/**
 * Names a destination item may legitimately carry for this source item, best first.
 *
 * The converted name comes first because conversion is the documented behaviour (feature 12.1:
 * .doc→.docx, .xls→.xlsx, .ppt→.pptx, Google native → Office). The ORIGINAL name is accepted as a
 * fallback so that a file which was NOT converted still pairs with its counterpart.
 *
 * Without that fallback one unconverted file produced three separate findings: missing on the source
 * side (nothing matched .pptx), extra on the destination side (the .ppt nobody claimed), and a
 * silent skip in the conversion check, which then reported PASS. Pairing them means the structure
 * check sees a match and the conversion check owns the defect — one file, one finding.
 */
function destNameCandidatesFor(item) {
  const converted = convertName(item.name, item.mimeType);
  return converted === item.name ? [item.name] : [converted, item.name];
}

function compareTrees(sourceItems, destItems, opts = {}) {
  const { destPrefix = '', pathLimit = PATH_LENGTH_LIMIT, segmentLimit = SEGMENT_LENGTH_LIMIT } = opts;
  const source = Array.isArray(sourceItems) ? sourceItems : [];
  const dest = Array.isArray(destItems) ? destItems : [];

  // Index the destination by parent path so a name is matched within its own folder.
  //
  // SharePoint renames folders as well as files, so a source item under "/Special : Chars" lives
  // under "/Special _ Chars" at the destination. Comparing raw parent paths would miss every child
  // of a renamed folder and report them all as misplaced.
  //
  // The destination is indexed by its literal parent key; each source item is then looked up under
  // every parent name its ancestors could legally have become (unchanged, or sanitized with either
  // replacement character). Trying candidates rather than collapsing '_' and '-' into one symbol
  // keeps genuinely different names — "my-folder" and "my_folder" — apart.
  const literalKey = (p) => segmentsOf(parentOf(p)).map((seg) => normKey(seg)).join('/');

  // THREE candidate keys, not one per combination of ancestor renames. Generating a variant per
  // segment was a 3^depth cross-product — a tree with special characters six levels deep produced 729
  // lookups per item. In practice a destination renames every segment with the SAME replacement
  // character, so the whole-path variants cover it; genuinely mixed renames fall through to the
  // segment-wise scan below.
  const parentKeyCandidates = (p) => {
    const segs = segmentsOf(parentOf(p));
    return [...new Set([
      segs.map((seg) => normKey(seg)).join('/'),
      segs.map((seg) => normKey(sanitizeForSharePoint(seg, '_'))).join('/'),
      segs.map((seg) => normKey(sanitizeForSharePoint(seg, '-'))).join('/'),
    ])];
  };

  /**
   * Fallback for a parent whose segments were renamed inconsistently: compare the source's parent
   * segments against a destination item's, segment by segment, through namesMatch. Only reached when
   * the three fast keys all miss, so the cost stays off the common path.
   */
  const parentSegmentsMatch = (sourcePath, destPath) => {
    const a = segmentsOf(parentOf(sourcePath));
    const b = segmentsOf(parentOf(destPath));
    if (a.length !== b.length) return false;
    return a.every((seg, i) => namesMatch(seg, b[i]));
  };

  const destByParent = new Map();
  for (const d of dest) {
    const parent = literalKey(d.path);
    if (!destByParent.has(parent)) destByParent.set(parent, []);
    destByParent.get(parent).push(d);
  }

  const matched = new Map();
  const claimed = new Set();
  const unmatchedSource = [];

  for (const s of source) {
    const nameCandidates = destNameCandidatesFor(s);
    const siblings = parentKeyCandidates(s.path).flatMap((k) => destByParent.get(k) || []);
    let hit = null;
    for (const cand of nameCandidates) {
      hit = siblings.find(
        (d) => !claimed.has(d) && d.type === s.type && namesMatch(cand, d.name)
      );
      if (hit) break;
    }
    // Mixed per-segment renames miss all three fast keys; fall back to a segment-wise comparison.
    if (!hit) {
      for (const cand of nameCandidates) {
        hit = dest.find(
          (d) => !claimed.has(d) && d.type === s.type && namesMatch(cand, d.name)
            && parentSegmentsMatch(s.path, d.path)
        );
        if (hit) break;
      }
    }
    if (hit) {
      claimed.add(hit);
      matched.set(s.path, { source: s, dest: hit });
    } else {
      unmatchedSource.push(s);
    }
  }

  const extra = dest.filter((d) => !claimed.has(d));

  // Same name somewhere else on the destination => moved, not missing.
  // Indexed by literal name; lookup uses namesMatch so either replacement character resolves.
  const extraByName = new Map();
  for (const e of extra) {
    const k = normKey(e.name);
    if (!extraByName.has(k)) extraByName.set(k, []);
    extraByName.get(k).push(e);
  }

  // Declared with the other accumulators: the relocation branch in the misplaced loop below writes
  // to placeholderLinks, which runs before the point these used to be declared.
  const placeholderLinks = [];
  const notMigratable = [];
  const misplaced = [];
  const usedExtra = new Set();
  const stillMissing = [];
  for (const s of unmatchedSource) {
    const nameCandidates = destNameCandidatesFor(s);
    const pool = extra.filter(
      (e) => !usedExtra.has(e) && e.type === s.type
        && nameCandidates.some((cand) => namesMatch(cand, e.name))
    );
    if (pool.length > 0) {
      const moved = pool[0];
      usedExtra.add(moved);
      // An item whose destination path would exceed the SharePoint limit cannot live where the
      // source put it, so the destination relocates it and leaves a placeholder link behind. That
      // is documented behaviour (in-scope feature 11.1), not a migration defect — reporting it as
      // "misplaced" made a deliberately over-length test path look like three separate failures
      // plus two unexplained extras.
      if (expectPlaceholderLink(s.path, { prefix: destPrefix, limit: pathLimit, segmentLimit })) {
        placeholderLinks.push({
          path: s.path,
          type: s.type,
          encodedLength: encodedPathLength(joinPath(destPrefix, s.path)),
          relocatedTo: moved.path,
          reason: 'over the SharePoint path limit — relocated by the destination, which is expected',
        });
      } else {
        misplaced.push({ name: s.name, type: s.type, source: s.path, dest: moved.path });
      }
    } else {
      stillMissing.push(s);
    }
  }

  // Absent AND over the path limit = the documented placeholder-link outcome, not a defect.
  // Absent AND a Google-only type = expected, since there is nothing to convert it into.
  const missing = [];
  for (const s of stillMissing) {
    if (isUnmigratableNative(s.mimeType)) {
      notMigratable.push({
        path: s.path, name: s.name, type: s.type, mimeType: s.mimeType,
        reason: unmigratableReason(s.mimeType),
      });
      continue;
    }
    if (expectPlaceholderLink(s.path, { prefix: destPrefix, limit: pathLimit, segmentLimit })) {
      placeholderLinks.push({
        path: s.path,
        type: s.type,
        encodedLength: encodedPathLength(joinPath(destPrefix, s.path)),
        reason: 'over the SharePoint path limit — a placeholder link URL is expected in its place',
      });
    } else {
      missing.push(s);
    }
  }

  // Destination-side artifacts of the over-limit relocation: the ".url" placeholder the destination
  // writes in place of the file it could not store, and any ancestor folder it created to hold the
  // relocated copy. Both have no source counterpart by definition, so counting them as "extra"
  // reported the platform behaving as documented as though it were a defect.
  const relocationRoots = placeholderLinks
    .map((pl) => pl.relocatedTo)
    .filter(Boolean)
    .map((x) => String(x).split('/').filter(Boolean)[0])
    .filter(Boolean);
  const isPlaceholderArtifact = (e) => {
    if (/^FolderPathLink\d*\.url$/i.test(String(e.name || ''))) return true;
    const first = String(e.path || '').split('/').filter(Boolean)[0];
    return Boolean(first) && relocationRoots.includes(first);
  };
  const placeholderArtifacts = extra.filter((e) => !usedExtra.has(e) && isPlaceholderArtifact(e));
  placeholderArtifacts.forEach((e) => usedExtra.add(e));

  const remainingExtra = extra.filter((e) => !usedExtra.has(e));
  const status = missing.length === 0 && remainingExtra.length === 0 && misplaced.length === 0
    ? 'PASS'
    : 'FAIL';

  return {
    matched,
    matchedCount: matched.size,
    totalSource: source.length,
    totalDest: dest.length,
    missing,
    extra: remainingExtra,
    placeholderArtifacts,
    misplaced,
    placeholderLinks,
    notMigratable,
    status,
  };
}

/**
 * Folder-only structure comparison (feature 3.1) — exact names, parent-child relationships, no missing,
 * no extra. Returns counts, the difference lists, and the sorted folder paths of each side for the ASCII
 * trees printed in the PDF.
 */
function compareFolders(sourceItems, destItems, opts = {}) {
  const srcFolders = (sourceItems || []).filter((i) => i.type === 'folder');
  const dstFolders = (destItems || []).filter((i) => i.type === 'folder');
  const cmp = compareTrees(srcFolders, dstFolders, opts);

  return {
    totalSource: srcFolders.length,
    totalDest: dstFolders.length,
    matched: cmp.matchedCount,
    missing: cmp.missing.map((i) => i.path),
    extra: cmp.extra.map((i) => i.path),
    misplaced: cmp.misplaced,
    placeholderLinks: cmp.placeholderLinks,
    notMigratable: cmp.notMigratable,
    status: cmp.status,
    sourceFolderPaths: srcFolders.map((i) => i.path).sort(),
    destFolderPaths: dstFolders.map((i) => i.path).sort(),
    // Root names and cloud labels drive the ASCII trees in the PDF report.
    sourceRootName: opts.sourceRootName || '(root)',
    destRootName: opts.destRootName || '(root)',
    sourceLabel: opts.sourceLabel || 'Source',
    destLabel: opts.destLabel || 'Destination',
  };
}

/* ── Tier B: content hashes ─────────────────────────────────────────────────*/

/**
 * SHA-256 the bytes of each matched file on both sides.
 *
 * Converted files (Google native, legacy Office) are NOT hashed — their destination bytes are produced
 * by a converter and can never match. They are returned in `notHashed` with the reason, and are never
 * counted as hashed passes. Same rule deepMailCore follows for attachments it cannot read.
 *
 * @param {Iterable} pairs                  values of compareTrees().matched
 * @param {(item) => Promise<Buffer>} downloadSource
 * @param {(item) => Promise<Buffer>} downloadDest
 * @param {object} opts                     { maxFiles, log }
 */
async function tierBHashes(pairs, downloadSource, downloadDest, opts = {}) {
  const { maxFiles = 500, log = null } = opts;
  const hashed = [];
  const notHashed = [];
  const mismatches = [];
  let scanned = 0;

  for (const pair of pairs) {
    const src = pair.source;
    const dst = pair.dest;
    if (!src || src.type !== 'file') continue;

    if (!isHashable(src)) {
      notHashed.push({ path: src.path, name: src.name, reason: notHashableReason(src) });
      continue;
    }
    if (scanned >= maxFiles) {
      notHashed.push({ path: src.path, name: src.name, reason: `beyond the ${maxFiles}-file hash cap` });
      continue;
    }

    scanned++;
    try {
      const [srcBuf, dstBuf] = await Promise.all([downloadSource(src), downloadDest(dst)]);
      const srcHash = sha256Hex(srcBuf);
      const dstHash = sha256Hex(dstBuf);
      if (srcHash === dstHash) {
        hashed.push({ path: src.path, name: src.name, sha256: srcHash });
      } else {
        hashed.push({ path: src.path, name: src.name, sha256: srcHash, ok: false });
        mismatches.push({
          path: src.path,
          name: src.name,
          sourceHash: srcHash,
          destHash: dstHash,
          sourceBytes: srcBuf?.length ?? null,
          destBytes: dstBuf?.length ?? null,
        });
      }
    } catch (err) {
      // A read failure is a skip with its reason, never a silent pass and never a scary hard failure.
      notHashed.push({ path: src.path, name: src.name, reason: `content read failed: ${err.message}` });
      if (log) log.warn(`Tier B (content): skipping byte-hash for "${src.name}": ${err.message}`);
    }
  }

  return { hashed, notHashed, mismatches, scanned };
}

/* ── Tier C: permissions, links, versions, timestamps ───────────────────────*/

/**
 * Compare the source permissions on one item against the destination's, through the user mapping.
 *
 * Handles both principal types the QA suite exercises: a grant to a person and a grant to a GROUP.
 * A user whose access comes through group membership is the case worth care — SharePoint shows the
 * group, not the person, so looking only for the person would fail a correct migration. When a user
 * grant has no direct destination match but a group grant on the same item carries at least the
 * expected level, the row is classified `viaGroup` and reported as informational rather than failed.
 * That is deliberately not silent: the row still appears in the report saying how access was resolved.
 *
 * @param {Array} sourcePerms  [{ email, role, type: 'user'|'group' }]
 * @param {Array} destPerms    [{ email, roles: [], principalType }]
 * @param {(email) => string} mapEmail
 * @returns {{ checked, matches, mismatches, escalations, viaGroup }}
 */
function comparePermissions(sourcePerms, destPerms, mapEmail) {
  const dest = Array.isArray(destPerms) ? destPerms : [];
  const matches = [];
  const mismatches = [];
  const escalations = [];
  const viaGroup = [];
  const notComparable = [];
  const unmappedPrincipals = [];
  let checked = 0;

  // Group grants on the destination, for the membership fallback below.
  const destGroupRoles = dest
    .filter((d) => String(d.principalType || '') === 'group')
    .flatMap((d) => d.roles || []);

  /**
   * Recognise the same group on both sides. A group is NOT mapped through Map Users: CloudFuze
   * migrates it AS A GROUP, so the destination tenant holds it under its own address — often with
   * no email at all, only a display name. Compare on alphanumerics of the local part and of the
   * display name, which pairs qa-group-view@filefuze.co with the destination group "qa-group-view"
   * and everyone_at_exinent@filefuze.co with "EveryoneatExinent@gajha.com".
   */
  const normKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const groupKeys = (email, name) => {
    const keys = new Set();
    const e = String(email || '').toLowerCase();
    if (e) {
      keys.add(normKey(e));
      keys.add(normKey(e.split('@')[0]));
    }
    if (name) keys.add(normKey(name));
    keys.delete('');
    return keys;
  };

  for (const sp of Array.isArray(sourcePerms) ? sourcePerms : []) {
    if (!sp?.email) continue;
    const principalType = String(sp.type || 'user').toLowerCase() === 'group' ? 'group' : 'user';

    // A role with no comparable destination permission (ownership, or an unrecognised role) is
    // reported, not failed. Drive returns an `owner` grant for every My Drive file, and treating it
    // as an ordinary grant failed every My Drive run on its own owner permission.
    if (!roleMap.isComparableDriveRole(sp.role)) {
      notComparable.push({
        user: sp.email,
        principalType,
        sourceRole: sp.role,
        reason: roleMap.nonComparableReason(sp.role),
      });
      continue;
    }

    // A source principal with no destination mapping cannot be re-granted: CloudFuze has nobody
    // to give the permission to. Counting that as a permission mismatch blamed the migration for
    // a configuration gap — every grant to an unmapped principal failed, which is how one
    // unmapped group produced 80 identical "SharePoint no access" rows and buried the grants that
    // genuinely did not migrate.
    // ── GROUP: matched group-to-group, never through a user mapping ──────────────────────
    // Mapping a group to a PERSON (as CONTENT_EXTRA_USER_MAPPINGS did) told this comparison to
    // expect that person to hold the grant. CloudFuze never does that, so every group grant failed
    // against a user who was never meant to have it. Unmapped, they were excused as "not
    // migratable" instead — also wrong: they had migrated, correctly, as groups.
    if (principalType === 'group') {
      const srcKeys = groupKeys(sp.email, sp.name);
      const hit = dest.find((d) => d.principalType === 'group'
        && [...groupKeys(d.email, d.name)].some((k) => srcKeys.has(k)));
      checked++;
      const destRoles = hit ? (hit.roles || []) : [];
      const cmp = roleMap.compareDriveAccess(sp.role, destRoles);
      const row = {
        user: sp.email,
        principalType: 'group',
        mappedTo: hit ? (hit.email || hit.name) : '(no matching group at the destination)',
        sourceRole: sp.role,
        destRoles,
        expected: cmp.expectedSpLabel,
        match: cmp.match,
      };
      if (cmp.match) matches.push(row); else mismatches.push(row);
      if (cmp.overGranted) {
        escalations.push({ ...row, note: 'destination grants more access than the source' });
      }
      continue;
    }

    const mapping = mapEmail ? mapEmail(sp.email, { detail: true }) : null;
    const expected = (mapping && typeof mapping === 'object')
      ? mapping.email
      : (mapping || String(sp.email).toLowerCase());
    const isMapped = (mapping && typeof mapping === 'object') ? Boolean(mapping.mapped) : true;
    if (!isMapped) {
      unmappedPrincipals.push({
        user: sp.email,
        principalType,
        sourceRole: sp.role,
        reason: 'no destination user is mapped for this principal, so the permission cannot be '
          + 'migrated — map it under Map Users to bring it into scope',
      });
      continue;
    }
    checked++;
    const destRoles = dest
      .filter((d) => String(d.email || '').toLowerCase() === expected)
      .flatMap((d) => d.roles || []);
    const cmp = roleMap.compareDriveAccess(sp.role, destRoles);
    const row = {
      user: sp.email,
      principalType,
      mappedTo: expected,
      sourceRole: sp.role,
      destRoles,
      expected: cmp.expectedSpLabel,
      match: cmp.match,
    };

    if (cmp.match) {
      matches.push(row);
    } else if (principalType === 'user' && destGroupRoles.length > 0
      && roleMap.compareDriveAccess(sp.role, destGroupRoles).match) {
      // Access is present, just carried by a group the user belongs to.
      const groupRow = {
        ...row,
        match: true,
        viaGroup: true,
        groupRoles: destGroupRoles,
        note: 'no direct grant, but a group on this item carries at least the expected access — '
          + 'verify the user is a member of that group',
      };
      matches.push(groupRow);
      viaGroup.push(groupRow);
    } else {
      mismatches.push(row);
    }

    if (cmp.overGranted) escalations.push({ ...row, note: 'destination grants more access than the source' });
  }

  return { checked, matches, mismatches, escalations, viaGroup, notComparable, unmappedPrincipals };
}

/**
 * Classify an item by the scope names the QA suite reports against: a permission on a root folder is
 * a different test from one on a sub folder or an inner file.
 * @returns {'rootFolder'|'subFolder'|'rootFile'|'innerFile'|'root'}
 */
function scopeOf(item) {
  const depth = segmentsOf(item?.path).length;
  if (depth === 0) return 'root';
  const isFolder = item?.type === 'folder';
  if (depth === 1) return isFolder ? 'rootFolder' : 'rootFile';
  return isFolder ? 'subFolder' : 'innerFile';
}

/** Human label for a scope key, for report lines. */
const SCOPE_LABEL = {
  root: 'shared drive root',
  rootFolder: 'root folder',
  rootFile: 'root file',
  subFolder: 'sub folder',
  innerFile: 'inner file',
};

/**
 * Compare the source shared links on one item against the destination's link permissions.
 * Asserts BOTH axes — who the link reaches (scope) and what they can do (type).
 *
 * @param {Array} sourceLinks  [{ type: 'anyone'|'domain', role }]
 * @param {Array} destLinks    [{ scope, type, roles }]
 */
function compareSharedLinks(sourceLinks, destLinks) {
  const results = [];
  const mismatches = [];

  const dest = Array.isArray(destLinks) ? destLinks : [];

  for (const link of Array.isArray(sourceLinks) ? sourceLinks : []) {
    const cmp = roleMap.compareSharedLink(link, destLinks);
    const row = {
      sourceType: link?.type,
      sourceRole: link?.role,
      expected: `${cmp.expectedScope}/${cmp.expectedType}`,
      actual: cmp.actual.join(', ') || 'no link on destination',
      scopeMatch: cmp.scopeMatch,
      typeMatch: cmp.typeMatch,
      match: cmp.match,
      // True when an anonymous link was expected and the destination holds no anonymous link at
      // all. Whether that is EXCUSABLE is decided after the loop — it depends on the whole item.
      anonymousAbsent: cmp.expectedScope === 'anonymous' && !cmp.scopeMatch,
    };
    results.push(row);
    if (!cmp.match) {
      mismatches.push({
        ...row,
        reason: !cmp.scopeMatch
          ? `no ${cmp.expectedScope} link on the destination`
          : `link scope preserved but type is not "${cmp.expectedType}"`,
      });
    }
  }

  // A missing anonymous link is excusable only when it is CONSISTENT with the destination refusing
  // anonymous sharing. Two shapes are:
  //   - the destination holds no link at all, or
  //   - every link it holds is claimed by a DIFFERENT source link that matched.
  // Both mean "the anonymous link simply could not be created".
  //
  // The shape that is NOT excusable is a public link that arrived NARROWED to organization scope
  // with no organization source link to explain it: the destination demonstrably can hold a link,
  // it just holds a weaker one, and that is data loss. contentCombinationSuite covers it.
  //
  // This was previously decided by regex over the rendered message, whose "actual" text carried
  // the item's OTHER links — so an item holding both an anonymous and an organization source link
  // never matched the pattern, and four excusable rows were reported as defects.
  const otherSourceLinkMatched = results.some((r) => !r.anonymousAbsent && r.match);
  const anonymousExcusable = dest.length === 0 || otherSourceLinkMatched;
  for (const m of mismatches) {
    m.anonymousExcusable = Boolean(m.anonymousAbsent && anonymousExcusable);
  }

  return { checked: results.length, results, mismatches };
}

/**
 * Version history (feature 8.1) — INFORMATIONAL ONLY.
 *
 * Per google-shared-drive-to-sharepoint-outscope.md, counts cannot be expected to match: the Google API
 * merges smaller revisions when listing, SharePoint may add a version for the migration timestamp, and
 * Google may expose only the earliest and latest revision. This returns a row to report, never a verdict.
 */
function compareVersions(sourceCount, destCount, opts = {}) {
  const { path = '', name = '' } = opts;
  const src = Number(sourceCount) || 0;
  const dst = Number(destCount) || 0;

  let note;
  if (src <= 1) note = 'single-version file — nothing to compare';
  else if (dst === 0) note = 'no version history on the destination — check that versioning is enabled on the library';
  else if (dst < src) {
    note = 'fewer versions on the destination — expected: the Google API merges smaller revisions when listing (documented limitation, not a defect)';
  } else if (dst > src) {
    note = 'more versions on the destination — expected: SharePoint may add a version reflecting the migration timestamp';
  } else note = 'version counts match';

  return { path, name, sourceVersions: src, destVersions: dst, severity: 'INFO', note };
}

/**
 * Created / modified timestamps (feature 10.1). Drift inside the band counts as preserved.
 * Version timestamps are explicitly out of scope and are not compared here.
 */
function compareTimestamps(source, dest, driftMs) {
  const parse = (v) => {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  };
  const sMod = parse(source?.modifiedAt);
  const dMod = parse(dest?.modifiedAt);
  const sCre = parse(source?.createdAt);
  const dCre = parse(dest?.createdAt);

  if (sMod === null || dMod === null) {
    return { comparable: false, match: null, note: 'no comparable timestamps' };
  }

  const modifiedOff = Math.abs(sMod - dMod) > driftMs;
  const createdOff = sCre !== null && dCre !== null && Math.abs(sCre - dCre) > driftMs;

  return {
    comparable: true,
    match: !modifiedOff && !createdOff,
    modifiedOff,
    createdOff,
    sourceModified: source?.modifiedAt || null,
    destModified: dest?.modifiedAt || null,
    sourceCreated: source?.createdAt || null,
    destCreated: dest?.createdAt || null,
  };
}

/**
 * Size comparison against a tolerance band. Converted files use the wider band, since a converter
 * legitimately produces a different size for the same document.
 */
function compareSize(source, dest, bands) {
  const s = Number(source?.size);
  const d = Number(dest?.size);
  if (!Number.isFinite(s) || !Number.isFinite(d) || s <= 0) {
    return { comparable: false, status: 'INFO', note: 'no comparable sizes' };
  }
  const band = isConverted(source) ? bands?.convertedFileSize : bands?.fileSize;
  if (!band) return { comparable: false, status: 'INFO', note: 'no tolerance band configured' };

  const ratio = d / s;
  let status;
  if (ratio >= band.infoMin && ratio <= band.infoMax) status = 'PASS';
  else if (ratio >= band.warnMin && ratio <= band.warnMax) status = 'WARN';
  else status = 'FAIL';

  return { comparable: true, status, ratio, sourceSize: s, destSize: d, note: band.note || '' };
}

/* ── Run shape ──────────────────────────────────────────────────────────────*/

/** Build a source→destination email map from Map-Users, the permission mapping, and migrated units. */
function buildEmailMap(context) {
  const map = {};
  const add = (s, d) => {
    if (s && d) map[String(s).toLowerCase()] = String(d).toLowerCase();
  };
  for (const m of context?.userEmailMappings || []) add(m?.sourceEmail, m?.destinationEmail);
  for (const m of context?.migratedUsers || []) add(m?.sourceEmail, m?.destinationEmail);

  const pm = context?.permissionMapping;
  if (Array.isArray(pm)) {
    for (const m of pm) {
      add(m?.sourceEmail || m?.fromMailId || m?.from, m?.destinationEmail || m?.toMailId || m?.to);
    }
  } else if (pm && typeof pm === 'object') {
    for (const [s, d] of Object.entries(pm)) add(s, typeof d === 'string' ? d : d?.destinationEmail);
  }
  return map;
}

/** One transfer unit per migrated pair: migratedUsers → userFolderMappings → the single-pair fallback. */
function resolveUnits(context) {
  const migrated = Array.isArray(context?.migratedUsers) ? context.migratedUsers : [];
  if (migrated.length > 0) {
    return migrated.map((m) => ({
      sourceEmail: m.sourceEmail || context.sourceEmail,
      destinationEmail: m.destinationEmail || context.destinationEmail,
      sourcePath: m.sourcePath || context.sourceTestDataPath || '',
      destinationPath: m.destinationPath || context.destinationPath || '/',
      // The drive must survive BOTH branches. It was added to the userFolderMappings branch below
      // only, and this branch wins whenever a migration ran — so every unit reached validation with
      // no drive, the validator fell back to one run-wide drive, and unit 2 was compared against
      // unit 1's source tree.
      sourceDriveName: m.sourceDriveName || null,
      sourceDriveId: m.sourceDriveId || null,
    }));
  }

  const folders = Array.isArray(context?.userFolderMappings) ? context.userFolderMappings : [];
  if (folders.length > 0) {
    return folders.map((f) => ({
      sourceEmail: f.sourceEmail || context.sourceEmail,
      destinationEmail: f.destinationEmail || context.destinationEmail,
      sourcePath: f.sourcePath || context.sourceTestDataPath || '',
      destinationPath: f.destinationPath || context.destinationPath || '/',
      // Carried through so a validator can resolve the SOURCE per unit. Two units may share a
      // sourcePath ("/Agent Shared Drive") and differ only by drive, in which case resolving one
      // drive for the whole run compares the second destination against the first drive's tree.
      // Additive: existing consumers ignore these, so every other combination is unaffected.
      sourceDriveName: f.sourceDriveName || null,
      sourceDriveId: f.sourceDriveId || null,
    }));
  }

  return [{
    sourceEmail: context?.sourceEmail,
    destinationEmail: context?.destinationEmail,
    sourcePath: context?.sourceTestDataPath || context?.sourcePath || '',
    destinationPath: context?.destinationPath || '/',
  }];
}

module.exports = {
  // constants
  spInvalidChars,
  SP_RESERVED_NAMES,
  PATH_LENGTH_LIMIT,
  SEGMENT_LENGTH_LIMIT,
  GOOGLE_NATIVE_EXPORT,
  LEGACY_OFFICE_CONVERSION,
  PASSTHROUGH_EXTENSIONS,
  // names
  sanitizeForSharePoint,
  isReservedName,
  needsSanitizing,
  normKey,
  namesMatch,
  // paths
  segmentsOf,
  encodedPathLength,
  exceedsPathLimit,
  oversizedSegments,
  expectPlaceholderLink,
  lastSegment,
  joinPath,
  parentOf,
  inDrivePath,
  siteSegmentOf,
  relativize,
  // file types
  isGoogleNative,
  isShortcut,
  isUnmigratableNative,
  unmigratableReason,
  GOOGLE_NATIVE_NO_EXPORT,
  extensionOf,
  convertName,
  expectedDestExtension,
  expectedDestName,
  isConverted,
  isHashable,
  notHashableReason,
  // scope
  scopeOf,
  SCOPE_LABEL,
  // tiers
  compareTrees,
  compareFolders,
  tierBHashes,
  comparePermissions,
  compareSharedLinks,
  compareVersions,
  compareTimestamps,
  compareSize,
  // run shape
  buildEmailMap,
  resolveUnits,
  // env helpers, re-exported so combinations have one source
  intEnv,
  boolEnv,
};
