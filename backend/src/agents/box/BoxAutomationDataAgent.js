const { BaseAgent } = require('../core/BaseAgent');
const box = require('../../clients/boxClient');
const logger = require('../../utils/logger');

// ─── Shared file buffers ──────────────────────────────────────────────────────

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=',
  'base64'
);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const ZIP = Buffer.from(
  'UEsDBBQAAAAAAIFSl1iua2JjFwAAABcAAAAOAAAAcWEtYXJjaGl2ZS50eHRtaWdyYXRpb24tcWEgemlwIHNhbXBsZVBLAQIUABQAAAAAAIFSl1iua2JjFwAAABcAAAAOAAAAAAAAAAAAAAAAAAAAAABxYS1hcmNoaXZlLnR4dFBLBQYAAAAAAQA8AAAAQwAAAAAAAAA=',
  'base64'
);
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj\n' +
  '4 0 obj<</Length 46>>stream\nBT /F1 12 Tf 72 720 Td (Box QA Automation PDF) Tj ET\nendstream\nendobj\n' +
  'xref\n0 5\ntrailer<</Root 1 0 R/Size 5>>\nstartxref\n200\n%%EOF'
);

function txt(content) { return Buffer.from(content); }

// ─── Version content ──────────────────────────────────────────────────────────

function versionContent(docName, v, total) {
  const markers = {
    1: 'Original — initial content created.',
    2: 'Added new paragraph with additional data.',
    3: 'Edited section headers; updated figures.',
    4: 'Deleted outdated section; trimmed body.',
    5: 'Renamed headers for clarity.',
    6: 'Added summary section at the end.',
    7: 'Final review pass; all sections approved.',
    8: 'Post-approval patch: minor wording fix.',
    9: 'Added appendix with reference data.',
  };
  return txt(
    `=== ${docName} ===\nVersion: ${v} of ${total}\nDate: ${new Date().toISOString()}\n\nChange: ${markers[v] || `Revision ${v}`}\n\n` +
    `Body:\nThis is version ${v} of the document. ` +
    (v === 1
      ? 'It contains the original content created for Box migration QA testing.'
      : `It reflects the change described above from the previous version.`) +
    `\n\n--- End v${v} ---`
  );
}

function selectiveContent(docName, v, isSelected) {
  return txt(
    `=== ${docName} (Selective Versions) ===\nVersion: ${v}\nMigration Selection: ${isSelected ? 'SELECTED — include in migration' : 'SKIPPED — do not migrate this version'}\nDate: ${new Date().toISOString()}\n\nContent for version ${v}. ` +
    `${isSelected ? 'This version should appear in the migrated destination.' : 'This version should be excluded from the migrated destination.'}\n\n--- End v${v} ---`
  );
}

// ─── Box Notes JSON builder ───────────────────────────────────────────────────

function bn(content) {
  return txt(JSON.stringify({ version: 1, doc: { nodeType: 'doc', content } }));
}
function bnP(text, marks = []) {
  return { nodeType: 'paragraph', content: [{ nodeType: 'text', text, marks }] };
}
function bnBullet(items) {
  return { nodeType: 'bullet_list', content: items.map((t) => ({ nodeType: 'list_item', content: [bnP(t)] })) };
}
function bnCheck(items) {
  return { nodeType: 'check_list', content: items.map(({ text, checked = false }) => ({ nodeType: 'check_list_item', attrs: { checked }, content: [bnP(text)] })) };
}

// ─── Scenario helpers ─────────────────────────────────────────────────────────

async function tryCollaborate(itemType, itemId, email, role, token, suppressNotify, label) {
  if (!email) return null;
  try {
    const c = await box.createCollaboration(itemType, itemId, email, role, token, suppressNotify);
    logger.info(`[BoxAuto]   Collaboration added: ${label} (${role}) → ${email}`);
    return c;
  } catch (err) {
    logger.warn(`[BoxAuto]   Collaboration skipped for ${label}: ${err.response?.data?.message || err.message}`);
    return null;
  }
}

async function trySharedLink(itemType, itemId, token, label) {
  try {
    const url = await box.createSharedLink(itemType, itemId, token);
    logger.info(`[BoxAuto]   Shared link: ${label} → ${url}`);
    return url;
  } catch (err) {
    logger.warn(`[BoxAuto]   Shared link failed for ${label}: ${err.message}`);
    return null;
  }
}

// ─── Agent ────────────────────────────────────────────────────────────────────

class BoxAutomationDataAgent extends BaseAgent {
  constructor() {
    super('BoxAutomationDataAgent');
    this.report = {};
    this.errors = [];
  }

  async execute(context) {
    const { adminEmail, collaboratorEmail, boxTargetUserId } = context;
    if (!adminEmail) throw new Error('adminEmail is required');

    const token = await box.getValidToken(adminEmail);
    const uid = boxTargetUserId || null;

    logger.info(`[BoxAuto] Starting — admin: ${adminEmail}, collaborator: ${collaboratorEmail || 'none'}`);

    // Root: AUTOMATION BOX
    const root = await box.createFolder('AUTOMATION BOX', '0', token, uid);
    this.report.rootId = root.id;
    logger.info(`[BoxAuto] Root folder "AUTOMATION BOX" created: ${root.id}`);

    await this._oneTime(root.id, token, uid);
    await this._delta(root.id, token, uid);
    await this._folderDisplay(root.id, token, uid);
    await this._versions(root.id, token, uid);
    await this._selectiveVersions(root.id, token, uid);
    await this._rootFolderPermissions(root.id, token, uid, collaboratorEmail);
    await this._subFolderPermissions(root.id, token, uid, collaboratorEmail);
    await this._rootFilePermissions(root.id, token, uid, collaboratorEmail);
    await this._innerFilePermissions(root.id, token, uid, collaboratorEmail);
    await this._externalShares(root.id, token, uid);
    await this._sharedLinks(root.id, token, uid);
    await this._preserveTimestamp(root.id, token, uid);
    await this._inlineComments(root.id, token, uid);
    await this._longFolderPath(root.id, token, uid);
    await this._specialCharacters(root.id, token, uid);
    await this._embeddedLinks(root.id, token, uid);
    await this._suppressEmailNotifications(root.id, token, uid, collaboratorEmail);
    await this._groupPermissions(root.id, token, uid);
    await this._longFileFolderName(root.id, token, uid);
    await this._boxNotes(root.id, token, uid, collaboratorEmail);
    await this._addPermissionsToMainContent(root.id, token, uid, collaboratorEmail);

    logger.info('[BoxAuto] All 20 scenarios complete');
    return { rootFolderId: root.id, report: this.report, errors: this.errors };
  }

  // ── 01 · One Time ─────────────────────────────────────────────────────────
  async _oneTime(rootId, token, uid) {
    logger.info('[BoxAuto] 01 · One Time');
    const f = await box.createFolder('01 - One Time', rootId, token, uid);
    const sub = await box.createFolder('OneTime SubFolder', f.id, token, uid);

    const files = [
      ['onetime_document.txt', txt('Box QA — One Time Migration\nType: One Time\nThis file is migrated exactly once. Content must appear unchanged in destination.\n\nSection A\nRegular text content for one-time migration validation.\n\nSection B\nLine 2 — additional body text.\nLine 3 — more content.')],
      ['onetime_spreadsheet.csv', txt('ID,Product,Category,Price,Stock,Region\n1,Widget A,Electronics,29.99,150,North\n2,Widget B,Electronics,49.99,80,South\n3,Gadget X,Accessories,12.50,300,East\n4,Gadget Y,Accessories,18.75,220,West\n5,Tool Z,Hardware,89.00,45,North')],
      ['onetime_report.html', txt('<!DOCTYPE html><html><head><title>One Time Report</title></head><body><h1>Box One Time Migration</h1><p>This HTML file is part of the one-time migration scenario.</p><ul><li>All content preserved</li><li>Timestamps maintained</li><li>Structure intact</li></ul></body></html>')],
      ['onetime_config.json', txt(JSON.stringify({ type: 'one-time', migrationId: 'OT-001', retainVersions: false, preservePermissions: true, timestamp: new Date().toISOString() }, null, 2))],
      ['onetime_image.jpg', JPEG],
      ['onetime_image.png', PNG],
      ['onetime_archive.zip', ZIP],
      ['onetime_document.pdf', PDF],
    ];

    this.report.oneTime = { folderId: f.id, files: [] };
    for (const [name, buf] of files) {
      try {
        const up = await box.uploadFile(name, buf, f.id, token, uid);
        this.report.oneTime.files.push({ name, id: up.id });
        logger.info(`[BoxAuto]   Uploaded: ${name}`);
      } catch (e) { this._err('oneTime', name, e); }
    }

    const subFiles = [
      ['onetime_sub_doc_1.txt', txt('One Time SubFolder — Document 1\nThis nested file is part of the one-time migration test.\nAll sub-folder content should migrate as-is.')],
      ['onetime_sub_doc_2.txt', txt('One Time SubFolder — Document 2\nSecond nested file for one-time migration subfolder test.')],
      ['onetime_sub_data.csv', txt('Name,Value\nAlpha,100\nBeta,200\nGamma,300')],
    ];
    for (const [name, buf] of subFiles) {
      try {
        const up = await box.uploadFile(name, buf, sub.id, token, uid);
        this.report.oneTime.files.push({ name, id: up.id, subfolder: true });
      } catch (e) { this._err('oneTime.sub', name, e); }
    }
  }

  // ── 02 · Delta ────────────────────────────────────────────────────────────
  async _delta(rootId, token, uid) {
    logger.info('[BoxAuto] 02 · Delta');
    const f = await box.createFolder('02 - Delta', rootId, token, uid);
    const sub = await box.createFolder('Delta SubFolder', f.id, token, uid);

    this.report.delta = { folderId: f.id, files: [] };
    const deltaFiles = [
      ['delta_doc_1.txt', 'Delta Migration — Document 1\nType: Delta\nState: Pre-Migration (Initial)\n\nOriginal content created before first migration run.\nAfter initial migration, this file will be modified to create delta changes.\n\nData Set: Alpha\nRecord count: 50\nLast sync: initial'],
      ['delta_doc_2.txt', 'Delta Migration — Document 2\nType: Delta\nState: Pre-Migration (Initial)\n\nSecond delta test file. This will have new rows appended after initial migration.\nMigration tool should capture added content in subsequent delta runs.\n\nTable: orders\nRows: 200\nStatus: baseline'],
      ['delta_doc_3.txt', 'Delta Migration — Document 3\nType: Delta\nState: Pre-Migration (Initial)\n\nThird delta file — tests modification of existing lines.\nMigration tool detects file modification date to identify delta items.'],
      ['delta_spreadsheet.csv', 'ID,Status,Amount,Date\n1,pending,100.00,2024-01-01\n2,complete,250.50,2024-01-02\n3,pending,75.00,2024-01-03'],
    ];

    for (const [name, content] of deltaFiles) {
      try {
        const up = await box.uploadFile(name, txt(content), f.id, token, uid);
        this.report.delta.files.push({ name, id: up.id });
        logger.info(`[BoxAuto]   Uploaded delta: ${name}`);
      } catch (e) { this._err('delta', name, e); }
    }

    // SubFolder delta files
    for (const [name, content] of [
      ['delta_nested_doc.txt', 'Delta SubFolder — Nested Document\nThis nested file tests delta migration of sub-folder content.\nExpected: captured in delta run after modification.'],
      ['delta_nested_data.csv', 'Key,OldValue,NewValue\nfield_a,original,updated\nfield_b,v1,v2'],
    ]) {
      try {
        await box.uploadFile(name, txt(content), sub.id, token, uid);
      } catch (e) { this._err('delta.sub', name, e); }
    }
  }

  // ── 03 · Folder Display ───────────────────────────────────────────────────
  async _folderDisplay(rootId, token, uid) {
    logger.info('[BoxAuto] 03 · Folder Display');
    const f = await box.createFolder('03 - Folder Display', rootId, token, uid);
    this.report.folderDisplay = { folderId: f.id };

    // Wide folder: 20 files, flat
    const wide = await box.createFolder('Wide Folder (20 Files)', f.id, token, uid);
    for (let i = 1; i <= 20; i++) {
      try {
        await box.uploadFile(`file_${String(i).padStart(2, '0')}.txt`, txt(`Wide folder file ${i} of 20.\nContent: Row ${i} data for folder-display migration testing.`), wide.id, token, uid);
      } catch (e) { this._err('folderDisplay.wide', `file_${i}`, e); }
    }

    // Deep folder: 5 levels
    const deep = await box.createFolder('Deep Folder (5 Levels)', f.id, token, uid);
    let parentId = deep.id;
    for (let i = 1; i <= 5; i++) {
      try {
        const lf = await box.createFolder(`Level ${i}`, parentId, token, uid);
        await box.uploadFile(`level_${i}_file.txt`, txt(`Deep folder — Level ${i}\nThis file is at nesting depth ${i}.\nMigration should preserve the full folder hierarchy.`), lf.id, token, uid);
        parentId = lf.id;
      } catch (e) { this._err('folderDisplay.deep', `level_${i}`, e); break; }
    }

    // Empty folder
    await box.createFolder('Empty Folder', f.id, token, uid);

    // Mixed content
    const mixed = await box.createFolder('Mixed Content Folder', f.id, token, uid);
    await box.createFolder('Mixed SubFolder A', mixed.id, token, uid);
    await box.createFolder('Mixed SubFolder B', mixed.id, token, uid);
    for (const [n, c] of [['mixed_file_1.txt', 'Mixed content file 1.'], ['mixed_file_2.csv', 'a,b\n1,2'], ['mixed_image.png', PNG]]) {
      try { await box.uploadFile(n, typeof c === 'string' ? txt(c) : c, mixed.id, token, uid); } catch (e) { this._err('folderDisplay.mixed', n, e); }
    }
  }

  // ── 04 · Versions ─────────────────────────────────────────────────────────
  async _versions(rootId, token, uid) {
    logger.info('[BoxAuto] 04 · Versions');
    const f = await box.createFolder('04 - Versions', rootId, token, uid);
    this.report.versions = { folderId: f.id, files: [] };

    for (const name of ['version_doc_1.txt', 'version_doc_2.txt', 'version_doc_3.txt']) {
      try {
        const initial = await box.uploadFile(name, versionContent(name, 1, 7), f.id, token, uid);
        for (let v = 2; v <= 7; v++) {
          await box.uploadVersion(initial.id, name, versionContent(name, v, 7), token, uid);
          logger.info(`[BoxAuto]   ${name} — v${v}`);
        }
        this.report.versions.files.push({ name, id: initial.id, versions: 7 });
      } catch (e) { this._err('versions', name, e); }
    }
  }

  // ── 05 · Selective Versions ───────────────────────────────────────────────
  async _selectiveVersions(rootId, token, uid) {
    logger.info('[BoxAuto] 05 · Selective Versions');
    const f = await box.createFolder('05 - Selective Versions', rootId, token, uid);
    this.report.selectiveVersions = { folderId: f.id, files: [] };

    // v1, v3, v5 = selected; v2, v4 = skipped
    const selectedVersions = new Set([1, 3, 5]);
    for (const name of ['selective_doc_1.txt', 'selective_doc_2.txt', 'selective_doc_3.txt']) {
      try {
        const initial = await box.uploadFile(name, selectiveContent(name, 1, selectedVersions.has(1)), f.id, token, uid);
        for (let v = 2; v <= 5; v++) {
          await box.uploadVersion(initial.id, name, selectiveContent(name, v, selectedVersions.has(v)), token, uid);
          logger.info(`[BoxAuto]   ${name} — v${v} (${selectedVersions.has(v) ? 'selected' : 'skipped'})`);
        }
        this.report.selectiveVersions.files.push({ name, id: initial.id, versions: 5, selectedVersions: [1, 3, 5] });
      } catch (e) { this._err('selectiveVersions', name, e); }
    }
  }

  // ── 06 · Root Folder Permissions ──────────────────────────────────────────
  async _rootFolderPermissions(rootId, token, uid, collaboratorEmail) {
    logger.info('[BoxAuto] 06 · Root Folder Permissions');
    const f = await box.createFolder('06 - Root Folder Permissions', rootId, token, uid);
    this.report.rootFolderPerms = { folderId: f.id };

    const roles = [
      { name: 'Viewer Permission Folder', role: 'viewer' },
      { name: 'Editor Permission Folder', role: 'editor' },
      { name: 'Co-Owner Permission Folder', role: 'co-owner' },
    ];

    for (const { name, role } of roles) {
      try {
        const sub = await box.createFolder(name, f.id, token, uid);
        await box.uploadFile('permission_info.txt', txt(`Folder: ${name}\nPermission Role: ${role}\nScenario: Root folder permission test\nExpected: Migrated with ${role} access preserved.`), sub.id, token, uid);
        await tryCollaborate('folder', sub.id, collaboratorEmail, role, token, true, name);
        logger.info(`[BoxAuto]   Created: ${name}`);
      } catch (e) { this._err('rootFolderPerms', name, e); }
    }
  }

  // ── 07 · Sub Folder Permissions ───────────────────────────────────────────
  async _subFolderPermissions(rootId, token, uid, collaboratorEmail) {
    logger.info('[BoxAuto] 07 · Sub Folder Permissions');
    const f = await box.createFolder('07 - Sub Folder Permissions', rootId, token, uid);
    const parent = await box.createFolder('Parent Folder', f.id, token, uid);
    await box.uploadFile('parent_info.txt', txt('Sub Folder Permissions — Parent Folder\nThis parent folder contains child folders with different permission levels.'), parent.id, token, uid);

    const children = [
      { name: 'Child Viewer Folder', role: 'viewer' },
      { name: 'Child Editor Folder', role: 'editor' },
      { name: 'Child CoOwner Folder', role: 'co-owner' },
    ];
    for (const { name, role } of children) {
      try {
        const child = await box.createFolder(name, parent.id, token, uid);
        await box.uploadFile('subfolder_permission.txt', txt(`Sub-folder: ${name}\nRole: ${role}\nParent: Parent Folder\nScenario: Sub-folder permission inheritance test.`), child.id, token, uid);
        await tryCollaborate('folder', child.id, collaboratorEmail, role, token, true, name);
        logger.info(`[BoxAuto]   Child created: ${name}`);
      } catch (e) { this._err('subFolderPerms', name, e); }
    }
    this.report.subFolderPerms = { folderId: f.id, parentId: parent.id };
  }

  // ── 08 · Root File Permissions ────────────────────────────────────────────
  async _rootFilePermissions(rootId, token, uid, collaboratorEmail) {
    logger.info('[BoxAuto] 08 · Root File Permissions');
    const f = await box.createFolder('08 - Root File Permissions', rootId, token, uid);
    this.report.rootFilePerms = { folderId: f.id, files: [] };

    const files = [
      { name: 'root_file_viewer.txt', role: 'viewer' },
      { name: 'root_file_editor.txt', role: 'editor' },
      { name: 'root_file_coowner.txt', role: 'co-owner' },
    ];
    for (const { name, role } of files) {
      try {
        const up = await box.uploadFile(name, txt(`Root File Permission Test\nFile: ${name}\nRole: ${role}\nScenario: Root-level file with ${role} permission.\nExpected: Permission preserved after migration.`), f.id, token, uid);
        await tryCollaborate('file', up.id, collaboratorEmail, role, token, true, name);
        this.report.rootFilePerms.files.push({ name, id: up.id, role });
        logger.info(`[BoxAuto]   Uploaded: ${name}`);
      } catch (e) { this._err('rootFilePerms', name, e); }
    }
  }

  // ── 09 · Inner File Permissions ───────────────────────────────────────────
  async _innerFilePermissions(rootId, token, uid, collaboratorEmail) {
    logger.info('[BoxAuto] 09 · Inner File Permissions');
    const f = await box.createFolder('09 - Inner File Permissions', rootId, token, uid);
    const container = await box.createFolder('Permission Container Folder', f.id, token, uid);
    this.report.innerFilePerms = { folderId: f.id, files: [] };

    const files = [
      { name: 'inner_file_viewer.txt', role: 'viewer' },
      { name: 'inner_file_editor.txt', role: 'editor' },
      { name: 'inner_file_coowner.txt', role: 'co-owner' },
    ];
    for (const { name, role } of files) {
      try {
        const up = await box.uploadFile(name, txt(`Inner File Permission Test\nFile: ${name}\nRole: ${role}\nLocation: inside sub-folder\nScenario: File inside a folder with ${role} permission.`), container.id, token, uid);
        await tryCollaborate('file', up.id, collaboratorEmail, role, token, true, name);
        this.report.innerFilePerms.files.push({ name, id: up.id, role });
        logger.info(`[BoxAuto]   Uploaded: ${name}`);
      } catch (e) { this._err('innerFilePerms', name, e); }
    }
  }

  // ── 10 · External Shares ──────────────────────────────────────────────────
  async _externalShares(rootId, token, uid) {
    logger.info('[BoxAuto] 10 · External Shares');
    const f = await box.createFolder('10 - External Shares', rootId, token, uid);
    const extFolder = await box.createFolder('External Shared Folder', f.id, token, uid);
    this.report.externalShares = { folderId: f.id, links: [] };

    const items = [
      { type: 'folder', id: extFolder.id, label: 'External Shared Folder' },
    ];

    for (const [name, content] of [
      ['external_shared_doc.txt', 'External Share Test — Document\nThis file is shared externally via an open shared link.\nAnyone with the link can access this file.\nScenario: External sharing migration test.'],
      ['external_shared_data.csv', 'Category,Value,Public\nRevenue,50000,yes\nExpenses,30000,yes'],
      ['external_shared_report.pdf', PDF],
    ]) {
      try {
        const up = await box.uploadFile(name, typeof content === 'string' ? txt(content) : content, f.id, token, uid);
        items.push({ type: 'file', id: up.id, label: name });
        logger.info(`[BoxAuto]   Uploaded: ${name}`);
      } catch (e) { this._err('externalShares', name, e); }
    }

    for (const item of items) {
      const url = await trySharedLink(item.type, item.id, token, item.label);
      if (url) this.report.externalShares.links.push({ ...item, url });
    }
  }

  // ── 11 · Shared Links ─────────────────────────────────────────────────────
  async _sharedLinks(rootId, token, uid) {
    logger.info('[BoxAuto] 11 · Shared Links');
    const f = await box.createFolder('11 - Shared Links', rootId, token, uid);
    const linkFolder = await box.createFolder('Shared Link Folder', f.id, token, uid);
    this.report.sharedLinks = { folderId: f.id, links: [] };

    const items = [
      { type: 'folder', id: linkFolder.id, label: 'Shared Link Folder' },
    ];

    for (const [name, content] of [
      ['shared_link_doc_1.txt', 'Shared Link Test — Document 1\nThis file has an open shared link.\nScenario: Shared link preservation during Box migration.'],
      ['shared_link_doc_2.txt', 'Shared Link Test — Document 2\nSecond file with shared link for migration validation.'],
      ['shared_link_image.jpg', JPEG],
      ['shared_link_report.pdf', PDF],
    ]) {
      try {
        const up = await box.uploadFile(name, typeof content === 'string' ? txt(content) : content, f.id, token, uid);
        items.push({ type: 'file', id: up.id, label: name });
        logger.info(`[BoxAuto]   Uploaded: ${name}`);
      } catch (e) { this._err('sharedLinks', name, e); }
    }

    for (const item of items) {
      const url = await trySharedLink(item.type, item.id, token, item.label);
      if (url) this.report.sharedLinks.links.push({ ...item, url });
    }
  }

  // ── 12 · Preserve Timestamp ───────────────────────────────────────────────
  async _preserveTimestamp(rootId, token, uid) {
    logger.info('[BoxAuto] 12 · Preserve Timestamp');
    const f = await box.createFolder('12 - Preserve Timestamp', rootId, token, uid);
    this.report.preserveTimestamp = { folderId: f.id, files: [] };

    const timestampFiles = [
      { name: 'timestamp_2019.txt', modifiedAt: '2019-03-20T09:00:00Z', label: 'March 2019' },
      { name: 'timestamp_2020.txt', modifiedAt: '2020-07-04T12:00:00Z', label: 'July 2020' },
      { name: 'timestamp_2021.txt', modifiedAt: '2021-11-11T08:30:00Z', label: 'November 2021' },
      { name: 'timestamp_2022.txt', modifiedAt: '2022-05-15T14:45:00Z', label: 'May 2022' },
      { name: 'timestamp_2023.txt', modifiedAt: '2023-01-01T00:00:00Z', label: 'January 2023' },
    ];

    for (const { name, modifiedAt, label } of timestampFiles) {
      try {
        const content = txt(
          `Preserve Timestamp Test\nFile: ${name}\nOriginal Modified: ${modifiedAt} (${label})\n\n` +
          `Scenario: Migration must preserve the original file timestamp.\n` +
          `Expected: content_modified_at in destination = ${modifiedAt}\n\n` +
          `Test data created for Box → Box migration timestamp validation.`
        );
        const up = await box.uploadFile(name, content, f.id, token, uid, {
          contentModifiedAt: modifiedAt,
          contentCreatedAt: modifiedAt,
        });
        this.report.preserveTimestamp.files.push({ name, id: up.id, modifiedAt });
        logger.info(`[BoxAuto]   Uploaded with timestamp ${modifiedAt}: ${name}`);
      } catch (e) { this._err('preserveTimestamp', name, e); }
    }
  }

  // ── 13 · Inline Comments ──────────────────────────────────────────────────
  async _inlineComments(rootId, token, uid) {
    logger.info('[BoxAuto] 13 · Inline Comments');
    const f = await box.createFolder('13 - Inline Comments', rootId, token, uid);
    this.report.inlineComments = { folderId: f.id, files: [] };

    const commentedFiles = [
      {
        name: 'commented_doc_1.txt',
        content: 'Inline Comment Test — Document 1\nThis file has 3 Box comments.\nComments should be preserved or noted during migration.\n\nSection A: Introduction\nSection B: Details\nSection C: Conclusion',
        comments: [
          'QA Comment 1: This document passed initial review.',
          'QA Comment 2: Section B needs validation after migration.',
          'QA Comment 3: Final sign-off pending migration verification.',
        ],
      },
      {
        name: 'commented_doc_2.txt',
        content: 'Inline Comment Test — Document 2\nThis file has 2 Box comments.\nValidate that in-line comments are handled correctly by the migration tool.\n\nContent: Regular body text for migration testing.',
        comments: [
          'Migration note: verify metadata intact post-migration.',
          'Review note: check file owner after migration.',
        ],
      },
      {
        name: 'commented_doc_3.txt',
        content: 'Inline Comment Test — Document 3\nSingle comment on this document.',
        comments: ['Single QA comment: confirm file appears in destination without modification.'],
      },
    ];

    for (const { name, content, comments } of commentedFiles) {
      try {
        const up = await box.uploadFile(name, txt(content), f.id, token, uid);
        const addedComments = [];
        for (const msg of comments) {
          try {
            const c = await box.addComment(up.id, msg, token, uid);
            addedComments.push(c.id);
            logger.info(`[BoxAuto]   Comment added to ${name}`);
          } catch (ce) { this._err('inlineComments.comment', `${name}:${msg.slice(0, 30)}`, ce); }
        }
        this.report.inlineComments.files.push({ name, id: up.id, comments: addedComments.length });
      } catch (e) { this._err('inlineComments', name, e); }
    }
  }

  // ── 14 · Long Folder Path ─────────────────────────────────────────────────
  async _longFolderPath(rootId, token, uid) {
    logger.info('[BoxAuto] 14 · Long Folder Path (30 levels)');
    const f = await box.createFolder('14 - Long Folder Path', rootId, token, uid);
    this.report.longFolderPath = { folderId: f.id, levels: 0 };

    let parentId = f.id;
    for (let i = 1; i <= 30; i++) {
      try {
        const sub = await box.createFolder(`Long Folder Path ${i}`, parentId, token, uid);
        if (i === 30) {
          await box.uploadFile('deep_file.txt', txt(`Long Folder Path — Deepest Level\nDepth: ${i}\nThis file is at the maximum nesting depth.\nMigration must preserve the full folder hierarchy of 30 levels.`), sub.id, token, uid);
        }
        parentId = sub.id;
        this.report.longFolderPath.levels = i;
        logger.info(`[BoxAuto]   Level ${i}`);
      } catch (e) { this._err('longFolderPath', `level_${i}`, e); break; }
    }
  }

  // ── 15 · Special Characters ───────────────────────────────────────────────
  async _specialCharacters(rootId, token, uid) {
    logger.info('[BoxAuto] 15 · Special Characters');
    const f = await box.createFolder('15 - Special Characters', rootId, token, uid);
    this.report.specialChars = { folderId: f.id };

    const specialFolders = [
      "Special !@#$%^&*() Folder",
      "Folder with Hyphens-and_Underscores",
      "Folder (with Parentheses) [and Brackets]",
      "Folder with Spaces   Multiple",
      "Folder+With+Plus+Signs",
    ];

    for (const name of specialFolders) {
      try {
        const sf = await box.createFolder(name, f.id, token, uid);
        await box.uploadFile('special_info.txt', txt(`Special Characters Folder: ${name}\nScenario: Test folder naming with special characters.\nExpected: Name preserved or correctly replaced after migration.`), sf.id, token, uid);
        logger.info(`[BoxAuto]   Folder created: ${name}`);
      } catch (e) { this._err('specialChars.folder', name, e); }
    }

    const specialFiles = [
      ["Special !@#$%^&*() Document.txt", "File with special characters in name: !@#$%^&*()\nScenario: Special character in file name migration test."],
      ["File with Spaces and (Parentheses).txt", "File name contains spaces and parentheses.\nMigration should handle or replace these correctly."],
      ["Hyphens-Underscores_Mixed.txt", "File name with hyphens and underscores.\nThese are generally safe characters in Box and most platforms."],
      ["File+with+Plus+Signs.txt", "File name uses plus signs as word separators.\nTest how migration tool handles plus signs in names."],
    ];

    for (const [name, content] of specialFiles) {
      try {
        await box.uploadFile(name, txt(content), f.id, token, uid);
        logger.info(`[BoxAuto]   File uploaded: ${name}`);
      } catch (e) { this._err('specialChars.file', name, e); }
    }
  }

  // ── 16 · Embedded Links ───────────────────────────────────────────────────
  async _embeddedLinks(rootId, token, uid) {
    logger.info('[BoxAuto] 16 · Embedded Links');
    const f = await box.createFolder('16 - Embedded Links', rootId, token, uid);
    this.report.embeddedLinks = { folderId: f.id, files: [] };

    const txtContent =
      `Embedded Links Test — Text Document\n` +
      `This document contains various embedded hyperlinks.\n\n` +
      `Box Shared Links:\n` +
      `  https://app.box.com/s/example_shared_link_abc123\n` +
      `  https://app.box.com/file/123456789\n\n` +
      `External URLs:\n` +
      `  https://www.cloudfuze.com/box-to-box-migration/\n` +
      `  https://developer.box.com/reference/\n\n` +
      `Cloud Storage Links:\n` +
      `  https://docs.google.com/document/d/example_doc_id/edit\n` +
      `  https://1drv.ms/w/s!exampleOneDriveLink\n` +
      `  https://company.sharepoint.com/sites/team/Documents/report.docx\n\n` +
      `Reference Link:\n` +
      `  https://support.box.com/hc/en-us/articles/360043696234\n\n` +
      `Scenario: These embedded links must be preserved as plain text during migration.`;

    const htmlContent =
      `<!DOCTYPE html><html><head><title>Embedded Links</title></head><body>` +
      `<h1>Box Migration — Embedded Links Test</h1>` +
      `<p>This HTML file contains anchor links that should be preserved.</p>` +
      `<h2>Box Links</h2>` +
      `<ul>` +
      `<li><a href="https://app.box.com/s/example1">Box Shared File Link</a></li>` +
      `<li><a href="https://app.box.com/folder/123456">Box Folder Link</a></li>` +
      `</ul>` +
      `<h2>External Links</h2>` +
      `<ul>` +
      `<li><a href="https://www.cloudfuze.com">CloudFuze Migration</a></li>` +
      `<li><a href="https://docs.google.com/spreadsheets/d/example_id">Google Sheets</a></li>` +
      `<li><a href="https://company.sharepoint.com/sites/project">SharePoint Site</a></li>` +
      `</ul>` +
      `<h2>Inline Image with Link</h2>` +
      `<a href="https://app.box.com"><img src="https://app.box.com/favicon.ico" alt="Box Logo" /></a>` +
      `</body></html>`;

    const csvContent =
      `Title,URL,Type\n` +
      `Box Shared File,https://app.box.com/s/abc123,box-shared\n` +
      `Box Folder,https://app.box.com/folder/456,box-folder\n` +
      `Google Doc,https://docs.google.com/d/xyz,google\n` +
      `SharePoint,https://company.sharepoint.com/doc,sharepoint\n` +
      `CloudFuze,https://www.cloudfuze.com,external`;

    for (const [name, content] of [
      ['embedded_links_doc.txt', txt(txtContent)],
      ['embedded_links_page.html', txt(htmlContent)],
      ['embedded_links_list.csv', txt(csvContent)],
    ]) {
      try {
        const up = await box.uploadFile(name, content, f.id, token, uid);
        this.report.embeddedLinks.files.push({ name, id: up.id });
        logger.info(`[BoxAuto]   Uploaded: ${name}`);
      } catch (e) { this._err('embeddedLinks', name, e); }
    }
  }

  // ── 17 · Suppress Email Notifications ────────────────────────────────────
  async _suppressEmailNotifications(rootId, token, uid, collaboratorEmail) {
    logger.info('[BoxAuto] 17 · Suppress Email Notifications');
    const f = await box.createFolder('17 - Suppress Email Notifications', rootId, token, uid);
    this.report.suppressEmail = { folderId: f.id, collaborations: [] };

    // Explanation file
    await box.uploadFile('suppress_email_info.txt', txt(
      `Suppress Email Notifications — Scenario\n\n` +
      `When Box migrations add collaborators to folders/files, Box sends invitation emails.\n` +
      `The notify=false parameter suppresses these emails.\n\n` +
      `This folder and its sub-folders test collaborations created with notify=false.\n` +
      `Expected: Collaborator added successfully, no email sent to collaboratee.\n\n` +
      `Collaborator used: ${collaboratorEmail || '(none configured — set collaboratorEmail in request body)'}`
    ), f.id, token, uid);

    const suppressFolders = [
      { name: 'Suppress Notify Viewer Folder', role: 'viewer' },
      { name: 'Suppress Notify Editor Folder', role: 'editor' },
    ];

    for (const { name, role } of suppressFolders) {
      try {
        const sf = await box.createFolder(name, f.id, token, uid);
        await box.uploadFile('collaboration_note.txt', txt(`Folder: ${name}\nCollaboration Role: ${role}\nEmail Suppressed: YES (notify=false)\nScenario: Verify collaboration added without sending invite email.`), sf.id, token, uid);
        const collab = await tryCollaborate('folder', sf.id, collaboratorEmail, role, token, true, name);
        if (collab) this.report.suppressEmail.collaborations.push({ folder: name, role, collaboratorEmail, status: 'added' });
        logger.info(`[BoxAuto]   Suppress notify folder: ${name}`);
      } catch (e) { this._err('suppressEmail', name, e); }
    }

    // One file-level collaboration with suppress notify
    try {
      const up = await box.uploadFile('suppress_notify_file.txt', txt(`File-Level Suppress Notify\nCollaboration on this file was added with notify=false.\nScenario: File-level suppress email notification test.`), f.id, token, uid);
      await tryCollaborate('file', up.id, collaboratorEmail, 'viewer', token, true, 'suppress_notify_file.txt');
    } catch (e) { this._err('suppressEmail.file', 'suppress_notify_file.txt', e); }
  }

  // ── 18 · Group Permissions ────────────────────────────────────────────────
  async _groupPermissions(rootId, token, uid) {
    logger.info('[BoxAuto] 18 · Group Permissions');
    const f = await box.createFolder('18 - Group Permissions', rootId, token, uid);
    this.report.groupPermissions = { folderId: f.id, groups: [] };

    const groups = [
      { name: 'QA Viewer Group', role: 'viewer' },
      { name: 'QA Editor Group', role: 'editor' },
      { name: 'QA Co-Owner Group', role: 'co-owner' },
    ];

    for (const { name, role } of groups) {
      try {
        const gf = await box.createFolder(`${name} Folder`, f.id, token, uid);
        await box.uploadFile('group_info.txt', txt(
          `Group Permission Test\nGroup: ${name}\nRole: ${role}\n\n` +
          `Scenario: Folder shared with a group. All group members have ${role} access.\n` +
          `Expected: Group collaboration migrated to destination with same permission level.`
        ), gf.id, token, uid);

        try {
          const group = await box.createGroup(name, token, uid);
          await box.createGroupCollaboration('folder', gf.id, group.id, role, token, true, uid);
          logger.info(`[BoxAuto]   Group "${name}" created and collaborated (${role})`);
          this.report.groupPermissions.groups.push({ name, role, groupId: group.id, status: 'created' });
        } catch (ge) {
          logger.warn(`[BoxAuto]   Group creation skipped (enterprise admin required): ${ge.response?.data?.message || ge.message}`);
          await box.uploadFile('group_setup_note.txt', txt(
            `Group Setup Note\nGroup: ${name}\nRole: ${role}\n\n` +
            `Note: Group creation via API requires enterprise admin privileges.\n` +
            `Configure manually in Box Admin Console: share this folder with a group named "${name}" at ${role} access.`
          ), gf.id, token, uid);
          this.report.groupPermissions.groups.push({ name, role, status: 'skipped-needs-enterprise-admin' });
        }
      } catch (e) { this._err('groupPermissions', name, e); }
    }
  }

  // ── 19 · Long File/Folder Name ────────────────────────────────────────────
  async _longFileFolderName(rootId, token, uid) {
    logger.info('[BoxAuto] 19 · Long File/Folder Name');
    const f = await box.createFolder('19 - Long File Folder Name', rootId, token, uid);
    this.report.longFileFolderName = { folderId: f.id, folders: [], files: [] };

    // Microsoft path limit: 400 chars for full path. Box folder name limit: 255 chars.
    const folderLengths = [100, 150, 200, 255];
    for (const len of folderLengths) {
      const name = ('LongFolder_' + 'A'.repeat(255)).substring(0, len);
      try {
        const sf = await box.createFolder(name, f.id, token, uid);
        await box.uploadFile('long_name_info.txt', txt(
          `Long Folder Name Test\nName length: ${name.length} chars\n\n` +
          `Microsoft imposes a 400-character limit for file/folder names including the entire path.\n` +
          `CloudFuze handles long names and creates a CSV listing all long-named content.\n` +
          `Expected: Folder migrated (possibly renamed) and listed in CloudFuze CSV report.`
        ), sf.id, token, uid);
        this.report.longFileFolderName.folders.push({ length: name.length, id: sf.id });
        logger.info(`[BoxAuto]   Long folder (${name.length} chars) created`);
      } catch (e) { this._err('longFileFolderName.folder', `${len}chars`, e); }
    }

    const fileLengths = [100, 150, 200, 248];
    for (const len of fileLengths) {
      const name = ('LongFile_' + 'B'.repeat(255 - 4)).substring(0, len - 4) + '.txt';
      try {
        await box.uploadFile(name, txt(
          `Long File Name Test\nFile name length: ${name.length} chars\n\n` +
          `Scenario: File name approaching Box 255-char limit, mapping to Microsoft 400-char path limit.\n` +
          `Expected: File migrated (possibly renamed) with reference in CloudFuze CSV report.`
        ), f.id, token, uid);
        this.report.longFileFolderName.files.push({ length: name.length });
        logger.info(`[BoxAuto]   Long filename (${name.length} chars) uploaded`);
      } catch (e) { this._err('longFileFolderName.file', `${len}chars`, e); }
    }
  }

  // ── 20 · Box Notes Migration ──────────────────────────────────────────────
  async _boxNotes(rootId, token, uid, collaboratorEmail) {
    logger.info('[BoxAuto] 20 · Box Notes Migration');
    const f = await box.createFolder('20 - Box Notes Migration', rootId, token, uid);
    this.report.boxNotes = { folderId: f.id, files: [] };

    // 20a — Bullets and Checkboxes (in scope: converted to numbered list at destination)
    try {
      const file = await box.uploadFile('boxnote_bullets_checkboxes.boxnote', bn([
        bnP('Box Note: Bullets and Checkboxes', [{ type: 'strong' }]),
        bnP('Expected: Bullet points and checklist items are migrated as numbered lists in the destination.'),
        bnBullet(['Bullet item one — project kickoff', 'Bullet item two — requirements gathering', 'Bullet item three — design phase']),
        bnCheck([{ text: 'Completed task: Initial setup', checked: true }, { text: 'Pending task: Final review', checked: false }, { text: 'Completed task: Data backup', checked: true }]),
      ]), f.id, token, uid);
      this.report.boxNotes.files.push({ name: 'boxnote_bullets_checkboxes.boxnote', id: file.id, scenario: 'bullets-checkboxes' });
      logger.info('[BoxAuto]   BoxNote: bullets_checkboxes');
    } catch (e) { this._err('boxNotes', 'boxnote_bullets_checkboxes.boxnote', e); }

    // 20b — Strikethrough (in scope: migrates as plain text)
    try {
      const file = await box.uploadFile('boxnote_strikethrough.boxnote', bn([
        bnP('Box Note: Strikethrough Text', [{ type: 'strong' }]),
        bnP('Expected: Strikethrough text migrates as plain text — formatting is not preserved.'),
        { nodeType: 'paragraph', content: [
          { nodeType: 'text', text: 'Normal text, then ', marks: [] },
          { nodeType: 'text', text: 'this is strikethrough that becomes plain', marks: [{ type: 'strike' }] },
          { nodeType: 'text', text: ', back to normal.', marks: [] },
        ]},
        { nodeType: 'paragraph', content: [
          { nodeType: 'text', text: 'Deleted content: ', marks: [] },
          { nodeType: 'text', text: 'REMOVED SECTION — do not include in final doc', marks: [{ type: 'strike' }] },
        ]},
      ]), f.id, token, uid);
      this.report.boxNotes.files.push({ name: 'boxnote_strikethrough.boxnote', id: file.id, scenario: 'strikethrough' });
      logger.info('[BoxAuto]   BoxNote: strikethrough');
    } catch (e) { this._err('boxNotes', 'boxnote_strikethrough.boxnote', e); }

    // 20c — Inline Code (in scope: migrates as regular text)
    try {
      const file = await box.uploadFile('boxnote_inline_code.boxnote', bn([
        bnP('Box Note: Inline Code', [{ type: 'strong' }]),
        bnP('Expected: Inline code formatting migrates as regular text — no code styling preserved.'),
        { nodeType: 'paragraph', content: [
          { nodeType: 'text', text: 'Run ', marks: [] },
          { nodeType: 'text', text: 'npm install', marks: [{ type: 'code' }] },
          { nodeType: 'text', text: ' to install dependencies.', marks: [] },
        ]},
        { nodeType: 'paragraph', content: [
          { nodeType: 'text', text: 'The function ', marks: [] },
          { nodeType: 'text', text: 'getUserById(id)', marks: [{ type: 'code' }] },
          { nodeType: 'text', text: ' returns a user object.', marks: [] },
        ]},
      ]), f.id, token, uid);
      this.report.boxNotes.files.push({ name: 'boxnote_inline_code.boxnote', id: file.id, scenario: 'inline-code' });
      logger.info('[BoxAuto]   BoxNote: inline_code');
    } catch (e) { this._err('boxNotes', 'boxnote_inline_code.boxnote', e); }

    // 20d — Box Note Comments (in scope: migrated to CSV at destination)
    try {
      const file = await box.uploadFile('boxnote_with_comments.boxnote', bn([
        bnP('Box Note: Comments Test', [{ type: 'strong' }]),
        bnP('This Box Note has 3 comments. Comments are not embedded in the file — they are migrated separately and provided in CSV format at the destination.'),
        bnP('Content: Product Requirements Overview — Version 1.0, initial draft for review.'),
      ]), f.id, token, uid);
      for (const msg of [
        'Review comment: Please verify section 2 after migration.',
        'Migration note: This comment should appear in the destination CSV output file.',
        'QA note: Validate all 3 comments are captured in the migration output.',
      ]) {
        try { await box.addComment(file.id, msg, token, uid); } catch (ce) { this._err('boxNotes.comment', msg.slice(0, 30), ce); }
      }
      this.report.boxNotes.files.push({ name: 'boxnote_with_comments.boxnote', id: file.id, scenario: 'comments', commentsAdded: 3 });
      logger.info('[BoxAuto]   BoxNote: with_comments (3 comments added)');
    } catch (e) { this._err('boxNotes', 'boxnote_with_comments.boxnote', e); }

    // 20e — Media via Shared Link (in scope: stays intact)
    try {
      const file = await box.uploadFile('boxnote_media_shared_link.boxnote', bn([
        bnP('Box Note: Media & Images (Shared Link)', [{ type: 'strong' }]),
        bnP('Images inserted via "Insert Image from Shared Link" migrate successfully and remain intact.'),
        { nodeType: 'paragraph', content: [
          { nodeType: 'text', text: 'Embedded image: ', marks: [] },
          { nodeType: 'text', text: 'https://app.box.com/s/sample_shared_image_qa_test', marks: [{ type: 'link', attrs: { href: 'https://app.box.com/s/sample_shared_image_qa_test' } }] },
        ]},
        bnP('Note: Files uploaded via media upload option (not shared link) will NOT migrate — out of scope.', [{ type: 'em' }]),
      ]), f.id, token, uid);
      this.report.boxNotes.files.push({ name: 'boxnote_media_shared_link.boxnote', id: file.id, scenario: 'media-shared-link' });
      logger.info('[BoxAuto]   BoxNote: media_shared_link');
    } catch (e) { this._err('boxNotes', 'boxnote_media_shared_link.boxnote', e); }

    // 20f — Embedded Links (in scope: remain clickable in destination)
    try {
      const file = await box.uploadFile('boxnote_embedded_links.boxnote', bn([
        bnP('Box Note: Embedded Links', [{ type: 'strong' }]),
        bnP('Embedded hyperlinks migrate successfully and remain clickable in the destination.'),
        { nodeType: 'paragraph', content: [
          { nodeType: 'text', text: 'CloudFuze: ', marks: [] },
          { nodeType: 'text', text: 'https://www.cloudfuze.com', marks: [{ type: 'link', attrs: { href: 'https://www.cloudfuze.com' } }] },
        ]},
        { nodeType: 'paragraph', content: [
          { nodeType: 'text', text: 'Box file: ', marks: [] },
          { nodeType: 'text', text: 'https://app.box.com/file/123456789', marks: [{ type: 'link', attrs: { href: 'https://app.box.com/file/123456789' } }] },
        ]},
        { nodeType: 'paragraph', content: [
          { nodeType: 'text', text: 'SharePoint: ', marks: [] },
          { nodeType: 'text', text: 'https://company.sharepoint.com/sites/migration', marks: [{ type: 'link', attrs: { href: 'https://company.sharepoint.com/sites/migration' } }] },
        ]},
      ]), f.id, token, uid);
      this.report.boxNotes.files.push({ name: 'boxnote_embedded_links.boxnote', id: file.id, scenario: 'embedded-links' });
      logger.info('[BoxAuto]   BoxNote: embedded_links');
    } catch (e) { this._err('boxNotes', 'boxnote_embedded_links.boxnote', e); }

    // 20g — Box Notes Versions (in scope: all versions stored at destination)
    try {
      const file = await box.uploadFile('boxnote_versions.boxnote', bn([
        bnP('Box Note Versions — Version 1', [{ type: 'strong' }]),
        bnP('Original content. This Box Note will have multiple versions.'),
      ]), f.id, token, uid);
      const vChanges = ['Updated title section', 'Added requirements list', 'Final review and sign-off'];
      for (let v = 2; v <= 4; v++) {
        try {
          await box.uploadVersion(file.id, 'boxnote_versions.boxnote', bn([
            bnP(`Box Note Versions — Version ${v}`, [{ type: 'strong' }]),
            bnP(`Version ${v} of 4. All versions should be stored at the destination.`),
            bnP(`Change in v${v}: ${vChanges[v - 2]}`),
          ]), token, uid);
          logger.info(`[BoxAuto]   BoxNote versions: v${v}`);
        } catch (ve) { this._err('boxNotes.versions', `v${v}`, ve); }
      }
      this.report.boxNotes.files.push({ name: 'boxnote_versions.boxnote', id: file.id, scenario: 'versions', versionCount: 4 });
    } catch (e) { this._err('boxNotes', 'boxnote_versions.boxnote', e); }

    // 20h — Box Notes with Permissions (in scope: permissions appear at destination)
    const permsFolder = await box.createFolder('Box Notes with Permissions', f.id, token, uid);
    for (const role of ['viewer', 'editor', 'co-owner']) {
      try {
        const file = await box.uploadFile(`boxnote_permission_${role}.boxnote`, bn([
          bnP(`Box Note: Permissions Test (${role})`, [{ type: 'strong' }]),
          bnP(`This Box Note has ${role} permission. Expected: Box Notes permissions are migrated and appear at the destination.`),
        ]), permsFolder.id, token, uid);
        await tryCollaborate('file', file.id, collaboratorEmail, role, token, true, `boxnote_permission_${role}`);
        this.report.boxNotes.files.push({ name: `boxnote_permission_${role}.boxnote`, id: file.id, scenario: `permissions-${role}` });
        logger.info(`[BoxAuto]   BoxNote permission: ${role}`);
      } catch (e) { this._err('boxNotes.permissions', role, e); }
    }

    // Out-of-scope documentation folder
    const oosFolder = await box.createFolder('Box Notes - Out of Scope (Documentation)', f.id, token, uid);
    const oosDocs = [
      ['oos_tags.boxnote', bn([
        bnP('OUT OF SCOPE: Box Notes Tags', [{ type: 'strong' }]),
        bnP('Tags associated with Box Notes will NOT migrate to the destination. Tags on this note: migration-qa, test-data, 2024-review.'),
      ])],
      ['oos_table.boxnote', bn([
        bnP('OUT OF SCOPE: Box Notes Tables', [{ type: 'strong' }]),
        bnP('Table content is NOT migrated as expected — structure, alignment, and formatting are broken in the destination.'),
        { nodeType: 'table', content: [
          { nodeType: 'table_row', content: [
            { nodeType: 'table_cell', content: [bnP('Feature')] },
            { nodeType: 'table_cell', content: [bnP('Status')] },
          ]},
          { nodeType: 'table_row', content: [
            { nodeType: 'table_cell', content: [bnP('Migration')] },
            { nodeType: 'table_cell', content: [bnP('Complete')] },
          ]},
        ]},
      ])],
      ['oos_font_color.boxnote', bn([
        bnP('OUT OF SCOPE: Font Size and Text Color', [{ type: 'strong' }]),
        bnP('Font size variations and text colors are NOT fully preserved. All text appears in uniform size and default color in the destination.'),
        { nodeType: 'paragraph', content: [
          { nodeType: 'text', text: 'Large heading text, ', marks: [] },
          { nodeType: 'text', text: 'colored red text, ', marks: [{ type: 'strong' }] },
          { nodeType: 'text', text: 'all become uniform default-size black text in destination.', marks: [] },
        ]},
      ])],
      ['oos_mention_annotation.boxnote', bn([
        bnP('OUT OF SCOPE: Box Note Annotations / Mentions', [{ type: 'strong' }]),
        bnP('@mention tags are migrated as normal plain text, not as actual mention tags. Annotations are also converted to plain text.'),
        bnP('@john.doe please review this section by Friday — this becomes plain text at destination.'),
      ])],
    ];

    for (const [name, content] of oosDocs) {
      try {
        const file = await box.uploadFile(name, content, oosFolder.id, token, uid);
        this.report.boxNotes.files.push({ name, id: file.id, scenario: 'out-of-scope-documentation' });
        logger.info(`[BoxAuto]   BoxNote OOS doc: ${name}`);
      } catch (e) { this._err('boxNotes.outOfScope', name, e); }
    }
  }

  // ── Post-scenarios: viewer/editor permissions + public shared links on main content ──
  async _addPermissionsToMainContent(rootId, token, uid, collaboratorEmail) {
    logger.info('[BoxAuto] Adding shared links and permissions to main content areas');

    // Public shared link on AUTOMATION BOX root
    await trySharedLink('folder', rootId, token, 'AUTOMATION BOX root');

    // 01 One Time: shared links on first 2 files; viewer on file[0], editor on file[1] if collaborator provided
    const otFiles = (this.report.oneTime?.files || []).filter((f) => !f.subfolder);
    if (otFiles[0]) {
      await trySharedLink('file', otFiles[0].id, token, `oneTime:${otFiles[0].name}`);
      await tryCollaborate('file', otFiles[0].id, collaboratorEmail, 'viewer', token, true, `oneTime viewer`);
    }
    if (otFiles[1]) {
      await trySharedLink('file', otFiles[1].id, token, `oneTime:${otFiles[1].name}`);
      await tryCollaborate('file', otFiles[1].id, collaboratorEmail, 'editor', token, true, `oneTime editor`);
    }
    if (this.report.oneTime?.folderId) {
      await trySharedLink('folder', this.report.oneTime.folderId, token, '01 One Time folder');
      await tryCollaborate('folder', this.report.oneTime.folderId, collaboratorEmail, 'viewer', token, true, '01 One Time folder viewer');
    }

    // 02 Delta: shared links on first 2 files; viewer on file[0], editor on folder
    const dtFiles = this.report.delta?.files || [];
    if (dtFiles[0]) {
      await trySharedLink('file', dtFiles[0].id, token, `delta:${dtFiles[0].name}`);
      await tryCollaborate('file', dtFiles[0].id, collaboratorEmail, 'viewer', token, true, `delta viewer`);
    }
    if (dtFiles[1]) {
      await trySharedLink('file', dtFiles[1].id, token, `delta:${dtFiles[1].name}`);
    }
    if (this.report.delta?.folderId) {
      await trySharedLink('folder', this.report.delta.folderId, token, '02 Delta folder');
      await tryCollaborate('folder', this.report.delta.folderId, collaboratorEmail, 'editor', token, true, '02 Delta folder editor');
    }

    // 04 Versions: shared link on first version file; viewer permission
    const vFiles = this.report.versions?.files || [];
    if (vFiles[0]) {
      await trySharedLink('file', vFiles[0].id, token, `versions:${vFiles[0].name}`);
      await tryCollaborate('file', vFiles[0].id, collaboratorEmail, 'viewer', token, true, `versions viewer`);
    }
    if (this.report.versions?.folderId) {
      await trySharedLink('folder', this.report.versions.folderId, token, '04 Versions folder');
    }

    logger.info('[BoxAuto] Shared links and permissions applied to main content areas');
  }

  // ── Error tracker ─────────────────────────────────────────────────────────
  _err(scenario, item, err) {
    const msg = err.response?.data?.message || err.message;
    logger.warn(`[BoxAuto] Warning — ${scenario} / ${item}: ${msg}`);
    this.errors.push({ scenario, item, error: msg });
  }
}

module.exports = BoxAutomationDataAgent;
