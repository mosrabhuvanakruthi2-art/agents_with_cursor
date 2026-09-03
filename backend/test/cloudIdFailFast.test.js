/**
 * Run: npm test  (from backend/)
 *
 * A migration must not proceed when CloudFuze's cloud lookup failed.
 *
 * Run dbx-gsd-1788419245787 (03-Sep-2026): getClouds failed twice — "socket hang up", then HTTP 500
 * — so both cloud ids stayed null and nothing checked. The run then built requests carrying the
 * literal string "null":
 *
 *     /mapping/user/path/csv?sourceCloudId=null&destCloudId=null   → HTTP 404
 *     /mapping/deleteAll/mapplist?sourceAdminCloudId=null&...       → HTTP 404
 *     cache/list: 0 mapping row(s)
 *     "ALL 1 pair(s) failed validation — nothing to migrate"
 *
 * Two separate harms: 39 minutes spent on a run that was doomed at minute two, and a final message
 * blaming the user/folder PAIR for what was a failed cloud lookup. A QA tool must not misattribute
 * a failure it can identify precisely.
 *
 * Asserted on the source because the guard sits between two live CloudFuze calls, so a behavioural
 * test would need the whole agent stood up against a stubbed server. What matters — that the check
 * exists, runs before the mapping calls, and names the real cause — is checkable directly.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'agents', 'migration', 'MigrationAgent.js'), 'utf8');

/** The guard exists and throws rather than warning. */
function testGuardExists() {
  assert.ok(src.includes('if (!context.sourceCloudId || !context.destCloudId) {'),
    'both cloud ids are checked, not just one');

  const idx = src.indexOf('if (!context.sourceCloudId || !context.destCloudId) {');
  const block = src.slice(idx, idx + 1400);
  assert.ok(/throw new Error\(/.test(block),
    'it throws — a warning would let the run continue with null ids, which is the bug');
  console.log('  null cloud ids throw rather than warn: ok');
}

/**
 * The message must name the real cause. The old failure text blamed the pair, which sent the
 * investigation to the wrong place for 39 minutes.
 */
function testMessageNamesTheRealCause() {
  const idx = src.indexOf('if (!context.sourceCloudId || !context.destCloudId) {');
  // Join adjacent string literals before matching. The message is built with `' + '` across several
  // lines, so a phrase that reads as one sentence at run time is split in the source — matching the
  // raw text failed for that reason alone, not because the wording was missing.
  const block = src.slice(idx, idx + 1400).replace(/'\s*\n?\s*\+\s*'/g, '');

  assert.ok(/getClouds/.test(block), 'the message names getClouds, the call that actually failed');
  assert.ok(/CloudFuze-side/i.test(block), 'and says it is CloudFuze-side');
  assert.ok(/not a problem with the source folder or the user mapping/i.test(block),
    'and explicitly rules out the pair, which the old message implied');
  assert.ok(/socket hang up|HTTP 500/.test(block),
    'and tells the reader which log lines to look for');
  console.log('  message names the cloud lookup, not the pair: ok');
}

/** The guard must sit before the mapping work, or it saves nothing. */
function testGuardRunsBeforeMappingCalls() {
  const guardAt = src.indexOf('if (!context.sourceCloudId || !context.destCloudId) {');
  assert.ok(guardAt > -1, 'guard found');

  // triggerMigration is what performs the path-CSV upload and job creation.
  const triggerAt = src.indexOf('migrationClient.triggerMigration(context)');
  assert.ok(triggerAt > -1, 'the migration trigger was found');
  assert.ok(guardAt < triggerAt,
    'the guard runs before triggerMigration, so a failed lookup cannot reach the mapping calls');

  // And after the ids are assigned, or it would always fire.
  const assignAt = src.indexOf('context.sourceCloudId   = sourceCloud.id;');
  assert.ok(assignAt > -1 && assignAt < guardAt,
    'the guard runs after the ids are assigned');
  console.log('  guard sits between id assignment and triggerMigration: ok');
}

/** Both providers are named in the error so the reader knows which side failed. */
function testNamesWhichSideFailed() {
  const idx = src.indexOf('if (!context.sourceCloudId || !context.destCloudId) {');
  const block = src.slice(idx, idx + 1400);
  assert.ok(/sourceProvider/.test(block) && /destinationProvider/.test(block),
    'the message reports which side (and which provider) failed to resolve');
  console.log('  reports which side failed to resolve: ok');
}

testGuardExists();
testMessageNamesTheRealCause();
testGuardRunsBeforeMappingCalls();
testNamesWhichSideFailed();
console.log('cloudIdFailFast.test.js: ok');
