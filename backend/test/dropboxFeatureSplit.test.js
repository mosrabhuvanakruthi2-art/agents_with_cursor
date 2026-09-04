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

/**
 * 7.1 must not FAIL for an absence it has itself ruled out.
 *
 * The feature asks one question: did a path get too long to migrate? When items LONGER than the
 * missing one arrived intact, the answer is no — so 7.1 has found no defect and must report
 * not-assessed, leaving the missing item to the structure check that owns it.
 *
 * On run 85a41244 a single unpaired Paper document produced a 1.1 failure, a 10.1 failure AND a 7.1
 * failure. One cause, counted three times, making the report read worse than the migration was —
 * the same double-counting the lumped 2.x permission check used to cause.
 *
 * Asserted on the source because the check sits inside a method that needs a whole paired tree; the
 * decision being protected is which STATUS the ruled-out branch pushes.
 */
function testLongPathNotBlamedForOtherCauses() {
  const fs2 = require('fs');
  const path2 = require('path');
  const src = fs2.readFileSync(path2.join(__dirname, '..', 'src', 'validation', 'combinations',
    'content', 'dropboxToGoogledrive.js'), 'utf8');

  const idx = src.indexOf('path length does not explain the absence');
  assert.ok(idx > -1, 'the ruled-out branch still exists');

  // Walk back to the push that owns this message and check its STATUS.
  const before = src.slice(Math.max(0, idx - 700), idx);
  const lastPush = before.lastIndexOf("push('");
  assert.ok(lastPush > -1, 'found the push for this branch');
  const status = before.slice(lastPush + 6, before.indexOf("'", lastPush + 6));
  assert.notStrictEqual(status, 'FAIL',
    'when path length is ruled out, 7.1 must NOT report FAIL — it has found no path-length defect');
  assert.strictEqual(status, 'WARN',
    'it reports not-assessed instead, and the structure check owns the missing item');

  // And the wording must point the reader at the check that does own it.
  const block = src.slice(idx - 700, idx + 500);
  assert.ok(/structure check/.test(block), 'the reader is sent to the structure check');
  assert.ok(/Not assessed/i.test(block), 'and the detail says plainly that it was not assessed');
  console.log('  7.1 not blamed for an absence it ruled out: ok');
}

testInnerFileFailureDoesNotBlameTheRootFolder();
/**
 * The checklist must match check names that carry the PER-UNIT PREFIX.
 *
 * A per-unit check is named "[QA-Automation-Dropbox-Dest] 2.1 Root Folder Permissions" — the feature
 * id is NOT at the start of the string. Anchoring the map patterns with ^ matched nothing, so on run
 * 85a41244 every permission and link feature reported "Not exercised by this run" in the checklist
 * while its own check said PASS. The report contradicted itself in the worst possible direction:
 * work that demonstrably passed was presented as untested.
 *
 * The fixture below uses the REAL names, prefix included. The earlier tests used bare names and so
 * agreed with the bug instead of catching it — the same mistake as the table-separator fixture.
 */
function testChecklistMatchesPrefixedCheckNames() {
  const agent = new Agent();
  const totals = agent._emptyTotals({ migrationType: 'ONETIME' });
  totals.scannedSourceItems = 75;

  const P = '[QA-Automation-Dropbox-Dest] ';
  const checks = [
    { name: P + '2.1 Root Folder Permissions', status: 'PASS', detail: '3 grant(s), all matched' },
    { name: P + '2.2 Root File Permissions', status: 'PASS', detail: '1 grant(s), all matched' },
    { name: P + '2.3 Sub-folder permissions', status: 'PASS', detail: '3 grant(s), all matched' },
    { name: P + '2.4 Inner file permissions', status: 'PASS', detail: '3 grant(s), all matched' },
    { name: P + '3.1 Shared Links (Anyone with the Link)', status: 'PASS', detail: 'ok' },
    { name: P + '3.2 Shared Links (Team Members)', status: 'PASS', detail: 'ok' },
    { name: P + '3.x Shared Link CSV', status: 'PASS', detail: 'ok' },
    { name: P + '1.1 Data Migration (structure)', status: 'PASS', detail: 'ok' },
  ];

  const rows = agent._buildChecklist(totals, checks);
  const row = (id) => rows.find((r) => r.id === id);

  for (const id of ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2']) {
    assert.strictEqual(row(id).status, 'pass',
      `${id} must read PASS in the checklist when its prefixed check passed — got ${row(id).status}`);
    assert.ok(!/not exercised/i.test(row(id).detail || ''),
      `${id} must not claim it was unexercised when a passing check exists`);
  }

  // And a bare, unprefixed name must still match — the script runner produces those.
  const bare = agent._buildChecklist(totals, [
    { name: '2.1 Root Folder Permissions', status: 'PASS', detail: 'ok' },
  ]);
  assert.strictEqual(bare.find((r) => r.id === '2.1').status, 'pass',
    'an unprefixed name still matches, so both callers work');

  // The id must not match inside a LONGER number — the reason the anchor existed at all.
  const wrong = agent._buildChecklist(totals, [
    { name: P + '2.10 Something Else', status: 'FAIL', detail: 'unrelated' },
  ]);
  assert.notStrictEqual(wrong.find((r) => r.id === '2.1').status, 'fail',
    '2.1 must not pick up a 2.10 check');
  console.log('  checklist matches prefixed check names, and only the right ones: ok');
}

testLongPathNotBlamedForOtherCauses();
testChecklistMatchesPrefixedCheckNames();
testPositionIsDecidedByDepth();
testPendingIsAttributedPerFeature();
testExternalSharesReportsItsOwnPreconditions();
testLinkFeaturesSplitByAudience();
testChecklistKeepsTheFeaturesApart();
console.log('dropboxFeatureSplit.test.js: ok');
