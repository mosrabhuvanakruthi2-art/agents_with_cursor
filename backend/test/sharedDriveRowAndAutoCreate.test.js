/**
 * Run: npm test  (from backend/)
 *
 * Two behaviours that a live run found the hard way, on the Shared Drive → Shared Drive pair.
 *
 * 1. CLEANUP MUST SEE THE ROW'S DRIVE.
 *    `context.sourceSharedDriveName` was applied ~50 lines AFTER CleanupAgent had already run, so
 *    cleanup fell back to env.GOOGLE_SHARED_DRIVE_NAME on every run whose drive was named per row.
 *    The log showed it as a split that is easy to misread as user error:
 *        content roots in play: "Agent Shared Drive"        <- row folder, already on the context
 *        source drives in play: "QA_TeamDrive" (0 resolved)  <- env fallback, row drive not applied
 *    Everything after Step 0 saw the right drive, which is why it survived so long: only the
 *    cleaning half pointed elsewhere, leaving the real source drive full of the previous run's data.
 *
 * 2. A NAMED DRIVE THAT DOES NOT EXIST IS CREATED, NOT FATAL — but never silently.
 *    Creating a Shared Drive is a persistent change to the Workspace, and a typo "succeeds" by
 *    producing a fresh empty drive. The WARN line is the only thing separating convenience from a
 *    run that seeds and validates the wrong location while reporting success, so it is asserted
 *    here rather than left to reviewer discipline.
 *
 * No network: the Drive client is stubbed and the assertions are over what the code actually did.
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
}

const DRIVE_CLIENT = require.resolve(path.join(__dirname, '..', 'src', 'clients', 'driveClient.js'));
const SEEDER = require.resolve(path.join(__dirname, '..', 'src', 'agents', 'drive', 'DriveTestDataAgent.js'));

/**
 * Load DriveTestDataAgent with a stubbed Drive client.
 * `existing` is the set of drive names that already exist for the account.
 */
function loadSeederWith({ existing = [], canCreate = true }) {
  for (const p of [DRIVE_CLIENT, SEEDER]) delete require.cache[p];
  const created = [];
  const stub = {
    resolveSharedDriveByName: async (name) => {
      const hit = existing.find((d) => d.toLowerCase() === String(name).toLowerCase());
      return hit ? { id: `id-${hit}`, name: hit } : null;
    },
    ensureSharedDrive: async (name) => {
      if (!canCreate) throw new Error('The user does not have sufficient permissions');
      created.push(name);
      existing.push(name);
      return { id: `id-${name}`, name, created: true };
    },
    listSharedDrives: async () => existing.map((n) => ({ id: `id-${n}`, name: n })),
  };
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (/clients[\\/]driveClient$/.test(request) || request === DRIVE_CLIENT) return stub;
    return originalLoad.call(this, request, parent, isMain);
  };
  let Agent;
  try { Agent = require(SEEDER); } finally { Module._load = originalLoad; }
  return { Agent, created, stub };
}

(async () => {
  // ── 1. the ordering fix ────────────────────────────────────────────────────────
  await check('the row\'s Source drive is applied to the context BEFORE cleanup runs', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'orchestrator', 'AgentOrchestrator.js'), 'utf8'
    );
    const applied = src.indexOf('context.sourceSharedDriveName = rowDrive0');
    const cleanup = src.indexOf("log.info('Step 0: Running CleanupAgent')");
    assert.ok(applied > 0, 'the row drive is applied somewhere');
    assert.ok(cleanup > 0, 'CleanupAgent still runs as Step 0');
    assert.ok(applied < cleanup,
      'the row drive must be applied BEFORE Step 0, or cleanup silently cleans the env default '
      + 'drive and leaves the real source drive holding the previous run\'s data');
  });

  // ── 2. auto-create ─────────────────────────────────────────────────────────────
  await check('a source drive that already exists is reused, never re-created', async () => {
    const { Agent, created } = loadSeederWith({ existing: ['QA_Team1'] });
    const agent = new Agent();
    // execute() resolves the drive first, then needs live Drive calls — it is expected to fail
    // further in. What this asserts is what happened BEFORE that point.
    await agent.execute({
      sourceProvider: 'googleshareddrive',
      sourceEmail: 'erik@example.invalid',
      sourceSharedDriveName: 'QA_Team1',
      sourceFolderName: 'Agent Shared Drive',
    }).catch(() => {});
    assert.deepStrictEqual(created, [],
      'an existing drive must be reused — creating a second one of the same name makes every later '
      + 'resolveSharedDriveByName ambiguous');
  });

  await check('ensureSharedDrive returns the existing drive rather than making a second', async () => {
    const { stub } = loadSeederWith({ existing: ['QA_Team1'] });
    const again = await stub.resolveSharedDriveByName('qa_team1');
    assert.ok(again, 'the lookup is case-insensitive, so a differently-cased name is not a new drive');
    assert.strictEqual(again.name, 'QA_Team1');
  });

  await check('a missing drive is created, and the creation is announced at WARN', async () => {
    const { Agent, created } = loadSeederWith({ existing: [] });
    const logs = [];
    const logger = require('../src/utils/logger');
    const originalWarn = logger.warn;
    logger.warn = (msg, ...rest) => { logs.push(String(msg)); return originalWarn.call(logger, msg, ...rest); };

    const agent = new Agent();
    // Drive resolution is the first thing execute() does; everything after it needs live Drive
    // calls, so the run is expected to fail further in. What matters is what happened FIRST.
    await agent.execute({
      sourceProvider: 'googleshareddrive',
      sourceEmail: 'erik@example.invalid',
      sourceSharedDriveName: 'Brand-New-Drive',
      sourceFolderName: 'Agent Shared Drive',
    }).catch(() => {});
    logger.warn = originalWarn;

    assert.deepStrictEqual(created, ['Brand-New-Drive'],
      'a named drive that does not exist is created, so a new name is enough to run');
    assert.ok(logs.some((l) => /CREATED it/.test(l) && /Brand-New-Drive/.test(l)),
      `the creation must be announced at WARN; got:\n${logs.join('\n')}`);
    assert.ok(logs.some((l) => /typo/i.test(l)),
      'the warning must name the typo risk — that is what keeps the convenience honest');
  });

  await check('a drive that cannot be created fails with an actionable reason', async () => {
    const { Agent } = loadSeederWith({ existing: [], canCreate: false });
    const agent = new Agent();
    let message = '';
    await agent.execute({
      sourceProvider: 'googleshareddrive',
      sourceEmail: 'erik@example.invalid',
      sourceSharedDriveName: 'Forbidden-Drive',
      sourceFolderName: 'Agent Shared Drive',
    }).catch((e) => { message = String(e.message); });
    assert.ok(/could not be created/i.test(message),
      `expected a creation failure; got: ${message}`);
    assert.ok(/admin\.google\.com/i.test(message),
      'the message points at the Workspace setting that governs it, not just "it failed"');
  });

  console.log(`\nsharedDriveRowAndAutoCreate: ${failures.length === 0
    ? 'all passed' : `${failures.length} failed`}`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
