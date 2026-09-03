/**
 * Run: npm test  (from backend/)
 *
 * Pre-creating the destination folder for a Shared Drive destination.
 *
 * AgentOrchestrator pre-creates each row's destination folder before the migration is triggered,
 * because whether CloudFuze creates a missing path segment has never been established on this
 * server — and a missing one risks the job resolving to the wrong root. That block was gated on
 * SharePoint only, so Google destinations got nothing: every Dropbox→Google run that worked had a
 * destination folder left over from an earlier attempt, and the first run to hit a genuinely new
 * path failed with a "wrong CSV paths" CONFLICT.
 *
 * The Shared Drive branch cannot share the My Drive one, and that is what these tests protect. For
 * a Shared Drive destination the FIRST path segment names the DRIVE — resolved by name, and it must
 * already exist. Walking the whole path with a folder-creating helper would create a folder named
 * after the drive inside the destination user's My Drive: the wrong tree, and a fresh instance of
 * the very failure the pre-create exists to prevent.
 *
 * The path rule is tested for real against deepContentCore. The wiring is asserted on the source,
 * because the branch sits mid-flight in runFullFlow between live CloudFuze calls — a behavioural
 * test would need the whole migration stood up against a stubbed server, and what matters here is
 * checkable directly: that the drive is resolved rather than created, and that only the segments
 * BELOW it are ever handed to ensureFolderPath.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const core = require('../src/validation/shared/deepContentCore');
const driveClient = require('../src/clients/driveClient');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'orchestrator', 'AgentOrchestrator.js'), 'utf8');

/** The branch that follows `} else if (… === 'googleshareddrive') {`, to its closing brace. */
function sharedDriveBranch() {
  const start = src.indexOf("context.destinationProvider === 'googleshareddrive'");
  assert.ok(start > -1, 'a googleshareddrive branch exists in AgentOrchestrator');
  // Bounded by the next else-if or the end of the pre-create region; 3000 chars covers the block.
  return src.slice(start, start + 3000);
}

/**
 * The path rule, tested against the real helper: segment 1 is the drive, the rest are folders.
 *
 * This is the decomposition the branch performs, so if segmentsOf ever changes its handling of
 * leading slashes or blank segments, the drive and the folders would be taken from the wrong
 * positions and this fails rather than a live run doing it silently.
 */
function testFirstSegmentIsTheDrive() {
  const cases = [
    ['/QA-Automation-Dropbox-Dest', 'QA-Automation-Dropbox-Dest', ''],
    ['/QA-Automation-Dropbox-Dest/Sub', 'QA-Automation-Dropbox-Dest', 'Sub'],
    ['QA-Automation-Dropbox-Dest/A/B', 'QA-Automation-Dropbox-Dest', 'A/B'],
    ['  /Spaced Drive/Inner/  ', 'Spaced Drive', 'Inner'],
    ['//Double//Slash//Deep', 'Double', 'Slash/Deep'],
  ];

  for (const [input, wantDrive, wantSub] of cases) {
    const segs = core.segmentsOf(input);
    assert.strictEqual(segs[0], wantDrive,
      `${JSON.stringify(input)}: first segment is the drive`);
    assert.strictEqual(segs.slice(1).join('/'), wantSub,
      `${JSON.stringify(input)}: the remainder is what gets created inside it`);
  }

  // A path naming nothing must yield no drive, so the branch skips instead of asking the Drive API
  // for a drive called "".
  for (const empty of ['', '/', '   ', '///']) {
    assert.deepStrictEqual(core.segmentsOf(empty), [],
      `${JSON.stringify(empty)} names no drive`);
  }
  console.log('  first segment is the drive, remainder is the folder path: ok');
}

/** The helpers the branch depends on must exist with the shapes it calls them by. */
function testHelpersExist() {
  assert.strictEqual(typeof driveClient.ensureFolderPath, 'function',
    'driveClient.ensureFolderPath exists');
  assert.strictEqual(typeof driveClient.resolveSharedDriveByName, 'function',
    'driveClient.resolveSharedDriveByName exists');
  // ensureFolderPath(path, email, opts) — the rootId option is how the walk is scoped to the drive.
  assert.ok(/function ensureFolderPath\(path, email, opts/.test(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'clients', 'driveClient.js'), 'utf8')),
  'ensureFolderPath takes an opts object, which is where rootId is passed');
  console.log('  drive helpers present with the expected signatures: ok');
}

/**
 * The drive is RESOLVED, never created — and only the segments below it are created.
 *
 * These two together are the whole point of the separate branch. If ensureFolderPath were ever
 * handed the full path, the drive's name would be created as an ordinary folder in the wrong tree.
 */
function testDriveIsResolvedNotCreated() {
  const block = sharedDriveBranch();

  assert.ok(/resolveSharedDriveByName\(/.test(block),
    'the drive is looked up by name');
  assert.ok(/segs\.slice\(1\)/.test(block),
    'only the segments BELOW the drive are used for folder creation');
  assert.ok(/rootId: drive\.id/.test(block),
    'the folder walk is scoped to the drive, whose id doubles as its root folder id');

  // Nothing in this branch may create the drive itself.
  assert.ok(!/createSharedDrive|drives\.create/.test(block),
    'a QA run must not bring a Shared Drive into existence as a side effect');
  console.log('  drive resolved and scoped, never created: ok');
}

/** An unresolvable drive is skipped, not thrown — the read side gives the better error. */
function testUnresolvableDriveIsNonBlocking() {
  const block = sharedDriveBranch();
  const notFound = block.indexOf('if (!drive)');
  assert.ok(notFound > -1, 'the not-found case is handled explicitly');

  const handler = block.slice(notFound, notFound + 500);
  assert.ok(/log\.warn/.test(handler), 'it warns');
  assert.ok(/continue/.test(handler),
    'and continues to the next path — one bad drive must not stop the others');
  assert.ok(!/throw /.test(handler),
    'it does not throw: resolveDestinationRoot already fails with the available drives listed, '
    + 'which is the more useful error');
  console.log('  unresolvable drive skipped, not thrown: ok');
}

/**
 * segmentsOf, never inDrivePath.
 *
 * inDrivePath strips a segment matching /^documents$/i because SharePoint mappings are written as
 * "<Site>/Documents/<subpath>". A Google drive or folder legitimately named "Documents" would be
 * silently stripped, and the pre-create would prepare a different folder from the one the migration
 * writes into.
 */
function testUsesSegmentsOfNotInDrivePath() {
  const block = sharedDriveBranch();
  assert.ok(/segmentsOf\(/.test(block), 'the branch decomposes the path with segmentsOf');
  assert.ok(!/inDrivePath/.test(block),
    'inDrivePath must not be used here — it would strip a folder named "Documents"');

  // Guard the claim itself: if inDrivePath ever stopped stripping, this test would be protecting
  // nothing, so assert the behaviour it is written against.
  assert.strictEqual(core.inDrivePath('/Site/Documents/Sub'), '/Sub',
    'inDrivePath does strip up to a Documents segment, which is why it is wrong for Google');
  assert.strictEqual(core.segmentsOf('/Documents/Sub').join('/'), 'Documents/Sub',
    'segmentsOf keeps a folder named Documents intact');
  console.log('  path decomposed with segmentsOf, not inDrivePath: ok');
}

/** My Drive must not be reachable from this branch, or it would create folders in the wrong tree. */
function testMyDriveIsASeparateBranch() {
  const shared = src.indexOf("context.destinationProvider === 'googleshareddrive'");
  const mine = src.indexOf("context.destinationProvider === 'googledrive'");
  assert.ok(mine > -1 && shared > -1, 'both branches exist');
  assert.ok(mine < shared,
    'the exact googledrive test comes first, so googleshareddrive cannot fall into it');

  // The My Drive branch must test for equality, not a substring: 'googleshareddrive'.includes
  // ('googledrive') is false, but a /drive/ style regex would catch both and reintroduce the bug.
  const myBlock = src.slice(mine - 60, mine + 60);
  assert.ok(/===\s*'googledrive'/.test(myBlock),
    'My Drive is matched by exact equality, not a pattern that could also match a Shared Drive');
  console.log('  My Drive and Shared Drive are separate, exactly-matched branches: ok');
}

testFirstSegmentIsTheDrive();
testHelpersExist();
testDriveIsResolvedNotCreated();
testUnresolvableDriveIsNonBlocking();
testUsesSegmentsOfNotInDrivePath();
testMyDriveIsASeparateBranch();
console.log('sharedDrivePreCreate.test.js: ok');
