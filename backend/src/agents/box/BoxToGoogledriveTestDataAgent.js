/**
 * Seeds Box source data for the Box → Google My Drive combination.
 *
 * Every seeding method traces to a numbered row in
 * `backend/data/feature-scope/box-to-google-testdata.md`, which enumerates the 34 in-scope features
 * from `box-to-google-inscope.md`. The row number is named in each `_seed*` method's comment.
 *
 * This is a NEW file, deliberately separate from `agents/box/BoxTestDataAgent.js`. That agent is
 * shared by `box→sharepoint` and `box→onedrive`, so it cannot be edited for this combination without
 * risking both of those — CONTRIBUTING's "one combination = its own files" rule. It IS reused as a
 * reference for the working Box API patterns (`boxClient` usage, versions, long paths, shared links).
 * The root folder itself follows Dropbox's fixed-root-wipe-and-reuse pattern instead of
 * BoxTestDataAgent's incrementing-suffix one: `_wipeRootByName` recursively deletes any existing
 * root-level folder with this run's name before `createFolder` runs, so the same name is always this
 * run's data. Incrementing left every previous run's folder behind with no signal which one was
 * current — confirmed as user-facing confusion (fresh seeding looked "stale" because the person was
 * looking at an old numbered folder, not the one just created).
 *
 * One thing that looked like a permanent gap but is not, stated up front so nobody "fixes" it back:
 *
 *   - **Box Notes (scope 10.1-10.16) ARE seeded with real content**, via `boxClient.createNote`
 *     (Box's `POST /2.0/notes/convert`, released May 2026 — Box API 2026.0+). This repo's earlier
 *     code assumed Box had no public Notes-authoring API at all and uploaded a hand-built JSON file
 *     with a `.boxnote` extension through the generic upload endpoint instead — confirmed live
 *     (2026-09-15) that Box does NOT recognise a file created that way as an actual Note (it carries
 *     only generic `extracted_text`/`embedded_metadata` representations). The real endpoint converts
 *     genuine Markdown into a real `.boxnote` file. See `boxNoteMarkdown` and `_seedBoxNotes` for what
 *     Markdown can and cannot express — a handful of UI-only elements (font size/colour, alignment, a
 *     real @mention, a pasted clipboard image, and the upload-from-computer / link-preview image
 *     methods specifically) still have no API equivalent and are reported NOT SEEDED with manual
 *     steps, but that list is now five items, not sixteen.
 *
 * One deliberate non-feature:
 *
 *   - **Delta (scope 1.3) is a SEPARATE PASS.** `applyDeltaChanges()` mutates an already-seeded and
 *     already-migrated tree. It is not called from `execute()` because a delta is only meaningful
 *     after a one-time migration has completed — same reasoning as
 *     `DropboxTestDataAgent.applyDeltaChanges`.
 *
 * Permission and shared-link grants need real principals (an internal user, an external address, a
 * group). BoxToGoogledriveTestDataAgent resolves the internal grantee dynamically from the run's real
 * managed users (`boxClient.getUsers`), falling back to `BOX_TEST_INTERNAL_USER(S)` only when that
 * lookup finds nobody else. External addresses and groups have no such dynamic source and come only
 * from env — see `config/env.js`. A grantee that cannot be resolved SKIPS that class of grant with a
 * warning; it never fails the run, because a missing QA account is a configuration gap, not a defect.
 */
const { BaseAgent } = require('../core/BaseAgent');
const boxClient = require('../../clients/boxClient');
const logger = require('../../utils/logger');
const env = require('../../config/env');

// ── Sample content ────────────────────────────────────────────────────────────
// Distinct, recognisable bytes per format, kept small: the comparison checks structure, permissions
// and hashes, and a large payload only slows every run down.

const SAMPLE_TXT = `Box QA — plain text
Seeded by BoxToGoogledriveTestDataAgent for the Box to Google My Drive migration QA flow.
This file is a pass-through format: it must arrive at Google byte-for-byte identical.
`;

const SAMPLE_CSV = `ID,Name,Email,Department,Role
1,Ada Lovelace,ada@example.com,Engineering,Editor
2,Alan Turing,alan@example.com,Research,Viewer
3,Grace Hopper,grace@example.com,Engineering,Editor
`;

const SAMPLE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Box QA</title></head>
<body><h1>Box QA</h1><p>Seeded HTML document.</p></body></html>
`;

const SAMPLE_JSON = JSON.stringify(
  { seededBy: 'BoxToGoogledriveTestDataAgent', purpose: 'Box to Google My Drive migration QA', version: 1 },
  null,
  2
);

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qa><seededBy>BoxToGoogledriveTestDataAgent</seededBy><format>xml</format></qa>
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

/** Legacy Office extension, to exercise the .doc → Google conversion path. */
const SAMPLE_DOC = Buffer.alloc(2048, 0x41);

/** Bytes for a 4-version file (scope 3.1 / 3.2). */
const VERSION_BODIES = [
  'Box QA — version 1 of 4.\n',
  'Box QA — version 2 of 4. Content changed.\n',
  'Box QA — version 3 of 4. Content changed again.\n',
  'Box QA — version 4 of 4, the latest.\n',
];

/**
 * Characters Box permits in a name that SharePoint would reject, but Google accepts unchanged.
 *
 * Scope 8.1 expects **no replacement** on a Google destination. `\` and `/` are excluded because Box
 * itself treats them as path separators and rejects them in a single segment name.
 */
const SPECIAL_CHARS_NAME = 'Special ~!@#$%^&()_+[]{};,.= chars';

/**
 * Markdown for a REAL Box Note, created via `boxClient.createNote` (Box's `POST /2.0/notes/convert`,
 * released May 2026 — see the comment on that function). SUPERSEDES the earlier assumption that Box
 * had no public Notes-authoring API: that was checked against the OLD generic-upload workaround only,
 * confirmed live (2026-09-15) to produce a file Box does not treat as a real Note. This endpoint is
 * the real one, and mirrors exactly how DropboxTestDataAgent._paperMarkdown feeds `files/paper/create`.
 *
 * What plain Markdown cannot express is reported honestly in `_seedBoxNotes`'s `notSeeded` entry
 * rather than silently skipped: font size/colour, text alignment, an @mention, a pasted clipboard
 * image, and the specific UI *method* used to insert an image (10.6 "upload from computer" and 10.8
 * "insert link preview" are indistinguishable from an ordinary markdown image reference — only 10.7,
 * "insert via Box shared link", can be represented faithfully, by embedding a real `app.box.com/s/…`
 * link to a file already seeded in this same run). 10.14 (Box Notes Comments) is NOT expressible in
 * Markdown either, but is seeded separately via `boxClient.addComment` after the Note is created —
 * comments are their own Box object, not part of a file's content.
 */
function boxNoteMarkdown(sharedImageUrl) {
  const table = (cols) => {
    const head = Array.from({ length: cols }, (_, i) => `c${i + 1}`);
    return [
      `| ${head.join(' | ')} |`,
      `| ${head.map(() => '---').join(' | ')} |`,
      `| ${head.map((_, i) => i + 1).join(' | ')} |`,
    ].join('\n');
  };

  return [
    '# QA Box Note — full feature document', '',
    'Seeded by BoxToGoogledriveTestDataAgent via POST /2.0/notes/convert. Do not edit by hand.', '',
    '## 10.2 Text formatting', '',
    'This paragraph carries **bold**, *italic*, ~~strikethrough~~ and `inline code` text.', '',
    '## 10.4 Checklist, numbered list, bulleted list', '',
    '- [x] a checked checklist item',
    '- [ ] an unchecked checklist item', '',
    '1. first numbered item',
    '2. second numbered item',
    '3. third numbered item', '',
    '- alpha bulleted item',
    '- beta bulleted item',
    '- gamma bulleted item', '',
    '## 10.5 Tables', '',
    table(5), '',
    '## 10.7 Insert Image (Box Shared Link)', '',
    sharedImageUrl ? `![an image inserted via a real Box shared link](${sharedImageUrl})`
      : '(no shared image link was available when this Note was seeded — see notSeeded)', '',
    '## 10.10 Emojis', '',
    'Emoji line: 🙂 🎉 🚀 👍 ❤️', '',
    '## 10.11 GIFs', '',
    '![a gif](https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif)', '',
    '## 10.12 Unicode symbols', '',
    'Symbols: ♠ ♣ ♥ ♦ ∞ € £ ¥ © ® ™ α β γ', '',
    '## 10.15 Links', '',
    'A bare pasted link: https://www.box.com', '',
    '## 10.16 Hyperlinks', '',
    'Styled hyperlink text: [Click here](https://www.box.com)', '',
    'End of document.', '',
  ].join('\n');
}

class BoxToGoogledriveTestDataAgent extends BaseAgent {
  constructor() {
    super('BoxToGoogledriveTestDataAgent');
  }

  /**
   * Seed the Box source tree.
   *
   * @param {import('../../models/MigrationContext')} context
   * @returns {Promise<object>} a report of what was created, skipped and left manual
   */
  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });

    const adminEmail = context.sourceAdminEmail || context.adminEmail || context.sourceEmail;
    if (!adminEmail) {
      throw new Error(
        'No admin/source email in context — BoxToGoogledriveTestDataAgent needs one to obtain a Box '
        + 'token (BOX_ENTERPRISE_ID client-credentials, a connected Box OAuth account, or '
        + 'BOX_DEVELOPER_TOKEN — see .env.example).'
      );
    }
    const token = await boxClient.getValidToken(adminEmail);

    // As-User: seed into the actual SOURCE account when it differs from the admin/service token,
    // exactly as boxToSharepoint.js and BoxTestDataAgent._seedLongPathFiles already resolve it.
    let asUserId = context.boxTargetUserId || null;
    let sourceLogin = String(adminEmail).toLowerCase();
    if (!asUserId && context.sourceEmail
        && String(context.sourceEmail).toLowerCase() !== sourceLogin) {
      try {
        const u = await boxClient.getBoxUserByEmail(adminEmail, context.sourceEmail);
        if (u) {
          asUserId = u.id;
          sourceLogin = String(u.login || context.sourceEmail).toLowerCase();
        } else {
          log.warn(`${context.sourceEmail} is not a Box managed user under this enterprise — `
            + 'seeding against the admin/service token\'s own account instead.');
        }
      } catch (err) {
        log.warn(`Box managed-user lookup failed (${err.message}) — seeding against the admin/service `
          + 'token\'s own account');
      }
    }

    const grantees = await this._resolveGrantees(adminEmail, sourceLogin, log);

    // Root folder at Box account root '0' — a FIXED name, wiped and reused on every run, matching
    // Dropbox's fixed-root-wipe-and-reuse pattern. Previously this incremented a numeric suffix on a
    // 409 conflict instead (Box-to-MyDrive-QA-lavanya, ...1, ...2, ...3, ...), which meant every run
    // left the last run's folder behind and a human had to know which numbered folder was "current" —
    // confirmed as user-facing confusion (a run's timestamps looked stale because the person was
    // looking at an old leftover folder, not the one the run just created). Wipe-and-reuse means the
    // folder named `BASE_ROOT_NAME` is always this run's data.
    const BASE_ROOT_NAME = (context.sourceFolderName || '').trim() || 'Agent Box-Google Data';
    let rootFolder;
    const rootFolderName = BASE_ROOT_NAME;
    if (context.skipCleanup !== true) {
      await this._wipeRootByName(BASE_ROOT_NAME, token, asUserId, log);
    }
    try {
      rootFolder = await boxClient.createFolder(BASE_ROOT_NAME, '0', token, asUserId);
    } catch (err) {
      if (err?.response?.status === 409) {
        // Lost a race, or the wipe above failed/was skipped — one more wipe-and-retry before giving up.
        log.warn(`Box folder "${BASE_ROOT_NAME}" still exists after cleanup — retrying once`);
        await this._wipeRootByName(BASE_ROOT_NAME, token, asUserId, log);
        rootFolder = await boxClient.createFolder(BASE_ROOT_NAME, '0', token, asUserId);
      } else {
        throw err;
      }
    }

    // AgentOrchestrator gates the whole content source-capture block on `rootFolderName`, and inside
    // it reads `rootFolderId` to give CloudFuze a real folder id as fromRootId (see the comment in
    // DropboxTestDataAgent.execute(), which names this exact contract — grep AgentOrchestrator.js for
    // `sourceData.rootFolderName` / `sourceData.rootFolderId`). Both are set at the top level, not
    // nested under a `scenarios` object, matching what the orchestrator actually reads.
    const report = {
      rootFolderId: rootFolder.id,
      rootFolderName,
      asUserId: asUserId || null,
      testType: context.testType || 'E2E',
      created: { folders: 0, files: 0, versions: 0, links: 0, grants: 0, comments: 0 },
      skipped: [],
      notSeeded: [],
      errors: [],
      items: [],
      grantees,
    };

    log.info(`Seeding Box test data under "${rootFolderName}" (id=${rootFolder.id}, `
      + `testType=${report.testType})`);

    // Each phase covers a disjoint set of features (2.x permissions, 5.x links, 7.1 long path, …),
    // so one phase throwing must not cost every phase after it. `_grant` and the per-target loop in
    // `_seedSharedLinks` already catch the failures they EXPECT (a role Box refuses, a link type an
    // account can't grant) — this catches the ones they don't, e.g. a plain folder/file create
    // returning an unexpected 400. Measured live: `_seedSharedLinks` threw on an uncaught `_mk`/`_put`
    // call and took out every phase after it (timestamps, special characters, long path, embedded
    // links, versions, the in-line comment, all 16 Box Notes features) even though none of them touch
    // shared links at all. `_run` records the real Box error body (not axios's opaque "Request failed
    // with status code 400") and moves on, so a single bad call costs one phase, not the other twelve.
    const phases = [
      ['2.1-2.5 permission ladder', () => this._seedPermissionLadder(rootFolder.id, token, asUserId, grantees, log, report)],
      ['permission matrix (role breadth)', () => this._seedPermissionMatrix(rootFolder.id, token, asUserId, grantees, log, report)],
      ['team-wide vs restricted access', () => this._applyAccessMode(rootFolder.id, token, asUserId, grantees, log, report)],
      ['1.1/1.2 root files', () => this._seedRootFiles(rootFolder.id, token, asUserId, log, report)],
      ['5.1/5.2 shared links', () => this._seedSharedLinks(rootFolder.id, token, asUserId, log, report)],
      ['4.1 timestamps', () => this._seedTimestampFiles(rootFolder.id, token, asUserId, log, report)],
      ['8.1 special characters', () => this._seedSpecialCharacterNames(rootFolder.id, token, asUserId, log, report)],
      ['7.1 long path', () => this._seedLongPath(rootFolder.id, token, asUserId, log, report)],
      ['9.1 embedded links', () => this._seedEmbeddedLinks(rootFolder.id, token, asUserId, log, report)],
      ['3.1/3.2 versions', () => this._seedVersions(rootFolder.id, token, asUserId, log, report)],
      ['6.1 in-line comment', () => this._seedInlineComment(rootFolder.id, token, asUserId, log, report)],
      ['10.1-10.16 Box Notes', () => this._seedBoxNotes(rootFolder.id, token, asUserId, log, report)],
    ];
    for (const [label, phase] of phases) {
      try {
        await phase();
      } catch (err) {
        const boxErr = err?.response?.data || {};
        const detail = boxErr.code || boxErr.message
          ? `${err?.response?.status || ''} ${boxErr.code || ''} ${boxErr.message || ''}`.trim()
          : err.message;
        log.error(`Phase "${label}" failed and was skipped — the rest of the seeding continues: ${detail}`);
        report.errors.push({ step: label, error: detail });
      }
    }

    // 11.1: every grant above already used notify:false (boxClient.createCollaboration /
    // createGroupCollaboration default `suppressNotify = true`), so no destination-side email
    // notification is expected for any of them. Recorded here rather than re-derived by the
    // validator, which has no way to see what parameter a collaboration call used.
    report.notificationsSuppressed = true;

    report.summary = this._summarize(report);
    log.info(report.summary);
    return report;
  }

  /**
   * Who the seeded grants go to.
   *
   * Internal grantee resolution is DYNAMIC-FIRST, the opposite order from
   * `DropboxTestDataAgent._resolveGrantees`: Box's enterprise `getUsers` call is cheap and already
   * proven in `BoxTestDataAgent._seedLongPathFiles`, so a real second managed user is preferred over an
   * env override. External addresses and groups have no such dynamic source (Box's API can list
   * managed users, but not people outside the enterprise, and `boxClient` has no group-listing
   * endpoint at all — see the comment on BOX_TEST_GROUP in config/env.js) and come from env only.
   */
  async _resolveGrantees(adminEmail, sourceLogin, log) {
    let internalUsers = [];
    try {
      const users = await boxClient.getUsers(adminEmail);
      internalUsers = users
        .map((u) => String(u.login || '').toLowerCase())
        .filter((login) => login && login !== sourceLogin && login !== String(adminEmail).toLowerCase());
    } catch (err) {
      log.warn(`Box managed-user listing failed (${err.message}) — falling back to `
        + 'BOX_TEST_INTERNAL_USER(S). This needs an enterprise admin token (Client Credentials Grant + '
        + 'BOX_ENTERPRISE_ID); a plain OAuth user token cannot list managed users.');
    }
    if (internalUsers.length === 0) {
      internalUsers = env.BOX_TEST_INTERNAL_USERS.length
        ? env.BOX_TEST_INTERNAL_USERS
        : (env.BOX_TEST_INTERNAL_USER ? [env.BOX_TEST_INTERNAL_USER] : []);
    }
    const internal = internalUsers[0] || '';

    const external = env.BOX_TEST_EXTERNAL_USER || '';
    const groupIds = env.BOX_TEST_GROUPS.length
      ? env.BOX_TEST_GROUPS
      : (env.BOX_TEST_GROUP ? [env.BOX_TEST_GROUP] : []);

    if (!internal) {
      log.warn('No internal grantee available (no other Box managed user found, and '
        + 'BOX_TEST_INTERNAL_USER(S) is unset) — every user permission (scope 2.1-2.4) will be SKIPPED.');
    }
    if (!external) {
      log.warn('No BOX_TEST_EXTERNAL_USER — external shares (scope 2.5) will be SKIPPED.');
    }
    if (groupIds.length === 0) {
      log.warn('No BOX_TEST_GROUP(S) — group grants will be SKIPPED. Box addresses a group by numeric '
        + 'id; boxClient has no group-listing endpoint to resolve a display name.');
    }
    log.info(`Grantees: ${internalUsers.length} internal user(s) available (using ${internal || '(none)'}), `
      + `${groupIds.length} group(s), ${external ? 1 : 0} external`);

    return {
      internal,
      internalUsers,
      external,
      groupIds,
      everyoneGroupId: env.BOX_TEST_EVERYONE_GROUP || '',
    };
  }

  /**
   * Delete the root-level Box folder named `name`, if one exists, so this run's `createFolder` gets a
   * clean slate instead of colliding with a previous run's leftovers. A recursive delete (Box's
   * `?recursive=true`) removes the whole tree in one call — cheap here because nothing outside this
   * agent's own seeded root is ever named this, so there is nothing else to preserve.
   */
  async _wipeRootByName(name, token, asUserId, log) {
    try {
      const items = await boxClient.getFolderItems('0', token, asUserId);
      const existing = items.find((i) => i.type === 'folder' && i.name === name);
      if (!existing) {
        log.info(`Nothing to clear — no existing "${name}" folder at Box account root`);
        return;
      }
      await boxClient.deleteBoxItem('folder', existing.id, token, asUserId);
      log.info(`Cleared existing Box folder "${name}" (id=${existing.id})`);
    } catch (err) {
      // Non-fatal: an absent root is the normal first-run case, and a failed wipe still lets
      // createFolder below surface a 409 the caller retries once.
      log.warn(`Could not clear existing "${name}" folder (continuing): ${err.message}`);
    }
  }

  /** Create a folder and count it. */
  async _mk(name, parentId, token, asUserId, report) {
    const item = await boxClient.createFolder(name, parentId, token, asUserId);
    report.created.folders += 1;
    report.items.push({ type: 'folder', name, id: item.id, parentId });
    return item;
  }

  /** Upload a file and count it. */
  async _put(name, body, parentId, token, asUserId, report, opts = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const item = await boxClient.uploadFile(name, buf, parentId, token, asUserId, opts);
    report.created.files += 1;
    report.items.push({ type: 'file', name, id: item.id, parentId, bytes: buf.length });
    return item;
  }

  /**
   * Grant access, tolerating a principal or role Box refuses.
   *
   * A failed grant is recorded and seeding continues: one unresolvable QA address or a Box account
   * policy must not cost the whole run, and the report has to distinguish "not granted" from "granted
   * and lost in migration" — exactly what the validator is later asked to judge.
   */
  async _grant(itemType, itemId, member, role, token, asUserId, report, label) {
    if (!member || (!member.email && !member.groupId)) {
      report.skipped.push({ step: label, reason: 'no principal configured' });
      return false;
    }
    try {
      if (member.groupId) {
        await boxClient.createGroupCollaboration(itemType, itemId, member.groupId, role, token, true, asUserId);
      } else {
        await boxClient.createCollaboration(itemType, itemId, member.email, role, token, true, asUserId);
      }
      report.created.grants += 1;
      return true;
    } catch (err) {
      const status = err?.response?.status;
      const boxErr = err?.response?.data || {};
      const code = String(boxErr.code || '');
      const message = String(boxErr.message || err.message || '');

      // A collaboration that already exists is not a failure — a re-run of the same seeding logic
      // against a fresh root cannot normally hit this (each root is new), but a shared principal
      // invited twice on the SAME item (e.g. by the permission ladder and the matrix both reaching
      // the same folder) can. Counted as granted rather than as an error.
      if (status === 409 || code === 'user_already_collaborator') {
        report.created.grants += 1;
        return true;
      }

      // Box enterprises commonly restrict inviting collaborators from outside the enterprise
      // ("Invite people outside <enterprise> to collaborate" toggled off in the admin console). That
      // is an account policy, not a migration defect, so it is reported as NOT SEEDED — the same
      // treatment DropboxTestDataAgent gives `cant_share_outside_team`.
      const outsideEnterpriseBlocked = /outside.*enterprise|not.*allowed.*invite|restricted_collaboration/i
        .test(`${code} ${message}`);
      if (outsideEnterpriseBlocked) {
        report.notSeeded.push({
          feature: label,
          reason: 'This Box enterprise does not permit inviting collaborators from outside it '
            + `(HTTP ${status}, ${code || message}). A source-account policy, not a migration defect — `
            + 'the external half of this position cannot be exercised here. Enable "Invite people '
            + 'outside <enterprise> to collaborate" in the Box admin console, or point '
            + 'BOX_TEST_EXTERNAL_USER at an address already known to this enterprise.',
          manualSteps: [],
        });
        logger.warn(`[box-seed] ${label} unavailable on this account — reported as not seeded`);
        return false;
      }

      report.errors.push({ step: label, error: message || `HTTP ${status}` });
      logger.warn(`[box-seed] ${label} failed: ${message || status}`);
      return false;
    }
  }

  /**
   * Scope 2.1-2.5 — the permission ladder.
   *
   * Position is the point, per box-to-google-inscope.md: the same grant is checked at the root
   * folder, a sub-folder, the root file and an inner file, because a run that only proves the root
   * proves nothing about how Box collaborations are read at depth. Each position gets its OWN
   * explicit grant, at both Editor and Viewer, to both a user and a group.
   */
  async _seedPermissionLadder(rootId, token, asUserId, grantees, log, report) {
    const userMember = grantees.internal ? { email: grantees.internal } : null;
    const groupMember = grantees.groupIds[0] ? { groupId: grantees.groupIds[0], displayName: `group ${grantees.groupIds[0]}` } : null;
    const externalMember = grantees.external ? { email: grantees.external } : null;

    // 2.1 — root folder.
    const rootFolder = await this._mk('01-Root-Folder-Permissions', rootId, token, asUserId, report);
    await this._grant('folder', rootFolder.id, userMember, 'editor', token, asUserId, report,
      '2.1 Root Folder Permissions -> user editor');
    await this._grant('folder', rootFolder.id, groupMember, 'viewer', token, asUserId, report,
      '2.1 Root Folder Permissions -> group viewer');

    // 2.2 — sub-folders at two depths.
    const sub1 = await this._mk('Sub-Level-1', rootFolder.id, token, asUserId, report);
    await this._grant('folder', sub1.id, userMember, 'viewer', token, asUserId, report,
      '2.2 Sub Folder Permissions -> user viewer (L1)');
    const sub2 = await this._mk('Sub-Level-2', sub1.id, token, asUserId, report);
    await this._grant('folder', sub2.id, groupMember, 'editor', token, asUserId, report,
      '2.2 Sub Folder Permissions -> group editor (L2)');

    // 2.3 — root file, both levels.
    const rootFileEdit = await this._put('02-root-file-editor.txt', SAMPLE_TXT, rootId, token, asUserId, report);
    await this._grant('file', rootFileEdit.id, userMember, 'editor', token, asUserId, report,
      '2.3 Root File Permissions -> user editor');
    const rootFileView = await this._put('02-root-file-viewer.txt', SAMPLE_TXT, rootId, token, asUserId, report);
    await this._grant('file', rootFileView.id, userMember, 'viewer', token, asUserId, report,
      '2.3 Root File Permissions -> user viewer');
    await this._grant('file', rootFileView.id, groupMember, 'viewer', token, asUserId, report,
      '2.3 Root File Permissions -> group viewer');

    // 2.4 — inner files inside the sub-folders above.
    const inner1 = await this._put('inner-file-editor.txt', SAMPLE_TXT, sub1.id, token, asUserId, report);
    await this._grant('file', inner1.id, userMember, 'editor', token, asUserId, report,
      '2.4 Inner File Permissions -> user editor (L1)');
    const inner2 = await this._put('inner-file-viewer.csv', SAMPLE_CSV, sub2.id, token, asUserId, report);
    await this._grant('file', inner2.id, userMember, 'viewer', token, asUserId, report,
      '2.4 Inner File Permissions -> user viewer (L2)');
    await this._grant('file', inner2.id, groupMember, 'viewer', token, asUserId, report,
      '2.4 Inner File Permissions -> group viewer (L2)');

    // 2.5 — external share.
    const extFolder = await this._mk('05-External-Shares', rootId, token, asUserId, report);
    const extFile = await this._put('shared-outside.txt', SAMPLE_TXT, extFolder.id, token, asUserId, report);
    if (externalMember) {
      await this._grant('folder', extFolder.id, externalMember, 'viewer', token, asUserId, report,
        '2.5 External Shares -> folder viewer');
      await this._grant('file', extFile.id, externalMember, 'editor', token, asUserId, report,
        '2.5 External Shares -> file editor');
    } else {
      report.skipped.push({
        step: 'external shares (scope 2.5)',
        reason: 'BOX_TEST_EXTERNAL_USER not set — needs an address outside this Box enterprise',
      });
    }
  }

  /**
   * Breadth: every Box collaboration role, on a folder and a file, against a user and a group.
   *
   * The ladder above covers POSITION; this covers the full ROLE vocabulary the role map has to
   * translate — including the three roles with no clean Google equivalent (`previewer`, `co-owner`,
   * `uploader`), so `validation/roleMaps/box_to_google.js`'s nuances are actually exercised rather than
   * left theoretical.
   */
  async _seedPermissionMatrix(rootId, token, asUserId, grantees, log, report) {
    const users = grantees.internalUsers.length ? grantees.internalUsers : (grantees.internal ? [grantees.internal] : []);
    const groups = grantees.groupIds.map((id) => ({ groupId: id, displayName: `group ${id}` }));

    if (users.length === 0 && groups.length === 0) {
      report.skipped.push({
        step: 'permission matrix (role breadth)',
        reason: 'no internal user or group configured — nothing to grant',
      });
      return;
    }

    const container = await this._mk('13-Permission-Matrix', rootId, token, asUserId, report);
    const roles = ['editor', 'viewer', 'previewer', 'co-owner', 'uploader'];
    log.info(`Permission matrix: ${roles.length} role(s) x ${users.length} user(s), `
      + `${groups.length} group(s)`);

    for (const [i, role] of roles.entries()) {
      const safeRole = role.replace(/\s+/g, '-');
      const folder = await this._mk(`folder_${safeRole}`, container.id, token, asUserId, report);
      const file = await this._put(`file_${safeRole}.txt`, SAMPLE_TXT, container.id, token, asUserId, report);

      for (const target of [{ item: folder, kind: 'folder' }, { item: file, kind: 'file' }]) {
        if (users.length > 0) {
          const who = users[i % users.length];
          await this._grant(target.kind, target.item.id, { email: who }, role, token, asUserId, report,
            `matrix ${target.kind} ${role} -> user ${who}`);
        }
        for (const g of groups) {
          await this._grant(target.kind, target.item.id, g, role, token, asUserId, report,
            `matrix ${target.kind} ${role} -> ${g.displayName}`);
        }
      }
    }
  }

  /**
   * Team-wide access vs a named few.
   *
   * Box has no automatic all-enterprise group the way Dropbox's Business teams do, so "open" here
   * means a real, pre-created group named by BOX_TEST_EVERYONE_GROUP (its numeric id) — never
   * invented, because creating enterprise groups as a side effect of seeding would change
   * configuration nobody asked to change.
   */
  async _applyAccessMode(rootId, token, asUserId, grantees, log, report) {
    const mode = env.BOX_TEST_ACCESS_MODE;
    if (!mode) {
      report.skipped.push({
        step: 'team-wide vs restricted access',
        reason: 'BOX_TEST_ACCESS_MODE not set — set it to "open" or "restricted" to exercise this',
      });
      return;
    }
    if (mode !== 'open' && mode !== 'restricted') {
      log.warn(`Unknown BOX_TEST_ACCESS_MODE "${mode}" — expected "open" or "restricted"; nothing seeded`);
      report.skipped.push({
        step: 'team-wide vs restricted access',
        reason: `BOX_TEST_ACCESS_MODE "${mode}" is not one of "open" / "restricted"`,
      });
      return;
    }

    const folder = await this._mk('14-Access-Mode', rootId, token, asUserId, report);

    if (mode === 'open') {
      if (!grantees.everyoneGroupId) {
        report.skipped.push({
          step: 'team-wide access ("open")',
          reason: 'BOX_TEST_EVERYONE_GROUP is not set — needs the numeric id of a pre-created group '
            + 'containing everyone the run wants covered',
        });
        return;
      }
      const ok = await this._grant('folder', folder.id, { groupId: grantees.everyoneGroupId }, 'viewer',
        token, asUserId, report, `access mode open -> everyone group ${grantees.everyoneGroupId} viewer`);
      log.info(ok
        ? `Access mode "open": granted to the everyone-group ${grantees.everyoneGroupId}`
        : `Access mode "open": the grant to ${grantees.everyoneGroupId} did NOT succeed — team-wide `
          + 'access is not exercised by this run. See the not-seeded/error entry for why.');
      return;
    }

    const few = (grantees.internalUsers.length ? grantees.internalUsers : (grantees.internal ? [grantees.internal] : [])).slice(0, 2);
    if (few.length === 0) {
      report.skipped.push({
        step: 'restricted access',
        reason: 'no internal user available, so there is no "few" to grant to',
      });
      return;
    }
    let granted = 0;
    for (const [i, who] of few.entries()) {
      const ok = await this._grant('folder', folder.id, { email: who }, i === 0 ? 'editor' : 'viewer',
        token, asUserId, report, `access mode restricted -> ${who} ${i === 0 ? 'editor' : 'viewer'}`);
      if (ok) granted += 1;
    }
    log.info(`Access mode "restricted": ${granted} of ${few.length} named grant(s) landed, no `
      + 'everyone-group');
  }

  /** Root files across the pass-through formats, plus one convertible legacy format. */
  async _seedRootFiles(rootId, token, asUserId, log, report) {
    const dir = await this._mk('03-File-Formats', rootId, token, asUserId, report);
    await this._put('document.txt', SAMPLE_TXT, dir.id, token, asUserId, report);
    await this._put('data.csv', SAMPLE_CSV, dir.id, token, asUserId, report);
    await this._put('page.html', SAMPLE_HTML, dir.id, token, asUserId, report);
    await this._put('config.json', SAMPLE_JSON, dir.id, token, asUserId, report);
    await this._put('feed.xml', SAMPLE_XML, dir.id, token, asUserId, report);
    await this._put('report.pdf', SAMPLE_PDF, dir.id, token, asUserId, report);
    await this._put('pixel.png', SAMPLE_PNG, dir.id, token, asUserId, report);
    await this._put('photo.jpg', SAMPLE_JPEG, dir.id, token, asUserId, report);
    // Legacy Office: Google may convert on import, so this exercises the conversion path rather than
    // byte equality — the validator must not hash it.
    await this._put('legacy.doc', SAMPLE_DOC, dir.id, token, asUserId, report);
    log.info('Seeded file formats');
  }

  /**
   * Scope 5.1/5.2 — shared links, both audiences Box supports.
   *
   * Box shared links have NO edit-vs-view axis at all (confirmed against the API's own shared_link
   * schema — only `can_download`/`can_preview`, never `can_edit`), so only one link is seeded per
   * audience rather than the four Dropbox's ladder needs. See
   * `validation/roleMaps/box_to_google.js`'s `expectedLinkType`, which is always `'view'` for exactly
   * this reason — a viewing link is the ONLY outcome this pair can ever produce.
   */
  async _seedSharedLinks(rootId, token, asUserId, log, report) {
    const dir = await this._mk('04-Shared-Links', rootId, token, asUserId, report);

    const targets = [
      { file: 'anyone-with-link.txt', access: 'open', scope: '5.1' },
      { file: 'company-only.txt', access: 'company', scope: '5.2' },
    ];

    for (const t of targets) {
      const item = await this._put(t.file, `${SAMPLE_TXT}Link access: ${t.access}\n`, dir.id, token, asUserId, report);
      try {
        const url = await boxClient.createSharedLink('file', item.id, token, asUserId, t.access);
        if (url) {
          report.created.links += 1;
          report.items.push({ type: 'link', name: t.file, id: item.id, access: t.access, url });
        }
      } catch (err) {
        // A 'company' link needs a Box enterprise; on a free/individual account it may be rejected.
        report.errors.push({ step: `shared link ${t.access} (scope ${t.scope})`, error: err.message });
        log.warn(`Shared link ${t.access} failed: ${err.message}`);
      }
    }
  }

  /**
   * Scope 4.1 — Box exposes BOTH creation and modification timestamps (`content_created_at` /
   * `content_modified_at`), unlike Dropbox which has neither creation time. Both are steered here, so
   * both halves of feature 4.1 are comparable — see boxToGoogledrive.js's validator, which treats
   * `createdComparable: true` deliberately, not copying Dropbox's `false`.
   *
   * Box rejects `content_created_at`/`content_modified_at` with 400 "not a valid rfc 3339 formatted
   * date" whenever the value carries milliseconds — confirmed directly: the exact same instant sent
   * as `...09:15:00.000Z` fails and `...09:15:00Z` (second precision) succeeds. RFC 3339 itself
   * allows fractional seconds; Box's own validator here just does not accept them. This was silently
   * dropping every 4.1 timestamp file, seeding nothing that scope 4.1 could compare.
   *
   * Dates are computed relative to NOW rather than hardcoded — a fixed year (2021, 2022...) only
   * looks "old" for a while and drifts back toward "recent" as real time passes, which quietly
   * weakens the test. Anchoring to "1/1.5/2 years before this run" keeps the gap meaningful forever.
   */
  async _seedTimestampFiles(rootId, token, asUserId, log, report) {
    const dir = await this._mk('06-Metadata-Timestamps', rootId, token, asUserId, report);
    // RFC 3339, second precision (no milliseconds) — the one format Box's validator accepts here.
    const rfc3339 = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const yearsAgo = (n, extraDays = 0) => {
      const d = new Date();
      d.setUTCFullYear(d.getUTCFullYear() - n);
      d.setUTCDate(d.getUTCDate() - extraDays);
      return d;
    };
    const stamps = [
      { created: rfc3339(yearsAgo(2)), modified: rfc3339(yearsAgo(2, -30)) },
      { created: rfc3339(yearsAgo(1, 60)), modified: rfc3339(yearsAgo(1, 30)) },
      { created: rfc3339(yearsAgo(1, 15)), modified: rfc3339(yearsAgo(1)) },
    ];
    for (let i = 0; i < stamps.length; i++) {
      const s = stamps[i];
      await this._put(
        `timestamped-${i + 1}.txt`,
        `${SAMPLE_TXT}Intended content_created_at: ${s.created}\nIntended content_modified_at: ${s.modified}\n`,
        dir.id, token, asUserId, report,
        { contentCreatedAt: s.created, contentModifiedAt: s.modified }
      );
    }
    log.info(`Seeded timestamp files (both created and modified, most recent ${stamps[2].modified})`);
  }

  /**
   * Scope 8.1 — names Google accepts unchanged. A NEGATIVE test: the expected result is no
   * replacement at all, since Google accepts nearly everything Box allows in a name.
   */
  async _seedSpecialCharacterNames(rootId, token, asUserId, log, report) {
    const dir = await this._mk('07-Special-Characters', rootId, token, asUserId, report);
    const special = await this._mk(SPECIAL_CHARS_NAME, dir.id, token, asUserId, report);
    await this._put(`${SPECIAL_CHARS_NAME}.txt`, SAMPLE_TXT, special.id, token, asUserId, report);
    log.info('Seeded special-character names');
  }

  /**
   * Scope 7.1 — the long-path chain. Matches BoxTestDataAgent's own 30-level convention, so
   * `treeDepth: 35` in utils/contentTolerance/boxToGoogledrive.js comfortably covers it.
   *
   * Google declares no total-path limit (validation/destinations/googledrive.js), so the expected
   * outcome for this pair is the long path arriving INTACT with no relocation — unlike a SharePoint
   * destination, where the equivalent scenario expects a placeholder link past 400 characters.
   */
  async _seedLongPath(rootId, token, asUserId, log, report) {
    const dir = await this._mk('08-Long-Paths', rootId, token, asUserId, report);
    await this._put('short-path-control.txt', SAMPLE_TXT, dir.id, token, asUserId, report);

    const LEVELS = 30;
    let parentId = dir.id;
    for (let i = 1; i <= LEVELS; i++) {
      const folder = await this._mk(`Level-with-a-deliberately-long-name-to-grow-the-path-${String(i).padStart(2, '0')}`,
        parentId, token, asUserId, report);
      parentId = folder.id;
      if (i === 10 || i === 20 || i === 25 || i === LEVELS) {
        await this._put(`checkpoint-depth-${i}.txt`, `${SAMPLE_TXT}Depth: ${i}\n`, parentId, token, asUserId, report);
      }
    }
    report.longestSeededPathDepth = LEVELS;
    log.info(`Seeded long path, ${LEVELS} levels deep`);
  }

  /**
   * Scope 9.1 — embedded links, one in scope and one out (mirrors the 10.8-equivalent nuance: a link
   * to a file NOT in the migration scope must remain pointing at the source).
   *
   * Seeded across FOUR formats — .docx, .pdf, .xlsx, .txt. Deliberately no .html: Box is not a source
   * where a user's own content is typically HTML, so it is not a representative source format for
   * this combination the way it might be for a web-export-oriented source — CloudFuze's link-rewrite
   * scope is "supported file types where link rewriting is technically feasible", and testing a
   * format nobody actually stores in Box risks reporting a result against a file type this
   * combination was never promised to touch. Matches `DropboxTestDataAgent._seedEmbeddedLinks`, which
   * established this exact pattern for Dropbox → real
   * `.docx`/`.pdf`/`.xlsx` files with genuine hyperlink fields (an OOXML relationship, a PDF /Link
   * annotation, a cell hyperlink — three different underlying mechanisms, so none of them can stand in
   * for the others), using the `docx`, `pdfkit` and `xlsx` packages already in this repo's
   * dependencies. `.txt` is added on top of Dropbox's set: a plain text file can only ever hold a bare
   * URL string, never a structured hyperlink field, so it is a deliberate negative control — if
   * CloudFuze's rewrite depends on parsing a structured link object, a bare URL in a .txt file is
   * expected to survive unchanged, which is itself useful evidence, not a gap in the test.
   */
  async _seedEmbeddedLinks(rootId, token, asUserId, log, report) {
    const dir = await this._mk('09-Embedded-Links', rootId, token, asUserId, report);

    // Each format gets its OWN pair of target files, not one pair shared across all five. Sharing
    // one pair meant a rewrite that happened to work for the first format tried made every other
    // format's check indistinguishable from a coincidence — a link CloudFuze rewrote once because it
    // processed that exact file earlier is not evidence it rewrites links in every format's own
    // hyperlink mechanism. Distinct targets make each format's result independent evidence.
    const formats = ['docx', 'pdf', 'xlsx', 'txt'];
    const targets = {};
    for (const fmt of formats) {
      const names = [`link-target-${fmt}-1.txt`, `link-target-${fmt}-2.txt`];
      const urls = [];
      for (const name of names) {
        try {
          const file = await this._put(name, `${SAMPLE_TXT}I am the target for the .${fmt} document's link.\n`,
            dir.id, token, asUserId, report);
          const url = await boxClient.createSharedLink('file', file.id, token, asUserId, 'open') || '';
          if (!url) throw new Error('createSharedLink returned no url');
          urls.push(url);
        } catch (err) {
          report.errors.push({ step: `embedded link (.${fmt} target ${name})`, error: err.message });
        }
      }
      targets[fmt] = urls;
    }

    // A format whose two target links did not BOTH come through is skipped entirely — a placeholder
    // URL would silently test a link that was never real, and the validator would judge it anyway.
    // Matches DropboxTestDataAgent's refusal in the same situation.
    const seeded = formats.filter((fmt) => targets[fmt].length === 2);
    const skipped = formats.filter((fmt) => targets[fmt].length !== 2);
    if (skipped.length > 0) {
      report.notSeeded.push({
        feature: `9.1 Embedded Links (.${skipped.join(', .')})`,
        reason: 'could not create both target shared links for this format — see report.errors for '
          + 'the underlying Box failure. No document was written for it rather than seed one with a '
          + 'fake link.',
        manualSteps: [],
      });
      log.warn(`Embedded-links document(s) NOT seeded for: .${skipped.join(', .')}`);
    }
    if (seeded.length === 0) return;

    const label1 = (fmt) => `${fmt} target 1`;
    const label2 = (fmt) => `${fmt} target 2`;

    // .docx — a real OOXML hyperlink relationship, not markup a converter could interpret loosely.
    if (seeded.includes('docx')) {
      const [url1, url2] = targets.docx;
      const { Document, Packer, Paragraph, TextRun, ExternalHyperlink } = require('docx');
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({ children: [new TextRun('Embedded links test document (scope 9.1).')] }),
            new Paragraph({ children: [new TextRun('')] }),
            new Paragraph({
              children: [
                new TextRun('Link 1: '),
                new ExternalHyperlink({ children: [new TextRun({ text: label1('docx'), style: 'Hyperlink' })], link: url1 }),
              ],
            }),
            new Paragraph({
              children: [
                new TextRun('Link 2: '),
                new ExternalHyperlink({ children: [new TextRun({ text: label2('docx'), style: 'Hyperlink' })], link: url2 }),
              ],
            }),
          ],
        }],
      });
      const docxBuffer = await Packer.toBuffer(doc);
      await this._put('document-with-embedded-links.docx', docxBuffer, dir.id, token, asUserId, report);
    }

    // .pdf — a real /Link annotation, a different underlying mechanism from the OOXML relationship.
    if (seeded.includes('pdf')) {
      const [url1, url2] = targets.pdf;
      const PDFDocument = require('pdfkit');
      const pdfDoc = new PDFDocument();
      const pdfChunks = [];
      pdfDoc.on('data', (c) => pdfChunks.push(c));
      const pdfDone = new Promise((resolve) => pdfDoc.on('end', () => resolve(Buffer.concat(pdfChunks))));
      pdfDoc.fontSize(14).text('Embedded links test document (scope 9.1).');
      pdfDoc.moveDown();
      const y1 = pdfDoc.y;
      pdfDoc.fillColor('blue').text(label1('pdf'), { underline: true });
      pdfDoc.link(pdfDoc.page.margins.left, y1, 200, 20, url1);
      pdfDoc.moveDown();
      const y2 = pdfDoc.y;
      pdfDoc.fillColor('blue').text(label2('pdf'), { underline: true });
      pdfDoc.link(pdfDoc.page.margins.left, y2, 200, 20, url2);
      pdfDoc.end();
      await this._put('document-with-embedded-links.pdf', await pdfDone, dir.id, token, asUserId, report);
    }

    // .xlsx — a cell hyperlink, a third distinct mechanism (an OOXML relationship scoped to the
    // sheet's drawing/relationship part, not the document body's).
    if (seeded.includes('xlsx')) {
      const [url1, url2] = targets.xlsx;
      const XLSX = require('xlsx');
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([
        ['Embedded links test document (scope 9.1)'],
        [label1('xlsx')],
        [label2('xlsx')],
      ]);
      // Cell refs are fixed by aoa_to_sheet's row order, so the validator can key off A2/A3 directly
      // instead of needing to resolve a shared-strings table to recover each cell's visible text.
      ws.A2.l = { Target: url1 };
      ws.A3.l = { Target: url2 };
      XLSX.utils.book_append_sheet(wb, ws, 'Links');
      const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      await this._put('document-with-embedded-links.xlsx', xlsxBuffer, dir.id, token, asUserId, report);
    }

    // .txt — deliberately a BARE url, not a structured hyperlink field (plain text cannot carry one).
    if (seeded.includes('txt')) {
      const [url1, url2] = targets.txt;
      const txtBody = `Embedded links test document (scope 9.1)\n\n`
        + `${label1('txt')}: ${url1}\n`
        + `${label2('txt')}: ${url2}\n`;
      await this._put('document-with-embedded-links.txt', txtBody, dir.id, token, asUserId, report);
    }

    report.embeddedLinks = { targets, formats: seeded };
    log.info(`Seeded embedded-link documents (.${seeded.join(', .')}), each with its own target pair`);
  }

  /**
   * Scope 3.1/3.2 — version history and selective versions. The expected DESTINATION count is a job
   * setting, not a constant (scope 3.2), so the seeded count is reported and the validator compares
   * against what the job requested rather than a fixed number.
   */
  async _seedVersions(rootId, token, asUserId, log, report) {
    const dir = await this._mk('10-Versions', rootId, token, asUserId, report);

    for (const name of ['versioned-a.txt', 'versioned-b.txt']) {
      const initial = await this._put(name, VERSION_BODIES[0], dir.id, token, asUserId, report);
      for (let v = 1; v < VERSION_BODIES.length; v++) {
        await boxClient.uploadVersion(initial.id, name, Buffer.from(VERSION_BODIES[v]), token, asUserId);
        report.created.versions += 1;
      }
    }

    try {
      const first = report.items.find((i) => i.name === 'versioned-a.txt');
      if (first) {
        const revs = await boxClient.getFileVersions(first.id, token, asUserId);
        report.seededVersionCount = revs.totalVersions;
        if (revs.totalVersions < VERSION_BODIES.length) {
          log.warn(`Expected ${VERSION_BODIES.length} versions, Box reports ${revs.totalVersions}. `
            + 'Version features 3.1/3.2 are under-seeded.');
        }
      }
    } catch (err) {
      report.errors.push({ step: 'verify versions', error: err.message });
    }
    log.info(`Seeded versions (${report.seededVersionCount ?? '?'} confirmed)`);
  }

  /** Scope 6.1 — an in-line comment. Migrates as a CSV report at the destination, not as a native comment. */
  async _seedInlineComment(rootId, token, asUserId, log, report) {
    const dir = await this._mk('11-In-Line-Comment', rootId, token, asUserId, report);
    const file = await this._put('commented-file.txt', SAMPLE_TXT, dir.id, token, asUserId, report);
    try {
      await boxClient.addComment(file.id, 'Seeded QA comment — expect this in the destination CSV report, '
        + 'not as a native comment on the migrated file.', token, asUserId);
      report.created.comments += 1;
    } catch (err) {
      report.errors.push({ step: 'in-line comment (scope 6.1)', error: err.message });
      log.warn(`Could not seed the in-line comment: ${err.message}`);
    }
  }

  /**
   * Scope 10.1-10.16 — Box Notes, seeded via the REAL Notes API (`boxClient.createNote`).
   *
   * Supersedes the earlier best-effort placeholder upload — see the module-level comment on
   * `boxNoteMarkdown` for how that was confirmed live not to be recognised as a real Note, and how
   * `POST /2.0/notes/convert` (Box API 2026.0+, released May 2026) is the genuine replacement,
   * mirroring `DropboxTestDataAgent._seedPaper`'s use of `files/paper/create`.
   */
  async _seedBoxNotes(rootId, token, asUserId, log, report) {
    const dir = await this._mk('12-Box-Notes', rootId, token, asUserId, report);

    // A real Box shared link to a file ALREADY seeded in this same run (03-File-Formats/photo.jpg,
    // from _seedRootFiles, which runs before this phase) — this is what lets 10.7 be represented
    // faithfully rather than guessed at: an actual `app.box.com/s/…` link, not a placeholder URL.
    let sharedImageUrl = null;
    try {
      const rootChildren = await boxClient.getFolderItems(rootId, token, asUserId);
      const formatsDir = rootChildren.find((i) => i.type === 'folder' && i.name === '03-File-Formats');
      const formatFiles = formatsDir ? await boxClient.getFolderItems(formatsDir.id, token, asUserId) : [];
      const photo = formatFiles.find((f) => /\.(png|jpe?g)$/i.test(f.name));
      if (photo) {
        sharedImageUrl = await boxClient.createSharedLink('file', photo.id, token, asUserId, 'open');
      }
    } catch (err) {
      log.warn(`Could not create a shared link for the 10.7 image reference: ${err.message}`);
    }

    try {
      const created = await boxClient.createNote(
        boxNoteMarkdown(sharedImageUrl), dir.id, token, asUserId, 'qa-note.boxnote'
      );
      report.created.files += 1;
      report.items.push({ type: 'file', name: 'qa-note.boxnote', id: created.id, parentId: dir.id, isBoxNote: true });
      report.boxNoteSeeded = { id: created.id, viaNotesApi: true, sharedImageUrl };
      log.info(`Created a real Box Note via POST /2.0/notes/convert (id=${created.id})`);

      // 10.14 — comments are their own Box object, not part of a Note's content, so this is a
      // separate call after creation. The SAME addComment used for scope 6.1 (in-line comment)
      // elsewhere in this agent, which is already confirmed working.
      try {
        await boxClient.addComment(
          created.id,
          'Seeded QA comment on the Box Note (scope 10.14) — expect this migrated as a CSV report at '
            + 'the destination, the same "CSV is the evidence" treatment as scope 6.1.',
          token, asUserId
        );
        report.created.comments += 1;
      } catch (commentErr) {
        report.errors.push({ step: 'Box Note comment (scope 10.14)', error: commentErr.message });
        log.warn(`Could not add the Box Note comment: ${commentErr.message}`);
      }
    } catch (err) {
      report.errors.push({ step: 'Box Note creation (POST /2.0/notes/convert)', error: err.message });
      log.warn(`Could not create the Box Note: ${err.message}`);
    }

    // What plain Markdown genuinely cannot express, stated once here rather than per-feature —
    // narrower than before now that the real API is in use. 10.14 (comments) is NOT in this list —
    // it is seeded above via addComment, a separate Box object from the Note's content.
    report.notSeeded.push({
      feature: 'Box Note elements Markdown cannot express (10.3, part of 10.2, 10.6/10.8 image-method '
        + 'distinction, 10.9, 10.13)',
      reason:
        '`POST /2.0/notes/convert` imports MARKDOWN, and Markdown has no syntax for a font size or '
        + 'colour choice, text alignment, an @mention that resolves to a real user, a pasted clipboard '
        + 'image, or a way to tell "uploaded from computer" (10.6) or "inserted via Link Preview" '
        + '(10.8) apart from an ordinary embedded image reference. Only 10.7 (Box shared link) is '
        + 'represented faithfully, using a real shared link to a file already seeded in this same run.',
      manualSteps: [
        `Open the "12-Box-Notes" folder under "${report.rootFolderName}" in the Box UI and edit the `
          + 'seeded Note (or create a new one) by hand for the remaining elements:',
        'Set a non-default font size and a non-default text colour, and try a right-aligned paragraph '
          + '(10.2 alignment, 10.3 — both documented as not preserved)',
        'Insert an image by uploading from your computer (10.6 — documented as not preserved)',
        'Insert an image via "Insert Link Preview" (10.8 — documented as not preserved)',
        'Paste a clipboard image directly into the Note (10.9 — documented as not preserved)',
        'Add an @mention of another user (10.13 — documented as NOT migrated)',
      ],
    });
  }

  /**
   * Scope 1.3 — delta. Called as a SECOND pass, after the one-time migration completed. Not called
   * from execute(): a delta against an unmigrated tree tests nothing.
   *
   * @param {object} context — must carry `rootFolderId` / `rootFolderName` from the prior one-time
   *   run's report (this agent creates a new root every `execute()`, so the delta pass needs to be
   *   told which root to mutate rather than discovering one itself).
   */
  async applyDeltaChanges(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    const adminEmail = context.sourceAdminEmail || context.adminEmail || context.sourceEmail;
    const token = await boxClient.getValidToken(adminEmail);
    const asUserId = context.boxTargetUserId || null;

    const rootId = context.sourceRootId || context.rootFolderId;
    if (!rootId) {
      throw new Error('applyDeltaChanges needs the seeded root\'s folder id (context.sourceRootId or '
        + 'context.rootFolderId) from the prior one-time run — there is nothing to mutate otherwise.');
    }

    const changes = { renamed: [], added: [], updated: [], moved: [], unchanged: [], errors: [] };
    const items = await boxClient.getFolderItems(rootId, token, asUserId).catch(() => []);
    const formats = items.find((i) => i.type === 'folder' && i.name === '03-File-Formats');

    const deltaDir = await boxClient.createFolder('15-Delta', rootId, token, asUserId).catch((err) => {
      changes.errors.push({ step: 'delta folder', error: err.message });
      return null;
    });

    // newly added
    if (deltaDir) {
      try {
        const f = await boxClient.uploadFile('delta-added.txt', Buffer.from('Added during delta window.\n'),
          deltaDir.id, token, asUserId);
        changes.added.push(f.id);
      } catch (err) { changes.errors.push({ step: 'added', error: err.message }); }
    }

    if (formats) {
      const formatItems = await boxClient.getFolderItems(formats.id, token, asUserId).catch(() => []);
      const doc = formatItems.find((i) => i.name === 'document.txt');
      const csv = formatItems.find((i) => i.name === 'data.csv');
      const xml = formatItems.find((i) => i.name === 'feed.xml');
      const json = formatItems.find((i) => i.name === 'config.json');

      // content updated — overwrite via a new version.
      if (doc) {
        try {
          await boxClient.uploadVersion(doc.id, 'document.txt',
            Buffer.from(`${SAMPLE_TXT}UPDATED during the delta window.\n`), token, asUserId);
          changes.updated.push(doc.id);
        } catch (err) { changes.errors.push({ step: 'updated', error: err.message }); }
      }

      // renamed — same parent, new name.
      if (csv) {
        try {
          await boxClient.updateItem('file', csv.id, { name: 'data-renamed-in-delta.csv' }, token, asUserId);
          changes.renamed.push({ id: csv.id, to: 'data-renamed-in-delta.csv' });
        } catch (err) { changes.errors.push({ step: 'renamed', error: err.message }); }
      }

      // moved — into the delta folder.
      if (xml && deltaDir) {
        try {
          await boxClient.updateItem('file', xml.id, { parent: { id: deltaDir.id } }, token, asUserId);
          changes.moved.push({ id: xml.id, to: deltaDir.id });
        } catch (err) { changes.errors.push({ step: 'moved', error: err.message }); }
      }

      // unchanged control — deliberately untouched, so the run can confirm it was NOT re-migrated.
      if (json) changes.unchanged.push(json.id);
    }

    log.info(`Delta pass: ${changes.added.length} added, ${changes.updated.length} updated, `
      + `${changes.renamed.length} renamed, ${changes.moved.length} moved, `
      + `${changes.unchanged.length} left unchanged, ${changes.errors.length} not applied`);
    return changes;
  }

  /** One line a human can read in the run log and the report. */
  _summarize(report) {
    const c = report.created;
    return (
      `Box seeding: ${c.folders} folders, ${c.files} files, ${c.versions} version uploads, `
      + `${c.links} shared links, ${c.grants} grants, ${c.comments} comment(s) under `
      + `"${report.rootFolderName}". ${report.skipped.length} skipped, `
      + `${report.notSeeded.length} not seedable by API, ${report.errors.length} errors.`
    );
  }
}

module.exports = BoxToGoogledriveTestDataAgent;
