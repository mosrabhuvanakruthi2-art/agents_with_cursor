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
 * The name that actually makes feature 5.1 a test.
 *
 * `SPECIAL_CHARS_NAME` above contains nothing SharePoint rejects, so 5.1 reported "not exercised"
 * even on a successful run — the check looks for names a destination WOULD rewrite, and there were
 * none. These are the characters that separate the two destinations: SharePoint forbids
 * `" * : < > ? |`, Google accepts them all. A folder named with them must therefore arrive
 * UNCHANGED at Google, and that is the negative test the scope document describes.
 *
 * `/` and `\` are still excluded — Dropbox itself rejects those in a path segment.
 */
const SHAREPOINT_INVALID_NAME = 'SP-invalid " * : < > ? | chars';

/**
 * Names reserved on Windows/SharePoint but ordinary on Google.
 *
 * `desktop.ini` is deliberately NOT here. Dropbox maintains its own list of names it refuses to
 * store — desktop.ini, thumbs.db, .ds_store, .dropbox — and rejects them with
 * `path/disallowed_name`. Including it made the whole seeding run die at this step, because the
 * source cloud cannot hold the file at all. That is a Dropbox limitation, not a gap in coverage:
 * a name Dropbox will not store can never be migrated from Dropbox.
 */
const RESERVED_STYLE_NAMES = ['CON', 'PRN', 'AUX', 'NUL'];

/** Names Dropbox itself refuses, recorded so the report can say why they are absent. */
const DROPBOX_DISALLOWED_NAMES = ['desktop.ini', 'thumbs.db', '.ds_store', '.dropbox'];

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

    // Where to seed, most explicit first.
    //
    // `sourceFolderName` is what the RUN WIZARD sends ("Source folder base name") and it must be
    // honoured, or the run seeds somewhere the user did not ask for. Reading only `sourcePath` meant
    // a wizard run typing "QA-Migration-Test" silently fell back to DROPBOX_TEST_ROOT and WIPED
    // /QA-Automation — the cleanup log said one folder while the seeding log said another.
    const rootSource = context.sourcePath ? 'the run\'s source path'
      : context.sourceFolderName ? 'the run\'s source folder base name (wizard)'
        : env.DROPBOX_TEST_ROOT ? 'DROPBOX_TEST_ROOT'
          : null;
    const root = dropboxClient.dbxPath(
      context.sourcePath
      || context.sourceFolderName
      || env.DROPBOX_TEST_ROOT
    );

    // No silent fallback. This agent DELETES its root before seeding, so a default would mean an
    // unfilled field quietly destroys whatever lives at that default — which is exactly what
    // happened to a teammate's /QA-Automation folder when the wizard field came through empty.
    if (!root || !rootSource) {
      throw new Error(
        'Refusing to seed: no Dropbox source folder was named. This agent DELETES its root before '
        + 'seeding, so it will not fall back to a shared default — that is how a teammate\'s test '
        + 'folder got wiped. Set the run\'s "Source folder base name" in the wizard, or '
        + 'DROPBOX_TEST_ROOT in the root .env, to a folder of your own (e.g. /QA-Dropbox-lavanya).'
      );
    }
    log.info(`Seeding root resolved to ${root} (from ${rootSource})`);

    const asMemberId = await this._resolveMemberContext(context, log);

    // Seed into the MEMBER FOLDER, not the team space.
    //
    // Writing at the team-space root was tried and is not permitted: create_folder_v2 there returns
    // `path/no_write_permission` for an ordinary member, admin token or not. The member folder is
    // the only place this agent can reliably write.
    //
    // That leaves a frame mismatch to solve elsewhere, not here: CloudFuze scans the TEAM SPACE,
    // where this same folder appears under the member's home path (e.g. "/Erik E/QA-…"). The
    // migration step translates the path when it talks to CloudFuze; `teamSpacePath` below is
    // reported so it has the value to use, and so a reader can see both forms of the same folder.
    const opts = { asMemberId };
    const homePath = await dropboxClient.resolveMemberHomePath(asMemberId);
    const grantees = this._resolveGrantees(context, log);

    const report = {
      root,
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
    await this._mk(root, opts, report);

    // Each step is independently survivable.
    //
    // The steps are not dependent on each other, and losing all of them because one name upset the
    // source cloud is the worst possible trade: the first live run died at the special-characters
    // step on a Dropbox-disallowed name and took long paths, embedded links and versions with it,
    // so the run produced no version or long-path data at all. A step that fails is recorded and
    // the rest still seed.
    const steps = [
      // Rows 1–4, 6: the permission ladder — root folder, root file, sub-folders, inner files.
      ['permission ladder (scope 2.1-2.5)', () => this._seedPermissionLadder(root, opts, grantees, log, report)],
      // Row 2: root files in every pass-through format.
      ['file formats (scope 1.1)', () => this._seedRootFiles(root, opts, log, report)],
      // Rows 7–8: shared links, both audiences, both access levels.
      ['shared links (scope 3.1/3.2)', () => this._seedSharedLinks(root, opts, log, report)],
      // Row 9: distinct modified timestamps.
      ['timestamps (scope 4.1)', () => this._seedTimestampFiles(root, opts, log, report)],
      // Row 10: names Google accepts unchanged.
      ['special characters (scope 5.1)', () => this._seedSpecialCharacterNames(root, opts, log, report)],
      // Row 11: the long-path breaking point.
      ['long paths (scope 7.1)', () => this._seedLongPath(root, opts, log, report)],
      // Row 12: embedded links, one in scope and one out.
      ['embedded links (scope 8.1/10.8)', () => this._seedEmbeddedLinks(root, opts, log, report)],
      // Rows 13–14: version history.
      ['versions (scope 9.1/9.2)', () => this._seedVersions(root, opts, log, report)],
    ];

    for (const [label, run] of steps) {
      try {
        await run();
      } catch (err) {
        report.errors.push({ step: label, error: err.message });
        log.warn(`Seeding step "${label}" failed (continuing): ${err.message}`);
      }
    }

    // Row 15: Paper — cannot be seeded; return the manual steps.
    report.notSeeded.push(this._reportPaperManualSteps(root));

    // Row 16: the user-mapping CSV is a MIGRATION input, not source data — noted, not created here.
    report.notSeeded.push({
      feature: 'user-mapping CSV (test-data row 16, 4,832 QA cases)',
      reason:
        'The mapping CSV is an input to the CloudFuze job, not data inside Dropbox. It is built by '
        + 'the migration step from the run\'s user mappings, so there is nothing to seed in the source.',
      manualSteps: [],
    });

    // The contract the ORCHESTRATOR reads back, not just our own report.
    //
    // AgentOrchestrator does `context.sourceTestDataPath = '/' + sourceData.rootFolderName` and
    // `context.sourceRootId = String(sourceData.rootFolderId)`. Without these two fields it built
    // `sourcePath: "/undefined"` and handed CloudFuze a path that does not exist — the run looked
    // seeded and then migrated nothing. Every other TestDataAgent in the repo returns them; this one
    // has to as well.
    //
    // `rootFolderName` carries the path WITHOUT its leading slash, so a nested seeding root
    // ("/QA/Sub") still reconstructs correctly when the orchestrator prefixes "/".
    report.rootFolderName = root.replace(/^\/+/, '');
    try {
      const meta = await dropboxClient.getMetadata(root, opts);
      report.rootFolderId = meta?.id || null;
    } catch (err) {
      report.rootFolderId = null;
      report.errors.push({ step: 'resolve seeding root id', error: err.message });
    }

    report.summary = this._summarize(report);
    log.info(
      `${report.summary} rootFolderName="${report.rootFolderName}" rootFolderId=${report.rootFolderId || 'none'}`
    );
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

  /**
   * Delete the seeding root so a re-run starts clean. Scoped to that one path, never the account.
   *
   * Says WHAT it is about to destroy before destroying it. The old one-line "Cleared existing X"
   * appeared after the fact, so a run that had silently resolved the wrong root gave no warning
   * until the data was already gone — the folder count is the cheapest possible tripwire.
   */
  async _wipeRoot(root, opts, log, report) {
    try {
      // Immediate children only. A deep walk here logged "depth cap reached" warnings for every
      // branch and still undercounted, which made the tripwire noisier than the thing it warns
      // about. The top-level count is enough to recognise a folder you did not mean to delete.
      const existing = await dropboxClient.listFolder(root, opts).catch(() => []);
      if (existing.length > 0) {
        log.warn(
          `About to DELETE ${root} — it holds ${existing.length} top-level item(s) and everything `
          + 'beneath them. If that is not your own test folder, cancel now and set a source folder '
          + 'of your own.'
        );
      }
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

    // The name that carries characters SharePoint forbids and Google allows — the one that makes
    // 5.1 assessable. Guarded separately: if Dropbox refuses any of these, we lose this folder and
    // learn which character it was, not the whole step.
    try {
      const spInvalid = `${dir}/${SHAREPOINT_INVALID_NAME}`;
      await this._mk(spInvalid, opts, report);
      await this._put(`${spInvalid}/${SHAREPOINT_INVALID_NAME}.txt`, SAMPLE_TXT, opts, report);
    } catch (err) {
      report.errors.push({
        step: `SharePoint-invalid character name "${SHAREPOINT_INVALID_NAME}" (scope 5.1)`,
        error: err.message,
      });
      log.warn(`Could not seed the SharePoint-invalid name: ${err.message}`);
    }

    // Per-name, so one name Dropbox happens to refuse cannot abort the whole seeding run. This step
    // is the most likely place to meet `path/disallowed_name`, and losing everything after it — long
    // paths, embedded links, versions — costs far more than the one name.
    for (const name of RESERVED_STYLE_NAMES) {
      try {
        await this._put(`${dir}/${name}`, `${SAMPLE_TXT}Reserved-on-Windows name: ${name}\n`, opts, report);
      } catch (err) {
        report.errors.push({ step: `reserved-style name "${name}" (scope 5.1)`, error: err.message });
        log.warn(`Could not seed reserved-style name "${name}": ${err.message}`);
      }
    }

    // Names the SOURCE cloud refuses. Documented rather than attempted: Dropbox cannot hold them, so
    // they can never be migrated from Dropbox, and attempting them only breaks the run.
    report.notSeeded.push({
      feature: 'Dropbox-disallowed names (scope 5.1, edge)',
      reason:
        `Dropbox refuses to store ${DROPBOX_DISALLOWED_NAMES.join(', ')} and rejects them with `
        + 'path/disallowed_name, and it rejects a path segment with a trailing dot or space. These '
        + 'cannot be seeded from the source side at all — not a gap in coverage, the source cloud '
        + 'cannot hold them.',
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
  _reportPaperManualSteps(root = null) {
    const at = root || '<your seeding root>';
    return {
      feature: 'Dropbox Paper (scope 10.1–10.19 — 19 of 36 in-scope features, 50 QA cases)',
      reason:
        'Dropbox retired the Paper authoring API; the remaining endpoints only EXPORT an existing '
        + 'Paper doc. Uploading a .paper file creates an ordinary file, not a Paper document, so it '
        + 'would exercise none of these features while looking seeded. Paper docs must be authored '
        + 'by hand once, then reused across runs.',
      manualSteps: [
        `In the Dropbox UI, create a Paper doc at ${at}/11-Paper/qa-paper-full.paper`,
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
    const root = dropboxClient.dbxPath(
      context.sourcePath || context.sourceFolderName || env.DROPBOX_TEST_ROOT
    );
    if (!root) throw new Error('Delta pass: no Dropbox source folder named — refusing to guess one.');
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
