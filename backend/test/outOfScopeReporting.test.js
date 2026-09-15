/**
 * Run: npm test  (from backend/)
 *
 * Two defects found in execution 38304680, both of which made a run LOOK clean while testing less
 * than it claimed. Neither announced itself: one produced a missing section, the other a check that
 * examined nothing and still reported a verdict.
 *
 *   1. The out-of-scope rollup was computed by the validator and never drawn by the report, so a
 *      run that seeded out-of-scope controls and judged them correctly showed the reader nothing.
 *      The report read as though out-of-scope had never been tested.
 *
 *   2. The permission budget took the first 60 pairs in tree-traversal order. That order began with
 *      a 21-level folder chain carrying no grants, so the budget was spent before the walk reached
 *      the permission ladder — "0 permission grant(s) compared", and the one confirmed defect in
 *      this combination (feature 2.3) disappeared from the report with nothing having been fixed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ValidationAgent = require('../src/validation/combinations/content/sharefileToSharepoint');
const { generateContentValidationPdf } = require('../src/utils/pdfGenerator');

/** A pair as the tree walk produces it: source/dest nodes carrying a path and a type. */
function pair(p, type) {
  return { source: { path: p, type, id: `src${p}` }, dest: { path: p, type, id: `dst${p}` } };
}

function testLadderIsNotStarvedByADeepChain() {
  const select = ValidationAgent.selectPermissionTargets;

  // The shape that actually starved the check: one long chain of folders (the real run had 21 levels plus the format and large-file folders; 35 here), each with a file, plus
  // the permission ladder sitting at depth 2-3 further along the traversal.
  const pairs = [];
  let chain = '';
  for (let i = 1; i <= 35; i++) {
    chain += `/seg-${String(i).padStart(2, '0')}`;
    pairs.push(pair(`/05-Long-Paths/deep-by-count${chain}`, 'folder'));
    pairs.push(pair(`/05-Long-Paths/deep-by-count${chain}/folder-content.txt`, 'file'));
  }
  for (const who of ['user', 'group']) {
    for (let n = 1; n <= 5; n++) {
      pairs.push(pair(`/09-Permissions/ladder-root/${who}-${n}`, 'folder'));
      pairs.push(pair(`/09-Permissions/ladder-sub/nested/${who}-${n}`, 'folder'));
    }
  }

  const chosen = select(pairs, 60).map((x) => x.source.path);

  const ladder = chosen.filter((p) => p.startsWith('/09-Permissions/'));
  assert.strictEqual(ladder.length, 20,
    'every permission-ladder folder must fit in the budget — the ladder is the only place in the '
    + `tree carrying seeded grants, and only ${ladder.length} of 20 were selected`);

  // Files may fill whatever the folders leave, but never ahead of a folder: folder permissions are
  // in scope for this combination and file-level permissions are documented out of scope.
  const firstFile = chosen.findIndex((p) => p.endsWith('.txt'));
  const lastFolder = chosen.map((p) => !p.endsWith('.txt')).lastIndexOf(true);
  assert.ok(firstFile === -1 || firstFile > lastFolder,
    `a file was selected ahead of a folder (file at ${firstFile}, last folder at ${lastFolder})`);

  // And the ordering must be stable, or two runs cannot be compared to each other.
  assert.deepStrictEqual(select(pairs, 60).map((x) => x.source.path), chosen,
    'selection must be deterministic');
  console.log('  permission budget reaches the ladder, folders first: ok');
}

function testTraversalOrderWouldHaveStarvedIt() {
  // Guards the guard: if this fixture ever stops reproducing the original failure, the test above
  // proves nothing. A plain slice of the same input must still miss the ladder entirely.
  const select = ValidationAgent.selectPermissionTargets;
  const pairs = [];
  let chain = '';
  for (let i = 1; i <= 35; i++) {
    chain += `/seg-${String(i).padStart(2, '0')}`;
    pairs.push(pair(`/05-Long-Paths/deep-by-count${chain}`, 'folder'));
    pairs.push(pair(`/05-Long-Paths/deep-by-count${chain}/folder-content.txt`, 'file'));
  }
  pairs.push(pair('/09-Permissions/ladder-root/user-1', 'folder'));

  const naive = pairs.slice(0, 60).filter((x) => x.source.path.startsWith('/09-Permissions/'));
  assert.strictEqual(naive.length, 0, 'fixture must still reproduce the starvation it pins');
  assert.ok(select(pairs, 60).some((x) => x.source.path.startsWith('/09-Permissions/')),
    'the fixed selection must reach what the naive one missed');
  console.log('  fixture still reproduces the original starvation: ok');
}

/** Render a content report to a temp file and return its byte length. */
function renderSize(validationSummary) {
  const out = path.join(os.tmpdir(), `qa-oos-${Math.random().toString(36).slice(2)}.pdf`);
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(out);
    stream.on('finish', () => {
      const size = fs.statSync(out).size;
      fs.unlinkSync(out);
      resolve(size);
    });
    stream.on('error', reject);
    generateContentValidationPdf({
      executionId: 'test', context: { sourceProvider: 'sharefile', destinationProvider: 'sharepoint' },
      result: { validationSummary },
    }, stream);
  });
}

async function testOutOfScopeRowsReachTheReport() {
  const checks = [{ name: 'ShareFile source reachable', status: 'PASS', detail: 'ok' }];
  const featureChecklist = [
    { id: '1.1', category: 'Files', feature: 'File migration', status: 'pass', detail: 'ok' },
  ];
  const outOfScopeChecklist = ValidationAgent.SHAREFILE_OUT_OF_SCOPE_FEATURES.map((f) => ({
    ...f, status: 'pass', detail: 'did not migrate, as documented',
  }));

  const without = await renderSize({ status: 'PASS', checks, featureChecklist });
  const with_ = await renderSize({
    status: 'PASS', checks, featureChecklist,
    outOfScopeChecklist,
    outOfScopeSummary: 'Out of scope: 7 stayed out, 0 MIGRATED (defect), 0 not exercised (of 7)',
  });

  assert.ok(with_ > without,
    'the report must grow when the validator supplies an out-of-scope rollup — it produced this '
    + `list for several releases while nothing drew it (${without} bytes vs ${with_} bytes)`);
  console.log(`  out-of-scope rollup is drawn (${without} → ${with_} bytes): ok`);
}

(async () => {
  testLadderIsNotStarvedByADeepChain();
  testTraversalOrderWouldHaveStarvedIt();
  await testOutOfScopeRowsReachTheReport();
  console.log('outOfScopeReporting.test.js: ok');
})().catch((err) => { console.error(err); process.exit(1); });

/**
 * The run summary must not contradict the checks beneath it.
 *
 * It carried a hardcoded "Permissions (features 2.1-2.4) are NOT assessed on this combination — no
 * documented role mapping", written before a role map existed. The first run that reached the
 * permission ladder printed that sentence directly beside a FAIL naming ten dropped group grants,
 * telling the reader to disregard the only real finding in the report.
 */
function testSummaryAgreesWithThePermissionChecks() {
  const build = require('../src/validation/combinations/content/sharefileToSharepoint').buildResultForTest;

  const failed = build([
    { name: '2. Permissions — user grants (features 2.1, 2.2, 2.4)', status: 'PASS', detail: 'ok' },
    { name: '2. Permissions — group grants (feature 2.3)', status: 'FAIL', detail: '10 dropped' },
  ], null).summary;
  // Scoped to the PERMISSION sentence: the feature rollup legitimately contains "not assessed
  // (of 11)" for features this run could not exercise, and a loose match would hit that instead.
  assert.ok(!/Permissions \(features 2\.1-2\.4\) were NOT assessed/.test(failed),
    `the summary must not say permissions were not assessed when they were: "${failed}"`);
  assert.ok(/assessed and 1 FAILED/.test(failed) && /group grants/.test(failed),
    `the summary must name the failing permission check: "${failed}"`);

  const notRun = build([
    { name: '2. Permissions (root folder, sub-folder, group, external)', status: 'WARN',
      detail: 'Not assessed — none comparable' },
  ], null).summary;
  assert.ok(/NOT assessed in this run/.test(notRun),
    `a run that could not judge permissions must still say so: "${notRun}"`);

  const allPass = build([
    { name: '2. Permissions — user grants (features 2.1, 2.2, 2.4)', status: 'PASS', detail: 'ok' },
    { name: '2. Permissions — group grants (feature 2.3)', status: 'PASS', detail: 'ok' },
  ], null).summary;
  assert.ok(/assessed: 2 check\(s\), all passed/.test(allPass),
    `a clean permission run must be stated as such: "${allPass}"`);
  console.log('  run summary agrees with the permission checks: ok');
}

testSummaryAgreesWithThePermissionChecks();

/**
 * PASS and FAIL mean OPPOSITE things in the two halves of a content report.
 *
 * In scope, FAIL means the feature did not arrive. Out of scope, FAIL means it DID — the product
 * doing more than the document describes. Printing the same two words in both tables is how a
 * reader comes to believe a green "PASS" beside "Shared Links" means shared links migrated.
 *
 * Out-of-scope rows must therefore print what happened, not a verdict word borrowed from the other
 * table. Asserted against the renderer's own vocabulary so the two cannot drift apart.
 */
function testOutOfScopeNeverPrintsPassOrFail() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'pdfGenerator.js'), 'utf8');

  const m = src.match(/function outOfScopeTagText\(status\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'the out-of-scope label vocabulary must live in one named function, or the checks '
    + 'table and the rollup will drift apart');

  // Evaluate the real function rather than a copy of it.
  // eslint-disable-next-line no-new-func
  const tagText = new Function(`${m[0]}; return outOfScopeTagText;`)();

  // FAIL carries ONE meaning across the whole report: it did not reach the destination. For an
  // out-of-scope feature that is expected, which the row's own detail says under "Expected:" — the
  // tag states the fact, the detail states whether the fact is a defect.
  assert.strictEqual(tagText('FAIL'), 'NOT MIGRATED');
  assert.strictEqual(tagText('PASS'), 'MIGRATED');
  for (const status of ['PASS', 'FAIL']) {
    assert.ok(!/^(PASS|FAIL)$/.test(tagText(status)),
      `out-of-scope rows must state what happened, not reprint "${status}"`);
  }

  // Both renderers must go through it: the checks table and the rollup.
  const uses = (src.match(/outOfScopeTagText\(/g) || []).length;
  assert.ok(uses >= 3,
    `every out-of-scope label must come from the shared function (found ${uses} call sites; the `
    + 'checks table and both rollup states need it)');
  console.log('  out-of-scope rows print NOT MIGRATED / MIGRATED, never PASS / FAIL: ok');
}

testOutOfScopeNeverPrintsPassOrFail();

/**
 * Every feature gets ONE row carrying ONE verdict — never a verdict plus INFO commentary.
 *
 * Embedded Links used to push four rows: three INFO carrying context, then the verdict. A reader
 * scanning the report saw "INFO" three times beside "Embedded Links" and could not tell whether the
 * links had migrated. The reference combination in this repo (dropboxToSharepoint, feature 9.1)
 * emits exactly one row and never emits INFO at all.
 *
 * The context is not dropped — it belongs inside the verdict's detail, after "Why:", which is where
 * a reader goes when they want to know what happened. One row cannot explain another row.
 */
function testEveryRowCarriesAVerdict() {
  const dir = path.join(__dirname, '..', 'src', 'validation', 'combinations', 'content');
  const ours = fs.readFileSync(path.join(dir, 'sharefileToSharepoint.js'), 'utf8');
  const reference = fs.readFileSync(path.join(dir, 'dropboxToSharepoint.js'), 'utf8');

  const countInfo = (src) => (src.match(/push\(\s*'INFO'/g) || []).length;

  assert.strictEqual(countInfo(reference), 0,
    'the reference combination emits no INFO rows — if that changed, this rule needs rethinking '
    + 'rather than silently enforcing');
  assert.strictEqual(countInfo(ours), 0,
    'a row with no verdict tells the reader nothing about whether the feature worked; fold the '
    + 'context into the verdict row\'s detail under "Why:" instead');

  // And the verdict a reader sees must state the outcome, not just a status colour.
  assert.ok(/NOT MIGRATED/.test(ours) && /MIGRATED — and it should not have/.test(ours),
    'the embedded-links verdict must say in words what happened, since a status alone is '
    + 'ambiguous for an out-of-scope feature');
  assert.ok(/Why: \$\{why\.join/.test(ours),
    'the evidence that used to sit in the INFO rows must still reach the report, inside the verdict');
  console.log('  one row, one verdict, reason inline — matches the reference combination: ok');
}

testEveryRowCarriesAVerdict();
