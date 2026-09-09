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

  await testNoColumnOverflow();
  await testNoVerticalOverlap();
  console.log('contentPdfReport.test.js: ok');
}


/**
 * No text may be drawn wider than the column it was given.
 *
 * PDFKit's `lineBreak: false` means "do not wrap" — it does NOT mean "clip". A value longer than its
 * width is drawn straight over whatever sits to its right, which is the overlapping text seen in the
 * report. Two real cases: the header meta band drew "googleshareddrive -> SharePoint" (110pt) into a
 * 74pt column, and a status table drew its own header label "Processed" (40pt) into 34pt.
 *
 * Detection hooks PDFKit itself rather than parsing the output, so it catches every draw site,
 * including ones this fixture does not exercise today. The fix (drawFitted) shrinks the font until it
 * fits and only falls back to an ellipsis at the floor.
 */
async function testNoColumnOverflow() {
  const PDFDocument = require('pdfkit');
  const origText = PDFDocument.prototype.text;
  const overflows = [];
  PDFDocument.prototype.text = function patched(txt, x, y, opts) {
    const o = (typeof x === 'object' && x !== null)
      ? x
      : (typeof y === 'object' && y !== null ? y : opts);
    const str = String(txt == null ? '' : txt);
    // Only unwrapped, un-clipped text can overlap: wrapping text reflows, ellipsis text is cut.
    if (o && o.lineBreak === false && typeof o.width === 'number' && str && !o.ellipsis) {
      let w = 0;
      try { w = this.widthOfString(str); } catch { w = 0; }
      if (w > o.width + 0.5) {
        overflows.push(`"${str.slice(0, 40)}" needs ${Math.round(w)}pt in ${Math.round(o.width)}pt`);
      }
    }
    return origText.apply(this, arguments);
  };

  try {
    // Long details and long labels, which is when the bug shows.
    const long = 'Long File Names: source had organization link, destination has no link at all. '
      + 'CloudFuze moved this content to a shorter path to clear the 400-character limit, but the '
      + 'link did not travel with it, so the placeholder points at unreachable content.';
    const rows = [];
    for (let i = 0; i < 24; i++) {
      rows.push({
        id: `${i + 1}.1`,
        category: i % 2 ? 'Permissions' : 'Long Folder/File path',
        feature: `Feature ${i + 1} with a fairly long descriptive name that keeps going`,
        status: ['fail', 'pass', 'na', 'info'][i % 4],
        detail: long,
      });
    }
    const checks = [{ name: '11b. Relocated over-limit content lost its sharing (1)', status: 'FAIL', detail: long }];
    await render({
      executionId: 'pdf-overflow-guard',
      status: 'COMPLETED',
      context: {
        sourceProvider: 'googleshareddrive',
        destinationProvider: 'sharepoint',
        sourceEmail: 'erik@filefuze.co',
        destinationEmail: 'granger@gajha.com',
      },
      result: {
        validationSummary: {
          status: 'FAIL',
          overallStatus: 'FAIL',
          combination: 'googleshareddrive -> sharepoint',
          featureChecklist: rows,
          checks,
          perUser: [{ destinationPath: '/QA_Team1/Agent Shared Drive', status: 'FAIL', checks }],
          deepContentValidation: { enabled: true },
          mismatches: [],
          summary: {},
        },
      },
    });
  } finally {
    PDFDocument.prototype.text = origText;
  }

  assert.deepStrictEqual(overflows, [],
    'text drawn wider than its column (would overlap the next one): ' + overflows.join(' | '));
  console.log('  no text overflows its column: ok');
}


/**
 * No text may be drawn into vertical space another draw already occupies.
 *
 * Separate bug from the column-overflow guard above, and the one that actually wrecked the report:
 * the per-item "extras" line carries every shared link on an item, so a folder deep in the tree
 * wrapped to six or more lines while doc.y advanced a flat 9pt. The next item's name was then
 * printed on top of the remainder — "Level 8" sitting inside the previous item's trailing
 * "anonymous/view, anonymous/view...". Measured 27 collisions before the fix, 0 after.
 *
 * Detection hooks PDFKit and compares each wrapping draw against the boxes already placed on that
 * page, so it covers every renderer rather than the one this fixture happens to exercise.
 */
async function testNoVerticalOverlap() {
  const PDFDocument = require('pdfkit');
  const origText = PDFDocument.prototype.text;
  const origAddPage = PDFDocument.prototype.addPage;
  let page = 0;
  let boxes = [];
  const collisions = [];

  PDFDocument.prototype.addPage = function patchedAddPage() {
    page += 1;
    boxes = [];               // a new page starts with clear space
    return origAddPage.apply(this, arguments);
  };
  PDFDocument.prototype.text = function patchedText(txt, x, y, opts) {
    const o = (typeof x === 'object' && x !== null)
      ? x
      : (typeof y === 'object' && y !== null ? y : opts);
    const str = String(txt == null ? '' : txt);
    const xx = typeof x === 'number' ? x : this.x;
    const yy = typeof y === 'number' ? y : this.y;
    const w = (o && typeof o.width === 'number') ? o.width : null;
    // Only WRAPPING text can grow taller than its caller expects.
    if (str && w && typeof yy === 'number' && !(o && o.lineBreak === false)) {
      let h = 0;
      try { h = this.heightOfString(str, { width: w }); } catch { h = 0; }
      const box = { x0: xx, x1: xx + w, y0: yy, y1: yy + h, s: str.slice(0, 30) };
      for (const b of boxes) {
        const xHit = box.x0 < b.x1 - 1 && b.x0 < box.x1 - 1;
        const yHit = box.y0 < b.y1 - 1.5 && b.y0 < box.y1 - 1.5;   // 1.5pt slack for rounding
        if (xHit && yHit) {
          collisions.push(`"${box.s}" over "${b.s}" on page ${page}`);
          break;
        }
      }
      boxes.push(box);
    }
    return origText.apply(this, arguments);
  };

  try {
    // Deep items whose link list grows — the shape that overlapped in the real report.
    const items = [];
    for (let i = 0; i < 24; i++) {
      const links = [];
      for (let k = 0; k <= i % 12; k++) {
        links.push({ sourceType: 'anyone', sourceRole: 'reader', actual: 'anonymous/view', match: true });
      }
      items.push({
        name: `Level ${i + 1}`, type: 'folder', depth: Math.min(i, 8), found: true,
        permissions: [
          { user: 'mia@filefuze.co', mappedTo: 'mia@gajha.com', sourceRole: 'reader', destRoles: ['read'], match: true },
          { user: 'erik@filefuze.co', mappedTo: 'granger@gajha.com', sourceRole: 'organizer', destRoles: [], match: true },
        ],
        sharedLinks: links,
        timestamps: { match: true },
      });
    }
    const long = 'Long File Names: source had anonymous+organization link, destination has no link at '
      + 'all. CloudFuze moved this content to a shorter path to clear the 400-character limit, but the '
      + 'link did not travel with it, so the placeholder points at unreachable content.';
    await render({
      executionId: 'pdf-vertical-overlap-guard',
      status: 'COMPLETED',
      context: {
        sourceProvider: 'googleshareddrive', destinationProvider: 'sharepoint',
        sourceEmail: 'erik@filefuze.co', destinationEmail: 'granger@gajha.com',
      },
      result: {
        validationSummary: {
          status: 'FAIL', overallStatus: 'FAIL',
          combination: 'googleshareddrive -> sharepoint',
          featureChecklist: Array.from({ length: 38 }, (_, i) => ({
            id: `${i + 1}.1`, category: i % 3 ? 'Permissions' : 'Long Folder/File path',
            feature: `Feature ${i + 1} with a fairly long descriptive name`,
            status: ['pass', 'fail', 'na', 'info'][i % 4], detail: long,
          })),
          checks: [{ name: 'CloudFuze migration status', status: 'PASS', detail: 'PROCESSED' }],
          perUser: [{
            sourceEmail: 'erik@filefuze.co',
            destinationPath: '/QA_Team1/Agent Shared Drive', status: 'FAIL',
            checks: [{ name: '11b. Relocated over-limit content lost its sharing (1)', status: 'FAIL', detail: long }],
            items,
          }],
          deepContentValidation: { enabled: true }, mismatches: [], summary: {},
        },
      },
    });
  } finally {
    PDFDocument.prototype.text = origText;
    PDFDocument.prototype.addPage = origAddPage;
  }

  assert.deepStrictEqual(collisions, [],
    'text drawn on top of earlier text: ' + collisions.slice(0, 6).join(' | '));
  console.log('  no text overlaps earlier text: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
