/**
 * Run: npm test  (from backend/)
 *
 * Dropbox → Google Shared Drive. The combination is a registration over the My Drive pair's agents,
 * mirroring how googleshareddrive → sharepoint reuses the googledrive → sharepoint validator. What
 * is asserted here is everything that would otherwise only fail during a live run, and would fail
 * in a way that reads like a migration defect rather than a configuration error:
 *
 *   - the registry resolves the pair at all (an unregistered pair dies at agent resolution, before
 *     any validation, so the run reports nothing rather than failing)
 *   - it resolves to the SAME agents as the My Drive pair, since the whole point is reuse
 *   - a Shared Drive destination with no drive name is refused, instead of silently validating
 *     against My Drive and reporting the entire tree as missing
 *
 * No network is exercised. resolveDestinationRoot throws on a missing drive name before it reaches
 * the Drive API, which is exactly why that case is testable offline.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const registry = require('../src/orchestrator/agentRegistry');
const ValidationAgent = require('../src/validation/combinations/content/dropboxToGoogledrive');
const GoogleDriveValidationAgent = require('../src/agents/googledrive/GoogleDriveValidationAgent');
const DropboxTestDataAgent = require('../src/agents/dropbox/DropboxTestDataAgent');
const env = require('../src/config/env');

/** The pair resolves, and to the same agents the My Drive pair uses. */
function testRegistration() {
  const entry = registry.resolve('content', 'dropbox', 'googleshareddrive');
  assert.ok(entry, 'content:dropbox:googleshareddrive is registered');

  assert.strictEqual(entry.TestDataAgent, DropboxTestDataAgent,
    'the Dropbox source is seeded by the same agent as the My Drive pair');
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
  const mine = registry.resolve('content', 'dropbox', 'googleshareddrive');
  const hers = registry.resolve('content', 'dropbox', 'googledrive');
  assert.ok(hers, 'content:dropbox:googledrive is still registered');
  assert.strictEqual(hers.ValidationAgent, mine.ValidationAgent, 'both pairs share one validator');
  assert.strictEqual(hers.TestDataAgent, mine.TestDataAgent, 'both pairs share one seeding agent');

  const pairs = registry.list()
    .filter((p) => p.domain === 'content' && p.sourceProvider === 'dropbox')
    .map((p) => p.destinationProvider)
    .sort();
  assert.deepStrictEqual(pairs, ['googledrive', 'googleshareddrive'],
    'exactly the two Dropbox content pairs are registered');

  console.log('  My Drive pair unaffected: ok');
}

/**
 * A Shared Drive destination is resolved BY NAME. With no name the agent must refuse.
 *
 * The dangerous alternative is falling through to the My Drive branch: rootId 'root' is a valid
 * root, so validation would run to completion against the wrong tree and report every migrated item
 * missing. That reads as total data loss when it is in fact an unset field.
 */
async function testSharedDriveRequiresAName() {
  const agent = new GoogleDriveValidationAgent();

  // Pin the configured default empty. resolveDestinationRoot now falls back to
  // env.GOOGLE_DEST_SHARED_DRIVE_NAME, so without this the outcome would depend on whether the
  // machine's .env happens to set it — and the test would START FAILING the moment an operator set
  // it, which is exactly what we ask them to do. Restored below.
  const configuredDefault = env.GOOGLE_DEST_SHARED_DRIVE_NAME;
  env.GOOGLE_DEST_SHARED_DRIVE_NAME = '';

  await assert.rejects(
    () => agent.resolveDestinationRoot({
      destinationEmail: 'erik@filefuze.co',
      destinationProvider: 'googleshareddrive',
    }),
    /no drive name was supplied|cannot be resolved without it/i,
    'a Shared Drive destination without a name is refused, never treated as My Drive'
  );

  // Blank and whitespace-only are the same mistake arriving by a different route.
  for (const name of ['', '   ']) {
    await assert.rejects(
      () => agent.resolveDestinationRoot({
        destinationEmail: 'erik@filefuze.co',
        destinationProvider: 'googleshareddrive',
        destinationSharedDriveName: name,
      }),
      /no drive name was supplied|cannot be resolved without it/i,
      `a ${JSON.stringify(name)} drive name is refused`
    );
  }

  // A destination path of "/" names no drive, so it must be refused too rather than resolving to
  // an empty name and asking the Drive API for a drive called "".
  await assert.rejects(
    () => agent.resolveDestinationRoot({
      destinationEmail: 'erik@filefuze.co',
      destinationProvider: 'googleshareddrive',
      destinationPath: '/',
    }),
    /no drive name was supplied|cannot be resolved without it/i,
    'a destination path naming no drive is refused'
  );

  env.GOOGLE_DEST_SHARED_DRIVE_NAME = configuredDefault;
  console.log('  shared drive without a name is refused: ok');
}

/**
 * The drive name may arrive as the run's destination path — the wizard collects that field, and
 * nothing in this repo ever sets destinationSharedDriveName or destinationFolderName.
 *
 * Asserted through the error message rather than a live lookup: with a name present the agent
 * reaches the Drive API, and what matters here is WHICH name it carried there.
 */
async function testDriveNameFromDestinationPath() {
  const agent = new GoogleDriveValidationAgent();

  const cases = [
    ['/QA-Automation-Dropbox-Dest', 'QA-Automation-Dropbox-Dest'],
    ['QA-Automation-Dropbox-Dest/', 'QA-Automation-Dropbox-Dest'],
    ['/QA-Automation-Dropbox-Dest/Sub/Deeper', 'QA-Automation-Dropbox-Dest'],
    ['  /Spaced Drive/  ', 'Spaced Drive'],
  ];

  for (const [destinationPath, expected] of cases) {
    await assert.rejects(
      () => agent.resolveDestinationRoot({
        destinationEmail: 'nobody@example.invalid',
        destinationProvider: 'googleshareddrive',
        destinationPath,
      }),
      (err) => {
        // Either it reached the lookup and reported the name it used, or auth failed first —
        // both prove the name was extracted, and neither is the "no drive name" refusal.
        assert.ok(!/no drive name was supplied/i.test(err.message),
          `${JSON.stringify(destinationPath)} must yield a drive name, not a refusal`);
        if (/not found for/.test(err.message)) {
          assert.ok(err.message.includes(`"${expected}"`),
            `expected the drive name ${JSON.stringify(expected)} in: ${err.message}`);
        }
        return true;
      }
    );
  }

  // An explicit name still wins over the path — the path is a fallback, not an override.
  await assert.rejects(
    () => agent.resolveDestinationRoot({
      destinationEmail: 'nobody@example.invalid',
      destinationProvider: 'googleshareddrive',
      destinationSharedDriveName: 'Explicit Drive',
      destinationPath: '/Path Drive/sub',
    }),
    (err) => {
      if (/not found for/.test(err.message)) {
        assert.ok(err.message.includes('"Explicit Drive"'),
          `the explicit name must win: ${err.message}`);
      }
      return true;
    }
  );

  console.log('  drive name resolved from the destination path: ok');
}

/** My Drive still resolves to the literal 'root' with no driveId — the two shapes stay distinct. */
async function testMyDriveRootShape() {
  const agent = new GoogleDriveValidationAgent();

  for (const provider of ['googledrive', undefined]) {
    const root = await agent.resolveDestinationRoot({
      destinationEmail: 'erik@filefuze.co',
      destinationProvider: provider,
    });
    assert.strictEqual(root.rootId, 'root', "My Drive's root id is the literal string 'root'");
    assert.strictEqual(root.driveId, null, 'My Drive has no drive id');
    assert.strictEqual(root.label, 'My Drive');
  }

  console.log('  My Drive root shape: ok');
}

/**
 * The Dropbox→Google gate must match BOTH Google destinations by their REGISTERED cloud names.
 *
 * CloudFuze registers My Drive as `G_SUITE`, which does not start with "GOOGLE". A pattern of
 * `/GOOGLE(_SHARED_DRIVES|DRIVE|_DRIVE|_SUITE)/i` puts `_SUITE` inside the GOOGLE(...) group, so it
 * matches only the non-existent "GOOGLE_SUITE" — My Drive fell out of the gate and lost
 * `pickInsideFolder` and `papertoGDoc`, i.e. every one of the 19 Paper features in §10.
 *
 * Asserted on the pattern itself: the gate is a local inside triggerMigration and cannot be called
 * without a live server, but the matching rule is the whole defect.
 */
function testGoogleDestinationNamesMatch() {
  const gate = /(GOOGLE|G_SUITE)/i;
  for (const registered of ['GOOGLE_SHARED_DRIVES', 'G_SUITE', 'GOOGLEDRIVE', 'GOOGLE_DRIVE']) {
    assert.ok(gate.test(registered), `${registered} must satisfy the Dropbox→Google gate`);
  }
  // The old pattern, kept as a regression witness: it missed the very pair the gate exists for.
  const broken = /GOOGLE(_SHARED_DRIVES|DRIVE|_DRIVE|_SUITE)/i;
  assert.ok(!broken.test('G_SUITE'),
    'documents the defect: the previous pattern could never match My Drive');
  assert.ok(gate.test('G_SUITE'), 'the fixed pattern matches My Drive');

  // A non-Google destination must NOT satisfy it, or Box/SharePoint runs would take the
  // Dropbox→Google payload shape.
  for (const other of ['BOX_BUSINESS', 'SHAREPOINT_ONLINE_BUSINESS', 'ONEDRIVE_BUSINESS_ADMIN']) {
    assert.ok(!gate.test(other), `${other} must not satisfy the Dropbox→Google gate`);
  }
  console.log('  Dropbox→Google gate matches both Google cloud names: ok');
}

/**
 * Every provider the content registry can resolve must appear in CONTENT_PROVIDERS.
 *
 * `googleshareddrive` was missing. Live pairs survived by accident — googleshareddrive→sharepoint
 * matches on its destination, dropbox→googleshareddrive on its source — so the first pair to break
 * would have been Shared-Drive-to-Shared-Drive or Shared-Drive-to-Drive.
 */
function testContentProvidersCoversRegistry() {
  const orchestrator = require('../src/orchestrator/AgentOrchestrator');
  const listed = orchestrator.CONTENT_PROVIDERS;
  assert.ok(Array.isArray(listed) && listed.length, 'CONTENT_PROVIDERS is exported');

  const registered = registry.list()
    .filter((p) => p.domain === 'content')
    .flatMap((p) => [p.sourceProvider, p.destinationProvider]);
  const missing = [...new Set(registered)].filter((p) => !listed.includes(p));
  assert.deepStrictEqual(missing, [],
    `every registered content provider must be in CONTENT_PROVIDERS; missing: ${missing.join(', ')}`);

  // The pair that would have exposed the gap: both sides are Shared Drive, so neither side could
  // be carried by the other.
  assert.strictEqual(
    orchestrator.isContentProvidersFor({
      sourceProvider: 'googleshareddrive',
      destinationProvider: 'googleshareddrive',
    }),
    true,
    'a Shared-Drive-to-Shared-Drive pair must be recognised as content providers'
  );
  // And a mail pair must still not be.
  assert.strictEqual(
    orchestrator.isContentProvidersFor({ sourceProvider: 'google', destinationProvider: 'microsoft' }),
    false,
    'a mail pair must not be treated as content'
  );

  console.log('  CONTENT_PROVIDERS covers every registered content provider: ok');
}

/**
 * GOOGLE_DEST_SHARED_DRIVE_NAME is honoured, and ranks LAST behind the run's own fields.
 *
 * .env.example documented this variable when the Shared Drive groundwork landed, but nothing in
 * backend/src read it — so a run that named no drive was refused while the operator had set exactly
 * the default the file told them to set. Precedence matters as much as presence: a per-run
 * destination must never be overridden by a global default, or one run's drive silently validates
 * against another's.
 *
 * Asserted through the error message rather than a live lookup — with a name present the agent
 * reaches the Drive API, and what matters is WHICH name it carried there.
 */
async function testEnvDefaultIsLastResort() {
  const agent = new GoogleDriveValidationAgent();
  const configuredDefault = env.GOOGLE_DEST_SHARED_DRIVE_NAME;

  try {
    env.GOOGLE_DEST_SHARED_DRIVE_NAME = 'Env-Default-Drive';

    // Nothing on the context: the configured default is used instead of a refusal.
    await assert.rejects(
      () => agent.resolveDestinationRoot({
        destinationEmail: 'nobody@example.invalid',
        destinationProvider: 'googleshareddrive',
      }),
      (err) => {
        assert.ok(!/no drive name was supplied/i.test(err.message),
          'the configured default must be used, not refused');
        if (/not found for/.test(err.message)) {
          assert.ok(err.message.includes('"Env-Default-Drive"'),
            `expected the env default to be the name looked up, got: ${err.message}`);
        }
        return true;
      }
    );

    // The run's own destination path outranks it.
    await assert.rejects(
      () => agent.resolveDestinationRoot({
        destinationEmail: 'nobody@example.invalid',
        destinationProvider: 'googleshareddrive',
        destinationPath: '/Explicit-Drive',
      }),
      (err) => {
        if (/not found for/.test(err.message)) {
          assert.ok(err.message.includes('"Explicit-Drive"'),
            `the run's own path must win over the env default, got: ${err.message}`);
          assert.ok(!err.message.includes('Env-Default-Drive'),
            'the env default must not override a per-run destination');
        }
        return true;
      }
    );
  } finally {
    env.GOOGLE_DEST_SHARED_DRIVE_NAME = configuredDefault;
  }

  console.log('  configured default honoured, and ranked last: ok');
}

/**
 * The permission settle window is configurable, and its default is unchanged.
 *
 * It was hardcoded at 2 attempts x 8000ms — 16 seconds against a delay measured at about 25 MINUTES
 * on run dbx-gsd-1788417784387, where five items reported no destination grants at validation time
 * and a direct read later showed every grant present. 16s only ever caught the fast cases, so
 * features 2.1-2.5 reported "not judgeable yet" instead of a verdict.
 *
 * Asserted here because the default must NOT drift: raising it silently would add wall-clock to
 * every run that has a genuinely unshared item, and lowering it would quietly give up sooner.
 */
function testSettleWindowIsConfigurable() {
  // Read the DEFAULTS in a child process with the variables blanked, not from this process's env.
  //
  // Asserting env.CONTENT_PERMISSION_SETTLE_ATTEMPTS directly was wrong and broke the moment an
  // operator set it in .env — which is exactly what we ask them to do. A test that fails when the
  // configuration is correct is worse than no test. dotenv does not override an already-set
  // variable, so blanking it in the child env makes parseInt('') fall through to the default.
  const probe = 'const e=require("./src/config/env");'
    + 'process.stdout.write(e.CONTENT_PERMISSION_SETTLE_ATTEMPTS+","+e.CONTENT_PERMISSION_SETTLE_MS);';
  const out = require('child_process').execFileSync(process.execPath, ['-e', probe], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, CONTENT_PERMISSION_SETTLE_ATTEMPTS: '', CONTENT_PERMISSION_SETTLE_MS: '' },
    encoding: 'utf8',
  });
  const [attempts, ms] = out.trim().split(',').map(Number);
  assert.strictEqual(attempts, 2, `the DEFAULT attempt count is 2, got ${attempts}`);
  assert.strictEqual(ms, 8000, `the DEFAULT interval is 8000ms, got ${ms}`);

  // Whatever this machine is configured with must still be usable: a negative attempt count or a
  // non-positive interval would make the wait meaningless.
  assert.ok(env.CONTENT_PERMISSION_SETTLE_ATTEMPTS >= 0,
    'the configured attempt count is 0 or more — 0 disables the wait for a fast smoke run');
  assert.ok(env.CONTENT_PERMISSION_SETTLE_MS > 0, 'the configured interval is positive');

  // The validator must READ the configured values rather than carry its own copy.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'validation', 'combinations',
    'content', 'dropboxToGoogledrive.js'), 'utf8');
  assert.ok(/const PERMISSION_SETTLE_ATTEMPTS = env.CONTENT_PERMISSION_SETTLE_ATTEMPTS;/.test(src),
    'the attempt count comes from config, not a literal');
  assert.ok(/const PERMISSION_SETTLE_MS = env.CONTENT_PERMISSION_SETTLE_MS;/.test(src),
    'the interval comes from config, not a literal');
  assert.ok(!/const PERMISSION_SETTLE_ATTEMPTS = [0-9]/.test(src),
    'no hardcoded attempt count remains');
  console.log('  permission settle window configurable, defaults pinned: ok');
}

(async () => {
  testContentProvidersCoversRegistry();
  testGoogleDestinationNamesMatch();
  testRegistration();
  testMyDrivePairUnaffected();
  await testSharedDriveRequiresAName();
  await testDriveNameFromDestinationPath();
  await testEnvDefaultIsLastResort();
  testSettleWindowIsConfigurable();
  await testMyDriveRootShape();
  console.log('dropboxToGoogleshareddrive.test.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
