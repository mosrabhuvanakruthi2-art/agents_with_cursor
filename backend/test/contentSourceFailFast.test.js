/**
 * Run: npm test  (from backend/)
 *
 * A content run must not start when nothing will ever give it a source folder.
 *
 * Execution e215d157 (15-Sep-2026, googledrive → googledrive) is the case. At the time that
 * combination registered no TestDataAgent — it has one now — and the run was started with "Use
 * existing source folder" unticked. So:
 *
 *   Step 1: Skipped (no TestDataAgent registered for this combination)
 *
 * left context.userFolderMappings empty, and migrationClient's fallback
 *
 *   const sourcePath = pathOverride || context.sourceTestDataPath || context.sourcePath || '/';
 *
 * turned that into the whole account. The path CSV CloudFuze received was:
 *
 *   Source User,Source Folder,Destination User,Destination Path
 *   mia@cloudfuze.com,/,erik@filefuze.co,/mydrive-mydrive-qa-agent
 *
 * Source Folder "/" is all of mia's My Drive, not the "mydrive-mydrive" folder the run named. The
 * job reached CONFLICT with totalFilesAndFolders=0 for an unrelated reason — a 401 on the source
 * cloud — so the copy never happened. Nothing in the flow would have stopped it if the token had
 * been valid.
 *
 * The useExistingSource branches already refuse for exactly this reason ("falls back to the drive
 * root, which is never what was asked for"). The seeding path had no equivalent check. Two guards
 * now close it: a fail-fast one before CleanupAgent, and a catch-all after Step 1.
 *
 * The condition is asserted through the exported predicate rather than by driving runFullFlow: the
 * guard sits one line before CleanupAgent, which talks to both clouds, so every arm of the
 * condition is checkable directly while the placement is checked on the source.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const orchestrator = require('../src/orchestrator/AgentOrchestrator');
const { contentRunHasNoPossibleSource } = orchestrator;
const { list: listCombinations } = require('../src/orchestrator/agentRegistry');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'orchestrator', 'AgentOrchestrator.js'), 'utf8');

const CONTENT = { isContentMode: true, hasTestDataAgent: false };

/** The e215d157 configuration itself: content, no seeding agent, no existing-source tick. */
function testTheRunThatBrokeIsRefused() {
  assert.strictEqual(contentRunHasNoPossibleSource({}, CONTENT), true,
    'a content run with no TestDataAgent and no useExistingSource is refused');
  console.log('  the e215d157 configuration is refused: ok');
}

/** Each arm has to be load-bearing, or the guard would refuse runs that are perfectly fine. */
function testEveryEscapeIsHonoured() {
  assert.strictEqual(
    contentRunHasNoPossibleSource({ useExistingSource: true }, CONTENT), false,
    'ticking "Use existing source folder" is the documented fix, so it must not be refused');

  assert.strictEqual(
    contentRunHasNoPossibleSource({}, { isContentMode: true, hasTestDataAgent: true }), false,
    'a combination that seeds its own data has a source folder by Step 1');

  assert.strictEqual(
    contentRunHasNoPossibleSource({}, { isContentMode: false, hasTestDataAgent: false }), false,
    'mail runs have no content source folder and must be untouched');

  assert.strictEqual(
    contentRunHasNoPossibleSource({ skipMigration: true }, CONTENT), false,
    'a resume that has already migrated needs no source folder');

  console.log('  useExistingSource / seeding combos / mail / resume are all still allowed: ok');
}

/** The diagnostic override names a path directly, so it satisfies the requirement. */
function testPathOverrideIsHonoured() {
  const env = require('../src/config/env');
  const before = env.CONTENT_SOURCE_PATH_OVERRIDE;
  try {
    env.CONTENT_SOURCE_PATH_OVERRIDE = '/Some/Diagnostic/Folder';
    assert.strictEqual(contentRunHasNoPossibleSource({}, CONTENT), false,
      'CONTENT_SOURCE_PATH_OVERRIDE supplies the source path, so the run is allowed');
  } finally {
    env.CONTENT_SOURCE_PATH_OVERRIDE = before;
  }
  console.log('  CONTENT_SOURCE_PATH_OVERRIDE still works as the escape hatch: ok');
}

/**
 * Placement is the half that cost e215d157 its source data. CleanupAgent empties the seeded folders
 * on BOTH sides, so a refusal that lands after Step 0 still destroys what the user had.
 */
function testItRefusesBeforeCleanupRuns() {
  // The CALL SITE, not the function definition — the definition sits at module level, well above
  // runFullFlow, so matching it would make every ordering assertion below pass for free.
  const guardIdx = src.indexOf('if (contentRunHasNoPossibleSource(context, {');
  const cleanupIdx = src.indexOf("log.info('Step 0: Running CleanupAgent')");
  assert.ok(guardIdx > -1, 'the fail-fast guard is wired into runFullFlow');
  assert.ok(cleanupIdx > -1, 'Step 0 still runs CleanupAgent');
  assert.ok(guardIdx < cleanupIdx,
    'the refusal is evaluated BEFORE CleanupAgent — refusing afterwards still empties the folders');

  // …and inside the try, so the existing catch marks the execution FAILED rather than leaving it
  // RUNNING with a rejected promise.
  const tryIdx = src.search(/ {4}try \{\r?\n {6}\/\/ ── Fail fast/);
  assert.ok(tryIdx > -1 && tryIdx < guardIdx,
    'the guard sits inside the try block, so the execution is marked FAILED');
  console.log('  the refusal happens before CleanupAgent, inside the try: ok');
}

/** A second guard after Step 1 for seeding that runs but produces nothing. */
function testCatchAllAfterSeeding() {
  const idx = src.indexOf('Content run has no source folder to migrate');
  assert.ok(idx > -1, 'the post-Step-1 catch-all exists');
  const block = src.slice(idx - 1200, idx + 900);
  assert.ok(/throw new Error\(/.test(block), 'it throws rather than warns');
  assert.ok(/userFolderMappings \|\| \[\]\)\.length > 0/.test(block)
    && /context\.sourceTestDataPath/.test(block),
    'it accepts EITHER a per-user mapping or a single seeded path');
  console.log('  seeding that produces nothing is caught after Step 1 too: ok');
}

/** The message has to name the fix. "Refusing to run" alone sends someone back to the logs. */
function testMessageNamesTheFix() {
  const idx = src.indexOf('No TestDataAgent is registered for');
  assert.ok(idx > -1, 'the refusal names the missing agent');
  const block = src.slice(idx, idx + 700);
  assert.ok(/Use existing source folder/.test(block),
    'and tells the user which box to tick');
  assert.ok(/drive root/.test(block),
    'and says what the fallback would have done, so the severity is clear');
  console.log('  the refusal names the cause and the fix: ok');
}

/**
 * The registry flag the run wizard warns from. Behavioural: a content combination registered without
 * a TestDataAgent should surface HERE, not at run time, because that is the shape that produced
 * e215d157. Every content combination can seed today, so the list is empty.
 */
function testRegistryReportsWhoCanSeed() {
  const content = listCombinations().filter((c) => c.domain === 'content');
  assert.ok(content.length > 0, 'content combinations are registered');

  const noSeed = content
    .filter((c) => !c.seedsTestData)
    .map((c) => `${c.sourceProvider} → ${c.destinationProvider}`);

  // Every content combination can now seed — googledrive → googledrive was the last one that could
  // not, and it gained DriveTestDataAgent so an unticked "Use existing source folder" still has a
  // source. The guard stays: it is what catches the NEXT combination registered without a seeder,
  // which is exactly how e215d157 reached CloudFuze with "/" as its source folder.
  assert.deepStrictEqual(noSeed, [],
    'no content combination is left without a seeder; one that is would need the wizard warning '
    + 'and would be refused by the fail-fast guard rather than migrating the drive root');

  for (const c of content) {
    assert.strictEqual(typeof c.seedsTestData, 'boolean',
      `${c.sourceProvider} → ${c.destinationProvider} reports seedsTestData as a boolean for the wizard`);
  }
  console.log('  the registry reports which combinations can seed: ok');
}

testTheRunThatBrokeIsRefused();
testEveryEscapeIsHonoured();
testPathOverrideIsHonoured();
testItRefusesBeforeCleanupRuns();
testCatchAllAfterSeeding();
testMessageNamesTheFix();
testRegistryReportsWhoCanSeed();
console.log('Content source fail-fast: all assertions passed');
