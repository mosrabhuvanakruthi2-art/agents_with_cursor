/**
 * Run: npm test  (from backend/)
 *
 * A migration must not be submitted when CloudFuze never validated the path mapping.
 *
 * Run 003eec1b (10-Sep-2026) is the case. The two-step sequence in migrationClient is:
 *
 *   1. POST /mapping/download/csvcreator/{csvId}/asynchronous   ← starts validation
 *   2. POST /mapping/check/csvvalidationstatus/{csvId}          ← poll until ready
 *
 * Step 1 returned HTTP 500. The code logged "polling anyway" and then polled step 2 sixty times
 * over 300 seconds, each time receiving "Total Saved Count :0" — which the client's own comment
 * already documents as the signature of validating nothing. A job was created regardless, reached
 * PROCESSED with totalFilesAndFolders=0 and status CONFLICT, and the run then spent 35 minutes
 * validating an empty destination to conclude that it was empty.
 *
 * Two harms, the same shape as the null-cloud-id bug that cloudIdFailFast.test.js pins: a run that
 * was doomed in its second minute burned its full duration, and the report described a destination
 * problem rather than the CloudFuze-side condition that caused it.
 *
 * The SAFETY half matters as much as the guard. A validation timeout on its own must stay a
 * warning: run fb511720 timed out at poll 60, still held a usable mapping, and migrated 83/83. So
 * the refusal is conditioned on step 1 never having STARTED, not on the timeout.
 *
 * Asserted on the source, for the reason cloudIdFailFast.test.js gives: the guard sits between two
 * live CloudFuze calls, so a behavioural test would need the whole client stood up against a
 * stubbed server. What matters — that the guard exists, throws rather than warns, is correctly
 * conditioned, and names the real cause — is checkable directly.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'clients', 'migrationClient.js'), 'utf8');

/** Step 1 failing has to be RECORDED, or the poll loop cannot know the polls are pointless. */
function testFailureIsRecorded() {
  assert.ok(/let validationStarted = true;/.test(src),
    'the started/not-started fact is tracked');

  const idx = src.indexOf('} catch (kickErr) {');
  assert.ok(idx > -1, 'the csvcreator call still has its own catch');
  const block = src.slice(idx, idx + 900);
  assert.ok(/validationStarted = false;/.test(block),
    'the catch records that validation never started, instead of only warning');
  console.log('  a failed csvcreator call is recorded, not just logged: ok');
}

/** It must stop polling early — 300s of "Total Saved Count :0" is 300s wasted. */
function testPollingStopsEarly() {
  const idx = src.indexOf('Total Saved Count');
  assert.ok(idx > -1, 'the zero-saved response is matched');
  const block = src.slice(src.indexOf('let zeroSavedPolls = 0;'), src.indexOf('if (!ready && !validationStarted)'));
  assert.ok(/zeroSavedPolls \+= 1;/.test(block), 'consecutive zero-saved polls are counted');
  assert.ok(/zeroSavedPolls >= 3/.test(block),
    'a few confirming polls are kept, in case the 500 was transient');
  assert.ok(/break;/.test(block), 'and then it stops rather than running the full window');
  assert.ok(/!validationStarted && \/Total Saved Count/.test(block),
    'the early exit requires BOTH facts — a zero count alone must not abandon a healthy run');
  console.log('  polling stops after confirming, instead of burning the full window: ok');
}

/** The refusal must THROW. A warning would let the doomed job be created, which is the bug. */
function testItRefusesTheJob() {
  const idx = src.indexOf('if (!ready && !validationStarted)');
  assert.ok(idx > -1, 'the guard is conditioned on BOTH not-ready and never-started');
  const block = src.slice(idx, idx + 1600);
  assert.ok(/throw new Error\(/.test(block),
    'it throws — a warning would submit a job that can only migrate nothing');
  console.log('  it refuses to create the job rather than warning: ok');
}

/**
 * The message has to name the cause and the remedy. The previous behaviour reported a destination
 * that "appears to have created nothing", which sends the reader to the wrong system entirely.
 */
function testMessageNamesTheCause() {
  const idx = src.indexOf('if (!ready && !validationStarted)');
  const block = src.slice(idx, idx + 1600);
  assert.ok(/Total Saved Count/.test(block), 'it quotes the observed symptom');
  assert.ok(/csvcreator/.test(block), 'it names the call that failed');
  assert.ok(/CloudFuze-side condition/i.test(block),
    'it says plainly that this is not a data problem, so nobody re-seeds in response');
  assert.ok(/Manage Clouds/.test(block), 'it points at where to look');
  assert.ok(/CONTENT_SOURCE_CLOUD_ID/.test(block) && /CONTENT_DEST_CLOUD_ID/.test(block),
    'and gives the pin-a-known-good-registration escape hatch');
  console.log('  the error names the cause, the place to look, and the workaround: ok');
}

/**
 * SAFETY: a plain timeout must still be survivable.
 *
 * fb511720 timed out at poll 60 and migrated 83/83. If the refusal keyed on `!ready` alone it would
 * have failed that run, so the ordering here is load-bearing: the throw is checked first and is
 * conditioned on !validationStarted, and the pre-existing timeout WARN still follows it.
 */
function testTimeoutAloneStillOnlyWarns() {
  const throwIdx = src.indexOf('if (!ready && !validationStarted)');
  const warnIdx = src.indexOf('CloudFuze mapping validation did not report ready within');
  assert.ok(throwIdx > -1 && warnIdx > -1, 'both branches exist');
  assert.ok(throwIdx < warnIdx,
    'the strict refusal is evaluated before the survivable timeout warning');

  const warnBlock = src.slice(src.lastIndexOf('if (!ready) {', warnIdx), warnIdx + 600);
  assert.ok(!/throw new Error\(/.test(warnBlock),
    'a timeout with validation STARTED still only warns — fb511720 timed out and migrated 83/83, '
    + 'so failing on the timeout alone would break working runs');
  assert.ok(/CONTENT_CSV_VALIDATION_MAX_POLLS/.test(warnBlock),
    'and it still suggests raising the poll ceiling');
  console.log('  a timeout on its own still only warns, so working runs are unaffected: ok');
}

testFailureIsRecorded();
testPollingStopsEarly();
testItRefusesTheJob();
testMessageNamesTheCause();
testTimeoutAloneStillOnlyWarns();
console.log('CloudFuze CSV validation fail-fast: all assertions passed');
