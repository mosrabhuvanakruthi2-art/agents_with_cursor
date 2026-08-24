'use strict';

/**
 * Content Functionality Checklist
 * --------------------------------
 * Rolls the per-item content validation results up into a per-FEATURE checklist, so a report answers
 * "which of the documented features actually work" rather than "how many checks passed".
 *
 * The content counterpart of functionalityChecklist.js (which does this for mail).
 *
 * Feature set and numbering come from
 *   backend/data/feature-scope/google-shared-drive-to-sharepoint-inscope.md   (38 features)
 *   backend/data/feature-scope/google-shared-drive-to-sharepoint-outscope.md  (1 limitation)
 *
 * States:
 *   'pass' — the feature was exercised and nothing mismatched
 *   'fail' — the feature was exercised and something mismatched
 *   'na'   — the feature could NOT be assessed by this run, with the reason. A role or link type that
 *            never appeared in the source, or a tier that was switched off, is 'na' — never 'pass'.
 *            Reporting an unexercised feature as passing is the failure mode this file exists to avoid.
 *   'info' — reported for information only and cannot fail (the out-of-scope version behaviour)
 */

/** Drive API role → the feature-doc UI label, for readable detail lines. */
const ROLE_LABEL = {
  reader: 'Viewer',
  commenter: 'Commenter',
  writer: 'Contributor/Editor',
  fileorganizer: 'Content Manager',
  organizer: 'Manager',
};

const norm = (v) => String(v || '').toLowerCase().trim();

function pass(detail) { return { status: 'pass', detail }; }
function fail(detail) { return { status: 'fail', detail }; }
function na(detail) { return { status: 'na', detail }; }
function info(detail) { return { status: 'info', detail }; }

/**
 * Verdict for one row of the permission matrix (features 4.2–4.8).
 * A role never seen in the source is 'na' — we cannot claim it migrated correctly.
 */
function evalPermissionRole(observations, itemType, role) {
  const seen = observations.filter((o) => norm(o.itemType) === itemType && norm(o.role) === norm(role));
  if (seen.length === 0) {
    return na(`No ${itemType} with ${ROLE_LABEL[norm(role)] || role} access existed in the source — not exercised`);
  }
  const bad = seen.filter((o) => !o.match);
  // The QA suite reports these by principal and by scope, so the detail line carries both — a row
  // that passed only for users while groups were never tried should say so.
  const context = describeCoverage(seen);
  return bad.length === 0
    ? pass(`${seen.length} ${itemType}(s) — access preserved${context}`)
    : fail(`${bad.length}/${seen.length} ${itemType}(s) wrong${context}: ${bad.slice(0, 5).map((o) => o.path).join(', ')}`);
}

/** " [users + groups; root folder, sub folder]" — what the observations actually covered. */
function describeCoverage(observations) {
  const principals = [...new Set(observations.map((o) => norm(o.principalType) || 'user'))];
  // Scope keys are camelCase ('rootFolder') and index SCOPE_LABEL directly — lower-casing them here
  // would miss the label and print the raw key.
  const scopes = [...new Set(observations.map((o) => o.scope).filter(Boolean))];
  const parts = [];
  if (principals.length) parts.push(principals.map((p) => (p === 'group' ? 'groups' : 'users')).join(' + '));
  if (scopes.length) parts.push(scopes.map((s) => SCOPE_LABEL[s] || s).join(', '));
  const viaGroup = observations.filter((o) => o.viaGroup).length;
  if (viaGroup) parts.push(`${viaGroup} resolved via group membership`);
  return parts.length ? ` [${parts.join('; ')}]` : '';
}

/** Scope keys, mirroring deepContentCore.scopeOf. */
const SCOPE_LABEL = {
  root: 'shared drive root',
  rootFolder: 'root folder',
  rootFile: 'root file',
  subFolder: 'sub folder',
  innerFile: 'inner file',
};

/**
 * Coverage of the dimensions the manual QA suite treats as first-class: principal type
 * (user vs group), item scope, and — for a delta run — whether anything was checked at all.
 * Reported alongside the feature rows so a green checklist cannot hide a whole untested axis.
 */
function buildCoverageReport(permObs, linkObs) {
  const all = [...permObs, ...linkObs];
  const scopes = ['rootFolder', 'rootFile', 'subFolder', 'innerFile'];
  return {
    principals: {
      user: permObs.filter((o) => norm(o.principalType) !== 'group').length,
      group: permObs.filter((o) => norm(o.principalType) === 'group').length,
      viaGroupMembership: permObs.filter((o) => o.viaGroup).length,
    },
    scopes: Object.fromEntries(scopes.map((s) => [s, all.filter((o) => norm(o.scope) === norm(s)).length])),
    untestedScopes: scopes.filter((s) => !all.some((o) => norm(o.scope) === norm(s)))
      .map((s) => SCOPE_LABEL[s]),
    groupsUntested: permObs.length > 0 && permObs.every((o) => norm(o.principalType) !== 'group'),
  };
}

/** Verdict for one row of the shared-link matrix (features 5.2–5.15). */
function evalLinkRow(observations, itemType, linkType, role) {
  const seen = observations.filter((o) => norm(o.itemType) === itemType
    && norm(o.linkType) === norm(linkType) && norm(o.role) === norm(role));
  const scopeLabel = norm(linkType) === 'anyone' ? 'Anyone with link' : 'organization';
  if (seen.length === 0) {
    return na(`No ${itemType} had an "${scopeLabel} — ${ROLE_LABEL[norm(role)] || role}" link in the source — not exercised`);
  }
  const bad = seen.filter((o) => !o.match);
  return bad.length === 0
    ? pass(`${seen.length} link(s) — scope and access level both preserved`)
    : fail(`${bad.length}/${seen.length} link(s) wrong: ${bad.slice(0, 5).map((o) => o.path).join(', ')}`);
}

/**
 * Build the 38-feature checklist.
 *
 * @param {object} dcv   the deepContentValidation totals produced by the combination validator
 * @param {object} opts  { migrationType: 'FULL' | 'DELTA' }
 * @returns {{ rows: Array<{id,category,feature,status,detail}>, coverage: object }}
 */
function computeContentFunctionalityChecklist(dcv, opts = {}) {
  const d = dcv || {};
  const migrationType = norm(opts.migrationType || d.migrationType || 'FULL').toUpperCase();
  const isDelta = migrationType === 'DELTA';

  const scanned = d.scannedSourceItems || 0;
  const missing = d.missing || [];
  const extra = d.extra || [];
  const misplaced = d.misplaced || [];
  const placeholders = d.placeholderLinks || [];
  const permObs = d.permissionObservations || [];
  const linkObs = d.linkObservations || [];
  const fileTypes = d.fileTypes || [];
  const specialChars = d.specialChars || { total: 0, arrived: 0 };

  // Nothing was read, so nothing can be claimed about any feature.
  const emptyCoverage = buildCoverageReport([], []);
  if (!d.enabled) {
    return {
      rows: buildIds().map((f) => ({ ...f, status: 'na', detail: 'Deep content validation was disabled for this run' })),
      coverage: emptyCoverage,
    };
  }
  if (scanned === 0) {
    return {
      rows: buildIds().map((f) => ({ ...f, status: 'na', detail: 'No source items were read — nothing was validated' })),
      coverage: emptyCoverage,
    };
  }

  const structureClean = missing.length === 0 && extra.length === 0 && misplaced.length === 0;
  const verdicts = {};

  // ── 1. Migration
  verdicts['1.1'] = isDelta
    ? na('This run was a delta migration')
    : (structureClean
      ? pass(`${scanned} source item(s) migrated and verified`)
      : fail(`${missing.length} missing, ${extra.length} extra, ${misplaced.length} misplaced`));
  verdicts['1.2'] = isDelta
    ? (structureClean
      ? pass('Incremental changes migrated and verified')
      : fail(`${missing.length} missing, ${extra.length} extra, ${misplaced.length} misplaced`))
    : na('This run was a one-time migration, not a delta');

  // ── 2. Files & folders
  const typeGaps = fileTypes.filter((t) => t.paired < t.total);
  verdicts['2.1'] = fileTypes.length === 0
    ? na('No files in the source')
    : (typeGaps.length === 0
      ? pass(fileTypes.map((t) => `${t.ext} ${t.paired}/${t.total}`).join(', '))
      : fail(`Missing by type: ${typeGaps.map((t) => `${t.ext} ${t.paired}/${t.total}`).join(', ')}`));

  // ── 3. Structure
  verdicts['3.1'] = structureClean
    ? pass(`Hierarchy identical — ${d.pairedCount || 0}/${scanned} items paired`)
    : fail(`missing ${missing.length}, extra ${extra.length}, misplaced ${misplaced.length}`);

  // ── 4. Permissions
  if (!d.metadataChecked) {
    for (const id of ['4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7', '4.8', '4.9']) {
      verdicts[id] = na('Metadata validation was switched off (CONTENT_DEEP_VALIDATE_METADATA=false)');
    }
  } else {
    const permBad = permObs.filter((o) => !o.match);
    verdicts['4.1'] = permObs.length === 0
      ? na('No shared items in the source — permissions were not exercised')
      : (permBad.length === 0
        ? pass(`${permObs.length} grant(s) mapped correctly${describeCoverage(permObs)}`)
        : fail(`${permBad.length}/${permObs.length} grant(s) wrong${describeCoverage(permObs)}`));
    verdicts['4.2'] = evalPermissionRole(permObs, 'folder', 'reader');
    verdicts['4.3'] = evalPermissionRole(permObs, 'folder', 'commenter');
    verdicts['4.4'] = evalPermissionRole(permObs, 'folder', 'writer');
    verdicts['4.5'] = evalPermissionRole(permObs, 'folder', 'fileOrganizer');
    verdicts['4.6'] = evalPermissionRole(permObs, 'file', 'reader');
    verdicts['4.7'] = evalPermissionRole(permObs, 'file', 'commenter');
    verdicts['4.8'] = evalPermissionRole(permObs, 'file', 'writer');

    const ext = d.externalShares || [];
    const extBad = ext.filter((o) => !o.match);
    verdicts['4.9'] = ext.length === 0
      ? na('No shares with users outside the source domain — not exercised')
      : (extBad.length === 0
        ? pass(`${ext.length} external share(s) preserved`)
        : fail(`${extBad.length}/${ext.length} external share(s) missing or wrong — also check the tenant's external sharing policy`));
  }

  // ── 5. Shared links
  if (!d.metadataChecked || !d.linksChecked) {
    for (let n = 1; n <= 15; n++) {
      verdicts[`5.${n}`] = na('Shared-link validation was switched off (CONTENT_DEEP_VALIDATE_LINKS=false)');
    }
  } else {
    const linkBad = linkObs.filter((o) => !o.match);
    verdicts['5.1'] = linkObs.length === 0
      ? na('No shared links in the source — not exercised')
      : (linkBad.length === 0
        ? pass(`${linkObs.length} link(s) migrated to the equivalent SharePoint configuration`)
        : fail(`${linkBad.length}/${linkObs.length} link(s) wrong`));
    // 5.2–5.9 folders, 5.10–5.15 files
    verdicts['5.2'] = evalLinkRow(linkObs, 'folder', 'anyone', 'reader');
    verdicts['5.3'] = evalLinkRow(linkObs, 'folder', 'anyone', 'commenter');
    verdicts['5.4'] = evalLinkRow(linkObs, 'folder', 'anyone', 'writer');
    verdicts['5.5'] = evalLinkRow(linkObs, 'folder', 'anyone', 'fileOrganizer');
    verdicts['5.6'] = evalLinkRow(linkObs, 'folder', 'domain', 'reader');
    verdicts['5.7'] = evalLinkRow(linkObs, 'folder', 'domain', 'commenter');
    verdicts['5.8'] = evalLinkRow(linkObs, 'folder', 'domain', 'writer');
    verdicts['5.9'] = evalLinkRow(linkObs, 'folder', 'domain', 'fileOrganizer');
    verdicts['5.10'] = evalLinkRow(linkObs, 'file', 'anyone', 'reader');
    verdicts['5.11'] = evalLinkRow(linkObs, 'file', 'anyone', 'commenter');
    verdicts['5.12'] = evalLinkRow(linkObs, 'file', 'anyone', 'writer');
    verdicts['5.13'] = evalLinkRow(linkObs, 'file', 'domain', 'reader');
    verdicts['5.14'] = evalLinkRow(linkObs, 'file', 'domain', 'commenter');
    verdicts['5.15'] = evalLinkRow(linkObs, 'file', 'domain', 'writer');
  }

  // CloudFuze generates these CSVs on its own server. No API for retrieving them is wired up in this
  // repo, so they are honestly reported as not assessed with the manual step, rather than assumed.
  verdicts['5.16'] = na('Not automated — no API for the Shared Links CSV. Manual: download the Shared Links CSV from the migration job and confirm it lists every shared source item');
  verdicts['6.2'] = na('Not automated — no API for the Embedded Links CSV. Manual: download the Embedded Links CSV from the migration job and confirm it lists the embedded references');

  // ── 6.1 Embedded links: requires parsing document contents for Drive URLs and confirming the
  // rewrite. Not implemented — reported as not assessed rather than assumed to work.
  verdicts['6.1'] = na('Not automated — needs document-content parsing to find Drive URLs and confirm the SharePoint rewrite. Manual: open a file containing a link to another Drive file and confirm the link points at SharePoint');

  // ── 7. Special characters
  verdicts['7.1'] = specialChars.total === 0
    ? na('No items with characters SharePoint rejects — not exercised')
    : (specialChars.arrived === specialChars.total
      ? pass(`${specialChars.total} item(s) renamed and found at the destination`)
      : fail(`${specialChars.arrived}/${specialChars.total} renamed item(s) found`));

  // ── 8. Versions — information only, per the out-of-scope document
  const versionInfo = d.versionInfo || [];
  const noHistory = versionInfo.filter((v) => v.destVersions === 0);
  if (!d.metadataChecked) {
    verdicts['8.1'] = na('Metadata validation was switched off');
  } else if (versionInfo.length === 0) {
    verdicts['8.1'] = na('No multi-version files in the source — not exercised');
  } else if (noHistory.length > 0) {
    // Reported, not failed: the validator raises this as a WARN, and the in-scope doc makes version
    // history conditional on the destination library having versioning enabled. Keeping the two
    // surfaces at the same severity stops a run reading WARN overall while its feature table says FAIL.
    verdicts['8.1'] = info(`${noHistory.length} file(s) have no version history at the destination — check that versioning is enabled on the document library`);
  } else {
    verdicts['8.1'] = info(`${versionInfo.length} versioned file(s) have history at the destination. Counts are not compared: the Google API merges smaller revisions and SharePoint may add a version for the migration timestamp (documented limitation)`);
  }

  // ── 9. Suppress email notifications
  if (!d.notificationsChecked) {
    const detail = 'Not checked (CONTENT_DEEP_VALIDATE_NOTIFICATIONS=false). Manual: confirm the destination user received no SharePoint sharing or invitation mail';
    verdicts['9.1'] = na(detail);
    verdicts['9.2'] = na(detail);
  } else {
    const leaks = d.notificationLeaks || [];
    const verdict = leaks.length === 0
      ? pass('No SharePoint sharing or invitation mail reached the destination user')
      : fail(`${leaks.length} notification(s) reached the destination user: ${leaks.slice(0, 5).join(' | ')}`);
    verdicts['9.1'] = verdict;
    verdicts['9.2'] = verdict;
  }

  // ── 10. Metadata
  const drift = d.timestampDrift || [];
  // The in-scope doc hedges 10.1 ("metadata preservation may depend on SharePoint settings"), and the
  // validator raises drift as a WARN — so this is reported, not failed.
  verdicts['10.1'] = !d.metadataChecked
    ? na('Metadata validation was switched off')
    : (drift.length === 0
      ? pass('Created and last-modified times preserved within tolerance')
      : info(`${drift.length} file(s) outside the timestamp tolerance — metadata preservation depends on destination library settings`));

  // ── 11. Long paths
  verdicts['11.1'] = placeholders.length === 0
    ? na('No source path exceeded the SharePoint limit — not exercised')
    : pass(`${placeholders.length} over-limit item(s) handled as placeholder links, as documented`);

  // ── 12. File conversion
  const convMismatches = d.conversionMismatches || [];
  const converted = (d.fileTypes || []).filter((t) => ['(Google native)', '.doc', '.xls', '.ppt'].includes(t.ext));
  verdicts['12.1'] = converted.length === 0
    ? na('No files needed conversion — not exercised')
    : (convMismatches.length === 0
      ? pass('All converted files carry the expected destination format')
      : fail(`${convMismatches.length} file(s) converted to the wrong format`));

  // Nothing paired: the source read fine but no item arrived, so every comparison ran against an
  // empty destination side. A check with nothing to compare has not been satisfied — it has not been
  // run — so no row may claim PASS. Without this, a run where 0 of 316 items migrated still reported
  // 10.1 Metadata, 11.1 Long paths and 12.1 File Conversion as PASS.
  const pairedCount = Number(d.pairedCount || 0) || 0;
  const nothingPaired = scanned > 0 && pairedCount === 0;

  const rows = buildIds().map((f) => {
    const v = verdicts[f.id] || na('Not assessed');
    if (nothingPaired && (v.status === 'pass' || v.status === 'info')) {
      return {
        ...f,
        status: 'fail',
        detail: `Not verifiable — 0 of ${scanned} source item(s) reached the destination, so this check had nothing to compare`,
      };
    }
    return { ...f, status: v.status, detail: v.detail };
  });
  return { rows, coverage: buildCoverageReport(permObs, linkObs), nothingPaired };
}

/** The 38 in-scope features, in document order. */
function buildIds() {
  return [
    { id: '1.1', category: 'Migration', feature: 'One Time Migration' },
    { id: '1.2', category: 'Migration', feature: 'Delta Migration' },
    { id: '2.1', category: 'Files & Folder Migration', feature: 'Files & Folder Migration' },
    { id: '3.1', category: 'Preserving File/Folder structure', feature: 'Preserving File/Folder structure' },
    { id: '4.1', category: 'Permissions', feature: 'Permissions' },
    { id: '4.2', category: 'Permissions', feature: 'Folder Permissions: Viewer' },
    { id: '4.3', category: 'Permissions', feature: 'Folder Permissions: Commenter' },
    { id: '4.4', category: 'Permissions', feature: 'Folder Permissions: Contributor' },
    { id: '4.5', category: 'Permissions', feature: 'Folder Permissions: Content Manager' },
    { id: '4.6', category: 'Permissions', feature: 'File Permissions: Viewer' },
    { id: '4.7', category: 'Permissions', feature: 'File Permissions: Commenter' },
    { id: '4.8', category: 'Permissions', feature: 'File Permissions: Editor' },
    { id: '4.9', category: 'Permissions', feature: 'External Shares' },
    { id: '5.1', category: 'Shared Links', feature: 'Shared Links' },
    { id: '5.2', category: 'Shared Links', feature: 'Folders: Anyone with link - Viewer' },
    { id: '5.3', category: 'Shared Links', feature: 'Folders: Anyone with link - Commenter' },
    { id: '5.4', category: 'Shared Links', feature: 'Folders: Anyone with link - Contributor' },
    { id: '5.5', category: 'Shared Links', feature: 'Folders: Anyone with link - Content Manager' },
    { id: '5.6', category: 'Shared Links', feature: 'Folders: Sync Orbit - Viewer' },
    { id: '5.7', category: 'Shared Links', feature: 'Folders: Sync Orbit - Commenter' },
    { id: '5.8', category: 'Shared Links', feature: 'Folders: Sync Orbit - Contributor' },
    { id: '5.9', category: 'Shared Links', feature: 'Folders: Sync Orbit - Content Manager' },
    { id: '5.10', category: 'Shared Links', feature: 'Files: Anyone with link - Viewer' },
    { id: '5.11', category: 'Shared Links', feature: 'Files: Anyone with link - Commenter' },
    { id: '5.12', category: 'Shared Links', feature: 'Files: Anyone with link - Editor' },
    { id: '5.13', category: 'Shared Links', feature: 'Files: Sync Orbit - Viewer' },
    { id: '5.14', category: 'Shared Links', feature: 'Files: Sync Orbit - Commenter' },
    { id: '5.15', category: 'Shared Links', feature: 'Files: Sync Orbit - Editor' },
    { id: '5.16', category: 'Shared Links', feature: 'Shared Link CSV generation' },
    { id: '6.1', category: 'Embedded Links', feature: 'Embedded Links' },
    { id: '6.2', category: 'Embedded Links', feature: 'Embedded Link CSV generation' },
    { id: '7.1', category: 'Special Character Replacement', feature: 'Special Character Replacement' },
    { id: '8.1', category: 'Versions or Selective Versions', feature: 'Versions or Selective Versions' },
    { id: '9.1', category: 'Suppress Email Notifications', feature: 'Suppress Email Notifications' },
    { id: '9.2', category: 'Suppress Email Notifications', feature: 'Email from Destination Part' },
    { id: '10.1', category: 'Metadata', feature: 'Metadata' },
    { id: '11.1', category: 'Long Folder/File path', feature: 'Long Folder/File path' },
    { id: '12.1', category: 'File Conversion', feature: 'File Conversion' },
  ];
}

/** Counts by state, for the report header. */
function summarizeChecklist(checklist, coverage = null) {
  const counts = { pass: 0, fail: 0, na: 0, info: 0 };
  for (const row of checklist || []) {
    if (counts[row.status] !== undefined) counts[row.status]++;
  }

  const gaps = [];
  if (coverage) {
    if (coverage.groupsUntested) gaps.push('no GROUP permissions were exercised');
    if (coverage.untestedScopes?.length) gaps.push(`untested scopes: ${coverage.untestedScopes.join(', ')}`);
  }

  return {
    ...counts,
    total: (checklist || []).length,
    coverage,
    coverageGaps: gaps,
    line: `Features: ${counts.pass} pass, ${counts.fail} fail, ${counts.info} info, ${counts.na} not assessed `
      + `(of ${(checklist || []).length})`
      + (gaps.length ? ` | Coverage gaps: ${gaps.join('; ')}` : ''),
  };
}

module.exports = {
  computeContentFunctionalityChecklist,
  summarizeChecklist,
  buildIds,
  buildCoverageReport,
  SCOPE_LABEL,
};
