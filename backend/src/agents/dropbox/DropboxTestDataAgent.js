/**
 * Seeds Dropbox source data for the Dropbox → Google combinations.
 *
 * Every item here traces to a numbered row in
 * `backend/data/feature-scope/dropbox-to-google-testdata.md`, which was derived from the QA team's
 * own 5,905 Xray cases. The row number is on each `_seed*` method, so a reader can tell which QA
 * cases stop being exercised if a piece is removed.
 *
 * Scope reference: `backend/data/feature-scope/dropbox-to-google-inscope.md` (36 features).
 *
 * Three deliberate non-features, stated up front because each would otherwise look like an omission:
 *
 *   - **Dropbox Paper (scope 10.1–10.19, 19 of the 36 features) is NOT seeded.** Dropbox retired the
 *     Paper authoring API; the remaining endpoints are export-only, and uploading a file with a
 *     `.paper` extension produces an ordinary file, not a Paper document. So the 19 Paper features
 *     cannot be seeded programmatically at all. `_reportPaperManualSteps()` returns the exact manual
 *     steps instead, and the result marks them NOT SEEDED. Reporting them as seeded would be the
 *     worst outcome: 19 features would appear covered while nothing tested them.
 *   - **Delta (scope 1.3, 61% of the QA cases) is a SEPARATE PASS.** `applyDeltaChanges()` mutates
 *     an already-seeded and already-migrated tree. It is not called from `execute()` because a delta
 *     is only meaningful after a one-time migration has completed.
 *   - **Permission grants need real principals.** A grant to an address Dropbox cannot resolve fails,
 *     so grantees come from the run context (or `DROPBOX_TEST_*` env) and are SKIPPED with a warning
 *     when absent. Skipped grants are listed in the result; they never fail the seeding, because a
 *     missing QA account is a configuration gap, not a product defect.
 */
const { BaseAgent } = require('../core/BaseAgent');
const dropboxClient = require('../../clients/dropboxClient');
const logger = require('../../utils/logger');
const env = require('../../config/env');

// ── Sample content ────────────────────────────────────────────────────────────
// Distinct, recognisable bytes per format. Sizes are small on purpose: the comparison checks
// structure, permissions and hashes, and a large payload only slows every run down.

const SAMPLE_TXT = `Dropbox QA — plain text
Seeded by DropboxTestDataAgent for the Dropbox to Google migration QA flow.
This file is a pass-through format: it must arrive at Google byte-for-byte identical.
`;

const SAMPLE_CSV = `ID,Name,Email,Department,Role
1,Ada Lovelace,ada@example.com,Engineering,Editor
2,Alan Turing,alan@example.com,Research,Viewer
3,Grace Hopper,grace@example.com,Engineering,Editor
`;

const SAMPLE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Dropbox QA</title></head>
<body><h1>Dropbox QA</h1><p>Seeded HTML document.</p></body></html>
`;

const SAMPLE_JSON = JSON.stringify(
  { seededBy: 'DropboxTestDataAgent', purpose: 'Dropbox to Google migration QA', version: 1 },
  null,
  2
);

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qa><seededBy>DropboxTestDataAgent</seededBy><format>xml</format></qa>
`;

/** Minimal valid PDF — a real header/trailer, so the destination can open it. */
const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1'
);

/** 1x1 PNG. */
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DAAAMEAQAA//8DAAX+AfUAAAAASUVORK5CYII=',
  'base64'
);

/** 1x1 JPEG. */
const SAMPLE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDX/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
  'base64'
);

/** Legacy Office extension, to exercise the .doc → Google conversion path (scope 1.1 / 10.x). */
const SAMPLE_DOC = Buffer.alloc(2048, 0x41);

/** Bytes for a second and third file version (scope 9.1 / 9.2). */
const VERSION_BODIES = [
  'Dropbox QA — version 1 of 3.\n',
  'Dropbox QA — version 2 of 3. Content changed.\n',
  'Dropbox QA — version 3 of 3. Content changed again, this is the latest.\n',
];

/**
 * Characters Dropbox permits in a name that SharePoint would reject.
 *
 * Scope 5.1 expects **no replacement** on a Google destination — Google accepts these. The name is
 * therefore a negative test: it must arrive unchanged. `\` and `/` are excluded because Dropbox
 * itself rejects them in a path segment, so they cannot be seeded at all.
 */
const SPECIAL_CHARS_NAME = 'Special ~!@#$%^&()_+[]{};,.= chars';

/**
 * Names that are reserved on Windows/SharePoint but ordinary on Google.
 *
 * `desktop.ini` is deliberately absent. Dropbox refuses it outright — `files/upload` returns
 * `path/disallowed_name`, alongside `.dropbox`, `.dropbox.attr` and `icon\r`. It sat in this list
 * and killed the whole seeding run at row 10, so nothing after it was ever created. It is reported
 * through notSeeded for the same reason trailing dots and spaces are: the source cloud cannot hold
 * it, which is a fact about Dropbox rather than a gap in coverage.
 */
const RESERVED_STYLE_NAMES = ['CON', 'PRN', 'AUX', 'NUL'];

/** Names Dropbox itself rejects, so they are documented rather than attempted. */
const DROPBOX_DISALLOWED_NAMES = ['desktop.ini', '.dropbox', '.dropbox.attr'];

class DropboxTestDataAgent extends BaseAgent {
  constructor() {
    super('DropboxTestDataAgent');
  }

  /**
   * Seed the source tree.
   *
   * @param {import('../../models/MigrationContext')} context
   * @returns {Promise<object>} a report of what was created, skipped and left manual
   */
  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });

    if (!dropboxClient.isConfigured()) {
      throw new Error(
        'Dropbox is not configured — cannot seed source data. Set DROPBOX_APP_KEY, '
        + 'DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN in the root .env (see .env.example).'
      );
    }

    const root = dropboxClient.dbxPath(context.sourcePath || env.DROPBOX_TEST_ROOT);
    if (!root) {
      throw new Error(
        'Refusing to seed at the Dropbox account root. Set DROPBOX_TEST_ROOT (or the run\'s source '
        + 'path) to a dedicated folder such as /QA-Automation — seeding at "/" would mix QA data '
        + 'into the whole account and cleanup would then have to delete everything.'
      );
    }

    const asMemberId = await this._resolveMemberContext(context, log);
    const opts = { asMemberId };
    const grantees = this._resolveGrantees(context, log);

    const report = {
      root,
      // AgentOrchestrator gates its whole source-capture block on `rootFolderName`, and inside it
      // reads `rootFolderId` to give CloudFuze a real folder id as fromRootId. Reporting neither —
      // as this agent did — is not a cosmetic omission:
      //   * context.sourceTestDataPath and context.sourceRootId stay unset,
      //   * fromRootId falls back to the PATH string "/QA-Automation",
      //   * CloudFuze scans nothing and the job ends PROCESSED_EMPTY with totalFilesAndFolders=0,
      //   * CleanupAgent logs "no source folder name in context" and skips cleanup.
      // The job still reports success throughout, which is exactly the silent-pass shape this
      // repo exists to catch. Both fields are filled in once the root folder is created.
      rootFolderName: null,
      rootFolderId: null,
      asMemberId: asMemberId || null,
      testType: context.testType || 'E2E',
      created: { folders: 0, files: 0, versions: 0, links: 0, grants: 0 },
      skipped: [],
      notSeeded: [],
      errors: [],
      items: [],
      grantees,
    };

    log.info(`Seeding Dropbox test data under ${root} (testType=${report.testType})`);

    if (context.skipCleanup !== true) {
      await this._wipeRoot(root, opts, log, report);
    }
    const rootItem = await this._mk(root, opts, report);
    // Dropbox ids look like "id:AbC…" and are what CloudFuze needs as fromRootId. The name is the
    // last path segment, matching how Box and Drive report theirs (a bare name, no leading slash).
    // Report the LOWER-CASE path, which is what CloudFuze resolves. Dropbox paths are
    // case-insensitive and it returns both forms; the path CSV is matched against `path_lower`, so
    // "/QA-Automation" comes back "Migration not Allowed for wrong CSV paths" (CONFLICT,
    // totalFilesAndFolders=0) while "/qa-automation" is accepted. Measured 2026-09-02 over 7
    // rejected jobs plus one accepted; the only run that ever got past it before used "/", which
    // has no letters to mis-case. Prefer Dropbox's own value over lower-casing ourselves.
    const rootPath = (rootItem && rootItem.pathLower) || root.toLowerCase();
    report.rootFolderName = rootPath.replace(/^\/+/, '');
    report.rootFolderId = (rootItem && rootItem.id) || null;
    if (!report.rootFolderId) {
      log.warn(
        `Dropbox root ${root} reported no folder id — CloudFuze will fall back to the path string `
        + 'as fromRootId, which scans nothing and ends the job PROCESSED_EMPTY.'
      );
    }

    // Row 1–4, 6: the permission ladder — root folder, root file, sub-folders, inner files.
    await this._seedPermissionLadder(root, opts, grantees, log, report);

    // Row 2: root files in every pass-through format.
    await this._seedRootFiles(root, opts, log, report);

    // Row 7–8: shared links, both audiences, both access levels.
    await this._seedSharedLinks(root, opts, log, report);

    // Row 9: distinct created/modified timestamps.
    await this._seedTimestampFiles(root, opts, log, report);

    // Row 10: names Google accepts unchanged.
    await this._seedSpecialCharacterNames(root, opts, log, report);

    // Row 11: the long-path breaking point.
    await this._seedLongPath(root, opts, log, report);

    // Row 12: embedded links, one in scope and one out.
    await this._seedEmbeddedLinks(root, opts, log, report);

    // Row 13–14: version history.
    await this._seedVersions(root, opts, log, report);

    // Row 15: Paper — cannot be seeded; return the manual steps.
    report.notSeeded.push(this._reportPaperManualSteps());

    // Row 16: the user-mapping CSV is a MIGRATION input, not source data — noted, not created here.
    report.notSeeded.push({
      feature: 'user-mapping CSV (test-data row 16, 4,832 QA cases)',
      reason:
        'The mapping CSV is an input to the CloudFuze job, not data inside Dropbox. It is built by '
        + 'the migration step from the run\'s user mappings, so there is nothing to seed in the source.',
      manualSteps: [],
    });

    report.summary = this._summarize(report);
    log.info(report.summary);
    return report;
  }

  /**
   * Resolve the Dropbox team member whose Dropbox we seed.
   *
   * A Business admin token with no member selected writes into the ADMIN's own Dropbox. That
   * succeeds, reports success, and seeds the wrong account — so when the source email names a team
   * member, select them explicitly and say so in the log.
   */
  async _resolveMemberContext(context, log) {
    const email = String(context.sourceEmail || '').trim().toLowerCase();
    if (!email) return null;
    try {
      const memberId = await dropboxClient.resolveTeamMemberId(email);
      if (memberId) {
        log.info(`Dropbox team member resolved for ${email}`);
        return memberId;
      }
      log.warn(
        `${email} is not a Dropbox team member — seeding against the token's own Dropbox. `
        + 'If this is a Business team, that is probably the admin account, not the intended source.'
      );
      return null;
    } catch (err) {
      // A personal Dropbox app has no team endpoints; that is expected, not an error.
      log.warn(`Dropbox team lookup unavailable (${err.message}) — using the token's own Dropbox`);
      return null;
    }
  }

  /**
   * Who the seeded grants go to.
   *
   * Internal + external + group, per test-data rows 5 and 6. Sourced from the run's user mappings
   * first (those are real accounts the run already knows about), then env overrides.
   */
  _resolveGrantees(context, log) {
    const mapped = (context.userEmailMappings || [])
      .map((m) => String(m.destinationEmail || m.sourceEmail || '').toLowerCase())
      .filter(Boolean);

    const internal = (env.DROPBOX_TEST_INTERNAL_USER || mapped[0] || '').toLowerCase();
    const external = (env.DROPBOX_TEST_EXTERNAL_USER || '').toLowerCase();
    const group = env.DROPBOX_TEST_GROUP || '';

    if (!internal) {
      log.warn(
        'No internal grantee available — every user permission (scope 2.1–2.4) will be SKIPPED. '
        + 'Set DROPBOX_TEST_INTERNAL_USER to a second account in the Dropbox team.'
      );
    }
    if (!external) {
      log.warn('No DROPBOX_TEST_EXTERNAL_USER — external shares (scope 2.5) will be SKIPPED.');
    }
    if (!group) {
      log.warn('No DROPBOX_TEST_GROUP — group grants (scope 2.1–2.4, 3,866 QA cases) will be SKIPPED.');
    }
    return { internal, external, group };
  }

  /** Delete the seeding root so a re-run starts clean. Scoped to that one path, never the account. */
  async _wipeRoot(root, opts, log, report) {
    try {
      await dropboxClient.deletePath(root, opts);
      log.info(`Cleared existing ${root}`);
    } catch (err) {
      // Non-fatal: an absent root is the normal first-run case.
      log.warn(`Could not clear ${root} (continuing): ${err.message}`);
      report.errors.push({ step: 'wipe', error: err.message });
    }
  }

  /** Create a folder and count it. */
  async _mk(path, opts, report) {
    const item = await dropboxClient.createFolder(path, opts);
    report.created.folders += 1;
    report.items.push({ type: 'folder', path });
    return item;
  }

  /** Upload a file and count it. */
  async _put(path, body, opts, report, extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const item = await dropboxClient.uploadFile(path, buf, { ...opts, ...extra });
    report.created.files += 1;
    report.items.push({ type: 'file', path, bytes: buf.length });
    return item;
  }

  /**
   * Grant access, tolerating a principal Dropbox cannot resolve.
   *
   * A failed grant is recorded and the seeding continues: one unresolvable QA address must not cost
   * the whole run, and the report has to distinguish "not granted" from "granted and lost in
   * migration" — which is exactly what the validator will later be asked to judge.
   */
  async _grant(item, member, role, opts, report, label) {
    if (!member || (!member.email && !member.groupId)) {
      report.skipped.push({ step: label, reason: 'no principal configured' });
      return false;
    }
    try {
      if (item.type === 'folder') {
        const sharedFolderId = await dropboxClient.shareFolder(item.path, opts);
        if (!sharedFolderId) throw new Error('folder could not be shared');
        await dropboxClient.addFolderMember(sharedFolderId, member, role, opts);
      } else {
        await dropboxClient.addFileMember(item.id || item.path, member, role, opts);
      }
      report.created.grants += 1;
      return true;
    } catch (err) {
      // Two failures here are the ACCOUNT's rules, not a defect, and both were measured rather
      // than assumed:
      //
      //   access_error/no_permission on a FILE + editor — this team allows editor on a folder
      //     member but refuses it on a file member; viewer on the same file succeeds.
      //   cant_share_outside_team — the team policy "share folders outside the team" is off.
      //
      // Reporting these as errors makes a healthy run look broken every time and, worse, says
      // nothing about the scope being untestable. They are recorded as NOT SEEDED so the validator
      // cannot later mark the feature as passing on evidence that was never created.
      const summary = String(err.dropboxSummary || err.message || '');
      const fileEditorBlocked = /no_permission/.test(summary) && item.type !== 'folder' && role === 'editor';
      const outsideTeamBlocked = /cant_share_outside_team/.test(summary);
      if (fileEditorBlocked || outsideTeamBlocked) {
        report.notSeeded.push({
          feature: label,
          reason: fileEditorBlocked
            ? 'This Dropbox account refuses editor access on an individual file '
              + '(sharing/add_file_member → access_error/no_permission), while viewer on the same '
              + 'file and editor on a folder both succeed. A source-account limit, not a migration '
              + 'defect — the editing half of this position cannot be exercised here.'
            : 'Dropbox returned cant_share_outside_team for this grant. NOTE: this is NOT the team-wide '
              + 'admin toggle — that was checked on 03-Sep-2026 and external sharing is fully enabled '
              + '("External sharing: Email and link"), and the shared folder itself reports member_policy '
              + '"anyone". The likely cause is the INVITEE: DROPBOX_TEST_EXTERNAL_USER is an address in '
              + 'another managed Dropbox team (cloudfuze.com), and a team-to-team invite can be refused by '
              + 'either team policy — including one we do not administer. Try an address attached to no '
              + 'Dropbox team at all before concluding scope 2.5 is untestable.',
          manualSteps: [],
        });
        logger.warn(`[dropbox-seed] ${label} unavailable on this account — reported as not seeded`);
        return false;
      }
      report.errors.push({ step: label, error: err.message });
      logger.warn(`[dropbox-seed] ${label} failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Test-data rows 1–4 and 6 — the permission ladder.
   *
   * Position is the point. The QA suite checks the same grant at root folder, root file, sub-folder
   * and inner file (1,656 / 737 / 3,568 / 1,136 cases) because a run that only proves the root
   * proves nothing about inheritance. Each position therefore gets its OWN explicit grant, at both
   * access levels, to both a user and a group.
   */
  async _seedPermissionLadder(root, opts, grantees, log, report) {
    const userMember = grantees.internal ? { email: grantees.internal } : null;
    const groupMember = await this._resolveGroupMember(grantees.group, log, report);
    const externalMember = grantees.external ? { email: grantees.external } : null;

    // Row 1 — root-level shared folder ("team folder" shape), user + group.
    const rootFolder = await this._mk(`${root}/01-Root-Folder-Permissions`, opts, report);
    await this._grant(rootFolder, userMember, 'editor', opts, report, 'root folder → user editor');
    await this._grant(rootFolder, groupMember, 'viewer', opts, report, 'root folder → group viewer');

    // Row 2 — root file, both levels.
    const rootFileEdit = await this._put(`${root}/02-root-file-editor.txt`, SAMPLE_TXT, opts, report);
    await this._grant(rootFileEdit, userMember, 'editor', opts, report, 'root file → user editor');
    const rootFileView = await this._put(`${root}/02-root-file-viewer.txt`, SAMPLE_TXT, opts, report);
    await this._grant(rootFileView, userMember, 'viewer', opts, report, 'root file → user viewer');
    await this._grant(rootFileView, groupMember, 'viewer', opts, report, 'root file → group viewer');

    // Row 3 — sub-folders at TWO depths, each with its own grant.
    const sub1 = await this._mk(`${root}/01-Root-Folder-Permissions/Sub-Level-1`, opts, report);
    await this._grant(sub1, userMember, 'viewer', opts, report, 'sub-folder L1 → user viewer');
    const sub2 = await this._mk(
      `${root}/01-Root-Folder-Permissions/Sub-Level-1/Sub-Level-2`, opts, report
    );
    await this._grant(sub2, groupMember, 'editor', opts, report, 'sub-folder L2 → group editor');

    // Row 4 — inner files inside those sub-folders, with their own grants.
    const inner1 = await this._put(
      `${root}/01-Root-Folder-Permissions/Sub-Level-1/inner-file-editor.txt`,
      SAMPLE_TXT, opts, report
    );
    await this._grant(inner1, userMember, 'editor', opts, report, 'inner file L1 → user editor');
    const inner2 = await this._put(
      `${root}/01-Root-Folder-Permissions/Sub-Level-1/Sub-Level-2/inner-file-viewer.csv`,
      SAMPLE_CSV, opts, report
    );
    await this._grant(inner2, userMember, 'viewer', opts, report, 'inner file L2 → user viewer');
    await this._grant(inner2, groupMember, 'viewer', opts, report, 'inner file L2 → group viewer');

    // Row 5 — external share (scope 2.5).
    const extFolder = await this._mk(`${root}/05-External-Shares`, opts, report);
    const extFile = await this._put(`${root}/05-External-Shares/shared-outside.txt`, SAMPLE_TXT, opts, report);
    if (externalMember) {
      await this._grant(extFolder, externalMember, 'viewer', opts, report, 'external → folder viewer');
      await this._grant(extFile, externalMember, 'editor', opts, report, 'external → file editor');
    } else {
      report.skipped.push({
        step: 'external shares (scope 2.5, 616 QA cases)',
        reason: 'DROPBOX_TEST_EXTERNAL_USER not set — needs an address outside the Dropbox team',
      });
    }
  }

  /**
   * Turn a configured group NAME into the selector Dropbox wants.
   *
   * Dropbox addresses a group by `group_id`, not by name, so the name has to be looked up. A name
   * that does not exist is reported rather than invented — creating a group as a side effect of
   * seeding would change team configuration nobody asked to change.
   */
  async _resolveGroupMember(groupName, log, report) {
    if (!groupName) return null;
    try {
      const groups = await dropboxClient.listTeamGroups();
      const want = String(groupName).toLowerCase().trim();
      const hit = groups.find((g) => String(g.name).toLowerCase().trim() === want);
      if (!hit) {
        report.skipped.push({
          step: 'group grants (scope 2.1–2.4, 3,866 QA cases)',
          reason: `Dropbox team has no group named "${groupName}". Available: `
            + (groups.map((g) => g.name).join(', ') || '(none)'),
        });
        log.warn(`Dropbox group "${groupName}" not found — group grants will be skipped`);
        return null;
      }
      return { groupId: hit.groupId, displayName: hit.name };
    } catch (err) {
      report.skipped.push({ step: 'group grants', reason: `group lookup failed: ${err.message}` });
      return null;
    }
  }

  /** Root files across the pass-through formats, so structure and Tier B hashing have material. */
  async _seedRootFiles(root, opts, log, report) {
    const dir = `${root}/03-File-Formats`;
    await this._mk(dir, opts, report);
    await this._put(`${dir}/document.txt`, SAMPLE_TXT, opts, report);
    await this._put(`${dir}/data.csv`, SAMPLE_CSV, opts, report);
    await this._put(`${dir}/page.html`, SAMPLE_HTML, opts, report);
    await this._put(`${dir}/config.json`, SAMPLE_JSON, opts, report);
    await this._put(`${dir}/feed.xml`, SAMPLE_XML, opts, report);
    await this._put(`${dir}/report.pdf`, SAMPLE_PDF, opts, report);
    await this._put(`${dir}/pixel.png`, SAMPLE_PNG, opts, report);
    await this._put(`${dir}/photo.jpg`, SAMPLE_JPEG, opts, report);
    // Legacy Office: Google converts on import, so this file exercises the conversion path rather
    // than byte equality. The validator must not hash it.
    await this._put(`${dir}/legacy.doc`, SAMPLE_DOC, opts, report);
    log.info('Seeded file formats');
  }

  /**
   * Test-data rows 7–8 — shared links, both audiences and both access levels.
   *
   * Four links, because scope 3.1 and 3.2 each specify a viewing AND an editing variant, and the
   * role map asserts both axes (who the link reaches, and what they can do). Three of the four would
   * pass a scope-only check while carrying the wrong access level.
   */
  async _seedSharedLinks(root, opts, log, report) {
    const dir = `${root}/04-Shared-Links`;
    await this._mk(dir, opts, report);

    const targets = [
      { file: 'anyone-view.txt', audience: 'public', access: 'viewer', scope: '3.1' },
      { file: 'anyone-edit.txt', audience: 'public', access: 'editor', scope: '3.1' },
      { file: 'team-view.txt', audience: 'team', access: 'viewer', scope: '3.2' },
      { file: 'team-edit.txt', audience: 'team', access: 'editor', scope: '3.2' },
    ];

    for (const t of targets) {
      const path = `${dir}/${t.file}`;
      await this._put(path, `${SAMPLE_TXT}Link audience: ${t.audience}, access: ${t.access}\n`, opts, report);
      try {
        const link = await dropboxClient.createSharedLink(path, { ...opts, audience: t.audience, access: t.access });
        if (link) {
          report.created.links += 1;
          report.items.push({ type: 'link', path, audience: t.audience, access: t.access, url: link.url });
        }
      } catch (err) {
        // `settings_error/invalid_settings` on an EDITOR link is the account refusing edit links at
        // all, not a bad request: measured on this team, viewer links succeed on both files and
        // folders while editor links fail on both. That is a limit of the source account, so it is
        // reported as NOT SEEDED — the same treatment as Paper and Dropbox-disallowed names.
        // Recording it as an error instead would leave the run looking broken every single time,
        // and would say nothing about the feature being untestable here.
        if (t.access === 'editor' && /invalid_settings/.test(String(err.dropboxSummary || err.message))) {
          report.notSeeded.push({
            feature: `shared link ${t.audience}/editor (scope ${t.scope})`,
            reason:
              'This Dropbox account does not permit edit links — sharing/create_shared_link_with_settings '
              + 'rejects access:"editor" with settings_error/invalid_settings on both files and folders, '
              + 'while viewer links succeed. The editing half of this scope cannot be exercised from '
              + 'this source account, so it must not be reported as a pass.',
            manualSteps: [],
          });
          log.warn(`Shared link ${t.audience}/editor unavailable on this account — reported as not seeded`);
          continue;
        }
        // A team-audience link needs a Business account; on a personal Dropbox it is unavailable.
        report.errors.push({ step: `shared link ${t.audience}/${t.access} (scope ${t.scope})`, error: err.message });
        log.warn(`Shared link ${t.audience}/${t.access} failed: ${err.message}`);
      }
    }
  }

  /**
   * Test-data row 9 — distinct created and modified timestamps (scope 4.1).
   *
   * Dropbox exposes no creation time through the API, so only `client_modified` can be steered. The
   * dates are set well in the past and far apart, so a destination that stamped "now" instead of
   * preserving the original is unmistakable rather than within a tolerance band.
   */
  async _seedTimestampFiles(root, opts, log, report) {
    const dir = `${root}/06-Metadata-Timestamps`;
    await this._mk(dir, opts, report);
    const dates = ['2021-03-04T09:15:00Z', '2022-07-19T14:40:00Z', '2023-11-28T21:05:00Z'];
    for (let i = 0; i < dates.length; i++) {
      await this._put(
        `${dir}/timestamped-${i + 1}.txt`,
        `${SAMPLE_TXT}Intended client_modified: ${dates[i]}\n`,
        opts, report,
        { clientModified: dates[i] }
      );
    }
    report.notSeeded.push({
      feature: 'creation timestamp (scope 4.1, partial)',
      reason:
        'Dropbox exposes no creation time on file metadata — only server_modified and '
        + 'client_modified exist. The created-date half of feature 4.1 therefore has no source value '
        + 'to compare against and must be reported as not comparable, not as a mismatch.',
      manualSteps: [],
    });
    log.info('Seeded timestamp files');
  }

  /**
   * Test-data row 10 — names Google accepts unchanged (scope 5.1).
   *
   * This is a NEGATIVE test. The expected result is no replacement at all: Google accepts these
   * characters and these names. It exists to catch a validator that wrongly applies SharePoint's
   * rules here — the mistake that produced the four-way failure recorded in the scope document.
   */
  async _seedSpecialCharacterNames(root, opts, log, report) {
    const dir = `${root}/07-Special-Characters`;
    await this._mk(dir, opts, report);
    const special = `${dir}/${SPECIAL_CHARS_NAME}`;
    await this._mk(special, opts, report);
    await this._put(`${special}/${SPECIAL_CHARS_NAME}.txt`, SAMPLE_TXT, opts, report);
    for (const name of RESERVED_STYLE_NAMES) {
      await this._put(`${dir}/${name}`, `${SAMPLE_TXT}Reserved-on-Windows name: ${name}\n`, opts, report);
    }
    // Trailing dot/space are the two Dropbox itself rejects, so they are documented, not attempted.
    report.notSeeded.push({
      feature: 'trailing dot / trailing space names (scope 5.1, edge)',
      reason:
        'Dropbox rejects a path segment with a trailing dot or space, so these cannot be seeded from '
        + 'the source side at all. Not a gap in coverage — the source cloud cannot hold them.',
      manualSteps: [],
    });
    report.notSeeded.push({
      feature: `Dropbox-disallowed names (scope 5.1, edge): ${DROPBOX_DISALLOWED_NAMES.join(', ')}`,
      reason:
        'Dropbox refuses these names on upload with path/disallowed_name, so they cannot exist in '
        + 'the source at all. Same reasoning as trailing dots and spaces — a limit of the source '
        + 'cloud, not missing coverage.',
      manualSteps: [],
    });
    log.info('Seeded special-character and reserved-style names');
  }

  /**
   * Test-data row 11 — the long-path "breaking point" (scope 7.1).
   *
   * 144 QA cases put items either side of a breaking point, while
   * `validation/destinations/googledrive.js` declares `pathLengthLimit: Infinity`. The test-data
   * document flags that contradiction as unresolved, so this seeds a path long enough to cross any
   * plausible limit (well past SharePoint's 400) with items on BOTH sides of it. That way the run
   * produces the evidence either way instead of assuming an answer.
   *
   * Dropbox's own ceiling is far higher than Google's documented one, so the deep chain is what
   * makes the question answerable at all.
   */
  async _seedLongPath(root, opts, log, report) {
    const dir = `${root}/08-Long-Paths`;
    await this._mk(dir, opts, report);

    // A file just inside a short path — the control.
    await this._put(`${dir}/short-path-control.txt`, SAMPLE_TXT, opts, report);

    // A deep chain. 20 levels matches DriveTestDataAgent's depth so the tolerance treeDepth (25)
    // still covers it; each segment is padded so the total encoded path passes 400 characters.
    const segment = 'Level-with-a-deliberately-long-name-to-grow-the-path';
    let path = dir;
    const LEVELS = 20;
    for (let i = 1; i <= LEVELS; i++) {
      path = `${path}/${segment}-${String(i).padStart(2, '0')}`;
      await this._mk(path, opts, report);
      // A file at a few checkpoints, so the report can say exactly where behaviour changed rather
      // than only that the deepest item is missing.
      if (i === 5 || i === 10 || i === 15 || i === LEVELS) {
        await this._put(`${path}/checkpoint-depth-${i}.txt`, `${SAMPLE_TXT}Depth: ${i}\n`, opts, report);
      }
    }
    report.longestSeededPath = `${path}/checkpoint-depth-${LEVELS}.txt`;
    report.longestSeededPathLength = report.longestSeededPath.length;
    log.info(`Seeded long path, deepest ${report.longestSeededPathLength} chars`);
  }

  /**
   * Test-data row 12 — embedded links (scope 8.1 and 10.8).
   *
   * Two links in one document: one to a file that IS in the migration scope, one to a file that is
   * not. Scope 10.8 says transformation happens only for in-scope targets, so a document with only
   * an in-scope link cannot distinguish "transformed correctly" from "transformed everything".
   *
   * The out-of-scope target is seeded OUTSIDE the seeding root deliberately.
   */
  async _seedEmbeddedLinks(root, opts, log, report) {
    const dir = `${root}/09-Embedded-Links`;
    await this._mk(dir, opts, report);

    const inScopePath = `${dir}/link-target-in-scope.txt`;
    await this._put(inScopePath, `${SAMPLE_TXT}I am the IN-SCOPE link target.\n`, opts, report);

    let inScopeUrl = '';
    let outOfScopeUrl = '';
    try {
      inScopeUrl = (await dropboxClient.createSharedLink(inScopePath, { ...opts, audience: 'public', access: 'viewer' }))?.url || '';
    } catch (err) {
      report.errors.push({ step: 'embedded link (in-scope target link)', error: err.message });
    }

    // Out-of-scope sibling: alongside the seeding root, so a migration of `root` cannot include it.
    const outsideDir = `${dropboxClient.dbxPath(root).replace(/\/[^/]+$/, '')}/QA-Out-Of-Scope`;
    try {
      await dropboxClient.createFolder(outsideDir, opts);
      const outPath = `${outsideDir}/link-target-out-of-scope.txt`;
      await dropboxClient.uploadFile(outPath, Buffer.from(`${SAMPLE_TXT}I am OUT OF SCOPE.\n`), opts);
      outOfScopeUrl = (await dropboxClient.createSharedLink(outPath, { ...opts, audience: 'public', access: 'viewer' }))?.url || '';
      report.items.push({ type: 'file', path: outPath, outOfScope: true });
    } catch (err) {
      report.errors.push({ step: 'embedded link (out-of-scope target)', error: err.message });
    }

    const body = `${SAMPLE_HTML.replace('</body>', '')}
<h2>Embedded links</h2>
<p>In scope: <a href="${inScopeUrl || 'https://www.dropbox.com/IN_SCOPE_LINK_UNAVAILABLE'}">in-scope target</a></p>
<p>Out of scope: <a href="${outOfScopeUrl || 'https://www.dropbox.com/OUT_OF_SCOPE_LINK_UNAVAILABLE'}">out-of-scope target</a></p>
</body></html>
`;
    await this._put(`${dir}/document-with-embedded-links.html`, body, opts, report);
    report.embeddedLinks = { inScopeUrl, outOfScopeUrl };
    log.info('Seeded embedded-link document');
  }

  /**
   * Test-data rows 13–14 — version history (scope 9.1) and selective versions (9.2).
   *
   * Each overwrite of the same path adds a Dropbox revision, so three uploads produce three
   * revisions. Scope 9.2 notes the expected destination count is a JOB SETTING, not a constant, so
   * the seeded count is reported here and the validator compares against what the job requested
   * rather than against a fixed number.
   */
  async _seedVersions(root, opts, log, report) {
    const dir = `${root}/10-Versions`;
    await this._mk(dir, opts, report);

    for (const name of ['versioned-a.txt', 'versioned-b.txt']) {
      const path = `${dir}/${name}`;
      for (let v = 0; v < VERSION_BODIES.length; v++) {
        // 'overwrite' on an existing path is what creates the new revision.
        await dropboxClient.uploadFile(path, Buffer.from(VERSION_BODIES[v]), { ...opts, mode: 'overwrite' });
        report.created.versions += 1;
      }
      report.created.files += 1;
      report.items.push({ type: 'file', path, versions: VERSION_BODIES.length });
    }

    // Confirm Dropbox actually recorded the revisions — an upload that silently deduplicated would
    // otherwise leave the versions features looking seeded when they are not.
    try {
      const revs = await dropboxClient.listRevisions(`${dir}/versioned-a.txt`, opts);
      report.seededVersionCount = revs.length;
      if (revs.length < VERSION_BODIES.length) {
        log.warn(
          `Expected ${VERSION_BODIES.length} revisions, Dropbox reports ${revs.length}. `
          + 'Version features 9.1/9.2 are under-seeded.'
        );
      }
    } catch (err) {
      report.errors.push({ step: 'verify versions', error: err.message });
    }
    log.info(`Seeded versions (${report.seededVersionCount ?? '?'} revisions confirmed)`);
  }

  /**
   * Scope 10.1–10.19 — Dropbox Paper. Nineteen features, and none can be seeded by API.
   *
   * Dropbox retired the Paper authoring endpoints (`paper/docs/create` and friends). What remains is
   * export-only. Uploading bytes with a `.paper` extension creates an ordinary file, not a Paper
   * document, so it would not exercise a single one of these features while appearing to.
   *
   * Returning explicit manual steps is the honest alternative: 19 of the 36 in-scope features are
   * over half the document, and a run must not imply they were covered.
   */
  _reportPaperManualSteps() {
    return {
      feature: 'Dropbox Paper (scope 10.1–10.19 — 19 of 36 in-scope features, 50 QA cases)',
      reason:
        'Dropbox retired the Paper authoring API; the remaining endpoints only EXPORT an existing '
        + 'Paper doc. Uploading a .paper file creates an ordinary file, not a Paper document, so it '
        + 'would exercise none of these features while looking seeded. Paper docs must be authored '
        + 'by hand once, then reused across runs.',
      manualSteps: [
        `In the Dropbox UI, create a Paper doc at ${env.DROPBOX_TEST_ROOT}/11-Paper/qa-paper-full.paper`,
        'Add, in one document: bold + strikethrough text, an H1 and an H2, a hyperlink (10.2, 10.7)',
        'Insert an image, a media embed, and a pasted clipboard image (10.3, 10.4, 10.5)',
        'Insert a GIF (10.6) — documented as NOT migrating; it is here to confirm that',
        'Insert a Dropbox file link to an in-scope file, and one to an out-of-scope file (10.8)',
        'Add a table with 62, 63 and 64 columns in three separate tables (10.9) — the documented boundary',
        'Insert a timeline with Title / Dates / Assigned To / Description columns (10.10)',
        'Add a to-do list with some boxes checked and some unchecked (10.11)',
        'Add a bulleted list and a numbered list (10.12, 10.13)',
        'Add a section break (10.14) — documented as NOT migrating',
        'Add a code block with syntax-highlighted content (10.15) — formatting documented as lost',
        'Add several emojis (10.16)',
        'Add an @mention of a team member (10.17) — documented as NOT migrating',
        'Add an in-line comment on a paragraph (10.18) — documented as NOT migrating',
        'Edit and re-save the doc twice so it has version history (10.19)',
        'Leave the doc in place — re-running the seeding agent will not delete it if it lives outside '
          + 'the wiped root, so keep it under a folder the agent does not clear, or re-create it after a wipe',
      ],
    };
  }

  /**
   * Scope 1.3 — delta. Called as a SECOND pass, after the one-time migration completed.
   *
   * The five change types are the ones the QA cases actually count: existing (1,677), renamed
   * (1,635), newly added (1,440), content updated (708) and moved (39). "Existing" is the control —
   * an item deliberately left alone, so the run can confirm it was NOT re-migrated.
   *
   * Not called from execute(): a delta against an unmigrated tree tests nothing.
   */
  async applyDeltaChanges(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    const root = dropboxClient.dbxPath(context.sourcePath || env.DROPBOX_TEST_ROOT);
    const asMemberId = await this._resolveMemberContext(context, log);
    const opts = { asMemberId };
    const changes = { renamed: [], added: [], updated: [], moved: [], unchanged: [], errors: [] };

    const deltaDir = `${root}/12-Delta`;
    await dropboxClient.createFolder(deltaDir, opts).catch(() => null);

    // newly added
    try {
      const p = `${deltaDir}/delta-added.txt`;
      await dropboxClient.uploadFile(p, Buffer.from('Added during delta window.\n'), opts);
      changes.added.push(p);
    } catch (err) { changes.errors.push({ step: 'added', error: err.message }); }

    // content updated — an existing seeded file, overwritten
    try {
      const p = `${root}/03-File-Formats/document.txt`;
      await dropboxClient.uploadFile(
        p, Buffer.from(`${SAMPLE_TXT}UPDATED during the delta window.\n`), { ...opts, mode: 'overwrite' }
      );
      changes.updated.push(p);
    } catch (err) { changes.errors.push({ step: 'updated', error: err.message }); }

    // renamed — a rename in Dropbox IS a move within the same parent.
    try {
      const from = `${root}/03-File-Formats/data.csv`;
      const to = `${root}/03-File-Formats/data-renamed-in-delta.csv`;
      await dropboxClient.movePath(from, to, opts);
      changes.renamed.push({ from, to });
    } catch (err) { changes.errors.push({ step: 'renamed', error: err.message }); }

    // moved — across folders, which is the case the QA suite counts separately (39 cases).
    try {
      const from = `${root}/03-File-Formats/feed.xml`;
      const to = `${deltaDir}/feed-moved-in-delta.xml`;
      await dropboxClient.movePath(from, to, opts);
      changes.moved.push({ from, to });
    } catch (err) { changes.errors.push({ step: 'moved', error: err.message }); }

    // unchanged control — deliberately a file NO other delta step touches, so the run can assert it
    // was not re-migrated. Picking one that is also renamed above would make the control meaningless.
    changes.unchanged.push(`${root}/03-File-Formats/config.json`);

    log.info(
      `Delta pass: ${changes.added.length} added, ${changes.updated.length} updated, `
      + `${changes.unchanged.length} left unchanged, ${changes.errors.length} not applied`
    );
    return changes;
  }

  /** One line a human can read in the run log and the report. */
  _summarize(report) {
    const c = report.created;
    return (
      `Dropbox seeding: ${c.folders} folders, ${c.files} files, ${c.versions} version uploads, `
      + `${c.links} shared links, ${c.grants} grants under ${report.root}. `
      + `${report.skipped.length} skipped, ${report.notSeeded.length} not seedable by API, `
      + `${report.errors.length} errors.`
    );
  }
}

module.exports = DropboxTestDataAgent;
// Exported so a test can assert the two lists never overlap: a Dropbox-disallowed name in the
// seeding list throws mid-run and takes every later row with it.
module.exports.RESERVED_STYLE_NAMES = RESERVED_STYLE_NAMES;
module.exports.DROPBOX_DISALLOWED_NAMES = DROPBOX_DISALLOWED_NAMES;
