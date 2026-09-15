/**
 * Run: npm test  (from backend/)
 *
 * The concurrency guard — a run must refuse to start while another is in flight on the same source
 * account.
 *
 * Why this has a test of its own: the failure it prevents does not look like a concurrency problem.
 * Execution d2222ede started while 23e4d09f was still RUNNING on the same ShareFile account and
 * reported "68 of 201 source items not found at the destination". Every number was accurate, the
 * migration engine was healthy, and the report read exactly like a CloudFuze data-loss defect. The
 * only clue was one line in a log nobody had reason to open.
 *
 * Three behaviours are load-bearing and all three are asserted:
 *
 *   1. it FIRES on a clash — otherwise the report above happens again
 *   2. it stays SILENT for a different source account, a finished run, and the run's own record —
 *      a guard that blocks legitimate runs gets deleted by the first person it inconveniences
 *   3. a broken execution store does NOT block the run — refusing to migrate because a bookkeeping
 *      lookup threw would be worse than the overlap it prevents
 */
const assert = require('assert');

const orchestrator = require('../src/orchestrator/AgentOrchestrator');
const executionService = require('../src/services/executionService');

const { assertNoConcurrentRun } = orchestrator;
const SILENT_LOG = { warn() {}, error() {}, info() {} };

/** Swap executionService.getAll for the duration of one call, then always put it back. */
function withExecutions(rows, fn) {
  const real = executionService.getAll;
  executionService.getAll = () => rows;
  try {
    return fn();
  } finally {
    executionService.getAll = real;
  }
}

function testFiresOnClash() {
  const rows = [{
    executionId: 'other-run',
    status: 'RUNNING',
    context: { sourceEmail: 'zara@storefuze.com' },
  }];

  withExecutions(rows, () => {
    assert.throws(
      () => assertNoConcurrentRun({ executionId: 'mine', sourceEmail: 'zara@storefuze.com' }, SILENT_LOG),
      (err) => {
        // The message has to name the other execution: "another run is in progress" with no id
        // leaves the user hunting through logs for which one.
        assert.ok(/other-run/.test(err.message), 'the clashing execution id must be named');
        assert.ok(/zara@storefuze\.com/.test(err.message), 'the source account must be named');
        return true;
      },
      'a second run on the same source account must be refused'
    );
  });
  console.log('  fires on a clash, naming the execution and the account: ok');
}

function testSilentWhenNoClash() {
  const cases = [
    {
      why: 'a different source account is not a clash',
      rows: [{ executionId: 'other', status: 'RUNNING', context: { sourceEmail: 'someone@else.com' } }],
    },
    {
      why: 'a finished run is not a clash',
      rows: [{ executionId: 'other', status: 'COMPLETED', context: { sourceEmail: 'zara@storefuze.com' } }],
    },
    {
      why: 'the run must not block on its OWN execution record',
      rows: [{ executionId: 'mine', status: 'RUNNING', context: { sourceEmail: 'zara@storefuze.com' } }],
    },
    { why: 'no executions at all', rows: [] },
  ];

  for (const c of cases) {
    withExecutions(c.rows, () => {
      assert.doesNotThrow(
        () => assertNoConcurrentRun({ executionId: 'mine', sourceEmail: 'zara@storefuze.com' }, SILENT_LOG),
        `${c.why} — the guard must stay out of the way`
      );
    });
  }
  console.log('  silent for other accounts, finished runs, and its own record: ok');
}

function testStoreFailureDoesNotBlock() {
  const real = executionService.getAll;
  executionService.getAll = () => { throw new Error('mongo unavailable'); };
  try {
    assert.doesNotThrow(
      () => assertNoConcurrentRun({ executionId: 'mine', sourceEmail: 'zara@storefuze.com' }, SILENT_LOG),
      'an unreadable execution store must not stop a migration'
    );
  } finally {
    executionService.getAll = real;
  }
  console.log('  an unreadable execution store does not block the run: ok');
}

function testGuardIsWiredIn() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/orchestrator/AgentOrchestrator.js'), 'utf8');
  // Exported-but-never-called is the failure mode here: the unit tests above would all pass while
  // no run was ever guarded.
  assert.ok(
    /assertNoConcurrentRun\(context, log\);/.test(src),
    'runFullFlow must actually call the guard — an uncalled guard passes every test and stops nothing'
  );
  console.log('  the guard is called from the flow, not merely exported: ok');
}

testFiresOnClash();
testSilentWhenNoClash();
testStoreFailureDoesNotBlock();
testGuardIsWiredIn();
console.log('concurrentRunGuard.test.js: ok');
