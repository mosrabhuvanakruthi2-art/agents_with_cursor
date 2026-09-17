/**
 * Run: npm test  (from backend/)
 *
 * Feature 8.1 (Embedded Links) on dropbox → googledrive / googleshareddrive, judged on a REAL
 * .docx instead of an .html.
 *
 * WHY THIS FILE EXISTS. 8.1 was being judged on `document-with-embedded-links.html`, a plain
 * document with two <a href> tags, and it FAILED on every run. That FAIL was invalid and was being
 * reported as a CloudFuze defect. Scope 8.1 limits link rewriting to "supported file types where
 * link rewriting is technically feasible", and a plain-text/HTML URL is not one of them —
 * DriveTestDataAgent._createEmbeddedLinks states the rule for the Drive pair in as many words:
 * "A real .docx with a real hyperlink is used, not a .txt with a URL in it ... failing on it would
 * report a defect against behaviour that was never promised." CloudFuze agrees in its own report:
 * `Erik E-EmbeddedLinks.csv` on the live destination carried 12 rows, every one a Paper document
 * and not one for the .html, so the document being failed on was never processed at all.
 *
 * So `DropboxTestDataAgent._seedEmbeddedLinks` now also writes `embedded_link_doc.docx`, built with
 * the `docx` library, and that document alone produces the 8.1 verdict. The .html stays as a
 * deliberate contrast case, reported at INFO and never judged.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT:
 *
 *   REAL — the .docx buffers below are built by the same `docx` API the seeder uses and read back
 *     through `utils/docxLinks.extractDocxLinks`, the same helper googledriveToSharepoint.js uses.
 *     Nothing about the ZIP or the relationship XML is hand-written or mocked, which is the point:
 *     a fixture invented to match the code cannot catch the code being wrong, and this repo has
 *     shipped that mistake twice (the Paper table-separator matcher and the list-block counter).
 *   REAL — the Dropbox shared-link URL SHAPE, taken from the live destination document, with the
 *     `rlkey` share token redacted. The filename inside the path is what the label reconstruction
 *     reads, and it is exactly as measured.
 *   NOT MEASURED — whether Google converts this .docx to a Google Doc on import to a Shared Drive.
 *     No run has been made since the seeder changed, so BOTH shapes are asserted and the validator
 *     reports which one it actually saw. Nothing here claims one outcome.
 *   NOT MEASURED — the Drive file id a rewritten link would carry. The URL shape is Drive's; the id
 *     is a placeholder, and no assertion depends on it.
 *
 * Feature 4.1's WARN-not-FAIL alignment is asserted in `dropboxCreatedDates.test.js`, where the
 * rest of 4.1 lives, rather than duplicated here.
 *
 * No network is exercised. `driveClient.downloadFile` / `exportNativeFile` are replaced in-process
 * for the two tests that walk `_checkEmbeddedLinks`, and restored afterwards.
 */
const assert = require('assert');
const { Document, Packer, Paragraph, TextRun, ExternalHyperlink } = require('docx');

const { extractDocxLinks } = require('../src/utils/docxLinks');
const driveClient = require('../src/clients/driveClient');
const ValidationAgent = require('../src/validation/combinations/content/dropboxToGoogledrive');

const {
  extractHtmlAnchors,
  classifyEmbeddedAnchors,
  judgeEmbeddedLinks,
  docxAnchorsFromTargets,
  readDocxAnchors,
  parseEmbeddedLinksCsv,
  crossCheckEmbeddedLinksCsv,
  EMBEDDED_DOCX_PATH,
  EMBEDDED_DOC_PATH,
  EMBEDDED_CONTRAST,
  EMBEDDED_VERDICT,
} = ValidationAgent;

// ── Fixtures ────────────────────────────────────────────────────────────────────────

/** The Dropbox shared links the seeder embeds, in the shape measured at the destination. */
const IN_SCOPE_URL =
  'https://www.dropbox.com/scl/fi/h12ag1166xmx8tbny3qwy/link-target-in-scope.txt?rlkey=REDACTED&dl=0';
const OUT_OF_SCOPE_URL =
  'https://www.dropbox.com/scl/fi/moa8x3q7jkcc6wvs5wr8a/link-target-out-of-scope.txt?rlkey=REDACTED&dl=0';

/** Where a rewritten in-scope link would point. Drive's URL shape; the file id is a placeholder. */
const REWRITTEN_URL =
  'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=drivesdk';

const SRC_DOCX = '/QA-Automation-Dropbox/09-Embedded-Links/embedded_link_doc.docx';
const DEST_DOCX = '/QA-Automation-Dropbox-Dest/09-Embedded-Links/embedded_link_doc.docx';
const SRC_HTML = '/QA-Automation-Dropbox/09-Embedded-Links/document-with-embedded-links.html';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

/**
 * A .docx carrying two real hyperlinks, built exactly the way `_seedEmbeddedLinks` builds it.
 *
 * @param {string} inScope the in-scope hyperlink target
 * @param {string} [outOfScope] the out-of-scope hyperlink target; omitted when empty
 * @returns {Promise<Buffer>}
 */
async function buildDocx(inScope, outOfScope = OUT_OF_SCOPE_URL) {
  const children = [
    new Paragraph({ children: [new TextRun('Embedded link test document (scope 8.1 / 10.8).')] }),
    new Paragraph({ children: [new TextRun('')] }),
    new Paragraph({
      children: [
        new TextRun('Open the in-scope target here: '),
        new ExternalHyperlink({
          children: [new TextRun({ text: 'in-scope target', style: 'Hyperlink' })],
          link: inScope,
        }),
      ],
    }),
  ];
  if (outOfScope !== '') {
    children.push(new Paragraph({
      children: [
        new TextRun('And the out-of-scope target here: '),
        new ExternalHyperlink({
          children: [new TextRun({ text: 'out-of-scope target', style: 'Hyperlink' })],
          link: outOfScope,
        }),
      ],
    }));
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

/** A .docx with no hyperlink at all — the "the links were dropped" case. */
async function buildLinklessDocx() {
  return Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun('No links here.')] })] }],
  }));
}

/** The HTML a converted Google Doc exports, carrying the same two anchors. */
const googleDocExport = (inScope) => '<html><head><meta charset="utf-8"></head><body>'
  + '<p class="c0"><span class="c1">Embedded link test document (scope 8.1 / 10.8).</span></p>'
  + `<p class="c0"><span>Open the in-scope target here: </span><a class="c2" href="${inScope}">`
  + '<span class="c3">in-scope target</span></a></p>'
  + `<p class="c0"><span>And the out-of-scope target here: </span><a href="${OUT_OF_SCOPE_URL}">`
  + '<span class="c3">out-of-scope target</span></a></p></body></html>';

const CSV_HEADER = 'Sl.No,Original File Name,Original File Path,Link File Name,Link Text Name,'
  + 'Linked File Path,Source url,Destination url,Destination Path';

const statuses = (rows) => rows.map((r) => r.status);
const verdictRow = (rows) => rows.find((r) => r.name.startsWith(EMBEDDED_VERDICT));

// ── The path matcher ────────────────────────────────────────────────────────────────

/** The judged document is the .docx, and nothing else in the folder may be mistaken for it. */
function testDocxPathMatcher() {
  assert.ok(EMBEDDED_DOCX_PATH.test('/09-Embedded-Links/embedded_link_doc.docx'),
    'the relativized seeded path matches');
  assert.ok(EMBEDDED_DOCX_PATH.test(SRC_DOCX), 'a My Drive root prefix does not matter');
  assert.ok(EMBEDDED_DOCX_PATH.test('/Team Space/x/09-embedded-links/embedded_link_doc.docx'),
    'case and a Shared Drive prefix do not matter');
  assert.strictEqual(EMBEDDED_DOCX_PATH.test('/09-Embedded-Links/link-target-in-scope.txt'), false,
    'the link target is not the document');
  assert.strictEqual(EMBEDDED_DOCX_PATH.test(SRC_HTML), false,
    'the .html contrast document is NOT the judged document');
  assert.strictEqual(EMBEDDED_DOC_PATH.test(SRC_DOCX), false,
    'and the two matchers do not overlap in the other direction either');
  console.log('  8.1 judged document is embedded_link_doc.docx: ok');
}

// ── Reading a real .docx ────────────────────────────────────────────────────────────

/**
 * A buffer built by the library, read back by the helper. This is the whole premise of the change:
 * if `extractDocxLinks` cannot see the hyperlinks the seeder writes, 8.1 is unverifiable.
 */
async function testRealDocxReadsBack() {
  const buf = await buildDocx(IN_SCOPE_URL);
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000, 'the library produced a real archive');

  const read = extractDocxLinks(buf);
  assert.strictEqual(read.ok, true, 'the archive is readable');
  assert.strictEqual(read.targets.length, 2, 'both hyperlink relationships are found');
  // The rels part stores the ampersand escaped, so the RAW target carries &amp; — the reason the
  // validator decodes before comparing or printing. Asserted rather than assumed.
  assert.ok(read.targets.some((t) => t.includes('&amp;dl=0')),
    'the raw relationship target keeps the XML entity');
  assert.ok(/in-scope target/.test(read.text), 'the visible labels survive in the body text');
  // The URLs must NOT appear as body text: Google auto-links a bare URL on conversion, which would
  // add an anchor carrying the SOURCE address and fail a document whose real link was rewritten.
  assert.strictEqual(read.text.includes('dropbox.com'), false,
    'the seeded document never prints its URLs as plain text');

  const parsed = readDocxAnchors(buf);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.anchors.length, 2);
  assert.deepStrictEqual(parsed.anchors.map((a) => a.href), [IN_SCOPE_URL, OUT_OF_SCOPE_URL],
    'the entity is decoded back to the URL the seeder embedded');
  assert.deepStrictEqual(parsed.anchors.map((a) => a.text),
    ['in-scope target', 'out-of-scope target'], 'the labels are reconstructed from the filenames');
  assert.deepStrictEqual(parsed.inferred, [], 'neither needed an inference');
  console.log('  8.1 a real .docx built by the library reads back through docxLinks: ok');
}

/** Out-of-scope must never be read as in-scope: "out-of-scope" contains "scope". */
function testLabelReconstruction() {
  const groups = classifyEmbeddedAnchors(docxAnchorsFromTargets([
    OUT_OF_SCOPE_URL, IN_SCOPE_URL,
  ]).anchors);
  assert.strictEqual(groups.inScope.length, 1);
  assert.strictEqual(groups.outOfScope.length, 1);
  assert.strictEqual(groups.inScope[0].href, IN_SCOPE_URL, 'order does not decide which is which');
  assert.strictEqual(groups.unclassified.length, 0);

  // A rewritten link carries a file id and no filename, so it is classified by INFERENCE, and the
  // inference is returned so the report can say so out loud.
  const fixed = docxAnchorsFromTargets([REWRITTEN_URL, OUT_OF_SCOPE_URL]);
  assert.deepStrictEqual(fixed.inferred, [REWRITTEN_URL], 'the inference is reported, not hidden');
  const fixedGroups = classifyEmbeddedAnchors(fixed.anchors);
  assert.strictEqual(fixedGroups.inScope.length, 1);
  assert.strictEqual(fixedGroups.inScope[0].state, 'destination');

  // A target pointing at neither system is claimed for nothing.
  const odd = docxAnchorsFromTargets(['https://example.com/somewhere']);
  assert.deepStrictEqual(odd.inferred, []);
  assert.strictEqual(classifyEmbeddedAnchors(odd.anchors).unclassified.length, 1);
  console.log('  8.1 .docx label reconstruction and the in-scope inference: ok');
}

// ── The verdicts ────────────────────────────────────────────────────────────────────

/** The defect 8.1 exists to catch: the in-scope link was not rewritten. */
async function testInScopeStaleFails() {
  const parsed = readDocxAnchors(await buildDocx(IN_SCOPE_URL));
  const rows = judgeEmbeddedLinks(parsed, { destPath: DEST_DOCX });
  const verdict = verdictRow(rows);
  assert.strictEqual(verdict.status, 'FAIL', 'an unrewritten in-scope link is a failure');
  assert.ok(verdict.detail.includes(IN_SCOPE_URL), 'the offending URL is quoted');
  assert.ok(/DID\s+migrate|same destination folder/i.test(verdict.detail),
    'and the detail states that the target migrated');
  assert.strictEqual(statuses(rows).includes('PASS'), false, 'nothing here passes 8.1');
  console.log('  8.1 .docx in-scope link still at Dropbox: FAIL — ok');
}

/** The documented outcome: rewritten to the destination. */
async function testInScopeRewrittenPasses() {
  const parsed = readDocxAnchors(await buildDocx(REWRITTEN_URL));
  const rows = judgeEmbeddedLinks(parsed, { destPath: DEST_DOCX });
  const verdict = verdictRow(rows);
  assert.strictEqual(verdict.status, 'PASS', 'a rewritten in-scope link passes');
  assert.ok(verdict.detail.includes(REWRITTEN_URL), 'the new URL is quoted');
  assert.strictEqual(statuses(rows).includes('FAIL'), false,
    'the out-of-scope link still at Dropbox must not drag the verdict down');
  console.log('  8.1 .docx in-scope link rewritten to Google: PASS — ok');
}

/** Scope 10.8: the out-of-scope link is CORRECT where it is, and failing it is a false positive. */
async function testOutOfScopeStaleIsInfo() {
  const rows = judgeEmbeddedLinks(readDocxAnchors(await buildDocx(REWRITTEN_URL)),
    { destPath: DEST_DOCX });
  const support = rows.filter((r) => /supporting observation/.test(r.name));
  assert.strictEqual(support.length, 1, 'reported once');
  assert.strictEqual(support[0].status, 'INFO', 'at INFO — never FAIL, never WARN');
  assert.ok(support[0].detail.includes(OUT_OF_SCOPE_URL), 'the URL is quoted');
  assert.ok(/CORRECT, not a finding/.test(support[0].detail), 'and stated as correct');

  // An out-of-scope link on its own leaves nothing to judge: not a pass, and not a failure.
  const alone = judgeEmbeddedLinks(readDocxAnchors(await buildDocx(OUT_OF_SCOPE_URL, '')),
    { destPath: DEST_DOCX });
  assert.strictEqual(verdictRow(alone).status, 'WARN', 'no in-scope link means no verdict');
  assert.strictEqual(statuses(alone).includes('FAIL'), false, 'and never a failure');
  console.log('  8.1 .docx out-of-scope link still at Dropbox: INFO, never a failure — ok');
}

/** A converted Google Doc is read through the HTML export and reaches the same verdicts. */
function testConvertedGoogleDocPath() {
  const stale = judgeEmbeddedLinks(extractHtmlAnchors(googleDocExport(IN_SCOPE_URL)),
    { destPath: DEST_DOCX });
  assert.strictEqual(verdictRow(stale).status, 'FAIL',
    'conversion does not excuse an unrewritten link');
  const fixed = judgeEmbeddedLinks(extractHtmlAnchors(googleDocExport(REWRITTEN_URL)),
    { destPath: DEST_DOCX });
  assert.strictEqual(verdictRow(fixed).status, 'PASS',
    'and a rewritten link still passes when read from an export');
  // Google's export wraps the label in <span>; the label is what classifies the anchor, so it has
  // to come out clean or a correct migration would read as unclassified.
  const anchors = extractHtmlAnchors(googleDocExport(REWRITTEN_URL)).anchors;
  assert.deepStrictEqual(anchors.map((a) => a.text),
    ['in-scope target', 'out-of-scope target']);
  console.log('  8.1 converted-to-Google-Doc path reaches the same verdicts: ok');
}

// ── The failures that must never be a pass ──────────────────────────────────────────

/** Missing, undownloadable and unparseable are three findings, and none of them is PASS. */
async function testDistinctWarns() {
  const names = new Set();
  for (const stage of ['missing', 'download', 'parse']) {
    const rows = judgeEmbeddedLinks({ ok: false, stage, reason: 'reason recorded' },
      { destPath: DEST_DOCX });
    const verdict = verdictRow(rows);
    assert.strictEqual(verdict.status, 'WARN', `${stage} is a WARN`);
    assert.strictEqual(statuses(rows).includes('PASS'), false, `${stage} never passes`);
    names.add(verdict.name);
  }
  assert.strictEqual(names.size, 3, 'the three failures are named differently, not collapsed');

  // Bytes that are not a .docx at all: a READ failure with its own reason, not "no links".
  const junk = readDocxAnchors(Buffer.from('%PDF-1.7 this is not a word document'));
  assert.strictEqual(junk.ok, false);
  assert.strictEqual(junk.stage, 'parse');
  assert.ok(/could not be read as a Word document/.test(junk.reason), 'the reason names the cause');
  assert.deepStrictEqual(junk.anchors, [], 'and no anchors are invented');
  const nonBuffer = readDocxAnchors(null);
  assert.strictEqual(nonBuffer.ok, false, 'a failed download that returned nothing is not readable');

  // A .docx that WAS read and holds no hyperlink is a DIFFERENT finding — the links were dropped.
  const gone = judgeEmbeddedLinks(readDocxAnchors(await buildLinklessDocx()),
    { destPath: DEST_DOCX });
  assert.strictEqual(verdictRow(gone).status, 'FAIL', 'a readable document with no link is a defect');
  assert.ok(/no hyperlink at all/.test(verdictRow(gone).detail));
  assert.strictEqual(/could not be read/.test(verdictRow(gone).name), false,
    '"could not read" and "holds no links" stay different findings');
  console.log('  8.1 missing / undownloadable / unparseable: three WARNs, never PASS — ok');
}

// ── The .html contrast document ─────────────────────────────────────────────────────

/** The .html is reported and can never produce a FAIL again. */
function testHtmlContrastNeverFails() {
  const agent = new ValidationAgent();
  const totals = {};
  const checks = [];
  const push = (status, name, detail) => checks.push({ status, name, detail });
  const sourceTree = [{ path: SRC_HTML, type: 'file' }];
  const cmp = { matched: new Map([[SRC_HTML, { dest: { id: 'd1', path: '/Dest/x.html' } }]]) };

  agent._reportEmbeddedHtmlContrast(push, sourceTree, cmp, totals);
  assert.strictEqual(checks.length, 1, 'exactly one observation');
  assert.strictEqual(checks[0].status, 'INFO', 'at INFO — never FAIL, never WARN');
  assert.strictEqual(checks[0].name, EMBEDDED_CONTRAST);
  assert.ok(/not a supported link-rewrite target/i.test(checks[0].detail),
    'it states plainly why the document is not judged');
  assert.ok(/never promised/.test(checks[0].detail),
    'and cites the Drive rationale so nobody turns it back into a failure');
  assert.strictEqual(totals.embeddedLinkContrastDoc.judged, false, 'recorded as not judged');

  // The name must not match the checklist's 8.1 pattern, or the contrast document could decide the
  // feature again — which is the bug being removed.
  const rollup = agent._buildChecklist(
    { enabled: true, scannedSourceItems: 67, migrationType: 'FULL', paperItems: [] },
    [{ name: `[Dest] ${EMBEDDED_CONTRAST}`, status: 'INFO', detail: checks[0].detail }]
  );
  assert.strictEqual(rollup.find((f) => f.id === '8.1').status, 'na',
    'the contrast observation cannot reach the 8.1 verdict in either direction');
  console.log('  8.1 the .html is reported at INFO and can never fail: ok');
}

// ── The CSV cross-check ─────────────────────────────────────────────────────────────

/** No row for the .docx is a WARN, and it is not the same finding as an unapplied rewrite. */
async function testCsvRowAbsentIsWarn() {
  const otherOnly = parseEmbeddedLinksCsv([
    CSV_HEADER,
    '1,qa-paper-full.html,/QA-Automation-Dropbox/11-Paper/qa-paper-full.html,x.txt,x,'
    + '/y.txt,https://www.dropbox.com/scl/fi/a/x.txt,https://www.dropbox.com/scl/fi/a/x.txt,',
  ]);
  const anchors = readDocxAnchors(await buildDocx(IN_SCOPE_URL)).anchors;
  const cross = crossCheckEmbeddedLinksCsv(otherOnly, anchors, {
    destPath: DEST_DOCX, csvName: '"Erik E-EmbeddedLinks.csv"',
  });
  assert.strictEqual(cross.decided, false, 'the CSV cannot decide without a row for the document');
  const warn = cross.observations.find((o) => o.status === 'WARN');
  assert.ok(warn, 'and the absence is a WARN');
  assert.ok(/embedded_link_doc\.docx/.test(warn.detail), 'the document it looked for is named');
  assert.ok(/did not process/.test(warn.detail),
    'the wording says CloudFuze did not process it — not that a rewrite was recorded and dropped');
  assert.strictEqual(/Destination url was recorded and then not applied/.test(warn.detail), true,
    'and it says explicitly that this is a different finding from an unapplied rewrite');

  // The hostname path still decides on its own, exactly as it does with no CSV at all.
  const rows = judgeEmbeddedLinks(readDocxAnchors(await buildDocx(IN_SCOPE_URL)), {
    destPath: DEST_DOCX, csv: otherOnly, csvName: '"Erik E-EmbeddedLinks.csv"',
  });
  assert.strictEqual(verdictRow(rows).status, 'FAIL',
    'a CSV that says nothing about the document cannot weaken the document verdict');
  console.log('  8.1 CSV with no row for the .docx: WARN, and the verdict still stands — ok');
}

// ── _checkEmbeddedLinks: which destination shape arrived ────────────────────────────

/**
 * Walk the real method with `driveClient` replaced in-process, once for each destination shape.
 *
 * Google may or may not convert an imported .docx on a Shared Drive, and no run has established
 * which happens here — so both are exercised, and the report is asserted to SAY which one it saw
 * rather than to assume either.
 */
async function testCheckEmbeddedLinksHandlesBothShapes(mimeType, bytes, expect) {
  const agent = new ValidationAgent();
  const totals = {};
  const checks = [];
  const push = (status, name, detail) => checks.push({ status, name, detail });
  const sourceTree = [{ path: SRC_DOCX, type: 'file' }];
  const cmp = {
    matched: new Map([[SRC_DOCX, { dest: { id: 'dest-1', path: DEST_DOCX, mimeType } }]]),
  };

  const realDownload = driveClient.downloadFile;
  const realExport = driveClient.exportNativeFile;
  const calls = [];
  driveClient.downloadFile = async () => { calls.push('downloadFile'); return bytes; };
  driveClient.exportNativeFile = async () => { calls.push('exportNativeFile'); return bytes; };
  try {
    await agent._checkEmbeddedLinks(push, sourceTree, cmp, 'qa@example.com', totals, undefined);
  } finally {
    driveClient.downloadFile = realDownload;
    driveClient.exportNativeFile = realExport;
  }

  assert.deepStrictEqual(calls, [expect.call], `the ${expect.shape} shape is read the right way`);
  assert.strictEqual(totals.embeddedLinkDoc.destShape, expect.shape, 'the shape is recorded');
  assert.strictEqual(totals.embeddedLinkDoc.readable, true, 'and the document was readable');
  const shapeNote = checks.find((c) => expect.says.test(c.detail));
  assert.ok(shapeNote, `the report states which shape it saw: ${expect.says}`);
  assert.strictEqual(shapeNote.status, 'INFO', 'the shape itself is never a finding');
  const verdict = checks.find((c) => c.name.startsWith(EMBEDDED_VERDICT));
  assert.strictEqual(verdict.status, expect.verdict, 'and the verdict is unaffected by the shape');
  return checks;
}

async function testBothDestinationShapes() {
  await testCheckEmbeddedLinksHandlesBothShapes(DOCX_MIME, await buildDocx(IN_SCOPE_URL), {
    shape: 'docx', call: 'downloadFile', verdict: 'FAIL',
    says: /arrived still as a Word document/,
  });
  await testCheckEmbeddedLinksHandlesBothShapes(
    GOOGLE_DOC_MIME, Buffer.from(googleDocExport(REWRITTEN_URL)),
    {
      shape: 'google-doc', call: 'exportNativeFile', verdict: 'PASS',
      says: /CONVERTED on import/,
    }
  );
  console.log('  8.1 both destination shapes are handled, and the report says which: ok');
}

/** A seeder that skipped the .docx must read as NOT EXERCISED, never as a pass or a defect. */
async function testMissingDocxIsNotExercised() {
  const agent = new ValidationAgent();
  const checks = [];
  const push = (status, name, detail) => checks.push({ status, name, detail });
  await agent._checkEmbeddedLinks(push, [{ path: SRC_HTML, type: 'file' }],
    { matched: new Map() }, 'qa@example.com', {}, undefined);
  const verdict = checks.find((c) => c.name.startsWith(EMBEDDED_VERDICT));
  assert.strictEqual(verdict.status, 'WARN', 'nothing to judge is a WARN');
  assert.ok(/not exercised/.test(verdict.name), 'and it says so in the name');
  assert.ok(/SKIPPED/.test(verdict.detail),
    'the detail names the skip-rather-than-fake-a-URL case as one of the causes');
  assert.strictEqual(statuses(checks).includes('FAIL'), false,
    'and an unseeded document is never a CloudFuze defect');
  console.log('  8.1 a skipped or unseeded .docx: not exercised, never a defect — ok');
}

async function run() {
  testDocxPathMatcher();
  await testRealDocxReadsBack();
  testLabelReconstruction();
  await testInScopeStaleFails();
  await testInScopeRewrittenPasses();
  await testOutOfScopeStaleIsInfo();
  testConvertedGoogleDocPath();
  await testDistinctWarns();
  testHtmlContrastNeverFails();
  await testCsvRowAbsentIsWarn();
  await testBothDestinationShapes();
  await testMissingDocxIsNotExercised();
  console.log('dropbox 8.1 embedded links judged on a real .docx: all assertions passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
