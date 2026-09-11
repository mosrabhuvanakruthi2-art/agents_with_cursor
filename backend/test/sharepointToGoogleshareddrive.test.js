/**
 * Run: npm test  (from backend/)
 *
 * SharePoint Online → Google Shared Drive. The first combination with SharePoint as its SOURCE, so
 * what is asserted here is everything that would otherwise only surface during a live run, and
 * would surface looking like a migration defect rather than a wiring error:
 *
 *   - the registry resolves the pair, with a seeding agent and a DEEP validator (without
 *     supportsDeepValidation the orchestrator silently falls back to the report-only agent, which
 *     compares nothing and can report SUCCESS having validated nothing)
 *   - the tolerance bands, role map and destination rules for the pair all exist and are the
 *     GOOGLE ones — falling back to the SharePoint tables would invent renames, path relocations
 *     and mistranslated grants that the destination never performs
 *   - the role table maps SharePoint's vocabulary in both directions, refuses to compare an owner
 *     grant, and treats a "specific people" link as a permission rather than a link
 *   - the feature checklist covers all 17 documented features and reports an unexercised one as
 *     `na`, never as a pass
 *   - SharePoint's own site groups are excluded from the permission comparison
 *   - the client can address a NAMED library, which is what feature 15.1 needs
 *
 * No network is exercised: every assertion is over pure functions and the module registries.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const registry = require('../src/orchestrator/agentRegistry');
const ValidationAgent = require('../src/validation/combinations/content/sharepointToGoogleshareddrive');
const GoogleDriveValidationAgent = require('../src/agents/googledrive/GoogleDriveValidationAgent');
const SharePointTestDataAgent = require('../src/agents/sharepoint/SharePointTestDataAgent');
const sharepointClient = require('../src/clients/sharepointClient');
const roleMaps = require('../src/validation/roleMaps');
const destinations = require('../src/validation/destinations');
const tolerance = require('../src/utils/contentTolerance');

const COMBINATION = 'sharepoint_to_googleshareddrive';

/** The pair resolves, seeds with the SharePoint agent, and validates DEEPLY. */
function testRegistration() {
  const entry = registry.resolve('content', 'sharepoint', 'googleshareddrive');
  assert.ok(entry, 'content:sharepoint:googleshareddrive is registered');
  assert.strictEqual(entry.TestDataAgent, SharePointTestDataAgent,
    'the SharePoint source is seeded by SharePointTestDataAgent');
  assert.strictEqual(entry.ValidationAgent, ValidationAgent,
    'the pair resolves to its own validator');
  assert.strictEqual(entry.ValidationAgent.supportsDeepValidation, true,
    'without supportsDeepValidation the orchestrator falls back to the report-only agent, which '
    + 'compares nothing');
  assert.ok(ValidationAgent.prototype instanceof GoogleDriveValidationAgent,
    'the destination half is the shared Google agent, not a copy');
}

/** The pair reads the GOOGLE bands, role map and destination rules — never SharePoint fallbacks. */
function testLookups() {
  const bands = tolerance.forCombination(COMBINATION);
  assert.ok(bands, 'tolerance bands exist for the combination');
  assert.strictEqual(bands.pathLengthLimit, Infinity,
    'Google imposes no path limit — a finite limit would make the validator expect relocations');
  assert.ok(bands.treeDepth >= SharePointTestDataAgent.LONG_PATH_LEVELS,
    'the tree must be read deeper than the long-path chain the seeder builds, or feature 12.1 '
    + 'cannot see its own data');
  assert.ok(bands.convertedFileSize.infoMin === 0,
    'a Google native doc reports little or no size, so the converted band must reach 0');

  const rules = destinations.forDestination('googleshareddrive');
  assert.ok(rules, 'Google Shared Drive destination rules are registered');
  assert.strictEqual(rules.needsSanitizing('Special !@#$ Chars'), false,
    'Google rewrites no character — feature 11.1 is a negative test');

  const map = roleMaps.forCombination(COMBINATION);
  assert.ok(map, 'a role map covers the combination');
  assert.strictEqual(map.pair, 'sharepoint_to_google');
}

/** SharePoint roles translate to Google access, and non-comparable ones are refused. */
function testRoleTranslation() {
  const map = roleMaps.forCombination(COMBINATION);

  assert.strictEqual(map.expectedGoogleLabel('write'), 'Editor');
  assert.strictEqual(map.expectedGoogleLabel('read'), 'Viewer');
  assert.strictEqual(map.expectedGoogleLabel('sp.edit'), 'Editor',
    'SharePoint role-definition names travel through the same field as Graph roles');

  // Equal access, not merely sufficient access.
  assert.strictEqual(map.compareDriveAccess('write', ['writer']).match, true);
  assert.strictEqual(map.compareDriveAccess('read', ['reader']).match, true);
  const escalated = map.compareDriveAccess('read', ['writer']);
  assert.strictEqual(escalated.match, false, 'a viewer arriving as an editor is not a match');
  assert.strictEqual(escalated.overGranted, true, 'it is reported as a privilege escalation');
  assert.strictEqual(map.compareDriveAccess('write', ['reader']).underGranted, true);

  // The migrating account owns the destination copy, so the source owner is not re-granted.
  assert.strictEqual(map.isComparableDriveRole('owner'), false);
  assert.strictEqual(map.isComparableDriveRole('sp.full control'), false);
  // Limited Access grants nothing on the item itself.
  assert.strictEqual(map.isComparableDriveRole('sp.limited access'), false);
  assert.strictEqual(map.isComparableDriveRole('write'), true);
  assert.ok(/owner/i.test(map.nonComparableReason('owner')));
}

/** Link scope AND type are both asserted, and a "specific people" link is not a link. */
function testLinkTranslation() {
  const map = roleMaps.forCombination(COMBINATION);

  const orgView = map.compareSharedLink(
    { scope: 'organization', type: 'view' },
    [{ scope: 'organization', type: 'view' }]
  );
  assert.strictEqual(orgView.match, true);

  // Scope right, type wrong — a view link that arrived as an edit link must not pass.
  const wrongType = map.compareSharedLink(
    { scope: 'organization', type: 'view' },
    [{ scope: 'organization', type: 'edit' }]
  );
  assert.strictEqual(wrongType.scopeMatch, true);
  assert.strictEqual(wrongType.typeMatch, false);
  assert.strictEqual(wrongType.match, false);

  const anon = map.compareSharedLink({ scope: 'anonymous', type: 'view' }, [{ scope: 'anonymous', type: 'view' }]);
  assert.strictEqual(anon.match, true);

  // A "specific people" link is a per-user grant wearing a link. Judging it as a link would fail
  // every one of them against a destination that expressed it correctly as a permission.
  const users = map.compareSharedLink({ scope: 'users', type: 'view' }, []);
  assert.strictEqual(users.comparable, false);
  assert.ok(/per-user grant/i.test(users.reason));
}

/** SharePoint's own site groups are not migrated permissions and must not be compared. */
function testBuiltinSiteGroupsExcluded() {
  const { isBuiltinSiteGroup } = ValidationAgent;
  assert.strictEqual(isBuiltinSiteGroup({ principalType: 'group', name: 'QA Owners' }), true);
  assert.strictEqual(isBuiltinSiteGroup({ principalType: 'group', name: 'QA Members' }), true);
  assert.strictEqual(isBuiltinSiteGroup({ principalType: 'group', name: 'QA Visitors' }), true);
  assert.strictEqual(
    isBuiltinSiteGroup({ principalType: 'group', email: 'qa@contoso.onmicrosoft.com' }), true
  );
  // A real seeded group must still be compared.
  assert.strictEqual(isBuiltinSiteGroup({ principalType: 'group', email: 'qa-team@filefuze.co' }), false);
  assert.strictEqual(isBuiltinSiteGroup({ principalType: 'user', email: 'ben@filefuze.co' }), false);
}

/** All 17 features are covered, and an unexercised feature is `na` — never a pass. */
function testChecklist() {
  const agent = new ValidationAgent();
  const features = ValidationAgent.SHAREPOINT_FEATURES;
  assert.strictEqual(features.length, 17,
    'the in-scope document lists 17 features; the checklist must cover each one');

  // Nothing scanned: every feature is na, and none may read as a pass.
  const nothing = agent._buildChecklist(
    { enabled: true, scannedSourceItems: 0, migrationType: 'FULL' }, []
  );
  assert.strictEqual(nothing.length, 17);
  assert.ok(nothing.every((r) => r.status === 'na'),
    'a run that read no source items validated nothing — no feature may report a pass');

  // A passing structure check answers 2.1 and, on a FULL run, 1.1 — but not 1.2.
  const totals = { enabled: true, scannedSourceItems: 12, migrationType: 'FULL' };
  const checks = [
    { name: '[unit] 2.1 Preserving File/Folder structure', status: 'PASS', detail: 'all matched' },
    { name: '[unit] 3.1 Root Folder Permissions', status: 'PASS', detail: '2 grants matched' },
    { name: '[unit] 7.1 Shared links', status: 'FAIL', detail: '1 of 2 links differ' },
    { name: '13.1 Suppress email notifications', status: 'WARN', detail: 'not verified' },
  ];
  const rows = agent._buildChecklist(totals, checks);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  assert.strictEqual(byId['2.1'].status, 'pass');
  assert.strictEqual(byId['1.1'].status, 'pass', 'a one-time run inherits the structure verdict');
  assert.strictEqual(byId['1.2'].status, 'na', 'this run was not a delta');
  assert.strictEqual(byId['3.1'].status, 'pass');
  assert.strictEqual(byId['7.1'].status, 'fail');
  // A WARN means "measured, but not assessable" — na, never pass.
  assert.strictEqual(byId['13.1'].status, 'na',
    'an unverifiable feature must not report as passing');
  assert.strictEqual(byId['15.1'].status, 'na', 'no custom library check ran in this run');

  // The unit prefix must not hide a feature id. Anchoring the pattern with ^ alone matched
  // nothing, and every feature then read "not exercised" beside its own PASS.
  assert.ok(byId['3.1'].detail.includes('2 grants matched'),
    'the checklist reads the detail of the prefixed per-unit check');
}

/** A FAIL anywhere fails the run; an out-of-scope INFO row never does. */
function testOutOfScopeNeverFails() {
  const agent = new ValidationAgent();
  const notes = ValidationAgent.OUT_OF_SCOPE_NOTES;
  assert.strictEqual(notes.length, 13,
    'the out-of-scope document lists 13 limitations; each is recorded on every run');

  const infoOnly = notes.map(([name, note]) => ({ name: `Out of scope · ${name}`, status: 'INFO', detail: note }));
  const result = agent._buildResult(
    [{ name: 'Destination location', status: 'PASS', detail: 'ok' }, ...infoOnly],
    [],
    { enabled: true, scannedSourceItems: 5, pairedCount: 5, migrationType: 'FULL' },
    { destinationProvider: 'googleshareddrive' }
  );
  assert.strictEqual(result.status, 'PASS',
    'INFO rows are records, not verdicts — an out-of-scope note must never move the status');
  assert.strictEqual(result.combination, COMBINATION);
  assert.strictEqual(result.sourceProvider, 'sharepoint');
  assert.strictEqual(result.mismatches.length, 0);

  const failed = agent._buildResult(
    [{ name: '[unit] 7.1 Shared links', status: 'FAIL', detail: 'link missing' }, ...infoOnly],
    [],
    { enabled: true, scannedSourceItems: 5, pairedCount: 5, migrationType: 'FULL' },
    { destinationProvider: 'googleshareddrive' }
  );
  assert.strictEqual(failed.status, 'FAIL');
  assert.strictEqual(failed.mismatches.length, 1, 'the FAIL is surfaced as a mismatch row');
}

/** A run that moved nothing says so, instead of reporting its reachability checks as a pass. */
function testMovedNothingIsNotAPass() {
  const agent = new ValidationAgent();
  const result = agent._buildResult(
    [{ name: 'Destination location', status: 'PASS', detail: 'resolved' }],
    [],
    { enabled: true, scannedSourceItems: 40, pairedCount: 0, migrationType: 'FULL' },
    { destinationProvider: 'googleshareddrive' }
  );
  assert.ok(/MIGRATION MOVED NOTHING/.test(result.summary),
    'zero paired items out of a non-empty source must be stated plainly in the summary');
}

/** The combination key follows the destination, so a My Drive run cannot read Shared Drive bands. */
function testCombinationKeyFollowsDestination() {
  const { combinationFor } = ValidationAgent;
  assert.strictEqual(combinationFor({ destinationProvider: 'googleshareddrive' }), COMBINATION);
  assert.strictEqual(combinationFor({ destinationProvider: 'googledrive' }), 'sharepoint_to_googledrive');
  assert.strictEqual(combinationFor({}), COMBINATION, 'the Shared Drive pair is the default');
}

/** The client can address a NAMED library — what feature 15.1 (Custom Library) needs. */
function testClientSurface() {
  for (const fn of ['listDrives', 'findDriveByName', 'ensureDocumentLibrary', 'createFolder',
    'uploadFile', 'invitePermission', 'createSharingLink']) {
    assert.strictEqual(typeof sharepointClient[fn], 'function', `sharepointClient.${fn} exists`);
  }
  // Addressing: with no driveId a path resolves in the site's DEFAULT library; with one it
  // resolves in that library. Getting this wrong reads (or deletes) the same path in Documents.
  const { driveItemUrl } = sharepointClient;
  assert.ok(driveItemUrl('site1', '/Agent Data').includes('/sites/site1/drive/root:/Agent%20Data'),
    'no driveId addresses the site default library, with each segment encoded');
  assert.ok(driveItemUrl('site1', '/Agent Data', '', { driveId: 'b!abc' })
    .includes('/drives/b!abc/root:/Agent%20Data'),
    'a driveId addresses that named library instead');
  assert.ok(driveItemUrl('site1', '/', '/children').includes('/drive/root/children'),
    'the library root has no path segment');
}

/** Both scope documents ship with the code — CONTRIBUTING requires reading them before a change. */
function testFeatureScopeDocsExist() {
  const dir = path.join(__dirname, '..', 'data', 'feature-scope');
  for (const name of ['sharepoint-to-google-shared-drive-inscope.md',
    'sharepoint-to-google-shared-drive-outscope.md']) {
    const file = path.join(dir, name);
    assert.ok(fs.existsSync(file), `${name} exists`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('SharePoint to Shared Drive'), `${name} names the combination`);
  }
  // Every in-scope feature id in the checklist appears in the document, so the report and the
  // document a reviewer holds cannot drift apart.
  const inscope = fs.readFileSync(
    path.join(dir, 'sharepoint-to-google-shared-drive-inscope.md'), 'utf8'
  );
  for (const f of ValidationAgent.SHAREPOINT_FEATURES) {
    assert.ok(inscope.includes(`${f.id} `) || inscope.includes(`| ${f.id} |`),
      `feature ${f.id} appears in the in-scope document`);
  }
}

/**
 * The path handed to CloudFuze for a SharePoint SOURCE carries the site and library.
 *
 * CloudFuze addresses a SharePoint cloud as /<Site display name>/<Library>/<folder>: its own
 * enumeration lists the site as objectName "QA", and a mapping that passes in its UI reads
 * "/SS test/Documents". Every job this repo sent used the library-relative form and came back
 * "Migration not Allowed for wrong CSV paths" with totalFilesAndFolders=0 — pair attached, source
 * id supplied, only the path wrong. Pinned here because it is invisible until a live run fails.
 */
function testSharepointCloudPath() {
  const migrationClient = require('../src/clients/migrationClient');
  const { sharepointCloudPath } = migrationClient;
  assert.strictEqual(typeof sharepointCloudPath, 'function', 'the helper is exported');

  const sp = { sourceCloudName: 'SHAREPOINT_ONLINE_BUSINESS', sourceCloudPathPrefix: '/QA/Documents' };
  assert.strictEqual(sharepointCloudPath(sp, '/tosharedrive'), '/QA/Documents/tosharedrive',
    'the site and library are prefixed');
  // Idempotent, or a resumed run would send /QA/Documents/QA/Documents/...
  assert.strictEqual(sharepointCloudPath(sp, '/QA/Documents/tosharedrive'), '/QA/Documents/tosharedrive',
    'an already-prefixed path is left alone');
  assert.strictEqual(sharepointCloudPath(sp, '/qa/documents/tosharedrive'), '/qa/documents/tosharedrive',
    'the idempotence check is case-insensitive — SharePoint names are');
  assert.strictEqual(sharepointCloudPath(sp, '/'), '/', 'the cloud root is not prefixed');

  // Every other combination must be byte-identical.
  assert.strictEqual(
    sharepointCloudPath({ sourceCloudName: 'BOX_BUSINESS', sourceCloudPathPrefix: '/QA/Documents' }, '/x'),
    '/x', 'a non-SharePoint source is untouched even if a prefix is present');
  assert.strictEqual(sharepointCloudPath({ sourceCloudName: 'SHAREPOINT_ONLINE_BUSINESS' }, '/x'), '/x',
    'with no prefix known the path is unchanged rather than guessed');
  assert.strictEqual(sharepointCloudPath({}, '/x'), '/x', 'no cloud name — unchanged');
}

/**
 * A base name containing "/" is a PATH, not a name.
 *
 * Graph rejects "a/b" as an item name ("The item name cannot contain a '/'") and the run died in
 * seeding — which is what happens when the wizard's "Source folder base name" is filled in with a
 * CloudFuze-style path. The seeder now creates the segments instead.
 */
function testNestedBaseNameIsCreatedAsSegments() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'agents', 'sharepoint', 'SharePointTestDataAgent.js'), 'utf8');
  assert.ok(/rootName\.split\('\/'\)/.test(src),
    'the base name is split on "/" rather than passed to Graph whole');
  assert.ok(/cannot contain a/.test(src),
    'the reason is recorded next to the fix, so it is not re-broken');
  assert.ok(/cloudPathPrefix/.test(src),
    'the seeder computes the CloudFuze path prefix, which is what that field was being misused for');
}

/**
 * Judgement rules learned from the first run that actually migrated data (58/58, exec 45f75a47).
 * Each of these produced a wrong verdict in that report, in a different direction.
 */
function testFirstRunJudgementFixes() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'validation', 'combinations',
    'content', 'sharepointToGoogleshareddrive.js'), 'utf8');
  // Comments stripped for the absence assertions below: the file documents the wrong field name it
  // used to read, so a document-wide search finds the explanation of the bug, not the bug.
  const src = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  // 1. Missing grants were excused as "not judgeable yet" while OTHER items in the same run had
  //    already received theirs — folder permissions had genuinely not arrived, and the checklist
  //    showed N/A instead of a finding.
  assert.ok(/const sharingHasRun =/.test(src),
    'the pending excuse is decided run-wide, not per item');
  assert.ok(/sharingHasRun\)/.test(src), 'and it gates the pending branch');
  assert.ok(/OTHER items in this same run/.test(src),
    'the FAIL explains why it is not a delay');
  // The finding must LEAD the message. The Key Issues panel and the PDF failure index take the text
  // after the last em dash as the root cause, so a message ending in an explanatory clause is
  // summarised as a fragment starting mid-sentence — which is exactly how "but OTHER items in this
  // same run did receive their direct grants…" reached the report as a headline.
  assert.ok(/grant\(s\) missing at the destination: /.test(src),
    'the message opens with the finding and the affected paths');
  assert.ok(!/only the inherited drive grant — but/.test(src),
    'and does not trail an explanation after an em dash');

  // 2. Google holds ONE general-access entry per scope, so two source links sharing a scope cannot
  //    both exist — judging them separately failed the pair for a platform limit.
  assert.ok(/strongestByScope/.test(src), 'source links are collapsed to the strongest per scope');
  assert.ok(/seenLink/.test(src), 'and deduped, since a parent folder link is reported on children');

  // 3. An anonymous link the destination never produces anywhere is a Workspace policy, reported
  //    apart and never as a pass.
  assert.ok(/destAnonymousLinkSeen/.test(src), 'the run records whether anonymous links work at all');
  assert.ok(/anonBlocked/.test(src), 'and anonymous refusals are separated from real differences');

  // 4. extractDocxLinks returns { targets, reason } — reading `links`/`error` made every document
  //    look empty and mis-stated "not rewritten" as "link lost".
  assert.ok(/read\.targets/.test(src), 'the docx reader is read by its real field name');
  assert.ok(!/read\.links/.test(src), 'and not by the field it does not have');

  // 5. A stray string concatenation printed `' + '` inside the 9.1 detail.
  assert.ok(!/file\(s\)\. "Created By" \/ '/.test(src), 'the 9.1 detail is one clean string');

  // 6. A grant whose principal has no destination counterpart is a mapping gap, not absent data.
  assert.ok(/MAPPING gap, not missing test/.test(src),
    'an unmappable principal is reported as such rather than "not exercised"');
}

/** The report labels the destination half of a permission row with the DESTINATION cloud. */
function testReportDestinationLabel() {
  const pdf = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'pdfGenerator.js'), 'utf8');
  assert.ok(/const dstLabel = it\.destLabel \|\| 'SP';/.test(pdf),
    'pdfGenerator takes a destLabel, defaulting to SP so other combinations are unchanged');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'validation', 'combinations',
    'content', 'sharepointToGoogleshareddrive.js'), 'utf8');
  assert.ok(/destLabel: 'Google'/.test(src),
    'this combination labels its destination Google, not SP');
}

const tests = [
  ['registration', testRegistration],
  ['first-run judgement fixes', testFirstRunJudgementFixes],
  ['report labels the destination cloud', testReportDestinationLabel],
  ['SharePoint source path carries site + library', testSharepointCloudPath],
  ['a slash in the base name creates nested folders', testNestedBaseNameIsCreatedAsSegments],
  ['lookups (bands, rules, role map)', testLookups],
  ['role translation', testRoleTranslation],
  ['link translation', testLinkTranslation],
  ['built-in site groups excluded', testBuiltinSiteGroupsExcluded],
  ['feature checklist', testChecklist],
  ['out-of-scope notes never fail a run', testOutOfScopeNeverFails],
  ['a migration that moved nothing is not a pass', testMovedNothingIsNotAPass],
  ['combination key follows the destination', testCombinationKeyFollowsDestination],
  ['client surface for a named library', testClientSurface],
  ['feature scope documents', testFeatureScopeDocsExist],
];

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
}
console.log(`sharepointToGoogleshareddrive: ${tests.length - failures}/${tests.length} passed`);
if (failures > 0) process.exit(1);
