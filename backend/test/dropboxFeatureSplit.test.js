/**
 * Run: npm test  (from backend/)
 *
 * The five permission features and the two shared-link features must be judged SEPARATELY.
 *
 * They were not. `_buildChecklist` mapped 2.1 through 2.5 to the same `/2\.x Permissions/` regex and
 * both link features to `/3\.x Shared Links/`, while the roll-up pushed exactly one lumped check for
 * each group. Two consequences, in opposite directions and both wrong:
 *
 *   - a difference on an INNER FILE marked "2.1 Root Folder Permissions" as failed, sending a
 *     reviewer to look at a root folder that was correct
 *   - a clean root marked "2.4 Inner file permissions" as PASSED, which is the failure mode the
 *     scope documents exist to prevent: reporting a feature green without exercising it
 *
 * The evidence to separate them was already being collected — every observation carries the item's
 * path and type, and every link observation carries its Dropbox audience. These tests drive the real
 * roll-up and the real checklist, so they fail if the features are ever re-merged.
 */
const assert = require('assert');

const Agent = require('../src/validation/combinations/content/dropboxToGoogledrive');

/** A totals object that looks like a run which read some items. */
function totalsFor(context = {}) {
  const t = new Agent()._emptyTotals({ migrationType: 'ONETIME', ...context });
  t.scannedSourceItems = 4;
  return t;
}

/** Run the real roll-up and return its checks keyed by name. */
function rollUp(totals) {
  const checks = [];
  const push = (status, name, detail) => checks.push({ name, status, detail });
  new Agent()._rollUpItemChecks(push, totals, []);
  return checks;
}

const find = (checks, prefix) => checks.find((c) => c.name.startsWith(prefix));

/**
 * A failure on an inner file must fail 2.4 ALONE. 2.1 covers a different item and stays clean.
 *
 * This is the regression the whole split exists for: before it, both features read the same lumped
 * check and therefore always carried the same verdict.
 */
function testInnerFileFailureDoesNotBlameTheRootFolder() {
  const t = totalsFor();
  t.permissionObservations = [
    { path: '/01-Root-Folder-Permissions', type: 'folder', checked: 2 },
    { path: '/01-Root-Folder-Permissions/inner.txt', type: 'file', checked: 1 },
  ];
  t.permissionMismatches = [
    { path: '/01-Root-Folder-Permissions/inner.txt', user: 'ben@filefuze.co' },
  ];

  const checks = rollUp(t);
  assert.strictEqual(find(checks, '2.4').status, 'FAIL',
    'the inner file carries the mismatch, so 2.4 fails');
  assert.strictEqual(find(checks, '2.1').status, 'PASS',
    'the root FOLDER was compared and matched, so 2.1 must not inherit the inner file\'s failure');

  // And the reverse direction: the two features that had no evidence must not read as passing.
  assert.strictEqual(find(checks, '2.2').status, 'WARN',
    'no root FILE was compared, so 2.2 is not exercised — never a pass');
  assert.strictEqual(find(checks, '2.3').status, 'WARN',
    'no SUB-folder was compared, so 2.3 is not exercised — never a pass');
  console.log('  inner-file failure does not blame the root folder: ok');
}

/** Depth decides position: one path segment is root, more than one is inner. */
function testPositionIsDecidedByDepth() {
  const t = totalsFor();
  t.permissionObservations = [
    { path: '/02-root-file-viewer.txt', type: 'file', checked: 1 },
    { path: '/01-Root/Sub', type: 'folder', checked: 1 },
  ];

  const checks = rollUp(t);
  assert.strictEqual(find(checks, '2.2').status, 'PASS', 'a one-segment file path is a ROOT file');
  assert.strictEqual(find(checks, '2.3').status, 'PASS', 'a two-segment folder path is a SUB-folder');
  assert.strictEqual(find(checks, '2.1').status, 'WARN', 'no root folder was compared');
  assert.strictEqual(find(checks, '2.4').status, 'WARN', 'no inner file was compared');
  console.log('  root vs inner decided by path depth: ok');
}

/**
 * A difference sitting entirely on items CloudFuze had not finished sharing is NOT a defect, and
 * the pending state must be attributed to the FEATURE that owns those items.
 *
 * Reporting this as FAIL is what filed four Neutara tickets against permissions a later read showed
 * were correct, so the rule matters per-feature and not just globally.
 */
function testPendingIsAttributedPerFeature() {
  const t = totalsFor();
  t.permissionObservations = [
    { path: '/01-Root-Folder-Permissions', type: 'folder', checked: 3 },
    { path: '/01-Root-Folder-Permissions/inner.txt', type: 'file', checked: 1 },
  ];
  // The root folder's grants had not landed yet; the inner file's genuinely differ.
  t.permissionMismatches = [
    { path: '/01-Root-Folder-Permissions', user: 'ben@filefuze.co' },
    { path: '/01-Root-Folder-Permissions/inner.txt', user: 'ben@filefuze.co' },
  ];
  t.permissionsPending = 1;
  t.permissionsPendingPaths = ['/01-Root-Folder-Permissions'];

  const checks = rollUp(t);
  const root = find(checks, '2.1');
  assert.strictEqual(root.status, 'WARN',
    'the root folder\'s only difference is an unsettled grant, so it is not judgeable yet');
  assert.ok(/not judgeable yet/i.test(root.detail),
    `the reason must say so, got: ${root.detail}`);

  assert.strictEqual(find(checks, '2.4').status, 'FAIL',
    'the inner file was NOT pending, so its difference is a real failure and must still be reported');
  console.log('  pending state attributed to the owning feature: ok');
}

/** 2.5 is about the PRINCIPAL, and must say plainly when it was never configured. */
function testExternalSharesReportsItsOwnPreconditions() {
  const t = totalsFor();
  t.permissionObservations = [{ path: '/a', type: 'folder', checked: 2, externalChecked: 0 }];

  const ext = find(rollUp(t), '2.5');
  assert.strictEqual(ext.status, 'WARN', 'with no external grant compared, 2.5 is not exercised');
  assert.ok(/DROPBOX_TEST_EXTERNAL_USER|not exercised/i.test(ext.detail),
    `2.5 must name what is missing, got: ${ext.detail}`);

  // With external grants present and matching, it passes on its own evidence — not on 2.1's.
  const t2 = totalsFor();
  t2.permissionObservations = [
    { path: '/a', type: 'folder', checked: 2, externalChecked: 1, externalFailed: 0 },
  ];
  t2.permissionMismatches = [];
  const ext2 = find(rollUp(t2), '2.5');
  assert.strictEqual(ext2.status, 'PASS', 'an external grant that matched passes 2.5');
  console.log('  external shares judged on its own evidence: ok');
}

/** Shared links split by Dropbox's own audience: 'public' is 3.1, anything else is 3.2. */
function testLinkFeaturesSplitByAudience() {
  const t = totalsFor();
  t.linkObservations = [
    { path: '/a.txt', type: 'file', sourceAudience: 'public', match: true },
    { path: '/b.txt', type: 'file', sourceAudience: 'team_only', match: false },
  ];

  const checks = rollUp(t);
  assert.strictEqual(find(checks, '3.1').status, 'PASS',
    'the anyone-with-the-link link matched, so 3.1 passes');
  assert.strictEqual(find(checks, '3.2').status, 'FAIL',
    'the team-only link differed, so 3.2 fails independently of 3.1');
  console.log('  link features split by audience: ok');
}

/**
 * The checklist must carry the per-feature verdicts through, not collapse them again.
 *
 * Asserted through the real _buildChecklist because the regex map is where the features were
 * previously merged — a correct roll-up feeding a merged map would still produce the old report.
 */
function testChecklistKeepsTheFeaturesApart() {
  const t = totalsFor();
  t.permissionObservations = [
    { path: '/01-Root-Folder-Permissions', type: 'folder', checked: 2 },
    { path: '/01-Root-Folder-Permissions/inner.txt', type: 'file', checked: 1 },
  ];
  t.permissionMismatches = [{ path: '/01-Root-Folder-Permissions/inner.txt', user: 'x@y.co' }];

  const checks = rollUp(t);
  const rows = new Agent()._buildChecklist(t, checks);
  const row = (id) => rows.find((r) => r.id === id);

  assert.strictEqual(row('2.1').status, 'pass', '2.1 reaches the checklist as its own pass');
  assert.strictEqual(row('2.4').status, 'fail', '2.4 reaches the checklist as its own fail');
  assert.notStrictEqual(row('2.1').status, row('2.4').status,
    'the two features must not share a verdict — that was the defect');

  // Every documented permission and link feature must resolve to a row, or the split silently
  // dropped one from the report.
  for (const id of ['2.1', '2.2', '2.3', '2.4', '2.5', '3.1', '3.2']) {
    assert.ok(row(id), `feature ${id} is present in the checklist`);
    assert.ok(row(id).detail, `feature ${id} carries a reason, not a bare status`);
  }
  console.log('  checklist keeps the features apart: ok');
}

testInnerFileFailureDoesNotBlameTheRootFolder();
testPositionIsDecidedByDepth();
testPendingIsAttributedPerFeature();
testExternalSharesReportsItsOwnPreconditions();
testLinkFeaturesSplitByAudience();
testChecklistKeepsTheFeaturesApart();
console.log('dropboxFeatureSplit.test.js: ok');
