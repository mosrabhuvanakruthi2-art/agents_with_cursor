'use strict';

/**
 * SharePointTestDataAgent — seeds a SharePoint Online SOURCE for the
 * SharePoint → Google Shared Drive combination.
 *
 * SharePoint had only ever been a DESTINATION in this repo (agents/sharepoint/
 * SharePointValidationAgent.js reads it), so nothing could put data INTO it. This is the source
 * half: one scenario per in-scope feature in
 * `backend/data/feature-scope/sharepoint-to-google-shared-drive-inscope.md`, laid out so the
 * validator can find each one by position and name.
 *
 * The layout is deliberate, not decorative — the validator answers features 3.1/4.1/5.1/6.1 by
 * WHERE a grant sits (root folder, root file, sub-folder, inner file), so a scenario in the wrong
 * place silently answers the wrong feature:
 *
 *   <root>/                                   ← context.sourceFolderName
 *     root_readme.txt                         plain root file
 *     02-root-file-permissions.txt            4.1  Root File Permissions      (viewer grant)
 *     01-Root-Folder-Permissions/             3.1  Root Folder Permissions    (editor grant)
 *     03-Sub-Folder-Permissions/
 *       Sub-Folder/                           5.1  Sub-folder permissions     (editor grant)
 *         04-inner-file-permissions.txt       6.1  Inner file permissions     (viewer grant)
 *     05-Shared-Links/                        7.1  Shared links (org view + org edit, file+folder)
 *     06-External-Shares/                     8.1  External Shares
 *     07-Versions/                            10.1 Version History (3 files × 5 versions)
 *     08-Metadata/                            9.1  Metadata (timestamps)
 *     09-Special !@#$ Chars/                  11.1 Special Characters Replacement
 *     10-Long-Path/L01/…/L20/                 12.1 Long folder path
 *     11-Embedded-Links/                      14.1 Embedded Links (.docx → another seeded file)
 *     12-CrossLinks/                          16.1 CrossLinks (.docx → the custom library)
 *     File Types/                             2.1  structure + a spread of formats
 *   <custom library>/                         15.1 Custom Library (its own document library)
 *
 * Two rules this file follows, both learned from the sibling seeders:
 *
 *   1. **A scenario that cannot be seeded is recorded as a warning, never skipped silently.** Each
 *      failure lands in `this.errors` and is logged as "this feature cannot be validated", because a
 *      feature nobody seeded must not reach the report as a pass.
 *   2. **Grants are created with `sendInvitation: false`.** Feature 13.1 asks whether the
 *      destination suppresses ITS notifications; seeding must not fill the same mailboxes with
 *      SharePoint invitations, or the two become indistinguishable.
 */

const { BaseAgent } = require('../core/BaseAgent');
const sharepointClient = require('../../clients/sharepointClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');

// ─── Fixture content ─────────────────────────────────────────────────────────

const ROOT_README = `SharePoint QA — Agent Data Root
=================================

Created by SharePointTestDataAgent for SharePoint Online -> Google Shared Drive migration QA.

In-scope features exercised (see
backend/data/feature-scope/sharepoint-to-google-shared-drive-inscope.md):

  01-Root-Folder-Permissions/    3.1  Root folder permissions
  02-root-file-permissions.txt   4.1  Root file permissions
  03-Sub-Folder-Permissions/     5.1  Sub-folder permissions
  04-inner-file-permissions.txt  6.1  Inner file permissions
  05-Shared-Links/               7.1  Shared links
  06-External-Shares/            8.1  External shares
  07-Versions/                   10.1 Version history
  08-Metadata/                   9.1  Metadata / timestamps
  09-Special !@#$ Chars/         11.1 Special character replacement
  10-Long-Path/                  12.1 Long folder path
  11-Embedded-Links/             14.1 Embedded links
  12-CrossLinks/                 16.1 Cross links
  File Types/                    2.1  File and folder structure

All data is synthetic and exists only for QA.`;

const SAMPLE_TXT = `SharePoint QA — Text Document

Plain text fixture created by SharePointTestDataAgent.

Section 1: Overview
Content, encoding and line breaks must survive the migration unchanged.

Section 2: Data
Name: Alice Johnson | Email: alice@example.com | Department: Engineering
Name: Bob Smith    | Email: bob@example.com    | Department: Marketing

End of document.`;

const SAMPLE_CSV = `ID,Name,Email,Department,Role,StartDate,Status
1,Alice Johnson,alice@example.com,Engineering,Senior Developer,2021-03-15,Active
2,Bob Smith,bob@example.com,Marketing,Marketing Manager,2020-07-01,Active
3,Carol White,carol@example.com,HR,HR Specialist,2022-01-10,Active
4,David Lee,david@example.com,Finance,Financial Analyst,2019-11-20,Active
5,Eve Chen,eve@example.com,Engineering,DevOps Engineer,2021-08-05,Active`;

const SAMPLE_JSON = JSON.stringify({
  name: 'SharePoint QA Test Configuration',
  version: '1.0.0',
  combination: 'SharePoint Online to Google Shared Drive',
  settings: { versioningEnabled: true, sharingEnabled: true },
  testSuites: [
    { id: 1, name: 'File Types', status: 'active' },
    { id: 2, name: 'Folder Structure', status: 'active' },
    { id: 3, name: 'Permissions', status: 'active' },
    { id: 4, name: 'Shared Links', status: 'active' },
  ],
}, null, 2);

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sharePointQaTest>
  <metadata>
    <combination>SharePoint Online to Google Shared Drive</combination>
    <environment>QA</environment>
  </metadata>
  <testData>
    <item id="1"><name>Document A</name><type>docx</type></item>
    <item id="2"><name>Spreadsheet B</name><type>xlsx</type></item>
    <item id="3"><name>Image C</name><type>png</type></item>
  </testData>
</sharePointQaTest>`;

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>SharePoint QA Report</title></head>
<body>
  <h1>SharePoint Online to Google Shared Drive QA</h1>
  <table>
    <tr><th>Scenario</th><th>Status</th></tr>
    <tr><td>File upload</td><td>CREATED</td></tr>
    <tr><td>Folder structure</td><td>CREATED</td></tr>
    <tr><td>Permissions</td><td>CREATED</td></tr>
  </table>
</body>
</html>`;

/** Minimal valid 1x1 PNG. */
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** Minimal valid 1x1 JPEG. */
const SAMPLE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=',
  'base64'
);

/** Minimal valid single-page PDF. */
const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj\n'
  + '4 0 obj<</Length 56>>stream\nBT /F1 12 Tf 72 720 Td (SharePoint QA Test PDF) Tj ET\nendstream\nendobj\n'
  + 'xref\n0 5\ntrailer<</Root 1 0 R/Size 5>>\nstartxref\n200\n%%EOF'
);

/**
 * Version bodies. Each version differs in LENGTH as well as content, so a destination that kept
 * only the newest can be told apart from one that kept the history.
 */
function makeVersionContent(docName, v) {
  return Buffer.from(
    `=== ${docName} ===\nVersion: ${v}\n\n`
    + `Revision ${v} of ${v * 3} recorded changes.\n`
    + `Checksum: ${(v * 7919) % 99991}\n`
    + `Records: ${v * 42}\n\n`
    + Array.from({ length: v }, (_, i) => `- change ${i + 1} introduced in v${i + 1}`).join('\n')
    + `\n\nStatus: ${v >= 5 ? 'FINAL' : 'DRAFT'}\n--- End ---`
  );
}

/** The special-character folder name. Google replaces nothing, so this must arrive verbatim. */
const SPECIAL_FOLDER = '09-Special !@#$ Chars';
const SPECIAL_FILE = 'special !@#$ file.txt';

/** Depth of the long-path chain. 20 levels × a long segment clears any practical limit. */
const LONG_PATH_LEVELS = 20;

class SharePointTestDataAgent extends BaseAgent {
  constructor() {
    super('SharePointTestDataAgent');
    this.results = {};
    this.errors = [];
  }

  /** Record a scenario that could not be seeded. The feature is then unvalidatable, and says so. */
  _warn(scenario, err, item = null) {
    const message = err && err.message ? err.message : String(err);
    this.errors.push({ scenario, item, error: message });
    logger.warn(`[SharePointTestDataAgent]   ${scenario}${item ? `/${item}` : ''} failed: ${message}`);
  }

  async execute(context) {
    const sourceEmail = context.sourceEmail;
    const rootName = (context.sourceFolderName || 'Agent SharePoint Data').trim();
    if (!sourceEmail) throw new Error('sourceEmail is required for SharePointTestDataAgent');

    // Grantees. Context wins (the standalone seeding endpoint sets them), then configuration.
    const editorEmail = (context.editorEmail || env.SHAREPOINT_TEST_EDITOR_EMAIL || '').trim();
    const viewerEmail = (context.viewerEmail || env.SHAREPOINT_TEST_VIEWER_EMAIL || '').trim();
    const groupEmail = (context.groupEmail || env.SHAREPOINT_TEST_GROUP_EMAIL || '').trim();
    const externalEmail = (context.externalEmail || env.SHAREPOINT_TEST_EXTERNAL_EMAIL || '').trim();

    const site = await this._resolveSite(context, sourceEmail);
    this.results.site = { id: site.siteId, hostname: site.hostname, sitePath: site.sitePath };
    logger.info(`[SharePointTestDataAgent] Seeding ${site.hostname}${site.sitePath} as ${sourceEmail}`);
    logger.info(`[SharePointTestDataAgent] Grantees — editor: ${editorEmail || '(none)'}, `
      + `viewer: ${viewerEmail || '(none)'}, group: ${groupEmail || '(none)'}, `
      + `external: ${externalEmail || '(none)'}`);

    // A grantee outside the source domain is not an internal grant.
    //
    // Features 3.1-6.1 ask whether an INTERNAL user's access survived; 8.1 asks about an EXTERNAL
    // one. An "internal" grantee from another tenant is invited as a guest, so it answers 8.1's
    // question while wearing 3.1's label — and where the tenant blocks guest invites it simply
    // fails with a 400, which is what the first run hit on three of its four grant scenarios.
    // Said out loud at seed time, because nothing downstream can tell the two apart.
    const sourceDomain = (String(sourceEmail).split('@')[1] || '').toLowerCase();
    const foreign = [['editor', editorEmail], ['viewer', viewerEmail], ['group', groupEmail]]
      .filter(([, addr]) => addr && String(addr).split('@')[1]
        && String(addr).split('@')[1].toLowerCase() !== String(sourceDomain).toLowerCase());
    if (foreign.length > 0) {
      logger.warn(`[SharePointTestDataAgent] ${foreign.length} "internal" grantee(s) are NOT in the `
        + `source domain @${sourceDomain}: ${foreign.map(([role, a]) => `${role}=${a}`).join(', ')}. `
        + 'SharePoint treats those as EXTERNAL guest invites, so features 3.1-6.1 would measure '
        + 'external sharing rather than internal grants — and the invite fails outright where the '
        + 'tenant blocks guests. Set SHAREPOINT_TEST_EDITOR_EMAIL / _VIEWER_EMAIL / _GROUP_EMAIL to '
        + `accounts in @${sourceDomain}.`);
      this.errors.push({
        scenario: 'granteeTenant',
        item: foreign.map(([role, a]) => `${role}=${a}`).join(', '),
        error: `not in the source domain @${sourceDomain} — these are external guests, not internal users`,
      });
    }

    const siteId = site.siteId;

    // ── The root folder, in the site's default document library ────────────────────────────────
    // Find-or-create, like DriveTestDataAgent: a stable item id across runs means the id CloudFuze
    // is asked to migrate does not churn, and CleanupAgent empties this folder rather than
    // deleting it.
    //
    // A NAME with slashes is treated as a PATH. Graph rejects "a/b" as an item name
    // ("invalidRequest — The item name cannot contain a '/'") and the whole run died there, which is
    // what happens when the wizard's "Source folder base name" is filled in with a path. Creating
    // the segments is both more useful and impossible to crash on.
    const segments = rootName.split('/').map((s) => s.trim()).filter(Boolean);
    let root = null;
    let parent = '/';
    for (const seg of segments) {
      root = await sharepointClient.createFolder(siteId, parent, seg, sourceEmail);
      parent = `${parent === '/' ? '' : parent}/${seg}`;
    }
    if (segments.length > 1) {
      logger.info(`[SharePointTestDataAgent] base name "${rootName}" contains a path — created `
        + `${segments.length} nested folder(s); the seeded root is /${segments.join('/')}`);
      // The specific confusion this diagnoses: someone typing the CloudFuze-style
      // "<folder>/Documents" here. The library segment does NOT belong in this field — the folder is
      // created INSIDE the library already, and the site/library prefix CloudFuze needs is added
      // automatically (see cloudPathPrefix below).
      const libraryish = segments.slice(1).some((s) => /^(documents|shared documents)$/i.test(s));
      if (libraryish) {
        logger.warn('[SharePointTestDataAgent] one of those segments is a LIBRARY name '
          + '("Documents"). This field is a folder name inside the library, not a CloudFuze path — '
          + 'the site and library prefix is added for you. Use just the folder name.');
      }
    }
    if (!root?.id) {
      throw new Error(
        `SharePointTestDataAgent could not create "/${rootName}" in `
        + `${site.hostname}${site.sitePath}. With app-only auth this is usually a missing Graph `
        + 'permission: reads need Sites.Read.All, writes need Sites.ReadWrite.All (or '
        + 'Files.ReadWrite.All) with admin consent.'
      );
    }
    const rootPath = `/${segments.join('/')}`;
    this.results.rootFolderId = root.id;
    this.results.rootFolderName = segments.join('/');
    logger.info(`[SharePointTestDataAgent] Root folder ready: ${rootPath} (${root.id})`);

    // ── The path CLOUDFUZE will need, which is not the path Graph uses ─────────────────────────
    //
    // Graph addresses this folder library-relative ("/tosharedrive"). CloudFuze addresses a
    // SharePoint cloud as "/<Site display name>/<Library name>/<folder>" — visible both in its own
    // enumeration (objectName "QA" for the site) and in a mapping that passes in its UI
    // ("/SS test/Documents"). Sending the library-relative form is what produced, on every run:
    //   errorDescription "Migration not Allowed for wrong CSV paths", totalFilesAndFolders 0
    // with the pair attached and the source item id supplied. So the prefix is computed here, where
    // the site and library are already known, and carried for the migration to use.
    let libraryName = 'Documents';
    try {
      const drive = await sharepointClient.getDefaultDrive(siteId, sourceEmail);
      if (drive?.name) libraryName = drive.name;
    } catch (err) {
      logger.warn(`[SharePointTestDataAgent] could not read the default library name `
        + `(${err.message}) — assuming "${libraryName}"`);
    }
    const siteName = site.displayName || String(site.sitePath || '').split('/').filter(Boolean).pop();
    this.results.cloudPathPrefix = siteName ? `/${siteName}/${libraryName}` : null;
    this.results.libraryName = libraryName;
    logger.info(`[SharePointTestDataAgent] CloudFuze path for this folder: `
      + `${this.results.cloudPathPrefix || '(unknown)'}${rootPath}`);

    await this._seedRootFiles(siteId, rootPath, sourceEmail);
    await this._seedFileTypes(siteId, rootPath, sourceEmail);
    await this._seedRootFolderPermissions(siteId, rootPath, sourceEmail, editorEmail, groupEmail);
    await this._seedRootFilePermissions(siteId, rootPath, sourceEmail, viewerEmail);
    await this._seedSubFolderPermissions(siteId, rootPath, sourceEmail, editorEmail, viewerEmail);
    await this._seedSharedLinks(siteId, rootPath, sourceEmail);
    await this._seedExternalShares(siteId, rootPath, sourceEmail, externalEmail);
    await this._seedVersions(siteId, rootPath, sourceEmail);
    await this._seedMetadata(siteId, rootPath, sourceEmail);
    await this._seedSpecialCharacters(siteId, rootPath, sourceEmail);
    await this._seedLongPath(siteId, rootPath, sourceEmail, site);
    const library = await this._seedCustomLibrary(siteId, sourceEmail, editorEmail);
    await this._seedEmbeddedLinks(siteId, rootPath, sourceEmail, site);
    await this._seedCrossLinks(siteId, rootPath, sourceEmail, site, library);

    const r = this.results;
    const count = (v) => (Array.isArray(v) ? v.length : (v ? 1 : 0));
    const summary = {
      site: `${site.hostname}${site.sitePath}`,
      rootFolderName: rootName,
      rootFolderId: r.rootFolderId,
      fileTypes: count(r.fileTypes),
      permissionGrants: count(r.permissionGrants),
      sharedLinks: count(r.sharedLinks),
      externalGrants: count(r.externalGrants),
      versionedFiles: count(r.versionFiles),
      versionsPerFile: r.versionsPerFile || 0,
      specialCharsFolder: r.specialCharsFolder || null,
      longPathLevels: r.longPath?.levels || 0,
      longPathChars: r.longPath?.approxLength || 0,
      embeddedLinkDoc: r.embeddedLinks?.documentPath || null,
      crossLinkDoc: r.crossLinks?.documentPath || null,
      customLibrary: r.customLibrary?.name || null,
      warnings: this.errors.length,
    };

    logger.info('[SharePointTestDataAgent] ── Seeded data inventory ──────────────────────────');
    logger.info(`[SharePointTestDataAgent]   site              : ${summary.site}`);
    logger.info(`[SharePointTestDataAgent]   root folder       : ${rootPath} (${summary.rootFolderId})`);
    logger.info(`[SharePointTestDataAgent]   file types        : ${summary.fileTypes}`);
    logger.info(`[SharePointTestDataAgent]   permission grants : ${summary.permissionGrants}`);
    logger.info(`[SharePointTestDataAgent]   shared links      : ${summary.sharedLinks}`);
    logger.info(`[SharePointTestDataAgent]   external grants   : ${summary.externalGrants}`);
    logger.info(`[SharePointTestDataAgent]   versioned files   : ${summary.versionedFiles} × ${summary.versionsPerFile} versions`);
    logger.info(`[SharePointTestDataAgent]   special chars     : ${summary.specialCharsFolder || '(none)'}`);
    logger.info(`[SharePointTestDataAgent]   long path         : ${summary.longPathLevels} level(s), ~${summary.longPathChars} chars`);
    logger.info(`[SharePointTestDataAgent]   embedded links    : ${summary.embeddedLinkDoc || '(none)'}`);
    logger.info(`[SharePointTestDataAgent]   cross links       : ${summary.crossLinkDoc || '(none)'}`);
    logger.info(`[SharePointTestDataAgent]   custom library    : ${summary.customLibrary || '(none)'}`);
    if (this.errors.length > 0) {
      logger.warn(`[SharePointTestDataAgent]   warnings          : ${this.errors.length} scenario(s) `
        + 'not seeded — the features below CANNOT be validated by this run:');
      for (const w of this.errors.slice(0, 20)) {
        logger.warn(`[SharePointTestDataAgent]     - ${w.scenario}${w.item ? `/${w.item}` : ''}: ${w.error}`);
      }
    }
    logger.info('[SharePointTestDataAgent] ───────────────────────────────────────────────────');

    return {
      // The orchestrator reads these two to build the transfer unit: rootFolderName becomes
      // context.sourceTestDataPath ("/<name>") and rootFolderId becomes context.sourceRootId,
      // which CloudFuze needs as fromRootId — a job with a null root id scans nothing.
      rootFolderId: r.rootFolderId,
      rootFolderName: r.rootFolderName,
      // What CloudFuze must be given instead of the library-relative path — see above.
      cloudPathPrefix: r.cloudPathPrefix || null,
      libraryName: r.libraryName || null,
      // No Shared Drive on this side; the fields exist so the orchestrator's Google-shaped
      // capture (sourceData.sharedDriveId / sharedDriveName) stays null rather than undefined.
      sharedDriveId: null,
      sharedDriveName: null,
      site: this.results.site,
      customLibrary: r.customLibrary || null,
      embeddedLinks: r.embeddedLinks || null,
      crossLinks: r.crossLinks || null,
      sharedLinks: r.sharedLinks || [],
      summary,
      scenarios: r,
      warnings: this.errors,
    };
  }

  /**
   * Resolve the SOURCE site.
   *
   * SHAREPOINT_SOURCE_* first, then the destination-side settings as a fallback, then the tenant's
   * own root hostname when the configured one does not resolve — the hostname is not derivable from
   * the email domain (granger@gajha.com is served at trydemos.sharepoint.com), which is exactly the
   * trap resolveTenantHostname exists for.
   */
  async _resolveSite(context, sourceEmail) {
    const sitePath = (context.sharepointSourceSitePath
      || env.SHAREPOINT_SOURCE_SITE_PATH
      || env.SHAREPOINT_SITE_PATH || '').trim();
    if (!sitePath) {
      throw new Error(
        'No SharePoint source site configured — set SHAREPOINT_SOURCE_SITE_PATH (e.g. /sites/QA).'
      );
    }
    const configured = (context.sharepointSourceHostname
      || env.SHAREPOINT_SOURCE_HOSTNAME
      || env.SHAREPOINT_HOSTNAME || '').trim();
    try {
      // One shared resolver (client), so seeding, validation and cleanup cannot disagree about
      // which tenant holds the data — they did on the first run, and cleanup silently no-opped.
      return await sharepointClient.resolveSiteForAccount(sourceEmail, sitePath, configured);
    } catch (err) {
      throw new Error(
        `${err.message} Check SHAREPOINT_SOURCE_HOSTNAME / SHAREPOINT_SOURCE_SITE_PATH and that the `
        + 'app has Sites.ReadWrite.All with admin consent in the source account\'s tenant.'
      );
    }
  }

  // ── Root files ─────────────────────────────────────────────────────────────
  async _seedRootFiles(siteId, rootPath, email) {
    logger.info('[SharePointTestDataAgent] Root files');
    try {
      await sharepointClient.uploadFile(siteId, rootPath, 'root_readme.txt', Buffer.from(ROOT_README), email);
      this.results.rootFiles = ['root_readme.txt'];
    } catch (err) {
      this._warn('rootFiles', err, 'root_readme.txt');
    }
  }

  // ── 2.1 structure + a spread of formats ────────────────────────────────────
  async _seedFileTypes(siteId, rootPath, email) {
    logger.info('[SharePointTestDataAgent] File types (feature 2.1)');
    const folder = `${rootPath}/File Types`;
    const seeded = [];
    try {
      await sharepointClient.createFolder(siteId, rootPath, 'File Types', email);
    } catch (err) {
      this._warn('fileTypes', err, 'File Types folder');
      return;
    }
    const files = [
      ['sample_document.txt', Buffer.from(SAMPLE_TXT)],
      ['employee_data.csv', Buffer.from(SAMPLE_CSV)],
      ['test_config.json', Buffer.from(SAMPLE_JSON)],
      ['test_data.xml', Buffer.from(SAMPLE_XML)],
      ['qa_report.html', Buffer.from(SAMPLE_HTML)],
      ['sample_image.png', SAMPLE_PNG],
      ['sample_photo.jpg', SAMPLE_JPEG],
      ['sample_document.pdf', SAMPLE_PDF],
    ];
    for (const [name, buf] of files) {
      try {
        await sharepointClient.uploadFile(siteId, folder, name, buf, email);
        seeded.push(name);
      } catch (err) {
        this._warn('fileTypes', err, name);
      }
    }
    // A real .docx as well: the Office formats are what feature 14.1/16.1 rely on, and a docx is
    // also the file whose conversion to a Google Doc the size bands have to tolerate.
    try {
      const buf = await this._buildDocx('SharePoint QA document fixture.', []);
      await sharepointClient.uploadFile(siteId, folder, 'sample_document.docx', buf, email);
      seeded.push('sample_document.docx');
    } catch (err) {
      this._warn('fileTypes', err, 'sample_document.docx');
    }
    // One nested level, so 2.1 is a structure test rather than a flat list.
    try {
      await sharepointClient.createFolder(siteId, folder, 'Nested', email);
      await sharepointClient.uploadFile(siteId, `${folder}/Nested`, 'nested_note.txt',
        Buffer.from('A file one level below File Types, for the structure comparison.'), email);
      seeded.push('Nested/nested_note.txt');
    } catch (err) {
      this._warn('fileTypes', err, 'Nested');
    }
    this.results.fileTypes = seeded;
  }

  /** One permission grant, recorded for the inventory. */
  async _grant(siteId, itemPath, emails, role, sourceEmail, opts = {}) {
    const list = (Array.isArray(emails) ? emails : [emails]).filter(Boolean);
    if (list.length === 0) return false;
    await sharepointClient.invitePermission(
      siteId, itemPath, { emails: list, role, sendInvitation: false }, sourceEmail, opts
    );
    this.results.permissionGrants = this.results.permissionGrants || [];
    for (const who of list) {
      this.results.permissionGrants.push({ path: itemPath, principal: who, role, library: opts.driveId || null });
    }
    return true;
  }

  /**
   * ONE grant, isolated, with Graph's refusal translated into something actionable.
   *
   * Isolated because grants used to be bundled: the editor and the group shared a try block, as did
   * the sub-folder editor and the inner-file viewer. So a single unusable address took its
   * neighbours down with it — measured on a real run, where an unresolvable editor cost features
   * 3.1 AND 6.1, and the log blamed "grants" without naming which principal or which feature.
   *
   * Graph's two refusals here mean quite different things, and neither is a migration defect:
   *   noResolvedUsers — the address is not a shareable principal in this tenant. An unlicensed
   *     account, a distribution list, or a mailbox with no sharing identity all answer this, even
   *     though the address appears in Graph /users. Verified: casey@gajha.com resolves,
   *     dan@gajha.com does not, and both are listed mailboxes.
   *   sharingFailed — the tenant or site policy refused the share, which is what an external
   *     address hits when external sharing is off.
   *
   * @returns {boolean} whether the grant was created
   */
  async _grantOrWarn(scenario, feature, siteId, itemPath, who, role, sourceEmail, opts = {}) {
    if (!who) return false;
    try {
      await this._grant(siteId, itemPath, who, role, sourceEmail, opts);
      return true;
    } catch (err) {
      const code = err.graphCode || '';
      let why = err.message;
      if (code === 'noResolvedUsers') {
        why = `"${who}" is not a shareable principal in this tenant (Graph: noResolvedUsers). `
          + 'An unlicensed account, a distribution list, or a mailbox with no sharing identity all '
          + 'answer this — appearing in the user list is not enough. Pick an address that can be '
          + `granted access in SharePoint. Feature ${feature} is NOT exercised by this run.`;
      } else if (code === 'sharingFailed') {
        why = `sharing "${itemPath}" with "${who}" was refused by tenant or site policy (Graph: `
          + `sharingFailed). For an address outside the organisation this normally means external `
          + `sharing is turned off for the site or that domain. Feature ${feature} is NOT exercised.`;
      }
      this._warn(scenario, new Error(why), `${feature} ${role} → ${who}`);
      return false;
    }
  }

  // ── 3.1 Root folder permissions ────────────────────────────────────────────
  async _seedRootFolderPermissions(siteId, rootPath, email, editorEmail, groupEmail) {
    logger.info('[SharePointTestDataAgent] Root folder permissions (feature 3.1)');
    const name = '01-Root-Folder-Permissions';
    const path = `${rootPath}/${name}`;
    try {
      await sharepointClient.createFolder(siteId, rootPath, name, email);
      await sharepointClient.uploadFile(siteId, path, 'folder_permission_note.txt',
        Buffer.from('This folder carries a write grant at the source root (feature 3.1).'), email);
    } catch (err) {
      this._warn('rootFolderPermissions', err, name);
      return;
    }
    if (!editorEmail && !groupEmail) {
      this._warn('rootFolderPermissions',
        new Error('neither SHAREPOINT_TEST_EDITOR_EMAIL nor SHAREPOINT_TEST_GROUP_EMAIL is set — '
          + 'feature 3.1 cannot be exercised'), name);
      return;
    }
    // The user gets write; the group gets read. Both on the SAME folder on purpose — the
    // out-of-scope document records that Google collapses every source group type into one
    // standard Google Group, so a group grant needs to exist to observe that at all.
    //
    // Independently, so an unusable group address cannot cost the user grant (or the reverse).
    await this._grantOrWarn('rootFolderPermissions', '3.1', siteId, path, editorEmail, 'write', email);
    await this._grantOrWarn('rootFolderPermissions', '3.1 (group half)', siteId, path, groupEmail, 'read', email);
  }

  // ── 4.1 Root file permissions ──────────────────────────────────────────────
  async _seedRootFilePermissions(siteId, rootPath, email, viewerEmail) {
    logger.info('[SharePointTestDataAgent] Root file permissions (feature 4.1)');
    const name = '02-root-file-permissions.txt';
    const path = `${rootPath}/${name}`;
    try {
      await sharepointClient.uploadFile(siteId, rootPath, name,
        Buffer.from('A file at the source root carrying a read grant (feature 4.1).'), email);
    } catch (err) {
      this._warn('rootFilePermissions', err, name);
      return;
    }
    if (!viewerEmail) {
      this._warn('rootFilePermissions',
        new Error('SHAREPOINT_TEST_VIEWER_EMAIL is not set — feature 4.1 cannot be exercised'), name);
      return;
    }
    await this._grantOrWarn('rootFilePermissions', '4.1', siteId, path, viewerEmail, 'read', email);
  }

  // ── 5.1 sub-folder + 6.1 inner file permissions ────────────────────────────
  async _seedSubFolderPermissions(siteId, rootPath, email, editorEmail, viewerEmail) {
    logger.info('[SharePointTestDataAgent] Sub-folder and inner file permissions (features 5.1, 6.1)');
    const container = '03-Sub-Folder-Permissions';
    const containerPath = `${rootPath}/${container}`;
    const subPath = `${containerPath}/Sub-Folder`;
    const innerFile = '04-inner-file-permissions.txt';
    try {
      await sharepointClient.createFolder(siteId, rootPath, container, email);
      await sharepointClient.createFolder(siteId, containerPath, 'Sub-Folder', email);
      await sharepointClient.uploadFile(siteId, subPath, innerFile,
        Buffer.from('A file below the root carrying its own read grant (feature 6.1).'), email);
    } catch (err) {
      this._warn('subFolderPermissions', err, container);
      return;
    }
    // 5.1 and 6.1 are separate features on separate items — so separate grants, each surviving the
    // other's failure. Bundled, an unresolvable editor address silently cost 6.1 as well.
    if (editorEmail) {
      await this._grantOrWarn('subFolderPermissions', '5.1', siteId, subPath, editorEmail, 'write', email);
    } else {
      this._warn('subFolderPermissions',
        new Error('SHAREPOINT_TEST_EDITOR_EMAIL is not set — feature 5.1 cannot be exercised'), 'Sub-Folder');
    }
    if (viewerEmail) {
      await this._grantOrWarn('subFolderPermissions', '6.1', siteId, `${subPath}/${innerFile}`,
        viewerEmail, 'read', email);
    } else {
      this._warn('subFolderPermissions',
        new Error('SHAREPOINT_TEST_VIEWER_EMAIL is not set — feature 6.1 cannot be exercised'), innerFile);
    }
  }

  // ── 7.1 Shared links ──────────────────────────────────────────────────────
  async _seedSharedLinks(siteId, rootPath, email) {
    logger.info('[SharePointTestDataAgent] Shared links (feature 7.1)');
    const container = '05-Shared-Links';
    const containerPath = `${rootPath}/${container}`;
    const links = [];
    try {
      await sharepointClient.createFolder(siteId, rootPath, container, email);
      await sharepointClient.uploadFile(siteId, containerPath, 'link_view.txt',
        Buffer.from('This file carries an organization VIEW link (feature 7.1).'), email);
      await sharepointClient.uploadFile(siteId, containerPath, 'link_edit.txt',
        Buffer.from('This file carries an organization EDIT link (feature 7.1).'), email);
    } catch (err) {
      this._warn('sharedLinks', err, container);
      return;
    }

    // Organization scope, both types, on a file AND on a folder.
    //
    // Anonymous links are deliberately not the backbone of this scenario: a tenant can forbid them
    // by policy, in which case a failure to create one says nothing about the migration. One is
    // still attempted last so the case is covered where the tenant allows it, and a rejection is
    // recorded as a seeding gap rather than a defect.
    const targets = [
      [`${containerPath}/link_view.txt`, { type: 'view', scope: 'organization' }],
      [`${containerPath}/link_edit.txt`, { type: 'edit', scope: 'organization' }],
      [containerPath, { type: 'view', scope: 'organization' }],
      [`${containerPath}/link_view.txt`, { type: 'view', scope: 'anonymous' }],
    ];
    for (const [path, spec] of targets) {
      try {
        const link = await sharepointClient.createSharingLink(siteId, path, spec, email);
        links.push({ path, ...spec, webUrl: link.webUrl });
      } catch (err) {
        this._warn('sharedLinks', err, `${path} ${spec.scope}/${spec.type}`);
      }
    }
    this.results.sharedLinks = links;
  }

  // ── 8.1 External shares ───────────────────────────────────────────────────
  async _seedExternalShares(siteId, rootPath, email, externalEmail) {
    logger.info('[SharePointTestDataAgent] External shares (feature 8.1)');
    const container = '06-External-Shares';
    const containerPath = `${rootPath}/${container}`;
    const fileName = 'external_share.txt';
    try {
      await sharepointClient.createFolder(siteId, rootPath, container, email);
      await sharepointClient.uploadFile(siteId, containerPath, fileName,
        Buffer.from('This file is shared with an address outside the source tenant (feature 8.1).'), email);
    } catch (err) {
      this._warn('externalShares', err, container);
      return;
    }
    if (!externalEmail) {
      this._warn('externalShares',
        new Error('SHAREPOINT_TEST_EXTERNAL_EMAIL is not set — feature 8.1 cannot be exercised'), container);
      return;
    }
    // External sharing may be disabled tenant-wide — a configuration fact, not a defect, and
    // _grantOrWarn spells out which of the two refusals came back.
    const granted = await this._grantOrWarn('externalShares', '8.1', siteId,
      `${containerPath}/${fileName}`, externalEmail, 'read', email);
    if (granted) {
      this.results.externalGrants = [{
        path: `${containerPath}/${fileName}`, principal: externalEmail, role: 'read',
      }];
    }
  }

  // ── 10.1 Version history ──────────────────────────────────────────────────
  async _seedVersions(siteId, rootPath, email) {
    logger.info('[SharePointTestDataAgent] Version history (feature 10.1)');
    const container = '07-Versions';
    const containerPath = `${rootPath}/${container}`;
    const VERSIONS = 5;
    const docs = ['versioned_report.txt', 'versioned_notes.txt', 'versioned_spec.txt'];
    const seeded = [];
    try {
      await sharepointClient.createFolder(siteId, rootPath, container, email);
    } catch (err) {
      this._warn('versions', err, container);
      return;
    }
    for (const name of docs) {
      try {
        // Re-uploading the same path is what creates a version in SharePoint — there is no
        // "add version" call. Sequential, because two concurrent PUTs to one path can collapse
        // into a single version.
        for (let v = 1; v <= VERSIONS; v += 1) {
          await sharepointClient.uploadFile(siteId, containerPath, name, makeVersionContent(name, v), email);
        }
        seeded.push(name);
      } catch (err) {
        this._warn('versions', err, name);
      }
    }
    this.results.versionFiles = seeded;
    this.results.versionsPerFile = VERSIONS;
  }

  // ── 9.1 Metadata ──────────────────────────────────────────────────────────
  async _seedMetadata(siteId, rootPath, email) {
    logger.info('[SharePointTestDataAgent] Metadata (feature 9.1)');
    const container = '08-Metadata';
    const containerPath = `${rootPath}/${container}`;
    try {
      await sharepointClient.createFolder(siteId, rootPath, container, email);
      await sharepointClient.uploadFile(siteId, containerPath, 'metadata_timestamps.txt',
        Buffer.from('Created and modified timestamps on this file must survive the migration '
          + '(feature 9.1). "Created By" / "Modified By" identity is out of scope — Google does '
          + 'not accept it.'), email);
      this.results.metadataFiles = ['metadata_timestamps.txt'];
    } catch (err) {
      this._warn('metadata', err, container);
    }
  }

  // ── 11.1 Special characters ───────────────────────────────────────────────
  async _seedSpecialCharacters(siteId, rootPath, email) {
    logger.info('[SharePointTestDataAgent] Special characters (feature 11.1)');
    try {
      const folder = await sharepointClient.createFolder(siteId, rootPath, SPECIAL_FOLDER, email);
      const folderPath = `${rootPath}/${SPECIAL_FOLDER}`;
      await sharepointClient.uploadFile(siteId, folderPath, SPECIAL_FILE,
        Buffer.from('A name carrying characters SharePoint accepts. Google replaces nothing, so '
          + 'both names must arrive verbatim (feature 11.1).'), email);
      // The name SharePoint actually stored, not the one requested: SharePoint rewrites some
      // characters on create, and the validator has to compare against what exists.
      this.results.specialCharsFolder = folder?.name || SPECIAL_FOLDER;
      this.results.specialCharsFile = SPECIAL_FILE;
    } catch (err) {
      this._warn('specialCharacters', err, SPECIAL_FOLDER);
    }
  }

  // ── 12.1 Long folder path ─────────────────────────────────────────────────
  /**
   * A deep chain, sized to fit inside SHAREPOINT's own limit.
   *
   * The source has a path limit even though the destination does not: SharePoint refuses a
   * server-relative URL over ~400 characters, and that budget includes the site prefix
   * ("/sites/QA/Shared Documents") and the run's root folder name. The first run used a fixed
   * 18-character segment and got HTTP 400 at level 16 — recorded as a scenario failure, which read
   * as a seeding defect when it is the source platform's rule.
   *
   * So the segment length is derived from the budget actually left after the prefix, and a 400 is
   * treated as the expected stop: the chain keeps whatever depth it reached, and that is reported
   * as INFO rather than as a warning claiming the feature cannot be validated. Fifteen levels
   * exercise 12.1 exactly as well as twenty — what matters is that Google reproduces the depth.
   */
  async _seedLongPath(siteId, rootPath, email, site) {
    logger.info('[SharePointTestDataAgent] Long folder path (feature 12.1)');
    const container = '10-Long-Path';
    const containerPath = `${rootPath}/${container}`;

    // What SharePoint counts: /sites/<site>/Shared Documents + our path + the file name.
    const sitePrefix = `${site?.sitePath || '/sites/QA'}/Shared Documents`;
    const FILE = '/deep_target.txt';
    const BUDGET = 400 - sitePrefix.length - containerPath.length - FILE.length - 8; // 8 = headroom
    // Each level costs the segment plus its separator. Keep names >= 8 chars so they stay readable.
    const perLevel = Math.max(8, Math.floor(BUDGET / LONG_PATH_LEVELS) - 1);
    logger.info(`[SharePointTestDataAgent]   path budget ${BUDGET} chars after "${sitePrefix}`
      + `${containerPath}" → ${LONG_PATH_LEVELS} level(s) of ${perLevel} chars`);

    let current = containerPath;
    const segments = [];
    let stoppedBy = null;
    try {
      await sharepointClient.createFolder(siteId, rootPath, container, email);
    } catch (err) {
      this._warn('longPath', err, container);
      return;
    }
    for (let i = 1; i <= LONG_PATH_LEVELS; i += 1) {
      const label = `L${String(i).padStart(2, '0')}-`;
      const seg = label + 'x'.repeat(Math.max(1, perLevel - label.length));
      try {
        await sharepointClient.createFolder(siteId, current, seg, email);
        current = `${current}/${seg}`;
        segments.push(seg);
      } catch (err) {
        // 400 here is SharePoint refusing the length — the expected end of the chain, not a defect.
        stoppedBy = err?.response?.status === 400
          ? `SharePoint refused a deeper path at level ${i} (its own ~400-character URL limit)`
          : `level ${i} failed: ${err.message}`;
        break;
      }
    }

    if (segments.length === 0) {
      this._warn('longPath', new Error(stoppedBy || 'no level could be created'), container);
      return;
    }
    try {
      await sharepointClient.uploadFile(siteId, current, 'deep_target.txt',
        Buffer.from('The deepest file in the long-path chain (feature 12.1). Google imposes no '
          + 'path limit, so it must arrive at the same depth with no relocation.'), email);
    } catch (err) {
      this._warn('longPath', err, 'deep_target.txt');
    }
    this.results.longPath = {
      levels: segments.length,
      approxLength: `${sitePrefix}${current}${FILE}`.length,
      deepestPath: current,
      stoppedBy,
    };
    if (stoppedBy) {
      // INFO, not a warning: the chain exists and the feature is exercised at the depth reached.
      logger.info(`[SharePointTestDataAgent]   chain stopped at ${segments.length} level(s) — ${stoppedBy}`);
    }
  }

  // ── 15.1 Custom library ───────────────────────────────────────────────────
  async _seedCustomLibrary(siteId, email, editorEmail) {
    const name = (env.SHAREPOINT_SOURCE_LIBRARY || '').trim();
    if (!name) {
      logger.info('[SharePointTestDataAgent] Custom library (feature 15.1): SHAREPOINT_SOURCE_LIBRARY '
        + 'is not set — scenario skipped, and 15.1 will report as not exercised');
      return null;
    }
    logger.info(`[SharePointTestDataAgent] Custom library "${name}" (feature 15.1)`);
    try {
      const drive = await sharepointClient.ensureDocumentLibrary(siteId, name, email);
      const opts = { driveId: drive.id };
      const folderName = 'Custom-Library-Content';
      await sharepointClient.createFolder(siteId, '/', folderName, email, opts);
      const folderPath = `/${folderName}`;
      await sharepointClient.uploadFile(siteId, folderPath, 'custom_library_file.txt',
        Buffer.from('A file in a CUSTOM SharePoint document library, not the default one '
          + '(feature 15.1).'), email, opts);
      await sharepointClient.createFolder(siteId, folderPath, 'Inner', email, opts);
      await sharepointClient.uploadFile(siteId, `${folderPath}/Inner`, 'custom_library_inner.txt',
        Buffer.from('A file one level down inside the custom library (feature 15.1).'), email, opts);
      // A grant inside the custom library — the scope document says its permissions migrate too.
      // Isolated like every other grant: an unusable principal must not cost the library itself,
      // which is the evidence feature 15.1 rests on.
      await this._grantOrWarn('customLibrary', '15.1 (library permissions)', siteId,
        `${folderPath}/custom_library_file.txt`, editorEmail, 'write', email, opts);
      this.results.customLibrary = {
        name: drive.name,
        driveId: drive.id,
        rootFolderName: folderName,
        rootFolderPath: folderPath,
      };
      return this.results.customLibrary;
    } catch (err) {
      // 403 on POST /sites/{id}/lists is a specific, actionable permission gap and deserves to say
      // so: creating a LIST needs Sites.Manage.All (or Sites.FullControl.All), which
      // Sites.ReadWrite.All does not cover — so uploads and grants succeed while library creation
      // is refused, which is exactly what the first run looked like. Either grant it, or create the
      // library by hand once: ensureDocumentLibrary returns an existing library unchanged.
      const status = err?.response?.status;
      if (status === 403) {
        this._warn('customLibrary', new Error(
          `Graph refused to create the library (403). Creating a document library needs `
          + `Sites.Manage.All or Sites.FullControl.All — Sites.ReadWrite.All is not enough, which is `
          + `why every upload above succeeded. Either grant one of those (with admin consent), or `
          + `create a library named "${name}" once by hand in the site; this agent reuses an `
          + 'existing one. Features 15.1 and 16.1 cannot be validated until then.'
        ), name);
      } else {
        this._warn('customLibrary', err, name);
      }
      // Recorded so 16.1 can say the library was REFUSED rather than "not configured" — two
      // different problems with two different fixes.
      this.results.customLibraryError = {
        name,
        status: status || null,
        message: err.message,
      };
      return null;
    }
  }

  /** A real .docx carrying real hyperlinks — used by both link features. */
  async _buildDocx(intro, links) {
    const { Document, Packer, Paragraph, TextRun, ExternalHyperlink } = require('docx');
    const children = [
      new Paragraph({ children: [new TextRun(intro)] }),
      new Paragraph({ children: [new TextRun('')] }),
    ];
    for (const l of links) {
      children.push(new Paragraph({
        children: [
          new TextRun(`${l.label}: `),
          new ExternalHyperlink({
            children: [new TextRun({ text: l.text || l.url, style: 'Hyperlink' })],
            link: l.url,
          }),
        ],
      }));
      // The URL as plain text as well, so a reader (and the report) can see the expected target
      // even in a destination rendering that dropped the hyperlink relationship.
      children.push(new Paragraph({ children: [new TextRun(`Source URL: ${l.url}`)] }));
    }
    const doc = new Document({ sections: [{ children }] });
    return Packer.toBuffer(doc);
  }

  // ── 14.1 Embedded links ───────────────────────────────────────────────────
  /**
   * A .docx whose hyperlink points at ANOTHER file seeded in this same run.
   *
   * A real hyperlink in a real Office document, not a URL in a .txt: the feature is about links
   * CloudFuze can rewrite, and a plain-text URL is not one — failing on it would report a defect
   * against behaviour that was never promised.
   */
  async _seedEmbeddedLinks(siteId, rootPath, email, site) {
    logger.info('[SharePointTestDataAgent] Embedded links (feature 14.1)');
    const container = '11-Embedded-Links';
    const containerPath = `${rootPath}/${container}`;
    try {
      await sharepointClient.createFolder(siteId, rootPath, container, email);
      const target = await sharepointClient.uploadFile(siteId, containerPath, 'embedded_link_target.txt',
        Buffer.from('This file is the target of a link embedded in embedded_link_doc.docx.'), email);
      const targetUrl = target?.webUrl
        || `https://${site.hostname}${site.sitePath}/Shared%20Documents${containerPath}/embedded_link_target.txt`;
      const buf = await this._buildDocx(
        'Embedded link test document (feature 14.1).',
        [{ label: 'Open the target file', text: 'embedded_link_target.txt', url: targetUrl }]
      );
      await sharepointClient.uploadFile(siteId, containerPath, 'embedded_link_doc.docx', buf, email);
      this.results.embeddedLinks = {
        documentName: 'embedded_link_doc.docx',
        documentPath: `${container}/embedded_link_doc.docx`,
        targetName: 'embedded_link_target.txt',
        targetPath: `${container}/embedded_link_target.txt`,
        sourceUrl: targetUrl,
      };
      logger.info(`[SharePointTestDataAgent]   embedded_link_doc.docx links to ${targetUrl}`);
    } catch (err) {
      this._warn('embeddedLinks', err, container);
    }
  }

  // ── 16.1 CrossLinks ───────────────────────────────────────────────────────
  /**
   * A .docx linking ACROSS libraries — into the custom library, when one was seeded.
   *
   * Feature 16.1 is the same mechanism as 14.1 with a different subject: the link crosses from one
   * SharePoint library to another, and the destination is expected to point at the migrated copy.
   * Without a custom library there is nothing to cross to, so the scenario is skipped and 16.1
   * reports as not exercised rather than being answered by 14.1's evidence.
   */
  async _seedCrossLinks(siteId, rootPath, email, site, library) {
    logger.info('[SharePointTestDataAgent] Cross links (feature 16.1)');
    if (!library) {
      // Name the ACTUAL cause. "unset or creation failed" covered two problems with different
      // fixes, and the first run printed it while SHAREPOINT_SOURCE_LIBRARY was in fact set and
      // Graph had refused the create with a 403 — sending the reader to the wrong place.
      const failure = this.results.customLibraryError;
      this._warn('crossLinks', new Error(
        failure
          ? `the custom library "${failure.name}" could not be created`
            + `${failure.status ? ` (HTTP ${failure.status})` : ''}, so there is nothing to `
            + 'cross-link to — see the customLibrary warning above for the fix'
          : 'SHAREPOINT_SOURCE_LIBRARY is not set, so no second library exists to cross-link to — '
            + 'feature 16.1 cannot be exercised'
      ));
      return;
    }
    const container = '12-CrossLinks';
    const containerPath = `${rootPath}/${container}`;
    try {
      await sharepointClient.createFolder(siteId, rootPath, container, email);
      const targetPath = `${library.rootFolderPath}/custom_library_file.txt`;
      const targetItem = await sharepointClient
        .getFolderItem(siteId, targetPath, email, { driveId: library.driveId })
        .catch(() => null);
      const targetUrl = targetItem?.webUrl
        || `https://${site.hostname}${site.sitePath}/${encodeURIComponent(library.name)}${targetPath}`;
      const buf = await this._buildDocx(
        `Cross-link test document (feature 16.1). The link below points into the "${library.name}" `
        + 'document library, a different library on the same site.',
        [{ label: 'Open the cross-library target', text: 'custom_library_file.txt', url: targetUrl }]
      );
      await sharepointClient.uploadFile(siteId, containerPath, 'cross_link_doc.docx', buf, email);
      this.results.crossLinks = {
        documentName: 'cross_link_doc.docx',
        documentPath: `${container}/cross_link_doc.docx`,
        targetLibrary: library.name,
        targetPath,
        sourceUrl: targetUrl,
      };
      logger.info(`[SharePointTestDataAgent]   cross_link_doc.docx links to ${targetUrl}`);
    } catch (err) {
      this._warn('crossLinks', err, container);
    }
  }
}

module.exports = SharePointTestDataAgent;
module.exports.SPECIAL_FOLDER = SPECIAL_FOLDER;
module.exports.SPECIAL_FILE = SPECIAL_FILE;
module.exports.LONG_PATH_LEVELS = LONG_PATH_LEVELS;
module.exports.makeVersionContent = makeVersionContent;
