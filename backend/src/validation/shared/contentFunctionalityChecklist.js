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
    : fail(`${describeDefects(bad, `${itemType}(s)`)} of ${seen.length} checked${context}`);
}

/**
 * Distinct DEFECTS among failing observations, and how far each spread.
 *
 * Google reports an inherited grant on every item it reaches, so one group missing from a Shared
 * Drive root produced a failing observation per item — reported as "88/978 grant(s) wrong", which
 * reads as 88 things to fix when there is one. Keying on the principal and role collapses the copies
 * while still saying how many grants were affected.
 *
 * Falls back to the path when observations carry no principal (older records, other combinations),
 * so the count degrades to the previous per-item behaviour rather than collapsing unrelated rows.
 */
function distinctDefects(failing) {
  const byDefect = new Map();
  for (const o of failing) {
    const key = o.principal
      ? `${norm(o.principal)}|${norm(o.role)}|${norm(o.itemType)}`
      : `path:${o.path}`;
    const prev = byDefect.get(key);
    if (prev) prev.items += 1;
    else byDefect.set(key, { items: 1, principal: o.principal, role: o.role, inherited: Boolean(o.inherited), path: o.path });
  }
  return [...byDefect.values()].sort((a, b) => b.items - a.items);
}

/** "2 distinct issue(s) across 88 grant(s)" plus the worst offenders, for a failing row. */
function describeDefects(failing, unit) {
  const defects = distinctDefects(failing);
  const lead = `${defects.length} distinct issue(s) across ${failing.length} ${unit}`;
  const worst = defects.slice(0, 4).map((d) => {
    const who = d.principal || d.path || 'unknown';
    const spread = d.items > 1
      ? ` [${d.items} ${unit}${d.inherited ? ', inherited — one grant' : ''}]`
      : '';
    return `${who}${d.role ? ` "${d.role}"` : ''}${spread}`;
  }).join(', ');
  return worst ? `${lead}: ${worst}` : lead;
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

/**
 * Verdict for one row of the shared-link matrix (features 5.2–5.15).
 *
 * @param {boolean} anonymousBlocked  the destination is DECLARED to refuse anonymous sharing
 *   (CONTENT_DEST_ANONYMOUS_SHARING=blocked). An "Anyone with link" row cannot then be a defect —
 *   the validator's own check 9b reports it at INFO, and these rows must agree with it. They did
 *   not: one run reported 4 failing checks beside 16 failing features, 7 of which were anonymous
 *   rows that 9b had already excused.
 */
function evalLinkRow(observations, itemType, linkType, role, anonymousBlocked = false) {
  const seen = observations.filter((o) => norm(o.itemType) === itemType
    && norm(o.linkType) === norm(linkType) && norm(o.role) === norm(role));
  const isAnonRow = norm(linkType) === 'anyone';
  const scopeLabel = isAnonRow ? 'Anyone with link' : 'organization';
  if (seen.length === 0) {
    return na(`No ${itemType} had an "${scopeLabel} — ${ROLE_LABEL[norm(role)] || role}" link in the source — not exercised`);
  }
  const bad = seen.filter((o) => !o.match);
  if (bad.length === 0) return pass(`${seen.length} link(s) — scope and access level both preserved`);
  if (isAnonRow && anonymousBlocked) {
    return info(`${bad.length}/${seen.length} anonymous link(s) absent — the destination site does not `
      + 'permit anonymous sharing, so they cannot be recreated (combination document #13 External '
      + 'Shares). Reported, never failed. Organization-scope rows below are still validated.');
  }
  return fail(`${bad.length}/${seen.length} link(s) wrong: ${bad.slice(0, 5).map((o) => o.path).join(', ')}`);
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
  //
  // "Did the migration deliver the source?" — which is only about items that FAILED TO ARRIVE.
  // Extra items at the destination are reported by 3.1 (structure) instead: an extra folder is
  // either leftover data from a previous run or a rename artefact, and neither means the migration
  // dropped anything. Counting extras here made 1.1 restate 3.1 word for word and fail a delivery
  // that was actually complete.
  const deliveryNote = extra.length > 0
    ? ` (${extra.length} unexpected item(s) at the destination — see structure)`
    : '';
  verdicts['1.1'] = isDelta
    ? na('This run was a delta migration')
    : (missing.length === 0 && misplaced.length === 0
      ? pass(`All ${scanned} source item(s) arrived${deliveryNote}`)
      : fail(`${missing.length} source item(s) did not arrive`
        + `${misplaced.length ? `, ${misplaced.length} arrived in the wrong place` : ''}`
        + `: ${missing.slice(0, 5).map((m) => m.path || m).join(', ')}`));
  verdicts['1.2'] = isDelta
    ? (missing.length === 0 && misplaced.length === 0
      ? pass(`Incremental changes migrated and verified${deliveryNote}`)
      : fail(`${missing.length} changed item(s) did not arrive`
        + `${misplaced.length ? `, ${misplaced.length} arrived in the wrong place` : ''}`))
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
    : fail(`${d.pairedCount || 0}/${scanned} paired; ${missing.length} missing, `
      + `${extra.length} extra, ${misplaced.length} misplaced`
      + `${extra.length ? `. Extra: ${extra.slice(0, 4).map((x) => x.path || x).join(', ')}` : ''}`);

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
        : fail(`${describeDefects(permBad, 'grant(s)')} of ${permObs.length} checked${describeCoverage(permObs)}`));
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
    // Excused anonymous rows are excluded from the aggregate too, or 5.1 contradicts 5.2-5.15.
    const anonBlocked = Boolean(d.anonymousBlocked);
    const isAnon = (o) => norm(o.linkType) === 'anyone';
    const anonExcused = anonBlocked ? linkObs.filter((o) => !o.match && isAnon(o)).length : 0;
    const linkBad = linkObs.filter((o) => !o.match && !(anonBlocked && isAnon(o)));
    const excusedNote = anonExcused ? ` (${anonExcused} anonymous link(s) not applicable — see 5.2)` : '';
    verdicts['5.1'] = linkObs.length === 0
      ? na('No shared links in the source — not exercised')
      : (linkBad.length === 0
        ? pass(`${linkObs.length - anonExcused} link(s) migrated to the equivalent SharePoint configuration${excusedNote}`)
        : fail(`${linkBad.length}/${linkObs.length - anonExcused} link(s) wrong${excusedNote}`));
    // 5.2–5.9 folders, 5.10–5.15 files
    verdicts['5.2'] = evalLinkRow(linkObs, 'folder', 'anyone', 'reader', anonBlocked);
    verdicts['5.3'] = evalLinkRow(linkObs, 'folder', 'anyone', 'commenter', anonBlocked);
    verdicts['5.4'] = evalLinkRow(linkObs, 'folder', 'anyone', 'writer', anonBlocked);
    verdicts['5.5'] = evalLinkRow(linkObs, 'folder', 'anyone', 'fileOrganizer', anonBlocked);
    verdicts['5.6'] = evalLinkRow(linkObs, 'folder', 'domain', 'reader');
    verdicts['5.7'] = evalLinkRow(linkObs, 'folder', 'domain', 'commenter');
    verdicts['5.8'] = evalLinkRow(linkObs, 'folder', 'domain', 'writer');
    verdicts['5.9'] = evalLinkRow(linkObs, 'folder', 'domain', 'fileOrganizer');
    verdicts['5.10'] = evalLinkRow(linkObs, 'file', 'anyone', 'reader', anonBlocked);
    verdicts['5.11'] = evalLinkRow(linkObs, 'file', 'anyone', 'commenter', anonBlocked);
    verdicts['5.12'] = evalLinkRow(linkObs, 'file', 'anyone', 'writer', anonBlocked);
    verdicts['5.13'] = evalLinkRow(linkObs, 'file', 'domain', 'reader');
    verdicts['5.14'] = evalLinkRow(linkObs, 'file', 'domain', 'commenter');
    verdicts['5.15'] = evalLinkRow(linkObs, 'file', 'domain', 'writer');
  }

  // CloudFuze generates these CSVs on its own server. No API for retrieving them is wired up in this
  // repo, so they are honestly reported as not assessed with the manual step, rather than assumed.
  // 5.16 / 6.2 are MEASURED now. They were declared "no API for the CSV" — there is no special
  // API, the reports are ordinary files in the destination library root and read like any other
  // file. Found live: a shared-links report with 3,183 rows, and an embedded-links report at 0 bytes.
  const csv = d.csvReports || {};
  // Row count alone does not make the report usable: without the destination path and link on the
  // same row a customer cannot answer "what was shared, and where did it end up?". Columns are
  // checked against the reference exports the team works to.
  const sharedMissing = (csv.sharedLinks && csv.sharedLinks.missingColumns) || [];
  verdicts['5.16'] = csv.sharedLinks
    ? (csv.sharedLinks.rows === 0
      ? fail(`"${csv.sharedLinks.name}" was generated but holds no rows, so nothing shared was `
        + 'reported to the customer')
      : (sharedMissing.length > 0
        ? fail(`"${csv.sharedLinks.name}" lists ${csv.sharedLinks.rows} row(s) but is missing `
          + `required column(s): ${sharedMissing.join(', ')} — the report cannot be used to trace `
          + 'what was shared')
        : pass(`"${csv.sharedLinks.name}" lists ${csv.sharedLinks.rows} shared item(s), with a `
          + 'source and a destination link on each row')))
    : na('Shared Links CSV not found in the destination library root — nothing to check. Manual: '
      + 'download it from the migration job and confirm it lists every shared source item');
  verdicts['6.2'] = csv.embeddedLinks
    ? (csv.embeddedLinks.rows > 0
      ? pass(`"${csv.embeddedLinks.name}" lists ${csv.embeddedLinks.rows} document(s) containing `
        + 'embedded links')
      : info(`"${csv.embeddedLinks.name}" was generated but is empty. Correct only if no source `
        + 'document linked to another file; when one does (feature 6.1) an empty report means the '
        + 'scan recorded nothing'))
    : na('Embedded Links CSV not found in the destination library root — nothing to check');

  // ── 6.1 Embedded links inside documents.
  //
  // MEASURED now. This read "not implemented — needs an archive library", but a .docx is a ZIP and
  // DEFLATE ships with Node, so utils/docxLinks reads the hyperlink targets straight out of
  // word/_rels/document.xml.rels. Judged on those targets, never the visible text: the seeded
  // document prints its original Drive URL as readable text on purpose, and matching the body would
  // fail every correct migration.
  const staleLinks = d.embeddedLinkStale || [];
  const linkTargets = d.embeddedLinkTargets || null;
  verdicts['6.1'] = !d.embeddedLinkDoc
    ? na('Not exercised — no document with an embedded link was seeded, so nothing tests whether '
      + 'links inside documents are rewritten')
    : (staleLinks.length > 0
      ? fail(`${staleLinks.length} link(s) inside the migrated document still point at Google: `
        + `${staleLinks.slice(0, 3).join(' | ')}. The document arrived but the link inside it was `
        + 'not rewritten, so a reader is sent back to the source system')
      : (linkTargets && linkTargets.length > 0
        ? pass(`${linkTargets.length} link(s) inside the migrated document were rewritten away from `
          + 'Google to the destination')
        : (linkTargets
          ? fail('The migrated document holds no external hyperlink at all, but the source document '
            + 'links to another file — the link was dropped in migration')
          : na(`Not proven — ${d.embeddedLinkDoc.destPath} could not be downloaded or parsed, so its `
            + 'links were never observed'))));

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
    // Two different reasons, and they must not read alike: the switch was off, or the switch was on
    // but the mailbox could not be read. Both are 'na' — never a pass — because no mail was seen.
    const detail = d.notificationsNotRequested
      ? 'Not exercised — this migration did not request email suppression, so SharePoint sharing '
        + 'notifications are the documented outcome and cannot show whether suppression works. '
        + 'Re-run with suppression enabled in the job to test it'
      : d.notificationsUnavailable
      ? `Not proven — the destination mailbox could not be read (${d.notificationsUnavailable}). `
        + 'Manual: confirm the destination user received no SharePoint sharing or invitation mail'
      : 'Not checked (CONTENT_DEEP_VALIDATE_NOTIFICATIONS=false). Manual: confirm the destination '
        + 'user received no SharePoint sharing or invitation mail';
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
  // The placeholder existing is only half the feature. The content it points at was RELOCATED to
  // a shorter path, and if its shared link did not travel the placeholder opens something nobody
  // can reach — the reported symptom "the long folder does not open by link". This row used to
  // pass on the placeholder alone, so it announced "handled as documented" in the same report
  // where check 11b said FAIL.
  const relocLost = d.relocatedSharingLost || [];
  const relocOrgLost = relocLost.filter((r) => r.orgLost);
  verdicts['11.1'] = placeholders.length === 0
    ? na('No source path exceeded the SharePoint limit — not exercised')
    : (relocOrgLost.length > 0
      ? fail(`${placeholders.length} over-limit item(s) became placeholder links as documented, but `
        + `the relocated content lost its shared link: `
        + `${relocOrgLost.slice(0, 4).map((r) => `${r.name} (source had ${r.had.join('+')}, destination has ${r.got})`).join(' | ')}`
        + '. An organization link cannot be refused by the destination, so the placeholder now '
        + 'points at content that cannot be opened by link')
      : (relocLost.length > 0
        ? info(`${placeholders.length} over-limit item(s) handled as placeholder links, as documented. `
          + `The relocated copy carries no link (${relocLost.slice(0, 3).map((r) => r.name).join(', ')}); `
          + 'the source link was anonymous, which the destination may refuse, so this is reported '
          + 'rather than failed')
        : pass(`${placeholders.length} over-limit item(s) handled as placeholder links, as documented`)));

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
