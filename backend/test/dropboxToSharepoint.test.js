/**
 * Run: npm test  (from backend/)
 *
 * Dropbox → SharePoint Online.
 *
 * Half of this file tests the new combination. The other half — and the more important half — proves
 * the new combination DISTURBS NOTHING. Four combinations were already live and green when this pair
 * was added:
 *
 *   box → sharepoint            googledrive → sharepoint
 *   dropbox → googledrive       dropbox → googleshareddrive
 *
 * The two SharePoint ones share `validation/contentRoleMap.js` and the SharePoint destination rules;
 * the two Dropbox ones share `dropboxClient` and the seeding agent. A new pair that touched any of
 * those in the wrong way would silently move their verdicts. The isolation assertions below are the
 * mechanical version of "it should not disturb them" — a promise nobody has to take on trust.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const registry = require('../src/orchestrator/agentRegistry');
const DropboxTestDataAgent = require('../src/agents/dropbox/DropboxTestDataAgent');
const ValidationAgent = require('../src/validation/combinations/content/dropboxToSharepoint');
const SharePointValidationAgent = require('../src/agents/sharepoint/SharePointValidationAgent');
const roleMaps = require('../src/validation/roleMaps');
const tolerance = require('../src/utils/contentTolerance');
const destinations = require('../src/validation/destinations');
const orchestrator = require('../src/orchestrator/AgentOrchestrator');

const SCOPE_DIR = path.join(__dirname, '..', 'data', 'feature-scope');

/* ── The new combination ──────────────────────────────────────────────────────────────────── */

function testRegistration() {
  const entry = registry.resolve('content', 'dropbox', 'sharepoint');
  assert.ok(entry, 'content:dropbox:sharepoint is registered');
  assert.strictEqual(entry.TestDataAgent, DropboxTestDataAgent, 'seeds with the Dropbox agent');
  assert.strictEqual(entry.ValidationAgent, ValidationAgent, 'validates with its own agent');
  // Without this the orchestrator falls back to ContentReportValidationAgent, which compares
  // nothing and can report a verdict while validating nothing.
  assert.strictEqual(entry.ValidationAgent.supportsDeepValidation, true,
    'declares supportsDeepValidation — otherwise the run is report-only');
  assert.ok(ValidationAgent.prototype instanceof SharePointValidationAgent,
    'extends the SharePoint destination agent, so the destination is read in one place');
  console.log('  registration: ok');
}

function testFeatureListMatchesTheDocument() {
  const features = ValidationAgent.DROPBOX_SP_FEATURES;
  assert.strictEqual(features.length, 36, 'the scope document declares 36 in-scope features');

  // The document's own numbering, which is NOT the Dropbox→Google numbering.
  const ids = features.map((f) => f.id);
  assert.ok(ids.includes('2.1'), 'Folder Display is §2.1 — it has no Dropbox→Google equivalent');
  assert.ok(ids.includes('3.1') && ids.includes('3.2'), 'Versions is §3 here, not §9');
  assert.ok(ids.includes('4.5'), 'External Shares is §4.5 here, not §2.5');
  assert.ok(ids.includes('11.19'), 'Paper is §11 here, not §10');
  assert.strictEqual(ids.filter((i) => i.startsWith('11.')).length, 19, '19 Paper features');
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate feature ids');

  // Guard against someone pasting the Google list in: those ids do not exist in this document.
  assert.ok(!ids.includes('10.19'), 'Paper must not carry the Google document\'s §10 numbering');
  console.log('  feature list matches the scope document: ok');
}

function testScopeDocumentsExist() {
  for (const type of ['inscope', 'outscope']) {
    const fp = path.join(SCOPE_DIR, `dropbox-to-sharepoint-${type}.md`);
    assert.ok(fs.existsSync(fp), `${path.basename(fp)} exists — the checklist has nothing to enumerate without it`);
  }
  const inscope = fs.readFileSync(path.join(SCOPE_DIR, 'dropbox-to-sharepoint-inscope.md'), 'utf8');
  assert.ok(/Total Features:\*\*\s*36/.test(inscope), 'the in-scope document declares 36 features');
  assert.ok(/Word \(`?\.docx/i.test(inscope), 'records that Paper converts to Word .docx, not a Google Doc');
  console.log('  scope documents present: ok');
}

function testSharePointRulesNotGoogleRules() {
  const bands = tolerance.forCombination('dropbox_to_sharepoint');
  assert.ok(bands, 'tolerance bands are registered under the combination key');

  // The single most important pair of numbers in this file. The Dropbox→Google bands are
  // Infinity/32767 because Google has no limits; inheriting them here would silence feature 8.1
  // entirely and report every over-limit item as missing instead of as a placeholder link.
  assert.strictEqual(bands.pathLengthLimit, 400, 'SharePoint enforces a 400-character encoded path');
  assert.strictEqual(bands.segmentLengthLimit, 255, 'and 255 characters per segment');

  const google = tolerance.forCombination('dropbox_to_googledrive');
  assert.strictEqual(google.pathLengthLimit, Infinity,
    'the Google pair still has no path limit — this change did not touch it');

  // Scope §3.1: SharePoint adds exactly one system version stamped with the migration time.
  assert.strictEqual(bands.versionExtraAllowed, 1, 'one extra destination version is expected');
  assert.strictEqual(bands.versionWindowDays, 180, 'Dropbox versions older than 180 days do not migrate');
  assert.strictEqual(bands.countDelta, 0, 'structure counts stay exact');
  assert.ok(bands.treeDepth > 20, 'must exceed the 20-level chain the seeder creates');

  // ~ # % & { } are VALID in SharePoint. Predicting them replaced produced four wrong findings on
  // run 6a8d53d2, and boxToSharepoint.js still carries that bad character class locally.
  const rules = destinations.forDestination('sharepoint');
  for (const ch of ['~', '#', '%', '&', '{', '}']) {
    assert.strictEqual(rules.needsSanitizing(`name${ch}x`), false, `"${ch}" is valid in SharePoint`);
  }
  for (const ch of ['<', '>', ':', '?', '|', '*']) {
    assert.strictEqual(rules.needsSanitizing(`name${ch}x`), true, `"${ch}" must be replaced`);
  }
  console.log('  SharePoint rules in force, Google rules absent: ok');
}

function testRoleMap() {
  const map = roleMaps.forCombination('dropbox_to_sharepoint');
  assert.ok(map, 'a role map covers this combination');

  // The four functions deepContentCore calls.
  for (const fn of ['isComparableDriveRole', 'nonComparableReason', 'compareDriveAccess', 'compareSharedLink']) {
    assert.strictEqual(typeof map[fn], 'function', `exposes ${fn}()`);
  }

  // Calling convention: this directory returns a NUMBER. contentRoleMap.js returns a string key.
  assert.strictEqual(typeof map.driveRoleLevel('editor'), 'number',
    'driveRoleLevel returns a number here — mixing conventions mis-scores every grant');

  // Dropbox has no commenter, so a read-level destination role is never a valid outcome for Editor.
  const downgrade = map.compareDriveAccess('editor', ['read']);
  assert.strictEqual(downgrade.match, false, 'Editor arriving as Read is a downgrade');
  assert.strictEqual(downgrade.underGranted, true, 'and is reported as under-granted');

  const escalation = map.compareDriveAccess('viewer', ['write']);
  assert.strictEqual(escalation.overGranted, true, 'Viewer arriving with Edit is an escalation');

  assert.strictEqual(map.compareDriveAccess('editor', ['write']).match, true, 'Editor → Edit matches');
  assert.strictEqual(map.expectedSpLabel('can edit'), 'Edit', 'labels are SharePoint names, not Google ones');
  assert.strictEqual(map.expectedSpLabel('can view'), 'Read');

  // The owner is not re-granted — the destination account owns the migrated copy.
  assert.strictEqual(map.isComparableDriveRole('owner'), false);

  // Scope §5: both axes of a link.
  assert.strictEqual(map.expectedLinkScope('anyone with the link'), 'anonymous');
  assert.strictEqual(map.expectedLinkScope('team members'), 'organization');
  const link = map.compareSharedLink({ type: 'team', role: 'viewer' }, [{ scope: 'organization', type: 'edit' }]);
  assert.strictEqual(link.scopeMatch, true, 'the audience matched');
  assert.strictEqual(link.typeMatch, false, 'but a view link arriving as an edit link is not a pass');
  assert.strictEqual(link.match, false);
  console.log('  role map: ok');
}

async function testEmptyRunNeverPasses() {
  // The guard the whole repo exists for: "the run completed" is never a pass.
  const agent = new ValidationAgent();
  const res = agent._buildResult([], [], { enabled: true, scannedSourceItems: 0, pairedCount: 0 }, {});
  assert.strictEqual(res.overallStatus, 'FAIL', 'a run that paired nothing FAILS');
  const passes = (res.featureChecklist || []).filter((r) => r.status === 'pass');
  assert.strictEqual(passes.length, 0, 'and reports zero pass verdicts');
  assert.ok(res.checks.some((c) => /Migration outcome/.test(c.name) && c.status === 'FAIL'),
    'and says so explicitly rather than leaving an empty report');
  console.log('  an empty run never reports a pass: ok');
}

function testChecklistHonesty() {
  const agent = new ValidationAgent();
  const totals = { scannedSourceItems: 10, migrationType: 'FULL', paperSourceCount: 0 };

  // A WARN must become 'na', never 'pass' — an unexercised feature is not a working feature.
  const warned = agent._buildChecklist(totals, [{ name: '[u] 7.1 Special Character Replacement', status: 'WARN' }]);
  assert.strictEqual(warned.find((r) => r.id === '7.1').status, 'na', 'WARN degrades to na, not pass');

  // A feature with no matching check is 'na' with a reason.
  const missing = warned.find((r) => r.id === '9.1');
  assert.strictEqual(missing.status, 'na');
  assert.match(missing.detail, /Not exercised/);

  // 2.1 can never be assessed from the destination cloud.
  assert.strictEqual(warned.find((r) => r.id === '2.1').status, 'na', 'Folder Display is a web-app property');

  // The eight documented Paper deviations are INFO with the document's own wording — never silently
  // passed and never invented as failures.
  const documented = Object.keys(ValidationAgent.PAPER_DOCUMENTED);
  assert.strictEqual(documented.length, 8, 'eight Paper deviations are recorded');
  for (const id of documented) {
    assert.strictEqual(warned.find((r) => r.id === id).status, 'info', `${id} is reported at INFO`);
  }

  // The `(^|\] )` anchor: unit checks arrive prefixed with "[tag] ".
  const prefixed = agent._buildChecklist(totals, [{ name: '[erik@x.com] 1.1 One time migration (structure)', status: 'PASS' }]);
  assert.strictEqual(prefixed.find((r) => r.id === '1.1').status, 'pass',
    'a prefixed check name still matches its feature');
  console.log('  checklist honesty rules: ok');
}

/* ── Isolation: the four combinations that were already green ─────────────────────────────── */

function testOtherCombinationsUndisturbed() {
  const untouched = [
    ['box', 'sharepoint'],
    ['googledrive', 'sharepoint'],
    ['dropbox', 'googledrive'],
    ['dropbox', 'googleshareddrive'],
  ];
  for (const [src, dst] of untouched) {
    const entry = registry.resolve('content', src, dst);
    assert.ok(entry, `${src} → ${dst} still resolves`);
    assert.ok(entry.ValidationAgent, `${src} → ${dst} still has a validator`);
    assert.notStrictEqual(entry.ValidationAgent, ValidationAgent,
      `${src} → ${dst} must NOT have been captured by the new combination`);
  }

  // The Dropbox pairs still read their own bands and their own role map.
  assert.strictEqual(tolerance.forCombination('dropbox_to_googledrive').combination, 'dropbox_to_googledrive');
  assert.strictEqual(roleMaps.forCombination('dropbox_to_googledrive').pair, 'dropbox_to_google');
  assert.strictEqual(roleMaps.forCombination('dropbox_to_googleshareddrive').pair, 'dropbox_to_google',
    'the Shared Drive pair still resolves to the Google map, not the SharePoint one');

  // The new map serves ONLY this combination.
  assert.strictEqual(roleMaps.forCombination('dropbox_to_sharepoint').pair, 'dropbox_to_sharepoint');
  assert.strictEqual(roleMaps.forCombination('box_to_sharepoint'), null,
    'the new map did not claim Box → SharePoint');
  assert.strictEqual(roleMaps.forCombination('googledrive_to_sharepoint'), null,
    'nor Drive → SharePoint — both still use validation/contentRoleMap.js');

  // SharePoint is still the default destination, so every existing combination's rules are unmoved.
  assert.strictEqual(destinations.DEFAULT, destinations.forDestination('sharepoint'),
    'SharePoint remains the default destination');
  console.log('  the four existing combinations are undisturbed: ok');
}

function testNoSharedFileWasEdited() {
  // The blast-radius rule as an assertion. These files are imported by combinations this change does
  // not own, so a diff here would be a change to somebody else's behaviour.
  //
  // migrationClient.js is the pointed one: for a Dropbox source with a non-Google destination its
  // `isDropboxToGoogleDrive` gate is false, so pickInsideFolder and four =false params are not sent.
  // Widening that gate would alter the payload of EVERY content combination to fix one, so it is
  // deliberately left alone until a network capture of the CloudFuze wizard says what this pair
  // actually needs. Guessing there cost two months on the Shared Drive pair.
  const src = path.join(__dirname, '..', 'src');
  const mustNotMentionUs = [
    ['clients', 'migrationClient.js'],
    ['validation', 'shared', 'deepContentCore.js'],
    ['validation', 'contentRoleMap.js'],
    ['agents', 'cleanup', 'CleanupAgent.js'],
    ['validation', 'combinations', 'content', 'dropboxToGoogledrive.js'],
    ['validation', 'combinations', 'content', 'googledriveToSharepoint.js'],
    ['validation', 'combinations', 'content', 'boxToSharepoint.js'],
  ];
  for (const parts of mustNotMentionUs) {
    const body = fs.readFileSync(path.join(src, ...parts), 'utf8');
    assert.ok(!/dropbox_?[tT]o_?[sS]harepoint/.test(body),
      `${parts.join('/')} must not reference this combination — it is shared with combinations this change does not own`);
  }

  // CONTENT_PROVIDERS already carried both keys, so nothing had to be added for this pair.
  assert.ok(orchestrator.CONTENT_PROVIDERS.includes('dropbox'));
  assert.ok(orchestrator.CONTENT_PROVIDERS.includes('sharepoint'));
  console.log('  no shared file was edited: ok');
}

function testSeedRootHonoursTheWizardField() {
  // The wizard's "Source folder base name" now reaches the Dropbox seeder, so two Dropbox
  // combinations can seed separate roots. That matters because seeding WIPES its root: sharing one
  // means a dropbox → sharepoint run destroys the tree dropbox → googleshareddrive depends on.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'agents', 'dropbox', 'DropboxTestDataAgent.js'), 'utf8');

  const chain = /dbxPath\(\s*context\.sourcePath\s*\|\|\s*context\.sourceFolderName\s*\|\|\s*env\.DROPBOX_TEST_ROOT\s*\)/;
  const hits = src.match(new RegExp(chain, 'g')) || [];
  assert.strictEqual(hits.length, 2,
    'both execute() and applyDeltaChanges() resolve the root the same way — a delta that seeded '
    + 'somewhere else than the one-time run would compare two different trees');

  // Precedence is the whole safety argument: a BLANK field must leave every existing run untouched.
  const dropboxClient = require('../src/clients/dropboxClient');
  const env = require('../src/config/env');
  const resolveRoot = (ctx) =>
    dropboxClient.dbxPath(ctx.sourcePath || ctx.sourceFolderName || env.DROPBOX_TEST_ROOT);

  assert.strictEqual(resolveRoot({}), '/QA-Automation',
    'a blank field still seeds at DROPBOX_TEST_ROOT — the Google pairs are unchanged');
  assert.strictEqual(resolveRoot({ sourceFolderName: '' }), '/QA-Automation',
    'an empty string is blank too');
  assert.strictEqual(resolveRoot({ sourceFolderName: 'QA-dropbox-sharepoint' }), '/QA-dropbox-sharepoint',
    'a named folder is honoured, and gains its leading slash');
  assert.strictEqual(resolveRoot({ sourcePath: '/explicit', sourceFolderName: 'ignored' }), '/explicit',
    'an explicit sourcePath still wins over the name');
  console.log('  seed root honours the wizard field, blank unchanged: ok');
}

function testUseExistingRefusesWhenNothingResolved() {
  // Without this, a mistyped folder name leaves userFolderMappings empty and migrationClient falls
  // back to '/' — the whole Dropbox account — while the run looks completely normal.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'orchestrator', 'AgentOrchestrator.js'), 'utf8');
  const branch = src.slice(src.indexOf("useExistingProvider === 'dropbox'"));
  const body = branch.slice(0, branch.indexOf('useExistingIsDrive'));
  assert.match(body, /userFolderMappings\.length === 0/,
    'the Dropbox use-existing branch checks for zero resolved folders');
  assert.match(body, /refusing to run/i,
    'and refuses, the way the Drive branch already does, rather than migrating the account root');
  console.log('  use-existing refuses rather than migrating the account root: ok');
}

function testGroupGranteeFallsBackToThePluralList() {
  // Measured on run 8510f385: .env sets DROPBOX_TEST_GROUPS (plural) and not the singular, so
  // `grantees.group` resolved to '' and _seedPermissionLadder seeded NO group grant at any of the
  // four positions — root folder, root file, sub-folder, inner file — while _seedPermissionMatrix
  // (which reads `groupNames`) seeded them fine. Features 2.1–2.4 lost their group dimension at
  // every position, reported only as "No DROPBOX_TEST_GROUP … will be SKIPPED".
  //
  // env.js already resolves the plural FROM the singular; this pins the reverse.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'agents', 'dropbox', 'DropboxTestDataAgent.js'), 'utf8');
  assert.match(src, /const group = env\.DROPBOX_TEST_GROUP \|\| env\.DROPBOX_TEST_GROUPS\[0\] \|\| ''/,
    'the singular group grantee falls back to the plural list, as `internal` already does');

  const env = require('../src/config/env');
  const resolveGroup = (e) => e.DROPBOX_TEST_GROUP || e.DROPBOX_TEST_GROUPS[0] || '';
  assert.strictEqual(resolveGroup({ DROPBOX_TEST_GROUP: 'Only', DROPBOX_TEST_GROUPS: [] }), 'Only',
    'the singular still wins when set');
  assert.strictEqual(resolveGroup({ DROPBOX_TEST_GROUP: '', DROPBOX_TEST_GROUPS: ['A', 'B'] }), 'A',
    'a plural-only .env now yields a ladder group instead of silently seeding none');
  assert.strictEqual(resolveGroup({ DROPBOX_TEST_GROUP: '', DROPBOX_TEST_GROUPS: [] }), '',
    'neither set still resolves empty, so the warning still fires when it should');

  // And against the real environment this repo runs with.
  assert.ok(resolveGroup(env), 'this checkout resolves a ladder group from its .env');
  console.log('  group grantee falls back to the plural list: ok');
}

function testWiredIntoTheTestChain() {
  // A test file absent from the && chain never runs and does not count as delivered.
  const pkg = require('../package.json');
  assert.ok(pkg.scripts.test.includes('dropboxToSharepoint.test.js'),
    'this file is wired into the && chain in package.json');
  console.log('  wired into the test chain: ok');
}

(async () => {
  testRegistration();
  testFeatureListMatchesTheDocument();
  testScopeDocumentsExist();
  testSharePointRulesNotGoogleRules();
  testRoleMap();
  await testEmptyRunNeverPasses();
  testChecklistHonesty();
  testOtherCombinationsUndisturbed();
  testNoSharedFileWasEdited();
  testSeedRootHonoursTheWizardField();
  testUseExistingRefusesWhenNothingResolved();
  testGroupGranteeFallsBackToThePluralList();
  testWiredIntoTheTestChain();
  console.log('dropboxToSharepoint.test.js: ok');
})().catch((err) => { console.error(err); process.exit(1); });
