/**
 * Run: npm test  (from backend/)
 *
 * My Drive → My Drive: role translation, native-type classification and registration, asserted
 * against the combination's own documents — `data/feature-scope/my-drive-to-my-drive-inscope.md`
 * (17 features), `-outscope.md` (7 limitations) and `-testdata.md` (the 14 Xray cases).
 *
 * Every expectation traces to a line in one of those files rather than to a guess, for the reason the
 * scope documents themselves record: on a sibling combination two guessed rules produced a false
 * failure on 92 ordinary emails and a pass printed directly above a FAIL for the same thing.
 *
 * The two cases this file exists for, because a validator inherited from a cross-platform pair gets
 * both wrong:
 *   - Commenter vs Viewer must not compare equal (3 of the 9 QA cases grant commenter).
 *   - Google Vids must be classified as a documented conflict (it is absent from the shared table).
 */
const assert = require('assert');
const roleMaps = require('../src/validation/roleMaps');
const agentRegistry = require('../src/orchestrator/agentRegistry');
const tolerance = require('../src/utils/contentTolerance');
const combo = require('../src/validation/combinations/content/googledriveToGoogledrive');

const map = roleMaps.forCombination('googledrive_to_googledrive');

function testRegistration() {
  assert.ok(map, 'the Google → Google pair is registered by directory scan');
  assert.strictEqual(map.pair, 'google_to_google');

  // Shared Drive is a DIFFERENT scope document and is deliberately not claimed by this map.
  assert.strictEqual(roleMaps.forCombination('googledrive_to_googleshareddrive'), null,
    'Shared Drive is not claimed — its ownership model and membership roles are another document');

  // No fallback: an uncovered combination resolves to null, never to a default.
  assert.strictEqual(roleMaps.forCombination('box_to_sharepoint'), null);

  assert.ok(tolerance.forCombination('googledrive_to_googledrive'),
    'tolerance bands are registered for the pair');

  const handlers = agentRegistry.resolve('content', 'googledrive', 'googledrive');
  assert.ok(handlers, 'the combination resolves in the agent registry');
  assert.ok(handlers.ValidationAgent, 'a ValidationAgent is registered');
  // Registered, like googledrive → sharepoint: same source provider, same seeder. It was absent at
  // first so a run could not "pass" features it never seeded — but the checklist reports those as
  // NOT ASSESSED, never pass, so the guard was never needed. Absent, it also meant an unticked
  // "Use existing source folder" left the run with no source at all.
  assert.ok(handlers.TestDataAgent,
    'a TestDataAgent seeds the source, so a run works without "Use existing source folder"');
  assert.strictEqual(handlers.TestDataAgent, require('../src/agents/drive/DriveTestDataAgent'),
    'and it is the same Drive seeder the googledrive → sharepoint pair already uses');
  assert.strictEqual(handlers.ValidationAgent.supportsDeepValidation, true,
    'deep validation is on, so the orchestrator stops skipping validation for this pair');
  console.log('  registration, no fallback, Drive seeder wired in: ok');
}

/** Scope §2: roles are preserved exactly. Same platform both sides. */
function testIdentityRoles() {
  for (const [src, expected] of [['writer', 'Editor'], ['editor', 'Editor'],
    ['reader', 'Viewer'], ['viewer', 'Viewer'], ['commenter', 'Commenter']]) {
    assert.strictEqual(map.expectedGoogleLabel(src), expected,
      `${src} is expected to arrive as ${expected}`);
  }

  assert.ok(map.compareDriveAccess('writer', ['writer']).match, 'Editor → Editor matches');
  assert.ok(map.compareDriveAccess('reader', ['reader']).match, 'Viewer → Viewer matches');
  // The API and the UI spell the same grant two ways; they must compare equal.
  assert.ok(map.compareDriveAccess('editor', ['writer']).match,
    'editor and writer are the same grant, spelled differently by the UI and the API');
  console.log('  identity role mapping, UI/API spellings equal: ok');
}

/**
 * The reason this map is not a copy of dropbox_to_google.js.
 *
 * That map folds commenter and reader into one READ level, which is correct for a source with no
 * commenter. Here it would pass a downgrade on a third of the tested surface — TEST-34400, -34401
 * and -34406 all grant commenter.
 */
function testCommenterIsDistinct() {
  const downgrade = map.compareDriveAccess('commenter', ['reader']);
  assert.strictEqual(downgrade.match, false,
    'Commenter arriving as Viewer is NOT a match — a level-only ladder would pass this');
  assert.strictEqual(downgrade.underGranted, true, 'and it is a downgrade');

  const escalation = map.compareDriveAccess('reader', ['commenter']);
  assert.strictEqual(escalation.match, false, 'Viewer arriving as Commenter is not a match either');
  assert.strictEqual(escalation.overGranted, true,
    'it is an escalation — "they can do more than before" is a finding, not a pass');

  assert.ok(map.compareDriveAccess('commenter', ['commenter']).match, 'Commenter → Commenter matches');

  // Held at INFO while the scope document stays silent on the role. See testdata question 1.
  assert.strictEqual(map.COMMENTER_IS_INFERRED, true,
    'the commenter mapping is inferred from the platform, not stated in the scope document');
  assert.ok(map.compareDriveAccess('commenter', ['reader']).commenterInferred,
    'a commenter verdict is flagged so the validator can hold it at INFO rather than failing it');
  assert.ok(!map.compareDriveAccess('writer', ['reader']).commenterInferred,
    'an ordinary Editor → Viewer downgrade is NOT excused by the commenter caveat');
  console.log('  commenter distinct from viewer, flagged as inferred: ok');
}

/** Scope §2: the destination account owns the copy, so the source owner is not re-granted. */
function testOwnerNotComparable() {
  assert.ok(!map.isComparableDriveRole('owner'), 'owner is not comparable as a grant');
  assert.match(map.nonComparableReason('owner'), /owns the destination copy/);
  assert.ok(map.isComparableDriveRole('writer'), 'ordinary roles are comparable');
  console.log('  owner excluded from grant comparison: ok');
}

/**
 * Scope §3.2: matched on SCOPE, never on the organisation's display name.
 *
 * The prose says a `Sync Orbit` link migrates as `Sync Orbit`; its own figure 3.2.1 shows the
 * destination reading `cloudfuze.com`. Keying on the literal word would pass only in the tenant the
 * screenshots came from.
 */
function testLinkScopes() {
  assert.strictEqual(map.expectedLinkScope('anyone'), 'anyone');
  assert.strictEqual(map.expectedLinkScope('domain'), 'domain');
  assert.strictEqual(map.expectedLinkScope('Sync Orbit'), 'domain',
    'the source tenant org name resolves to the domain SCOPE, not to a literal string');

  const v = map.compareSharedLink({ type: 'domain', role: 'writer' },
    [{ scope: 'domain', type: 'writer', domain: 'cloudfuze.com' }]);
  assert.ok(v.match, 'a domain link matches on scope even though the org name differs across tenants');
  assert.ok(v.domainNameDiffers, 'and the report is told the names legitimately differ');

  // Three link types, not two — same reason as the commenter grant.
  assert.strictEqual(map.expectedLinkType('commenter'), 'comment');
  assert.strictEqual(map.expectedLinkType('writer'), 'edit');
  assert.strictEqual(map.expectedLinkType('reader'), 'view');
  const wrong = map.compareSharedLink({ type: 'anyone', role: 'reader' },
    [{ scope: 'anyone', type: 'writer' }]);
  assert.strictEqual(wrong.match, false, 'a viewing link that arrived as an editing link is not a match');
  console.log('  link scope matched on audience not org name, comment link distinct: ok');
}

/**
 * Out-of-scope 3.1–7.1: five native types go into conflict and are non-migratable.
 *
 * Google Vids is the one that matters: deepContentCore's shared table was written for a Microsoft
 * destination and predates Vids, so without this classification every seeded Vid is reported MISSING.
 */
function testConflictTypes() {
  const core = require('../src/validation/shared/deepContentCore');
  const VID = 'application/vnd.google-apps.vid';

  assert.strictEqual(core.isUnmigratableNative(VID), false,
    'the shared table does NOT know Google Vids — this is the gap this combination fills');
  assert.ok(combo.isConflictType(VID), 'the combination classifies Vids as a documented conflict');

  for (const t of ['form', 'map', 'script', 'site']) {
    assert.ok(combo.isConflictType(`application/vnd.google-apps.${t}`), `${t} is a documented conflict`);
  }
  // Reasons cite THIS document, not the shared table's "no Microsoft 365 equivalent".
  assert.match(combo.NATIVE_CONFLICT_TYPES[VID], /out-of-scope 3\.1/);
  assert.ok(!/Microsoft/.test(combo.NATIVE_CONFLICT_TYPES[VID]),
    'the reason does not mention Microsoft — the destination is Google');
  console.log('  five conflict types classified, Vids gap closed: ok');
}

/**
 * Out-of-scope 2.1: a Drawing ARRIVES (as an empty Doc), so it stays in the comparable set.
 *
 * The shared table says the opposite — that a Drawing is unmigratable and expected absent. Left
 * alone, a correctly-migrated Drawing is counted as an unexpected EXTRA at the destination.
 */
function testDrawingStaysComparable() {
  const DRAWING = 'application/vnd.google-apps.drawing';
  const core = require('../src/validation/shared/deepContentCore');
  assert.strictEqual(core.isUnmigratableNative(DRAWING), true,
    'the shared table marks a Drawing expected-absent');
  assert.strictEqual(combo.isConflictType(DRAWING), false,
    'this combination does not — out-of-scope 2.1 says it arrives as an empty Doc');

  const { comparable, conflicts, drawings } = combo.partitionSource([
    { path: '/a.pdf', name: 'a.pdf', type: 'file', mimeType: 'application/pdf' },
    { path: '/d', name: 'd', type: 'file', mimeType: DRAWING },
    { path: '/v', name: 'v', type: 'file', mimeType: 'application/vnd.google-apps.vid' },
    { path: '/f', name: 'f', type: 'file', mimeType: 'application/vnd.google-apps.form' },
  ]);

  assert.strictEqual(conflicts.length, 2, 'the Vid and the Form are excluded as documented conflicts');
  assert.strictEqual(drawings.length, 1, 'the Drawing is tracked for the 2.1 check');
  assert.strictEqual(comparable.length, 2, 'the PDF and the Drawing remain comparable');
  assert.ok(comparable.some((i) => i.mimeType === DRAWING),
    'a Drawing that fails to arrive is still reported missing');
  console.log('  drawing kept comparable, conflicts partitioned out: ok');
}

/** The checklist must carry the document's own 17 ids, plus the 7 out-of-scope rows. */
function testFeatureLists() {
  assert.strictEqual(combo.DRIVE_FEATURES.length, 17,
    'the in-scope document states 17 features');
  assert.strictEqual(combo.OUT_OF_SCOPE_FEATURES.length, 7,
    'the out-of-scope document states 7');

  const ids = combo.DRIVE_FEATURES.map((f) => f.id);
  for (const id of ['1.1', '1.2', '1.3', '2.1', '2.5', '3.1', '3.2', '4.1', '5.1', '6.1', '7.1',
    '8.1', '9.1', '9.2']) {
    assert.ok(ids.includes(id), `feature ${id} is in the checklist under the document's own numbering`);
  }
  // The two out-of-scope features that are NOT about absence.
  const present = combo.OUT_OF_SCOPE_FEATURES.filter((f) => !f.expectAbsent).map((f) => f.id);
  assert.deepStrictEqual(present.sort(), ['out-1.1', 'out-2.1'],
    'in-line comments and Drawings concern an item that DOES arrive; the other five concern absence');
  console.log('  17 in-scope + 7 out-of-scope rows, document numbering: ok');
}

/** Scope 9.2 makes the expected destination version count a JOB SETTING, not a property of the data. */
function testVersionJobSettings() {
  assert.strictEqual(combo.selectiveVersionCount({ contentOptions: { selectiveVersions: 5 } }), 5);
  assert.strictEqual(combo.selectiveVersionCount({ contentOptions: {} }), null);
  assert.strictEqual(combo.allVersionsRequested({ contentOptions: { allVersions: true } }), true);
  assert.strictEqual(combo.allVersionsRequested({ contentOptions: { selectiveVersions: 5 } }), false,
    'a selective count means NOT all versions — 9.2, not 9.1');

  // `versionHistory` is the key the Run Agent wizard sends. Reading only `versions`/`allVersions`
  // meant ticking "Version History" in the UI left 9.1 and 9.2 reporting "no version migration
  // requested" on a job where the operator had requested it.
  assert.strictEqual(combo.allVersionsRequested({ contentOptions: { versionHistory: true } }), true,
    "the wizard's Version History toggle actually enables version validation");
  assert.strictEqual(
    combo.allVersionsRequested({ contentOptions: { versionHistory: true, selectiveVersions: 3 } }),
    false, 'an explicit selective count still wins over the blanket toggle');
  assert.strictEqual(combo.allVersionsRequested({ contentOptions: { versionHistory: false } }), false,
    'and an unticked toggle still means no version migration');
  console.log('  version expectations read from the job settings: ok');
}

/** A Drive "link" is a permission, not an object — it must not leak into the principal comparison. */
function testPermissionSplit() {
  const perms = [
    { type: 'user', emailAddress: 'Alex@filefuze.co', role: 'reader' },
    { type: 'group', emailAddress: 'g@filefuze.co', role: 'writer' },
    { type: 'anyone', role: 'reader' },
    { type: 'domain', role: 'writer', domain: 'cloudfuze.com' },
  ];
  const principals = combo.principalPermissions(perms);
  const links = combo.linkPermissions(perms);

  assert.strictEqual(principals.length, 2, 'only user and group grants are principals');
  assert.strictEqual(principals[0].email, 'alex@filefuze.co', 'addresses are normalised for comparison');
  assert.strictEqual(links.length, 2, 'anyone and domain are LINKS, not grants to an unknown principal');
  assert.deepStrictEqual(links.map((l) => l.scope).sort(), ['anyone', 'domain']);
  console.log('  link permissions separated from principal grants: ok');
}

/**
 * The link shape this combination BUILDS must be the shape the role map READS.
 *
 * `linkPermissions()` emits { scope: audience, type: role }; the role map used to read
 * `sourceLink.type` as the audience, which is the RAW driveClient key, not this one. Feeding a role
 * to the audience table produced expectedScope = null, so no destination link could match and run
 * d9607a1c reported 3.1 as "0/96 matched … expected null/view" with every link present and correct.
 *
 * Asserted end to end — client rows through linkPermissions into compareSharedLink — because the
 * defect lived in the JOIN between the two, and either half read alone looks right.
 */
function testLinkShapeRoundTrip() {
  const srcRows = [
    { type: 'anyone', role: 'reader' },
    { type: 'domain', role: 'commenter', domain: 'filefuze.co' },
  ];
  const [anyoneLink, domainLink] = combo.linkPermissions(srcRows);
  const destLinks = combo.linkPermissions([
    { type: 'anyone', role: 'reader' },
    { type: 'domain', role: 'commenter', domain: 'cloudfuze.com' },
  ]);

  const anyoneV = map.compareSharedLink(anyoneLink, destLinks);
  assert.strictEqual(anyoneV.expectedScope, 'anyone', 'the AUDIENCE is read from `scope`, not the role');
  assert.strictEqual(anyoneV.match, true, 'an anyone/reader link that arrived intact is a match (3.1)');

  const domainV = map.compareSharedLink(domainLink, destLinks);
  assert.strictEqual(domainV.expectedScope, 'domain');
  assert.strictEqual(domainV.expectedType, 'comment', 'a comment link is its own outcome, not a view link');
  assert.strictEqual(domainV.match, true, 'matched on scope, not on the organisation name (3.2)');

  // The raw client shape still works, so a caller that skips linkPermissions is not broken.
  assert.strictEqual(map.compareSharedLink({ type: 'anyone', role: 'reader' }, destLinks).match, true,
    'the raw { type: audience, role } row is still understood');

  // And the check can still fail.
  assert.strictEqual(map.compareSharedLink(combo.linkPermissions([{ type: 'anyone', role: 'writer' }])[0],
    destLinks).match, false, 'an edit link that arrived read-only is still a failure');
  assert.strictEqual(map.compareSharedLink(domainLink, combo.linkPermissions([{ type: 'anyone', role: 'reader' }])).match,
    false, 'a domain link that is gone at the destination is still a failure');
  console.log('  shared links compared on the shape this combination builds: ok');
}

/**
 * The commenter INFERENCE excuses a ROLE, never a missing grant.
 *
 * `COMMENTER_IS_INFERRED` exists because the scope document never states commenter → commenter, so
 * a commenter arriving as Viewer is held at INFO. A commenter arriving as NOTHING is a lost grant
 * and has no bearing on that open question — run d9607a1c reported the missing group grant on
 * /root_folder_commenter as "NOT FAILED: the commenter mapping is inferred" while the reader and
 * writer grants lost the very same way were failed.
 */
function testCommenterInferenceNeedsAGrant() {
  assert.strictEqual(map.compareDriveAccess('commenter', ['reader']).commenterInferred, true,
    'commenter → Viewer is the open question, held at INFO');
  const lost = map.compareDriveAccess('commenter', []);
  assert.strictEqual(lost.match, false);
  assert.strictEqual(lost.commenterInferred, false,
    'a commenter grant that did not arrive at all is a lost grant, not an undocumented mapping');
  assert.strictEqual(map.compareDriveAccess('commenter', ['commenter']).match, true,
    'and commenter → commenter is still a plain match');
  console.log('  commenter inference cannot excuse a missing grant: ok');
}

/**
 * core.compareTrees() returns `matched` (Map: source path → { source, dest }) and `matchedCount`.
 * It has never returned `paired`.
 *
 * This file read `cmp.paired` in five places, so every one evaluated to undefined: pairedCount was
 * pinned at 0 however much migrated, and each Tier C check skipped itself as "no paired item". Run
 * 0700d557 paired 89 of 90 items and still reported "MIGRATION MOVED NOTHING — 0 of 90 source
 * item(s) reached the destination", with permissions, shared links, timestamps and versions all
 * reported as not exercised against a migration that had moved everything.
 *
 * Asserted on the source because reaching the comparison needs two live Drive accounts and a
 * completed CloudFuze job. The defect was a property of the code, not of the data: a key that the
 * shared helper does not return can be spotted without either.
 */
function testPairsReadFromMatched() {
  const fs = require('fs');
  const path = require('path');
  const comboSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'validation', 'combinations', 'content', 'googledriveToGoogledrive.js'), 'utf8');
  const coreSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'validation', 'shared', 'deepContentCore.js'), 'utf8');

  // The premise: the shared helper really does not expose `paired`.
  const ret = coreSrc.slice(coreSrc.lastIndexOf('  return {', coreSrc.indexOf('placeholderArtifacts,')));
  assert.ok(/matchedCount,/.test(ret), 'compareTrees returns matchedCount');
  assert.ok(!/^\s*paired[,:]/m.test(ret), 'compareTrees does NOT return a `paired` key');

  // So nothing here may read one. Comments may still mention it; code may not.
  const code = comboSrc.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/cmp\.paired/.test(code),
    'no executable line reads cmp.paired — it is always undefined and silently zeroes every count');

  assert.ok(/totals\.pairedCount \+= cmp\.matchedCount/.test(code),
    'the paired total comes from matchedCount, as every other combination in this folder does');
  assert.ok(/cmp\.matched\?\.values\(\)/.test(code),
    'per-item work iterates cmp.matched.values(), which yields the { source, dest } pairs');
  console.log('  paired items read from cmp.matched, not the non-existent cmp.paired: ok');
}

/**
 * Report rows must use the shape every consumer reads: { id, category, feature }.
 *
 * This file used { id, name }. pdfGenerator's drawContentFeatureChecklist reads `row.feature`, so
 * the PDF for run 95ebb59c printed the entire checklist as "1.1 undefined", "2.1 undefined" … for
 * all 24 rows, and lost the category headers with it. The shared builder
 * (validation/shared/contentFunctionalityChecklist.js) and all three sibling combinations already
 * emit { id, category, feature }.
 */
function testChecklistRowShape() {
  for (const [label, list] of [['in-scope', combo.DRIVE_FEATURES], ['out-of-scope', combo.OUT_OF_SCOPE_FEATURES]]) {
    for (const f of list) {
      assert.ok(f.feature, `${label} ${f.id} carries a "feature" label — the PDF renders row.feature`);
      assert.ok(f.category, `${label} ${f.id} carries a category, which groups the PDF checklist`);
      assert.strictEqual(f.name, undefined,
        `${label} ${f.id} must not use the old "name" key — nothing reads it`);
    }
  }

  const fs = require('fs');
  const path = require('path');
  const pdfSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'utils', 'pdfGenerator.js'), 'utf8');
  assert.ok(/row\.id\}\s*\$\{row\.feature/.test(pdfSrc),
    'the PDF still renders id + feature, so this shape is the one it needs');
  console.log('  checklist rows carry { id, category, feature } for the PDF: ok');
}

/**
 * A My Drive run must not be pointed at a Shared Drive by an env var meant for a different provider.
 *
 * DriveTestDataAgent read `env.GOOGLE_SHARED_DRIVE_NAME` whatever the source provider. With that set
 * to QA_Team1, run b78eb168 (googledrive -> googledrive, "Use existing source folder" unticked) died
 * in Step 1 with "Shared Drive QA_Team1 is not visible to mia@cloudfuze.com" -- for a run that had
 * nothing to do with QA_Team1. The refusal itself is correct and must stay: what was wrong is
 * consulting the variable at all for a My Drive source.
 *
 * Same rule migrationClient already applies to the drive id: the PROVIDER decides the shape of the
 * run, the drive name only decides which drive within that shape.
 */
function testSharedDriveEnvIsProviderGated() {
  const fs = require('fs');
  const path = require('path');
  const agentSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'agents', 'drive', 'DriveTestDataAgent.js'), 'utf8');

  assert.ok(/providerUsesSharedDrive\s*=\s*\/shareddrive\/i\.test/.test(agentSrc),
    'the seeder derives whether this provider uses a Shared Drive at all');
  assert.ok(/providerUsesSharedDrive \? env\.GOOGLE_SHARED_DRIVE_NAME : ''/.test(agentSrc),
    'and the env fallback is reachable ONLY for a shared-drive provider');
  assert.ok(/context\.sourceSharedDriveName \|\|/.test(agentSrc),
    'while an explicitly named drive still wins for any provider');

  // The refusal that surfaced the bug must not have been softened into a warning.
  assert.ok(/Refusing to fall back to My Drive/.test(agentSrc),
    'a named-but-unresolvable Shared Drive still stops the run rather than seeding the wrong place');
  console.log('  GOOGLE_SHARED_DRIVE_NAME is only consulted for a shared-drive source: ok');
}

/**
 * A seeded Drive tree must be listable before the run migrates it.
 *
 * Drive's files.list is eventually consistent for new items. On run 14f78fa0, 90 seeded items that
 * finished at 11:29:55 read as 7 at 11:33:16 and 90 at 11:38:43, stable thereafter -- and CloudFuze
 * scanned 76, so the JOB was handed a partial tree too. The run then reported "MIGRATION MOVED
 * NOTHING" about a migration that was never given the whole source.
 */
function testSeededTreeSettles() {
  const fs = require('fs');
  const path = require('path');
  const agentSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'agents', 'drive', 'DriveTestDataAgent.js'), 'utf8');
  const envSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'env.js'), 'utf8');

  // It has to run BEFORE the agent returns, or the orchestrator starts the migration regardless.
  const settleIdx = agentSrc.indexOf('await this._settleSeededTree(');
  const returnIdx = agentSrc.indexOf("logger.info('[DriveTestDataAgent] All inscope scenarios completed')");
  assert.ok(settleIdx > -1, 'the seeder waits for its tree to settle');
  assert.ok(settleIdx < returnIdx, 'and it waits before reporting the seed complete');

  // Stability, not a fixed sleep -- a settled tree must cost one extra list and return.
  const body = agentSrc.slice(agentSrc.indexOf('async _settleSeededTree('));
  assert.ok(/current === previous/.test(body),
    'it returns when two consecutive reads agree, rather than sleeping a fixed time');
  assert.ok(/catch \(err\)/.test(body),
    'a settle that cannot be measured never fails a seed that already succeeded');

  assert.ok(/DRIVE_SEED_SETTLE_ATTEMPTS/.test(envSrc) && /DRIVE_SEED_SETTLE_MS/.test(envSrc),
    'the budget is configurable, like the permission settle window it mirrors');
  console.log('  seeded Drive tree is settled before the migration reads it: ok');
}

/**
 * driveClient.listPermissions() returns { grants, links }, NOT a flat array.
 *
 * testPermissionSplit above feeds a raw array — the shape a bare permissions.list() page has, and
 * NOT the shape production passes. The helpers guarded with `Array.isArray(perms) ? perms : []`, so
 * the real object fell through to [] on every call: permChecked and linkChecked were pinned at 0
 * for the life of the combination, and features 2.1–2.5 and 3.1/3.2 reported "nothing was proven"
 * against a source tree with every grant and link seeded.
 */
function testPermissionsReadTheClientShape() {
  const live = {
    grants: [
      { email: 'alex@filefuze.co', role: 'reader', type: 'user', inherited: false },
      { email: 'g@cloudfuze.com', role: 'writer', type: 'group', inherited: true },
    ],
    links: [
      { type: 'anyone', role: 'reader', domain: null },
      { type: 'domain', role: 'writer', domain: 'cloudfuze.com' },
    ],
  };

  const principals = combo.principalPermissions(live);
  const links = combo.linkPermissions(live);
  assert.strictEqual(principals.length, 2, 'grants are read from the { grants } bucket');
  assert.strictEqual(principals[0].email, 'alex@filefuze.co');
  assert.strictEqual(principals[1].inherited, true,
    'inheritance already resolved by driveClient survives — not re-derived from permissionDetails');
  assert.deepStrictEqual(links.map((l) => l.scope).sort(), ['anyone', 'domain'],
    'links are read from the { links } bucket');

  // A link must never be counted as a principal, nor the reverse, in either shape.
  assert.strictEqual(combo.linkPermissions({ grants: live.grants, links: [] }).length, 0);
  assert.strictEqual(combo.principalPermissions({ grants: [], links: live.links }).length, 0);
  console.log('  permissions read from the { grants, links } shape the client returns: ok');
}

/**
 * Each of 2.1–2.5 stands on the grants that are evidence for IT.
 *
 * One lumped "Permissions (2.1–2.5)" verdict mapped onto five features would claim 2.5 External
 * Shares on a run whose grants were all internal — the "never counted as passing" rule the sibling
 * combination states as the whole point of the checklist.
 */
function testPermissionFeatureBuckets() {
  // mia@cloudfuze.com → erik@filefuze.co, the pairing run d9607a1c used.
  const ids = (path, type, email) =>
    combo.permissionFeatureIds({ path, type }, { email }, 'cloudfuze.com', 'filefuze.co');

  assert.deepStrictEqual(ids('/Permission Matrix', 'folder', 'a@cloudfuze.com'), ['2.1']);
  assert.deepStrictEqual(ids('/root_readme.txt', 'file', 'a@cloudfuze.com'), ['2.2']);
  assert.deepStrictEqual(ids('/Permission Matrix/folder_reader', 'folder', 'a@cloudfuze.com'), ['2.3']);
  assert.deepStrictEqual(ids('/Permission Matrix/file_reader.txt', 'file', 'a@cloudfuze.com'), ['2.4']);

  // 2.5 is orthogonal to depth: a third-party grant is evidence for its own bucket AND for 2.5.
  assert.deepStrictEqual(ids('/Permission Matrix/file_reader.txt', 'file', 'waldo@snapbot.io'),
    ['2.4', '2.5'], 'a grant to a principal in neither tenant is an external share');

  // But the DESTINATION tenant is not an outside organization. This pair is cross-tenant by
  // definition, so scoring 2.5 on "not the source domain" made it every grant on the tree: run
  // d9607a1c reported 26 of 26 grants under 2.5 and failed it on the same group grants 2.1 and 2.3
  // had already failed on — one defect counted three times, and no feature of its own.
  assert.deepStrictEqual(ids('/Permission Matrix/file_reader.txt', 'file', 'erik@filefuze.co'),
    ['2.4'], "the destination account's own address is not an external share");
  assert.deepStrictEqual(ids('/root_folder_reader', 'folder', 'qa-group-edit@filefuze.co'),
    ['2.1'], 'nor is a group inside the destination tenant');
  console.log('  each permission feature scored on its own evidence: ok');
}

/**
 * The checklist must find a verdict that a check actually produced.
 *
 * `byFeature` matches the literal `(<id>)` in a check name. Nine features had their verdict pushed
 * under a lumped name — "Permissions (2.1–2.5)", "Shared Links (3.1, 3.2)", "Versions (9.1, 9.2)" —
 * containing none of those substrings, so all nine printed "Not assessed by this run" EVEN WHEN THE
 * CHECK HAD PASSED. This asserts a green run reaches the checklist green.
 */
function testGreenChecksReachTheChecklist() {
  const rows = new combo()._buildChecklist({}, [
    { name: '[mia] Structure (1.1)', status: 'PASS', detail: '90 paired' },
    { name: '[mia] Root Folder Permissions (2.1)', status: 'PASS', detail: '3/3' },
    { name: '[mia] Root File Permissions (2.2)', status: 'PASS', detail: '1/1' },
    { name: '[mia] Sub-folder permissions (2.3)', status: 'PASS', detail: '3/3' },
    { name: '[mia] Inner File Permissions (2.4)', status: 'PASS', detail: '3/3' },
    { name: '[mia] External Shares (2.5)', status: 'WARN', detail: 'no external grant seen' },
    { name: '[mia] Shared Links — Anyone with the Link (3.1)', status: 'PASS', detail: '6/6' },
    { name: '[mia] Shared Links — organisation-restricted (3.2)', status: 'PASS', detail: '6/6' },
    { name: '[mia] Metadata (4.1)', status: 'PASS', detail: '90/90' },
  ]);
  const by = (id) => rows.find((r) => r.id === id);

  for (const id of ['1.1', '2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '4.1']) {
    assert.strictEqual(by(id).status, 'pass', `${id} passed its check and must read pass, not na`);
    assert.notStrictEqual(by(id).detail, 'Not assessed by this run',
      `${id} must carry its real detail, not the boilerplate`);
  }

  // A WARN is "measured but not proven" — na, never a pass — and it keeps its reason.
  assert.strictEqual(by('2.5').status, 'na', 'an unexercised feature is never a green check');
  assert.strictEqual(by('2.5').detail, 'no external grant seen');

  // Versions stay split: an all-versions run must not mark the selective feature.
  const verRows = new combo()._buildChecklist({}, [
    { name: '[mia] Version History (9.1)', status: 'PASS', detail: '3/3 versions' },
  ]);
  assert.strictEqual(verRows.find((r) => r.id === '9.1').status, 'pass');
  assert.strictEqual(verRows.find((r) => r.id === '9.2').status, 'na',
    '9.2 is a different feature and is not claimed by a 9.1 pass');
  console.log('  a check that passed reaches the checklist as a pass: ok');
}

/** 4.1 compares `modifiedAt` — the field toItem() emits — not Drive's raw `modifiedTime`. */
function testTimestampFieldMatchesItemShape() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../src/validation/combinations/content/googledriveToGoogledrive.js'), 'utf8');
  // Comments stripped: the block deliberately NAMES the old field to explain the bug, and the
  // assertion is about what the code reads, not about what the comment says.
  const block = src
    .slice(src.indexOf('// ── Timestamps (4.1)'), src.indexOf('// ── Versions (9.1, 9.2)'))
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  assert.ok(/modifiedAt/.test(block), '4.1 reads modifiedAt');
  assert.ok(!/\.modifiedTime/.test(block),
    'toItem() renames modifiedTime to modifiedAt, so reading modifiedTime is always undefined — it '
    + 'pinned tsChecked at 0 and 4.1 could never be assessed');

  // The item shape the comparison relies on really does carry modifiedAt.
  const clientSrc = fs.readFileSync(path.join(__dirname, '../src/clients/driveClient.js'), 'utf8');
  assert.ok(/modifiedAt: file\.modifiedTime/.test(clientSrc),
    'driveClient.toItem() is the source of the field name this check depends on');
  console.log('  4.1 compares the timestamp field the item shape actually carries: ok');
}

console.log('My Drive → My Drive validation');
testRegistration();
testIdentityRoles();
testCommenterIsDistinct();
testOwnerNotComparable();
testLinkScopes();
testConflictTypes();
testDrawingStaysComparable();
testFeatureLists();
testVersionJobSettings();
testPermissionSplit();
testLinkShapeRoundTrip();
testCommenterInferenceNeedsAGrant();
testPairsReadFromMatched();
testChecklistRowShape();
testSharedDriveEnvIsProviderGated();
testSeededTreeSettles();
testPermissionsReadTheClientShape();
testPermissionFeatureBuckets();
testGreenChecksReachTheChecklist();
testTimestampFieldMatchesItemShape();
console.log('All My Drive → My Drive validation tests passed.');
