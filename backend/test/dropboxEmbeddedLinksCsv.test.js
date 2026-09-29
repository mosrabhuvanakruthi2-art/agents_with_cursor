/**
 * Run: npm test  (from backend/)
 *
 * Feature 8.1 on dropbox → googledrive / googleshareddrive, cross-checked against CloudFuze's OWN
 * embedded-links report.
 *
 * `<user>-EmbeddedLinks.csv` carries `Source url` AND `Destination url` on every row. That makes it
 * an authoritative EXPECTED VALUE — for each embedded link CloudFuze records both what the URL was
 * and what it should have become — and the validator was throwing it away in favour of a row count.
 * Reading it upgrades the finding from "the href points at dropbox.com" (arguable) to "CloudFuze
 * recorded the destination URL in its own report and did not apply it to the document" (not).
 *
 * WHAT IS MEASURED AND WHAT IS NOT — this matters, because this repo has twice shipped a fixture
 * that agreed with the bug instead of catching it (the Paper table-separator matcher and the
 * list-block counter, both noted in the validator itself):
 *
 *   MEASURED, at the destination Shared Drive QA-Automation-Dropbox-Dest, folder 09-Embedded-Links:
 *     - `document-with-embedded-links.html`, text/html, 520 bytes — the CONTRAST document,
 *       which 8.1 is no longer judged on: plain HTML is not a supported link-rewrite target
 *       under scope 8.1, and CloudFuze's own CSV on that destination carried 12 rows, every
 *       one a Paper document and not one for this .html, so it was never processed
 *   NOT MEASURED — `embedded_link_doc.docx`, the document 8.1 IS judged on, is newly seeded by
 *     _seedEmbeddedLinks and no run has yet observed it at a destination. Its NAME and PATH
 *     below come from the seeder, and the CSV row matcher is asserted against them; whether
 *     Google converts it to a Google Doc on import is not claimed here either way (the
 *     validator handles both shapes and reports which one it saw).
 *     - `link-target-in-scope.txt`, text/plain, 219 bytes — the in-scope target DID migrate
 *     - the two hrefs still inside the destination document, below, `rlkey` redacted and nothing
 *       else touched
 *     - run fe2581f8 reported 8.1 with the CSV present and 8 rows
 *   MEASURED from the seeder (DropboxTestDataAgent):
 *     - the anchor labels "in-scope target" / "out-of-scope target" (`_seedEmbeddedLinks`)
 *     - the folder name `Special ~!@#$%^&()_+[]{};,.= chars` (`SPECIAL_CHARS_NAME`), used here
 *       because it contains a real comma and so exercises quoted-field parsing on a real value
 *   MEASURED from the seniors' reference export:
 *     - the nine column names, verbatim and in order
 *   NOT MEASURED, and marked as such wherever it appears:
 *     - the CONTENTS of the live CSV's `Destination url` column. The run reported the file present
 *       with 8 rows; its cells were not read. So the Drive file id in DEST_URL_* below is a
 *       placeholder, written in Drive's real URL shape. Every assertion here is about the
 *       COMPARISON, which cannot depend on which id CloudFuze wrote.
 *
 * No network is exercised. Every verdict is produced by a pure function.
 */
const assert = require('assert');

const ValidationAgent = require('../src/validation/combinations/content/dropboxToGoogledrive');

const {
  extractHtmlAnchors,
  judgeEmbeddedLinks,
  judgeEmbeddedLinksByHost,
  parseCsvRow,
  normalizeCsvHeader,
  missingEmbeddedCsvColumns,
  parseEmbeddedLinksCsv,
  normalizeEmbeddedUrl,
  csvRowNamesEmbeddedDoc,
  crossCheckEmbeddedLinksCsv,
  EMBEDDED_CSV_COLUMNS,
  EMBEDDED_CSV_CHECK,
} = ValidationAgent;

// ── Measured fixtures ───────────────────────────────────────────────────────────────

/** The two hrefs found inside the DESTINATION copy of the document. Neither was rewritten. */
const MEASURED_IN_SCOPE_URL =
  'https://www.dropbox.com/scl/fi/h12ag1166xmx8tbny3qwy/link-target-in-scope.txt?rlkey=REDACTED';
const MEASURED_OUT_OF_SCOPE_URL =
  'https://www.dropbox.com/scl/fi/moa8x3q7jkcc6wvs5wr8a/link-target-out-of-scope.txt?rlkey=REDACTED';

/** The seeded source paths, as DropboxTestDataAgent._seedEmbeddedLinks writes them. */
const SRC_DOC_PATH = '/QA-Automation-Dropbox/09-Embedded-Links/embedded_link_doc.docx';
const SRC_TARGET_PATH = '/QA-Automation-Dropbox/09-Embedded-Links/link-target-in-scope.txt';
const DEST_DOC_PATH =
  '/QA-Automation-Dropbox-Dest/09-Embedded-Links/embedded_link_doc.docx';

/**
 * Where a rewritten link would point. The URL SHAPE is Drive's; the file id is a placeholder,
 * because the live CSV's cells were never read. Nothing asserted below depends on the id itself.
 */
const DEST_URL_IN_SCOPE =
  'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=drivesdk';

/** The name of the report, as the validator quotes it. */
const CSV_NAME = '"Erik E-EmbeddedLinks.csv"';

/** The nine columns, verbatim from the reference export. */
const CSV_HEADER = 'Sl.No,Original File Name,Original File Path,Link File Name,Link Text Name,'
  + 'Linked File Path,Source url,Destination url,Destination Path';

/** The destination document as measured — both hrefs still at Dropbox. */
const MEASURED_DEST_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Dropbox QA</title></head>
<body><h1>Dropbox QA</h1><p>Seeded HTML document.</p>
<h2>Embedded links</h2>
<p>In scope: <a href="${MEASURED_IN_SCOPE_URL}">in-scope target</a></p>
<p>Out of scope: <a href="${MEASURED_OUT_OF_SCOPE_URL}">out-of-scope target</a></p>
</body></html>
`;

/** The same document as it would look if CloudFuze had done what scope 8.1 promises. */
const REWRITTEN_DEST_HTML =
  MEASURED_DEST_HTML.replace(MEASURED_IN_SCOPE_URL, DEST_URL_IN_SCOPE);

/**
 * One CSV row, assembled from the nine columns.
 * @param {object} o
 */
function csvRow(o) {
  const q = (v) => (String(v).includes(',') ? `"${v}"` : String(v));
  return [
    o.no, q(o.originalName), q(o.originalPath), q(o.linkFileName), q(o.linkTextName),
    q(o.linkedPath), q(o.sourceUrl), q(o.destinationUrl), q(o.destinationPath),
  ].join(',');
}

/** The in-scope row: CloudFuze recorded a rewrite from the Dropbox link to a Drive link. */
const ROW_IN_SCOPE = csvRow({
  no: 1,
  originalName: 'embedded_link_doc.docx',
  originalPath: SRC_DOC_PATH,
  linkFileName: 'link-target-in-scope.txt',
  linkTextName: 'in-scope target',
  linkedPath: SRC_TARGET_PATH,
  sourceUrl: MEASURED_IN_SCOPE_URL,
  destinationUrl: DEST_URL_IN_SCOPE,
  destinationPath: '/QA-Automation-Dropbox-Dest/09-Embedded-Links/link-target-in-scope.txt',
});

/**
 * The out-of-scope row: source and destination URL identical, because that target sits in the
 * sibling QA-Out-Of-Scope folder and was deliberately never migrated, so there is no destination
 * address to rewrite to. Scope 10.8 does not ask for one.
 */
const ROW_OUT_OF_SCOPE = csvRow({
  no: 2,
  originalName: 'embedded_link_doc.docx',
  originalPath: SRC_DOC_PATH,
  linkFileName: 'link-target-out-of-scope.txt',
  linkTextName: 'out-of-scope target',
  linkedPath: '/QA-Out-Of-Scope/link-target-out-of-scope.txt',
  sourceUrl: MEASURED_OUT_OF_SCOPE_URL,
  destinationUrl: MEASURED_OUT_OF_SCOPE_URL,
  destinationPath: '',
});

/** A row for a different document, whose paths carry the seeder's real comma-bearing folder. */
const SPECIAL_DIR = 'Special ~!@#$%^&()_+[]{};,.= chars';
const ROW_OTHER_DOC = csvRow({
  no: 3,
  originalName: 'notes.html',
  originalPath: `/QA-Automation-Dropbox/07-Special-Characters/${SPECIAL_DIR}/notes.html`,
  linkFileName: `${SPECIAL_DIR}.txt`,
  linkTextName: 'special chars',
  linkedPath: `/QA-Automation-Dropbox/07-Special-Characters/${SPECIAL_DIR}/${SPECIAL_DIR}.txt`,
  sourceUrl: 'https://www.dropbox.com/scl/fi/zzz/special.txt?rlkey=REDACTED',
  destinationUrl: 'https://drive.google.com/file/d/1Zz/view?usp=drivesdk',
  destinationPath: `/QA-Automation-Dropbox-Dest/07-Special-Characters/${SPECIAL_DIR}`,
});

const anchorsOf = (html) => extractHtmlAnchors(html).anchors;
const verdictRows = (rows) => rows.filter((r) => /in-document URLs/.test(r.name));
const crossRows = (rows) => rows.filter((r) => r.name === EMBEDDED_CSV_CHECK);
const statuses = (rows) => rows.map((r) => r.status);

// ── The parser ──────────────────────────────────────────────────────────────────────

/**
 * A naive `split(',')` shifts every column after `Linked File Path` one to the left, which would
 * compare a path against an href — a guaranteed false FAIL on a correct migration.
 */
function testQuotedCommaParsing() {
  const fields = parseCsvRow(ROW_OTHER_DOC);
  assert.strictEqual(fields.length, 9, 'nine columns survive a comma inside a quoted field');
  assert.strictEqual(fields[5],
    `/QA-Automation-Dropbox/07-Special-Characters/${SPECIAL_DIR}/${SPECIAL_DIR}.txt`,
    'the Linked File Path keeps its comma and loses its quotes');
  assert.strictEqual(fields[6], 'https://www.dropbox.com/scl/fi/zzz/special.txt?rlkey=REDACTED',
    'Source url is still in column 7, not shifted');
  assert.strictEqual(fields[7], 'https://drive.google.com/file/d/1Zz/view?usp=drivesdk',
    'Destination url is still in column 8');

  // A URL with a comma in its query string is the same hazard.
  const withComma = parseCsvRow('1,a.html,"/x, y/a.html",b.txt,b,"/x, y/b.txt",'
    + '"https://d.com/f?a=1,2","https://drive.google.com/file/d/1B/view",/dest');
  assert.strictEqual(withComma.length, 9);
  assert.strictEqual(withComma[6], 'https://d.com/f?a=1,2', 'a comma inside a URL is not a split');

  // RFC 4180 escaped quote.
  assert.deepStrictEqual(parseCsvRow('a,"he said ""hi""",c'), ['a', 'he said "hi"', 'c']);
  // Empty trailing field is a field, not an absence.
  assert.deepStrictEqual(parseCsvRow('a,b,'), ['a', 'b', '']);
  console.log('  8.1 CSV quoted-comma parsing: ok');
}

/** Header names are compared normalised, so "Sl.No" / "S.No" / "No" are all the index column. */
function testHeaderNormalisation() {
  assert.strictEqual(normalizeCsvHeader('Sl.No'), 'sl no');
  assert.strictEqual(normalizeCsvHeader(' Destination url '), 'destination url');
  assert.strictEqual(normalizeCsvHeader('Link Text Name'), 'link text name');

  assert.deepStrictEqual(missingEmbeddedCsvColumns(parseCsvRow(CSV_HEADER)), [],
    'the reference export satisfies every required column');
  assert.deepStrictEqual(
    missingEmbeddedCsvColumns(parseCsvRow(
      'No,ORIGINAL FILE NAME,Original File Path,Link File Name,Link Text Name,'
      + 'Linked File Path,SOURCE URL,Destination URL,Destination Path'
    )),
    [],
    'case and a plain "No" index column are still a complete header'
  );
  assert.strictEqual(EMBEDDED_CSV_COLUMNS.length, 9, 'nine required columns, per the reference');
  console.log('  8.1 CSV header normalisation: ok');
}

/** Rows come out keyed by column name, and a truncated row is flagged rather than misread. */
function testParseEmbeddedLinksCsv() {
  const csv = parseEmbeddedLinksCsv([CSV_HEADER, ROW_IN_SCOPE, ROW_OUT_OF_SCOPE, ROW_OTHER_DOC]);
  assert.strictEqual(csv.ok, true);
  assert.strictEqual(csv.present, true);
  assert.strictEqual(csv.rows.length, 3);
  assert.strictEqual(csv.malformed, 0);
  assert.deepStrictEqual(csv.missingColumns, []);
  assert.strictEqual(csv.rows[0]['source url'], MEASURED_IN_SCOPE_URL);
  assert.strictEqual(csv.rows[0]['destination url'], DEST_URL_IN_SCOPE);
  assert.strictEqual(csv.rows[0]['link text name'], 'in-scope target');

  // readTextLines splits the file on newlines before this sees it, so a quoted field containing a
  // newline arrives cut in half. That row must be flagged, not read as if its columns lined up.
  const split = parseEmbeddedLinksCsv([
    CSV_HEADER,
    `1,embedded_link_doc.docx,"${SRC_DOC_PATH}`,
    ROW_OUT_OF_SCOPE,
  ]);
  assert.strictEqual(split.malformed, 1, 'the truncated row is counted');
  assert.strictEqual(split.rows[0]._truncated, true);
  assert.strictEqual(split.rows[1]._truncated, false);

  // Absent and empty are different, and neither is "parsed".
  const absent = parseEmbeddedLinksCsv(null);
  assert.strictEqual(absent.ok, false);
  assert.strictEqual(absent.present, false);
  assert.ok(/no embedded-links CSV was found/.test(absent.reason));
  const blank = parseEmbeddedLinksCsv([]);
  assert.strictEqual(blank.ok, false);
  assert.strictEqual(blank.present, true, 'the file was there — it just had nothing in it');
  assert.ok(/not even a header row/.test(blank.reason));
  console.log('  8.1 CSV parsing into keyed rows: ok');
}

/**
 * Only rows about the seeded document are cross-checked, on either Google pair.
 *
 * The document is `embedded_link_doc.docx` now, not the .html. This assertion CHANGED on
 * purpose: judging 8.1 on the .html produced an invalid FAIL that was being reported as a
 * CloudFuze defect, because scope 8.1 promises rewriting only for supported file types and a
 * plain <a href> in an .html file is not one. A row naming the .html would now match nothing,
 * which is correct — the live CSV never carried such a row in the first place.
 */
function testRowMatchesTheSeededDocument() {
  const csv = parseEmbeddedLinksCsv([CSV_HEADER, ROW_IN_SCOPE, ROW_OTHER_DOC]);
  assert.strictEqual(csvRowNamesEmbeddedDoc(csv.rows[0]), true);
  assert.strictEqual(csvRowNamesEmbeddedDoc(csv.rows[1]), false,
    'another document\'s row must not be judged as this one');
  // Windows separators, and a Shared Drive root rather than My Drive: same document.
  assert.strictEqual(csvRowNamesEmbeddedDoc({
    'original file path': '\\Team Space\\QA-Automation-Dropbox\\09-Embedded-Links'
      + '\\embedded_link_doc.docx',
  }), true);
  // Path missing entirely: the name is the fallback, and it is unique in the seeded tree.
  assert.strictEqual(csvRowNamesEmbeddedDoc({
    'original file name': 'embedded_link_doc.docx',
    'original file path': '',
  }), true);
  assert.strictEqual(csvRowNamesEmbeddedDoc({ 'original file name': 'link-target-in-scope.txt' }),
    false, 'the link TARGET is not the document');
  console.log('  8.1 CSV row → seeded document matching: ok');
}

/** Comparing addresses must not be so loose that two different links compare equal. */
function testUrlNormalisation() {
  assert.strictEqual(
    normalizeEmbeddedUrl('https://WWW.DROPBOX.com/scl/fi/AbC/f.txt?rlkey=k&dl=0'),
    'https://www.dropbox.com/scl/fi/AbC/f.txt?rlkey=k',
    'host is lower-cased, the path case is kept, dl=0 is dropped'
  );
  assert.strictEqual(
    normalizeEmbeddedUrl('https://www.dropbox.com/scl/fi/AbC/f.txt?rlkey=k&dl=1'),
    normalizeEmbeddedUrl('https://www.dropbox.com/scl/fi/AbC/f.txt?rlkey=k&dl=0'),
    'the download toggle is not evidence of a missing rewrite'
  );
  // A Drive file id is case-sensitive: lower-casing the path would invent a match.
  assert.notStrictEqual(
    normalizeEmbeddedUrl('https://drive.google.com/file/d/1AbC/view'),
    normalizeEmbeddedUrl('https://drive.google.com/file/d/1abc/view')
  );
  // rlkey identifies the shared link and is compared as written.
  assert.notStrictEqual(
    normalizeEmbeddedUrl('https://www.dropbox.com/scl/fi/x/f.txt?rlkey=aaa'),
    normalizeEmbeddedUrl('https://www.dropbox.com/scl/fi/x/f.txt?rlkey=bbb')
  );
  assert.strictEqual(normalizeEmbeddedUrl('https://drive.google.com/file/d/1A/view/'),
    'https://drive.google.com/file/d/1A/view', 'a trailing slash is not a different address');
  assert.strictEqual(normalizeEmbeddedUrl(''), '');
  assert.strictEqual(normalizeEmbeddedUrl(null), '');
  console.log('  8.1 URL normalisation for comparison: ok');
}

// ── The cross-check ─────────────────────────────────────────────────────────────────

/**
 * A report with no `Source url` / `Destination url` states no expected value. That is a WARN naming
 * exactly which columns are gone — the format is CloudFuze's, so a changed header is a REPORTING
 * problem, not a migration defect — and the document still gets its verdict from hostnames.
 */
function testMissingUrlColumnsWarnNamingThem() {
  const header = 'Sl.No,Original File Name,Original File Path,Link File Name,Link Text Name,'
    + 'Linked File Path,Destination Path';
  const csv = parseEmbeddedLinksCsv([
    header,
    `1,embedded_link_doc.docx,${SRC_DOC_PATH},link-target-in-scope.txt,`
    + 'in-scope target,' + SRC_TARGET_PATH + ',/dest',
  ]);
  assert.deepStrictEqual(csv.missingColumns, ['source url', 'destination url'],
    'both URL columns are reported missing, and nothing else is');

  const cross = crossCheckEmbeddedLinksCsv(csv, anchorsOf(MEASURED_DEST_HTML), {
    destPath: DEST_DOC_PATH, csvName: CSV_NAME,
  });
  assert.strictEqual(cross.decided, false, 'no expected value means no cross-check verdict');
  assert.strictEqual(cross.verdicts.length, 0);
  const warn = cross.observations.find((r) => r.status === 'WARN');
  assert.ok(warn, 'a WARN is raised');
  assert.ok(warn.detail.includes('source url'), 'source url is named');
  assert.ok(warn.detail.includes('destination url'), 'destination url is named');
  assert.ok(/WARN and not a FAIL/.test(warn.detail), 'the wording says why it is not a FAIL');
  assert.ok(/REPORTING problem, not a migration defect/.test(warn.detail),
    'and says whose problem it is');
  assert.strictEqual(statuses(cross.observations).includes('FAIL'), false,
    'a changed CSV format never fails the feature');

  // And the document is still judged, from the other path.
  const rows = judgeEmbeddedLinks(extractHtmlAnchors(MEASURED_DEST_HTML), {
    destPath: DEST_DOC_PATH, csv, csvName: CSV_NAME,
  });
  assert.strictEqual(verdictRows(rows)[0].status, 'FAIL',
    'a missing column must not turn the live defect into "could not assess"');
  console.log('  8.1 CSV missing source/destination url: WARN naming them — ok');
}

/** The href IS the Destination url CloudFuze recorded. That is the strongest possible pass. */
function testHrefMatchingDestinationUrlPasses() {
  const csv = parseEmbeddedLinksCsv([CSV_HEADER, ROW_IN_SCOPE, ROW_OUT_OF_SCOPE]);
  const cross = crossCheckEmbeddedLinksCsv(csv, anchorsOf(REWRITTEN_DEST_HTML), {
    destPath: DEST_DOC_PATH, csvName: CSV_NAME,
  });
  assert.strictEqual(cross.decided, true);
  assert.strictEqual(cross.verdicts.length, 1, 'one decisive row: the in-scope link');
  assert.strictEqual(cross.verdicts[0].status, 'PASS');
  assert.ok(cross.verdicts[0].detail.includes(DEST_URL_IN_SCOPE), 'the matched address is quoted');
  assert.ok(/Destination url/.test(cross.verdicts[0].detail),
    'the pass says it matched CloudFuze\'s own recorded expected value');
  assert.ok(/CSV cross-check, not by hostnames/.test(cross.verdicts[0].detail),
    'and which of the two paths produced it');

  const rows = judgeEmbeddedLinks(extractHtmlAnchors(REWRITTEN_DEST_HTML), {
    destPath: DEST_DOC_PATH, csv, csvName: CSV_NAME,
  });
  assert.deepStrictEqual(statuses(verdictRows(rows)), ['PASS'], 'exactly one verdict, and it passes');
  assert.strictEqual(statuses(rows).includes('FAIL'), false, 'nothing fails on a correct migration');
  console.log('  8.1 href equals the recorded Destination url: PASS — ok');
}

/**
 * The live defect, stated the way it belongs in a ticket. This is the whole reason for reading the
 * CSV, so the sentence is asserted literally.
 */
function testHrefStillAtSourceUrlFails() {
  const csv = parseEmbeddedLinksCsv([CSV_HEADER, ROW_IN_SCOPE, ROW_OUT_OF_SCOPE, ROW_OTHER_DOC]);
  const cross = crossCheckEmbeddedLinksCsv(csv, anchorsOf(MEASURED_DEST_HTML), {
    destPath: DEST_DOC_PATH, csvName: CSV_NAME,
  });
  assert.strictEqual(cross.decided, true);
  assert.strictEqual(cross.verdicts.length, 1, 'the other document\'s row is not judged here');
  const fail = cross.verdicts[0];
  assert.strictEqual(fail.status, 'FAIL');
  assert.ok(fail.detail.startsWith(
    'CloudFuze recorded the destination URL in its own report and did not apply it to the document.'
  ), `the exact reasoning leads the detail, got: ${fail.detail.slice(0, 120)}`);
  assert.ok(fail.detail.includes(MEASURED_IN_SCOPE_URL), 'the Source url still in the document');
  assert.ok(fail.detail.includes(DEST_URL_IN_SCOPE), 'and the Destination url it should have been');
  assert.ok(/link-target-in-scope\.txt/.test(fail.name), 'the name says which link');
  assert.ok(/not a question of which hostname is acceptable/.test(fail.detail),
    'the detail says why this is stronger evidence than the hostname reading');

  const rows = judgeEmbeddedLinks(extractHtmlAnchors(MEASURED_DEST_HTML), {
    destPath: DEST_DOC_PATH, csv, csvName: CSV_NAME,
  });
  assert.deepStrictEqual(statuses(verdictRows(rows)), ['FAIL'],
    'one verdict row, so the same defect is not counted twice');
  assert.ok(crossRows(rows).some((r) => /Corroboration only/.test(r.detail)),
    'the hostname reading is kept as corroboration, under a name the checklist does not key on');
  assert.strictEqual(statuses(rows).includes('PASS'), false, 'nothing about this run passes 8.1');
  console.log('  8.1 href still at the recorded Source url: FAIL with that reasoning — ok');
}

/**
 * Source url === Destination url means CloudFuze never intended a rewrite. INFO, never FAIL — and
 * this is exactly the out-of-scope target, whose file was deliberately never migrated.
 */
function testIdenticalSourceAndDestinationUrlIsInfo() {
  const csv = parseEmbeddedLinksCsv([CSV_HEADER, ROW_OUT_OF_SCOPE]);
  const cross = crossCheckEmbeddedLinksCsv(csv, anchorsOf(MEASURED_DEST_HTML), {
    destPath: DEST_DOC_PATH, csvName: CSV_NAME,
  });
  assert.strictEqual(cross.decided, false, 'a row that intended no rewrite decides nothing');
  const info = cross.observations.filter((r) => r.status === 'INFO');
  assert.strictEqual(info.length, 1, 'the identical-URL row is reported once');
  assert.ok(/SAME address as both Source url and Destination url/.test(info[0].detail));
  assert.ok(/nothing here to have failed/.test(info[0].detail));
  assert.ok(info[0].detail.includes(MEASURED_OUT_OF_SCOPE_URL), 'the address is quoted');
  assert.ok(/only if the referenced files are included in the migration scope|"included in the migration scope"/
    .test(info[0].detail), 'scope 10.8 is quoted, not paraphrased into a rule');
  assert.strictEqual(statuses(cross.observations).includes('FAIL'), false,
    'the out-of-scope target must never fail 8.1 — its target was never migrated');
  assert.strictEqual(statuses(cross.verdicts).includes('FAIL'), false);

  // On the rewritten document the whole feature therefore still passes.
  const csvBoth = parseEmbeddedLinksCsv([CSV_HEADER, ROW_IN_SCOPE, ROW_OUT_OF_SCOPE]);
  const rows = judgeEmbeddedLinks(extractHtmlAnchors(REWRITTEN_DEST_HTML), {
    destPath: DEST_DOC_PATH, csv: csvBoth, csvName: CSV_NAME,
  });
  assert.strictEqual(statuses(rows).includes('FAIL'), false,
    'the identical-URL row must not drag a correct migration down');
  console.log('  8.1 identical Source/Destination url: INFO, never FAIL — ok');
}

/** A row CloudFuze wrote whose link is in neither state: the link may have been dropped. */
function testCsvRowWithNoMatchingHrefWarns() {
  const csv = parseEmbeddedLinksCsv([CSV_HEADER, ROW_IN_SCOPE, ROW_OUT_OF_SCOPE]);
  // The document arrived with the in-scope anchor gone entirely — only the out-of-scope one left.
  const stripped = MEASURED_DEST_HTML.replace(
    `<p>In scope: <a href="${MEASURED_IN_SCOPE_URL}">in-scope target</a></p>\n`, ''
  );
  assert.strictEqual(anchorsOf(stripped).length, 1, 'the fixture really did lose one anchor');

  const cross = crossCheckEmbeddedLinksCsv(csv, anchorsOf(stripped), {
    destPath: DEST_DOC_PATH, csvName: CSV_NAME,
  });
  assert.strictEqual(cross.decided, false, 'neither URL is present, so nothing can be asserted');
  const warn = cross.observations.find((r) => r.status === 'WARN');
  assert.ok(warn, 'a WARN is raised');
  assert.ok(/carries NEITHER address/.test(warn.detail));
  assert.ok(/dropped from the document entirely/.test(warn.detail),
    'and says what it probably means');
  assert.ok(warn.detail.includes(MEASURED_IN_SCOPE_URL), 'the missing link is named');

  // A row with neither URL filled in states nothing, and says so.
  const blankUrls = parseEmbeddedLinksCsv([
    CSV_HEADER,
    csvRowLike({ sourceUrl: '', destinationUrl: '' }),
  ]);
  const noValue = crossCheckEmbeddedLinksCsv(blankUrls, anchorsOf(MEASURED_DEST_HTML), {
    destPath: DEST_DOC_PATH, csvName: CSV_NAME,
  });
  assert.strictEqual(noValue.decided, false);
  assert.ok(noValue.observations.some((r) => r.status === 'WARN'
    && /neither a Source url nor a Destination url/.test(r.detail)));
  console.log('  8.1 CSV row with no matching href: WARN — ok');
}

/** An href CloudFuze's report never mentioned: the CSV cannot speak for it, and says so. */
function testHrefWithNoCsvRowWarns() {
  // Only the in-scope link was reported; the out-of-scope anchor appears on no row.
  const csv = parseEmbeddedLinksCsv([CSV_HEADER, ROW_IN_SCOPE]);
  const cross = crossCheckEmbeddedLinksCsv(csv, anchorsOf(MEASURED_DEST_HTML), {
    destPath: DEST_DOC_PATH, csvName: CSV_NAME,
  });
  assert.strictEqual(cross.decided, true, 'the in-scope row still decides');
  const warn = cross.observations.find((r) => /appear on no row/.test(r.detail));
  assert.ok(warn, 'the uncovered href is reported');
  assert.strictEqual(warn.status, 'WARN');
  assert.ok(warn.detail.includes(MEASURED_OUT_OF_SCOPE_URL), 'it is named');
  assert.ok(/out-of-scope target/.test(warn.detail), 'with its label, so a human can find it');

  // A CSV that covers other documents but not ours cannot cross-check anything.
  const otherOnly = parseEmbeddedLinksCsv([CSV_HEADER, ROW_OTHER_DOC]);
  const none = crossCheckEmbeddedLinksCsv(otherOnly, anchorsOf(MEASURED_DEST_HTML), {
    destPath: DEST_DOC_PATH, csvName: CSV_NAME,
  });
  assert.strictEqual(none.decided, false);
  assert.strictEqual(none.docRows, 0);
  const gap = none.observations.find((r) => r.status === 'WARN');
  assert.ok(gap, 'a report that skipped the one seeded document is a reporting gap');
  assert.ok(/none of which names the seeded document/.test(gap.detail));
  console.log('  8.1 href with no CSV row: WARN naming it — ok');
}

// ── The fallback must survive ───────────────────────────────────────────────────────

/**
 * The CSV makes 8.1 stronger where it applies. It must never become a dependency that turns a real
 * defect into "could not assess", so the hostname verdict is asserted to be BYTE-IDENTICAL when the
 * CSV is absent, empty, or unparseable.
 */
function testHostnameFallbackUnchanged() {
  const parsed = extractHtmlAnchors(MEASURED_DEST_HTML);
  const baseline = judgeEmbeddedLinksByHost(parsed, { destPath: DEST_DOC_PATH });
  assert.strictEqual(verdictRows(baseline)[0].status, 'FAIL', 'the baseline verdict is the defect');

  const cases = {
    'no CSV at the destination': parseEmbeddedLinksCsv(null),
    'a CSV with nothing in it': parseEmbeddedLinksCsv([]),
    'a CSV whose header holds no column names': parseEmbeddedLinksCsv([',,,', '1,2,3']),
    'bytes that are not a CSV at all': parseEmbeddedLinksCsv(['%PDF-1.7 not a csv']),
  };
  for (const [label, csv] of Object.entries(cases)) {
    const rows = judgeEmbeddedLinks(parsed, { destPath: DEST_DOC_PATH, csv, csvName: CSV_NAME });
    assert.deepStrictEqual(
      rows.filter((r) => r.name.startsWith('8.1 Embedded Links (in-document URLs)')),
      baseline.filter((r) => r.name.startsWith('8.1 Embedded Links (in-document URLs)')),
      `${label}: the hostname verdict is produced exactly as before`
    );
    const which = crossRows(rows);
    assert.strictEqual(which.length, 1, `${label}: the report says which path decided`);
    assert.ok(/judged from the destination document's own hostnames|hostnames/.test(which[0].detail),
      `${label}: and names the hostname path`);
    assert.notStrictEqual(which[0].status, 'FAIL', `${label}: a missing report is not a defect`);
  }

  // `%PDF-1.7 not a csv` has no comma, so it parses as a one-column header and no rows. That is
  // still "the CSV said nothing about our document", and it must not be read as a clean report.
  const junk = parseEmbeddedLinksCsv(['%PDF-1.7 not a csv']);
  assert.ok(junk.missingColumns.length > 0, 'junk bytes do not satisfy the required columns');

  // With no `csv` option at all — the shape every existing 8.1 test uses — nothing changes.
  assert.deepStrictEqual(judgeEmbeddedLinks(parsed, { destPath: DEST_DOC_PATH }), baseline,
    'omitting the CSV entirely leaves the original function untouched');
  console.log('  8.1 hostname fallback still produces the verdict: ok');
}

/**
 * If the two paths disagree, the HARSHER reading wins. A CSV recording an acceptable Destination url
 * cannot excuse what the document actually contains — otherwise a report could pass a real defect.
 */
function testDisagreementKeepsTheHarsherVerdict() {
  // CloudFuze records a rewrite from one Dropbox link to ANOTHER Dropbox link, and the document
  // carries the recorded destination. The CSV path is satisfied; the hostname path is not.
  const stillDropbox = 'https://www.dropbox.com/scl/fi/other/link-target-in-scope.txt?rlkey=REDACTED';
  const csv = parseEmbeddedLinksCsv([CSV_HEADER, csvRowLike({ destinationUrl: stillDropbox })]);
  const html = MEASURED_DEST_HTML.replace(MEASURED_IN_SCOPE_URL, stillDropbox);
  const rows = judgeEmbeddedLinks(extractHtmlAnchors(html), {
    destPath: DEST_DOC_PATH, csv, csvName: CSV_NAME,
  });
  const verdicts = verdictRows(rows);
  assert.ok(verdicts.some((r) => r.status === 'PASS'), 'the CSV path is satisfied');
  const kept = verdicts.find((r) => r.status === 'FAIL');
  assert.ok(kept, 'the harsher hostname FAIL keeps the verdict name rather than being demoted');
  assert.ok(/two independent 8.1 paths DISAGREE/.test(kept.detail), 'and the conflict is stated');
  console.log('  8.1 disagreement keeps the harsher verdict: ok');
}

/**
 * The feature checklist must still key on the DOCUMENT verdict. A CSV — however carefully read —
 * may not pass 8.1 on its own, and a CSV-derived FAIL must reach the rollup.
 */
function testChecklistStillKeysOnTheDocumentVerdict() {
  const agent = new ValidationAgent();
  const totals = { enabled: true, scannedSourceItems: 67, migrationType: 'FULL', paperItems: [] };
  const row = (checks) => agent._buildChecklist(totals, checks).find((f) => f.id === '8.1');

  const crossOnly = row([
    { name: `[Dest] ${EMBEDDED_CSV_CHECK}`, status: 'WARN', detail: 'missing source url' },
    { name: '[Dest] 8.1 Embedded Links CSV (supporting evidence)', status: 'INFO', detail: 'present' },
  ]);
  assert.strictEqual(crossOnly.status, 'na',
    'CSV observations alone leave 8.1 not assessed — a report cannot pass or warn the feature');

  const csvFail = row([
    { name: `[Dest] ${EMBEDDED_CSV_CHECK}`, status: 'INFO', detail: 'corroboration' },
    {
      name: '[Dest] 8.1 Embedded Links (in-document URLs) — link-target-in-scope.txt still '
        + 'carries the Source url',
      status: 'FAIL',
      detail: 'CloudFuze recorded the destination URL in its own report and did not apply it.',
    },
  ]);
  assert.strictEqual(csvFail.status, 'fail', 'a CSV-derived verdict does reach the rollup');
  console.log('  8.1 feature checklist still keys on the document verdict: ok');
}

/** ROW_IN_SCOPE with one or two columns overridden. */
function csvRowLike(overrides) {
  return csvRow({
    no: 1,
    originalName: 'embedded_link_doc.docx',
    originalPath: SRC_DOC_PATH,
    linkFileName: 'link-target-in-scope.txt',
    linkTextName: 'in-scope target',
    linkedPath: SRC_TARGET_PATH,
    sourceUrl: MEASURED_IN_SCOPE_URL,
    destinationUrl: DEST_URL_IN_SCOPE,
    destinationPath: '/QA-Automation-Dropbox-Dest/09-Embedded-Links/link-target-in-scope.txt',
    ...overrides,
  });
}

function run() {
  testQuotedCommaParsing();
  testHeaderNormalisation();
  testParseEmbeddedLinksCsv();
  testRowMatchesTheSeededDocument();
  testUrlNormalisation();
  testMissingUrlColumnsWarnNamingThem();
  testHrefMatchingDestinationUrlPasses();
  testHrefStillAtSourceUrlFails();
  testIdenticalSourceAndDestinationUrlIsInfo();
  testCsvRowWithNoMatchingHrefWarns();
  testHrefWithNoCsvRowWarns();
  testHostnameFallbackUnchanged();
  testDisagreementKeepsTheHarsherVerdict();
  testChecklistStillKeysOnTheDocumentVerdict();
  console.log('dropbox 8.1 embedded-links CSV cross-check: all assertions passed');
}

run();
