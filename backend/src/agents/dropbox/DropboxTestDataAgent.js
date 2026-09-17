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
 * Names holding characters the MICROSOFT destinations replace, one character per name.
 *
 * One per name rather than all in one: SharePoint replaces each with `_`, so a single name holding
 * six of them arrives as `SP-invalid ______ chars.txt` and a reader cannot tell which character was
 * handled. Separate names make each rule individually observable — and if Dropbox refuses one, the
 * other five are still seeded.
 *
 * These are inert for a Google destination, which accepts all of them unchanged.
 */
const MS_INVALID_CHAR_NAMES = [
  'MS-invalid star * name.txt',
  'MS-invalid colon : name.txt',
  'MS-invalid lt < name.txt',
  'MS-invalid gt > name.txt',
  'MS-invalid question ? name.txt',
  'MS-invalid pipe | name.txt',
  'MS-invalid quote " name.txt',
];

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

    // `sourceFolderName` is the run wizard's "Source folder base name" field. It was not read here,
    // so a run that named a folder still seeded into DROPBOX_TEST_ROOT and the wizard's own
    // "This run will create …" line was wrong. Every other source honours it — Box and Drive both
    // create the named folder — so Dropbox was the odd one out.
    //
    // It matters beyond the label. Seeding WIPES its root, and both Dropbox combinations share this
    // agent: with the field ignored, a dropbox → sharepoint run destroys the tree a
    // dropbox → googleshareddrive run depends on, and neither report says which run produced what.
    // Naming a folder per combination is the fix, and this is what makes the field do it.
    //
    // Precedence keeps existing runs byte-identical: an explicit sourcePath still wins, and a BLANK
    // field still falls through to DROPBOX_TEST_ROOT (/QA-Automation). Only a filled field changes
    // anything, and only to what the label promises.
    const root = dropboxClient.dbxPath(
      context.sourcePath || context.sourceFolderName || env.DROPBOX_TEST_ROOT
    );
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

    // Row 15: Paper — FIRST, deliberately, though it is the last row in the scope document.
    //
    // Paper was seeded last and CloudFuze started copying 23 seconds later. On run 93b0636a the
    // freshly created /11-Paper/qa-paper-full.paper arrived at the destination as a 500-byte Google
    // Doc holding no text, while the two Paper docs that already existed converted perfectly. Our
    // own export round-trip right after creation returned all 3 tables, so DROPBOX had the content
    // — whatever CloudFuze read 23 seconds later did not.
    //
    // Seeding it first puts the rest of the seeding (~4 minutes: permissions, formats, links,
    // timestamps, long paths, versions) between creation and the copy, instead of 23 seconds. That
    // is a mitigation for a propagation delay we have not proved the mechanism of, not a fix for a
    // known bug — so if an empty Paper doc appears again, the delay theory is wrong and the next
    // suspect is CloudFuze caching its namespace scan.
    //
    // Order is otherwise irrelevant here: every step writes to its own subtree of `root`.
    await this._seedPaper(root, opts, log, report);

    // Row 1–4, 6: the permission ladder — root folder, root file, sub-folders, inner files.
    await this._seedPermissionLadder(root, opts, grantees, log, report);

    // Row 1-4 breadth: every role against every principal type, on a folder and a file.
    await this._seedPermissionMatrix(root, opts, grantees, log, report);

    // Team-wide vs restricted access — "Everyone at <team>" or only named people.
    await this._applyAccessMode(root, opts, grantees, log, report);

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

    // Row 15 (Paper) is seeded FIRST — see the note at the top of this sequence.

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
    // SOURCE emails, not destination ones. These grants are made on DROPBOX; a destination address
    // is the GOOGLE side of the mapping and need not exist in the Dropbox team at all. Preferring
    // destinationEmail here meant the run's kamal.basha@cloudfuze.com mapping contributed
    // "kamal@filefuze.co" — real on Google, absent from the Dropbox team — so Dropbox rejected the
    // grant as cant_share_outside_team and features 2.1, 2.2 and 2.4 lost their user-editor
    // dimension while the log said only "unavailable on this account".
    const mapped = (context.userEmailMappings || [])
      .map((m) => String(m.sourceEmail || m.destinationEmail || '').toLowerCase())
      .filter(Boolean);

    // The plural list comes BEFORE the run's mapping. Whoever set DROPBOX_TEST_INTERNAL_USERS chose
    // those people deliberately; falling through to mapped[0] silently ignored that choice the
    // moment the singular var was cleared in favour of the list.
    const internal = (env.DROPBOX_TEST_INTERNAL_USER
      || env.DROPBOX_TEST_INTERNAL_USERS[0]
      || mapped[0]
      || '').toLowerCase();
    const external = (env.DROPBOX_TEST_EXTERNAL_USER || '').toLowerCase();
    // Falls back to the plural list, exactly as `internal` does two lines above. Without it the two
    // vars were asymmetric in a way that silently cost coverage: env.js already resolves
    // DROPBOX_TEST_GROUPS from DROPBOX_TEST_GROUP, but not the reverse — so a .env setting only the
    // PLURAL (which is what ours does) left this empty.
    //
    // That is not cosmetic. `grantees.group` is what _seedPermissionLadder grants with, so with it
    // empty the ladder seeded NO group grant at any of the four positions — root folder, root file,
    // sub-folder, inner file — while _seedPermissionMatrix, which reads `groupNames`, seeded them
    // fine. Features 2.1–2.4 (4.1–4.4 on the SharePoint scope) therefore lost their group dimension
    // at every position, and the run reported only "No DROPBOX_TEST_GROUP … will be SKIPPED",
    // which reads like a configuration note rather than the coverage hole it was.
    const group = env.DROPBOX_TEST_GROUP || env.DROPBOX_TEST_GROUPS[0] || '';

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
      log.warn(
        'No DROPBOX_TEST_GROUP or DROPBOX_TEST_GROUPS — group grants (scope 2.1–2.4, 3,866 QA cases) '
        + 'will be SKIPPED. Set either to the display name of an existing Dropbox team group.'
      );
    }
    // The singular keys are unchanged, so the positional ladder behaves exactly as before. The
    // plural sets are what the breadth matrix uses, and each falls back to the singular value — a
    // .env naming one user and one group produces one-element lists and identical behaviour.
    //
    // Names only, not resolved selectors: this method is synchronous and has no report to record a
    // missing group against, so the lookup belongs in _seedPermissionMatrix.
    const internalUsers = env.DROPBOX_TEST_INTERNAL_USERS.length
      ? env.DROPBOX_TEST_INTERNAL_USERS
      : (internal ? [internal] : []);
    const groupNames = env.DROPBOX_TEST_GROUPS.length
      ? env.DROPBOX_TEST_GROUPS
      : (group ? [group] : []);
    log.info(`Grantees: ${internalUsers.length} internal user(s), ${groupNames.length} group(s), `
      + `${external ? 1 : 0} external`);

    return { internal, external, group, internalUsers, groupNames };
  }

  /**
   * Clear the seeding root so a re-run starts clean, PRESERVING the hand-authored folders.
   *
   * Scoped to this one path, never the account.
   *
   * Deleting the root wholesale is still the fast path and is used whenever nothing needs keeping.
   * When DROPBOX_PRESERVE_ON_WIPE names something, the children are removed one by one instead and
   * those names are skipped — which is what lets a Dropbox Paper doc live inside the migration
   * source and survive re-seeding. Paper IS seeded by API now (`files/paper/create`, see
   * _seedPaper), so preservation is no longer the only way a Paper doc can exist. It stays because a
   * hand-authored doc carries structure the generated one does not, and keeping it costs nothing.
   */
  async _wipeRoot(root, opts, log, report) {
    const preserve = (env.DROPBOX_PRESERVE_ON_WIPE || []).map((s) => s.toLowerCase());
    try {
      if (preserve.length === 0) {
        await dropboxClient.deletePath(root, opts);
        log.info(`Cleared existing ${root}`);
        return;
      }

      // Child-by-child so the preserved names survive. An absent root simply lists empty.
      const children = await dropboxClient.listFolder(root, opts).catch(() => []);
      if (!children || children.length === 0) {
        log.info(`Nothing to clear under ${root}`);
        return;
      }

      let removed = 0;
      const kept = [];
      for (const child of children) {
        const name = String(child.name || '');
        if (preserve.includes(name.toLowerCase())) {
          kept.push(name);
          continue;
        }
        try {
          await dropboxClient.deletePath(child.path || `${root}/${name}`, opts);
          removed += 1;
        } catch (delErr) {
          log.warn(`Could not clear ${name}: ${delErr.message}`);
        }
      }
      log.info(`Cleared ${removed} item(s) under ${root}`
        + (kept.length ? `; kept ${kept.join(', ')} (preserved by DROPBOX_PRESERVE_ON_WIPE)` : ''));
      if (kept.length === 0 && preserve.length > 0) {
        report.notSeeded.push({
          feature: `preserved folder(s) ${preserve.join(', ')} (Dropbox Paper — 19 features)`,
          reason: `DROPBOX_PRESERVE_ON_WIPE names ${preserve.join(', ')}, but no such folder exists `
            + `under ${root}. The API-seeded Paper doc (_seedPaper) still covers these features; `
            + 'a hand-authored doc there would add structure the generated one does not.',
          manualSteps: [],
        });
      }
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
      // An EXTERNAL grant on a FILE is refused as member_error/no_permission, at BOTH roles — not
      // as cant_share_outside_team, which is what the folder call returns. Measured directly:
      // sharing/add_file_member answered HTTP 200 with that member_error in the body, so until the
      // client learned to read per-member results this refusal was invisible and scope 2.5 reported
      // "no grant found" instead of "Dropbox refused". Classified with the other documented account
      // limits rather than as a run error.
      const externalBlocked = /external/i.test(String(label || ''))
        && /no_permission|cant_share_outside_team/.test(summary);
      // Dropbox refuses to add an AUTOMATIC group (the team-wide "Everyone at <team>") as a folder
      // member: sharing/add_folder_member returns bad_member/automatic_group. That is a platform
      // rule, not a defect and not a configuration mistake, so it belongs with the other documented
      // limitations rather than in report.errors where it made a healthy run look broken.
      const automaticGroupBlocked = /automatic_group/.test(summary);
      if (fileEditorBlocked || outsideTeamBlocked || automaticGroupBlocked || externalBlocked) {
        report.notSeeded.push({
          feature: label,
          reason: automaticGroupBlocked
            ? 'Dropbox refuses to add an automatic group as a folder member '
              + '(sharing/add_folder_member → bad_member/automatic_group). The team-wide '
              + '"Everyone at <team>" group is created and managed by Dropbox, and only '
              + 'user-created groups can be granted access this way. To exercise team-wide access, '
              + 'point DROPBOX_TEST_EVERYONE_GROUP at a normal group containing the whole team, or '
              + 'use a team-scoped shared link instead.'
            : fileEditorBlocked
            ? 'This Dropbox account refuses editor access on an individual file '
              + '(sharing/add_file_member → access_error/no_permission), while viewer on the same '
              + 'file and editor on a folder both succeed. A source-account limit, not a migration '
              + 'defect — the editing half of this position cannot be exercised here.'
            : 'Dropbox refuses every external grant from this account, and the cause is now narrowed '
              + 'to a PER-MEMBER sharing permission rather than anything about the invitee or the '
              + 'folder. Measured directly against the QA account:\n'
              + '  - FOLDER invite -> HTTP error cant_share_outside_team\n'
              + '  - FILE invite   -> HTTP 200 with member_error/no_permission in the body, at BOTH '
              + 'viewer and editor\n'
              + 'Ruled out by test, not by assumption: the "+" sub-address alias is irrelevant '
              + '(srinidhperla2004+dbxqa@gmail.com and srinidhperla2004@gmail.com are refused '
              + 'identically); the team space is irrelevant (a folder in the member\'s PERSONAL '
              + 'namespace is refused the same way); and the team-wide toggle is enabled ("External '
              + 'sharing: Email and link", checked 03-Sep-2026) with the shared folder reporting '
              + 'member_policy "anyone". An INTERNAL grant on the same file in the same call '
              + 'succeeds and reads back, so the code path is sound.\n'
              + 'What remains: the Dropbox admin console\'s per-member or group sharing permission '
              + 'for this member (erik@filefuze.co) — the one control not yet inspected. Scope 2.5 '
              + 'stays unexercised until an admin changes it; it is a source-account limit, not a '
              + 'migration defect.',
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
   * The full permission matrix — every ROLE against every PRINCIPAL TYPE, on a folder and a file.
   *
   * Mirrors DriveTestDataAgent._createPermissionMatrix, which is the shape the manual QA suite is
   * written against: a dedicated container, one folder and one file per role, and three principal
   * types on each — internal user, GROUP, external. Group grants alone are 3,866 of its cases.
   *
   * The ladder above covers POSITION (root folder, root file, sub-folder, inner file), which is what
   * features 2.1-2.4 are keyed on. This covers BREADTH at one position: with a single internal user
   * and a single group it was about two of the eighteen combinations the scope asks for.
   *
   * Dropbox has only two collaborator levels, `editor` and `viewer` — there is no commenter, so the
   * role axis is two wide rather than the Drive side's four.
   */
  async _seedPermissionMatrix(root, opts, grantees, log, report) {
    const users = grantees.internalUsers || [];
    const external = grantees.external ? { email: grantees.external } : null;

    // Resolved ONCE here, not per grant: each lookup lists every team group (309 on this account),
    // so resolving inside the loop below would repeat that call for every item and role. A name
    // that does not exist is recorded by _resolveGroupMember and simply absent from this list —
    // never invented, because creating a group as a side effect of seeding would change team
    // configuration nobody asked to change.
    const groups = [];
    for (const name of (grantees.groupNames || [])) {
      const member = await this._resolveGroupMember(name, log, report);
      if (member) groups.push(member);
    }

    if (users.length === 0 && groups.length === 0 && !external) {
      report.skipped.push({
        step: 'permission matrix (scope 2.1-2.5)',
        reason: 'no internal user, group or external address configured — nothing to grant. Set '
          + 'DROPBOX_TEST_INTERNAL_USERS / DROPBOX_TEST_GROUPS / DROPBOX_TEST_EXTERNAL_USER.',
      });
      return;
    }

    const container = await this._mk(`${root}/13-Permission-Matrix`, opts, report);
    log.info(`Permission matrix: ${users.length} user(s), ${groups.length} group(s), `
      + `${external ? 1 : 0} external — on a folder and a file at each role`);

    // Deterministic rotation, so the same ROLE is held by a DIFFERENT person in a different root.
    //
    // Taken from the Drive side, where every drive giving the same grantee the same role made
    // cross-drive leakage undetectable: if one tree's grants appear on another, the correct grantee
    // is exactly what a correct migration looks like. A character sum rather than randomness, so a
    // re-run of the same root seeds the same people and two reports stay comparable.
    const offset = [...String(root)].reduce((a, ch) => a + ch.charCodeAt(0), 0);

    for (const [roleIndex, role] of ['editor', 'viewer'].entries()) {
      const folder = await this._mk(`${root}/13-Permission-Matrix/folder_${role}`, opts, report);
      const file = await this._put(
        `${root}/13-Permission-Matrix/file_${role}.txt`, SAMPLE_TXT, opts, report
      );

      for (const target of [folder, file]) {
        const kind = target && target.type === 'folder' ? 'folder' : 'file';
        if (!target) continue;

        // Internal: one rotated pick per role, not every user on every item — granting all of them
        // everywhere would tell us nothing extra and multiplies the run time.
        if (users.length > 0) {
          const who = users[(roleIndex + offset) % users.length];
          await this._grant(target, { email: who }, role, opts, report,
            `matrix ${kind} ${role} → user ${who}`);
        } else {
          report.skipped.push({
            step: `matrix ${kind} ${role} → internal user`,
            reason: 'no DROPBOX_TEST_INTERNAL_USERS configured',
          });
        }

        // EVERY group, deliberately: a company-managed and a user-managed Dropbox group migrate
        // differently, so covering only one leaves the other type untested while looking covered.
        for (const g of groups) {
          await this._grant(target, g, role, opts, report,
            `matrix ${kind} ${role} → group ${g.displayName}`);
        }
        if (groups.length === 0) {
          report.skipped.push({
            step: `matrix ${kind} ${role} → group`,
            reason: 'no DROPBOX_TEST_GROUPS configured',
          });
        }

        if (external) {
          await this._grant(target, external, role, opts, report,
            `matrix ${kind} ${role} → external ${external.email}`);
        }
      }
    }
  }

  /**
   * Team-wide access vs a named few — the Dropbox equivalent of the Drive side's driveAccessMode.
   *
   * In the Dropbox sharing dialog this is the choice between "Everyone at <team>" and "Only
   * specific people". Both modes grant to the SAME named people; the only difference is whether the
   * everyone-group is also present, so when two runs differ that group is the single variable.
   *
   * An unset or unrecognised mode seeds nothing and says so. A mode with no principal configured
   * does the same — the feature must not come out green having never been exercised.
   */
  async _applyAccessMode(root, opts, grantees, log, report) {
    const mode = env.DROPBOX_ACCESS_MODE;
    if (!mode) {
      report.skipped.push({
        step: 'team-wide vs restricted access',
        reason: 'DROPBOX_ACCESS_MODE not set — set it to "open" or "restricted" to exercise this',
      });
      return;
    }
    if (mode !== 'open' && mode !== 'restricted') {
      log.warn(`Unknown DROPBOX_ACCESS_MODE "${mode}" — expected "open" or "restricted"; nothing seeded`);
      report.skipped.push({
        step: 'team-wide vs restricted access',
        reason: `DROPBOX_ACCESS_MODE "${mode}" is not one of "open" / "restricted"`,
      });
      return;
    }

    const folder = await this._mk(`${root}/14-Access-Mode`, opts, report);
    if (!folder) return;

    if (mode === 'open') {
      const everyone = await this._resolveGroupMember(env.DROPBOX_TEST_EVERYONE_GROUP, log, report);
      if (!everyone) {
        report.skipped.push({
          step: 'team-wide access ("open")',
          reason: 'DROPBOX_TEST_EVERYONE_GROUP is not set or names no existing group — the '
            + '"Everyone at <team>" group in the Dropbox sharing dialog',
        });
        return;
      }
      // Check the result. This logged "granted to the team-wide group" unconditionally, so a run
      // whose grant was REFUSED still reported it as granted — the one thing this whole validator
      // exists to prevent.
      const ok = await this._grant(folder, everyone, 'viewer', opts, report,
        `access mode open → everyone group ${everyone.displayName} viewer`);
      if (ok) {
        log.info(`Access mode "open": granted to the team-wide group "${everyone.displayName}"`);
      } else {
        log.warn(`Access mode "open": the grant to "${everyone.displayName}" did NOT succeed — `
          + 'team-wide access is not exercised by this run. See the not-seeded entry for why.');
      }
      return;
    }

    // restricted: the same named few, and no everyone-group.
    const few = (grantees.internalUsers || []).slice(0, 2);
    if (few.length === 0) {
      report.skipped.push({
        step: 'restricted access',
        reason: 'no DROPBOX_TEST_INTERNAL_USERS configured, so there is no "few" to grant to',
      });
      return;
    }
    let granted = 0;
    for (const [i, who] of few.entries()) {
      const ok = await this._grant(folder, { email: who }, i === 0 ? 'editor' : 'viewer', opts, report,
        `access mode restricted → ${who} ${i === 0 ? 'editor' : 'viewer'}`);
      if (ok) granted += 1;
    }
    // The COUNT THAT LANDED, not the count attempted — same reason as the open branch above.
    log.info(`Access mode "restricted": ${granted} of ${few.length} named grant(s) landed, `
      + 'no team-wide group');
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

    // Names carrying characters the MICROSOFT destinations actually reject.
    //
    // SPECIAL_CHARS_NAME above is `~!@#$%^&()_+[]{};,.=` — every one of which SharePoint and
    // OneDrive accept unchanged. So on a Microsoft destination feature 7.1 (Special Character
    // Replacement) had nothing to exercise and reported "not assessed" on every run, while reading
    // like coverage. The Microsoft invalid set is `" * : < > ? / \ |`.
    //
    // `/` and `\` are omitted deliberately: Dropbox uses them as path separators and cannot hold
    // them in a name, so they are documented below rather than attempted. Each name is seeded
    // individually — Dropbox rejects some of these on some accounts, and one refusal must not take
    // the rest of the row with it.
    //
    // Harmless to the Google combinations that share this agent: Google accepts these characters,
    // so the files simply arrive unchanged, which is exactly what the Google scope document says
    // feature 5.1 should observe.
    for (const name of MS_INVALID_CHAR_NAMES) {
      try {
        await this._put(`${dir}/${name}`, `${SAMPLE_TXT}Destination-invalid characters: ${name}\n`,
          opts, report);
      } catch (err) {
        report.notSeeded.push({
          feature: `destination-invalid characters "${name}" (scope 7.1)`,
          reason: `Dropbox refused this name (${err.message}), so the replacement rule cannot be `
            + 'exercised with it. A limit of the source cloud, not missing coverage.',
          manualSteps: [],
        });
        log.warn(`Special-character name "${name}" refused by Dropbox — reported as not seeded`);
      }
    }
    report.notSeeded.push({
      feature: 'names containing "/" or "\\" (scope 7.1, edge)',
      reason: 'Dropbox uses both as path separators and cannot store either inside a name, so the '
        + 'destination\'s replacement of them cannot be exercised from a Dropbox source.',
      manualSteps: [],
    });
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
   *
   * TWO documents are written, and only ONE of them is a fair test.
   *
   *   embedded_link_doc.docx        — a real Word document carrying real hyperlink relationships.
   *                                   This is what feature 8.1 is judged on.
   *   document-with-embedded-links.html — the same two links as plain <a href> in HTML. Kept as a
   *                                   deliberate CONTRAST case, reported and never judged.
   *
   * The .docx exists because the .html cannot fail honestly. Scope 8.1 limits link rewriting to
   * "supported file types where link rewriting is technically feasible", and plain HTML is not one
   * of them — DriveTestDataAgent._createEmbeddedLinks makes exactly this point for the Drive pair:
   * "A real .docx with a real hyperlink is used, not a .txt with a URL in it ... failing on it
   * would report a defect against behaviour that was never promised." The live destination proves
   * CloudFuze agrees: its own Erik E-EmbeddedLinks.csv carried 12 rows, every one a Paper document
   * and not one for the .html, so the document it was failing on was never processed at all.
   *
   * The shared links are created FIRST, above, so the .docx embeds the real Dropbox URLs. If the
   * in-scope link could not be created the .docx is SKIPPED and the reason recorded, rather than
   * embedding a placeholder: a fabricated target can never be rewritten, so 8.1 would fail forever
   * on data that was never valid — unfalsifiable, which is the bug this seeding fixes.
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
    const htmlPath = `${dir}/document-with-embedded-links.html`;
    await this._put(htmlPath, body, opts, report);

    // ── The judged artefact: a real .docx with real hyperlink relationships ──────────────
    //
    // Built with `docx` (already a dependency, used the same way by DriveTestDataAgent), so the
    // links live in word/_rels/document.xml.rels as TargetMode="External" relationships — the
    // thing a migration actually rewrites, and the thing utils/docxLinks reads back.
    //
    // The URLs are deliberately NOT printed as body text. Google auto-links a bare URL when it
    // converts a document, which would add a second anchor carrying the SOURCE address as its own
    // label and fail 8.1 on a document whose real hyperlink was rewritten correctly. That is the
    // false-failure trap the Drive→SharePoint document is seeded to catch, and it is not repeated.
    const docxPath = `${dir}/embedded_link_doc.docx`;
    let docxSeeded = false;
    let docxSkippedReason = null;
    if (inScopeUrl === '') {
      docxSkippedReason = 'the Dropbox shared link for the in-scope target could not be created, '
        + 'so the document would have had to embed a placeholder URL. A target that cannot be '
        + 'rewritten would make feature 8.1 unfalsifiable, so the .docx was skipped instead';
      report.skipped.push({ step: 'embedded link (.docx)', reason: docxSkippedReason });
      log.warn(`Skipped embedded_link_doc.docx: ${docxSkippedReason}`);
    } else {
      try {
        const { Document, Packer, Paragraph, TextRun, ExternalHyperlink } = require('docx');
        const children = [
          new Paragraph({
            children: [new TextRun('Embedded link test document (scope 8.1 / 10.8).')],
          }),
          new Paragraph({ children: [new TextRun('')] }),
          new Paragraph({
            children: [
              new TextRun('Open the in-scope target here: '),
              new ExternalHyperlink({
                children: [new TextRun({ text: 'in-scope target', style: 'Hyperlink' })],
                link: inScopeUrl,
              }),
            ],
          }),
        ];
        if (outOfScopeUrl !== '') {
          children.push(new Paragraph({ children: [new TextRun('')] }));
          children.push(new Paragraph({
            children: [
              new TextRun('And the out-of-scope target here: '),
              new ExternalHyperlink({
                children: [new TextRun({ text: 'out-of-scope target', style: 'Hyperlink' })],
                link: outOfScopeUrl,
              }),
            ],
          }));
        }
        const buffer = await Packer.toBuffer(new Document({ sections: [{ children }] }));
        await this._put(docxPath, buffer, opts, report);
        docxSeeded = true;
      } catch (err) {
        docxSkippedReason = `building or uploading the .docx failed: ${err.message}`;
        report.errors.push({ step: 'embedded link (.docx)', error: err.message });
      }
    }

    // Both documents are named, so the report can tell a reader exactly which file to open and
    // which one carries no verdict — the generic "check an embedded link" instruction nobody can
    // act on is what left this row unverified for so long.
    // ── One document per FORMAT, each pointing at its OWN target ─────────────────────────
    //
    // Scope 8.1 says nothing about file types, and resting the whole feature on a single .docx
    // meant a product that rewrites Word documents but not spreadsheets would have passed. So a
    // .xlsx, a .pdf and a .txt are seeded beside it.
    //
    // Each gets a DIFFERENT target file, deliberately. Sharing one target would let a single
    // rewrite satisfy every format at once — the "one piece of evidence answering several
    // features" defect — and would make it impossible to say WHICH format was left alone.
    const formats = await this._seedEmbeddedLinkFormats(dir, opts, log, report);

    report.embeddedLinks = {
      inScopeUrl,
      outOfScopeUrl,
      judgedDocument: docxSeeded ? docxPath : null,
      judgedDocumentName: 'embedded_link_doc.docx',
      docxSeeded,
      docxSkippedReason,
      contrastDocument: htmlPath,
      contrastDocumentName: 'document-with-embedded-links.html',
      contrastNote: 'Plain HTML is not a supported link-rewrite target under scope 8.1, so this '
        + 'document is reported and never judged.',
      formats,
    };
    const wrote = formats.filter((f) => f.seeded).map((f) => `.${f.format}`).join(', ');
    log.info(
      `Seeded embedded-link documents (.docx ${docxSeeded ? 'written' : 'SKIPPED'}, .html written`
      + `${wrote ? `, ${wrote} written` : ''})`
    );
  }

  /**
   * A .xlsx, a .pdf and a .txt, each carrying a hyperlink to its OWN in-scope target.
   *
   * Returns one row per format describing what was seeded, so the validator can judge each
   * separately and name the ones it could not exercise.
   *
   * The .txt is seeded but marked `judgeable: false`. A plain text file cannot hold a hyperlink —
   * only characters that look like one — so a migration leaving it untouched is not misbehaving,
   * and failing it would report a defect against behaviour nobody promised. It is there to show
   * what happens, which is a different and still useful thing.
   *
   * Every format is independent: a failure building one is recorded against that format alone and
   * never stops the others, because losing all of 8.1 to one bad dependency is exactly the
   * all-or-nothing trap the Paper seeding already had to be rescued from.
   */
  async _seedEmbeddedLinkFormats(dir, opts, log, report) {
    const specs = [
      { format: 'xlsx', judgeable: true, target: 'link-target-for-xlsx.txt', doc: 'embedded_link_doc.xlsx' },
      { format: 'pdf', judgeable: true, target: 'link-target-for-pdf.txt', doc: 'embedded_link_doc.pdf' },
      { format: 'txt', judgeable: false, target: 'link-target-for-txt.txt', doc: 'embedded_link_doc.txt' },
    ];
    const rows = [];

    for (const spec of specs) {
      const row = { format: spec.format, judgeable: spec.judgeable, seeded: false, reason: null };
      try {
        const targetPath = `${dir}/${spec.target}`;
        await this._put(targetPath,
          `${SAMPLE_TXT}I am the in-scope link target for the .${spec.format} document.\n`,
          opts, report);

        const link = await dropboxClient.createSharedLink(targetPath,
          { ...opts, audience: 'public', access: 'viewer' });
        const url = (link && link.url) || '';
        if (!url) {
          // Same rule as the .docx: a document embedding a placeholder URL makes 8.1
          // unfalsifiable, so it is skipped rather than seeded with something unrewritable.
          row.reason = 'the Dropbox shared link for this format\'s target could not be created, so '
            + 'the document would have had to embed a placeholder URL — skipped rather than make '
            + 'the feature unfalsifiable';
          report.skipped.push({ step: `embedded link (.${spec.format})`, reason: row.reason });
          rows.push(row);
          continue;
        }
        row.targetPath = targetPath;
        row.url = url;

        const docPath = `${dir}/${spec.doc}`;
        const buffer = await this._buildEmbeddedLinkFile(spec.format, url);
        await this._put(docPath, buffer, opts, report);
        row.documentPath = docPath;
        row.documentName = spec.doc;
        row.seeded = true;
      } catch (err) {
        row.reason = `building or uploading the .${spec.format} failed: ${err.message}`;
        report.errors.push({ step: `embedded link (.${spec.format})`, error: err.message });
        log.warn(`Embedded-link .${spec.format} not seeded: ${err.message}`);
      }
      rows.push(row);
    }
    return rows;
  }

  /**
   * Build one embedded-link document.
   *
   * The URL is never written as visible body text in the Office and PDF cases. A converter that
   * auto-links a bare URL would add a second anchor carrying the SOURCE address as its own label,
   * and 8.1 would fail on a document whose real hyperlink had been rewritten correctly — the same
   * false-failure trap the .docx is deliberately built to avoid.
   */
  async _buildEmbeddedLinkFile(format, url) {
    if (format === 'xlsx') {
      // exceljs is already a dependency (report generation uses it). A cell hyperlink lands in
      // xl/worksheets/_rels/sheet1.xml.rels as TargetMode="External" — the same relationship shape
      // a .docx uses, which is why one reader can serve both.
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('EmbeddedLinks');
      ws.getCell('A1').value = 'Embedded link test workbook (scope 8.1 / 10.8).';
      ws.getCell('A3').value = { text: 'in-scope target', hyperlink: url };
      return Buffer.from(await wb.xlsx.writeBuffer());
    }
    if (format === 'pdf') {
      // pdfkit is already a dependency (utils/pdfGenerator). `link()` writes a real /URI link
      // annotation, which is what a migration would have to rewrite.
      const PDFDocument = require('pdfkit');
      return await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.fontSize(12).text('Embedded link test document (scope 8.1 / 10.8).');
        doc.moveDown();
        const label = 'in-scope target';
        const x = doc.x; const y = doc.y;
        doc.fillColor('blue').text(label, { underline: true });
        doc.link(x, y, doc.widthOfString(label), doc.currentLineHeight(), url);
        doc.end();
      });
    }
    // Plain text: the URL as characters, which is all a .txt can carry.
    return Buffer.from(
      'Embedded link test file (scope 8.1 / 10.8).\n\n'
      + 'A .txt cannot hold a hyperlink, only text that looks like one. This file is seeded to\n'
      + 'show what the migration does with it, and is reported rather than judged.\n\n'
      + `In-scope target: ${url}\n`
    );
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
   * The Paper document content, as markdown.
   *
   * Every block is separated by a blank line, deliberately. Paper's markdown importer merges
   * adjacent blocks: an earlier draft put a list straight after a table and Paper folded the list
   * INTO the table, so the fidelity comparison would have counted a table where a list belonged.
   * Verified by exporting the created doc back and counting the structures.
   *
   * The 62/63/64-column tables are the boundary the scope document names, so they are generated
   * rather than hand-written — three tables nobody would type correctly by hand.
   */
  _paperMarkdown(root = '/QA-Automation') {
    const table = (cols) => {
      const head = Array.from({ length: cols }, (_, i) => `c${i + 1}`);
      return [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        `| ${head.map((_, i) => i + 1).join(' | ')} |`,
      ].join('\n');
    };

    return [
      '# QA Paper — full feature document', '',
      'Seeded by DropboxTestDataAgent via files/paper/create. Do not edit by hand.', '',
      '## 10.2 Text formatting', '',
      'This paragraph carries **bold**, *italic* and ~~strikethrough~~ text.', '',
      '### A third-level heading', '',
      '## 10.7 Links', '',
      'An external [hyperlink to the spec](https://example.invalid/spec) in a sentence.', '',
      '## 10.8 Dropbox file links', '',
      // The in-scope target must live inside THIS RUN's root, or it is not in scope at all.
      //
      // This was hardcoded to `/QA-Automation`, which is correct only when that happens to be the
      // seeded root. Seeding into `/QA-dropbox-sharepoint` left the "in-scope" link pointing at a
      // folder outside the migration, so CloudFuze could not rewrite it — and its own
      // Erik E-EmbeddedLinks.csv said so plainly, "Parent File/Link Doesn't found", for both links.
      // Validation then reported that as a product defect in feature 9.1/11.8. It was ours.
      `A [link to an in-scope file](https://www.dropbox.com/home${root}/03-File-Formats)`,
      'and a [link to an out-of-scope file](https://www.dropbox.com/home/Elsewhere/other.txt).', '',
      '## 10.9 Tables — the 62 / 63 / 64 column boundary', '',
      table(62), '',
      'Separator paragraph between tables.', '',
      table(63), '',
      'Separator paragraph between tables.', '',
      table(64), '',
      'Separator paragraph after the last table.', '',
      '## 10.11 TO-DO list', '',
      '- [x] a checked item',
      '- [ ] an unchecked item', '',
      'Separator paragraph.', '',
      '## 10.12 Bulleted list', '',
      '- alpha',
      '- beta',
      '- gamma', '',
      'Separator paragraph.', '',
      '## 10.13 Numbered list', '',
      '1. first',
      '2. second',
      '3. third', '',
      'Separator paragraph.', '',
      '## 10.14 Section break', '',
      '---', '',
      'Text after the section break.', '',
      '## 10.15 Code block', '',
      '```',
      'const answer = 42;',
      'function identity(x) { return x; }',
      '```', '',
      '## 10.16 Emojis', '',
      'Emoji line: 🎉 🚀 👍 — and page #4, 2 + 3 = 5, item 7* which are NOT emojis.', '',
      '## 10.3 Inserted image', '',
      '![a referenced image](https://www.gstatic.com/webp/gallery/1.jpg)', '',
      // The GIF for 10.6 is deliberately NOT here — it lives in its own document, see
      // _paperGifMarkdown. Google exports every image as a bare <img> with an empty alt, so two
      // images in ONE document cannot be told apart and 10.3 and 10.6 would have to share a single
      // count. One image per document makes each count attributable to exactly one feature.
      'End of document.', '',
    ].join('\n');
  }

  /**
   * A Paper document holding ONE animated GIF and nothing else — feature 10.6.
   *
   * Separate from the main document on purpose. Google's HTML export gives every image a bare
   * <img> with an empty alt, so two images in one document are indistinguishable and 10.3 and 10.6
   * would have to share one count — the "one piece of evidence answering several features" defect
   * that testImageOriginIsNotGuessed exists to block. One image per document makes each count
   * belong to exactly one feature.
   *
   * A GIF IS seedable: verified by creating a throwaway Paper doc and exporting it back, where the
   * animated GIF survived the import as an image exactly like a JPEG. Scope 10.6 records GIFs as
   * NOT migrating properly, so seeding one is what makes that claim checkable rather than assumed.
   */
  _paperGifMarkdown() {
    return [
      '# QA Paper — GIF only (feature 10.6)',
      '',
      'Seeded by DropboxTestDataAgent. This document holds exactly ONE image, an animated GIF, so',
      'the destination image count belongs to feature 10.6 alone. Do not add another image here.',
      '',
      '![an animated gif](https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth_%28large%29.gif)',
      '',
      // A second, non-image element on purpose. Without it, a document holding ONLY the GIF would
      // count as "empty at the destination" the moment the GIF is dropped — and the empty-document
      // rule hands that to 10.1 by name and excludes the document from every construct feature, so
      // 10.6 would report "not compared" exactly when it had something to say. One link keeps the
      // document non-empty, letting a lost GIF fail 10.6 on its own evidence.
      'A [reference link](https://example.invalid/gif-spec) so this document is not image-only.',
      '',
    ].join('\n');
  }

  /**
   * Seed the Dropbox Paper document — features 10.1 to 10.19.
   *
   * This used to report all nineteen as impossible and print manual authoring steps, on the grounds
   * that "Dropbox retired the Paper authoring API". Only half true: the OLD paper/docs/* namespace is
   * retired, but files/paper/create is its live replacement and accepts markdown. Verified against
   * the QA account, including a files/export round trip, which only a real Paper doc can do.
   *
   * What markdown CANNOT author is reported honestly rather than silently omitted: an @mention, an
   * in-line comment, a Paper timeline, a pasted clipboard image, an embedded media player and a GIF
   * all need the Paper UI. Several of those are among the six the scope document already records as
   * not migrating, so the loss of coverage is smaller than the count suggests.
   *
   * Idempotent by intent: the doc is recreated on every run so its content always matches what the
   * comparison expects. DROPBOX_PRESERVE_ON_WIPE keeps the folder as a safety net for a
   * hand-authored doc, but nothing depends on that any more.
   */
  async _seedPaper(root, opts, log, report) {
    const dir = `${root}/11-Paper`;
    await this._mk(dir, opts, report);

    // The document is created at a path that has NEVER held a file, and the previous run's copies
    // are removed separately. Both halves matter, and the reason is measured:
    //
    //   created at a brand-new path      (e6bdd529, "qa-paper-full (1).paper")  -> full content
    //   left untouched, already existed  (93b0636a and 65439ee5, two docs each) -> full content
    //   DELETED and recreated at the SAME path (93b0636a, 65439ee5)             -> EMPTY at dest
    //
    // The empty case was a 500-byte Google Doc holding no text, while the source held 3 tables,
    // 3 lists, 1 image, 3 links and 3 emojis — and our own export a second after creation returned
    // all of it, so Dropbox had the content and whatever CloudFuze read did not. Seeding Paper
    // first, ~4 minutes before the copy instead of 23 seconds, made no difference: it is not a
    // propagation delay, it is the reused path.
    //
    // This previously deleted the exact target to keep the filename stable across runs, on the
    // grounds that a stable name makes two reports comparable. That is true and it is the lesser
    // concern: a stable name whose content silently fails to migrate is worse than a name that
    // moves. The content counts are what the 10.x features compare, and those pair by path.
    //
    // Reported to CloudFuze as silent content loss, since a customer who deletes and recreates a
    // Paper doc before migrating hits it with no error and a correct-looking filename.
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const path = `${dir}/qa-paper-full-${stamp}.paper`;

    // Clear OUR OWN artifacts from previous runs — matched by the seeded prefix, so a Paper doc a
    // human authored beside them under any other name is left alone. Done here rather than in
    // _wipeRoot because DROPBOX_PRESERVE_ON_WIPE deliberately spares this whole folder.
    try {
      const existing = await dropboxClient.listFolder(dir, opts).catch(() => []);
      const ours = (existing || []).filter((x) => /^qa-paper-.*\.papert?$/i.test(String(x.name || '')));
      for (const doc of ours) {
        await dropboxClient.deletePath(doc.path || `${dir}/${doc.name}`, opts)
          .catch((delErr) => log.warn(`Could not remove old Paper doc ${doc.name}: ${delErr.message}`));
      }
      if (ours.length) {
        log.info(`Cleared ${ours.length} Paper doc(s) seeded by earlier runs: `
          + ours.map((x) => x.name).join(', '));
      }
    } catch (clearErr) {
      log.warn(`Could not clear previous Paper docs (continuing): ${clearErr.message}`);
    }

    try {
      // Retry, because `files/paper/create` fails transiently and each failure costs the whole of
      // §11 — nineteen of this combination's thirty-six features — for that run.
      //
      // Three different transient errors were observed on 2026-09-09/10 alone, all on the same
      // account within hours: `insufficient_permissions` (409), a bare 409, and
      // `Invalid arguments supplied` (400). Each succeeded on a plain retry minutes later, and on
      // 10 Sep the SAME seeding pass failed on /QA-dropbox-sharepoint and succeeded on
      // /QA-Automation moments apart. Dropbox retired the Paper authoring API, so this endpoint is
      // not going to get more reliable.
      //
      // A fresh path per attempt: the note above records that reusing a path that has held a Paper
      // doc produces an EMPTY document at the destination, so a retry must not reuse the one that
      // just failed.
      // Create ONCE, then verify — never retry. `files/paper/create` is not idempotent (every POST
      // makes a document) and it reports failure while succeeding: on run f95a9bb8 all three
      // attempts threw HTTP 400 and all three documents existed afterwards. So look before
      // believing the error, and delete any duplicate the client's own retryWithBackoff produced.
      let made = null;
      try {
        made = await dropboxClient.createPaperDoc(path, this._paperMarkdown(root), opts);
      } catch (err) {
        const found = (await dropboxClient.listFolder(dir, opts).catch(() => []))
          .filter((x) => /^qa-paper-.*\.papert?$/i.test(String(x.name || '')));
        if (found.length === 0) throw err;
        // Keep the first and remove any extras the client's own retry produced, or the §11 counts
        // are summed across duplicates.
        found.sort((x, y) => String(x.name).localeCompare(String(y.name)));
        for (const dup of found.slice(1)) {
          await dropboxClient.deletePath(dup.path || `${dir}/${dup.name}`, opts).catch(() => {});
          log.warn(`Removed duplicate Paper document created by the retry: ${dup.name}`);
        }
        made = { path: found[0].path || `${dir}/${found[0].name}`, revision: null };
        log.warn(`files/paper/create reported "${err.message}" but the document exists at `
          + `${made.path} — treating as created. This endpoint is retired by Dropbox and reports `
          + 'failure while succeeding.');
      }
      if (made.path !== path) {
        // Dropbox still renamed it, so the delete did not take effect — say so rather than let the
        // report compare a document under a name it did not expect.
        log.warn(`Paper document was created as "${made.path}" instead of "${path}" — Dropbox `
          + 'autorenamed it, which should be impossible now the name carries a per-run timestamp. '
          + 'It means a file already existed at that exact path, so the clock or the clear step is '
          + 'wrong; the 10.x counts will aggregate across every Paper doc in the folder.');
      }
      report.created.files += 1;
      log.info(`Seeded Dropbox Paper document at ${made.path} (revision ${made.revision})`);

      // Export it back and count what Paper actually kept. Paper's importer rewrites the markup, so
      // seeding content is not the same as HAVING it — a table the importer folded into a list
      // would make the destination comparison meaningless in a way nothing else would reveal.
      try {
        const back = (await dropboxClient.exportPaper(made.path, 'markdown', opts)).toString('utf8');
        // `-+`, not `-{3,}`. Paper's export writes a table separator as `| - | - |` with a SINGLE
        // dash; requiring three counted 1 table in a document holding 3 and logged "0 code
        // block(s)" for a document that has one. A sanity log that under-reports is worse than
        // none — it says Paper dropped content when Paper kept it.
        //
        // The authority for these counts is paperMarkdownStructure in the dropbox_to_google
        // validator, which is what the destination comparison uses. This is a deliberate small
        // duplicate rather than an import: the validator extends GoogleDriveValidationAgent, and
        // importing it from a seeding agent would couple seeding to the validation graph.
        const kept = {
          tables: (back.match(/^[^\S\n]*\|?[^\S\n]*:?-+:?[^\S\n]*(\|[^\S\n]*:?-+:?[^\S\n]*)+\|?[^\S\n]*$/gm) || []).length,
          codeFences: (back.match(/```/g) || []).length,
          // Paper does NOT keep the ``` it was given — it rewrites the block as 4-space indented
          // lines. Measured on the real export of qa-paper-full-20260910070125.paper: 0 fences and
          // 2 indented code lines, for a document seeded with one fenced block. Logging only the
          // fence count said "0 code fence(s) survived" about a code block that survived fine.
          codeLines: (back.match(/^ {4}\S.*$/gm) || []).length,
          // Paper also drops the leading `- ` from a `- [x]` item, exporting it as `[x] text`.
          // Counted here so the seeding log shows the to-do items really are in the document.
          todo: (back.match(/^[^\S\n]*(?:[-*+][^\S\n]+)?\[[ xX]\](?=\s)/gm) || []).length,
          links: (back.match(/\[[^\]]*\]\([^)]*\)/g) || []).length,
        };
        // Fences reported as a raw count, not divided into "blocks": Paper may export a code block
        // without fences at all, and halving an odd number would invent a fraction of a block.
        log.info(`Paper round trip: ${kept.tables} table(s), ${kept.codeLines} code line(s) `
          + `(${kept.codeFences} fence marker(s) — Paper converts fences to indentation), `
          + `${kept.todo} TO-DO item(s), ${kept.links} link(s) survived the import`);
        report.paperSeeded = { path: made.path, revision: made.revision, kept };

        // An EMPTY document is worse than no document, and the recovery above could produce one.
        //
        // On run 30e0806d files/paper/create threw, the catch found a file at the path, and the
        // document was treated as created — but it was a 0-byte shell. The round trip then read
        // "0 table(s), 0 code line(s), 0 TO-DO item(s), 0 link(s)" for a document seeded with three
        // tables, a code block, two to-do items and three links, and every §10 construct feature
        // was excluded from the run as "empty at the destination".
        //
        // So existence is not the test — CONTENT is. When the export comes back with nothing, the
        // shell is deleted and the document is created once more at a fresh path. Fresh, because
        // the measured rule still holds: a path that has held a Paper document produces an empty
        // one when reused.
        const survived = kept.tables + kept.codeLines + kept.todo + kept.links;
        if (survived === 0) {
          log.warn(`The Paper document at ${made.path} came back EMPTY on export — files/paper/create `
            + 'left a shell rather than a document. Deleting it and creating the document once more '
            + 'at a fresh path.');
          await dropboxClient.deletePath(made.path, opts).catch((delErr) =>
            log.warn(`Could not delete the empty Paper shell: ${delErr.message}`));
          const retryPath = `${dir}/qa-paper-full-${stamp}-r2.paper`;
          try {
            const again = await dropboxClient.createPaperDoc(retryPath, this._paperMarkdown(root), opts);
            const back2 = (await dropboxClient.exportPaper(again.path, 'markdown', opts)).toString('utf8');
            const ok = /\S/.test(back2) && back2.length > 200;
            log.info(`Second attempt at ${again.path}: ${back2.length} byte(s) exported back`);
            if (ok) {
              report.paperSeeded = { path: again.path, revision: again.revision, retried: true };
            } else {
              report.notSeeded.push({
                feature: 'Dropbox Paper document content (scope 10.2-10.19)',
                reason: 'files/paper/create produced an EMPTY document twice, so the Paper content '
                  + 'features cannot be exercised this run. The document exists but holds nothing; '
                  + 'this is a Dropbox endpoint failure, not a migration result.',
                manualSteps: [],
              });
              log.warn('Second attempt was also empty — Paper content features are not exercised.');
            }
          } catch (retryErr) {
            report.notSeeded.push({
              feature: 'Dropbox Paper document content (scope 10.2-10.19)',
              reason: `The first Paper document came back empty and the retry failed: `
                + `${retryErr.message}. Paper content features are not exercised this run.`,
              manualSteps: [],
            });
            log.warn(`Retry of the Paper document failed: ${retryErr.message}`);
          }
        }
      } catch (exportErr) {
        log.warn(`Paper created but could not be exported back (${exportErr.message}) — content `
          + 'was not verified, so the destination comparison may measure something unexpected');
      }
    } catch (err) {
      report.errors.push({ step: 'Dropbox Paper document', error: err.message });
      log.warn(`Could not seed the Paper document: ${err.message}`);
      return;
    }

    // The GIF document — feature 10.6. Created SECOND and in its own try/catch, so a transient
    // files/paper/create failure (this endpoint is retired and fails intermittently — three
    // different errors were seen on one account in a day) costs 10.6 alone instead of taking the
    // other eighteen §10 features with it.
    try {
      const gifPath = `${dir}/qa-paper-gif-${stamp}.paper`;
      let gif;
      try {
        gif = await dropboxClient.createPaperDoc(gifPath, this._paperGifMarkdown(), opts);
      } catch (gifErr) {
        // Same "reports failure while succeeding" behaviour as the main document — look before
        // believing the error, or the retry leaves a duplicate that doubles the 10.6 image count.
        const found = (await dropboxClient.listFolder(dir, opts).catch(() => []))
          .filter((x) => /^qa-paper-gif-.*\.papert?$/i.test(String(x.name || '')));
        if (found.length === 0) throw gifErr;
        found.sort((x, y) => String(x.name).localeCompare(String(y.name)));
        for (const dup of found.slice(1)) {
          await dropboxClient.deletePath(dup.path || `${dir}/${dup.name}`, opts).catch(() => {});
          log.warn(`Removed duplicate GIF Paper document created by the retry: ${dup.name}`);
        }
        gif = { path: found[0].path || `${dir}/${found[0].name}`, revision: null };
        log.warn(`files/paper/create reported "${gifErr.message}" but the GIF document exists at `
          + `${gif.path} — treating as created.`);
      }
      report.created.files += 1;
      log.info(`Seeded the GIF-only Paper document for feature 10.6 at ${gif.path}`);
    } catch (gifErr) {
      report.notSeeded.push({
        feature: 'Dropbox Paper GIF document (scope 10.6)',
        reason: `files/paper/create failed for the GIF-only document: ${gifErr.message}. Feature `
          + '10.6 is therefore not exercised this run; every other §10 feature is unaffected '
          + 'because the main document was created separately and succeeded.',
        manualSteps: [],
      });
      log.warn(`Could not seed the GIF Paper document (10.6 not exercised): ${gifErr.message}`);
    }

    // Only the genuinely UI-only elements remain manual.
    report.notSeeded.push({
      feature: 'Paper elements that markdown cannot express (10.4, 10.5, 10.6, 10.10, 10.17, 10.18)',
      reason:
        'files/paper/create imports MARKDOWN, and markdown has no syntax for an @mention, an '
        + 'in-line comment, a Paper timeline, a pasted clipboard image, an embedded media player or '
        + 'a GIF. Those six need the Paper UI. Four of them (10.6 GIFs, 10.17 mentions, 10.18 '
        + 'comments, and 10.2 highlight colours) are already recorded by the scope document as NOT '
        + 'migrating, so the coverage actually lost is 10.4, 10.5 and 10.10.',
      manualSteps: [
        `Open ${path} in the Dropbox UI to add the six elements above, if those features are needed`,
        'Everything else in the document — formatting, headings, links, the 62/63/64-column tables, '
          + 'lists, to-do items, section break, code block, emojis and an image — is seeded '
          + 'automatically on every run',
      ],
    });
  }

  /**
   * Scope 10.1–10.19 — Dropbox Paper. SUPERSEDED by _seedPaper; kept only for reference.
   *
   * The claim below — that no Paper feature can be seeded by API — was wrong, and cost the
   * combination nineteen features until 04-Sep-2026. The retired endpoints are the OLD paper/docs/*
   * namespace; files/paper/create is the live replacement and imports markdown. Nothing calls this
   * method any more.
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
    const root = dropboxClient.dbxPath(
      context.sourcePath || context.sourceFolderName || env.DROPBOX_TEST_ROOT
    );
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
