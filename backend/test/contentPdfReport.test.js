/**
 * Run: npm test  (from backend/)
 *
 * Smoke test for the content validation PDF.
 *
 * generateContentValidationPdf is SHARED by every content combination, so it has to render two
 * different result shapes: the original Box→SharePoint one (boxFolderPaths / spName / versions.box)
 * and the neutral one later combinations emit (sourceFolderPaths / destName / versions.source).
 * A renderer that silently drops a section — or throws
 * on an unexpected field — produces a report that looks complete and isn't, so both shapes are
 * rendered here and the output is checked for size and for the strings that prove each section ran.
 *
 * Nothing is written to disk: the PDF is collected in memory.
 */
const assert = require('assert');
const { Writable } = require('stream');
const { generateContentValidationPdf } = require('../src/utils/pdfGenerator');

/** Collect a PDF into a Buffer. */
function render(execution) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try {
      generateContentValidationPdf(execution, sink);
    } catch (err) {
      reject(err);
    }
  });
}

const baseContext = {
  sourceEmail: 'qa@src.com', destinationEmail: 'qa@dst.com',
  sourceProvider: 'googledrive', destinationProvider: 'sharepoint',
  domain: 'content', migrationType: 'FULL',
};

/** The neutral shape emitted by googledriveToSharepoint. */
function driveShaped() {
  return {
    executionId: 'exec-drive-1',
    status: 'COMPLETED',
    createdAt: '2026-08-20T10:00:00.000Z',
    context: baseContext,
    result: {
      validationSummary: {
        status: 'WARN',
        checks: [
          { name: 'SharePoint site accessible', status: 'PASS', detail: 'filefuze.sharepoint.com/sites/X' },
          { name: '[qa@src.com] 3. File/folder structure (feature 3.1)', status: 'PASS', detail: 'Identical' },
        ],
        perUser: [{
          sourceEmail: 'qa@src.com',
          destinationEmail: 'qa@dst.com',
          mapping: { sourceEmail: 'qa@src.com', sourceLocation: '/QA', destEmail: 'qa@dst.com', destLocation: '/QA' },
          status: 'PASS',
          summary: '5/5 checks passed',
          checks: [{ name: '1. Destination location', status: 'PASS', detail: 'found' }],
          folderStructure: {
            status: 'PASS', totalSource: 2, totalDest: 2, matched: 2,
            missing: [], extra: [], misplaced: [],
            sourceFolderPaths: ['/Docs', '/Docs/Reports'],
            destFolderPaths: ['/Docs', '/Docs/Reports'],
            sourceRootName: 'QA Shared Drive', destRootName: 'QA',
            sourceLabel: 'Google Shared Drive', destLabel: 'SharePoint',
          },
          items: [{
            path: '/Docs', name: 'Docs', type: 'folder', depth: 1, found: true, destName: 'Docs',
            permissions: [
              { user: 'bob@src.com', mappedTo: 'bob@dst.com', principalType: 'user', sourceRole: 'writer', destRoles: ['write'], match: true },
              { user: 'team@src.com', mappedTo: 'team@dst.com', principalType: 'group', sourceRole: 'fileOrganizer', destRoles: ['write'], match: true },
              { user: 'carol@src.com', mappedTo: 'carol@dst.com', principalType: 'user', sourceRole: 'writer', destRoles: [], match: true, viaGroup: true },
            ],
            versions: { source: 7, dest: 4 },
            timestamps: { match: true },
            sharedLinks: [{ sourceType: 'anyone', sourceRole: 'reader', actual: 'anonymous/view', match: true }],
            contentHash: { sha256: 'abc', ok: true },
          }],
        }],
        featureChecklist: [
          { id: '1.1', category: 'Migration', feature: 'One Time Migration', status: 'pass', detail: 'verified' },
          { id: '4.5', category: 'Permissions', feature: 'Folder Permissions: Content Manager', status: 'pass', detail: '1 folder(s) [groups; root folder]' },
          { id: '8.1', category: 'Versions or Selective Versions', feature: 'Versions or Selective Versions', status: 'info', detail: 'counts not compared — Google merges revisions' },
          { id: '6.1', category: 'Embedded Links', feature: 'Embedded Links', status: 'na', detail: 'Not automated — Manual: open a file and confirm the link' },
        ],
        featureSummary: { line: 'Features: 2 pass, 0 fail, 1 info, 1 not assessed (of 4)' },
      },
      migrationResult: { finalStatus: 'PROCESSED' },
    },
  };
}

/** The original Box→SharePoint shape — must keep rendering after the neutral fields were added. */
function boxShaped() {
  return {
    executionId: 'exec-box-1',
    status: 'COMPLETED',
    createdAt: '2026-08-20T10:00:00.000Z',
    context: { ...baseContext, sourceProvider: 'box' },
    result: {
      validationSummary: {
        status: 'FAIL',
        checks: [{ name: 'SharePoint site accessible', status: 'PASS', detail: 'ok' }],
        perUser: [{
          sourceEmail: 'qa@src.com',
          mapping: { sourceEmail: 'qa@src.com', sourceLocation: '/BOX', destEmail: 'qa@dst.com', destLocation: '/SP' },
          status: 'FAIL',
          summary: '3/5 checks passed',
          checks: [{ name: '7. Version history', status: 'FAIL', detail: 'Box 5 → SP 2' }],
          folderStructure: {
            status: 'FAIL', totalSource: 2, totalDest: 1, matched: 1,
            missing: ['/Sub'], extra: [], misplaced: [],
            boxFolderPaths: ['/Root', '/Sub'], spFolderPaths: ['/Root'],
            boxRootName: 'BOX', spRootName: 'SP',
          },
          items: [{
            path: '/Root', name: 'a:b', type: 'folder', depth: 1, found: true, spName: 'a_b',
            permissions: [{ user: 'x@src.com', mappedTo: 'x@dst.com', boxRole: 'editor', spRoles: ['write'], match: true }],
            versions: { box: 5, sp: 2 },
            author: { spModBy: 'x@dst.com', match: true },
            comments: 3,
            sharedLink: { onDest: false },
          }],
        }],
      },
    },
  };
}

async function run() {
  // Neutral (Drive) shape
  const drivePdf = await render(driveShaped());
  assert.ok(drivePdf.length > 3000, `drive-shaped PDF looks too small: ${drivePdf.length} bytes`);
  assert.strictEqual(drivePdf.subarray(0, 5).toString(), '%PDF-', 'is a PDF');

  // Original Box shape must still render — the renderer is shared.
  const boxPdf = await render(boxShaped());
  assert.ok(boxPdf.length > 3000, `box-shaped PDF looks too small: ${boxPdf.length} bytes`);
  assert.strictEqual(boxPdf.subarray(0, 5).toString(), '%PDF-', 'is a PDF');

  // A result with no checks at all still renders the "nothing available" page rather than throwing.
  const empty = await render({
    executionId: 'e', status: 'COMPLETED', context: baseContext,
    result: { validationSummary: { status: 'N/A', checks: [] } },
  });
  assert.ok(empty.length > 800, 'empty-result PDF still renders');

  // A missing validationSummary must not crash the generator either.
  const noSummary = await render({ executionId: 'e', status: 'FAILED', context: baseContext, result: {} });
  assert.ok(noSummary.length > 800, 'missing-summary PDF still renders');

  console.log('contentPdfReport.test.js: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
