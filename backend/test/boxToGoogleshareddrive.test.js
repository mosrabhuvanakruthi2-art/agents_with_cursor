/**
 * Run: npm test  (from backend/)
 *
 * Box → Google Shared Drive. The combination is a registration over the My Drive pair's agents,
 * mirroring dropboxToGoogleshareddrive.js / dropboxToGoogleshareddrive.test.js. What is asserted here
 * is everything that would otherwise only fail during a live run, and would fail in a way that reads
 * like a migration defect rather than a configuration error:
 *
 *   - the registry resolves the pair at all (an unregistered pair dies at agent resolution, before
 *     any validation, so the run reports nothing rather than failing)
 *   - it resolves to the SAME agents as the My Drive pair, since the whole point is reuse
 *   - the My Drive pair still resolves, untouched by the addition
 *
 * Generic Shared Drive behaviour (name resolution, refusal with no drive name, the
 * GOOGLE_DEST_SHARED_DRIVE_NAME fallback, the permission settle window) lives in
 * GoogleDriveValidationAgent and is already covered by dropboxToGoogleshareddrive.test.js — none of
 * that varies by source provider, so it is not re-asserted here.
 */
const assert = require('assert');

const registry = require('../src/orchestrator/agentRegistry');
const ValidationAgent = require('../src/validation/combinations/content/boxToGoogledrive');
const BoxToGoogledriveTestDataAgent = require('../src/agents/box/BoxToGoogledriveTestDataAgent');

/** The pair resolves, and to the same agents the My Drive pair uses. */
function testRegistration() {
  const entry = registry.resolve('content', 'box', 'googleshareddrive');
  assert.ok(entry, 'content:box:googleshareddrive is registered');

  assert.strictEqual(entry.TestDataAgent, BoxToGoogledriveTestDataAgent,
    'the Box source is seeded by the same agent as the My Drive pair');
  assert.strictEqual(entry.ValidationAgent, ValidationAgent,
    'the validator is reused, not copied — a copy would drift from the My Drive pair');

  // Without this the orchestrator falls back to ContentReportValidationAgent, which compares
  // nothing and can report SUCCESS while validating nothing.
  assert.strictEqual(entry.ValidationAgent.supportsDeepValidation, true,
    'deep validation must be opted into');

  console.log('  shared-drive combination registration: ok');
}

/** The My Drive pair still resolves — reuse must not disturb the combination it borrows from. */
function testMyDrivePairUnaffected() {
  const mine = registry.resolve('content', 'box', 'googleshareddrive');
  const hers = registry.resolve('content', 'box', 'googledrive');
  assert.ok(hers, 'content:box:googledrive is still registered');
  assert.strictEqual(hers.ValidationAgent, mine.ValidationAgent, 'both pairs share one validator');
  assert.strictEqual(hers.TestDataAgent, mine.TestDataAgent, 'both pairs share one seeding agent');

  const pairs = registry.list()
    .filter((p) => p.domain === 'content' && p.sourceProvider === 'box')
    .map((p) => p.destinationProvider)
    .sort();
  for (const expected of ['googledrive', 'googleshareddrive']) {
    assert.ok(pairs.includes(expected), `the Box → ${expected} pair is registered`);
  }

  // box → sharepoint / box → onedrive deliberately do NOT share this validator — a different
  // permission model and a different scope document. Assert that separation rather than the
  // directory's total contents.
  const sharepoint = registry.resolve('content', 'box', 'sharepoint');
  if (sharepoint) {
    assert.notStrictEqual(sharepoint.ValidationAgent, mine.ValidationAgent,
      'the SharePoint pair must have its own validator — sharing one would let a change to either '
      + 'scope document move the other pair\'s verdicts');
  }

  console.log('  My Drive pair unaffected: ok');
}

/** The role map lists both Box → Google combinations now that both exist. */
function testRoleMapCoversBothCombinations() {
  const roleMap = require('../src/validation/roleMaps/box_to_google');
  assert.deepStrictEqual(
    [...roleMap.combinations].sort(),
    ['box_to_googledrive', 'box_to_googleshareddrive'],
    'box_to_google.js must list both Google destinations'
  );
  console.log('  role map covers both Box → Google combinations: ok');
}

(async () => {
  testRegistration();
  testMyDrivePairUnaffected();
  testRoleMapCoversBothCombinations();
  console.log('boxToGoogleshareddrive.test.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
