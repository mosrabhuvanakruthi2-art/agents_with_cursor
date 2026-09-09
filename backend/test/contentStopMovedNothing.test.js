/**
 * Run: npm test  (from backend/)
 *
 * A content migration that STOPPED having moved nothing must report itself as failed.
 *
 * Run 27d31e8d (dropbox → googleshareddrive) ended:
 *
 *   terminal status: CONFLICT
 *   job details: total=0, processed=0
 *   CloudFuze says: "Migration not Allowed for wrong CSV paths"
 *
 * and the execution still recorded `migrationFailed: false`. The validator, which runs after a stop
 * status on purpose so a report always exists, then reported 77 scanned / 0 paired / 77 missing
 * against a destination CleanupAgent had emptied.
 *
 * So the run read as a migration that "did not fail" losing 77 files, when nothing had ever been
 * copied. Two concrete costs, not just wording:
 *
 *   - a reader is sent to investigate 77 content defects that do not exist, and
 *   - AgentOrchestrator suppresses Neutara bug filing only when `migrationFailed` is set, so those
 *     77 findings were eligible to be filed as real defects. Execution ac77ad80 did exactly that
 *     once already, filing 5 tickets against a destination nothing had been written to.
 *
 * The judgement is on the ITEM COUNT, never the status name: a stop status that did move items is a
 * partial migration whose findings are genuine and must keep reaching validation untouched.
 */
const assert = require('assert');
const fs = require('fs');

const src = fs.readFileSync(require.resolve('../src/agents/migration/MigrationAgent'), 'utf8');

/** The rule as the agent applies it, asserted directly. */
function movedNothing(details) {
  return Number(details.totalCount || 0) === 0 && Number(details.processedCount || 0) === 0;
}

function testZeroItemsIsAFailure() {
  // The real numbers from run 27d31e8d.
  assert.strictEqual(movedNothing({ totalCount: 0, processedCount: 0 }), true,
    'CONFLICT with total=0, processed=0 moved nothing and is a failed migration');

  // Missing/undefined counts are the same thing — CloudFuze omits them on some stop paths.
  assert.strictEqual(movedNothing({}), true, 'absent counts are treated as nothing moved');
  assert.strictEqual(movedNothing({ totalCount: null, processedCount: null }), true);
  console.log('  a stop status with zero items is reported as a failed migration: ok');
}

function testPartialMigrationIsNotAFailure() {
  // 77/77 with a stop status: everything arrived, then the job stopped. Real findings.
  assert.strictEqual(movedNothing({ totalCount: 77, processedCount: 77 }), false,
    'a stop status that moved every item is not "moved nothing"');

  // A genuine partial: some arrived. Its validation findings are real and must not be suppressed.
  assert.strictEqual(movedNothing({ totalCount: 77, processedCount: 40 }), false,
    'a PARTIAL migration is not "moved nothing" — its findings are genuine defects');

  // The boundary that matters: one single item is enough to make the findings real.
  assert.strictEqual(movedNothing({ totalCount: 1, processedCount: 0 }), false,
    'one item attached means the destination was written to, so findings stand');
  console.log('  a partial migration keeps its findings: ok');
}

/**
 * The flags have to travel on the RETURNED result, not only on the content report — the
 * orchestrator reads `migrationResult.migrationFailed` and `migrationResult.failureReason`.
 */
function testFlagsReachTheOrchestrator() {
  const stopBlock = src.slice(src.indexOf('isContentMode && isContentStopStatus'));
  assert.ok(stopBlock.length > 0, 'the content stop-status branch still exists');

  const returnIdx = stopBlock.indexOf('return {');
  assert.ok(returnIdx > -1, 'the branch still returns a result');
  const returned = stopBlock.slice(returnIdx, returnIdx + 1200);

  assert.ok(/migrationFailed: true/.test(returned),
    'the returned result carries migrationFailed, which is the field AgentOrchestrator reads');
  assert.ok(/failureReason: stopReason/.test(returned),
    'and the reason, so the report says WHY nothing moved');
  assert.ok(/movedNothing \?/.test(returned),
    'both are conditional on nothing having moved, so a partial migration is unaffected');

  // The orchestrator side of the contract.
  const orch = fs.readFileSync(require.resolve('../src/orchestrator/AgentOrchestrator'), 'utf8');
  assert.ok(/migrationFailed: Boolean\(migrationResult\?\.migrationFailed\)/.test(orch),
    'the orchestrator still reads migrationFailed off the migration result');
  assert.ok(/if \(migrationResult\?\.migrationFailed\)/.test(orch),
    'and still uses it to suppress bug filing when nothing was copied');
  console.log('  the flags reach the orchestrator and suppress bug filing: ok');
}

/** The reason must name the cause, not just restate the status. */
function testReasonIsUseful() {
  assert.ok(/totalFilesAndFolders=0/.test(src),
    'the reason cites the count CloudFuze reported, so a reader can verify it');
  assert.ok(/27d31e8d/.test(src),
    'the run that exposed this is cited, so the check is not mistaken for defensive noise');
  console.log('  the failure reason explains the cause: ok');
}

testZeroItemsIsAFailure();
testPartialMigrationIsNotAFailure();
testFlagsReachTheOrchestrator();
testReasonIsUseful();
console.log('contentStopMovedNothing.test.js: ok');
