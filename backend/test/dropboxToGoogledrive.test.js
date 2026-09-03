/**
 * Run: npm test  (from backend/)
 *
 * Dropbox → Google My Drive: the pieces that can be asserted without a live Dropbox or Google
 * account. Network calls are not exercised here — what IS exercised is every place a wrong constant
 * or a wrong default would produce a confident false verdict, which is the failure mode the scope
 * documents record for this family of combinations.
 */
const assert = require('assert');

const dropboxClient = require('../src/clients/dropboxClient');
const tolerance = require('../src/utils/contentTolerance');
const destinations = require('../src/validation/destinations');
const roleMaps = require('../src/validation/roleMaps');
const registry = require('../src/orchestrator/agentRegistry');
const ValidationAgent = require('../src/validation/combinations/content/dropboxToGoogledrive');
const GoogleDriveValidationAgent = require('../src/agents/googledrive/GoogleDriveValidationAgent');
const DropboxTestDataAgent = require('../src/agents/dropbox/DropboxTestDataAgent');

const COMBINATION = 'dropbox_to_googledrive';

/**
 * Dropbox's root is the empty string, not "/". Getting this wrong yields `path/malformed_path`,
 * whose message names no argument — so it is asserted rather than left to a live run to discover.
 */
function testPathNormalisation() {
  assert.strictEqual(dropboxClient.dbxPath('/'), '', 'root is the empty string, never "/"');
  assert.strictEqual(dropboxClient.dbxPath(''), '');
  assert.strictEqual(dropboxClient.dbxPath(null), '');
  assert.strictEqual(dropboxClient.dbxPath('.'), '');
  assert.strictEqual(dropboxClient.dbxPath('QA/a'), '/QA/a', 'a relative path gains a leading slash');
  assert.strictEqual(dropboxClient.dbxPath('/QA/a/'), '/QA/a', 'a trailing slash is dropped');
  assert.strictEqual(dropboxClient.dbxPath('\\QA\\a'), '/QA/a', 'backslashes normalise');
  console.log('  dropbox path normalisation: ok');
}

/**
 * The Dropbox-API-Arg header must be pure ASCII. A non-Latin filename otherwise returns a 400 that
 * reads like an auth failure.
 */
function testApiArgIsAscii() {
  const out = dropboxClient.apiArg({ path: '/QA/Rapport-Été.pdf', n: '日本語' });
  assert.ok(/^[\x00-\x7F]*$/.test(out), 'the header value is pure ASCII');
  assert.ok(out.includes('\\u00c9'), 'É is escaped, not passed through');
  assert.ok(out.includes('\\u65e5'), 'CJK is escaped too');
  // The path itself must survive intact after unescaping.
  assert.strictEqual(JSON.parse(out).path, '/QA/Rapport-Été.pdf');
  console.log('  Dropbox-API-Arg ASCII escaping: ok');
}

/**
 * The canonical item shape. deepContentCore.compareTrees consumes Dropbox, Drive and SharePoint
 * items interchangeably, so a missing or differently-named field silently breaks the comparison.
 */
function testItemShape() {
  const file = dropboxClient.toItem({
    '.tag': 'file',
    id: 'id:abc',
    name: 'report.pdf',
    path_display: '/QA/report.pdf',
    size: 2048,
    server_modified: '2026-01-02T03:04:05Z',
    client_modified: '1999-01-01T00:00:00Z',
    rev: '0123',
    content_hash: 'deadbeef',
  }, '/QA');

  assert.strictEqual(file.type, 'file');
  assert.strictEqual(file.path, '/QA/report.pdf');
  assert.strictEqual(file.size, 2048);
  // server_modified, NOT client_modified: the client value is supplied by whatever uploaded the file
  // and can be arbitrary, so comparing it would describe the uploader rather than the migration.
  assert.strictEqual(file.modifiedAt, '2026-01-02T03:04:05Z',
    'modifiedAt uses server_modified, never client_modified');
  assert.strictEqual(file.createdAt, null, 'Dropbox exposes no creation time');
  assert.strictEqual(file.mimeType, null, 'Dropbox metadata carries no MIME type');

  const folder = dropboxClient.toItem({ '.tag': 'folder', name: 'Sub', path_display: '/QA/Sub' }, '/QA');
  assert.strictEqual(folder.type, 'folder');
  assert.strictEqual(folder.size, null, 'a folder has no size');

  // Path falls back to parent + name when path_display is absent.
  const noDisplay = dropboxClient.toItem({ '.tag': 'file', name: 'x.txt' }, '/QA');
  assert.strictEqual(noDisplay.path, '/QA/x.txt');
  console.log('  canonical item shape: ok');
}

/**
 * `toItem` decides folder-vs-file solely from the `.tag` discriminator — and `.tag` is present only
 * on the union entries `files/list_folder` returns. `files/create_folder_v2` answers with a BARE
 * FolderMetadata that has no `.tag`, so a newly created folder came back typed as a FILE.
 *
 * That is not cosmetic. Callers branch on `type` to choose sharing/add_folder_member over
 * sharing/add_file_member, so every grant on a freshly created folder went to the file endpoint and
 * failed `access_error/is_folder` — silently losing all folder permissions in a run that otherwise
 * looked healthy. createFolder now supplies the tag; this pins both halves of that behaviour.
 */
function testFolderTagRequired() {
  const tagged = dropboxClient.toItem(
    { '.tag': 'folder', id: 'id:f', name: 'Sub', path_display: '/QA/Sub' }, '/QA'
  );
  assert.strictEqual(tagged.type, 'folder', 'a tagged folder is a folder');
  assert.strictEqual(tagged.size, null, 'folders carry no size');

  // The create_folder_v2 shape — same metadata, no discriminator.
  const untagged = dropboxClient.toItem(
    { id: 'id:f', name: 'Sub', path_display: '/QA/Sub' }, '/QA'
  );
  assert.strictEqual(untagged.type, 'file',
    'without .tag toItem cannot know it is a folder — which is why createFolder must supply it');

  console.log('  folder tag drives the folder/file branch: ok');
}

/**
 * CloudFuze resolves a Dropbox path CSV against Dropbox's CANONICAL lower-case path.
 *
 * Measured 2026-09-02: seven jobs sending "/QA-Automation" were rejected with
 * "Migration not Allowed for wrong CSV paths" (CONFLICT, totalFilesAndFolders=0); the same tree
 * sent as "/qa-automation" was accepted. `toItem` must therefore carry `path_lower`, because
 * `path_display` preserves whatever case the folder was created with.
 */
function testPathLowerCarried() {
  const item = dropboxClient.toItem({
    '.tag': 'folder',
    id: 'id:abc',
    name: 'QA-Automation',
    path_display: '/QA-Automation',
    path_lower: '/qa-automation',
  }, '/');
  assert.strictEqual(item.path, '/QA-Automation', 'path keeps the display form for reporting');
  assert.strictEqual(item.pathLower, '/qa-automation', 'pathLower carries the form CloudFuze matches');

  // Dropbox always sends path_lower, but fall back rather than emit undefined — an undefined path
  // would reach the CSV as the string "undefined" and be rejected for a different reason.
  const noLower = dropboxClient.toItem({
    '.tag': 'folder', name: 'Mixed Case', path_display: '/Mixed Case',
  }, '/');
  assert.strictEqual(noLower.pathLower, '/mixed case', 'falls back to lower-casing the path');

  console.log('  path_lower carried for CloudFuze path matching: ok');
}

/**
 * Names Dropbox refuses outright must not be in the seeding list.
 *
 * `desktop.ini` was, and `files/upload` answers `path/disallowed_name` — an unguarded throw that
 * killed the whole seeding run at row 10 of 12, so nothing after it was ever created.
 */
function testDisallowedNamesNotSeeded() {
  const reserved = DropboxTestDataAgent.RESERVED_STYLE_NAMES;
  const disallowed = DropboxTestDataAgent.DROPBOX_DISALLOWED_NAMES;
  assert.ok(Array.isArray(reserved) && reserved.length, 'the reserved-style list is exported');
  assert.ok(Array.isArray(disallowed) && disallowed.length, 'the disallowed list is exported');

  for (const name of disallowed) {
    assert.ok(!reserved.some((r) => r.toLowerCase() === name.toLowerCase()),
      `${name} is refused by Dropbox and must never be seeded`);
  }
  assert.ok(disallowed.some((n) => n.toLowerCase() === 'desktop.ini'),
    'desktop.ini is documented as unseedable rather than silently dropped');

  console.log('  Dropbox-disallowed names excluded from seeding: ok');
}

/** Paper detection gates all 19 of scope §10 — a Paper must never be byte-compared. */
function testPaperDetection() {
  assert.ok(dropboxClient.isPaperEntry({ name: 'notes.paper' }), '.paper is Paper');
  assert.ok(dropboxClient.isPaperEntry({ name: 'notes.papert' }), '.papert is Paper');
  assert.ok(dropboxClient.isPaperEntry({ name: 'x', export_info: { export_as: 'markdown' } }),
    'an exportable file is Paper');
  assert.ok(!dropboxClient.isPaperEntry({ name: 'report.pdf' }), 'a pdf is not Paper');
  assert.ok(!dropboxClient.isPaperEntry({ name: 'paperwork.txt' }),
    '"paper" inside a name is not an extension match');
  assert.strictEqual(dropboxClient.toItem({ '.tag': 'file', name: 'a.paper' }, '/').isPaper, true);
  console.log('  Dropbox Paper detection: ok');
}

/**
 * `too_many_write_operations` arrives as a 409, which the shared retry helper deliberately rejects.
 * A genuine path conflict must NOT be retried, because retrying it could never succeed.
 */
function testRetryClassification() {
  assert.ok(dropboxClient.isRetryable({ status: 429 }), '429 retries');
  assert.ok(dropboxClient.isRetryable({ status: 503 }), '5xx retries');
  assert.ok(
    dropboxClient.isRetryable({ status: 409, dropboxSummary: 'too_many_write_operations/...' }),
    'the 409 write-throttle retries — the case utils/retry.js cannot see'
  );
  assert.ok(!dropboxClient.isRetryable({ status: 409, dropboxSummary: 'path/conflict/folder/..' }),
    'a real conflict does NOT retry');
  assert.ok(!dropboxClient.isRetryable({ status: 401, dropboxSummary: 'invalid_access_token/' }),
    'an auth failure does NOT retry');
  console.log('  Dropbox retry classification: ok');
}

/**
 * The Google destination rules. These three values are the whole reason this combination cannot
 * inherit SharePoint's: each wrong one produces confident false failures, not a quiet gap.
 */
function testGoogleDestinationRules() {
  const g = destinations.forDestination('googledrive');
  assert.ok(g, 'the googledrive destination is registered');
  assert.strictEqual(g.pathLengthLimit, Infinity, 'Google declares no total-path limit');
  assert.strictEqual(g.usesPlaceholderLinksOverPathLimit, false,
    'no placeholder link is ever the expected outcome');
  assert.strictEqual(g.isReservedName('CON'), false, 'Google reserves no names');

  // Characters SharePoint rewrites must survive unchanged on Google — the negative test behind 5.1.
  const nasty = 'a"b*c:d<e>f?g|h';
  assert.strictEqual(g.sanitizeName(nasty), nasty, 'Google rewrites nothing');
  assert.strictEqual(g.needsSanitizing(nasty), false);
  assert.strictEqual(g.needsSanitizing('  padded  '), true, 'only surrounding whitespace changes');

  // And SharePoint must still disagree, or the 5.1 negative test proves nothing.
  const sp = destinations.forDestination('sharepoint');
  assert.ok(sp.needsSanitizing(nasty), 'SharePoint WOULD rewrite these — the contrast 5.1 relies on');

  // A Shared Drive shares the rules via alias.
  assert.strictEqual(destinations.forDestination('googleshareddrive'), g, 'alias resolves to the same rules');
  console.log('  Google destination rules: ok');
}

/** Dropbox has two collaborator levels and no commenter — a destination Commenter is never expected. */
function testRoleMap() {
  const m = roleMaps.forCombination(COMBINATION);
  assert.ok(m, 'a role map covers dropbox_to_googledrive');

  assert.strictEqual(m.compareDriveAccess('editor', ['writer']).match, true, 'Can edit → Editor');
  assert.strictEqual(m.compareDriveAccess('viewer', ['reader']).match, true, 'Can view → Viewer');
  assert.strictEqual(m.expectedGoogleLabel('editor'), 'Editor');
  assert.strictEqual(m.expectedGoogleLabel('viewer'), 'Viewer');

  // A source Viewer arriving as Editor is an escalation, never a pass.
  const esc = m.compareDriveAccess('viewer', ['writer']);
  assert.strictEqual(esc.match, false, 'equal access is required, not merely sufficient');
  assert.strictEqual(esc.overGranted, true, 'the escalation is reported as such');

  // Dropbox has no commenter, so Commenter must not satisfy an Editor grant.
  assert.strictEqual(m.compareDriveAccess('editor', ['commenter']).match, false);
  assert.strictEqual(m.compareDriveAccess('editor', ['commenter']).underGranted, true);

  // Ownership is not re-granted at the destination, so it is not comparable.
  assert.strictEqual(m.isComparableDriveRole('owner'), false);
  assert.ok(/not re-granted/.test(m.nonComparableReason('owner')));

  // Link scope maps on SCOPE, never on the tenant's display name.
  assert.strictEqual(m.expectedLinkScope('anyone with the link'), 'anonymous');
  assert.strictEqual(m.expectedLinkScope('team members'), 'organization');
  assert.strictEqual(m.compareSharedLink({ type: 'team', role: 'viewer' },
    [{ scope: 'organization', type: 'view' }]).match, true);
  // Right audience, wrong access level — must fail, or a viewing link that arrived editable passes.
  assert.strictEqual(m.compareSharedLink({ type: 'team', role: 'viewer' },
    [{ scope: 'organization', type: 'edit' }]).match, false);
  console.log('  dropbox → google role map: ok');
}

/** Tolerance bands, including the three that deliberately differ from the SharePoint combination. */
function testToleranceBands() {
  const b = tolerance.forCombination(COMBINATION);
  assert.ok(b, 'bands auto-load from their own file');
  assert.strictEqual(b.combination, COMBINATION);
  assert.strictEqual(b.countDelta, 0, 'structure is exact');
  assert.strictEqual(b.pathLengthLimit, Infinity, 'Google has no path limit');
  assert.ok(b.segmentLengthLimit > 255, 'a Google name may far exceed 255 chars');
  // The seeding agent builds a 20-level chain for the long-path scenario.
  assert.ok(b.treeDepth > 20, 'tree depth must exceed the 20-level seeded nesting');
  // A Google native destination reports little or no size, so the converted band must reach 0.
  assert.strictEqual(b.convertedFileSize.infoMin, 0,
    'a native Google doc reports near-zero size — the band must allow it');
  assert.ok(b.fileSize.infoMin > 0.95, 'pass-through formats are still held to byte equality');
  console.log('  dropbox → my drive tolerance bands: ok');
}

/** The combination must resolve from the registry, or a run dies at agent resolution. */
function testRegistration() {
  const hit = registry.resolve('content', 'dropbox', 'googledrive');
  assert.ok(hit, 'content:dropbox:googledrive is registered');
  assert.strictEqual(hit.ValidationAgent, ValidationAgent);
  assert.strictEqual(hit.TestDataAgent, DropboxTestDataAgent);
  // Without this the orchestrator skips validation entirely and the run is report-only.
  assert.strictEqual(ValidationAgent.supportsDeepValidation, true,
    'deep validation must be opted into or the orchestrator compares nothing');
  // The validator reads the Google destination through the shared destination-side agent.
  assert.ok(ValidationAgent.prototype instanceof GoogleDriveValidationAgent,
    'the combination extends the Google destination agent');
  console.log('  combination registration: ok');
}

/** All 36 in-scope features are present, in the scope document's own numbering. */
function testFeatureChecklistCoverage() {
  const feats = ValidationAgent.DROPBOX_FEATURES;
  assert.strictEqual(feats.length, 36, 'the scope document lists 36 in-scope features');

  const ids = feats.map((f) => f.id);
  assert.strictEqual(new Set(ids).size, 36, 'no duplicate feature ids');
  // Spot-check the boundaries of every documented section.
  for (const id of ['1.1', '1.3', '2.1', '2.5', '3.1', '3.2', '4.1', '5.1', '6.1', '7.1', '8.1',
    '9.1', '9.2', '10.1', '10.19']) {
    assert.ok(ids.includes(id), `feature ${id} is present`);
  }
  // §10 is 19 features — over half the document.
  assert.strictEqual(ids.filter((i) => i.startsWith('10.')).length, 19,
    'Dropbox Paper contributes 19 features');

  // The six disputed non-migrations carry the document's own wording, and each is a real feature id.
  const disputed = Object.keys(ValidationAgent.PAPER_DISPUTED);
  assert.deepStrictEqual(disputed.sort(), ['10.14', '10.15', '10.17', '10.18', '10.2', '10.6'].sort());
  for (const id of disputed) {
    assert.ok(ids.includes(id), `disputed feature ${id} is a real feature`);
    assert.ok(ValidationAgent.PAPER_DISPUTED[id].length > 20, 'the document wording is carried, not a stub');
  }
  console.log('  36-feature checklist coverage: ok');
}

/**
 * A run that compared nothing must never report a pass.
 *
 * This is the rule the scope documents were written around: a validator that reports SUCCESS while
 * validating nothing is the bug. Asserted through the real result builder.
 */
function testEmptyRunNeverPasses() {
  const agent = new ValidationAgent();
  const res = agent._buildResult(
    [{ name: 'Deep content validation', status: 'WARN', detail: 'disabled' }],
    [],
    { enabled: false, scannedSourceItems: 0 },
    { destinationProvider: 'googledrive' }
  );
  assert.notStrictEqual(res.status, 'PASS', 'a run that compared nothing is not a pass');
  assert.strictEqual(res.featureSummary.pass, 0, 'no feature passes when nothing was validated');
  assert.strictEqual(res.featureSummary.na, 36, 'all 36 features report not-assessed');
  assert.strictEqual(res.combination, COMBINATION);
  assert.strictEqual(res.sourceProvider, 'dropbox');

  // And when the source WAS read but nothing arrived, the summary has to say so first.
  const moved = agent._buildResult(
    [{ name: 'Source items scanned', status: 'PASS', detail: '10 items' }],
    [],
    { enabled: true, scannedSourceItems: 10, pairedCount: 0, paperItems: [], migrationType: 'FULL' },
    { destinationProvider: 'googledrive' }
  );
  assert.ok(/MIGRATION MOVED NOTHING/.test(moved.summary),
    'a zero-paired run leads with the fact that nothing moved');
  assert.strictEqual(moved.featureSummary.pass, 0);
  console.log('  an empty run never reports a pass: ok');
}

/** The seeding agent must refuse to seed at the account root. */
function testSeedingRefusesAccountRoot() {
  const agent = new DropboxTestDataAgent();
  assert.strictEqual(agent.getName(), 'DropboxTestDataAgent',
    'the agent name matches the class, as BaseAgent.toJSON expects');
  // Paper cannot be seeded by API; the agent must return real manual steps rather than claim coverage.
  const paper = agent._reportPaperManualSteps();
  assert.ok(/10\.1/.test(paper.feature) && /10\.19/.test(paper.feature), 'names the feature range');
  assert.ok(paper.manualSteps.length >= 10, 'the manual steps are enumerated, not hand-waved');
  assert.ok(/retired the Paper authoring API/.test(paper.reason), 'says why it cannot be automated');
  console.log('  seeding agent guards + Paper manual steps: ok');
}

testPathNormalisation();
testApiArgIsAscii();
testItemShape();
testFolderTagRequired();
testPathLowerCarried();
testDisallowedNamesNotSeeded();
testPaperDetection();
testRetryClassification();
testGoogleDestinationRules();
testRoleMap();
testToleranceBands();
testRegistration();
testFeatureChecklistCoverage();
testEmptyRunNeverPasses();
testSeedingRefusesAccountRoot();

console.log('dropboxToGoogledrive.test.js: ok');
