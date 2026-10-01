/**
 * Google Shared Drive → OneDrive for Business — the eight documented features, and the traps.
 *
 * This combination is deliberately NARROW: four migration features and four permission features.
 * Versions, shared links, timestamps and external shares are out of scope for it, and the biggest
 * risk when writing it was carrying a check across from google-shared-drive-to-sharepoint, which
 * does judge them. Several assertions here exist purely to stop that happening later.
 */
const assert = require('assert');
const Agent = require('../src/validation/combinations/content/googleshareddriveToOnedrive');
const core = require('../src/validation/shared/deepContentCore');
const tolerance = require('../src/utils/contentTolerance');
const { buildUnitResult } = require('../src/validation/shared/contentResultShape');

// ── The checklist covers every DOCUMENTED feature: eight judged, four out of scope ─────
//
// It used to carry only the eight in-scope rows, and the four out-of-scope features reached the
// report as a single lumped INFO check that the Feature Checklist table does not read. A reader
// holding the two scope documents against the PDF counted twelve documented features and eight
// rows, and could not tell a deliberately unjudged feature from a forgotten one.
const agent = new Agent();
const checklist = agent._buildChecklist([]);
const judged = checklist.filter((f) => f.status !== 'info');
const observed = checklist.filter((f) => f.status === 'info');

assert.strictEqual(judged.length, 8, 'the in-scope document names eight features, no more, no fewer');
assert.deepStrictEqual(
  judged.map((f) => f.id),
  ['1.1', '1.2', '1.3', '1.4', '2.1', '2.2', '2.3', '2.4'],
  'in the document\'s own numbering'
);
for (const f of judged) {
  assert.strictEqual(f.status, 'na',
    `${f.id} with no check must be na — never a pass on absent evidence`);
}

assert.strictEqual(observed.length, 4, 'the out-scope document names four features');
assert.deepStrictEqual(
  observed.map((f) => f.id),
  ['OS 1.1', 'OS 2.1', 'OS 3.1', 'OS 4.1'],
  'in the OUT-scope document\'s numbering, prefixed so it cannot collide with in-scope 1.1 / 2.1'
);
assert.deepStrictEqual(
  observed.map((f) => f.feature),
  ['External shares', 'Timestamps', 'SharedLinks', 'Versions'],
  'the four the out-scope document actually lists'
);

// THE POINT OF THE PREFIX. Unprefixed, "1.1" would match both the in-scope One Time Migration
// check and the out-of-scope External shares check, and whichever came first in `checks` would
// decide a row. This pins that they resolve independently.
const mixed = agent._buildChecklist([
  { status: 'PASS', name: '1.1 One Time Migration', detail: 'delivered 12 items' },
  { status: 'INFO', name: 'OS 1.1 External shares', detail: 'none seeded' },
]);
assert.strictEqual(mixed.find((f) => f.id === '1.1').status, 'pass');
assert.strictEqual(mixed.find((f) => f.id === '1.1').detail, 'delivered 12 items');
assert.strictEqual(mixed.find((f) => f.id === 'OS 1.1').detail, 'none seeded');

// An out-of-scope row is pinned to `info` WHATEVER its check said, so no future edit to
// _reportOutOfScope can let an unjudged feature fail a run.
const shouted = agent._buildChecklist([
  { status: 'FAIL', name: 'OS 4.1 Versions', detail: 'source 9 versions, dest 1' },
]);
assert.strictEqual(shouted.find((f) => f.id === 'OS 4.1').status, 'info',
  'out of scope means it cannot fail the run, however loudly the check was written');
assert.strictEqual(shouted.find((f) => f.id === 'OS 4.1').inScope, false,
  'and it is marked as such for anything reading the rows programmatically');

// In-scope ids that belong to a NEIGHBOURING combination must still not appear.
const ids = new Set(checklist.map((f) => f.id));
for (const foreign of ['3.1', '4.1', '5.1', '9.1', '10.1']) {
  assert.ok(!ids.has(foreign),
    `${foreign} belongs to another combination's document and must not be judged here`);
}

// ── A WARN is "not assessed", never a pass ─────────────────────────────────────────────
const warned = agent._buildChecklist([
  { status: 'WARN', name: '1.3 Files & Folder Migration', detail: 'not exercised' },
]);
assert.strictEqual(warned.find((f) => f.id === '1.3').status, 'na',
  'a WARN means measured-but-not-assessable, which is not a pass');

// ── Position classification drives the 2.x split ───────────────────────────────────────
assert.strictEqual(Agent.isRootLevel('/Report.docx'), true, 'one segment is root level');
assert.strictEqual(Agent.isRootLevel('/Folder/Report.docx'), false, 'two segments is nested');
assert.strictEqual(Agent.isRootLevel('/A/B/C.txt'), false);
const positions = Agent.POSITIONS.map((p) => `${p.id}:${p.type}:${p.root}`);
assert.deepStrictEqual(positions,
  ['2.1:folder:true', '2.2:folder:false', '2.3:file:true', '2.4:file:false'],
  'the four positions are folder/file × root/nested — a run that only checks the root proves '
  + 'nothing about inheritance, which is why the document names four features');

// ── 1.1 / 1.2 are about the RUN TYPE, and each excludes the other ──────────────────────
function migrationRows(migrationType, matchedCount) {
  const rows = [];
  const push = (status, name, detail) => rows.push({ status, name, detail });
  agent._checkMigrationType(push, { migrationType }, { matchedCount });
  const by = (id) => rows.find((r) => r.name.startsWith(id));
  return { one: by('1.1'), delta: by('1.2') };
}
const full = migrationRows('FULL', 12);
assert.strictEqual(full.one.status, 'PASS', 'a one-time run that delivered items passes 1.1');
assert.strictEqual(full.delta.status, 'WARN',
  'and must NOT pass 1.2 — a one-time run never exercises delta, and passing it would be the '
  + 'unfalsifiable pass this project exists to avoid');
assert.ok(/Delta/i.test(full.delta.detail), 'the detail tells the reader how to exercise it');

const delta = migrationRows('DELTA', 5);
assert.strictEqual(delta.delta.status, 'PASS', 'a delta run that delivered items passes 1.2');
assert.strictEqual(delta.one.status, 'WARN', 'and does not claim the one-time path');

const emptyRun = migrationRows('FULL', 0);
assert.strictEqual(emptyRun.one.status, 'FAIL', 'a run that paired nothing fails 1.1');

// ── 1.3 names the file types, so they are the population ───────────────────────────────
function filesAndFolders(sourceTree, missing = []) {
  const rows = [];
  const push = (status, name, detail) => rows.push({ status, name, detail });
  agent._checkFilesAndFolders(push, sourceTree, { missing }, {});
  return rows.find((r) => r.name.startsWith('1.3'));
}
const onlyTxt = [
  { name: 'a.txt', path: '/a.txt', type: 'file' },
  { name: 'dir', path: '/dir', type: 'folder' },
];
assert.strictEqual(filesAndFolders(onlyTxt).status, 'WARN',
  'a run holding only .txt has not exercised 1.3, which names PDF/DOCX/XLSX/PPTX/images');
assert.ok(/NONE of the types/.test(filesAndFolders(onlyTxt).detail), 'and says why');

const named = [
  { name: 'doc.docx', path: '/doc.docx', type: 'file' },
  { name: 'sheet.xlsx', path: '/sheet.xlsx', type: 'file' },
  { name: 'pic.png', path: '/pic.png', type: 'file' },
  { name: 'dir', path: '/dir', type: 'folder' },
];
const namedRow = filesAndFolders(named);
assert.strictEqual(namedRow.status, 'PASS', 'the named types present and nothing missing passes');
assert.ok(/docx/.test(namedRow.detail) && /image/.test(namedRow.detail),
  `the detail names the coverage, got: ${namedRow.detail}`);

assert.strictEqual(filesAndFolders(named, [{ path: '/doc.docx', type: 'file' }]).status, 'FAIL',
  'a file that did not arrive is a real defect');

// Folders but no files, or files but no folders, is not an exercise of "Files & Folder Migration".
assert.strictEqual(filesAndFolders([{ name: 'dir', path: '/dir', type: 'folder' }]).status, 'WARN');

// ── Google native files must PAIR with their converted destination name ────────────────
//
// A Google Doc has no extension at the source and arrives as .docx. If this stopped working every
// native file would read as missing-plus-extra and 1.3/1.4 would fail on a correct migration.
assert.strictEqual(core.convertName('Quarterly Report', 'application/vnd.google-apps.document'),
  'Quarterly Report.docx', 'a Google Doc converts to .docx');
assert.strictEqual(core.convertName('Budget', 'application/vnd.google-apps.spreadsheet'),
  'Budget.xlsx', 'a Google Sheet converts to .xlsx');
assert.strictEqual(core.convertName('Deck', 'application/vnd.google-apps.presentation'),
  'Deck.pptx', 'Google Slides convert to .pptx');
assert.strictEqual(core.convertName('notes.txt', 'text/plain'), 'notes.txt',
  'a pass-through file keeps its name');

// ── Tolerance bands exist, and deliberately omit the out-of-scope ones ─────────────────
const bands = tolerance.forCombination('googleshareddrive_to_onedrive');
assert.ok(bands, 'the combination has its own bands');
assert.strictEqual(bands.pathLengthLimit, 400,
  'OneDrive runs on SharePoint Online, so SharePoint path limits apply — in-scope 1.4 says so');
assert.strictEqual(bands.segmentLengthLimit, 255);
assert.ok(bands.treeDepth > 20,
  'DriveTestDataAgent seeds a 20-level path; a lower cap drops deep nesting out of 1.4 silently');
assert.strictEqual(bands.countDelta, 0, 'structure is exact — a missing item is never absorbed');
assert.strictEqual(bands.timestampDriftMs, undefined,
  'timestamps are OUT of scope here; a band would invite a check the document does not ask for');

// ── The role map is the SHARED one, not a local invention ──────────────────────────────
const roleMap = require('../src/validation/contentRoleMap');
assert.strictEqual(roleMap.isComparableDriveRole('owner'), false,
  'owner is not comparable — the destination account owns its own copy');
assert.strictEqual(roleMap.isComparableDriveRole('writer'), true);
assert.strictEqual(roleMap.isComparableDriveRole('commenter'), true,
  'commenter IS compared — the test repository has explicit cases for it');
assert.strictEqual(roleMap.driveRoleLevel('commenter'), roleMap.driveRoleLevel('reader'),
  'Google commenter collapses to read on a Microsoft destination, which has no comment-only role. '
  + 'If that should be reported as a loss, it is a change to the shared map and to BOTH '
  + 'combinations — not a rule invented in this validator');

// ── Out-of-scope grants are classified, not guessed at ─────────────────────────────────
//
// INHERITED GRANTS MUST BE EXCLUDED. On a Shared Drive every member's access is inherited from the
// drive, so counting inherited entries would report the drive's entire membership as an external
// share on every single item — hundreds of rows describing one drive setting.
// LINKS ARRIVE ON A SEPARATE ARRAY. driveClient.listPermissions filters `grants` to type user
// or group and returns anyone/domain on `links`, so a link can never appear in `grants` — and
// the classifier used to scan only `grants` for one. Run 0fa8ae2c reported "0 link grant(s) at
// the source; 22 at the destination" against a source whose Shared Link Matrix holds fourteen.
const osGrants = agent._classifyOutOfScopeGrants(
  [
    { type: 'user', email: 'alex@filefuze.co', role: 'writer', inherited: false },
    { type: 'user', email: 'outsider@example.org', role: 'reader', inherited: false },
    { type: 'group', email: 'partners@example.org', role: 'writer', inherited: false },
    { type: 'user', email: 'drivemember@example.org', role: 'writer', inherited: true },
  ],
  'erik@filefuze.co',
  [
    { type: 'anyone', role: 'reader' },
    { type: 'domain', role: 'reader', domain: 'filefuze.co' },
  ]
);
assert.deepStrictEqual(
  osGrants.external.map((g) => g.email),
  ['outsider@example.org', 'partners@example.org'],
  'external = a non-inherited grant to a principal outside the SOURCE account\'s own domain'
);
assert.deepStrictEqual(osGrants.links.map((g) => g.audience), ['anyone', 'domain'],
  'both link audiences are reported: anyone-with-the-link and organisation-scoped');
assert.strictEqual(
  agent._classifyOutOfScopeGrants([{ type: 'anyone', role: 'reader' }], 'erik@filefuze.co').links.length,
  0,
  'and a link is never harvested from `grants`, because driveClient never puts one there — '
  + 'reading it from the wrong place is what made the source side report zero'
);
assert.ok(!osGrants.external.some((g) => g.inherited),
  'an inherited grant is drive membership, not an item-level external share');

// ── Timestamps are observed for every matched pair and judged for none ─────────────────
const tsTotals = {
  outOfScope: { tsCompared: 0, tsCreatedDrift: [], tsModifiedDrift: [] },
};
const tsMatched = new Map([
  // Same instant on both sides: read, counted, and reported as no drift.
  ['/same.txt', {
    source: { createdAt: '2026-09-18T04:00:00Z', modifiedAt: '2026-09-18T04:00:00Z' },
    dest: { createdAt: '2026-09-18T04:00:00Z', modifiedAt: '2026-09-18T04:00:30Z' },
  }],
  // The migration stamped its own dates — the expected outcome when preservation was not requested.
  ['/drifted.txt', {
    source: { createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-02T00:00:00Z' },
    dest: { createdAt: '2026-09-18T04:40:00Z', modifiedAt: '2026-09-18T04:40:00Z' },
  }],
  // An unreadable date on one side is not drift. Comparing a missing value against a present one
  // would invent a difference out of a gap in the data.
  ['/nodate.txt', {
    source: { createdAt: null, modifiedAt: null },
    dest: { createdAt: '2026-09-18T04:40:00Z', modifiedAt: '2026-09-18T04:40:00Z' },
  }],
]);
agent._observeTimestamps({ matched: tsMatched }, tsTotals);
assert.strictEqual(tsTotals.outOfScope.tsCompared, 3, 'every matched pair is read');
assert.deepStrictEqual(tsTotals.outOfScope.tsCreatedDrift.map((d) => d.path), ['/drifted.txt'],
  'only a real difference beyond the 60s rounding tolerance counts as created-date drift');
assert.deepStrictEqual(tsTotals.outOfScope.tsModifiedDrift.map((d) => d.path), ['/drifted.txt'],
  '30 seconds is clock rounding between two clouds, not drift worth printing');

// ── Four out-of-scope checks are pushed, each naming what was observed ─────────────────
const osChecks = [];
agent._reportOutOfScope((status, name, detail) => osChecks.push({ status, name, detail }), {
  outOfScope: {
    externalSource: [], externalDest: [], linksSource: [], linksDest: [],
    tsCompared: 3, tsCreatedDrift: [{ path: '/a.txt', source: 'x', dest: 'y' }],
    tsModifiedDrift: [], versions: null,
  },
});
assert.strictEqual(osChecks.length, 4, 'one check per out-of-scope feature, not one lumped line');
assert.deepStrictEqual(
  osChecks.map((c) => c.name),
  ['OS 1.1 External shares', 'OS 2.1 Timestamps', 'OS 3.1 SharedLinks', 'OS 4.1 Versions'],
  'named so _buildChecklist can match each one to its row'
);
for (const c of osChecks) {
  assert.strictEqual(c.status, 'INFO', 'never a PASS or a FAIL — the document does not judge these');
  assert.ok(/out of scope/i.test(c.detail),
    `${c.name} must say why it is unjudged, or the next reader adds a check the document does `
    + 'not ask for');
}
assert.ok(/3 matched pair\(s\) read/.test(osChecks[1].detail),
  'the timestamps row reports the measurement, not just the disclaimer — "out of scope" must not '
  + 'be allowed to read as "never looked"');
assert.ok(/NOT read on either side/.test(osChecks[3].detail),
  'versions are honestly reported as unmeasured rather than dressed up as an observation');

// ── A seeded grantee with no destination identity is OUR gap, not a product defect ─────
//
// Run 27a74447 is the case this pins. The job requested every permission flag, the source items
// genuinely carried the grants, and all 21 of them arrived as "no grant for this principal" —
// because the run's permission mapping held ONE pair (erik -> granger) and said nothing about
// alex@, mia@, warner@ or the two groups. CloudFuze had no destination identity to grant to, so it
// dropped every grant, and all four permission features reported FAIL against the product.
//
// The seeding agent now publishes those pairs. These assertions are the guard that keeps a future
// gap from reading as a failure again.
const mapped = agent._mappedSources({
  sourceEmail: 'erik@filefuze.co',
  userEmailMappings: [
    { sourceEmail: 'erik@filefuze.co', destinationEmail: 'granger@gajha.com' },
    { sourceEmail: 'alex@filefuze.co', destinationEmail: 'alex@gajha.com' },
  ],
  migratedUsers: [{ sourceEmail: 'mia@filefuze.co', destinationEmail: 'mia@gajha.com' }],
  permissionMapping: [{ fromMailId: 'warner@snapbot.io', toMailId: 'warner@gajha.com' }],
});
assert.ok(mapped.has('erik@filefuze.co'), 'the migrating pair is mapped');
assert.ok(mapped.has('alex@filefuze.co'), 'Map-Users pairs count');
assert.ok(mapped.has('mia@filefuze.co'), 'pairs the migration reported back count');
assert.ok(mapped.has('warner@snapbot.io'), 'the mapping CloudFuze resolved itself counts');
assert.ok(!mapped.has('qa-group-view@filefuze.co'),
  'a principal nobody mapped is NOT mapped — this is the case that must never read as a FAIL');

// The source account is always mapped even when no pairs were passed at all, because it IS the
// migrating pair. Without this a single-user run would treat the owner's own grant as unmappable.
assert.ok(agent._mappedSources({ sourceEmail: 'erik@filefuze.co' }).has('erik@filefuze.co'));
assert.strictEqual(agent._mappedSources({}).size, 0, 'and nothing is invented from an empty context');

// ── An unexercised position reports WARN and names the fix, never FAIL ─────────────────
const unmappedRun = agent._buildChecklist([
  { status: 'WARN',
    name: '2.1 Root Folder Permissions',
    detail: 'Not exercised: no root-level folder carried a judgeable grant at the source. The '
      + 'grants that exist are held by principals with no destination counterpart, so CloudFuze '
      + 'had nobody to grant to — add them to the run\'s Map Users pairs, or create matching '
      + 'accounts in the destination tenant.' },
]);
const row21 = unmappedRun.find((f) => f.id === '2.1');
assert.strictEqual(row21.status, 'na',
  'a position we could not exercise is not assessed — reporting it as FAIL blames the product for '
  + 'our own test data');
assert.ok(/Map Users|destination counterpart/.test(row21.detail),
  'and the detail tells the reader what to change, which is the whole value of the distinction');

// ── An over-limit branch is expected-absent WHOLE, whichever end the placeholder sits at ───
//
// The Results screen showed "Over Limit Path  6 -> 3  Mismatch" while feature 1.4 two sections
// above it said "missing 0". Both came from the same comparison: the validator excused the branch,
// but only the items at or ABOVE the placeholder reached the screen marked as placeholders, so the
// two items BELOW it arrived as Missing and the folder table contradicted the verdict.
const phBase = '/Over Limit Path';
const phPaths = [`${phBase}/L1/L2/L3`];
const underPh = (p) => phPaths.some((ph) => ph === p || ph.startsWith(`${p}/`) || p.startsWith(`${ph}/`));

assert.ok(underPh(`${phBase}/L1/L2/L3`), 'the placeholder itself');
assert.ok(underPh(`${phBase}/L1/L2/L3/L4`), 'a folder BELOW the placeholder cannot exist — its parent is a link');
assert.ok(underPh(`${phBase}/L1/L2/L3/L4/over_limit_target.txt`), 'nor a file deeper still');
assert.ok(underPh(`${phBase}/L1/L2`), 'an ancestor is excused too — the other direction, seen when the '
  + 'placeholder is the 504-char leaf and the missing items are its 260- and 382-char ancestors');
assert.ok(!underPh('/Agent Files/qa_notes.txt'),
  'an unrelated missing item is still a real loss — the excuse is per BRANCH, not blanket');

const overLimit = [phBase, `${phBase}/L1`, `${phBase}/L1/L2`, `${phBase}/L1/L2/L3`,
  `${phBase}/L1/L2/L3/L4`, `${phBase}/L1/L2/L3/L4/over_limit_target.txt`]
  .map((p, i) => ({ path: p, name: p.split('/').pop(), type: i === 5 ? 'file' : 'folder' }));
const reached = new Map(overLimit.slice(0, 3).map((s) => [s.path, { dest: { id: 'x', name: s.name } }]));
const absent = overLimit.slice(3).map((s) => ({ path: s.path }));
const unit = buildUnitResult(overLimit,
  { matched: reached, missing: absent.filter((m) => !underPh(m.path)), extra: [], misplaced: [], matchedCount: 3 },
  { placeholderPaths: new Set(absent.filter((m) => underPh(m.path)).map((m) => m.path)) });

const reachedCount = unit.items.filter((i) => i.found).length;
const placeheld = unit.items.filter((i) => i.placeholder).length;
assert.strictEqual(reachedCount + placeheld, unit.items.length,
  'the screen reads Match only when found + placeholder accounts for every source item — this is '
  + 'the arithmetic behind the "Over Limit Path 6 -> 3 Mismatch" row');
assert.strictEqual(unit.folderStructure.missing.length, 0,
  'and the folder table must agree with feature 1.4, which allows exactly this under SharePoint '
  + 'Online path length limits');

// ── The report must NAME what failed, at the end, not just count it ────────────────────
//
// Asked for directly: "if something fails like 8 out of 10 then we have to say the 8 which
// failed exactly ... at the last in that report so they can understand what is passed and what
// is not passed". The Failure Index at the TOP lists failing CHECKS, which is a longer and
// different list than the documented FEATURES, and it never says what passed.
//
// Tested through a pure function because a rendered PDF keeps its text inside compressed
// streams — asserting on the buffer would prove nothing about the words.
const { buildFeatureVerdictSummary } = require('../src/utils/pdfGenerator');

const verdictMixed = buildFeatureVerdictSummary([
  { id: '1.1', feature: 'One Time Migration', status: 'pass' },
  { id: '1.2', feature: 'Delta Migration', status: 'na' },
  { id: '1.3', feature: 'Files & Folder Migration', status: 'fail' },
  { id: '2.2', feature: 'Subfolder Permissions', status: 'fail' },
  { id: 'OS 1.1', feature: 'External shares', status: 'info' },
]);
assert.strictEqual(verdictMixed.judged, 4, 'out-of-scope rows are not part of the denominator');
assert.ok(/2 OF 4 IN-SCOPE FEATURE\(S\) FAILED/.test(verdictMixed.headline), verdictMixed.headline);

const byLabel = Object.fromEntries(verdictMixed.groups.map((g) => [g.label, g.names]));
assert.deepStrictEqual(byLabel.FAILED,
  ['1.3 Files & Folder Migration', '2.2 Subfolder Permissions'],
  'every failure is named in full — a count alone sends the reader back to hunt for them');
assert.deepStrictEqual(byLabel.PASSED, ['1.1 One Time Migration'],
  'and what passed is stated too, which the Failure Index never does');
assert.deepStrictEqual(byLabel['NOT ASSESSED'], ['1.2 Delta Migration']);
assert.deepStrictEqual(byLabel['OUT OF SCOPE'], ['OS 1.1 External shares'],
  'listed apart, because the document does not judge these and they must never read as failures');

// A clean run says so plainly rather than printing an empty FAILED row.
const verdictClean = buildFeatureVerdictSummary([
  { id: '1.1', feature: 'One Time Migration', status: 'pass' },
  { id: '1.2', feature: 'Delta Migration', status: 'na' },
]);
assert.ok(/none failed/.test(verdictClean.headline), verdictClean.headline);
assert.ok(!verdictClean.groups.some((g) => g.label === 'FAILED'),
  'no empty FAILED block on a run with nothing to report');

// An empty or malformed checklist must not throw — the report still has to render.
assert.strictEqual(buildFeatureVerdictSummary([]).groups.length, 0);
assert.strictEqual(buildFeatureVerdictSummary(null).groups.length, 0);
assert.strictEqual(buildFeatureVerdictSummary([null, undefined]).groups.length, 0);


// ── A migrated GROUP has a name and no email; a user has an email ─────────────────────
//
// Run fee5db73 failed 2.1-2.4 on a migration that was entirely correct. These are the exact
// permission entries read back from `/00-OneDrive-Perms` on that run:
//
//   {"email":"alex@gajha.com", "name":"alex",          "roles":["write"]}
//   {"email":null,             "name":"qa-group-view", "roles":["write"]}
//
// The source grant is `qa-group-view@filefuze.co` — an email with no display name — and the
// destination entry is a display name with no email, so email, display-name and email-local-part
// matching all miss. The matcher then fell through to the `group-mapping.csv` address and compared
// the group against mia, reporting `fileOrganizer -> read (expected Edit)` while `qa-group-view`
// sat on the same item holding exactly the `write` the feature wanted.
const destPerms = [
  { email: null, name: null, roles: ['read'], isLink: true },
  { email: 'alex@gajha.com', name: 'alex', roles: ['write'], isLink: false },
  { email: 'warner@gajha.com', name: 'warner w', roles: ['write'], isLink: false },
  { email: 'mia@gajha.com', name: 'mia M', roles: ['read'], isLink: false },
  { email: null, name: 'qa-group-edit', roles: ['write'], isLink: false },
  { email: null, name: 'qa-group-manage', roles: ['write'], isLink: false },
  { email: null, name: 'qa-group-view', roles: ['write'], isLink: false },
  { email: 'granger@gajha.com', name: 'Granger G', roles: ['owner'], isLink: false },
];
const roleOf = (who) => {
  const hit = Agent.matchPrincipal(destPerms, { email: who });
  return hit ? hit.grant.roles.join('/') : null;
};

assert.strictEqual(roleOf('qa-group-view@filefuze.co'), 'write',
  'a group matches the destination entry that carries its name — this is the miss that failed '
  + '2.1 through 2.4 on a correct migration');
assert.strictEqual(roleOf('qa-group-edit@filefuze.co'), 'write');
assert.strictEqual(roleOf('qa-group-manage@filefuze.co'), 'write');

// The group rule must not steal a match from a real address.
assert.strictEqual(roleOf('alex@filefuze.co'), 'write', 'alex resolves by address, not by name');
assert.strictEqual(roleOf('mia@filefuze.co'), 'read',
  'mia keeps her own read — the destination name is "mia M", so only the address can match her');

// And it only ever considers entries that have NO email, so a user is never matched by a name
// that happens to look like their local part.
assert.strictEqual(
  Agent.matchPrincipal(
    [{ email: 'someone.else@gajha.com', name: 'alex', roles: ['write'], isLink: false }],
    { email: 'alex@filefuze.co' }
  ),
  null,
  'a name collision on an entry that HAS an email is not a group and must not match'
);
assert.strictEqual(Agent.matchPrincipal([{ isLink: true, name: 'qa-group-view', roles: ['read'] }],
  { email: 'qa-group-view@filefuze.co' }), null, 'a link is never a principal');

// ── The permission pass must actually RUN in a test, not only be reasoned about ────────
//
// Run 2934c640 died after twenty minutes of real work with "Cannot access 'osSource' before
// initialization": a read of a `const` twenty lines above its declaration, inside the per-item
// loop. Every unit test passed, lint passed, and three earlier runs never reached that line
// because the loop only gets there when an item has grants to classify.
//
// Nothing here talks to a cloud. The two clients are replaced with stubs, which is enough to
// execute the whole path — and any temporal-dead-zone, typo or bad-shape error in it fails loudly
// and in under a second instead of after a migration.
// The wait budget is switched off for the smoke test. It defaults to ten minutes, which is
// correct for a real run and unacceptable in a suite — and a test that silently sat there
// would be worse than no test. Mutating the loaded config object is deliberate: env.js reads
// process.env once at require time, so setting the variable here would already be too late.
require('../src/config/env').SHAREDDRIVE_PERMISSION_SETTLE_MS = 0;
const driveClientStub = require('../src/clients/driveClient');
const onedriveClientStub = require('../src/clients/onedriveClient');

const realDriveListPermissions = driveClientStub.listPermissions;
const realOdGetById = onedriveClientStub.getPermissionsById;
const realOdCounterpart = onedriveClientStub.resolveCounterpart;

// A source drive with two members, and one item carrying a direct external grant plus a link, so
// every branch of the classification is exercised: membership, external, link, and mapped user.
driveClientStub.listPermissions = async (id) => (id === 'DRIVE'
  ? {
    grants: [
      { email: 'erik@filefuze.co', role: 'organizer', type: 'user', inherited: false },
      { email: 'alex@filefuze.co', role: 'fileOrganizer', type: 'user', inherited: false },
      { email: 'mia@filefuze.co', role: 'reader', type: 'user', inherited: false },
    ],
    links: [],
  }
  : {
    grants: [
      { email: 'alex@filefuze.co', role: 'fileOrganizer', type: 'user', inherited: true, inheritedFrom: 'DRIVE' },
      { email: 'outsider@example.org', role: 'writer', type: 'user', inherited: false },
    ],
    links: [{ type: 'anyone', role: 'reader' }],
  });
onedriveClientStub.getPermissionsById = async () => ({
  readable: true,
  permissions: [
    { email: 'alex@gajha.com', roles: ['write'], isLink: false },
    { email: 'mia@gajha.com', roles: ['read'], isLink: false },
    { isLink: true, linkScope: 'organization', roles: ['read'] },
  ],
});
onedriveClientStub.resolveCounterpart = async (who) => ({
  address: String(who).split('@')[0] + '@gajha.com', kind: 'user', exact: true,
});

(async () => {
  const smokeAgent = new Agent();
  const sourceTree = [
    { id: 'f1', path: '/Root Folder', name: 'Root Folder', type: 'folder' },
    { id: 'f2', path: '/Root Folder/Sub', name: 'Sub', type: 'folder' },
    { id: 'f3', path: '/root.txt', name: 'root.txt', type: 'file' },
    { id: 'f4', path: '/Root Folder/inner.txt', name: 'inner.txt', type: 'file' },
  ];
  const matched = new Map(sourceTree.map((s) => [s.path, { source: s, dest: { id: `d-${s.id}`, name: s.name } }]));
  const checks = [];
  const totals = {
    permissionObservations: [], notJudged: [],
    outOfScope: {
      externalSource: [], externalDest: [], linksSource: [], linksDest: [],
      tsCompared: 0, tsCreatedDrift: [], tsModifiedDrift: [], versions: null,
    },
  };

  await smokeAgent._checkPermissions(
    (status, name, detail) => checks.push({ status, name, detail }),
    sourceTree,
    { matched, matchedCount: matched.size, missing: [], extra: [], misplaced: [] },
    { id: 'DESTDRIVE' },
    'granger@gajha.com',
    'erik@filefuze.co',
    totals,
    { sourceEmail: 'erik@filefuze.co',
      userEmailMappings: [
        { sourceEmail: 'alex@filefuze.co', destinationEmail: 'alex@gajha.com' },
        { sourceEmail: 'mia@filefuze.co', destinationEmail: 'mia@gajha.com' },
      ] },
    'DRIVE'
  );

  // Every documented position produced a verdict — the point of the pass.
  for (const id of ['2.1', '2.2', '2.3', '2.4']) {
    assert.ok(checks.some((c) => c.name.startsWith(`${id} `)), `${id} produced no verdict`);
  }
  // The classification ran: a link at the source is seen (it lives on perms.links, not grants)
  // and the outside-domain grant is held back from the in-scope comparison.
  assert.ok(totals.outOfScope.linksSource.length > 0,
    'a source link must be observed — reading links from `grants` is what made this report zero');
  assert.ok(totals.notJudged.some((n) => n.why === 'external'),
    'an out-of-domain grant is set aside, not judged against an in-scope feature');

  // Restore, so the stubs cannot leak into anything that runs after this file.
  driveClientStub.listPermissions = realDriveListPermissions;
  onedriveClientStub.getPermissionsById = realOdGetById;
  onedriveClientStub.resolveCounterpart = realOdCounterpart;

  console.log('googleshareddriveToOnedrive: OK');
})().catch((err) => {
  driveClientStub.listPermissions = realDriveListPermissions;
  onedriveClientStub.getPermissionsById = realOdGetById;
  onedriveClientStub.resolveCounterpart = realOdCounterpart;
  console.error(err);
  process.exit(1);
});
