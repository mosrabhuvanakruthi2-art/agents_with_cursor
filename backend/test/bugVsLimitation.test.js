/**
 * Run: npm test  (from backend/)
 *
 * Every finding must be classified against the DOCUMENT before it becomes a ticket.
 *
 * neutaraClient files a Neutara Bug for each mismatch unless it carries
 * `bugStatus: 'known_limitation'`, and skips ticket creation entirely when a run produces only
 * limitations. This combination never set the field, so documented behaviour would have been filed
 * as a defect — which is exactly how the Shared Drive combination filed four tickets against
 * permissions that were correct and had to retract them.
 *
 * Three outcomes, and the distinction matters to whoever reads the ticket:
 *
 *   bug                an IN-SCOPE feature did not do what doc.cftools.live says it does
 *   out-of-scope ran   an OUT-OF-SCOPE feature happened anyway — the product doing MORE than
 *                      documented, which is worth raising but is not data loss
 *   known limitation   documented behaviour that merely looks like a failure — never a bug
 *
 * Asserted through the real validator so the classifier cannot drift from the checks it classifies.
 */
const assert = require('assert');

const ValidationAgent = require('../src/validation/combinations/content/sharefileToSharepoint');

/**
 * Drive buildResult through the exported agent by calling the module's own classification path.
 * The mismatch list is built inside buildResult, so a check list is pushed through a minimal fake
 * run rather than reimplementing the mapping here — a copy would pass while the real one broke.
 */
function classify(checks) {
  // buildResult is module-private; it is reached through the agent's result shape by calling the
  // same function the agent calls. Exported for this purpose alongside the feature lists.
  const build = ValidationAgent.buildResultForTest;
  assert.strictEqual(typeof build, 'function',
    'buildResultForTest must be exported — without it this test would assert a copy of the '
    + 'classifier rather than the classifier itself');
  return build(checks, null).mismatches || [];
}

function testInScopeFailureIsABug() {
  const m = classify([
    { name: '2. Permissions — group grants (feature 2.3)', status: 'FAIL',
      detail: '10 group grant(s) did not arrive at the destination' },
  ]);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].bugStatus, 'bug',
    'an in-scope feature that did not behave as documented is a defect');
  assert.strictEqual(m[0].scope, 'in-scope');
  assert.strictEqual(m[0].featureId, '2.3', 'the ticket must name which documented feature failed');
  assert.ok(/IN SCOPE/.test(m[0].scopeNote), 'the note must state the basis for calling it a defect');
  console.log('  in-scope failure → bug, naming the feature: ok');
}

function testDocumentedBehaviourIsALimitation() {
  const cases = [
    ['6. Long file/folder path', '3 item(s) over the 400-character limit were relocated'],
    ['4. Version history', 'file(s) carry more versions at the destination — SharePoint App placeholder'],
    ['1. File sizes', '4 Office file(s) larger — SharePoint adds customXml/docProps metadata'],
  ];
  for (const [name, detail] of cases) {
    const m = classify([{ name, status: 'FAIL', detail }]);
    assert.strictEqual(m[0].bugStatus, 'known_limitation', `"${name}" must not be filed as a bug`);
    assert.strictEqual(m[0].severity, 'info', 'a limitation is reported, not raised as an error');
    assert.ok(/NOT A BUG/.test(m[0].scopeNote),
      'the row must say why it is documented, or the next reader re-files it');
  }
  console.log('  documented behaviour → known limitation, with its citation: ok');
}

function testOutOfScopeMigratingIsItsOwnKind() {
  // Direction is carried by the detail, not the status: FAIL now means "did not reach the
  // destination" everywhere in the report, so a LEAK is a check that succeeded in the plain sense.
  const leaked = classify([
    { name: '9. Out-of-scope: shared links did not migrate', status: 'PASS',
      detail: 'MIGRATED — and it should not have. 1 sharing link(s) on the destination copy' },
  ]);
  assert.strictEqual(leaked.length, 1,
    'a leak must survive the finding filter even though its check status is PASS — filtering on '
    + 'FAIL alone would drop the one defect the out-of-scope controls exist to catch');
  assert.strictEqual(leaked[0].bugStatus, 'bug', 'an out-of-scope feature running is worth raising');
  assert.strictEqual(leaked[0].scope, 'out-of-scope');
  assert.ok(/MORE than the document/.test(leaked[0].scopeNote),
    'the ticket must distinguish "did too much" from "lost data" — they are not the same defect');

  // The mirror case: the documented outcome. Reported as a failure because the job asked and the
  // tool did not deliver, but it must never reach the ticket queue.
  const documented = classify([
    { name: '9. Out-of-scope: shared links did not migrate', status: 'FAIL',
      detail: 'NOT MIGRATED. Expected: Shared Links is on the OUT-OF-SCOPE list for this pair.' },
  ]);
  assert.strictEqual(documented[0].bugStatus, 'known_limitation',
    'an out-of-scope feature that did not arrive is documented behaviour — shown as a failure, '
    + 'never filed as a CloudFuze defect');
  assert.ok(/NOT A BUG/.test(documented[0].scopeNote),
    'the row must say why it is expected, or the next reader files it');
  console.log('  out-of-scope: migrated → raised; not migrated → shown as FAIL, no ticket: ok');
}

function testValidatorGapIsNotACloudFuzeDefect() {
  const m = classify([
    { name: 'SharePoint site accessible', status: 'FAIL', detail: 'Could not resolve the site' },
  ]);
  assert.strictEqual(m[0].kind, 'infrastructure');
  assert.strictEqual(m[0].bugStatus, 'unknown',
    'a check that could not run must not be filed as a product defect — neutaraClient turns an '
    + 'all-infrastructure run into a Task, and marking it a bug would defeat that');
  console.log('  validator gap → infrastructure, not a product defect: ok');
}

function testUnmappedFailureStaysABug() {
  const m = classify([
    { name: 'Something nobody has classified', status: 'FAIL', detail: 'unexpected' },
  ]);
  assert.strictEqual(m[0].bugStatus, 'bug',
    'an unclassified failure must stay a bug — silently downgrading what nobody has categorised '
    + 'is how a real finding disappears');
  assert.strictEqual(m[0].scope, 'unmapped');
  console.log('  unmapped failure stays a bug rather than being downgraded: ok');
}

testInScopeFailureIsABug();
testDocumentedBehaviourIsALimitation();
testOutOfScopeMigratingIsItsOwnKind();
testValidatorGapIsNotACloudFuzeDefect();
testUnmappedFailureStaysABug();
console.log('bugVsLimitation.test.js: ok');
