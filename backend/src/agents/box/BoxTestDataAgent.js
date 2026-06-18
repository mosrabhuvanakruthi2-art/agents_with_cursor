const { BaseAgent } = require('../core/BaseAgent');
const boxClient = require('../../clients/boxClient');
const logger = require('../../utils/logger');

// ─── Static file content buffers ─────────────────────────────────────────────

const SAMPLE_TXT = `Box Cloud QA - Text Document
Created: ${new Date().toISOString()}

This is a sample plain text file for Box migration QA testing.
It contains multiple paragraphs to simulate real-world document content.

Section 1: Overview
This document serves as test data for Box cloud migration validation.
It includes various text patterns that migration tools must preserve.

Section 2: Data Samples
Name: John Doe | Email: john.doe@example.com | Department: Engineering
Name: Jane Smith | Email: jane.smith@example.com | Department: Marketing

Section 3: Notes
All data in this file is synthetic and created for testing purposes.
Migration agents should transfer this file without any modification.

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

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Box QA Test Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #333; }
    h1 { color: #0061D5; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #0061D5; color: white; }
    .pass { color: green; font-weight: bold; }
  </style>
</head>
<body>
  <h1>Box Cloud Migration QA Report</h1>
  <p><strong>Generated:</strong> ${new Date().toISOString()}</p>
  <h2>Test Summary</h2>
  <table>
    <tr><th>Test Case</th><th>Category</th><th>Status</th></tr>
    <tr><td>File Upload</td><td>Content</td><td class="pass">PASS</td></tr>
    <tr><td>Folder Creation</td><td>Structure</td><td class="pass">PASS</td></tr>
    <tr><td>File Versioning</td><td>Versions</td><td class="pass">PASS</td></tr>
    <tr><td>Shared Links</td><td>Sharing</td><td class="pass">PASS</td></tr>
    <tr><td>Special Characters</td><td>Naming</td><td class="pass">PASS</td></tr>
    <tr><td>Deep Nesting</td><td>Structure</td><td class="pass">PASS</td></tr>
  </table>
  <p>All test scenarios executed successfully by Box QA Agent.</p>
</body>
</html>`;

const SAMPLE_JSON = JSON.stringify({
  name: 'Box QA Test Configuration',
  version: '1.0.0',
  created: new Date().toISOString(),
  environment: 'QA',
  settings: { maxFileSize: '5GB', versioningEnabled: true, sharingEnabled: true, retentionDays: 365 },
  testSuites: [
    { id: 1, name: 'File Operations', tests: 25, status: 'active' },
    { id: 2, name: 'Folder Management', tests: 18, status: 'active' },
    { id: 3, name: 'Version Control', tests: 12, status: 'active' },
    { id: 4, name: 'Sharing & Permissions', tests: 10, status: 'active' },
  ],
}, null, 2);

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<boxQaTest>
  <metadata>
    <created>${new Date().toISOString()}</created>
    <environment>QA</environment>
    <version>1.0</version>
  </metadata>
  <testData>
    <item id="1"><name>Document A</name><type>pdf</type><size>1024</size></item>
    <item id="2"><name>Spreadsheet B</name><type>xlsx</type><size>2048</size></item>
    <item id="3"><name>Image C</name><type>jpg</type><size>512</size></item>
    <item id="4"><name>Archive D</name><type>zip</type><size>4096</size></item>
  </testData>
  <results><status>PASS</status><message>Box QA data created successfully</message></results>
</boxQaTest>`;

const SAMPLE_JS = `/**
 * Box Cloud QA Test Script
 * Generated: ${new Date().toISOString()}
 */
const BoxClient = {
  baseUrl: 'https://api.box.com/2.0',
  async getUsers(token) {
    const res = await fetch(\`\${this.baseUrl}/users?user_type=managed\`, {
      headers: { Authorization: \`Bearer \${token}\` },
    });
    return res.json();
  },
  async createFolder(name, parentId, token) {
    const res = await fetch(\`\${this.baseUrl}/folders\`, {
      method: 'POST',
      headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent: { id: parentId } }),
    });
    return res.json();
  },
  async createSharedLink(fileId, token) {
    const res = await fetch(\`\${this.baseUrl}/files/\${fileId}?fields=shared_link\`, {
      method: 'PUT',
      headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shared_link: { access: 'open' } }),
    });
    return res.json();
  },
};
module.exports = BoxClient;`;

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

// Minimal valid ZIP (contains qa-archive.txt)
const SAMPLE_ZIP = Buffer.from(
  'UEsDBBQAAAAAAIFSl1iua2JjFwAAABcAAAAOAAAAcWEtYXJjaGl2ZS50eHRtaWdyYXRpb24tcWEgemlwIHNhbXBsZVBLAQIUABQAAAAAAIFSl1iua2JjFwAAABcAAAAOAAAAAAAAAAAAAAAAAAAAAABxYS1hcmNoaXZlLnR4dFBLBQYAAAAAAQA8AAAAQwAAAAAAAAA=',
  'base64'
);

// Minimal valid single-page PDF
const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj\n' +
  '4 0 obj<</Length 46>>stream\nBT /F1 12 Tf 72 720 Td (Box QA Test PDF) Tj ET\nendstream\nendobj\n' +
  'xref\n0 5\ntrailer<</Root 1 0 R/Size 5>>\nstartxref\n200\n%%EOF'
);

const ROOT_README = `Box Cloud QA — Agent Data Root
================================
Created: ${new Date().toISOString()}

This folder was created by the Box QA Data Agent.

Contents:
  Agent sub folder/  — 10 diverse file types (txt, csv, html, json, xml, js, jpg, png, zip, pdf)
  Agent Versions/    — 3 files, each with 7 tracked versions
  Long Folder Path/  — 30 levels of nested sub-folders
  Special chars folder, long-name folder
  root_readme.txt    — this file
  root_manifest.csv  — folder index

All data is synthetic and for QA testing only.`;

const ROOT_MANIFEST = `Type,Name,Description,Created
folder,Agent sub folder,Diverse file types,${new Date().toISOString()}
folder,Agent Versions,Versioned files (7 versions x 3 files),${new Date().toISOString()}
folder,Long Folder Path,30-level nested structure,${new Date().toISOString()}
file,root_readme.txt,Root documentation,${new Date().toISOString()}
file,root_manifest.csv,Folder index (this file),${new Date().toISOString()}`;

// ─── Version content generator ────────────────────────────────────────────────

function makeVersionContent(docName, v) {
  const ts = new Date().toISOString();
  const bodies = {
    1: `Original Content:\nInitial draft of ${docName} for Box migration QA.\n\nSection 1: Introduction\nDocument created to test Box file versioning capabilities.\nAll content is synthetic and for testing purposes only.`,
    2: `Content Added (v2):\nAdded new section to document.\n\nSection 1: Introduction\nDocument created to test Box versioning capabilities.\n\nSection 2: New Content (Added in v2)\nNew data point: ${Math.random().toFixed(4)}\nAdditional information appended to support QA process.`,
    3: `Edited Content (v3):\nModified existing sections, added analysis.\n\nSection 1: Introduction (Updated)\nModified introduction with additional context.\n\nSection 2: Content\nUpdated with revised information.\n\nSection 3: Analysis (New)\n- Item A: ${Math.floor(Math.random() * 100)}\n- Item B: ${Math.floor(Math.random() * 100)}\n- Item C: ${Math.floor(Math.random() * 100)}`,
    4: `Revised Content (v4):\nDeleted outdated sections, restructured document.\n\nSection 1: Introduction (Revised)\nDocument revised for Box QA — outdated content removed.\n\nSection 3: Analysis (Retained)\n- Item A: confirmed\n- Item C: confirmed\n\nNote: Section 2 removed as redundant.`,
    5: `Renamed Headers (v5):\n\n01. Overview\nHeaders renamed for clarity in version 5.\n\n02. Core Analysis\n- Alpha: 100\n- Beta: 200\n- Gamma: 350\n\n03. Remarks\nHeader renaming completed. Structure improved.`,
    6: `Summary Added (v6):\n\n01. Overview\nDocument with added summary section.\n\n02. Core Analysis\n- Alpha: 100\n- Beta: 200\n- Gamma: 350\n\nSummary:\nThis document has undergone 5 major revisions.\nChanges: 12 lines added, 6 removed, 4 headers renamed.`,
    7: `FINAL VERSION (v7):\n\n01. Overview [FINAL]\nFinal approved version of ${docName} for Box QA.\n\n02. Core Analysis [FINAL]\n- Alpha: 100 [VERIFIED]\n- Beta:  200 [VERIFIED]\n- Gamma: 350 [VERIFIED]\n\nSummary:\nVersion history: 7 versions created and tracked.\nFinal review: ${new Date().toLocaleDateString()}\n\nStatus: APPROVED — FINAL VERSION`,
  };
  return Buffer.from(`=== ${docName} ===\nVersion: ${v}\nDate: ${ts}\n\n${bodies[v] || bodies[7]}\n\n--- End of Document ---`);
}

// ─── Agent ────────────────────────────────────────────────────────────────────

class BoxTestDataAgent extends BaseAgent {
  constructor() {
    super('BoxTestDataAgent');
    this.results = {};
    this.sharedLinks = [];
    this.errors = [];
  }

  async execute(context) {
    const { adminEmail, boxTargetUserId } = context;
    if (!adminEmail) throw new Error('adminEmail is required for BoxTestDataAgent');

    const token = await boxClient.getValidToken(adminEmail);
    const asUserId = boxTargetUserId || null;

    logger.info(`[BoxTestDataAgent] Starting — admin: ${adminEmail}${asUserId ? `, as-user: ${asUserId}` : ''}`);

    // 1. Root folder "Agent Box Data" at Box root (parent id "0")
    logger.info('[BoxTestDataAgent] Creating root folder: Agent Box Data');
    const rootFolder = await boxClient.createFolder('Agent Box Data', '0', token, asUserId);
    this.results.rootFolderId = rootFolder.id;
    logger.info(`[BoxTestDataAgent] Root folder id: ${rootFolder.id}`);

    // Run all scenarios sequentially so each can reference prior IDs
    await this._createSubFolder(rootFolder.id, token, asUserId);
    await this._createRootFiles(rootFolder.id, token, asUserId);
    await this._createVersionsFolder(rootFolder.id, token, asUserId);
    await this._createLongPath(rootFolder.id, token, asUserId);
    await this._createLongNameFolder(rootFolder.id, token, asUserId);
    await this._createSpecialCharsFolder(rootFolder.id, token, asUserId);
    await this._createSharedLinks(token, asUserId);

    logger.info('[BoxTestDataAgent] All scenarios completed');
    return {
      rootFolderId: this.results.rootFolderId,
      scenarios: this.results,
      sharedLinks: this.sharedLinks,
      warnings: this.errors,
    };
  }

  // ── Scenario 1: Agent sub folder with 10 file types ────────────────────────
  async _createSubFolder(rootId, token, asUserId) {
    logger.info('[BoxTestDataAgent] Scenario 1 — Agent sub folder');
    const subFolder = await boxClient.createFolder('Agent sub folder', rootId, token, asUserId);
    this.results.subFolderId = subFolder.id;

    const files = [
      { name: 'sample_text.txt',   content: Buffer.from(SAMPLE_TXT) },
      { name: 'sample_data.csv',   content: Buffer.from(SAMPLE_CSV) },
      { name: 'sample_report.html',content: Buffer.from(SAMPLE_HTML) },
      { name: 'sample_config.json',content: Buffer.from(SAMPLE_JSON) },
      { name: 'sample_data.xml',   content: Buffer.from(SAMPLE_XML) },
      { name: 'sample_script.js',  content: Buffer.from(SAMPLE_JS) },
      { name: 'sample_image.jpg',  content: SAMPLE_JPEG },
      { name: 'sample_image.png',  content: SAMPLE_PNG },
      { name: 'sample_archive.zip',content: SAMPLE_ZIP },
      { name: 'sample_document.pdf',content: SAMPLE_PDF },
    ];

    this.results.subFolderFiles = [];
    for (const f of files) {
      try {
        const uploaded = await boxClient.uploadFile(f.name, f.content, subFolder.id, token, asUserId);
        this.results.subFolderFiles.push({ name: f.name, id: uploaded.id });
        if (f.name === 'sample_text.txt') this.results.sampleTxtFileId = uploaded.id;
        logger.info(`[BoxTestDataAgent]   Uploaded: ${f.name}`);
      } catch (err) {
        logger.warn(`[BoxTestDataAgent]   Failed: ${f.name} — ${err.message}`);
        this.errors.push({ scenario: 'subFolder', file: f.name, error: err.message });
      }
    }
  }

  // ── Scenario 2: Root files directly in "Agent Box Data" ────────────────────
  async _createRootFiles(rootId, token, asUserId) {
    logger.info('[BoxTestDataAgent] Scenario 2 — Root files');
    const rootFiles = [
      { name: 'root_readme.txt',   content: Buffer.from(ROOT_README) },
      { name: 'root_manifest.csv', content: Buffer.from(ROOT_MANIFEST) },
    ];
    this.results.rootFiles = [];
    for (const f of rootFiles) {
      try {
        const uploaded = await boxClient.uploadFile(f.name, f.content, rootId, token, asUserId);
        this.results.rootFiles.push({ name: f.name, id: uploaded.id });
        if (f.name === 'root_readme.txt') this.results.rootReadmeFileId = uploaded.id;
        logger.info(`[BoxTestDataAgent]   Uploaded root file: ${f.name}`);
      } catch (err) {
        logger.warn(`[BoxTestDataAgent]   Failed root file ${f.name}: ${err.message}`);
        this.errors.push({ scenario: 'rootFiles', file: f.name, error: err.message });
      }
    }
  }

  // ── Scenario 3: "Agent Versions" — 3 files × 7 versions each ──────────────
  async _createVersionsFolder(rootId, token, asUserId) {
    logger.info('[BoxTestDataAgent] Scenario 3 — Agent Versions (3 files × 7 versions)');
    const versionsFolder = await boxClient.createFolder('Agent Versions', rootId, token, asUserId);
    this.results.versionsFolderId = versionsFolder.id;

    const versionedDocs = ['versioned_doc_1.txt', 'versioned_doc_2.txt', 'versioned_doc_3.txt'];
    this.results.versionedFiles = [];

    for (const filename of versionedDocs) {
      try {
        logger.info(`[BoxTestDataAgent]   Creating ${filename} — version 1`);
        const initial = await boxClient.uploadFile(filename, makeVersionContent(filename, 1), versionsFolder.id, token, asUserId);
        const fileId = initial.id;

        for (let v = 2; v <= 7; v++) {
          await boxClient.uploadVersion(fileId, filename, makeVersionContent(filename, v), token, asUserId);
          logger.info(`[BoxTestDataAgent]   ${filename} — version ${v}`);
        }
        this.results.versionedFiles.push({ name: filename, id: fileId, versions: 7 });
      } catch (err) {
        logger.warn(`[BoxTestDataAgent]   Versioning failed for ${filename}: ${err.message}`);
        this.errors.push({ scenario: 'versions', file: filename, error: err.message });
      }
    }
  }

  // ── Scenario 4: "Long Folder Path" — 30 levels deep ───────────────────────
  async _createLongPath(rootId, token, asUserId) {
    logger.info('[BoxTestDataAgent] Scenario 4 — Long Folder Path (30 nested levels)');
    const container = await boxClient.createFolder('Long Folder Path', rootId, token, asUserId);
    this.results.longPathContainerId = container.id;

    let parentId = container.id;
    this.results.longPathFolders = [];
    for (let i = 1; i <= 30; i++) {
      try {
        const f = await boxClient.createFolder(`Long Folder Path ${i}`, parentId, token, asUserId);
        this.results.longPathFolders.push({ name: `Long Folder Path ${i}`, id: f.id, level: i });
        parentId = f.id;
        logger.info(`[BoxTestDataAgent]   Level ${i}: Long Folder Path ${i}`);
      } catch (err) {
        logger.warn(`[BoxTestDataAgent]   Long path stopped at level ${i}: ${err.message}`);
        this.errors.push({ scenario: 'longPath', level: i, error: err.message });
        break;
      }
    }
  }

  // ── Scenario 5: Folder with maximum name length (255 chars — Box API limit) ─
  async _createLongNameFolder(rootId, token, asUserId) {
    const prefix = 'Long Name Folder ';
    const longName = prefix + 'A'.repeat(255 - prefix.length);
    logger.info(`[BoxTestDataAgent] Scenario 5 — Long name folder (${longName.length} chars)`);
    try {
      const f = await boxClient.createFolder(longName, rootId, token, asUserId);
      this.results.longNameFolderId = f.id;
      this.results.longNameLength = longName.length;
      logger.info(`[BoxTestDataAgent]   Created: id ${f.id}, length ${longName.length}`);
    } catch (err) {
      logger.warn(`[BoxTestDataAgent]   Long name folder failed: ${err.message}`);
      this.errors.push({ scenario: 'longName', error: err.message });
    }
  }

  // ── Scenario 6: Folder with special characters in name ────────────────────
  async _createSpecialCharsFolder(rootId, token, asUserId) {
    const specialName = "Special !@#$%^&*()-_+=[]{};',. Folder";
    logger.info(`[BoxTestDataAgent] Scenario 6 — Special chars folder: ${specialName}`);
    try {
      const f = await boxClient.createFolder(specialName, rootId, token, asUserId);
      this.results.specialCharsFolderId = f.id;
      this.results.specialCharsName = specialName;
      logger.info(`[BoxTestDataAgent]   Created: id ${f.id}`);
    } catch (err) {
      logger.warn(`[BoxTestDataAgent]   Special chars failed (${err.message}), trying reduced set`);
      try {
        const fallback = 'Special !@#$%^&*() Folder';
        const f = await boxClient.createFolder(fallback, rootId, token, asUserId);
        this.results.specialCharsFolderId = f.id;
        this.results.specialCharsName = fallback;
        this.results.specialCharsFallback = true;
        logger.info(`[BoxTestDataAgent]   Created (fallback): id ${f.id}`);
      } catch (err2) {
        this.errors.push({ scenario: 'specialChars', error: err2.message });
      }
    }
  }

  // ── Scenario 7: Shared links for selected folders and files ───────────────
  async _createSharedLinks(token, asUserId) {
    logger.info('[BoxTestDataAgent] Scenario 7 — Shared links');
    const targets = [
      { type: 'folder', id: this.results.subFolderId,       label: 'Agent sub folder' },
      { type: 'folder', id: this.results.versionsFolderId,  label: 'Agent Versions' },
      { type: 'file',   id: this.results.sampleTxtFileId,   label: 'sample_text.txt' },
      { type: 'file',   id: this.results.rootReadmeFileId,  label: 'root_readme.txt' },
    ];

    for (const t of targets) {
      if (!t.id) continue;
      try {
        const url = await boxClient.createSharedLink(t.type, t.id, token, asUserId);
        this.sharedLinks.push({ label: t.label, type: t.type, id: t.id, url });
        logger.info(`[BoxTestDataAgent]   Shared link — ${t.label}: ${url}`);
      } catch (err) {
        logger.warn(`[BoxTestDataAgent]   Shared link failed for ${t.label}: ${err.message}`);
        this.errors.push({ scenario: 'sharedLinks', label: t.label, error: err.message });
      }
    }
  }
}

module.exports = BoxTestDataAgent;
