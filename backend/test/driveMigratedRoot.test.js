/**
 * Run: npm test  (from backend/)
 *
 * GoogleDriveValidationAgent.findMigratedRoot — where the comparison starts at a Google
 * destination.
 *
 * Behavioural, not static: driveClient's three lookups are stubbed so the real branching runs.
 *
 * The bug this pins down. migrationClient sends `pickInsideFolder=true` for Dropbox→Google, which
 * tells CloudFuze to migrate the CONTENTS of the source folder rather than the folder itself — so
 * nothing named after the source folder is ever created at the destination. findMigratedRoot
 * searched for exactly that name and returned null, which the caller reports as "the migration
 * appears to have created nothing".
 *
 * Job 6a982af3b17d0e315c80eb2c moved 67/67 items, CloudFuze said "Processed", all 12 items were
 * sitting at the Shared Drive root — and the report read FAIL with all 36 documented features
 * "not assessed".
 *
 * The fallback cannot manufacture a pass: the tree comparison still has to match every source
 * item, so a genuinely empty destination reports each one missing. Same verdict, more detail.
 */
const assert = require('assert');
const Agent = require('../src/agents/googledrive/GoogleDriveValidationAgent');
const driveClient = require('../src/clients/driveClient');

const DRIVE_ID = '0ABHjC_xyzgvYUk9PVA';
const DRIVE_NAME = 'QA-Automation-Dropbox-Dest';
const EMAIL = 'erik@filefuze.co';

/** Swap in stubs, run, always restore — a leaked stub would corrupt later tests in the chain. */
async function withStubs(stubs, fn) {
  const saved = {};
  for (const k of Object.keys(stubs)) {
    saved[k] = driveClient[k];
    driveClient[k] = stubs[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) driveClient[k] = saved[k];
  }
}

const driveStub = { getSharedDriveById: async () => ({ id: DRIVE_ID, name: DRIVE_NAME }) };

/**
 * The regression: destination path names the drive, no wrapper folder exists.
 * Must resolve to the drive root, not null.
 */
async function testPickInsideFolderNoWrapper() {
  const root = await withStubs({
    ...driveStub,
    resolveFolderByPath: async () => null,
    findByName: async () => null,               // no "qa-automation" folder — by design
  }, () => new Agent().findMigratedRoot(DRIVE_ID, DRIVE_ID, `/${DRIVE_NAME}`, 'qa-automation', EMAIL));

  assert.ok(root, 'a destination holding the migrated contents is not "nothing created"');
  assert.strictEqual(root.id, DRIVE_ID, 'the comparison starts at the Shared Drive root');
  assert.strictEqual(root.path, '/', 'and its path is the root');
  console.log('  pickInsideFolder migration resolves to the drive root: ok');
}

/** A real wrapper folder still wins when CloudFuze does create one. */
async function testWrapperFolderStillPreferred() {
  const root = await withStubs({
    ...driveStub,
    resolveFolderByPath: async () => null,
    findByName: async (name) => (name === 'qa-automation' ? { id: 'FOLDER1', name } : null),
  }, () => new Agent().findMigratedRoot(DRIVE_ID, DRIVE_ID, `/${DRIVE_NAME}`, 'qa-automation', EMAIL));

  assert.strictEqual(root.id, 'FOLDER1', 'the wrapper folder is preferred over the root');
  assert.strictEqual(root.path, '/qa-automation');
  console.log('  a real wrapper folder still wins: ok');
}

/** Dedup variants keep working — a renamed landing folder must not read as everything missing. */
async function testDedupVariant() {
  const root = await withStubs({
    ...driveStub,
    resolveFolderByPath: async () => null,
    findByName: async (name) => (name === 'qa-automation 1' ? { id: 'FOLDER2', name } : null),
  }, () => new Agent().findMigratedRoot(DRIVE_ID, DRIVE_ID, `/${DRIVE_NAME}`, 'qa-automation', EMAIL));

  assert.strictEqual(root.id, 'FOLDER2', 'a dedup-suffixed folder is found');
  console.log('  dedup variant still found: ok');
}

/**
 * A named SUBPATH that does not exist must still return null.
 *
 * This is the case the fallback must NOT swallow: the run targeted a specific folder inside the
 * drive, and that folder is absent. Falling back to the drive root there would compare against
 * unrelated content sitting beside it.
 */
async function testMissingSubpathStillNull() {
  const root = await withStubs({
    ...driveStub,
    resolveFolderByPath: async () => null,
    findByName: async () => null,
  }, () => new Agent().findMigratedRoot(
    DRIVE_ID, DRIVE_ID, `/${DRIVE_NAME}/Some-Subfolder`, 'qa-automation', EMAIL));

  assert.strictEqual(root, null,
    'a named subpath that does not exist is still reported as nothing created');
  console.log('  missing named subpath still returns null: ok');
}

/** An explicit destination subpath that DOES resolve wins over everything. */
async function testExplicitSubpathWins() {
  const root = await withStubs({
    ...driveStub,
    resolveFolderByPath: async (base) => (base === 'Some-Subfolder'
      ? { id: 'SUB1', name: 'Some-Subfolder', path: '/Some-Subfolder' } : null),
    findByName: async () => ({ id: 'SHOULD_NOT_WIN', name: 'qa-automation' }),
  }, () => new Agent().findMigratedRoot(
    DRIVE_ID, DRIVE_ID, `/${DRIVE_NAME}/Some-Subfolder`, 'qa-automation', EMAIL));

  assert.strictEqual(root.id, 'SUB1', 'the resolved destination subpath wins');
  console.log('  explicit destination subpath wins: ok');
}

/** My Drive (no driveId) is untouched by the change. */
async function testMyDriveUnaffected() {
  const root = await withStubs({
    ...driveStub,
    resolveFolderByPath: async () => null,
    findByName: async () => null,
  }, () => new Agent().findMigratedRoot('root', null, '', 'qa-automation', EMAIL));

  assert.strictEqual(root, null,
    'My Drive with no destination path and no wrapper is unchanged — the drive-root fallback is '
    + 'gated on the path having named the Shared Drive');
  console.log('  My Drive path unaffected: ok');
}

(async () => {
  await testPickInsideFolderNoWrapper();
  await testWrapperFolderStillPreferred();
  await testDedupVariant();
  await testMissingSubpathStillNull();
  await testExplicitSubpathWins();
  await testMyDriveUnaffected();
  console.log('driveMigratedRoot.test.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
