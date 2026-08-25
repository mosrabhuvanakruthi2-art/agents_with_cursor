'use strict';

/**
 * Validation must compare the SEEDED folder, not the path sent to CloudFuze.
 *
 * For a Google Shared Drive these differ. CloudFuze only scans a Shared Drive when the request names
 * the DRIVE ("/QA_TeamDrive"), so that is what the migration request carries. But what lands at the
 * destination — and what validation has to compare — is the seeded folder ("/Agent Shared Drive"),
 * which is a child of that drive.
 *
 * deepContentCore.resolveUnits() prefers context.migratedUsers over context.userFolderMappings. When
 * migratedUsers leaked the drive path, validation searched for "QA_TeamDrive" on both sides, found
 * neither, and reported 0 matched / 42 missing against a migration that had just moved 83 items
 * successfully (job 6a8d53d2). The run looked like a total failure and was in fact a total success.
 */

const assert = require('assert');
const core = require('../src/validation/shared/deepContentCore');

const BASE = {
  sourceEmail: 'erik@filefuze.co',
  destinationEmail: 'granger@gajha.com',
  destinationPath: 'QA/Documents',
};

// ── migratedUsers wins, and must carry the seeded folder ──────────────────────
{
  const units = core.resolveUnits({
    ...BASE,
    sourceTestDataPath: '/Agent Shared Drive',
    userFolderMappings: [{ ...BASE, sourcePath: '/Agent Shared Drive' }],
    migratedUsers: [{ ...BASE, sourcePath: '/Agent Shared Drive', requestedSourcePath: '/QA_TeamDrive' }],
  });
  assert.strictEqual(units.length, 1);
  assert.strictEqual(units[0].sourcePath, '/Agent Shared Drive',
    'validation must compare the seeded folder, never the drive named in the CloudFuze request');
  assert.strictEqual(core.lastSegment(units[0].sourcePath), 'Agent Shared Drive',
    'lastSegment drives both the destination probe and the source lookup');
}

// ── The regression itself: a drive path here breaks both lookups ──────────────
{
  const units = core.resolveUnits({
    ...BASE,
    migratedUsers: [{ ...BASE, sourcePath: '/QA_TeamDrive' }],
  });
  assert.strictEqual(core.lastSegment(units[0].sourcePath), 'QA_TeamDrive');
  assert.notStrictEqual(core.lastSegment(units[0].sourcePath), 'Agent Shared Drive',
    'documents the broken shape — migrationClient must not emit it');
}

// ── Fallbacks still work when migratedUsers is absent ────────────────────────
{
  const viaFolders = core.resolveUnits({
    ...BASE,
    userFolderMappings: [{ ...BASE, sourcePath: '/Agent Shared Drive' }],
  });
  assert.strictEqual(viaFolders[0].sourcePath, '/Agent Shared Drive');

  const viaContext = core.resolveUnits({ ...BASE, sourceTestDataPath: '/Agent Shared Drive' });
  assert.strictEqual(viaContext[0].sourcePath, '/Agent Shared Drive');
  assert.strictEqual(viaContext[0].sourceEmail, 'erik@filefuze.co');
}

// ── Multi-user: every unit keeps its own seeded folder ───────────────────────
{
  const units = core.resolveUnits({
    ...BASE,
    migratedUsers: [
      { sourceEmail: 'a@x.co', destinationEmail: 'a@y.co', sourcePath: '/Agent A', destinationPath: 'QA/Documents' },
      { sourceEmail: 'b@x.co', destinationEmail: 'b@y.co', sourcePath: '/Agent B', destinationPath: 'QA/Documents' },
    ],
  });
  assert.deepStrictEqual(units.map((u) => u.sourcePath), ['/Agent A', '/Agent B']);
  assert.deepStrictEqual(units.map((u) => u.sourceEmail), ['a@x.co', 'b@x.co']);
}

console.log('contentValidationUnitPaths.test.js: ok');
