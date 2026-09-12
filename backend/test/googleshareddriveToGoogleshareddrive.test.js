/**
 * Run: npm test  (from backend/)
 *
 * Google Shared Drive → Google Shared Drive.
 *
 * Built from the proven sharepoint → googleshareddrive combination, so the tests that matter are
 * the ones asserting what CHANGED in the move, plus the rules that were wrong verdicts on real runs
 * before they were rules:
 *
 *   - both roots are Shared Drives, which must EXIST — a drive cannot be created by a path
 *   - every item inherits the drive's own grant, so an inherited grant must never satisfy a
 *     user grant, or every permission check passes regardless of what migrated
 *   - nothing converts or is renamed, so 6.1 and 7.1 are NEGATIVE tests
 *   - embedded links must be judged by FILE ID: both URLs are drive.google.com, so "points at
 *     Google" is not evidence of a re-pointed link
 *   - the five non-migratable Google types must not count as missing
 *
 * Behavioural where it can be: the checks below run the agent's own methods against constructed
 * inputs and assert on the verdicts produced, rather than on the text of the source.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const registry = require('../src/orchestrator/agentRegistry');
const ValidationAgent = require('../src/validation/combinations/content/googleshareddriveToGoogleshareddrive');
const GoogleDriveValidationAgent = require('../src/agents/googledrive/GoogleDriveValidationAgent');
const DriveTestDataAgent = require('../src/agents/drive/DriveTestDataAgent');
const roleMaps = require('../src/validation/roleMaps');
const destinations = require('../src/validation/destinations');
const tolerance = require('../src/utils/contentTolerance');
const core = require('../src/validation/shared/deepContentCore');

const COMBINATION = 'googleshareddrive_to_googleshareddrive';

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
}

/** Collect the checks an agent method pushes, so a verdict can be asserted on. */
function collect(fn) {
  const rows = [];
  const push = (status, name, detail) => rows.push({ status, name, detail });
  fn(push, rows);
  return rows;
}
const find = (rows, id) => rows.find((r) => r.name.startsWith(id));

// ── registration ────────────────────────────────────────────────────────────────
check('the pair resolves, seeds with the Drive agent and validates deeply', () => {
  const entry = registry.resolve('content', 'googleshareddrive', 'googleshareddrive');
  assert.ok(entry, 'content:googleshareddrive:googleshareddrive is registered');
  assert.strictEqual(entry.TestDataAgent, DriveTestDataAgent,
    'the Shared Drive source is seeded by the same agent every other Drive pair uses');
  assert.strictEqual(entry.ValidationAgent, ValidationAgent);
  assert.strictEqual(entry.ValidationAgent.supportsDeepValidation, true,
    'without this the orchestrator falls back to the report-only agent, which compares nothing');
  assert.ok(ValidationAgent.prototype instanceof GoogleDriveValidationAgent,
    'the destination half is the shared Google agent — and for this pair it reads the source too');
});

// ── the scope documents, and that the code matches them ─────────────────────────
check('both feature-scope documents exist and carry the documented totals', () => {
  const dir = path.join(__dirname, '..', 'data', 'feature-scope');
  for (const [file, total] of [
    ['google-shared-drive-to-shared-drive-inscope.md', 19],
    ['google-shared-drive-to-shared-drive-outscope.md', 7],
  ]) {
    const full = path.join(dir, file);
    assert.ok(fs.existsSync(full), `${file} exists`);
    const text = fs.readFileSync(full, 'utf8');
    assert.ok(new RegExp(`Total Features:\\*\\* ${total}`).test(text),
      `${file} states Total Features: ${total}`);
  }
});

check('the validator implements exactly the 19 in-scope features, by the document ids', () => {
  const ids = ValidationAgent.SHAREDDRIVE_FEATURES.map((f) => f.id);
  assert.strictEqual(ids.length, 19, 'the scope document lists 19 features');
  assert.deepStrictEqual(ids, [
    '1.1', '1.2',
    '2.1',
    '3.1', '3.2', '3.3', '3.4', '3.5', '3.6',
    '4.1',
    '5.1', '5.2',
    '6.1', '7.1', '8.1', '9.1', '10.1', '11.1', '12.1',
  ], 'ids follow the scope document verbatim — the checklist matches on them');
});

check('all 7 documented limitations are reported, and none can fail a run', () => {
  assert.strictEqual(ValidationAgent.OUT_OF_SCOPE_NOTES.length, 7);
  const agent = new ValidationAgent();
  const rows = collect((push) => agent._recordOutOfScope(push));
  assert.strictEqual(rows.length, 7, 'every limitation is reported');
  assert.ok(rows.every((r) => r.status === 'INFO'),
    'an out-of-scope limitation is INFO — it must never fail a run');
});

// ── lookups the validator refuses to run without ────────────────────────────────
check('bands, destination rules and role map all resolve for this combination', () => {
  const bands = tolerance.forCombination(COMBINATION);
  assert.ok(bands, 'utils/contentTolerance has a file for this combination');
  assert.strictEqual(bands.pathLengthLimit, Infinity,
    'Google imposes no path limit — a finite limit would make 7.1 expect a relocation that never happens');
  assert.ok(bands.fileSize.infoMin >= 0.99,
    'Google → Google copies bytes, so the size band is tight — a loose band hides a real difference');
  assert.ok(destinations.forDestination('googleshareddrive'), 'the Google destination rules exist');
  assert.ok(roleMaps.forCombination(COMBINATION),
    'a role map covers this pair — falling back to a SharePoint table would mistranslate every grant');
});

check('roles translate as the identity, and Manager is excluded with a stated reason', () => {
  const map = roleMaps.forCombination(COMBINATION);
  // fileOrganizer (Content manager) exists ONLY on a Shared Drive and MUST be comparable — the
  // seeder grants it for this pair, and a map that did not know it would report every such grant
  // as untranslatable.
  for (const role of ['fileOrganizer', 'writer', 'commenter', 'reader']) {
    assert.ok(map.isComparableDriveRole(role), `${role} is comparable on a Shared Drive pair`);
  }
  // `organizer` (Manager) is deliberately NOT compared: the shared google_to_google map excludes it
  // alongside `owner`, because the migrating account owns its own copy and its own grant cannot be
  // asserted. On a Shared Drive that reasoning is weaker — Manager is a real role held by several
  // members — so this is pinned as the CURRENT behaviour with the reason surfaced, not asserted as
  // correct. A Manager grant therefore appears in the report under "not comparable" rather than
  // vanishing. See the open question in google-shared-drive-to-shared-drive-inscope.md.
  assert.strictEqual(map.isComparableDriveRole('organizer'), false,
    'Manager is currently not compared — if this changes, the scope doc note must change with it');
  assert.ok(/owner/i.test(map.nonComparableReason('organizer')),
    'the report says WHY a Manager grant was not compared, so it is visible rather than dropped');
  assert.ok(map.driveRoleLevel('fileOrganizer') >= map.driveRoleLevel('writer'),
    'Content manager outranks Editor');
  assert.ok(map.driveRoleLevel('writer') > map.driveRoleLevel('reader'),
    'Editor outranks Viewer — without this an escalation reads as a match');
});

// ── the rules that were wrong verdicts before they were rules ───────────────────
check('the five non-migratable Google types are not counted as missing', () => {
  for (const mime of [
    'application/vnd.google-apps.form',
    'application/vnd.google-apps.site',
    'application/vnd.google-apps.map',
    'application/vnd.google-apps.script',
    'application/vnd.google-apps.vid',
  ]) {
    assert.ok(core.isUnmigratableNative(mime),
      `${mime} is documented as non-migratable — counting it missing invents a defect`);
    assert.ok(core.unmigratableReason(mime),
      `${mime} carries a reason, so the report can say why it is absent`);
  }
});

check('6.1 is a NEGATIVE test — a name Google left intact passes, a rewritten one fails', () => {
  const agent = new ValidationAgent();
  const rules = destinations.forDestination('googleshareddrive');
  const totals = { specialChars: { total: 0, arrived: 0 } };
  const name = 'Special !@#$%^&*()-_+=[] Folder';
  const srcTree = [{ path: `/${name}`, name, type: 'folder' }];

  const intact = collect((push) => agent._checkSpecialCharacters(push, srcTree, {
    matched: new Map([[`/${name}`, { source: srcTree[0], dest: { name, path: `/${name}` } }]]),
  }, rules, totals));
  assert.strictEqual(find(intact, '6.1').status, 'PASS',
    'Google replaces nothing, so an intact name is the PASS');

  const totals2 = { specialChars: { total: 0, arrived: 0 } };
  const rewritten = collect((push) => agent._checkSpecialCharacters(push, srcTree, {
    matched: new Map([[`/${name}`, {
      source: srcTree[0],
      dest: { name: 'Special ____________ Folder', path: '/Special ____________ Folder' },
    }]]),
  }, rules, totals2));
  assert.strictEqual(find(rewritten, '6.1').status, 'FAIL',
    'a destination that rewrote the name is the defect — if this passes, the test is vacuous');
});

check('8.1 is reported NOT VERIFIED, never as a pass', () => {
  const agent = new ValidationAgent();
  const rows = collect((push) => agent._checkNotificationSuppression(push, {}));
  const row = find(rows, '8.1');
  assert.ok(row, 'the feature is reported');
  assert.notStrictEqual(row.status, 'PASS',
    'nothing on the Google side proves a notification was suppressed — a pass here would be invented');
  assert.ok(/NOT VERIFIED/i.test(row.detail), 'the report says plainly that it was not verified');
});

check('12.1 does not claim the folder picker was exercised', () => {
  const agent = new ValidationAgent();
  const sourceDrive = { name: 'QA_Source', label: 'Shared Drive "QA_Source"' };
  const destRoot = { label: 'Shared Drive "QA_Dest"' };

  const none = collect((push) => agent._checkFolderDisplay(push, sourceDrive, destRoot, []));
  assert.strictEqual(find(none, '12.1').status, 'WARN',
    'with no resolved unit there is nothing to say about the mapping');

  const some = collect((push) => agent._checkFolderDisplay(push, sourceDrive, destRoot, [
    { status: 'PASS', sourcePath: '/Agent Data', items: [{ path: '/a' }] },
  ]));
  const row = find(some, '12.1');
  assert.strictEqual(row.status, 'PASS');
  assert.ok(/not exercised by a headless run/i.test(row.detail),
    'the limitation is stated in the same breath as the pass, not hidden behind it');
});

check('11.1 does not fail a run for an absent comments CSV', () => {
  const agent = new ValidationAgent();
  const totals = { commentCsv: [] };
  const absent = collect((push) => agent._checkInlineComments(push, [
    { type: 'file', name: 'notes.txt', path: '/notes.txt' },
  ], totals));
  const row = find(absent, '11.1');
  assert.strictEqual(row.status, 'WARN',
    'whether any source item carried a comment is unknown here, so an absent CSV cannot be a defect');

  const totals2 = { commentCsv: [] };
  const present = collect((push) => agent._checkInlineComments(push, [
    { type: 'file', name: 'file_comments.csv', path: '/file_comments.csv' },
  ], totals2));
  assert.strictEqual(find(present, '11.1').status, 'PASS');
  assert.deepStrictEqual(totals2.commentCsv, ['/file_comments.csv'],
    'the CSV found is recorded, so a reader can go and look at it');
});

check('3.6 counts GROUP-typed grants, not grants satisfied via a group', () => {
  const agent = new ValidationAgent();
  const base = {
    permissionObservations: [], permissionMismatches: [], permissionsPendingPaths: [],
    linkObservations: [], versionInfo: [], timestampDrift: [], hashMismatches: [],
    conversionMismatches: [], notComparable: [],
  };
  // viaGroup is set, but no grant was TYPED group: 3.6 must report not-exercised, not a pass.
  const rows = collect((push) => agent._rollUpItemChecks(push, {
    ...base,
    permissionObservations: [{
      path: '/f', type: 'file', checked: 1, matches: 1, mismatches: 0, escalations: 0,
      viaGroup: 3, groupChecked: 0, groupFailed: 0,
    }],
  }, []));
  const row = find(rows, '3.6');
  assert.ok(row, '3.6 is reported');
  assert.notStrictEqual(row.status, 'PASS',
    'viaGroup means a USER grant was satisfied through a group — it is not a group grant');
});

// ── the property that makes this pair different from every cross-platform one ───
check('the tolerance file states why native sizes cannot prove correctness', () => {
  const bands = tolerance.forCombination(COMBINATION);
  assert.ok(bands.convertedFileSize.infoMax >= 6,
    'Drive reports little or no size for a native doc on EITHER side, so the band must be wide');
  assert.strictEqual(bands.countDelta, 0,
    'structure is exact — a missing item is a defect, never absorbed by a tolerance');
  assert.ok(bands.treeDepth >= 25, 'must exceed the 20-level chain the seeder builds');
});

console.log(`\ngoogleshareddriveToGoogleshareddrive: ${failures.length === 0
  ? 'all passed' : `${failures.length} failed`}`);
process.exit(failures.length === 0 ? 0 : 1);
