/**
 * Run: npm test  (from backend/)
 *
 * Feature 4.1 of `dropbox-to-google-inscope.md` is "maintaining the original timestamps, INCLUDING
 * CREATION and modification dates and times". Only the modified half was ever compared, on the
 * grounds recorded in dropboxClient.toItem: "Dropbox exposes no creation time for files".
 *
 * That reason was wrong, and this file pins the correction:
 *
 *   - `files/get_metadata` genuinely has no creation field, but `files/list_revisions` returns the
 *     retained history newest-first, and the OLDEST entry's `server_modified` is the first upload
 *     Dropbox recorded for the file. So a source creation time IS derivable.
 *   - The endpoint caps `limit` at 100 and has NO cursor, so a list coming back AT the limit may
 *     be missing older revisions. Its oldest entry is then a LOWER BOUND on the creation time, not
 *     the creation time — and a lower bound must never be compared as if it were an equality.
 *   - CloudFuze was being sent `createdTimeForFiles=false`, hardcoded. A created-date difference on
 *     such a job is the expected outcome, so it is reported at INFO: neither failed (the job never
 *     asked for preservation) nor passed (nothing was preserved).
 *
 * Every assertion below is a pure function. No network, no Dropbox account, no Drive account.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dropboxClient = require('../src/clients/dropboxClient');
const ValidationAgent = require('../src/validation/combinations/content/dropboxToGoogledrive');

const {
  judgeCreatedTimestamps,
  createdTimeRow,
  createdTimeRequested,
  modifiedTimeRequested,
} = ValidationAgent;
const { createdTimeFromRevisions, REVISION_LIST_LIMIT } = dropboxClient;

// ── Fixtures ────────────────────────────────────────────────────────────────────────
//
// Shaped exactly like dropboxClient.listRevisions output: `{ rev, size, modifiedAt }`, newest
// first, `modifiedAt` being the revision's server_modified.

const SEEDED_CREATED = '2026-09-01T10:15:00Z';
const SEEDED_MODIFIED = '2026-09-01T11:42:00Z';

/** A seeded file uploaded three times: creation is the OLDEST of the three. */
const THREE_REVISIONS = [
  { rev: '0193c3', size: 512, modifiedAt: SEEDED_MODIFIED },
  { rev: '0193c2', size: 400, modifiedAt: '2026-09-01T10:50:00Z' },
  { rev: '0193c1', size: 128, modifiedAt: SEEDED_CREATED },
];

/** A file whose history fills the listing maximum — older revisions are unreachable. */
const AT_THE_LIMIT = Array.from({ length: REVISION_LIST_LIMIT }, (_, i) => ({
  rev: `f${i}`,
  size: 100 + i,
  // Newest first: index 0 is the most recent, the last entry the oldest returned.
  modifiedAt: new Date(Date.parse('2026-09-01T12:00:00Z') - i * 60000).toISOString(),
}));

const destItem = (createdAt) => ({ id: 'drv1', name: 'document.txt', createdAt });
const srcItem = (p = '/06-Metadata/document.txt') => ({ path: p, name: 'document.txt' });
const FIVE_MIN = 5 * 60 * 1000;

const byName = (rows, re) => rows.find((r) => re.test(r.name));

// ── The derivation: what the revision list can and cannot establish ─────────────────

function testOldestRevisionIsTheCreationTime() {
  const got = createdTimeFromRevisions(THREE_REVISIONS, { limit: REVISION_LIST_LIMIT });
  assert.strictEqual(got.createdAt, SEEDED_CREATED,
    'the oldest revision server_modified is the creation time');
  assert.strictEqual(got.exact, true, 'a list shorter than the limit is complete');
  assert.strictEqual(got.truncated, false);
  assert.strictEqual(got.revisionCount, 3);
  console.log('  oldest revision is the creation time: ok');
}

function testOrderIsNotTrusted() {
  // Reversed and shuffled input must produce the same answer: the endpoint documents newest-first,
  // but reading the last element would hand a wrong answer to any caller that had sorted the list.
  const shuffled = [THREE_REVISIONS[2], THREE_REVISIONS[0], THREE_REVISIONS[1]];
  assert.strictEqual(createdTimeFromRevisions(shuffled).createdAt, SEEDED_CREATED,
    'the earliest timestamp is taken, not the last array element');
  console.log('  earliest timestamp wins regardless of array order: ok');
}

function testTruncatedListIsOnlyALowerBound() {
  const got = createdTimeFromRevisions(AT_THE_LIMIT, { limit: REVISION_LIST_LIMIT });
  assert.strictEqual(got.revisionCount, REVISION_LIST_LIMIT);
  assert.strictEqual(got.truncated, true, 'a full page means older revisions may exist');
  assert.strictEqual(got.exact, false, 'a lower bound is not an exact creation time');
  assert.ok(/LOWER BOUND/.test(got.reason), 'the reason says so in words');
  console.log('  a list at the listing maximum is a lower bound, not the creation time: ok');
}

function testNoRevisionsIsNotACreationTime() {
  for (const empty of [[], null, undefined]) {
    const got = createdTimeFromRevisions(empty);
    assert.strictEqual(got.createdAt, null);
    assert.strictEqual(got.exact, false);
    assert.ok(got.reason, 'an unknown always carries its reason');
  }
  const unreadable = createdTimeFromRevisions([{ rev: 'a', size: 1, modifiedAt: null }]);
  assert.strictEqual(unreadable.createdAt, null, 'a revision with no timestamp is not a date');
  console.log('  a failed or empty revision read is an unknown, never a date: ok');
}

// ── What the job asked for ──────────────────────────────────────────────────────────

function testJobOptionMirrors() {
  // Created defaults to FALSE, mirroring migrationClient's opt('preserveCreatedTime', false).
  assert.strictEqual(createdTimeRequested(undefined), false);
  assert.strictEqual(createdTimeRequested({}), false);
  assert.strictEqual(createdTimeRequested({ contentOptions: {} }), false);
  assert.strictEqual(createdTimeRequested({ contentOptions: { preserveCreatedTime: true } }), true);
  // Modified defaults to TRUE, mirroring opt('preserveTimestamp').
  assert.strictEqual(modifiedTimeRequested({}), true);
  assert.strictEqual(modifiedTimeRequested({ contentOptions: {} }), true);
  const noModified = { contentOptions: { preserveTimestamp: false } };
  assert.strictEqual(modifiedTimeRequested(noModified), false);
  console.log('  option mirrors match migrationClient defaults (created false, modified true): ok');
}

// ── One file's comparison ───────────────────────────────────────────────────────────

function testRowComparesWithinTheBand() {
  const inBand = createdTimeRow(srcItem(), destItem('2026-09-01T10:16:30Z'), THREE_REVISIONS,
    { driftMs: FIVE_MIN, revisionLimit: REVISION_LIST_LIMIT });
  assert.strictEqual(inBand.comparable, true);
  assert.strictEqual(inBand.drifted, false, '90s inside a 5 minute band is preserved');

  const outOfBand = createdTimeRow(srcItem(), destItem('2026-09-04T09:00:00Z'), THREE_REVISIONS,
    { driftMs: FIVE_MIN, revisionLimit: REVISION_LIST_LIMIT });
  assert.strictEqual(outOfBand.comparable, true);
  assert.strictEqual(outOfBand.drifted, true, 'three days is drift');
  assert.strictEqual(outOfBand.source, SEEDED_CREATED);
  assert.strictEqual(outOfBand.dest, '2026-09-04T09:00:00Z');
  console.log('  one file: banded created comparison: ok');
}

function testRowRefusesToCompareWhatItCannotEstablish() {
  const oldestReturned = AT_THE_LIMIT[AT_THE_LIMIT.length - 1].modifiedAt;
  const truncated = createdTimeRow(srcItem(), destItem(oldestReturned), AT_THE_LIMIT,
    { driftMs: FIVE_MIN, revisionLimit: REVISION_LIST_LIMIT });
  assert.strictEqual(truncated.comparable, false,
    'even when the lower bound happens to equal the destination, it is not an equality claim');
  assert.strictEqual(truncated.truncated, true);

  const noRevisions = createdTimeRow(srcItem(), destItem(SEEDED_CREATED), [],
    { driftMs: FIVE_MIN });
  assert.strictEqual(noRevisions.comparable, false);

  const noDestCreated = createdTimeRow(srcItem(), destItem(null), THREE_REVISIONS,
    { driftMs: FIVE_MIN });
  assert.strictEqual(noDestCreated.comparable, false);
  assert.ok(/destination/.test(noDestCreated.reason));
  console.log('  one file: an unestablishable created time is not compared: ok');
}

// ── The verdict ─────────────────────────────────────────────────────────────────────

const matchRow = (p) => ({
  path: p, source: SEEDED_CREATED, dest: '2026-09-01T10:15:20Z',
  comparable: true, drifted: false, truncated: false, revisionCount: 3,
});
const driftRow = (p) => ({
  path: p, source: SEEDED_CREATED, dest: '2026-09-08T14:02:11Z',
  comparable: true, drifted: true, truncated: false, revisionCount: 3,
});
const unknownRow = (p, truncated = false) => ({
  path: p, source: truncated ? '2026-09-01T10:19:00Z' : null, dest: '2026-09-08T14:02:11Z',
  comparable: false, drifted: null, truncated, revisionCount: truncated ? REVISION_LIST_LIMIT : 0,
  reason: truncated ? 'the revision list came back at the 100-entry maximum — LOWER BOUND'
    : 'files/list_revisions returned no revisions',
});

function testRequestedAndMatchingPasses() {
  const v = judgeCreatedTimestamps([matchRow('/a.txt'), matchRow('/b.txt')],
    { createdTimeRequested: true, driftMs: FIVE_MIN });
  assert.strictEqual(v.status, 'PASS');
  assert.ok(/COMPLETE Dropbox revision list/.test(v.detail),
    'the pass states what makes it an equality claim');
  console.log('  requested + matching: PASS — ok');
}

function testRequestedAndDifferingFails() {
  const v = judgeCreatedTimestamps([matchRow('/a.txt'), driftRow('/06-Metadata/document.txt')],
    { createdTimeRequested: true, driftMs: FIVE_MIN });
  assert.strictEqual(v.status, 'FAIL');
  assert.ok(/document\.txt/.test(v.detail), 'the failing file is named');
  assert.ok(v.detail.includes(SEEDED_CREATED), 'the source timestamp is printed');
  assert.ok(v.detail.includes('2026-09-08T14:02:11Z'), 'the destination timestamp is printed');
  console.log('  requested + differing: FAIL naming files and both timestamps — ok');
}

function testNotRequestedIsInfoAndNeverAPass() {
  // Today's default. A difference here is the expected outcome, so it must not fail; nothing was
  // preserved, so it must not pass either.
  const v = judgeCreatedTimestamps([driftRow('/a.txt'), driftRow('/b.txt')],
    { createdTimeRequested: false, driftMs: FIVE_MIN });
  assert.strictEqual(v.status, 'INFO');
  assert.notStrictEqual(v.status, 'PASS');
  assert.notStrictEqual(v.status, 'FAIL');
  assert.ok(/NOT requested/.test(v.detail), 'the reason is stated plainly');
  assert.ok(/preserveCreatedTime/.test(v.detail), 'the option to set is named');

  // Matching dates on a job that never asked for preservation are still not a pass — a coincidence
  // is not a preserved timestamp.
  const coincidence = judgeCreatedTimestamps([matchRow('/a.txt')], { createdTimeRequested: false });
  assert.strictEqual(coincidence.status, 'INFO');
  console.log('  not requested: INFO, never PASS and never FAIL — ok');
}

function testUnobtainableWarns() {
  const none = judgeCreatedTimestamps([unknownRow('/a.txt'), unknownRow('/b.txt')],
    { createdTimeRequested: true, driftMs: FIVE_MIN });
  assert.strictEqual(none.status, 'WARN');
  assert.ok(/could not determine|NOT "matches"/i.test(none.detail),
    '"could not determine" and "matches" are not the same statement');

  const truncatedOnly = judgeCreatedTimestamps([unknownRow('/big.txt', true)],
    { createdTimeRequested: true, driftMs: FIVE_MIN });
  assert.strictEqual(truncatedOnly.status, 'WARN');
  assert.ok(/lower bound/i.test(truncatedOnly.detail), 'the truncation is named as the cause');

  const partial = judgeCreatedTimestamps([matchRow('/a.txt'), unknownRow('/b.txt')],
    { createdTimeRequested: true, driftMs: FIVE_MIN });
  assert.strictEqual(partial.status, 'WARN', 'a partial result is not a clean pass');

  const nothingAtAll = judgeCreatedTimestamps([], { createdTimeRequested: true });
  assert.strictEqual(nothingAtAll.status, 'WARN');
  console.log('  unobtainable / truncated / partial source created time: WARN — ok');
}

function testDriftStillFailsEvenWithUnknownsPresent() {
  const v = judgeCreatedTimestamps([driftRow('/a.txt'), unknownRow('/b.txt', true)],
    { createdTimeRequested: true, driftMs: FIVE_MIN });
  assert.strictEqual(v.status, 'FAIL', 'a real mismatch outranks an unknown');
  assert.ok(/NOT counted either way/.test(v.detail), 'the unknown is still reported, not hidden');
  console.log('  a mismatch outranks an unknown, and the unknown is still reported: ok');
}

// ── The 4.1 roll-up: the modified verdict must not move ─────────────────────────────

/** The two 4.1 checks produced by the roll-up for a given set of totals. */
function rollUp({ drift = [], createdInfo = [], created = false, modified = true, files = 37 }) {
  const agent = new ValidationAgent();
  const totals = agent._emptyTotals({ destinationProvider: 'googledrive' });
  totals.timestampDrift = drift;
  totals.createdInfo = createdInfo;
  totals.createdTimeRequested = created;
  totals.modifiedTimeRequested = modified;
  const itemDetails = Array.from({ length: files }, (_, i) => ({
    path: `/f${i}.txt`, type: 'file', found: true, timestamps: { comparable: true, match: true },
  }));
  const checks = [];
  agent._rollUpItemChecks((status, name, detail) => checks.push({ status, name, detail }),
    totals, itemDetails);
  return checks;
}

function testModifiedVerdictUnchanged() {
  // The live run's shape: 37 files compared, no modified drift, created preservation not requested.
  const checks = rollUp({ createdInfo: [matchRow('/a.txt')] });
  const modifiedCheck = byName(checks, /^4\.1 Metadata$/);
  assert.ok(modifiedCheck, 'the modified check keeps its exact name');
  assert.strictEqual(modifiedCheck.status, 'PASS', '37 files, no drift — still a PASS');
  assert.ok(/37 file\(s\)/.test(modifiedCheck.detail), 'it still reports the count it compared');
  assert.ok(!/Dropbox exposes no creation time/.test(modifiedCheck.detail),
    'and no longer repeats the claim that Dropbox has no creation time');

  const createdCheck = byName(checks, /^4\.1 Metadata \(created dates\)$/);
  assert.strictEqual(createdCheck.status, 'INFO', 'created half is INFO by default');

  // No files at all is still the WARN it was, not a pass.
  const noFiles = rollUp({ files: 0 });
  assert.strictEqual(byName(noFiles, /^4\.1 Metadata$/).status, 'WARN');
  assert.strictEqual(byName(noFiles, /created dates/), undefined,
    'with nothing compared there is no created verdict to claim either');
  console.log('  modified-date verdict unchanged (PASS on 37 files, WARN on none): ok');
}

function testModifiedDriftNowReachable() {
  // compareTimestamps has NEVER returned a `drifted` field — the per-item code read exactly that,
  // so totals.timestampDrift could never fill and this FAIL branch was dead. Pinned here so the
  // wrong field name cannot come back unnoticed.
  const core = require('../src/validation/shared/deepContentCore');
  const cmp = core.compareTimestamps(
    { createdAt: null, modifiedAt: '2026-09-01T11:42:00Z' },
    { createdAt: null, modifiedAt: '2026-09-08T11:42:00Z' },
    FIVE_MIN
  );
  assert.strictEqual(cmp.drifted, undefined, 'there is no `drifted` field to read');
  assert.strictEqual(cmp.modifiedOff, true, '`modifiedOff` is the field that carries the answer');

  const failed = rollUp({
    drift: [{ path: '/a.txt', source: '2026-09-01T11:42:00Z', dest: '2026-09-08T11:42:00Z' }],
  });
  // The verdict CHANGED from FAIL to WARN, deliberately. googledriveToSharepoint.js reports the
  // identical situation as a WARN, and two content validators cannot disagree about whether the
  // same observation is a defect. What this test exists to pin is that the drift is REACHABLE at
  // all — the old per-item code read a `drifted` field compareTimestamps never returns, so the
  // branch was dead and 4.1 reported "preserved" whatever the data said. That, and the fact that
  // drift is never swallowed into a PASS, are what is asserted.
  const driftCheck = byName(failed, /^4\.1 Metadata$/);
  assert.strictEqual(driftCheck.status, 'WARN',
    'measured modified drift reaches the report — as a WARN, matching '
    + 'googledriveToSharepoint.js on the identical situation');
  assert.notStrictEqual(driftCheck.status, 'PASS', 'and it is never swallowed into a pass');
  assert.ok(/googledriveToSharepoint\.js/.test(driftCheck.detail),
    'the note says which validator it was aligned with');
  assert.ok(/file_viewer\.txt/.test(driftCheck.detail),
    'and quotes the measured case from run 54f9bfc2');
  assert.ok(/HYPOTHESIS/.test(driftCheck.detail),
    'the permission-write mechanism is stated as a hypothesis, not a conclusion');

  // …unless the job switched modified preservation off, which is the mirror of the created rule.
  const notAsked = rollUp({
    drift: [{ path: '/a.txt', source: '2026-09-01T11:42:00Z', dest: '2026-09-08T11:42:00Z' }],
    modified: false,
  });
  assert.strictEqual(byName(notAsked, /^4\.1 Metadata$/).status, 'INFO',
    'drift on a job that did not request preservation is the expected outcome');
  console.log('  modified drift is detectable, WARN not FAIL, and not judged when never '
    + 'requested: ok');
}

function testChecklistStillKeysOnFeature41() {
  const agent = new ValidationAgent();
  const totals = { enabled: true, scannedSourceItems: 40, migrationType: 'FULL', paperItems: [] };
  const failed = agent._buildChecklist(totals, [
    { name: '[Dest] 4.1 Metadata', status: 'PASS', detail: 'Modified timestamps preserved' },
    { name: '[Dest] 4.1 Metadata (created dates)', status: 'FAIL', detail: 'created dates differ' },
  ]);
  assert.strictEqual(failed.find((f) => f.id === '4.1').status, 'fail',
    'a created-date failure cannot be masked by the modified half passing');

  const info = agent._buildChecklist(totals, [
    { name: '[Dest] 4.1 Metadata', status: 'PASS', detail: 'Modified timestamps preserved' },
    { name: '[Dest] 4.1 Metadata (created dates)', status: 'INFO', detail: 'NOT requested' },
  ]);
  const row = info.find((f) => f.id === '4.1');
  assert.strictEqual(row.status, 'pass', 'the modified half still carries the feature');
  assert.ok(/NOT requested/.test(row.detail),
    'and the created situation is stated in the feature detail, not hidden');
  console.log('  36-feature roll-up sees both halves of 4.1: ok');
}

// ── The job option CloudFuze is actually sent ───────────────────────────────────────

function testJobRequestsCreatedTimeByOption() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'clients', 'migrationClient.js'), 'utf8');

  assert.ok(!/'createdTimeForFiles=false'/.test(src),
    'createdTimeForFiles must no longer be hardcoded');
  const m = src.match(/createdTimeForFiles=\$\{opt\('([A-Za-z]+)',\s*(true|false)\)\}/);
  assert.ok(m, 'createdTimeForFiles is built from a job option, like modifiedTimeForFiles');
  assert.strictEqual(m[1], 'preserveCreatedTime', 'the option name the validator also reads');
  assert.strictEqual(m[2], 'false',
    'the DEFAULT stays false: migrationClient is shared by every content combination and a run '
    + 'naming no option must send the job it sent before');
  assert.ok(/modifiedTimeForFiles=\$\{opt\('preserveTimestamp'\)\}/.test(src),
    'the modified flag is untouched');

  // migrationClient's own opt(), applied to the extracted default — the behaviour that matters is
  // "no options means the same job as before".
  const o = (options) => (options.preserveCreatedTime === undefined
    ? false : Boolean(options.preserveCreatedTime));
  assert.strictEqual(o({}), false, 'default job: createdTimeForFiles=false, exactly as before');
  assert.strictEqual(o({ preserveCreatedTime: true }), true, 'opt-in requests preservation');
  console.log('  job sends createdTimeForFiles=false by default, true on request: ok');
}

function run() {
  testOldestRevisionIsTheCreationTime();
  testOrderIsNotTrusted();
  testTruncatedListIsOnlyALowerBound();
  testNoRevisionsIsNotACreationTime();
  testJobOptionMirrors();
  testRowComparesWithinTheBand();
  testRowRefusesToCompareWhatItCannotEstablish();
  testRequestedAndMatchingPasses();
  testRequestedAndDifferingFails();
  testNotRequestedIsInfoAndNeverAPass();
  testUnobtainableWarns();
  testDriftStillFailsEvenWithUnknownsPresent();
  testModifiedVerdictUnchanged();
  testModifiedDriftNowReachable();
  testChecklistStillKeysOnFeature41();
  testJobRequestsCreatedTimeByOption();
  console.log('dropbox → google feature 4.1 created dates: all assertions passed');
}

run();
