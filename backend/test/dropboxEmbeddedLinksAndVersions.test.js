/**
 * Run: npm test  (from backend/)
 *
 * Two verified gaps in the dropbox → google validator (both Google pairs share the file):
 *
 *   - feature 8.1 Embedded Links used to PASS on the existence of CloudFuze's report CSV, without
 *     ever opening the migrated document. Run fe2581f8 passed 8.1 that way while the document's
 *     in-scope anchor still pointed at dropbox.com.
 *   - feature 9.1 Version History refused to compare counts, justified by "Google merges
 *     revisions" — a limitation that is documented for Google as a SOURCE
 *     (google-shared-drive-to-sharepoint-outscope.md) and appears nowhere in
 *     dropbox-to-google-outscope.md, where Google is the destination.
 *
 * THE FIXTURES ARE MEASURED, NOT IMAGINED. The HTML below is the destination copy of
 * `09-Embedded-Links/document-with-embedded-links.html` read off the live Shared Drive
 * QA-Automation-Dropbox-Dest (text/html, 520 bytes), and the version counts are the sampled
 * source→destination pairs. This repo has twice shipped a hand-written fixture that agreed with the
 * bug instead of catching it — the table separator matcher (`|---|` vs Paper's `| - |`) and the
 * list-block counter — so a fixture invented to match the code is treated as a defect here.
 *
 * The only redaction is the `rlkey` share token in each Dropbox URL: the host, path and filename
 * are exactly as measured, and those are the parts every assertion reads.
 *
 * No network is exercised. Every verdict is produced by a pure function.
 */
const assert = require('assert');

const ValidationAgent = require('../src/validation/combinations/content/dropboxToGoogledrive');

const {
  extractHtmlAnchors,
  classifyEmbeddedAnchors,
  judgeEmbeddedLinks,
  judgeVersionHistory,
  allVersionsRequested,
  EMBEDDED_DOC_PATH,
} = ValidationAgent;

// ── Measured fixtures ───────────────────────────────────────────────────────────────

/** The two hrefs found inside the DESTINATION copy of the document. Neither was rewritten. */
const MEASURED_IN_SCOPE_URL =
  'https://www.dropbox.com/scl/fi/h12ag1166xmx8tbny3qwy/link-target-in-scope.txt?rlkey=REDACTED';
const MEASURED_OUT_OF_SCOPE_URL =
  'https://www.dropbox.com/scl/fi/moa8x3q7jkcc6wvs5wr8a/link-target-out-of-scope.txt?rlkey=REDACTED';

/**
 * The destination document, in the shape DropboxTestDataAgent._seedEmbeddedLinks writes it:
 * SAMPLE_HTML with its </body> stripped, then the two labelled anchors, then the closing tags.
 */
const MEASURED_DEST_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Dropbox QA</title></head>
<body><h1>Dropbox QA</h1><p>Seeded HTML document.</p>
<h2>Embedded links</h2>
<p>In scope: <a href="${MEASURED_IN_SCOPE_URL}">in-scope target</a></p>
<p>Out of scope: <a href="${MEASURED_OUT_OF_SCOPE_URL}">out-of-scope target</a></p>
</body></html>
`;

/** The same document as it would look if CloudFuze had done what scope 8.1 promises. */
const REWRITTEN_DEST_HTML = MEASURED_DEST_HTML.replace(
  MEASURED_IN_SCOPE_URL,
  'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=drivesdk'
);

/**
 * Sampled version counts. Only the leaf name was recorded for each, which is all the verdict
 * prints, so the fixture paths carry the measured leaf and nothing invented above it.
 */
const MEASURED_VERSIONS = [
  { path: '/file_editor.txt', sourceVersions: 9, destVersions: 9 },
  { path: '/file_viewer.txt', sourceVersions: 9, destVersions: 9 },
  { path: '/document.txt', sourceVersions: 40, destVersions: 40 },
  { path: '/data.csv', sourceVersions: 40, destVersions: 40 },
];

const statuses = (rows) => rows.map((r) => r.status);
const verdictRow = (rows) => rows.find((r) => /in-document URLs/.test(r.name));

// ── Feature 8.1 — reading the document ──────────────────────────────────────────────

/**
 * The seeded document is located by its relativized source path, on both Google pairs.
 *
 * `EMBEDDED_DOC_PATH` now finds the .html CONTRAST document, not the judged one — 8.1 is decided by
 * `embedded_link_doc.docx`, because judging the .html produced an invalid FAIL against behaviour
 * scope 8.1 never promised. The matcher itself is unchanged and still has to be exact, so these
 * assertions stand as they were; the judged document's matcher is asserted in
 * `dropboxEmbeddedLinksDocx.test.js`, which also pins that the two cannot match each other.
 */
function testDocumentPathMatcher() {
  assert.ok(EMBEDDED_DOC_PATH.test('/09-Embedded-Links/document-with-embedded-links.html'),
    'the relativized seeded path matches');
  assert.ok(EMBEDDED_DOC_PATH.test('/QA-Automation-Dropbox/09-embedded-links/document-with-embedded-links.html'),
    'case and a leading prefix do not matter');
  // The folder itself and the link TARGET must not be mistaken for the document — that is exactly
  // the substring-matching mistake the CSV check made when it passed 8.1 on a directory.
  assert.strictEqual(EMBEDDED_DOC_PATH.test('/09-Embedded-Links'), false,
    'the folder is not the document');
  assert.strictEqual(EMBEDDED_DOC_PATH.test('/09-Embedded-Links/link-target-in-scope.txt'), false,
    'the link target is not the document');
  console.log('  8.1 embedded-link document path matcher: ok');
}

/** The anchors and their hrefs come out of the real destination bytes exactly. */
function testAnchorExtraction() {
  const parsed = extractHtmlAnchors(MEASURED_DEST_HTML);
  assert.strictEqual(parsed.ok, true, 'the measured document is readable');
  assert.strictEqual(parsed.anchors.length, 2, 'the document holds exactly two anchors');
  assert.deepStrictEqual(parsed.anchors.map((a) => a.href),
    [MEASURED_IN_SCOPE_URL, MEASURED_OUT_OF_SCOPE_URL]);
  assert.deepStrictEqual(parsed.anchors.map((a) => a.text),
    ['in-scope target', 'out-of-scope target'], 'the labels survive, and they are the classifier');

  // A Google HTML export wraps anchor text in <span>; the label must still come out clean.
  const spanned = extractHtmlAnchors(
    '<html><body><p><a href="https://drive.google.com/file/d/1x/view">'
    + '<span class="c1">in-scope target</span></a></p></body></html>'
  );
  assert.strictEqual(spanned.anchors[0].text, 'in-scope target', 'inner markup is stripped');

  // &amp; is not cosmetic: a Dropbox shared link carries ?rlkey=…&dl=0.
  const escaped = extractHtmlAnchors(
    '<html><body><a href="https://www.dropbox.com/scl/fi/x/f.txt?rlkey=k&amp;dl=0">in-scope</a></body></html>'
  );
  assert.strictEqual(escaped.anchors[0].href,
    'https://www.dropbox.com/scl/fi/x/f.txt?rlkey=k&dl=0', 'the entity is decoded');
  console.log('  8.1 anchor extraction from the measured document: ok');
}

/** The out-of-scope label must never be read as an in-scope match. */
function testAnchorClassification() {
  const groups = classifyEmbeddedAnchors(extractHtmlAnchors(MEASURED_DEST_HTML).anchors);
  assert.strictEqual(groups.inScope.length, 1, 'one in-scope anchor');
  assert.strictEqual(groups.outOfScope.length, 1, 'one out-of-scope anchor');
  assert.strictEqual(groups.unclassified.length, 0, 'both anchors were recognised');
  assert.strictEqual(groups.inScope[0].href, MEASURED_IN_SCOPE_URL);
  assert.strictEqual(groups.outOfScope[0].href, MEASURED_OUT_OF_SCOPE_URL);
  assert.strictEqual(groups.inScope[0].state, 'source', 'the in-scope link still points at Dropbox');
  assert.strictEqual(groups.outOfScope[0].state, 'source');

  // A rewritten link is classified by its LABEL, because the Drive URL carries a file id and no
  // filename — filename matching alone could recognise a stale link and never a fixed one.
  const fixed = classifyEmbeddedAnchors(extractHtmlAnchors(REWRITTEN_DEST_HTML).anchors);
  assert.strictEqual(fixed.inScope.length, 1, 'a rewritten link is still classified as in-scope');
  assert.strictEqual(fixed.inScope[0].state, 'destination');
  console.log('  8.1 anchor classification: ok');
}

/** The live defect: the in-scope link was not rewritten, and that is a FAIL. */
function testInScopeStaleFails() {
  const rows = judgeEmbeddedLinks(extractHtmlAnchors(MEASURED_DEST_HTML), {
    destPath: '/QA-Automation-Dropbox-Dest/09-Embedded-Links/document-with-embedded-links.html',
  });
  const verdict = verdictRow(rows);
  assert.ok(verdict, 'a verdict row is produced');
  assert.strictEqual(verdict.status, 'FAIL',
    'an in-scope link still pointing at Dropbox is a failure, not a pass on the CSV beside it');
  assert.ok(verdict.detail.includes(MEASURED_IN_SCOPE_URL), 'the offending URL is quoted');
  assert.ok(/same destination folder/i.test(verdict.detail),
    'the detail says the target migrated to the same folder');
  assert.ok(/sent back to the source system/i.test(verdict.detail),
    'the detail says what it costs a reader');
  assert.strictEqual(statuses(rows).includes('PASS'), false, 'nothing about this run passes 8.1');
  console.log('  8.1 in-scope link still pointing at Dropbox: FAIL — ok');
}

/** The same document with the in-scope link rewritten is the pass, and it quotes the new URL. */
function testInScopeRewrittenPasses() {
  const rows = judgeEmbeddedLinks(extractHtmlAnchors(REWRITTEN_DEST_HTML), { destPath: '/doc.html' });
  const verdict = verdictRow(rows);
  assert.strictEqual(verdict.status, 'PASS', 'a rewritten in-scope link is the documented outcome');
  assert.ok(/drive\.google\.com/.test(verdict.detail), 'the rewritten URL is quoted');
  assert.strictEqual(statuses(rows).includes('FAIL'), false,
    'the out-of-scope link still pointing at Dropbox must not drag the verdict down');
  console.log('  8.1 in-scope link rewritten to Google: PASS — ok');
}

/**
 * The out-of-scope link is CORRECT where it is. Scope 10.8 limits the transformation to files
 * inside the migration scope, so failing this would be a false positive.
 */
function testOutOfScopeStaleIsNotAFailure() {
  const rows = judgeEmbeddedLinks(extractHtmlAnchors(REWRITTEN_DEST_HTML), { destPath: '/doc.html' });
  const support = rows.filter((r) => /supporting observation/.test(r.name));
  assert.strictEqual(support.length, 1, 'the out-of-scope link is reported, once');
  assert.strictEqual(support[0].status, 'INFO', 'supporting evidence at most — never FAIL or WARN');
  assert.ok(support[0].detail.includes(MEASURED_OUT_OF_SCOPE_URL), 'the URL is quoted');
  assert.ok(/CORRECT, not a finding/.test(support[0].detail), 'it is stated as correct');
  assert.ok(/only if the referenced files are included in the migration scope/
    .test(support[0].detail), 'the scope 10.8 condition is quoted, not paraphrased into a rule');
  // Judged on its own, an out-of-scope-only document still cannot pass 8.1 — there is no in-scope
  // anchor to judge — but it must not fail either.
  const alone = judgeEmbeddedLinks({
    ok: true,
    anchors: [{ href: MEASURED_OUT_OF_SCOPE_URL, text: 'out-of-scope target' }],
  }, { destPath: '/doc.html' });
  assert.strictEqual(verdictRow(alone).status, 'WARN', 'no in-scope anchor means no verdict');
  assert.strictEqual(statuses(alone).includes('FAIL'), false, 'and never a failure');
  console.log('  8.1 out-of-scope link still pointing at Dropbox: not a finding — ok');
}

/**
 * "Could not be read" and "no links found" must never reach the report as the same thing, and
 * neither may ever be a pass.
 */
function testUnreadableIsWarnNeverPass() {
  const cases = [
    ['missing', 'document not found at the destination'],
    ['download', 'document could not be downloaded'],
    ['parse', 'document could not be read'],
  ];
  const seen = new Set();
  for (const [stage, expected] of cases) {
    const rows = judgeEmbeddedLinks({ ok: false, stage, reason: 'measured reason' });
    const verdict = verdictRow(rows);
    assert.strictEqual(verdict.status, 'WARN', `${stage} is a WARN`);
    assert.ok(verdict.name.includes(expected), `${stage} names which failure it was: ${verdict.name}`);
    assert.strictEqual(statuses(rows).includes('PASS'), false, `${stage} never passes`);
    seen.add(verdict.name);
  }
  assert.strictEqual(seen.size, 3, 'the three failures are named differently, not collapsed');

  // Empty bytes and non-HTML bytes are read failures, with their own reasons.
  const empty = extractHtmlAnchors('');
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.stage, 'parse');
  assert.ok(/0 bytes/.test(empty.reason), 'an empty download says so');
  const junk = extractHtmlAnchors('%PDF-1.7 not html at all');
  assert.strictEqual(junk.ok, false);
  assert.ok(/no HTML markup/.test(junk.reason), 'non-HTML bytes say so');

  // A document that WAS read and holds no anchor is a different finding: the links were dropped.
  const gone = judgeEmbeddedLinks(
    extractHtmlAnchors('<html><body><h1>Dropbox QA</h1><p>Seeded HTML document.</p></body></html>'),
    { destPath: '/doc.html' }
  );
  assert.strictEqual(verdictRow(gone).status, 'FAIL', 'a readable document with no link is a defect');
  assert.ok(/no hyperlink at all/.test(verdictRow(gone).detail));
  assert.strictEqual(verdictRow(gone).name.includes('could not be read'), false,
    'a dropped link must not be reported as an unreadable document');
  console.log('  8.1 unreadable / missing / dropped links: distinct, and never PASS — ok');
}

/** The CSV can no longer decide 8.1 — only the document verdict reaches the feature checklist. */
function testChecklistKeysOnTheDocumentNotTheCsv() {
  const agent = new ValidationAgent();
  // paperItems is supplied because _buildChecklist reads it for the §10 rows; _emptyTotals
  // always provides it in a real run.
  const totals = { enabled: true, scannedSourceItems: 67, migrationType: 'FULL', paperItems: [] };
  const row = (checks) => agent._buildChecklist(totals, checks).find((f) => f.id === '8.1');

  const csvOnly = row([
    { name: '[Dest] 8.1 Embedded Links CSV (supporting evidence)', status: 'INFO', detail: 'present' },
  ]);
  assert.strictEqual(csvOnly.status, 'na',
    'a present CSV alone leaves 8.1 not assessed — this is the false pass that is being removed');

  const staleDoc = row([
    { name: '[Dest] 8.1 Embedded Links CSV (supporting evidence)', status: 'INFO', detail: 'present' },
    {
      name: '[Dest] 8.1 Embedded Links (in-document URLs) — 1 in-scope link(s) still point at Dropbox',
      status: 'FAIL',
      detail: 'still links to dropbox.com',
    },
  ]);
  assert.strictEqual(staleDoc.status, 'fail', 'the document verdict decides the feature');

  const supportingOnly = row([
    { name: '[Dest] 8.1 Embedded Links — supporting observation', status: 'INFO', detail: 'out of scope' },
  ]);
  assert.strictEqual(supportingOnly.status, 'na',
    'the supporting INFO row must not be able to pass the feature on its own');

  const rewritten = row([
    { name: '[Dest] 8.1 Embedded Links (in-document URLs)', status: 'PASS', detail: 'rewritten' },
  ]);
  assert.strictEqual(rewritten.status, 'pass', 'a rewritten in-scope link passes 8.1');
  console.log('  8.1 feature checklist keys on the document verdict: ok');
}

// ── Feature 9.1 — comparing version counts ──────────────────────────────────────────

/** The job default is ALL versions, exactly as migrationClient's opt() reads it. */
function testAllVersionsRequestedMirrorsTheJob() {
  assert.strictEqual(allVersionsRequested({}), true, 'no options at all means all versions');
  assert.strictEqual(allVersionsRequested({ contentOptions: {} }), true,
    'an options object without the key means all versions — migrationClient defaults opt() to true');
  assert.strictEqual(allVersionsRequested({ contentOptions: { versionHistory: true } }), true);
  assert.strictEqual(allVersionsRequested({ contentOptions: { versionHistory: false } }), false);
  console.log('  9.x all-versions-requested mirrors the job option: ok');
}

/** Every measured pair matched exactly, and that is a stronger statement than "history arrived". */
function testCountsEqualPasses() {
  const v = judgeVersionHistory(MEASURED_VERSIONS, { allVersionsRequested: true });
  assert.strictEqual(v.status, 'PASS');
  assert.ok(/matched the source EXACTLY/.test(v.detail), 'the pass claims equality, not presence');
  assert.ok(/file_editor\.txt 9→9/.test(v.detail), 'the measured examples are quoted');
  assert.ok(/document\.txt 40→40/.test(v.detail));
  assert.strictEqual(/merges revision/i.test(v.detail), false,
    'the undocumented merging excuse is gone from the pass text');
  console.log('  9.1 counts equal (9→9, 40→40): PASS — ok');
}

/** A shortfall is a real observation, surfaced for a human rather than failed. */
function testCountLowerWarns() {
  const v = judgeVersionHistory([
    ...MEASURED_VERSIONS.slice(0, 3),
    { path: '/data.csv', sourceVersions: 40, destVersions: 37 },
  ], { allVersionsRequested: true });
  assert.strictEqual(v.status, 'WARN', 'a shortfall warns — it neither passes nor fails');
  assert.ok(/FEWER versions/.test(v.detail));
  assert.ok(/data\.csv 40→37/.test(v.detail), 'the file and BOTH numbers are named');
  assert.ok(/dropbox-to-google-outscope\.md/.test(v.detail),
    'the note says where a confirmed merging limitation would have to be recorded');
  assert.ok(/shortfall is a defect/.test(v.detail),
    'and that it is a defect if merging is not confirmed');
  console.log('  9.1 destination count lower: WARN — ok');
}

/** A migration inventing revisions is also worth seeing. */
function testCountHigherWarns() {
  const v = judgeVersionHistory([
    { path: '/file_editor.txt', sourceVersions: 9, destVersions: 11 },
  ], { allVersionsRequested: true });
  assert.strictEqual(v.status, 'WARN');
  assert.ok(/MORE versions/.test(v.detail));
  assert.ok(/file_editor\.txt 9→11/.test(v.detail));
  console.log('  9.1 destination count higher: WARN — ok');
}

/** History lost entirely stays a FAIL, and outranks the shortfall WARN. */
function testNoHistoryStillFails() {
  const v = judgeVersionHistory([
    { path: '/10-Versions/versioned-a.txt', sourceVersions: 3, destVersions: 1 },
    { path: '/10-Versions/versioned-b.txt', sourceVersions: 3, destVersions: 3 },
  ], { allVersionsRequested: true });
  assert.strictEqual(v.status, 'FAIL', 'no history at all is still a failure, not a count warning');
  assert.ok(/no history at all/.test(v.detail));
  assert.ok(v.detail.includes('/10-Versions/versioned-a.txt'), 'the file is named');
  assert.ok(/\(3→1\)/.test(v.detail), 'with both numbers');

  const zero = judgeVersionHistory([{ path: '/a.txt', sourceVersions: 9, destVersions: 0 }],
    { allVersionsRequested: true });
  assert.strictEqual(zero.status, 'FAIL', 'zero destination versions is the same failure');
  console.log('  9.1 no history at the destination: FAIL — ok');
}

/** Counts are only comparable when the job asked for all of them. */
function testSelectiveRunDoesNotCompareCounts() {
  const v = judgeVersionHistory([
    { path: '/file_editor.txt', sourceVersions: 9, destVersions: 5 },
  ], { allVersionsRequested: false });
  assert.strictEqual(v.status, 'PASS',
    'a run that did not request all versions has no N to compare against — scope 9.2');
  assert.ok(/Counts are NOT compared/.test(v.detail), 'and it says so rather than implying equality');
  console.log('  9.1 selective run leaves counts uncompared: ok');
}

/** Nothing seeded means nothing proven — never a pass, and the wording must not lie about why. */
function testNoSourceHistoryWarns() {
  const none = judgeVersionHistory([{ path: '/a.txt', sourceVersions: 1, destVersions: 1 }],
    { allVersionsRequested: true });
  assert.strictEqual(none.status, 'WARN', 'no source history means the feature was not exercised');

  // A file with history at the destination and one revision at the source is a failed Dropbox
  // read, not a single-version file. Saying "none had more than one source revision" and stopping
  // sends the reader to fix seeding that is not broken.
  const readFailed = judgeVersionHistory([{ path: '/a.txt', sourceVersions: 0, destVersions: 9 }],
    { allVersionsRequested: true });
  assert.strictEqual(readFailed.status, 'WARN');
  assert.ok(/DO have history at the destination/.test(readFailed.detail),
    'the contradiction is reported instead of being described as a single-version source');
  console.log('  9.1 unexercised / failed source read: WARN — ok');
}

/** A count shortfall must not show up as a passing feature in the 36-feature rollup. */
function testChecklistNeverPassesAShortfall() {
  const agent = new ValidationAgent();
  // paperItems is supplied because _buildChecklist reads it for the §10 rows; _emptyTotals
  // always provides it in a real run.
  const totals = { enabled: true, scannedSourceItems: 67, migrationType: 'FULL', paperItems: [] };
  const rollup = agent._buildChecklist(totals, [
    { name: '[Dest] 9.1 Version History', status: 'WARN', detail: '1 arrived with FEWER versions' },
  ]);
  assert.strictEqual(rollup.find((f) => f.id === '9.1').status, 'na',
    'a WARN is not assessed, never a pass');
  console.log('  9.1 shortfall is not counted as a passing feature: ok');
}

function run() {
  testDocumentPathMatcher();
  testAnchorExtraction();
  testAnchorClassification();
  testInScopeStaleFails();
  testInScopeRewrittenPasses();
  testOutOfScopeStaleIsNotAFailure();
  testUnreadableIsWarnNeverPass();
  testChecklistKeysOnTheDocumentNotTheCsv();
  testAllVersionsRequestedMirrorsTheJob();
  testCountsEqualPasses();
  testCountLowerWarns();
  testCountHigherWarns();
  testNoHistoryStillFails();
  testSelectiveRunDoesNotCompareCounts();
  testNoSourceHistoryWarns();
  testChecklistNeverPassesAShortfall();
  console.log('dropbox embedded links (8.1) + version counts (9.1): all assertions passed');
}

run();
