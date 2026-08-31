const { BaseAgent } = require('../core/BaseAgent');
const driveClient = require('../../clients/driveClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const { normalizeDriveName } = require('../../utils/driveNames');

// ─── Static file content buffers ─────────────────────────────────────────────

const SAMPLE_TXT = `Google Drive QA — Text Document

This is a sample plain text file created by DriveTestDataAgent for Google My Drive to OneDrive migration QA.

Section 1: Overview
This document tests plain text file migration. Content, encoding, and line breaks must be preserved.

Section 2: Data Samples
Name: Alice Johnson | Email: alice@example.com | Department: Engineering
Name: Bob Smith    | Email: bob@example.com    | Department: Marketing

Section 3: Notes
All data in this file is synthetic. Migration agents must transfer it without modification.

End of Document.`;

const SAMPLE_CSV = `ID,Name,Email,Department,Role,Salary,StartDate,Status
1,Alice Johnson,alice@example.com,Engineering,Senior Developer,95000,2021-03-15,Active
2,Bob Smith,bob@example.com,Marketing,Marketing Manager,82000,2020-07-01,Active
3,Carol White,carol@example.com,HR,HR Specialist,68000,2022-01-10,Active
4,David Lee,david@example.com,Finance,Financial Analyst,78000,2019-11-20,Active
5,Eve Chen,eve@example.com,Engineering,DevOps Engineer,92000,2021-08-05,Active
6,Frank Brown,frank@example.com,Sales,Account Executive,75000,2020-04-22,Inactive
7,Grace Kim,grace@example.com,Engineering,QA Engineer,80000,2022-06-01,Active
8,Henry Wilson,henry@example.com,Management,VP Engineering,150000,2018-01-01,Active
9,Iris Davis,iris@example.com,Design,UX Designer,88000,2021-09-15,Active
10,Jack Martinez,jack@example.com,Engineering,Backend Developer,90000,2023-02-01,Active`;

const SAMPLE_JSON = JSON.stringify({
  name: 'Drive QA Test Configuration',
  version: '1.0.0',
  environment: 'QA',
  combination: 'Google My Drive to OneDrive',
  settings: { maxFileSize: '250GB', versioningEnabled: true, sharingEnabled: true },
  testSuites: [
    { id: 1, name: 'File Types', tests: 12, status: 'active' },
    { id: 2, name: 'Folder Structure', tests: 8, status: 'active' },
    { id: 3, name: 'File Versions', tests: 5, status: 'active' },
    { id: 4, name: 'Permissions', tests: 6, status: 'active' },
    { id: 5, name: 'Native Conversion', tests: 3, status: 'active' },
  ],
}, null, 2);

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<driveQaTest>
  <metadata>
    <environment>QA</environment>
    <combination>Google My Drive to OneDrive</combination>
    <version>1.0</version>
  </metadata>
  <testData>
    <item id="1"><name>Document A</name><type>docx</type><size>1024</size></item>
    <item id="2"><name>Spreadsheet B</name><type>xlsx</type><size>2048</size></item>
    <item id="3"><name>Image C</name><type>jpg</type><size>512</size></item>
    <item id="4"><name>Archive D</name><type>zip</type><size>4096</size></item>
  </testData>
  <results><status>CREATED</status><message>Drive QA data created successfully</message></results>
</driveQaTest>`;

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Drive QA Test Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #333; }
    h1 { color: #1a73e8; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #1a73e8; color: white; }
    .pass { color: green; font-weight: bold; }
  </style>
</head>
<body>
  <h1>Google My Drive to OneDrive Migration QA Report</h1>
  <h2>Test Summary</h2>
  <table>
    <tr><th>Test Case</th><th>Category</th><th>Status</th></tr>
    <tr><td>File Upload</td><td>Content</td><td class="pass">CREATED</td></tr>
    <tr><td>Folder Creation</td><td>Structure</td><td class="pass">CREATED</td></tr>
    <tr><td>File Versioning</td><td>Versions</td><td class="pass">CREATED</td></tr>
    <tr><td>Permissions</td><td>Sharing</td><td class="pass">CREATED</td></tr>
    <tr><td>Native Files</td><td>Conversion</td><td class="pass">CREATED</td></tr>
    <tr><td>Special Chars</td><td>Naming</td><td class="pass">CREATED</td></tr>
    <tr><td>Deep Nesting</td><td>Structure</td><td class="pass">CREATED</td></tr>
  </table>
  <p>All inscope scenarios created by DriveTestDataAgent.</p>
</body>
</html>`;

// Minimal valid 1×1 JPEG
const SAMPLE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=',
  'base64'
);

// Minimal valid 1×1 PNG
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// Minimal valid ZIP
const SAMPLE_ZIP = Buffer.from(
  'UEsDBBQAAAAAAIFSl1iua2JjFwAAABcAAAAOAAAAcWEtYXJjaGl2ZS50eHRtaWdyYXRpb24tcWEgemlwIHNhbXBsZVBLAQIUABQAAAAAAIFSl1iua2JjFwAAABcAAAAOAAAAAAAAAAAAAAAAAAAAAABxYS1hcmNoaXZlLnR4dFBLBQYAAAAAAQA8AAAAQwAAAAAAAAA=',
  'base64'
);

// Minimal valid single-page PDF
const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj\n' +
  '4 0 obj<</Length 52>>stream\nBT /F1 12 Tf 72 720 Td (Drive QA Test PDF) Tj ET\nendstream\nendobj\n' +
  'xref\n0 5\ntrailer<</Root 1 0 R/Size 5>>\nstartxref\n200\n%%EOF'
);

const ROOT_README = `Google Drive QA — Agent Data Root
====================================

This folder was created by DriveTestDataAgent for Google My Drive → OneDrive migration QA.

Inscope features covered:
  Agent Files/         — 10 diverse file types (txt, csv, json, xml, html, jpg, png, zip, pdf, and a docx)
  Agent Native Files/  — Google Docs, Sheets, and Slides (converted to Office formats at destination)
  Agent Versions/      — 3 files, each with 5 tracked versions
  Agent Permissions/   — files shared with editor and viewer users
  Long Folder Path/    — 20 levels of nested sub-folders (deep nesting)
  Special !@#$ Folder/ — folder name with special characters
  Long Name Folder/    — folder name at near-maximum length
  root_readme.txt      — this file

All data is synthetic and created for QA testing only.`;

// ─── Version content generator ────────────────────────────────────────────────

function makeVersionContent(docName, v) {
  const bodies = {
    1:  `Original Content:\nInitial draft of ${docName} for Drive QA.\nThis is version 1 of the document.`,
    2:  `Content Added (v2):\nAdded new section.\n\nSection 1: Original\nInitial content from version 1.\n\nSection 2: New (v2)\nAdditional data appended in version 2.`,
    3:  `Edited Content (v3):\nModified existing sections.\n\nSection 1: Updated Introduction\nRevised text for clarity.\n\nSection 2: Analysis\n- Point A: confirmed\n- Point B: added\n- Point C: new`,
    4:  `Revised Content (v4):\nRestructured document.\n\nSection 1: Overview (revised)\nDocument restructured in version 4.\n\nSection 2: Key Points\n- Alpha: 100\n- Beta: 200`,
    5:  `APPROVED (v5):\n\n01. Overview [APPROVED]\nFirst approved version of ${docName}.\n\n02. Key Points\n- Alpha: 100 [VERIFIED]\n- Beta:  200 [VERIFIED]\n\nStatus: APPROVED`,
    6:  `Post-Approval Edit (v6):\nMinor corrections after approval.\n\n01. Overview [UPDATED]\nCorrected a typo in the overview.\n\n02. Key Points\n- Alpha: 100 [VERIFIED]\n- Beta:  200 [VERIFIED]\n- Gamma: 300 [NEW]\n\nStatus: UPDATED`,
    7:  `Peer Review (v7):\nChanges from peer review incorporated.\n\n01. Overview\nPeer review notes addressed.\n\n02. Key Points\n- Alpha: 100\n- Beta:  200\n- Gamma: 300 [REVIEWED]\n\n03. Review Notes\nAll comments resolved by reviewer.\n\nStatus: PEER REVIEWED`,
    8:  `Extended Analysis (v8):\nAdded extended analysis section.\n\n01. Overview\nDocument extended with new data.\n\n02. Key Points\n- Alpha: 100\n- Beta:  200\n- Gamma: 300\n- Delta: 400 [NEW]\n\n03. Extended Analysis\nNew metrics added in version 8.\n\nStatus: EXTENDED`,
    9:  `Pre-Final Review (v9):\nPre-final review changes applied.\n\n01. Overview [PRE-FINAL]\nAll sections reviewed and updated.\n\n02. Key Points [CONFIRMED]\n- Alpha: 100\n- Beta:  200\n- Gamma: 300\n- Delta: 400\n\n03. Summary\nDocument ready for final sign-off.\n\nStatus: PRE-FINAL`,
    10: `FINAL VERSION (v10):\n\n01. Overview [FINAL]\nFinal signed-off version of ${docName}.\n\n02. Key Points [FINAL]\n- Alpha: 100 [LOCKED]\n- Beta:  200 [LOCKED]\n- Gamma: 300 [LOCKED]\n- Delta: 400 [LOCKED]\n\n03. Sign-off\nApproved and locked. No further edits.\n\nStatus: FINAL — DO NOT EDIT`,
  };
  const dynamicBody = bodies[v] || `Incremental Update (v${v}):\nContinued iteration on ${docName}.\n\nChange Log:\n- v${v}: Automated incremental content update\n- Revision timestamp: ${v * 1000}\n- Build: ${v}\n\nData Metrics (v${v}):\n- Records processed: ${v * 42}\n- Checksum: ${(v * 7919) % 99991}\n- Status: ACTIVE\n\nNotes:\nThis is version ${v} of the document, generated for delta migration QA.\nEach version introduces a unique checksum and record count.`;
  return Buffer.from(`=== ${docName} ===\nVersion: ${v}\n\n${dynamicBody}\n\n--- End ---`);
}

// ─── Agent ────────────────────────────────────────────────────────────────────

/**
 * DriveTestDataAgent — creates test data in Google My Drive covering all inscope
 * features for the "Google My Drive to One Drive" content migration combination.
 *
 * Inscope features exercised:
 *   - All file types (txt, csv, json, xml, html, jpg, png, zip, pdf, docx)
 *   - Google Workspace native files (Doc, Sheet, Slide) → conversion test
 *   - File version history (5 versions × 3 files)
 *   - Nested folder structure
 *   - Deep nesting (20 levels)
 *   - Special characters in folder/file names
 *   - Long folder names
 *   - Internal user permissions (editor, viewer)
 *   - Root-level files
 */
class DriveTestDataAgent extends BaseAgent {
  constructor() {
    super('DriveTestDataAgent');
    this.results = {};
    this.errors = [];
  }

  async execute(context) {
    const { sourceEmail, sourceFolderName = 'Agent My Drive' } = context;
    // The main QA flow never sets these — only the standalone seeding endpoint does — so the
    // permission matrix skipped silently on every real run. Fall back to configuration, the same
    // way groupEmail and externalEmail already do.
    const editorEmail = context.editorEmail || env.GOOGLE_TEST_EDITOR_EMAIL || '';
    const viewerEmail = context.viewerEmail || env.GOOGLE_TEST_VIEWER_EMAIL || '';
    if (!sourceEmail) throw new Error('sourceEmail is required for DriveTestDataAgent');

    logger.info(`[DriveTestDataAgent] Starting — user: ${sourceEmail}, target folder: ${sourceFolderName}`);

    // Shared Drive target, when one is configured. A Shared Drive's id doubles as its root folder id,
    // so everything below is unchanged apart from where the tree is rooted. Shared Drives are also the
    // only place the Content Manager (fileOrganizer) role exists, so the permission matrix needs one.
    const sharedDriveName = normalizeDriveName(context.sourceSharedDriveName || env.GOOGLE_SHARED_DRIVE_NAME);
    let sharedDrive = null;
    if (sharedDriveName) {
      sharedDrive = await driveClient.resolveSharedDriveByName(sharedDriveName, sourceEmail);
      if (!sharedDrive) {
        // This used to warn and seed into My Drive instead. That made a wrong drive name invisible:
        // the run seeded My Drive, migrated My Drive and reported SUCCESS, while every log line and
        // the report still said "Shared Drive". It is not hypothetical — GOOGLE_SHARED_DRIVE_NAME
        // sat at a drive that had been renamed, and nothing surfaced it.
        //
        // A drive that was explicitly named and cannot be resolved is a configuration error, so
        // stop. Seeding somewhere else tests the wrong location, which CLAUDE.md §1 calls a bug in
        // this system's own terms. Runs that name no drive at all are untouched and still use
        // My Drive legitimately.
        throw new Error(
          `Shared Drive "${sharedDriveName}" is not visible to ${sourceEmail}. `
          + 'Check the name matches exactly and that the account is a member of the drive '
          + '(Manage members → Manager). Refusing to fall back to My Drive, which would seed and '
          + 'validate the wrong location while reporting success.'
        );
      }
      logger.info(`[DriveTestDataAgent] Seeding into Shared Drive "${sharedDrive.name}" (${sharedDrive.id})`);
    }
    this.results.sharedDrive = sharedDrive ? { id: sharedDrive.id, name: sharedDrive.name } : null;
    const parentRoot = sharedDrive?.id || 'root';

    // Find or create the target folder at the chosen root
    let rootFolder = await driveClient.findByName(sourceFolderName, parentRoot, sourceEmail);
    if (rootFolder) {
      logger.info(`[DriveTestDataAgent] Found existing folder: ${sourceFolderName} (${rootFolder.id})`);
    } else {
      logger.info(`[DriveTestDataAgent] Creating folder: ${sourceFolderName}`);
      rootFolder = await driveClient.createFolder(sourceFolderName, sharedDrive?.id || null, sourceEmail);
      logger.info(`[DriveTestDataAgent] Created: ${sourceFolderName} (${rootFolder.id})`);
    }
    this.results.rootFolderId = rootFolder.id;
    this.results.rootFolderName = sourceFolderName;

    // Upload root-level readme (Inscope: Root Level Files)
    await this._createRootFiles(rootFolder.id, sourceEmail);

    // Run all inscope scenarios
    await this._createFilesFolder(rootFolder.id, sourceEmail);
    await this._createNativeFilesFolder(rootFolder.id, sourceEmail);
    await this._createVersionsFolder(rootFolder.id, sourceEmail);
    await this._createPermissionsFolder(rootFolder.id, sourceEmail, editorEmail, viewerEmail);
    await this._createDeepNesting(rootFolder.id, sourceEmail);
    await this._createSpecialCharsFolder(rootFolder.id, sourceEmail);
    await this._createLongNameFolder(rootFolder.id, sourceEmail);
    await this._createSharedLinks(sourceEmail);
    // Scenarios that exist so no documented feature is left unexercised (and therefore reported
    // "not assessed") in the Shared Drive → SharePoint checklist.
    await this._createPermissionMatrix(rootFolder.id, sourceEmail, editorEmail, viewerEmail, sharedDrive, {
      // The manual QA suite's dominant dimensions: group grants (most of its cases) and external users.
      groupEmail: context.groupEmail || env.GOOGLE_TEST_GROUP_EMAIL || '',
      // GOOGLE_TEST_GROUP_EMAIL may be a comma-separated list; each role then gets its own group.
      groupEmails: String(context.groupEmail || env.GOOGLE_TEST_GROUP_EMAIL || '')
        .split(',').map((x) => x.trim()).filter(Boolean),
      externalEmail: context.externalEmail || env.GOOGLE_TEST_EXTERNAL_EMAIL || '',
    });
    // Drive-level ("Level 1") membership — feature 4.10. Everything above grants on folders and
    // files; nothing granted on the DRIVE itself, so "is this drive open to everyone or restricted
    // to a few" was never seeded and never testable. Runs only when the row declares a mode.
    await this._applyDriveAccessMode(sharedDrive, sourceEmail, context);
    await this._createLinkMatrix(rootFolder.id, sourceEmail, sharedDrive);
    await this._createLegacyOfficeFiles(rootFolder.id, sourceEmail);
    await this._createOverLimitPath(rootFolder.id, sourceEmail);

    // Inventory of what was actually created, mirroring how the mail agent reports its counters.
    // Printed to the log AND returned, so the execution record answers "what data exists in the
    // source?" without anyone opening Drive — and so a seed that silently created nothing is visible.
    const r = this.results;
    const count = (v) => (Array.isArray(v) ? v.length : (v ? 1 : 0));
    const summary = {
      rootFolderName: sourceFolderName,
      rootFolderId: r.rootFolderId || null,
      sharedDrive: r.sharedDrive ? `${r.sharedDrive.name} (${r.sharedDrive.id})` : '(My Drive)',
      fileTypes: count(r.filesCreated) || count(r.filesFolderIds),
      nativeFiles: count(r.nativeFiles),
      versionedFiles: count(r.versionFiles),
      fileFormats: count(r.legacyOfficeFiles),
      permissionGrants: count(r.permissionMatrix),
      sharedLinkGrants: count(r.linkMatrix),
      sharedLinks: count(r.sharedLinks),
      deepNestingLevels: count(r.deepNestingFolders),
      specialCharsFolder: r.specialCharsName || null,
      overLimitPathChars: r.overLimitPath?.approxLength || 0,
      warnings: this.errors.length,
    };

    logger.info('[DriveTestDataAgent] ── Seeded data inventory ──────────────────────────────');
    logger.info(`[DriveTestDataAgent]   target            : ${summary.sharedDrive}`);
    logger.info(`[DriveTestDataAgent]   root folder       : ${summary.rootFolderName} (${summary.rootFolderId || 'not created'})`);
    logger.info(`[DriveTestDataAgent]   file types        : ${summary.fileTypes}`);
    logger.info(`[DriveTestDataAgent]   declared formats  : ${summary.fileFormats}  (.doc/.xls/.ppt + pass-through)`);
    logger.info(`[DriveTestDataAgent]   Google native     : ${summary.nativeFiles}  (Doc/Sheet/Slides)`);
    logger.info(`[DriveTestDataAgent]   versioned files   : ${summary.versionedFiles}`);
    logger.info(`[DriveTestDataAgent]   permission grants : ${summary.permissionGrants}  (users + groups + external)`);
    logger.info(`[DriveTestDataAgent]   shared-link grants: ${summary.sharedLinkGrants}  (anonymous + organization)`);
    logger.info(`[DriveTestDataAgent]   deep nesting      : ${summary.deepNestingLevels} level(s)`);
    logger.info(`[DriveTestDataAgent]   special chars     : ${summary.specialCharsFolder || '(none)'}`);
    logger.info(`[DriveTestDataAgent]   over-limit path   : ${summary.overLimitPathChars} chars`);
    if (this.errors.length > 0) {
      logger.warn(`[DriveTestDataAgent]   warnings          : ${this.errors.length} scenario(s) not seeded — these features cannot be validated:`);
      for (const w of this.errors.slice(0, 20)) {
        logger.warn(`[DriveTestDataAgent]     - ${w.scenario}${w.item ? `/${w.item}` : ''}: ${w.error}`);
      }
    }
    logger.info('[DriveTestDataAgent] ───────────────────────────────────────────────────────');

    // A seed that created no root folder produced no data at all; say so rather than reporting success.
    if (!r.rootFolderId) {
      throw new Error(
        'DriveTestDataAgent created no data — the root folder was never created. '
        + 'Check Drive access for the source account (the Drive scope must be granted) and the '
        + 'Shared Drive name.'
      );
    }

    logger.info('[DriveTestDataAgent] All inscope scenarios completed');
    return {
      rootFolderId: r.rootFolderId,
      rootFolderName: sourceFolderName,
      // The Shared Drive the data lives in. CloudFuze needs it to enumerate the folder's children:
      // given only a folder id it reports zero contents (job 6a885ddc7371a25e3aa6ab66).
      sharedDriveId: this.results.sharedDrive?.id || null,
      // The name too, so a multi-drive run can record which drive each transfer unit actually
      // used. Reading it back off the resolved drive rather than the requested string means the
      // report shows Google's own spelling.
      sharedDriveName: this.results.sharedDrive?.name || null,
      // Drive-level membership actually applied (feature 4.10), or null when no mode was declared.
      driveAccess: this.results.driveAccess || null,
      summary,
      scenarios: r,
      sharedLinks: r.sharedLinks || [],
      warnings: this.errors,
    };
  }

  // ── Root files (Inscope: Root Level Files) ────────────────────────────────
  async _createRootFiles(rootId, email) {
    logger.info('[DriveTestDataAgent] Root files');
    try {
      const f = await driveClient.uploadFile('root_readme.txt', 'text/plain', Buffer.from(ROOT_README), rootId, email);
      this.results.rootReadmeId = f.id;
      logger.info(`[DriveTestDataAgent]   Uploaded: root_readme.txt (${f.id})`);
    } catch (err) {
      logger.warn(`[DriveTestDataAgent]   root_readme.txt failed: ${err.message}`);
      this.errors.push({ scenario: 'rootFiles', file: 'root_readme.txt', error: err.message });
    }
  }

  // ── Scenario 1: All file types (Inscope: All File Types) ─────────────────
  async _createFilesFolder(rootId, email) {
    logger.info('[DriveTestDataAgent] Scenario 1 — Agent Files (diverse file types)');
    const folder = await driveClient.createFolder('Agent Files', rootId, email);
    this.results.filesFolderId = folder.id;

    const files = [
      { name: 'qa_notes.txt',        mime: 'text/plain',       content: Buffer.from(SAMPLE_TXT) },
      { name: 'qa_employees.csv',    mime: 'text/csv',          content: Buffer.from(SAMPLE_CSV) },
      { name: 'qa_config.json',      mime: 'application/json',  content: Buffer.from(SAMPLE_JSON) },
      { name: 'qa_testdata.xml',     mime: 'application/xml',   content: Buffer.from(SAMPLE_XML) },
      { name: 'qa_report.html',      mime: 'text/html',         content: Buffer.from(SAMPLE_HTML) },
      { name: 'qa_photo.jpg',        mime: 'image/jpeg',        content: SAMPLE_JPEG },
      { name: 'qa_logo.png',         mime: 'image/png',         content: SAMPLE_PNG },
      { name: 'qa_archive.zip',      mime: 'application/zip',   content: SAMPLE_ZIP },
      { name: 'qa_manual.pdf',       mime: 'application/pdf',   content: SAMPLE_PDF },
    ];

    this.results.filesUploaded = [];
    for (const f of files) {
      try {
        const uploaded = await driveClient.uploadFile(f.name, f.mime, f.content, folder.id, email);
        this.results.filesUploaded.push({ name: f.name, id: uploaded.id });
        logger.info(`[DriveTestDataAgent]   Uploaded: ${f.name} (${uploaded.id})`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   Failed: ${f.name} — ${err.message}`);
        this.errors.push({ scenario: 'files', file: f.name, error: err.message });
      }
    }
  }

  // ── Scenario 2: Google Workspace native files (Inscope: Native Conversion) ─
  async _createNativeFilesFolder(rootId, email) {
    logger.info('[DriveTestDataAgent] Scenario 2 — Agent Native Files (Docs, Sheets, Slides)');
    const folder = await driveClient.createFolder('Agent Native Files', rootId, email);
    this.results.nativeFilesFolderId = folder.id;

    const natives = [
      { name: 'QA Test Document',     mime: 'application/vnd.google-apps.document',     label: 'Google Doc' },
      { name: 'QA Test Spreadsheet',  mime: 'application/vnd.google-apps.spreadsheet',  label: 'Google Sheet' },
      { name: 'QA Test Presentation', mime: 'application/vnd.google-apps.presentation', label: 'Google Slide' },
    ];

    this.results.nativeFiles = [];
    for (const n of natives) {
      try {
        const created = await driveClient.createNativeFile(n.name, n.mime, folder.id, email);
        this.results.nativeFiles.push({ name: n.name, id: created.id, label: n.label });
        logger.info(`[DriveTestDataAgent]   Created ${n.label}: ${n.name} (${created.id})`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   Failed ${n.label}: ${err.message}`);
        this.errors.push({ scenario: 'nativeFiles', name: n.name, error: err.message });
      }
    }
  }

  // ── Scenario 3: File versions (Inscope: File Version History) ────────────
  async _createVersionsFolder(rootId, email) {
    logger.info('[DriveTestDataAgent] Scenario 3 — Agent Versions (3 files × 5 versions)');
    const folder = await driveClient.createFolder('Agent Versions', rootId, email);
    this.results.versionsFolderId = folder.id;

    const docs = ['versioned_doc_1.txt', 'versioned_doc_2.txt', 'versioned_doc_3.txt'];
    this.results.versionedFiles = [];

    for (const name of docs) {
      try {
        logger.info(`[DriveTestDataAgent]   ${name} — version 1`);
        const initial = await driveClient.uploadFile(name, 'text/plain', makeVersionContent(name, 1), folder.id, email);
        const fileId = initial.id;

        for (let v = 2; v <= 5; v++) {
          await driveClient.uploadVersion(fileId, 'text/plain', makeVersionContent(name, v), email);
          logger.info(`[DriveTestDataAgent]   ${name} — version ${v}`);
        }
        this.results.versionedFiles.push({ name, id: fileId, versions: 5 });
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   Versioning failed for ${name}: ${err.message}`);
        this.errors.push({ scenario: 'versions', file: name, error: err.message });
      }
    }
  }

  // ── Scenario 4: Permissions — editor and viewer (Inscope: Permissions) ────
  async _createPermissionsFolder(rootId, ownerEmail, editorEmail, viewerEmail) {
    logger.info('[DriveTestDataAgent] Scenario 4 — Agent Permissions (editor + viewer)');
    const folder = await driveClient.createFolder('Agent Permissions', rootId, ownerEmail);
    this.results.permissionsFolderId = folder.id;

    // Upload a file to share
    let sharedFileId = null;
    try {
      const f = await driveClient.uploadFile(
        'shared_file.txt', 'text/plain',
        Buffer.from('This file is shared with editor and viewer users for permissions QA.'),
        folder.id, ownerEmail
      );
      sharedFileId = f.id;
      this.results.sharedFileId = f.id;
      logger.info(`[DriveTestDataAgent]   Uploaded shared_file.txt (${f.id})`);
    } catch (err) {
      logger.warn(`[DriveTestDataAgent]   shared_file.txt upload failed: ${err.message}`);
      this.errors.push({ scenario: 'permissions', step: 'upload', error: err.message });
    }

    // Share with editor
    if (sharedFileId && editorEmail) {
      try {
        await driveClient.shareFile(sharedFileId, editorEmail, 'writer', ownerEmail);
        this.results.editorPermission = { email: editorEmail, role: 'writer' };
        logger.info(`[DriveTestDataAgent]   Shared as editor with ${editorEmail}`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   Editor share failed: ${err.message}`);
        this.errors.push({ scenario: 'permissions', step: 'editor', error: err.message });
      }
    } else if (!editorEmail) {
      logger.info('[DriveTestDataAgent]   Skipping editor share — editorEmail not provided');
    }

    // Share with viewer
    if (sharedFileId && viewerEmail) {
      try {
        await driveClient.shareFile(sharedFileId, viewerEmail, 'reader', ownerEmail);
        this.results.viewerPermission = { email: viewerEmail, role: 'reader' };
        logger.info(`[DriveTestDataAgent]   Shared as viewer with ${viewerEmail}`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   Viewer share failed: ${err.message}`);
        this.errors.push({ scenario: 'permissions', step: 'viewer', error: err.message });
      }
    } else if (!viewerEmail) {
      logger.info('[DriveTestDataAgent]   Skipping viewer share — viewerEmail not provided');
    }
  }

  // ── Drive-level membership (feature 4.10) ─────────────────────────────────
  /**
   * Grant access on the DRIVE itself, so a run can prove that an open drive stays open and a
   * restricted drive stays restricted after migration.
   *
   * Two modes, declared per row:
   *   open        — the configured everyone-group gets Content Manager at the drive root. Folders
   *                 and files inherit it; nothing is granted per item (the approved reading of
   *                 "all levels" — see spec 002 Assumptions).
   *   restricted  — only the named principals are granted, and the everyone-group is NOT.
   *
   * `organizer` (Manager) is deliberately never granted: the in-scope document maps Viewer,
   * Commenter, Contributor and Content Manager to a destination access level and gives Manager
   * none, so a Manager grant migrates to nothing and would only add noise.
   *
   * A no-op without a Shared Drive or without an access mode, so existing runs are unchanged.
   */
  async _applyDriveAccessMode(sharedDrive, ownerEmail, context) {
    const mode = String(context.driveAccessMode || '').trim().toLowerCase();
    if (!sharedDrive || !mode) {
      this.results.driveAccess = null;
      return;
    }
    if (mode !== 'open' && mode !== 'restricted') {
      logger.warn(`[DriveTestDataAgent] Unknown driveAccessMode "${mode}" — skipping drive-level grants`);
      this.results.driveAccess = { mode, skipped: 'unknown mode' };
      return;
    }

    const everyoneGroup = String(context.everyoneGroupEmail || env.GOOGLE_TEST_GROUP_EMAIL || '')
      .split(',').map((s) => s.trim()).filter(Boolean)[0] || '';

    // The "few" for a restricted drive: the same principals the folder matrix already uses, so the
    // two drives differ only in whether the everyone-group is present.
    const few = [
      [env.GOOGLE_TEST_EDITOR_EMAIL, 'fileOrganizer'],
      [env.GOOGLE_TEST_VIEWER_EMAIL, 'reader'],
    ].filter(([who]) => who);

    const granted = [];
    const targets = mode === 'open'
      ? (everyoneGroup ? [[everyoneGroup, 'fileOrganizer']] : [])
      : few;

    if (targets.length === 0) {
      // Reported rather than passed silently: with nothing to grant, feature 4.10 has not been
      // exercised and must not come out green.
      logger.warn(`[DriveTestDataAgent] driveAccessMode=${mode} but no principal configured `
        + `(${mode === 'open' ? 'GOOGLE_TEST_GROUP_EMAIL' : 'GOOGLE_TEST_EDITOR_EMAIL / GOOGLE_TEST_VIEWER_EMAIL'}) — nothing seeded`);
      this.results.driveAccess = { mode, driveId: sharedDrive.id, granted: [], skipped: 'no principal configured' };
      return;
    }

    for (const [who, role] of targets) {
      try {
        // A Shared Drive's id doubles as its root folder id, so the same permissions call works.
        await driveClient.shareFile(sharedDrive.id, who, role, ownerEmail);
        granted.push({ email: who, role });
        logger.info(`[DriveTestDataAgent]   drive "${sharedDrive.name}" shared with ${who} as ${role} (mode=${mode})`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   drive-level grant failed for ${who} as ${role}: ${err.message}`);
        this.errors.push({ scenario: 'driveAccess', item: `${who}:${role}`, error: err.message });
      }
    }
    this.results.driveAccess = { mode, driveId: sharedDrive.id, driveName: sharedDrive.name, granted, everyoneGroup: mode === 'open' ? everyoneGroup : null };
  }

  // ── Permission matrix (features 4.2–4.8) ──────────────────────────────────
  /**
   * Seed one folder and one file at every source role the feature doc lists, so each of features
   * 4.2–4.8 has something to validate.
   *
   * Content Manager (`fileOrganizer`) exists only on Shared Drives — on My Drive the API rejects it,
   * so that role is skipped with a logged reason rather than silently omitted.
   */
  async _createPermissionMatrix(rootId, ownerEmail, editorEmail, viewerEmail, sharedDrive, principals) {
    logger.info('[DriveTestDataAgent] Permission matrix (features 4.2–4.8)');
    const grantees = [editorEmail, viewerEmail].filter(Boolean);
    if (grantees.length === 0) {
      logger.info('[DriveTestDataAgent]   Skipping — no editorEmail/viewerEmail provided');
      this.results.permissionMatrix = { skipped: 'no grantee emails provided' };
      return;
    }

    // reader/commenter/writer work anywhere; fileOrganizer is Shared Drive only.
    const roles = ['reader', 'commenter', 'writer'];
    if (sharedDrive) roles.push('fileOrganizer');
    else logger.info('[DriveTestDataAgent]   fileOrganizer (Content Manager) needs a Shared Drive — skipped');

    const container = await driveClient.createFolder('Permission Matrix', rootId, ownerEmail);
    this.results.permissionMatrixFolderId = container.id;
    const seeded = [];

    // The manual QA suite covers three principals per role — internal user, external user, and GROUP
    // — with group grants making up the majority of its cases. Group and external grantees are only
    // seeded when configured; a missing one is logged so the checklist can honestly say "not
    // exercised" instead of implying the dimension passed.
    const { groupEmail, externalEmail } = principals || {};
    const groupEmails = (principals && principals.groupEmails && principals.groupEmails.length)
      ? principals.groupEmails
      : (groupEmail ? [groupEmail] : []);
    if (groupEmails.length === 0) {
      logger.info('[DriveTestDataAgent]   No group email configured — group permissions not seeded');
    } else {
      logger.info(`[DriveTestDataAgent]   ${groupEmails.length} group(s) configured for permission grants`);
    }
    if (!externalEmail) logger.info('[DriveTestDataAgent]   No external email configured — external shares not seeded');

    for (const [roleIndex, role] of roles.entries()) {
      // Indexed on the role so the same role always gets the same grantee across runs.
      const grantee = grantees[roleIndex % grantees.length];
      // A folder at this role
      try {
        const folder = await driveClient.createFolder(`folder_${role}`, container.id, ownerEmail);

        // Google refuses some roles for some accounts — "Cannot set the requested role for that
        // user as they lack the necessary license". Two things used to go wrong when it did:
        //
        //   1. The rotation put `commenter` and `fileOrganizer` on an unlicensed account, so
        //      features 4.3 and 4.5 were never seeded and reported NA rather than pass or fail.
        //   2. The throw escaped to the outer try, which skipped the GROUP and EXTERNAL grants for
        //      that role as well — one licence limit silently cost three test cases.
        //
        // So try the assigned grantee, fall back to any other configured account that can hold the
        // role, and keep the failure local either way.
        const candidates = [grantee, ...grantees.filter((g) => g !== grantee)];
        let userGrantee = null;
        let lastErr = null;
        for (const who of candidates) {
          try {
            await driveClient.shareFile(folder.id, who, role, ownerEmail);
            userGrantee = who;
            break;
          } catch (err) {
            lastErr = err;
            if (!/lack the necessary license/i.test(err.message || '')) break;
          }
        }
        if (userGrantee) {
          seeded.push({ itemType: 'folder', role, grantee: userGrantee, principal: 'user', id: folder.id });
          logger.info(`[DriveTestDataAgent]   folder_${role} shared with ${userGrantee} as ${role}`
            + (userGrantee === grantee ? '' : ` (fell back from ${grantee} — licence)`));
        } else {
          logger.warn(`[DriveTestDataAgent]   folder_${role} user share failed for every configured `
            + `account: ${lastErr ? lastErr.message : 'unknown'}`);
          this.errors.push({ scenario: 'permissionMatrix', item: `folder_${role}_user`,
            error: lastErr ? lastErr.message : 'no grantee could hold this role' });
        }

        // Same role, granted to a group — the dimension most of the QA suite exercises.
        const roleGroup = groupEmails.length > 0
          ? groupEmails[roleIndex % groupEmails.length]
          : null;
        if (roleGroup) {
          try {
            await driveClient.shareFile(folder.id, roleGroup, role, ownerEmail);
            seeded.push({ itemType: 'folder', role, grantee: roleGroup, principal: 'group', id: folder.id });
            logger.info(`[DriveTestDataAgent]   folder_${role} shared with group ${roleGroup} as ${role}`);
          } catch (err) {
            logger.warn(`[DriveTestDataAgent]   folder_${role} group share failed: ${err.message}`);
            this.errors.push({ scenario: 'permissionMatrix', item: `folder_${role}_group`, error: err.message });
          }
        }
        // Same role, granted to a user outside the source domain (feature 4.9).
        if (externalEmail) {
          try {
            await driveClient.shareFile(folder.id, externalEmail, role, ownerEmail);
            seeded.push({ itemType: 'folder', role, grantee: externalEmail, principal: 'external', id: folder.id });
            logger.info(`[DriveTestDataAgent]   folder_${role} shared externally with ${externalEmail} as ${role}`);
          } catch (err) {
            logger.warn(`[DriveTestDataAgent]   folder_${role} external share failed: ${err.message}`);
            this.errors.push({ scenario: 'permissionMatrix', item: `folder_${role}_external`, error: err.message });
          }
        }
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   folder_${role} failed: ${err.message}`);
        this.errors.push({ scenario: 'permissionMatrix', item: `folder_${role}`, error: err.message });
      }

      // fileOrganizer is a folder-level role in the feature doc; files use reader/commenter/writer.
      if (role === 'fileOrganizer') continue;
      try {
        const file = await driveClient.uploadFile(
          `file_${role}.txt`, 'text/plain',
          Buffer.from(`Shared at the "${role}" role to validate the permission mapping.`),
          container.id, ownerEmail
        );
        await driveClient.shareFile(file.id, grantee, role, ownerEmail);
        seeded.push({ itemType: 'file', role, grantee, id: file.id });
        logger.info(`[DriveTestDataAgent]   file_${role}.txt shared with ${grantee} as ${role}`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   file_${role}.txt failed: ${err.message}`);
        this.errors.push({ scenario: 'permissionMatrix', item: `file_${role}`, error: err.message });
      }
    }

    this.results.permissionMatrix = seeded;
  }

  // ── Shared-link matrix (features 5.2–5.15) ────────────────────────────────
  /**
   * Seed both link scopes at every role, on a folder and a file:
   *   'anyone' → "Anyone with the link"        (SharePoint: anonymous)
   *   'domain' → the source organization link  (SharePoint: "People in <org> with the link")
   * Without both scopes present, a run cannot tell a preserved public link from one quietly
   * narrowed to the organization.
   */
  async _createLinkMatrix(rootId, ownerEmail, sharedDrive) {
    logger.info('[DriveTestDataAgent] Shared-link matrix (features 5.2–5.15)');
    const domain = String(ownerEmail || '').split('@')[1] || '';
    const container = await driveClient.createFolder('Shared Link Matrix', rootId, ownerEmail);
    this.results.linkMatrixFolderId = container.id;

    const folderRoles = sharedDrive
      ? ['reader', 'commenter', 'writer', 'fileOrganizer']
      : ['reader', 'commenter', 'writer'];
    const fileRoles = ['reader', 'commenter', 'writer'];
    const scopes = domain ? ['anyone', 'domain'] : ['anyone'];
    if (!domain) logger.warn('[DriveTestDataAgent]   No domain on the owner email — organization links skipped');

    const seeded = [];
    for (const scope of scopes) {
      for (const role of folderRoles) {
        try {
          const folder = await driveClient.createFolder(`link_folder_${scope}_${role}`, container.id, ownerEmail);
          await driveClient.createLinkPermission(folder.id, { type: scope, role, domain }, ownerEmail);
          seeded.push({ itemType: 'folder', scope, role, id: folder.id });
          logger.info(`[DriveTestDataAgent]   link_folder_${scope}_${role}`);
        } catch (err) {
          logger.warn(`[DriveTestDataAgent]   link_folder_${scope}_${role} failed: ${err.message}`);
          this.errors.push({ scenario: 'linkMatrix', item: `folder_${scope}_${role}`, error: err.message });
        }
      }
      for (const role of fileRoles) {
        try {
          const file = await driveClient.uploadFile(
            `link_file_${scope}_${role}.txt`, 'text/plain',
            Buffer.from(`Link-shared: scope "${scope}", role "${role}".`),
            container.id, ownerEmail
          );
          await driveClient.createLinkPermission(file.id, { type: scope, role, domain }, ownerEmail);
          seeded.push({ itemType: 'file', scope, role, id: file.id });
          logger.info(`[DriveTestDataAgent]   link_file_${scope}_${role}.txt`);
        } catch (err) {
          logger.warn(`[DriveTestDataAgent]   link_file_${scope}_${role} failed: ${err.message}`);
          this.errors.push({ scenario: 'linkMatrix', item: `file_${scope}_${role}`, error: err.message });
        }
      }
    }

    this.results.linkMatrix = seeded;
  }

  // ── File formats (feature 12.1) ───────────────────────────────────────────
  /**
   * .doc / .xls / .ppt must arrive as .docx / .xlsx / .pptx; every other declared format must arrive
   * unchanged. Both expectations need a file in the source to be validated against.
   */
  async _createLegacyOfficeFiles(rootId, email) {
    logger.info('[DriveTestDataAgent] File formats (feature 12.1)');
    const container = await driveClient.createFolder('File Formats', rootId, email);
    this.results.legacyOfficeFolderId = container.id;

    // The three legacy formats CloudFuze upgrades, plus the declared pass-through formats that the
    // other scenarios don't already seed (_createFilesFolder covers txt/csv/json/xml/jpg/png/zip/pdf).
    // Without these, feature 12.1 can only ever be validated for a subset of its formats.
    const files = [
      { name: 'legacy_document.doc', mime: 'application/msword' },
      { name: 'legacy_workbook.xls', mime: 'application/vnd.ms-excel' },
      { name: 'legacy_deck.ppt', mime: 'application/vnd.ms-powerpoint' },
      { name: 'macro_workbook.xlsm', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12' },
      { name: 'macro_document.docm', mime: 'application/vnd.ms-word.document.macroEnabled.12' },
      { name: 'macro_deck.pptm', mime: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12' },
      { name: 'notebook.one', mime: 'application/onenote' },
      { name: 'diagram.vsdx', mime: 'application/vnd.visio' },
      { name: 'clip.mp4', mime: 'video/mp4' },
      { name: 'audio.mp3', mime: 'audio/mpeg' },
      { name: 'bundle.rar', mime: 'application/vnd.rar' },
      { name: 'modern_document.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { name: 'modern_workbook.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { name: 'modern_deck.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    ];
    const seeded = [];
    for (const f of files) {
      try {
        // Content is plain text; the point is the extension and the declared type, which is what
        // drives CloudFuze's conversion.
        const created = await driveClient.uploadFile(
          f.name, f.mime,
          Buffer.from(`Legacy format fixture for the file-conversion feature (${f.name}).`),
          container.id, email
        );
        seeded.push({ name: f.name, id: created.id });
        logger.info(`[DriveTestDataAgent]   Uploaded ${f.name}`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   ${f.name} failed: ${err.message}`);
        this.errors.push({ scenario: 'legacyOffice', item: f.name, error: err.message });
      }
    }
    this.results.legacyOfficeFiles = seeded;
  }

  // ── Over-limit path (feature 11.1) ────────────────────────────────────────
  /**
   * Build a destination path past SharePoint's 400-character limit so the placeholder-link behaviour
   * can be validated. The limit counts the URL-ENCODED path, and each segment is capped at 255, so
   * this uses several long-but-legal segments rather than one enormous name.
   */
  async _createOverLimitPath(rootId, email) {
    logger.info('[DriveTestDataAgent] Over-limit path (feature 11.1)');
    const container = await driveClient.createFolder('Over Limit Path', rootId, email);
    this.results.overLimitRootId = container.id;

    const segment = 'L'.repeat(120);
    let parentId = container.id;
    const segments = [];
    try {
      // 4 × 120 characters plus separators and the destination prefix clears 400.
      for (let i = 1; i <= 4; i++) {
        const folder = await driveClient.createFolder(`${segment}${i}`, parentId, email);
        parentId = folder.id;
        segments.push(folder.name);
      }
      const file = await driveClient.uploadFile(
        'over_limit_target.txt', 'text/plain',
        Buffer.from('This file sits past the 400-character SharePoint path limit. A Folder/File Path Link URL is the expected destination outcome.'),
        parentId, email
      );
      this.results.overLimitPath = {
        depth: segments.length,
        approxLength: segments.join('/').length,
        fileId: file.id,
      };
      logger.info(`[DriveTestDataAgent]   Built a ${segments.join('/').length}-character path`);
    } catch (err) {
      logger.warn(`[DriveTestDataAgent]   Over-limit path failed: ${err.message}`);
      this.errors.push({ scenario: 'overLimitPath', error: err.message });
    }
  }

  // ── Scenario 5: Deep nesting — 20 levels (Inscope: Deep Nesting) ─────────
  async _createDeepNesting(rootId, email) {
    logger.info('[DriveTestDataAgent] Scenario 5 — Long Folder Path (20 nested levels)');
    const container = await driveClient.createFolder('Long Folder Path', rootId, email);
    this.results.deepNestingRootId = container.id;

    let parentId = container.id;
    this.results.deepNestingFolders = [];
    for (let i = 1; i <= 20; i++) {
      try {
        const f = await driveClient.createFolder(`Level ${i}`, parentId, email);
        this.results.deepNestingFolders.push({ name: `Level ${i}`, id: f.id, depth: i });
        parentId = f.id;
        logger.info(`[DriveTestDataAgent]   Depth ${i}: Level ${i} (${f.id})`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   Deep nesting stopped at level ${i}: ${err.message}`);
        this.errors.push({ scenario: 'deepNesting', level: i, error: err.message });
        break;
      }
    }

    // Drop a file at the deepest level
    if (parentId !== container.id) {
      try {
        const f = await driveClient.uploadFile(
          'deep_file.txt', 'text/plain',
          Buffer.from('File at the deepest folder level — tests long path migration.'),
          parentId, email
        );
        this.results.deepFileId = f.id;
        logger.info(`[DriveTestDataAgent]   File at deepest level: ${f.id}`);
      } catch (err) {
        this.errors.push({ scenario: 'deepNesting', step: 'deepFile', error: err.message });
      }
    }
  }

  // ── Scenario 6: Special characters in name (Inscope: Special Characters) ──
  async _createSpecialCharsFolder(rootId, email) {
    const specialName = "Special !@#$%^&*()-_+=[] Folder";
    logger.info(`[DriveTestDataAgent] Scenario 6 — Special chars folder: ${specialName}`);
    try {
      const f = await driveClient.createFolder(specialName, rootId, email);
      this.results.specialCharsFolderId = f.id;
      this.results.specialCharsName = specialName;
      logger.info(`[DriveTestDataAgent]   Created: ${specialName} (${f.id})`);

      // Upload a file with special chars in name too
      const uploaded = await driveClient.uploadFile(
        'file !@# special.txt', 'text/plain',
        Buffer.from('File with special characters in name — tests filename sanitization.'),
        f.id, email
      );
      this.results.specialCharsFileId = uploaded.id;
      logger.info(`[DriveTestDataAgent]   Special-name file: ${uploaded.id}`);
    } catch (err) {
      logger.warn(`[DriveTestDataAgent]   Special chars failed (${err.message}), trying reduced set`);
      try {
        const fallback = 'Special !@#$ Folder';
        const f = await driveClient.createFolder(fallback, rootId, email);
        this.results.specialCharsFolderId = f.id;
        this.results.specialCharsName = fallback;
        this.results.specialCharsFallback = true;
        logger.info(`[DriveTestDataAgent]   Created (fallback): ${fallback} (${f.id})`);
      } catch (err2) {
        this.errors.push({ scenario: 'specialChars', error: err2.message });
      }
    }
  }

  // ── Scenario 7: Long folder name (Inscope: Long File Names) ───────────────
  async _createLongNameFolder(rootId, email) {
    const prefix = 'Long Name Folder ';
    // Google Drive folder name limit is 32,767 chars but keep it practical for migration QA
    const longName = prefix + 'A'.repeat(200 - prefix.length);
    logger.info(`[DriveTestDataAgent] Scenario 7 — Long name folder (${longName.length} chars)`);
    try {
      const f = await driveClient.createFolder(longName, rootId, email);
      this.results.longNameFolderId = f.id;
      this.results.longNameLength = longName.length;
      logger.info(`[DriveTestDataAgent]   Created: ${longName.length}-char folder (${f.id})`);
    } catch (err) {
      logger.warn(`[DriveTestDataAgent]   Long name folder failed: ${err.message}`);
      this.errors.push({ scenario: 'longName', error: err.message });
    }
  }

  // ── Setup: remove public links + create Agent Shared Links folder ────────
  /**
   * 1. Removes "anyone with the link" public permissions from all previously shared items.
   * 2. Creates "Agent Shared Links" folder inside the given root folder.
   * 3. Creates 5 files inside it with targeted access:
   *    - file_1_public_viewer.txt  → "anyone with the link" viewer
   *    - file_2_public_editor.txt  → "anyone with the link" editor
   *    - file_3_domain_viewer.txt  → storefuze.com domain viewer
   *    - file_4_domain_commenter.txt → storefuze.com domain commenter
   *    - file_5_domain_editor.txt  → storefuze.com domain editor
   *
   * @param {string} email - owner email
   * @param {string} rootFolderId - ID of "Agent My Drive" folder
   * @param {Array<{label, id}>} existingSharedItems - items whose public links to remove first
   * @param {string} domain - domain for restricted links (e.g. 'storefuze.com')
   */
  async setupSharedLinksFolder(email, rootFolderId, existingSharedItems = [], domain = 'storefuze.com') {
    this.results.sharedLinksSetup = {};

    // Step 1: Remove existing public "anyone" links
    logger.info(`[DriveTestDataAgent] Step 1 — removing public links from ${existingSharedItems.length} item(s)`);
    const removed = [];
    for (const item of existingSharedItems) {
      try {
        const wasRemoved = await driveClient.removePublicLink(item.id, email);
        removed.push({ label: item.label, id: item.id, removed: wasRemoved });
        logger.info(`[DriveTestDataAgent]   ${wasRemoved ? 'Removed' : 'No public link found on'}: ${item.label}`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   Remove link failed for ${item.label}: ${err.message}`);
        this.errors.push({ scenario: 'removePublicLinks', label: item.label, error: err.message });
      }
    }
    this.results.sharedLinksSetup.removedLinks = removed;

    // Step 2: Find or create "Agent Shared Links" folder
    logger.info('[DriveTestDataAgent] Step 2 — find-or-create Agent Shared Links folder');
    let folder = await driveClient.findByName('Agent Shared Links', rootFolderId, email);
    if (folder) {
      logger.info(`[DriveTestDataAgent]   Folder already exists: ${folder.id}`);
    } else {
      folder = await driveClient.createFolder('Agent Shared Links', rootFolderId, email);
      logger.info(`[DriveTestDataAgent]   Folder created: ${folder.id}`);
    }
    this.results.sharedLinksSetup.folderId = folder.id;

    // Step 3: Create 5 files + apply permissions
    const fileSpecs = [
      { name: 'file_1_public_viewer.txt',    content: 'Public viewer file — anyone with the link can view this file.'    },
      { name: 'file_2_public_editor.txt',    content: 'Public editor file — anyone with the link can edit this file.'    },
      { name: 'file_3_domain_viewer.txt',    content: `Domain viewer file — only ${domain} users can view this file.`    },
      { name: 'file_4_domain_commenter.txt', content: `Domain commenter file — only ${domain} users can comment on this file.` },
      { name: 'file_5_domain_editor.txt',    content: `Domain editor file — only ${domain} users can edit this file.`    },
    ];

    logger.info('[DriveTestDataAgent] Step 3 — creating 5 files with targeted permissions');
    this.results.sharedLinksSetup.files = [];

    for (const spec of fileSpecs) {
      let fileId = null;
      try {
        const uploaded = await driveClient.uploadFile(spec.name, 'text/plain', Buffer.from(spec.content), folder.id, email);
        fileId = uploaded.id;
        logger.info(`[DriveTestDataAgent]   Uploaded: ${spec.name} (${fileId})`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   Upload failed ${spec.name}: ${err.message}`);
        this.errors.push({ scenario: 'sharedLinksFolder', file: spec.name, step: 'upload', error: err.message });
        continue;
      }

      let link = null;
      let accessType = null;
      let role = null;

      try {
        if (spec.name === 'file_1_public_viewer.txt') {
          role = 'reader'; accessType = 'public';
          link = await driveClient.createSharedLink(fileId, email);
        } else if (spec.name === 'file_2_public_editor.txt') {
          role = 'writer'; accessType = 'public';
          // Override createSharedLink with writer role
          const drive = await driveClient.getDriveClient(email);
          await drive.permissions.create({ fileId, requestBody: { type: 'anyone', role: 'writer' }, fields: 'id' });
          const res = await drive.files.get({ fileId, fields: 'webViewLink' });
          link = res.data.webViewLink;
        } else if (spec.name === 'file_3_domain_viewer.txt') {
          role = 'reader'; accessType = 'domain';
          link = await driveClient.createDomainLink(fileId, domain, 'reader', email);
        } else if (spec.name === 'file_4_domain_commenter.txt') {
          role = 'commenter'; accessType = 'domain';
          link = await driveClient.createDomainLink(fileId, domain, 'commenter', email);
        } else if (spec.name === 'file_5_domain_editor.txt') {
          role = 'writer'; accessType = 'domain';
          link = await driveClient.createDomainLink(fileId, domain, 'writer', email);
        }
        logger.info(`[DriveTestDataAgent]   Permission set — ${spec.name}: ${accessType} ${role} → ${link}`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   Permission failed for ${spec.name}: ${err.message}`);
        this.errors.push({ scenario: 'sharedLinksFolder', file: spec.name, step: 'permission', error: err.message });
      }

      this.results.sharedLinksSetup.files.push({ name: spec.name, id: fileId, accessType, role, link });
    }

    return this.results.sharedLinksSetup;
  }

  // ── Update: append more versions to existing versioned files ─────────────
  /**
   * Adds versions (fromVersion+1 … toVersion) to existing Drive files.
   * @param {string} email - owner email
   * @param {Array<{name, id}>} versionedFiles - existing file list from a prior run
   * @param {number} fromVersion - last version already present (e.g. 5)
   * @param {number} toVersion   - target total versions (e.g. 10)
   */
  async updateVersions(email, versionedFiles, fromVersion, toVersion) {
    logger.info(`[DriveTestDataAgent] updateVersions — adding v${fromVersion + 1}–v${toVersion} to ${versionedFiles.length} file(s)`);
    this.results.updatedVersions = [];

    for (const file of versionedFiles) {
      const updates = [];
      for (let v = fromVersion + 1; v <= toVersion; v++) {
        try {
          await driveClient.uploadVersion(file.id, 'text/plain', makeVersionContent(file.name, v), email);
          updates.push(v);
          logger.info(`[DriveTestDataAgent]   ${file.name} — version ${v} uploaded`);
        } catch (err) {
          logger.warn(`[DriveTestDataAgent]   ${file.name} v${v} failed: ${err.message}`);
          this.errors.push({ scenario: 'updateVersions', file: file.name, version: v, error: err.message });
        }
      }
      this.results.updatedVersions.push({ name: file.name, id: file.id, addedVersions: updates, totalVersions: toVersion });
    }
    return this.results.updatedVersions;
  }

  // ── Scenario 8: Shareable hyperlinks (Inscope: Shareable Links) ──────────
  async _createSharedLinks(email) {
    logger.info('[DriveTestDataAgent] Scenario 8 — Shareable hyperlinks');
    this.results.sharedLinks = [];

    const targets = [
      { id: this.results.rootFolderId,        label: 'Agent My Drive (root folder)' },
      { id: this.results.filesFolderId,        label: 'Agent Files folder' },
      { id: this.results.nativeFilesFolderId,  label: 'Agent Native Files folder' },
      { id: this.results.sharedFileId,         label: 'shared_file.txt' },
      { id: this.results.rootReadmeId,         label: 'root_readme.txt' },
    ];

    for (const t of targets) {
      if (!t.id) continue;
      try {
        const url = await driveClient.createSharedLink(t.id, email);
        this.results.sharedLinks.push({ label: t.label, id: t.id, url });
        logger.info(`[DriveTestDataAgent]   Shared link — ${t.label}: ${url}`);
      } catch (err) {
        logger.warn(`[DriveTestDataAgent]   Shared link failed for ${t.label}: ${err.message}`);
        this.errors.push({ scenario: 'sharedLinks', label: t.label, error: err.message });
      }
    }
  }
}

module.exports = DriveTestDataAgent;