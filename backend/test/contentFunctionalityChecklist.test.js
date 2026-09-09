/**
 * Run: npm test  (from backend/)
 *
 * The 38-feature rollup for Google Shared Drive → SharePoint.
 *
 * The property that matters most here: a feature that was never exercised must report 'na' with a
 * reason, NEVER 'pass'. A checklist that turns "we did not look" into a green tick is worse than no
 * checklist at all.
 */
const assert = require('assert');
const {
  computeContentFunctionalityChecklist,
  summarizeChecklist,
  buildIds,
} = require('../src/validation/shared/contentFunctionalityChecklist');

const byId = (res) => Object.fromEntries(rowsOf(res).map((r) => [r.id, r]));
const rowsOf = (res) => (Array.isArray(res) ? res : res.rows);
const summarize = (res) => summarizeChecklist(rowsOf(res), Array.isArray(res) ? null : res.coverage);

/** A run where everything was checked and everything was clean. */
function healthy(overrides = {}) {
  return {
    enabled: true,
    metadataChecked: true,
    linksChecked: true,
    notificationsChecked: true,
    hashChecked: true,
    migrationType: 'FULL',
    scannedSourceItems: 20,
    pairedCount: 20,
    missing: [], extra: [], misplaced: [], placeholderLinks: [],
    permissionMismatches: [], sharedLinkMismatches: [], conversionMismatches: [],
    timestampDrift: [], versionInfo: [], notificationLeaks: [],
    permissionObservations: [], linkObservations: [], externalShares: [],
    fileTypes: [{ ext: '.pdf', total: 3, paired: 3 }],
    specialChars: { total: 0, arrived: 0 },
    ...overrides,
  };
}

function testFeatureListShape() {
  const ids = buildIds();
  assert.strictEqual(ids.length, 38, 'the in-scope document defines 38 features');
  assert.strictEqual(new Set(ids.map((i) => i.id)).size, 38, 'ids are unique');
  // Spot-check the numbering matches the document
  const m = byId(ids);
  assert.strictEqual(m['4.5'].feature, 'Folder Permissions: Content Manager');
  assert.strictEqual(m['5.12'].feature, 'Files: Anyone with link - Editor');
  assert.strictEqual(m['12.1'].category, 'File Conversion');
  assert.ok(ids.every((i) => i.category && i.feature));
}

function testNothingValidatedIsNeverPass() {
  // Deep validation switched off
  const off = computeContentFunctionalityChecklist({ enabled: false });
  assert.strictEqual(rowsOf(off).length, 38);
  assert.ok(rowsOf(off).every((r) => r.status === 'na'), 'a disabled run passes nothing');
  assert.ok(rowsOf(off).every((r) => /disabled/.test(r.detail)));

  // Enabled but zero items read — the vacuous-pass trap
  const empty = computeContentFunctionalityChecklist(healthy({ scannedSourceItems: 0 }));
  assert.ok(rowsOf(empty).every((r) => r.status === 'na'), 'reading nothing passes nothing');
  assert.ok(rowsOf(empty).every((r) => /nothing was validated/.test(r.detail)));
  assert.strictEqual(summarize(empty).pass, 0);
}

function testUnexercisedFeaturesAreNa() {
  // A clean run that simply had no shared items, no links, no special characters
  const rows = byId(computeContentFunctionalityChecklist(healthy()));

  for (const id of ['4.2', '4.3', '4.4', '4.5', '4.6', '4.7', '4.8']) {
    assert.strictEqual(rows[id].status, 'na', `${id} was not exercised`);
    assert.ok(/not exercised/.test(rows[id].detail), `${id} says why`);
  }
  for (const id of ['5.2', '5.9', '5.12', '5.15']) {
    assert.strictEqual(rows[id].status, 'na', `${id} was not exercised`);
  }
  assert.strictEqual(rows['7.1'].status, 'na', 'no special characters in the source');
  assert.strictEqual(rows['11.1'].status, 'na', 'no over-limit paths in the source');
  assert.strictEqual(rows['4.9'].status, 'na', 'no external shares in the source');

  // What WAS exercised passes
  assert.strictEqual(rows['1.1'].status, 'pass');
  assert.strictEqual(rows['2.1'].status, 'pass');
  assert.strictEqual(rows['3.1'].status, 'pass');
}

function testPermissionRows() {
  const rows = byId(computeContentFunctionalityChecklist(healthy({
    permissionObservations: [
      { itemType: 'folder', role: 'reader', match: true, path: '/A' },
      { itemType: 'folder', role: 'commenter', match: true, path: '/A' },
      { itemType: 'folder', role: 'fileOrganizer', match: true, path: '/A' },
      { itemType: 'file', role: 'writer', match: false, path: '/A/f.pdf' },
    ],
  })));

  assert.strictEqual(rows['4.2'].status, 'pass', 'folder Viewer observed and correct');
  assert.strictEqual(rows['4.3'].status, 'pass', 'folder Commenter observed and correct');
  assert.strictEqual(rows['4.5'].status, 'pass', 'folder Content Manager observed and correct');
  assert.strictEqual(rows['4.8'].status, 'fail', 'file Editor observed and wrong');
  assert.ok(/f\.pdf/.test(rows['4.8'].detail), 'the failing path is named');

  // Roles never seen stay na even though sibling roles were checked
  assert.strictEqual(rows['4.4'].status, 'na', 'folder Contributor was not observed');
  assert.strictEqual(rows['4.6'].status, 'na', 'file Viewer was not observed');

  // The aggregate reflects the failure
  assert.strictEqual(rows['4.1'].status, 'fail');

  // case-insensitivity: the API returns camelCase roles
  const camel = byId(computeContentFunctionalityChecklist(healthy({
    permissionObservations: [{ itemType: 'folder', role: 'fileorganizer', match: true, path: '/A' }],
  })));
  assert.strictEqual(camel['4.5'].status, 'pass');
}

function testLinkRows() {
  const rows = byId(computeContentFunctionalityChecklist(healthy({
    linkObservations: [
      { itemType: 'folder', linkType: 'anyone', role: 'reader', match: true, path: '/A' },
      { itemType: 'folder', linkType: 'domain', role: 'writer', match: true, path: '/A' },
      { itemType: 'file', linkType: 'anyone', role: 'writer', match: false, path: '/A/f.pdf' },
    ],
  })));

  assert.strictEqual(rows['5.2'].status, 'pass', 'folder anonymous view link');
  assert.strictEqual(rows['5.8'].status, 'pass', 'folder organization edit link');
  assert.strictEqual(rows['5.12'].status, 'fail', 'file anonymous edit link is wrong');
  assert.strictEqual(rows['5.5'].status, 'na', 'that link combination was not present');
  assert.strictEqual(rows['5.1'].status, 'fail', 'the aggregate reflects the failure');
}

function testVersionsNeverFailOnCount() {
  // Fewer versions at the destination is documented Google behaviour, not a defect
  const fewer = byId(computeContentFunctionalityChecklist(healthy({
    versionInfo: [{ path: '/a.txt', sourceVersions: 7, destVersions: 3, severity: 'INFO' }],
  })));
  assert.strictEqual(fewer['8.1'].status, 'info', 'a count difference is informational');
  assert.notStrictEqual(fewer['8.1'].status, 'fail');
  assert.ok(/merges smaller revisions/.test(fewer['8.1'].detail), 'the reason travels with it');

  // More versions is also expected (SharePoint adds one for the migration timestamp)
  const more = byId(computeContentFunctionalityChecklist(healthy({
    versionInfo: [{ path: '/a.txt', sourceVersions: 3, destVersions: 6, severity: 'INFO' }],
  })));
  assert.strictEqual(more['8.1'].status, 'info');

  // But NO history at all is a real problem — versioning is probably off on the library
  const none = byId(computeContentFunctionalityChecklist(healthy({
    versionInfo: [{ path: '/a.txt', sourceVersions: 5, destVersions: 0, severity: 'INFO' }],
  })));
  // Reported as INFO, matching the WARN the validator raises — but the reason must still be there.
  assert.strictEqual(none['8.1'].status, 'info');
  assert.notStrictEqual(none['8.1'].status, 'pass', 'and never silently passes');
  assert.ok(/versioning is enabled/.test(none['8.1'].detail));
}

function testDeltaAwareness() {
  const full = byId(computeContentFunctionalityChecklist(healthy({ migrationType: 'FULL' })));
  assert.strictEqual(full['1.1'].status, 'pass', 'one-time migration was exercised');
  assert.strictEqual(full['1.2'].status, 'na', 'delta was not');

  const delta = byId(computeContentFunctionalityChecklist(healthy({ migrationType: 'DELTA' })));
  assert.strictEqual(delta['1.2'].status, 'pass', 'delta migration was exercised');
  assert.strictEqual(delta['1.1'].status, 'na', 'one-time was not');
}

function testSwitchedOffTiers() {
  const noMeta = byId(computeContentFunctionalityChecklist(healthy({ metadataChecked: false })));
  for (const id of ['4.1', '4.5', '8.1', '10.1']) {
    assert.strictEqual(noMeta[id].status, 'na', `${id} cannot be claimed when Tier C is off`);
  }
  assert.strictEqual(noMeta['3.1'].status, 'pass', 'structure is unaffected by the metadata switch');

  const noLinks = byId(computeContentFunctionalityChecklist(healthy({ linksChecked: false })));
  assert.strictEqual(noLinks['5.4'].status, 'na');
  assert.ok(/switched off/.test(noLinks['5.4'].detail));

  const noNotify = byId(computeContentFunctionalityChecklist(healthy({ notificationsChecked: false })));
  assert.strictEqual(noNotify['9.1'].status, 'na');
  assert.ok(/Manual:/.test(noNotify['9.1'].detail), 'an unautomated feature carries a manual step');
}

function testUnautomatedFeaturesCarryManualSteps() {
  const rows = byId(computeContentFunctionalityChecklist(healthy()));
  // 6.1 (embedded links INSIDE a document) genuinely is not automated: reading a .docx needs an
  // archive library this project does not use. It must still tell a human exactly what to open.
  assert.strictEqual(rows['6.1'].status, 'na', '6.1 is not automated');
  assert.ok(/Not automated|Not exercised/.test(rows['6.1'].detail), '6.1 says so plainly');
  assert.ok(/Manual:|no document/.test(rows['6.1'].detail), '6.1 tells a human what to do instead');
}


/**
 * The CSV reports must carry the columns the team's reference exports carry.
 *
 * Row count alone does not make a report usable: without the destination path and link on the same
 * row, a customer cannot answer "what was shared, and where did it end up?" — the report is full of
 * rows and still useless. The index column is written as "No", "S.No" and "Sl.No" across real
 * exports, so matching is on a normalised header and must not fail a correct report over that.
 */
function testCsvColumnContract() {
  const V = require('../src/validation/combinations/content/googledriveToSharepoint');
  const req = V.CSV_REQUIRED_COLUMNS;

  // Both real headers seen in the field pass — the reference export and our own.
  assert.deepStrictEqual(
    V.missingCsvColumns('No,File/Folder Name,Source Path,Destination Path,Destination shared link',
      req.sharedLinks), [],
    'the reference shared-links export satisfies the contract');
  assert.deepStrictEqual(
    V.missingCsvColumns(
      'S.No,File/Folder Name,Source Path,Source shared link,Destination Path,Destination shared link',
      req.sharedLinks), [],
    '"S.No" instead of "No" must not fail a correct report');
  assert.deepStrictEqual(
    V.missingCsvColumns(
      'Sl.No,Original File Name,Original File Path,Link File Name,Link Text Name,'
      + 'Linked File Path,Source url,Destination url,Destination Path',
      req.embeddedLinks), [],
    'the reference embedded-links export satisfies the contract');

  // A report that lost a column is caught, and named.
  assert.deepStrictEqual(
    V.missingCsvColumns('S.No,File/Folder Name,Source Path', req.sharedLinks),
    ['destination path', 'destination shared link'],
    'the missing columns are named, not just counted');

  // And the checklist fails on it rather than passing on the row count.
  const rows = byId(computeContentFunctionalityChecklist(healthy({
    csvReports: { sharedLinks: { name: 'x shared links.csv', rows: 3277, missingColumns: ['destination shared link'] } },
  })));
  assert.strictEqual(rows['5.16'].status, 'fail',
    'a report full of rows but missing a column is not a pass');
  console.log('  CSV column contract enforced against the reference exports: ok');
}

/**
 * The two CSV reports ARE checkable, and used to claim otherwise.
 *
 * Both rows read "no API for the CSV". There is no special API — CloudFuze writes the reports as
 * ordinary files into the destination library root, where they read like any other file (found live:
 * a shared-links report with 3,183 rows, and an embedded-links report at 0 bytes). A feature marked
 * un-testable never gets tested, so the wrong label costs real coverage.
 */
function testCsvReportsAreMeasured() {
  // Report present with rows -> a real pass.
  const ok = byId(computeContentFunctionalityChecklist(healthy({
    csvReports: {
      sharedLinks: { name: 'Erik E shared links.csv', rows: 3183 },
      embeddedLinks: { name: 'Erik E-EmbeddedLinks.csv', rows: 4 },
    },
  })));
  assert.strictEqual(ok['5.16'].status, 'pass', 'a populated shared-links report passes');
  assert.ok(/3183/.test(ok['5.16'].detail), 'the row count is stated as evidence');
  assert.strictEqual(ok['6.2'].status, 'pass', 'a populated embedded-links report passes');

  // Generated but EMPTY: the shared-links report failing is the point — the customer gets nothing.
  const empty = byId(computeContentFunctionalityChecklist(healthy({
    csvReports: {
      sharedLinks: { name: 'Erik E shared links.csv', rows: 0 },
      embeddedLinks: { name: 'Erik E-EmbeddedLinks.csv', rows: 0 },
    },
  })));
  assert.strictEqual(empty['5.16'].status, 'fail',
    'a shared-links report with no rows is a failure, not a pass');
  // An empty embedded-links report is only wrong when a document actually held a link, which this
  // row cannot know on its own — so it reports rather than fails.
  assert.strictEqual(empty['6.2'].status, 'info',
    'an empty embedded-links report is reported, not failed');

  // Absent altogether: never a pass.
  const missing = byId(computeContentFunctionalityChecklist(healthy()));
  assert.strictEqual(missing['5.16'].status, 'na', 'no report found means nothing was proven');
  assert.strictEqual(missing['6.2'].status, 'na', 'no report found means nothing was proven');
  console.log('  CSV reports measured, empty report not a pass: ok');
}

function testStructureAndNotificationFailures() {
  const broken = byId(computeContentFunctionalityChecklist(healthy({
    missing: [{ path: '/A/gone.pdf' }],
  })));
  assert.strictEqual(broken['3.1'].status, 'fail');
  assert.strictEqual(broken['1.1'].status, 'fail');

  const leaked = byId(computeContentFunctionalityChecklist(healthy({
    notificationLeaks: ['"X shared a file with you" from no-reply@sharepointonline.com'],
  })));
  assert.strictEqual(leaked['9.1'].status, 'fail');
  assert.strictEqual(leaked['9.2'].status, 'fail');

  const renamed = byId(computeContentFunctionalityChecklist(healthy({
    specialChars: { total: 4, arrived: 2 },
  })));
  assert.strictEqual(renamed['7.1'].status, 'fail');

  // Timestamp drift is reported, not failed — it depends on destination library settings
  const drift = byId(computeContentFunctionalityChecklist(healthy({
    timestampDrift: ['/a.pdf: modified 10:00 → 12:30'],
  })));
  assert.strictEqual(drift['10.1'].status, 'info');
  assert.notStrictEqual(drift['10.1'].status, 'pass', 'but it is not a clean pass either');

  const placeholders = byId(computeContentFunctionalityChecklist(healthy({
    placeholderLinks: [{ path: '/very/long', encodedLength: 460 }],
  })));
  assert.strictEqual(placeholders['11.1'].status, 'pass', 'documented placeholder handling is correct behaviour');
}

/**
 * Coverage reporting, drawn from the dimensions the manual QA suite treats as first-class:
 * group vs user principals, and item scope. A green checklist must not hide an untested axis.
 */
function testCoverageReporting() {
  // Users only — groups are the majority of the QA suite's cases, so their absence is called out
  const usersOnly = computeContentFunctionalityChecklist(healthy({
    permissionObservations: [
      { itemType: 'folder', role: 'reader', match: true, path: '/A', principalType: 'user', scope: 'rootFolder' },
    ],
  }));
  const s1 = summarize(usersOnly);
  assert.strictEqual(s1.coverage.principals.group, 0);
  assert.ok(s1.coverageGaps.some((g) => /GROUP/.test(g)), 'an untested group dimension is surfaced');
  assert.ok(/Coverage gaps/.test(s1.line), 'and it reaches the summary line');

  // With both principals and several scopes, the gap disappears and the detail names them
  const both = computeContentFunctionalityChecklist(healthy({
    permissionObservations: [
      { itemType: 'folder', role: 'reader', match: true, path: '/A', principalType: 'user', scope: 'rootFolder' },
      { itemType: 'folder', role: 'reader', match: true, path: '/A/B', principalType: 'group', scope: 'subFolder' },
      { itemType: 'file', role: 'reader', match: true, path: '/a.txt', principalType: 'user', scope: 'rootFile' },
      { itemType: 'file', role: 'reader', match: true, path: '/A/b.txt', principalType: 'group', scope: 'innerFile' },
    ],
  }));
  const s2 = summarize(both);
  assert.strictEqual(s2.coverage.principals.group, 2);
  assert.deepStrictEqual(s2.coverage.untestedScopes, [], 'all four scopes were exercised');
  assert.ok(!s2.coverageGaps.some((g) => /GROUP/.test(g)));

  const rows = byId(both);
  assert.ok(/groups/.test(rows['4.2'].detail), 'the feature row names the principals covered');
  assert.ok(/root folder|sub folder/.test(rows['4.2'].detail), 'and the scopes covered');

  // Access resolved through group membership is reported, not hidden
  const viaGroup = computeContentFunctionalityChecklist(healthy({
    permissionObservations: [
      { itemType: 'folder', role: 'reader', match: true, path: '/A', principalType: 'user', scope: 'rootFolder', viaGroup: true },
    ],
  }));
  assert.strictEqual(summarize(viaGroup).coverage.principals.viaGroupMembership, 1);
  assert.ok(/via group membership/.test(byId(viaGroup)['4.2'].detail));
}

function testSummary() {
  const list = computeContentFunctionalityChecklist(healthy({
    permissionObservations: [{ itemType: 'folder', role: 'reader', match: true, path: '/A' }],
  }));
  const s = summarize(list);
  assert.strictEqual(s.total, 38);
  assert.strictEqual(s.pass + s.fail + s.na + s.info, 38, 'every feature has exactly one state');
  assert.ok(/Features: \d+ pass/.test(s.line));
}

function run() {
  testFeatureListShape();
  testNothingValidatedIsNeverPass();
  testUnexercisedFeaturesAreNa();
  testPermissionRows();
  testLinkRows();
  testVersionsNeverFailOnCount();
  testDeltaAwareness();
  testSwitchedOffTiers();
  testUnautomatedFeaturesCarryManualSteps();
testCsvReportsAreMeasured();
testCsvColumnContract();
  testStructureAndNotificationFailures();
  testCoverageReporting();
  testSummary();
  console.log('contentFunctionalityChecklist.test.js: ok');
}

run();
