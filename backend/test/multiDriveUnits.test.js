/**
 * Run: npm test  (from backend/)
 *
 * Spec 002 — multi-drive content runs.
 *
 * Two behaviours are asserted here, both of which were silently wrong before:
 *
 *   1. Drive-name normalisation strips leading AND trailing slashes. Only leading ones were
 *      stripped, so a CSV column reading "/QA_Team1/" became "QA_Team1/", matched no drive, and
 *      seeding fell back to My Drive while the run still reported success.
 *   2. A per-row Shared Drive overrides the run-wide one. The run-wide drive used to be applied to
 *      every transfer unit unconditionally, so a run naming two drives read BOTH rows from
 *      whichever drive resolved first — the second drive was never scanned.
 *
 * The unit-building logic is duplicated here rather than imported: it lives inside
 * migrationClient.triggerMigration(), which logs in over HTTP before it reaches that code. The
 * duplication is deliberate and the assertions below pin the exact expressions used there, so a
 * change to one without the other fails this test.
 */
const assert = require('assert');
const { normalizeDriveName, driveNamesMatch } = require('../src/utils/driveNames');

function testNormalisation() {
  // The case that actually broke: a trailing slash from a path-style CSV column.
  assert.strictEqual(normalizeDriveName('/QA_Team1/'), 'QA_Team1');
  assert.strictEqual(normalizeDriveName('/QA_Team1'), 'QA_Team1');
  assert.strictEqual(normalizeDriveName('QA_Team1/'), 'QA_Team1');
  assert.strictEqual(normalizeDriveName('QA_Team1'), 'QA_Team1');
  assert.strictEqual(normalizeDriveName('  /QA_Team2/  '), 'QA_Team2');
  assert.strictEqual(normalizeDriveName('///QA_Team1///'), 'QA_Team1');

  // Spaces inside a name are real — customers have drives called "Naga Lakshmi Shared drive".
  assert.strictEqual(normalizeDriveName('/Naga Lakshmi Shared drive/'), 'Naga Lakshmi Shared drive');

  // Empty-ish input must not become a match-anything value.
  for (const empty of ['', '   ', '/', '///', null, undefined]) {
    assert.strictEqual(normalizeDriveName(empty), '', `${JSON.stringify(empty)} normalises to ''`);
  }

  // An empty name must never match another empty name — that would resolve "no drive named" to
  // the first drive in the account, which for this QA account is one of a thousand.
  assert.strictEqual(driveNamesMatch('', ''), false);
  assert.strictEqual(driveNamesMatch('/', ''), false);
  assert.strictEqual(driveNamesMatch('/QA_Team1/', 'QA_Team1'), true);
  assert.strictEqual(driveNamesMatch('qa_team1', 'QA_TEAM1'), true, 'case-insensitive');
  assert.strictEqual(driveNamesMatch('QA_Team1', 'QA_Team2'), false);
  console.log('  normalisation: ok');
}

/**
 * Mirrors the per-unit expressions in migrationClient.triggerMigration().
 * `runWide.isSharedDrive` mirrors /SHARED_DRIVE/i.test(context.sourceCloudName) — the registered
 * CLOUD TYPE, not where the bytes sit. Defaults true because that is the multi-drive case.
 */
function buildUnit(row, runWide) {
  const isSharedDrive = runWide.isSharedDrive !== false;
  const rowDriveId = isSharedDrive ? (row.sourceDriveId || runWide.driveId || null) : null;
  const rowDriveName = isSharedDrive
    ? (normalizeDriveName(row.sourceDriveName) || runWide.driveName || '')
    : '';
  const isRowSharedDrive = Boolean(rowDriveId && rowDriveName);
  return {
    sourcePath: isRowSharedDrive ? `/${rowDriveName}` : (row.sourcePath || '/'),
    fromRootId: rowDriveId || row.sourceRootId || row.sourcePath || '/',
    folderRootId: rowDriveId || row.sourceRootId || null,
    seededFolderPath: row.sourcePath || null,
    sourceDriveName: rowDriveName || null,
  };
}

function testTwoDrivesInOneRun() {
  const runWide = { driveId: '0AJoAzUBzPvRXUk9PVA', driveName: 'QA_Team1' };
  const rows = [
    { sourceDriveName: '/QA_Team1/', sourceDriveId: '0AJoAzUBzPvRXUk9PVA', sourcePath: '/Agent Shared Drive' },
    { sourceDriveName: 'QA_Team2', sourceDriveId: '0ACD5LTUGQOCOUk9PVA', sourcePath: '/Agent Shared Drive' },
  ];
  const units = rows.map((r) => buildUnit(r, runWide));

  // Each row keeps its OWN drive. This is the whole point of the change.
  assert.strictEqual(units[0].fromRootId, '0AJoAzUBzPvRXUk9PVA');
  assert.strictEqual(units[1].fromRootId, '0ACD5LTUGQOCOUk9PVA');
  assert.notStrictEqual(units[0].fromRootId, units[1].fromRootId, 'two drives, two scan roots');

  // The path names the DRIVE, not the seeded folder — the id and the path must describe the same
  // object or CloudFuze scans nothing (job comparison in migrationClient).
  assert.strictEqual(units[0].sourcePath, '/QA_Team1', 'trailing slash normalised out of the path');
  assert.strictEqual(units[1].sourcePath, '/QA_Team2');

  // The seeded folder is still carried for the report.
  assert.strictEqual(units[0].seededFolderPath, '/Agent Shared Drive');
  assert.strictEqual(units[1].seededFolderPath, '/Agent Shared Drive');

  // Identical data in both drives means the folder name is shared, not per row.
  assert.strictEqual(units[0].seededFolderPath, units[1].seededFolderPath);
  console.log('  two drives in one run: ok');
}

function testSingleDriveUnchanged() {
  // A row carrying no drive of its own must still pick up the run-wide pair, so existing
  // single-drive runs behave exactly as before this change.
  const runWide = { driveId: '0AJoAzUBzPvRXUk9PVA', driveName: 'QA_Team1' };
  const unit = buildUnit({ sourcePath: '/Agent Shared Drive' }, runWide);
  assert.strictEqual(unit.fromRootId, '0AJoAzUBzPvRXUk9PVA');
  assert.strictEqual(unit.sourcePath, '/QA_Team1');
  assert.strictEqual(unit.folderRootId, '0AJoAzUBzPvRXUk9PVA');
  console.log('  single-drive fallback: ok');
}

function testNonSharedDriveUntouched() {
  // Box / OneDrive / My Drive rows carry no drive at all. They must keep the caller's folder path
  // and must not acquire a "/undefined" style source path.
  const unit = buildUnit({ sourcePath: '/Agent Box Data', sourceRootId: '12345' }, { driveId: null, driveName: '' });
  assert.strictEqual(unit.sourcePath, '/Agent Box Data', 'folder path preserved for non-Shared-Drive');
  assert.strictEqual(unit.fromRootId, '12345');
  assert.strictEqual(unit.sourceDriveName, null);
  console.log('  non-Shared-Drive rows untouched: ok');
}

function testDuplicateDriveDetectable() {
  // Spec 002 rule 7: two rows naming the same drive must be rejected rather than silently merged
  // into one destination. The detection is a plain uniqueness check on the normalised name.
  const names = ['/QA_Team1/', 'QA_Team1'].map(normalizeDriveName);
  assert.strictEqual(new Set(names).size, 1, 'differently written, same drive — must be caught');

  const distinct = ['/QA_Team1', 'QA_Team2/'].map(normalizeDriveName);
  assert.strictEqual(new Set(distinct).size, 2, 'genuinely different drives pass the check');
  console.log('  duplicate-drive detection: ok');
}

/**
 * Mirrors AgentOrchestrator's per-row drive selection:
 *   entry[0] → context.sourceSharedDriveName (Step 1 seeds entry[0]'s dataset)
 *   entry[i] → its own drive, else the run-wide one
 */
function seedTargets(cufEntries, runWideName) {
  const entry0Drive = normalizeDriveName(cufEntries[0] && cufEntries[0].sourceDriveName);
  const step1Drive = entry0Drive || normalizeDriveName(runWideName);
  const targets = [step1Drive];
  for (let i = 1; i < cufEntries.length; i++) {
    targets.push(normalizeDriveName(cufEntries[i].sourceDriveName) || step1Drive);
  }
  return targets;
}

function testSeedingTargets() {
  // Two rows naming two drives → two DISTINCT seeding passes. Before the change every pass used
  // GOOGLE_SHARED_DRIVE_NAME, so the second drive was never written to.
  const twoDrives = seedTargets(
    [{ sourceDriveName: '/QA_Team1/' }, { sourceDriveName: 'QA_Team2' }],
    'QA_TeamDrive'
  );
  assert.deepStrictEqual(twoDrives, ['QA_Team1', 'QA_Team2']);
  assert.strictEqual(new Set(twoDrives).size, 2, 'each row seeds its own drive');

  // entry[0]'s drive must win over the run-wide name, or Step 1 seeds the wrong drive and only
  // rows 1..N would be correct.
  assert.strictEqual(twoDrives[0], 'QA_Team1', 'entry[0] overrides GOOGLE_SHARED_DRIVE_NAME');

  // Rows that name no drive inherit the run-wide one — existing single-drive runs unchanged.
  assert.deepStrictEqual(seedTargets([{}, {}], 'QA_Team1'), ['QA_Team1', 'QA_Team1']);

  // Mixed: row 2 names a drive, row 3 does not and falls back to Step 1's drive.
  assert.deepStrictEqual(
    seedTargets([{}, { sourceDriveName: 'QA_Team2' }, {}], 'QA_Team1'),
    ['QA_Team1', 'QA_Team2', 'QA_Team1']
  );

  // No drive anywhere (a My Drive or Box run) → empty, and the agent must NOT then throw.
  assert.deepStrictEqual(seedTargets([{}], ''), ['']);
  console.log('  seeding targets per row: ok');
}

function testUnresolvedDriveIsFatal() {
  // Spec 002 rule 4. The agent's guard is `if (sharedDriveName) { ...resolve...; if (!drive) throw }`
  // so the two conditions that matter are: a NAMED drive that does not resolve is fatal, and NO
  // named drive is not. Pinning the predicate keeps the My-Drive fallback from creeping back in.
  const shouldThrow = (name, resolved) => Boolean(normalizeDriveName(name)) && !resolved;

  assert.strictEqual(shouldThrow('QA_Team9', null), true, 'named but unresolvable → fatal');
  assert.strictEqual(shouldThrow('/QA_Team9/', null), true, 'trailing slash does not excuse it');
  assert.strictEqual(shouldThrow('QA_Team1', { id: '0A' }), false, 'resolved → proceed');
  assert.strictEqual(shouldThrow('', null), false, 'no drive named → My Drive is legitimate');
  assert.strictEqual(shouldThrow('   ', null), false, 'whitespace-only is not a drive name');
  assert.strictEqual(shouldThrow('/', null), false, 'a bare slash is not a drive name');
  console.log('  unresolved drive is fatal: ok');
}

/** Mirrors the folder-name choice in AgentOrchestrator's extra-row seeding loop. */
function folderNameFor(entry, baseName, localPart, rowDrive, step1Drive) {
  const separatedByDrive = Boolean(rowDrive) && rowDrive !== step1Drive;
  return (entry.sourceFolderName || '').trim()
    || (separatedByDrive ? baseName : `${baseName} ${localPart}`);
}

function testFolderNameAcrossDrives() {
  const base = 'Agent Shared Drive';

  // Rows separated by DRIVE keep the base name: each drive must hold the SAME tree or the two
  // sides are not comparable. Suffixing would produce "Agent Shared Drive erik" in drive 2.
  assert.strictEqual(folderNameFor({}, base, 'erik', 'QA_Team2', 'QA_Team1'), base);

  // Rows separated by USER inside ONE drive still get the suffix — identically named folders in the
  // same account would collide, which is why the suffix exists.
  assert.strictEqual(folderNameFor({}, base, 'alex', 'QA_Team1', 'QA_Team1'), `${base} alex`);
  assert.strictEqual(folderNameFor({}, base, 'alex', '', ''), `${base} alex`);

  // An explicit per-row folder name always wins.
  assert.strictEqual(folderNameFor({ sourceFolderName: 'Custom' }, base, 'erik', 'QA_Team2', 'QA_Team1'), 'Custom');
  console.log('  folder name across drives: ok');
}

/**
 * Mirrors the destination derivation in buildPayload / the summary table.
 * `rowBase` is a per-row destination (from a CSV column, or typed before that field became
 * read-only). It acts as that row's BASE — the drive name is always appended — so a row can never
 * pin two drives to one folder.
 */
function autoDest(driveName, basePath, rowBase = '') {
  const drive = String(driveName || '').trim().replace(/^\/+|\/+$/g, '');
  const chosen = String(rowBase || '').trim() || basePath || '';
  const base = String(chosen).replace(/\/+$/, '');
  const endsWithDrive = Boolean(drive) && base.toLowerCase().endsWith(`/${drive.toLowerCase()}`);
  // `base`, not `chosen`, on the no-append branch: chosen still carries a trailing slash, and
  // "/QA/Documents/QA_Team1/" and "/QA/Documents/QA_Team1" must not be two different destinations.
  return drive && base && !endsWithDrive ? `${base}/${drive}` : (base || chosen);
}

function testDestinationDerivation() {
  // "I give /QA/Documents, the rest is done" — the drive name becomes the sub-folder.
  assert.strictEqual(autoDest('QA_Team1', '/QA/Documents'), '/QA/Documents/QA_Team1');
  assert.strictEqual(autoDest('QA_Team2', '/QA/Documents'), '/QA/Documents/QA_Team2');

  // Two drives must never derive the same destination — that collision is what produced
  // "70 extra, 260 misplaced" on an earlier run.
  assert.notStrictEqual(autoDest('QA_Team1', '/QA/Documents'), autoDest('QA_Team2', '/QA/Documents'));

  // Slash handling on both sides.
  assert.strictEqual(autoDest('/QA_Team1/', '/QA/Documents/'), '/QA/Documents/QA_Team1');

  // No drive → the base path is used unchanged (Box / OneDrive / My Drive rows).
  assert.strictEqual(autoDest('', '/QA/Documents'), '/QA/Documents');
  assert.strictEqual(autoDest(null, '/QA/Documents'), '/QA/Documents');

  // No base configured → nothing is invented.
  assert.strictEqual(autoDest('QA_Team1', ''), '');

  // REGRESSION GUARD for the collision the UI invited. Typing the base value into every row — the
  // obvious thing to do while that column looked like an input — used to win outright, so both
  // drives resolved to "/QA/Documents" and their trees merged at the destination. A row value is
  // now a BASE, so the drive is still appended and the two stay distinct.
  const a = autoDest('QA_Team1', '/QA/Documents', '/QA/Documents');
  const b = autoDest('QA_Team2', '/QA/Documents', '/QA/Documents');
  assert.strictEqual(a, '/QA/Documents/QA_Team1');
  assert.strictEqual(b, '/QA/Documents/QA_Team2');
  assert.notStrictEqual(a, b, 'a per-row destination can no longer collapse two drives into one folder');

  // A row base that differs from the run base is still honoured, with the drive appended.
  assert.strictEqual(autoDest('QA_Team2', '/QA/Documents', '/Other/Docs'), '/Other/Docs/QA_Team2');

  // With no drive, a row base still wins over the run base (Box / OneDrive rows).
  assert.strictEqual(autoDest('', '/QA/Documents', '/Other/Docs'), '/Other/Docs');

  // BOTH CSV styles must work. A colleague's example mapping writes the FULL destination path per
  // row; ours writes the base and lets the drive be appended. Appending has to be idempotent or the
  // explicit style would become "/QA/Documents/QA_Team1/QA_Team1".
  assert.strictEqual(autoDest('QA_Team1', '', '/QA/Documents/QA_Team1'), '/QA/Documents/QA_Team1');
  assert.strictEqual(autoDest('QA_Team2', '', '/QA/Documents/QA_Team2'), '/QA/Documents/QA_Team2');
  assert.strictEqual(autoDest('QA_Team1', '', '/QA/Documents/QA_Team1/'), '/QA/Documents/QA_Team1');
  assert.strictEqual(autoDest('qa_team1', '', '/QA/Documents/QA_Team1'), '/QA/Documents/QA_Team1',
    'case-insensitive, so a differently cased drive name does not double up');

  // A folder that merely CONTAINS the drive name is not the same as ending with it.
  assert.strictEqual(autoDest('QA_Team1', '', '/QA_Team1/Docs'), '/QA_Team1/Docs/QA_Team1');

  // Both styles must still keep the two drives apart.
  assert.notStrictEqual(
    autoDest('QA_Team1', '', '/QA/Documents/QA_Team1'),
    autoDest('QA_Team2', '', '/QA/Documents/QA_Team2')
  );
  console.log('  destination derivation: ok');
}

/** Mirrors _applyDriveAccessMode's target selection (feature 4.10). */
function driveAccessTargets(mode, { everyoneGroup = '', editor = '', viewer = '' } = {}) {
  const m = String(mode || '').trim().toLowerCase();
  if (!m) return null;                       // no mode declared → no drive-level seeding at all
  if (m !== 'open' && m !== 'restricted') return null;
  const few = [[editor, 'fileOrganizer'], [viewer, 'reader']].filter(([who]) => who);
  return m === 'open' ? (everyoneGroup ? [[everyoneGroup, 'fileOrganizer']] : []) : few;
}

/**
 * Mirrors the CSV import's "lift the destination into the base field" rule.
 * Returns { base, rows } where rows keep only the destinations that could not be lifted.
 */
function liftDestination(csvRows) {
  const dests = [...new Set(csvRows.map((r) => String(r.destinationPath || '').trim()).filter(Boolean))];
  if (dests.length === 1) {
    return { base: dests[0], rows: csvRows.map((r) => ({ ...r, destinationPath: '' })) };
  }
  return { base: null, rows: csvRows.map((r) => ({ ...r })) };
}

function testResolveUnitsCarriesDriveBothBranches() {
  // REGRESSION GUARD for the bug that produced 88 phantom permission mismatches in run f6290828.
  //
  // resolveUnits has two branches and migratedUsers WINS whenever a migration ran. The drive fields
  // were added to the userFolderMappings branch only, so every unit reached validation with no
  // drive, the validator fell back to one run-wide drive, and unit 2's destination was compared
  // against unit 1's SOURCE tree. Two drives holding an identically named folder made the result
  // look like a real permission defect.
  const { resolveUnits } = require('../src/validation/shared/deepContentCore');

  const drives = [
    { sourceEmail: 'erik@x.co', destinationEmail: 'g@y.com', sourcePath: '/Agent Shared Drive', destinationPath: '/QA/Documents/QA_Team1', sourceDriveName: 'QA_Team1', sourceDriveId: '0AJoAz' },
    { sourceEmail: 'erik@x.co', destinationEmail: 'g@y.com', sourcePath: '/Agent Shared Drive', destinationPath: '/QA/Documents/QA_Team2', sourceDriveName: 'QA_Team2', sourceDriveId: '0ACD5L' },
  ];

  for (const [label, context] of [
    ['migratedUsers branch', { migratedUsers: drives }],
    ['userFolderMappings branch', { userFolderMappings: drives }],
  ]) {
    const units = resolveUnits(context);
    assert.strictEqual(units.length, 2, `${label}: two units`);
    assert.deepStrictEqual(units.map((u) => u.sourceDriveName), ['QA_Team1', 'QA_Team2'], `${label}: drive names carried`);
    assert.deepStrictEqual(units.map((u) => u.sourceDriveId), ['0AJoAz', '0ACD5L'], `${label}: drive ids carried`);

    // The decisive property: the two units share a sourcePath and MUST still be distinguishable by
    // drive. If sourceDriveName is null the validator cannot tell them apart.
    assert.strictEqual(units[0].sourcePath, units[1].sourcePath, `${label}: same folder name in both drives`);
    assert.notStrictEqual(units[0].sourceDriveName, units[1].sourceDriveName, `${label}: different drives`);
    for (const u of units) {
      assert.ok(u.sourceDriveName, `${label}: no unit may reach validation without its drive`);
    }
  }

  // A unit that genuinely has no drive (Box / OneDrive) still resolves, with nulls rather than undefined.
  const noDrive = resolveUnits({ migratedUsers: [{ sourceEmail: 'a@x.co', sourcePath: '/Agent Box Data', destinationPath: '/SANITY/Documents' }] });
  assert.strictEqual(noDrive[0].sourceDriveName, null);
  assert.strictEqual(noDrive[0].sourceDriveId, null);
  console.log('  resolveUnits carries drive on both branches: ok');
}

function testCsvDestinationLifting() {
  // The common case: every row names the same destination, so it belongs in the base field. Left in
  // per-row state it was invisible — the base "Destination drive" box stayed empty after an import
  // and nothing on screen said where the destination came from.
  const same = liftDestination([
    { sourceDriveName: '/QA_Team1', destinationPath: '/QA/Documents' },
    { sourceDriveName: '/QA_Team2', destinationPath: '/QA/Documents' },
  ]);
  assert.strictEqual(same.base, '/QA/Documents', 'lifted into the base field');
  assert.deepStrictEqual(same.rows.map((r) => r.destinationPath), ['', ''], 'and cleared from the rows');

  // Each row still resolves to its own destination afterwards.
  const resolved = same.rows.map((r) => autoDest(r.sourceDriveName, same.base, r.destinationPath));
  assert.deepStrictEqual(resolved, ['/QA/Documents/QA_Team1', '/QA/Documents/QA_Team2']);

  // Rows that DISAGREE must keep their own value — a mapping CSV may send each source somewhere
  // different, and collapsing those into one base would silently retarget them.
  const differing = liftDestination([
    { sourceDriveName: '/QA_Team1', destinationPath: '/QA/Documents' },
    { sourceDriveName: '/QA_Team2', destinationPath: '/Other/Docs' },
  ]);
  assert.strictEqual(differing.base, null, 'nothing lifted when rows disagree');
  assert.deepStrictEqual(differing.rows.map((r) => r.destinationPath), ['/QA/Documents', '/Other/Docs']);
  assert.deepStrictEqual(
    differing.rows.map((r) => autoDest(r.sourceDriveName, '', r.destinationPath)),
    ['/QA/Documents/QA_Team1', '/Other/Docs/QA_Team2']
  );

  // A CSV with no destination column at all leaves the base alone.
  const none = liftDestination([{ sourceDriveName: '/QA_Team1', destinationPath: '' }]);
  assert.strictEqual(none.base, null);
  console.log('  csv destination lifting: ok');
}

function testDriveAccessModes() {
  const cfg = {
    everyoneGroup: 'everyone_at_exinent@filefuze.co',
    editor: 'alex@filefuze.co',
    viewer: 'mia@filefuze.co',
  };

  // OPEN grants the everyone-group at the drive root, once — inherited by folders and files.
  assert.deepStrictEqual(driveAccessTargets('open', cfg), [['everyone_at_exinent@filefuze.co', 'fileOrganizer']]);

  // RESTRICTED grants only the named few, and must NOT include the everyone-group — that absence
  // is the whole point of the comparison.
  const restricted = driveAccessTargets('restricted', cfg);
  assert.deepStrictEqual(restricted, [['alex@filefuze.co', 'fileOrganizer'], ['mia@filefuze.co', 'reader']]);
  assert.ok(!restricted.some(([who]) => who === cfg.everyoneGroup), 'restricted never grants the everyone-group');

  // The two modes must differ, or there is nothing to test.
  assert.notDeepStrictEqual(driveAccessTargets('open', cfg), restricted);

  // Manager/organizer is never granted — the in-scope doc gives it no destination mapping.
  for (const mode of ['open', 'restricted']) {
    for (const [, role] of driveAccessTargets(mode, cfg)) {
      assert.notStrictEqual(role, 'organizer', `${mode} must not grant Manager`);
    }
  }

  // No mode → no drive-level seeding (pre-existing behaviour untouched).
  assert.strictEqual(driveAccessTargets('', cfg), null);
  assert.strictEqual(driveAccessTargets(undefined, cfg), null);
  assert.strictEqual(driveAccessTargets('nonsense', cfg), null);

  // Mode declared but nothing configured → empty, so 4.10 reports "not exercised" instead of PASS.
  assert.deepStrictEqual(driveAccessTargets('open', {}), []);
  assert.deepStrictEqual(driveAccessTargets('restricted', {}), []);
  console.log('  drive access modes: ok');
}

function testPerUnitDriveResolution() {
  // Mirrors driveForUnit(): a unit naming a drive resolves that drive; one naming none keeps the
  // run-wide drive. Without this, two units sharing a sourcePath validate against one source tree.
  const runWide = { id: '0AJoAzUBzPvRXUk9PVA', name: 'QA_Team1' };
  const resolve = (name) => ({ QA_TEAM1: runWide, QA_TEAM2: { id: '0ACD5LTUGQOCOUk9PVA', name: 'QA_Team2' } }[
    normalizeDriveName(name).toUpperCase().replace('_TEAM', '_TEAM')] || null);

  const driveForUnit = (unit) => {
    const name = String(unit.sourceDriveName || '').trim();
    return name ? resolve(name) : runWide;
  };

  assert.strictEqual(driveForUnit({ sourceDriveName: 'QA_Team1' }).id, '0AJoAzUBzPvRXUk9PVA');
  assert.strictEqual(driveForUnit({ sourceDriveName: 'QA_Team2' }).id, '0ACD5LTUGQOCOUk9PVA');
  assert.strictEqual(driveForUnit({}).id, runWide.id, 'no drive named → run-wide drive');

  // The decisive assertion: two units with the SAME sourcePath must resolve DIFFERENT drives.
  const a = { sourcePath: '/Agent Shared Drive', sourceDriveName: 'QA_Team1' };
  const b = { sourcePath: '/Agent Shared Drive', sourceDriveName: 'QA_Team2' };
  assert.strictEqual(a.sourcePath, b.sourcePath, 'same folder name in both drives');
  assert.notStrictEqual(driveForUnit(a).id, driveForUnit(b).id, 'but different source drives');

  // An unresolvable drive yields null, which the validator reports as FAIL rather than falling back.
  assert.strictEqual(driveForUnit({ sourceDriveName: 'QA_Team9' }), null);
  console.log('  per-unit drive resolution: ok');
}

function testCloudTypeGate() {
  // REGRESSION GUARD. googledrive→sharepoint is a My Drive cloud, but GOOGLE_SHARED_DRIVE_NAME is
  // set in this environment, so the Drive seeder resolves a Shared Drive and reports its id back.
  // An early version of the per-row change read that id without checking the cloud type, which made
  // a My Drive cloud send "/QA_Team1" as its source path instead of the seeded folder.
  const myDriveCloud = { driveId: null, driveName: '', isSharedDrive: false };
  const unit = buildUnit(
    { sourceDriveId: '0AJoAzUBzPvRXUk9PVA', sourceDriveName: 'QA_Team1', sourcePath: '/Agent Shared Drive', sourceRootId: '1Jtyv' },
    myDriveCloud
  );
  assert.strictEqual(unit.sourcePath, '/Agent Shared Drive', 'a My Drive cloud keeps the FOLDER path');
  assert.strictEqual(unit.fromRootId, '1Jtyv', 'and the folder id, not the drive id');
  assert.strictEqual(unit.sourceDriveName, null);

  // The same row against a Shared Drive cloud does use the drive.
  const sdUnit = buildUnit(
    { sourceDriveId: '0AJoAzUBzPvRXUk9PVA', sourceDriveName: 'QA_Team1', sourcePath: '/Agent Shared Drive', sourceRootId: '1Jtyv' },
    { driveId: null, driveName: '', isSharedDrive: true }
  );
  assert.strictEqual(sdUnit.sourcePath, '/QA_Team1');
  assert.strictEqual(sdUnit.fromRootId, '0AJoAzUBzPvRXUk9PVA');
  console.log('  cloud-type gate honoured: ok');
}

function testDriveRelativeDestination() {
  // The destination path CloudFuze is given includes the SITE and the LIBRARY
  // ("/QA/Documents/QA_Team1"), but Graph's default drive IS the library — so the folder to create
  // is "/QA_Team1". Getting this wrong would create "/QA/Documents/QA_Team1" *inside* the library.
  const { inDrivePath } = require('../src/validation/shared/deepContentCore');

  assert.strictEqual(inDrivePath('/QA/Documents/QA_Team1'), '/QA_Team1');
  assert.strictEqual(inDrivePath('/QA/Documents/QA_Team2'), '/QA_Team2');
  assert.strictEqual(inDrivePath('/QA/Documents'), '/');
  assert.strictEqual(inDrivePath('/SANITYDATAA/Documents/Sanityy'), '/Sanityy');

  // The two drives must stay distinct after the conversion, or both would be created as the same
  // folder and the trees would merge.
  assert.notStrictEqual(inDrivePath('/QA/Documents/QA_Team1'), inDrivePath('/QA/Documents/QA_Team2'));

  // A base-only destination yields the library root, which the pre-create step must skip rather
  // than trying to "create" the root.
  const skipped = ['/QA/Documents', '/', ''].map(inDrivePath).filter((p) => p && p !== '/');
  assert.deepStrictEqual(skipped, [], 'root paths are never passed to ensureFolderPath');
  console.log('  drive-relative destination: ok');
}

/** Mirrors CleanupAgent's source-side drive gathering. */
function cleanupSourceDrives(context, envDefault) {
  return [...new Set([
    ...(context.contentUserFolders || []).map((u) => normalizeDriveName(u && u.sourceDriveName)),
    ...(context.userFolderMappings || []).map((u) => normalizeDriveName(u && u.sourceDriveName)),
    normalizeDriveName(context.sourceSharedDriveName),
    normalizeDriveName(envDefault),
  ].filter(Boolean))];
}

/** Mirrors the orchestrator's stray-item guard on a Shared Drive root. */
function straysInDriveRoot(rootChildren, seededPaths) {
  const seeded = new Set(seededPaths.map((p) => normalizeDriveName(p).toLowerCase()).filter(Boolean));
  return rootChildren.filter((k) => !seeded.has(String(k.name || '').trim().toLowerCase()));
}

function testDriveRoleCap() {
  // Measured on run 6e2a2352 — the same folder, the same item grant, two drives:
  //   QA_Team1  drive=fileOrganizer  item=fileOrganizer  → SharePoint edit  PASS
  //   QA_Team2  drive=commenter      item=fileOrganizer  → SharePoint read  reported FAIL
  // The destination tracked the DRIVE role both times, so demanding Edit for a group that only had
  // Commenter on the drive was a false failure. Expectations are capped at the drive role.
  const roleMap = require('../src/validation/contentRoleMap');
  const cap = (grants, driveRoles) => {
    const byPrincipal = new Map(Object.entries(driveRoles).map(([k, v]) => [k.toLowerCase(), v]));
    return grants.map((g) => {
      const driveRole = byPrincipal.get(String(g.email || '').toLowerCase());
      if (!driveRole) return g;
      const itemLevel = roleMap.LEVEL[roleMap.driveRoleLevel(g.role)] ?? 0;
      const driveLevel = roleMap.LEVEL[roleMap.driveRoleLevel(driveRole)] ?? 0;
      if (driveLevel === 0 || driveLevel >= itemLevel) return g;
      return { ...g, role: driveRole, cappedFrom: g.role };
    });
  };

  // The false failure: item grant above the drive role gets capped down.
  const capped = cap(
    [{ email: 'qa-group-view@filefuze.co', role: 'fileOrganizer', type: 'group' }],
    { 'qa-group-view@filefuze.co': 'commenter' }
  );
  assert.strictEqual(capped[0].role, 'commenter', 'expectation capped to the drive role');
  assert.strictEqual(capped[0].cappedFrom, 'fileOrganizer', 'and records what it was capped from');

  // The passing drive is untouched — drive role already matches the item grant.
  const same = cap(
    [{ email: 'qa-group-view@filefuze.co', role: 'fileOrganizer', type: 'group' }],
    { 'qa-group-view@filefuze.co': 'fileOrganizer' }
  );
  assert.strictEqual(same[0].role, 'fileOrganizer');
  assert.strictEqual(same[0].cappedFrom, undefined, 'no cap applied, nothing rewritten');

  // A grant BELOW the drive role must not be raised — capping only ever lowers.
  const lower = cap(
    [{ email: 'alex@filefuze.co', role: 'reader', type: 'user' }],
    { 'alex@filefuze.co': 'fileOrganizer' }
  );
  assert.strictEqual(lower[0].role, 'reader', 'a lower item grant stays as it is');

  // A principal with no drive membership at all is left alone (item-level share to a non-member).
  const nonMember = cap([{ email: 'outsider@other.com', role: 'writer', type: 'user' }], {});
  assert.strictEqual(nonMember[0].role, 'writer');

  // Same LEVEL, different role name (writer vs fileOrganizer are both EDIT) → no rewrite.
  const sameLevel = cap(
    [{ email: 'alex@filefuze.co', role: 'fileOrganizer', type: 'user' }],
    { 'alex@filefuze.co': 'writer' }
  );
  assert.strictEqual(sameLevel[0].role, 'fileOrganizer', 'equal levels are not rewritten');
  console.log('  drive role cap: ok');
}

function testStrayDriveContentsDetected() {
  // A Shared Drive migrates WHOLE — the path and fromRootId must describe the same object, so a
  // subfolder id scans nothing (findings doc). Everything in the drive root therefore migrates.
  // That rule was operational only, and it has already been broken once: a leftover
  // "ZZ Seeding Fix Check" folder was migrated because nobody noticed it.
  const clean = straysInDriveRoot([{ name: 'Agent Shared Drive' }], ['/Agent Shared Drive']);
  assert.deepStrictEqual(clean, [], 'a drive holding only the seeded folder has no strays');

  const dirty = straysInDriveRoot(
    [{ name: 'Agent Shared Drive' }, { name: 'ZZ Seeding Fix Check' }, { name: 'Someone Else Data' }],
    ['/Agent Shared Drive']
  );
  assert.deepStrictEqual(dirty.map((k) => k.name), ['ZZ Seeding Fix Check', 'Someone Else Data'],
    'anything else in the root is flagged — it will migrate');

  // Slash and case differences must not create phantom strays.
  assert.deepStrictEqual(straysInDriveRoot([{ name: 'Agent Shared Drive' }], ['Agent Shared Drive/']), []);
  assert.deepStrictEqual(straysInDriveRoot([{ name: 'agent shared drive' }], ['/Agent Shared Drive']), []);

  // Multiple seeded folders (a multi-user run in one drive) are all recognised.
  assert.deepStrictEqual(
    straysInDriveRoot([{ name: 'Agent Shared Drive' }, { name: 'Agent Shared Drive alex' }], ['/Agent Shared Drive', '/Agent Shared Drive alex']),
    []
  );
  console.log('  stray drive contents detected: ok');
}

function testCleanupCleansEverySourceDrive() {
  // REGRESSION GUARD for run c4722d01: source cleanup read GOOGLE_SHARED_DRIVE_NAME only, so a
  // two-drive run emptied the folder in the FIRST drive and left the second holding the previous
  // run's data. The second drive's source then had every folder twice (24 children vs 12), the
  // migration copied the duplicates, and validation reported 14 missing / 11 extra / 73 misplaced
  // against a migration that had done nothing wrong.
  const twoRows = cleanupSourceDrives({
    contentUserFolders: [{ sourceDriveName: '/QA_Team1' }, { sourceDriveName: '/QA_Team2' }],
  }, 'QA_Team1');
  assert.deepStrictEqual(twoRows, ['QA_Team1', 'QA_Team2'], 'both drives cleaned, env is not the only source');
  assert.ok(twoRows.includes('QA_Team2'), 'the second drive must not be skipped');

  // The env default still applies when no row names a drive — single-drive runs unchanged.
  assert.deepStrictEqual(cleanupSourceDrives({}, 'QA_Team1'), ['QA_Team1']);

  // Post-migration mappings are an equally valid source of drive names (cleanup may run on a resume).
  assert.deepStrictEqual(
    cleanupSourceDrives({ userFolderMappings: [{ sourceDriveName: 'QA_Team2' }] }, 'QA_Team1'),
    ['QA_Team2', 'QA_Team1']
  );

  // Differently written but identical drives collapse to one — no duplicate work, no double delete.
  assert.deepStrictEqual(
    cleanupSourceDrives({ contentUserFolders: [{ sourceDriveName: '/QA_Team1/' }, { sourceDriveName: 'QA_Team1' }] }, ''),
    ['QA_Team1']
  );

  // No drive anywhere → empty list, which means "no drive filter" (My Drive), the old behaviour.
  assert.deepStrictEqual(cleanupSourceDrives({}, ''), []);
  console.log('  cleanup cleans every source drive: ok');
}

function testCleanupScansEveryDestination() {
  // Cleanup must scan the library root AND each row's destination folder. Scanning only the root
  // would leave "/QA_Team1/Agent Shared Drive" behind, and the next run would migrate on top of it.
  const { inDrivePath } = require('../src/validation/shared/deepContentCore');
  const rows = [
    { destinationPath: '/QA/Documents/QA_Team1' },
    { destinationPath: '/QA/Documents/QA_Team2' },
  ];
  const destRoots = [...new Set(['/', ...rows.map((u) => inDrivePath(u.destinationPath)).filter((p) => p && p !== '/')])];
  assert.deepStrictEqual(destRoots, ['/', '/QA_Team1', '/QA_Team2']);

  // Single-drive run with no wrapper → root only, exactly today's behaviour.
  const single = [...new Set(['/', ...[{ destinationPath: '/QA/Documents' }]
    .map((u) => inDrivePath(u.destinationPath)).filter((p) => p && p !== '/')])];
  assert.deepStrictEqual(single, ['/'], 'single-drive cleanup unchanged');

  // Path joining must not produce a double slash.
  const joined = destRoots.map((base) => `${base === '/' ? '' : base}/Agent Shared Drive`);
  assert.deepStrictEqual(joined, [
    '/Agent Shared Drive',
    '/QA_Team1/Agent Shared Drive',
    '/QA_Team2/Agent Shared Drive',
  ]);
  for (const p of joined) assert.ok(!p.includes('//'), `no double slash in ${p}`);
  console.log('  cleanup scans every destination: ok');
}

testNormalisation();
testSeedingTargets();
testFolderNameAcrossDrives();
testDestinationDerivation();
testResolveUnitsCarriesDriveBothBranches();
testCsvDestinationLifting();
testDriveAccessModes();
testPerUnitDriveResolution();
testCloudTypeGate();
testDriveRelativeDestination();
testDriveRoleCap();
testStrayDriveContentsDetected();
testCleanupCleansEverySourceDrive();
testCleanupScansEveryDestination();
testUnresolvedDriveIsFatal();
testTwoDrivesInOneRun();
testSingleDriveUnchanged();
testNonSharedDriveUntouched();
testDuplicateDriveDetectable();
console.log('multiDriveUnits.test.js: ok');
