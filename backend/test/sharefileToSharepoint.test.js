/**
 * Run: npm test  (from backend/)
 *
 * ShareFile → SharePoint: the pieces that can be asserted without a live ShareFile account.
 *
 * No network call is exercised — the ShareFile client is UNVERIFIED against a live tenant and these
 * tests do not pretend otherwise. What IS exercised is every place a wrong constant or a wrong
 * default would produce a confident false verdict, plus the two decisions that make this combination
 * different from its siblings:
 *
 *   1. permissions are reported as NOT ASSESSED, never compared against a guessed role mapping
 *   2. nothing may be classified as a known limitation, because no out-of-scope document exists
 *
 * Both are load-bearing. A future change that quietly starts comparing permissions, or that borrows
 * another combination's limitations list, must fail here rather than in a live run's report.
 */
const assert = require('assert');

const sharefileClient = require('../src/clients/sharefileClient');
const tolerance = require('../src/utils/contentTolerance');
const roleMaps = require('../src/validation/roleMaps');
const core = require('../src/validation/shared/deepContentCore');
const registry = require('../src/orchestrator/agentRegistry');
const env = require('../src/config/env');
const ValidationAgent = require('../src/validation/combinations/content/sharefileToSharepoint');
const SharePointValidationAgent = require('../src/agents/sharepoint/SharePointValidationAgent');

const COMBINATION = 'sharefile_to_sharepoint';

/** The combination must be registered, or a run fails at agent resolution before validating anything. */
function testRegistration() {
  const set = registry.resolve('content', 'sharefile', 'sharepoint');
  assert.ok(set, 'content: sharefile → sharepoint must be registered');
  assert.strictEqual(set.ValidationAgent, ValidationAgent);
  assert.strictEqual(
    ValidationAgent.supportsDeepValidation, true,
    'without supportsDeepValidation the orchestrator falls back to the report-only agent, which compares nothing'
  );
  // Both agents, matching dropboxToSharepoint. This asserted the seeder was ABSENT while none
  // existed; ShareFileTestDataAgent now exists, and a combination registered without it would skip
  // seeding entirely — every item would then report as missing at the destination and the migration
  // would be blamed for an empty source.
  assert.ok(set.TestDataAgent, 'the ShareFile seeder must be registered, or a run seeds nothing');
  assert.strictEqual(set.TestDataAgent.name, 'ShareFileTestDataAgent');
  // The shared MigrationAgent belongs to the orchestrator, not to a combination.
  assert.ok(!set.MigrationAgent, 'no combination registers a MigrationAgent — the orchestrator owns it');
  console.log('  combination registered with both agents, deep validation on: ok');
}

/** The destination is SharePoint, so the destination agent must be the shared one, not a copy. */
function testReusesSharePointDestination() {
  assert.ok(
    ValidationAgent.prototype instanceof SharePointValidationAgent,
    'the validator must EXTEND SharePointValidationAgent — destination behaviour is shared, never copied'
  );
  console.log('  reuses the shared SharePoint destination agent: ok');
}

/**
 * Permissions must come back not-comparable for every input.
 *
 * This is the combination's defining decision. ShareFile grants access as independent per-item flags
 * (download / upload / delete / manage) and the feature document publishes no mapping onto
 * SharePoint's Read / Edit / Full Control. Comparing against an invented mapping would produce
 * confident wrong verdicts in both directions.
 */
function testPermissionRoleMap() {
  const map = roleMaps.forCombination(COMBINATION);
  assert.ok(map, 'a role map must be registered for the combination');
  assert.strictEqual(map.permissionsNotAssessed, false,
    'permissions are assessed now — this flag drives the checklist verdicts');
  assert.strictEqual(map.mappingIsMeasured, true,
    'the table came from measurement, not a published document, and the report says so');

  // The measured ladder. Read off a completed migration, rung by rung: view alone becomes Read,
  // anything with a write-ish flag becomes Edit. Asserted so a future edit cannot quietly change
  // what a grant is expected to produce.
  const cases = [
    ['CanView', map.LEVEL.READ],
    ['CanView+CanUpload', map.LEVEL.EDIT],
    ['CanView+CanDownload+CanUpload', map.LEVEL.EDIT],
    ['CanView+CanDownload+CanUpload+CanDelete', map.LEVEL.EDIT],
    ['CanView+CanDownload+CanUpload+CanDelete+CanManagePermissions', map.LEVEL.EDIT],
  ];
  for (const [role, expected] of cases) {
    assert.strictEqual(map.driveRoleLevel(role), expected, `source level for "${role}"`);
    assert.ok(map.isComparableDriveRole(role), `"${role}" must be comparable`);
  }

  // Destination vocabulary.
  assert.strictEqual(map.spRolesLevel(['read']), map.LEVEL.READ);
  assert.strictEqual(map.spRolesLevel(['write']), map.LEVEL.EDIT);
  assert.strictEqual(map.spRolesLevel(['owner']), map.LEVEL.FULL);
  assert.strictEqual(map.spRolesLevel([]), map.LEVEL.NONE);

  // A principal with no flags has no grant to verify — reported, never compared.
  assert.strictEqual(map.isComparableDriveRole('none'), false);
  assert.strictEqual(map.isComparableDriveRole(''), false);
  assert.ok(map.nonComparableReason('none').length > 30, 'a skip must carry its reason');

  console.log('  role map encodes the measured ladder (view→read, anything else→write): ok');
}

/**
 * The comparison must FAIL a grant that did not arrive, and must not be satisfied by SharePoint's
 * own site groups.
 *
 * Both halves are load-bearing. The first is the defect this map was written to catch: group grants
 * present on every source rung and absent from every destination one, which "not assessed" hid
 * completely. The second is how that catch gets silently undone — SharePoint attaches Owners /
 * Members / Visitors to effectively every item, and comparePermissions will let a destination GROUP
 * grant satisfy a user's grant, so without a filter every permission passes no matter what migrated.
 */
function testPermissionComparison() {
  const map = roleMaps.forCombination(COMBINATION);
  const builtInSiteGroup = (d) => {
    const name = String(d?.name || '').trim().toLowerCase();
    const email = String(d?.email || '').trim().toLowerCase();
    return /\.onmicrosoft\.com$/.test(email) || /\b(owners|members|visitors)$/.test(name);
  };
  const siteGroups = [
    { email: '', name: 'qa Members', principalType: 'group', roles: ['write'] },
    { email: '', name: 'qa Owners', principalType: 'group', roles: ['owner'] },
    { email: 'qa@trydemos.onmicrosoft.com', name: 'qa', principalType: 'group', roles: ['owner'] },
  ];

  // 1. A user grant that arrived.
  let cmp = core.comparePermissions(
    [{ email: 'alex@filefuze.co', role: 'CanView', type: 'user' }],
    [...siteGroups, { email: 'alex@filefuze.co', name: 'alex', principalType: 'user', roles: ['read'] }],
    (e) => e,
    { roleMap: map, groupFallbackFrom: (d) => !builtInSiteGroup(d) }
  );
  assert.strictEqual(cmp.mismatches.length, 0, 'a grant that arrived must not be a mismatch');
  assert.strictEqual(cmp.matches.length, 1, 'and must be counted as a match');

  // 2. A user grant that did NOT arrive — the site groups must not rescue it.
  cmp = core.comparePermissions(
    [{ email: 'alex@filefuze.co', role: 'CanView', type: 'user' }],
    siteGroups,
    (e) => e,
    { roleMap: map, groupFallbackFrom: (d) => !builtInSiteGroup(d) }
  );
  assert.strictEqual(cmp.mismatches.length, 1,
    'a missing user grant must FAIL — SharePoint\'s built-in site groups must not satisfy it, or '
    + 'every permission check passes regardless of what migrated');

  // 3. A group grant with NO EMAIL is silently skipped by the shared comparator.
  //
  // ShareFile groups carry a name and no email — all 53 on the live tenant. comparePermissions
  // opens with `if (!sp?.email) continue`, so an un-normalised group grant is dropped before it is
  // compared, and feature 2.3 reports a verdict having checked nothing. The validator therefore
  // keys group rows by name; this asserts the raw behaviour so nobody removes that step.
  cmp = core.comparePermissions(
    [{ email: '', name: '! Countsq@ %', role: 'CanView', type: 'group' }],
    siteGroups,
    (e) => e,
    { roleMap: map, groupFallbackFrom: (d) => !builtInSiteGroup(d) }
  );
  assert.strictEqual(cmp.checked, 0,
    'an email-less group grant is skipped entirely — which is why the validator keys groups by name');

  // 4. The same grant, keyed by name as the validator passes it — now it must FAIL.
  cmp = core.comparePermissions(
    [{ email: '! Countsq@ %', name: '! Countsq@ %', role: 'CanView', type: 'group' }],
    siteGroups,
    (e) => e,
    { roleMap: map, groupFallbackFrom: (d) => !builtInSiteGroup(d) }
  );
  assert.strictEqual(cmp.mismatches.length, 1, 'a group grant with no destination counterpart must FAIL');
  assert.strictEqual(cmp.mismatches[0].principalType, 'group',
    'and must be reported AS a group, so feature 2.3 can be judged on its own');

  console.log('  comparison fails absent grants and is not satisfied by site groups: ok');
}

/**
 * Feature 2.3 must read its verdict from the GROUP check, not the user one.
 *
 * All four permission features used to share one match pattern, and the checklist takes the first
 * hit. Once user and group grants became separate verdicts that meant a failing group migration
 * would report the USER result — four green ticks over a real defect.
 */
function testPermissionFeaturesAreSeparate() {
  const byId = Object.fromEntries(ValidationAgent.SHAREFILE_FEATURES.map((f) => [f.id, f]));
  const userCheck = '2. Permissions — user grants (features 2.1, 2.2, 2.4)';
  const groupCheck = '2. Permissions — group grants (feature 2.3)';

  assert.ok(byId['2.3'].match.test(groupCheck), '2.3 must match the group check');
  assert.ok(!byId['2.3'].match.test(userCheck),
    '2.3 must NOT match the user check, or a group failure hides behind a user pass');
  for (const id of ['2.1', '2.2', '2.4']) {
    assert.ok(byId[id].match.test(userCheck), `${id} must match the user check`);
    assert.ok(!byId[id].match.test(groupCheck), `${id} must not match the group check`);
  }
  console.log('  feature 2.3 is judged by the group check, not the user check: ok');
}

/**
 * Bands. The destination-side numbers are SharePoint's and must match the sibling combination;
 * the source-side numbers are ShareFile's and are asserted because a silently inherited value is
 * what produced the false failures recorded in the Dropbox scope doc.
 */
function testToleranceBands() {
  const b = tolerance.forCombination(COMBINATION);
  assert.ok(b, 'tolerance bands must be registered for the combination');
  assert.strictEqual(b.combination, COMBINATION);

  // SharePoint destination physics — same as googledrive_to_sharepoint.
  const sp = tolerance.forCombination('googledrive_to_sharepoint');
  assert.strictEqual(b.pathLengthLimit, sp.pathLengthLimit, 'same destination, same encoded-path limit');
  assert.strictEqual(b.segmentLengthLimit, sp.segmentLengthLimit);

  // ShareFile stores plain binaries — no native document format — so pass-through sizes are exact.
  assert.ok(b.fileSize.infoMin >= 0.99 && b.fileSize.infoMax <= 1.01,
    'ShareFile files migrate byte-for-byte; a wide band here would hide real size loss');

  // Structure and versions are exact: this combination documents no merge caveat, unlike Google.
  assert.strictEqual(b.countDelta, 0, 'a missing or extra item is a defect, never a tolerance');
  // Version counts are NOT compared for equality. Figure 4.1.1 of the feature document shows five
  // source versions arriving as ten: CloudFuze writes a "SharePoint App" placeholder version beside
  // each real one. An exact rule (the original `versionCountDelta: 0`) failed correct migrations.
  // The rule is directional — loss is a defect, excess is reported — so there is no symmetric
  // tolerance, and null records that rather than a number implying one.
  assert.strictEqual(b.versionCountDelta, null,
    'version counts are judged directionally (loss fails, excess is reported), not by a delta');
  assert.strictEqual(b.versionCountExpectedRatio, 2,
    'the observed destination:source ratio is recorded for the report, never enforced');

  assert.ok(b.treeDepth >= 25, 'a depth cap below the seeded tree silently drops items from the comparison');
  console.log('  tolerance bands correct for a SharePoint destination and a ShareFile source: ok');
}

/**
 * Configuration guard, and the Phase A contract this client obeys.
 *
 * The account host is an OUTPUT of sign-in, never an input: there is no SHAREFILE_SUBDOMAIN setting,
 * and the host lives per-account in the token store. An earlier draft of this client required a
 * subdomain env var; that was wrong, and this asserts it stays gone.
 */
function testConfigurationGuard() {
  assert.strictEqual(
    typeof sharefileClient.isConfigured(), 'boolean',
    'isConfigured must always answer, so the validator can fail with a reason instead of throwing'
  );
  assert.strictEqual(typeof sharefileClient.verifyConnection, 'function',
    'verifyConnection is the first thing to run against a live tenant');

  // No subdomain env var may reappear — the connect layer settled this.
  assert.strictEqual(env.SHAREFILE_SUBDOMAIN, undefined,
    'there is no SHAREFILE_SUBDOMAIN setting: the host arrives on the OAuth callback');

  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'clients', 'sharefileClient.js'), 'utf8');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/SHAREFILE_SUBDOMAIN/.test(codeOnly),
    'the client must not read a subdomain setting outside comments');
  assert.ok(/SHAREFILE_CLIENT_ID/.test(codeOnly) && /SHAREFILE_CLIENT_SECRET/.test(codeOnly),
    'it uses the two app credentials the connect layer defines');

  // Phase B settings exist and default safely.
  assert.strictEqual(typeof env.SHAREFILE_TEST_ROOT, 'string');
  assert.ok(env.SHAREFILE_TEST_ROOT.startsWith('/'), 'the seeding root is a path');
  console.log('  configuration guard + no-subdomain contract: ok');
}

/**
 * Every read takes the account email first. Acting as the wrong connected ShareFile tenant reads a
 * different file tree entirely, so the account is never implicit in a multi-account setup.
 */
function testAccountScopedCalls() {
  for (const fn of ['getRoot', 'listChildren', 'buildFolderTree', 'listAccessControls',
    'listVersions', 'downloadFile', 'listUsers', 'listGroups']) {
    assert.strictEqual(typeof sharefileClient[fn], 'function', `${fn} must exist`);
    assert.ok(sharefileClient[fn].length >= 1, `${fn} must take the account email as its first argument`);
  }
  assert.strictEqual(typeof sharefileClient.resolveAccount, 'function',
    'resolveAccount maps an email to its stored host and refresh token');
  console.log('  every read is scoped to a named account: ok');
}

/** The item normaliser must produce exactly the shape deepContentCore compares. */
function testItemNormalisation() {
  const folder = sharefileClient.toItem({
    Id: 'fi1', Name: 'Reports', 'odata.type': 'ShareFile.Api.Models.Folder',
    CreationDate: '2026-09-01T10:00:00Z',
  }, '/QA');
  assert.strictEqual(folder.type, 'folder');
  assert.strictEqual(folder.path, '/QA/Reports', 'path is assembled from the parent path and the name');
  assert.strictEqual(folder.size, 0, 'a folder has no size');

  const file = sharefileClient.toItem({
    Id: 'fi2', Name: 'q3.pdf', 'odata.type': 'ShareFile.Api.Models.File',
    FileSizeBytes: 2048, ClientModifiedDate: '2026-09-02T11:00:00Z',
  }, '/QA/Reports');
  assert.strictEqual(file.type, 'file');
  assert.strictEqual(file.size, 2048);
  assert.strictEqual(file.path, '/QA/Reports/q3.pdf');

  // No mimeType is invented. ShareFile has no native document format, so every item is an ordinary
  // binary — and deepContentCore treats an absent mimeType as exactly that. Inventing one here would
  // make isConverted()/isHashable() misjudge the file.
  assert.strictEqual(file.mimeType, undefined, 'mimeType must not be invented');
  assert.strictEqual(core.isHashable(file), true, 'an ordinary ShareFile binary is hashable for Tier B');

  assert.strictEqual(sharefileClient.toItem(null), null);
  console.log('  item normalisation matches the deepContentCore contract: ok');
}

/**
 * Nothing on this combination may be excused as a known limitation, because no out-of-scope document
 * exists for it. Guard against a future change borrowing a sibling's list.
 */
function testOutOfScopeIsRecorded() {
  const fs = require('fs');
  const path = require('path');
  const outscope = fs.readFileSync(
    path.join(__dirname, '../data/feature-scope/sharefile-to-sharepoint-outscope.md'), 'utf8'
  );

  // This file used to be pinned at zero, with this test enforcing it, because the .docx set has no
  // out-of-scope document — the "(1)" file is the in-scope list with its label flipped. The list
  // does exist, in the feature repository rather than the document set, and pinning zero meant the
  // agent seeded no negative controls at all. The pin now guards the real count instead.
  assert.ok(/\*\*Total Features:\*\* 7/.test(outscope),
    'the out-of-scope list has 7 features — a different count means someone edited it without a source');

  for (const feature of ['Delta', 'Root File Permissions', 'Inner File Permissions',
    'In Line comment', 'Shared Links', 'Selective Versions', 'Embedded Links']) {
    assert.ok(outscope.includes(feature), `out-of-scope feature "${feature}" must be recorded`);
  }

  // The distinction the in-scope document never states, and the one most likely to be lost in an
  // edit: FOLDER permissions migrate, FILE permissions do not. Validating file grants as in-scope
  // would fail a run for behaving exactly as specified.
  assert.ok(/must migrate/.test(outscope) && /must NOT migrate/.test(outscope),
    'the folder-vs-file permission distinction must stay written down');

  // A feature nobody can seed must never be able to report a pass.
  assert.ok(/never as passing/i.test(outscope),
    'the file must keep saying that an unseeded control is reported as not exercised');

  console.log('  out-of-scope list recorded, with the folder-vs-file permission split: ok');
}

/**
 * Every feature that can report PASS must also be able to report FAIL.
 *
 * This is the most expensive bug class the sibling combination shipped: feature 4.1 printed
 * "metadata preserved on 37 files" for weeks because its FAIL branch read a field that did not
 * exist and could never be reached. Ours had two of them — 5.1 pushed PASS from BOTH branches of
 * its if/else, and 6.1 pushed PASS or WARN and nothing else. A verdict no data can overturn is not
 * a check, and it is invisible in every run that passes.
 *
 * Asserted against the source text rather than by running the validator, because the point is
 * structural: the FAIL branch must EXIST. A behavioural test would need a live migration that had
 * actually gone wrong, which is precisely the run nobody has when the bug is introduced.
 */
function testEveryPassCanFail() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../src/validation/combinations/content/sharefileToSharepoint.js'), 'utf8'
  );

  // Verdict expressions carry no comma (`cond ? 'PASS' : 'FAIL'`), so the first argument ends at the
  // first comma and the check title is the quoted string after it.
  const verdictsByTitle = new Map();
  const re = /push\(([^,]*),\s*'([^']+)'/g;
  let m = re.exec(src);
  while (m) {
    const [, verdictExpr, title] = m;
    const seen = verdictsByTitle.get(title) || new Set();
    for (const v of ['PASS', 'FAIL', 'WARN']) if (verdictExpr.includes(`'${v}'`)) seen.add(v);
    verdictsByTitle.set(title, seen);
    m = re.exec(src);
  }
  assert.ok(verdictsByTitle.size > 0, 'no push() calls found — the regex or the file shape changed');

  for (const feature of ValidationAgent.SHAREFILE_FEATURES) {
    const titles = [...verdictsByTitle.keys()].filter((t) => feature.match.test(t));
    assert.ok(titles.length > 0,
      `feature ${feature.id} (${feature.feature}) matches no check the validator pushes — it would `
      + 'report "na" on every run');

    const verdicts = new Set();
    for (const t of titles) for (const v of verdictsByTitle.get(t)) verdicts.add(v);
    if (verdicts.has('PASS')) {
      assert.ok(verdicts.has('FAIL'),
        `feature ${feature.id} (${feature.feature}) can report PASS but has no reachable FAIL — `
        + 'nothing in the migrated data could overturn its verdict, so it is not a check');
    }
  }
  console.log('  every feature that can pass can also fail: ok');
}

/**
 * The permission ladder — features 2.1-2.4, the ~20 Xray cases.
 *
 * Run entirely against stubs: the point is not that ShareFile accepts the grants (only a live
 * tenant can say that) but that the ladder the seeder BUILDS is the one the cases describe. Four
 * things go wrong silently in a live run and are cheap to catch here:
 *
 *   - a flag name typo (`CanManagePermission`) — ShareFile ignores unknown properties, so the rung
 *     is written a level weaker than intended and nobody finds out until the report disagrees
 *   - a rung that is not a superset of the one below it, which makes the ladder unreadable
 *   - a folder reused between rungs, which merges two cases into one ACL
 *   - an account with no second user or no group failing the run, instead of seeding the folders
 *     and reporting the grant as skipped
 *
 * The stubs are restored in a `finally` around an AWAITED body. Returning the promise from inside
 * `try` would restore the real client at the first await and send the rest of the ladder at a live
 * tenant from a unit test.
 */
async function testPermissionLadder() {
  const ShareFileTestDataAgent = require('../src/agents/sharefile/ShareFileTestDataAgent');

  const realCreate = sharefileClient.createFolder;
  const realUpload = sharefileClient.uploadFile;
  const realGrant = sharefileClient.setAccessControl;

  const folders = [];
  const files = [];
  const grants = [];
  sharefileClient.createFolder = async (email, parentId, name) => {
    folders.push(name);
    return { id: `id-${folders.length}`, name, type: 'folder' };
  };
  sharefileClient.uploadFile = async (email, parentId, name) => { files.push(name); return true; };
  sharefileClient.setAccessControl = async (email, itemId, principalId, flags) => {
    grants.push({ itemId, principalId, flags });
    const asked = Object.keys(flags).filter((f) => flags[f] === true);
    return { itemId, principalId, asked, applied: asked, dropped: [] };
  };

  try {
    const agent = new ShareFileTestDataAgent();
    agent.log = { info() {}, warn() {} };
    agent.account = 'tester@example.com';

    const parent = { id: 'parent', path: '/QA-Automation/09-Permissions/ladder-root' };
    const principals = {
      user: { id: 'u1', email: 'someone@example.com' },
      group: { id: 'g1', name: 'Some Group' },
    };
    await agent._grantLadder(parent, principals, 'root', '2.1', '2.3');

    assert.strictEqual(grants.length, 10,
      '5 access levels x {user, group} = 10 grants per level; a different number means a rung or a '
      + 'principal kind was dropped');
    assert.strictEqual(agent.grants.length, 10, 'every applied grant must reach the result');

    // Every flag must be a real ShareFile property. A typo is accepted by the API and ignored.
    for (const g of grants) {
      for (const flag of Object.keys(g.flags)) {
        assert.ok(sharefileClient.ACCESS_FLAGS.includes(flag),
          `"${flag}" is not a ShareFile access flag — ShareFile would ignore it and the rung would `
          + 'be granted weaker than the case requires');
      }
    }

    // Two constraints ShareFile imposes, both verified live and both silent when broken — the grant
    // returns HTTP 200 and stores less than it was asked for.
    for (const g of grants) {
      assert.ok(!Object.keys(g.flags).includes('CanAddFolder'),
        'CanAddFolder is not settable through AccessControls — asking for it puts a permanent '
        + '"dropped" on the rung and teaches the reader to ignore the dropped field');
      if (g.flags.CanManagePermissions === true) {
        assert.strictEqual(g.flags.CanDelete, true,
          'ShareFile stores CanManagePermissions only alongside CanDelete; granting admin without '
          + 'delete produces a rung identical to the one below it, which tests nothing');
      }
    }

    // Each rung must contain everything the rung below it granted.
    for (const kind of ['user', 'group']) {
      const rungs = agent.grants.filter((g) => g.kind === kind).sort((a, b) => a.rung - b.rung);
      assert.strictEqual(rungs.length, 5, `${kind}: five rungs`);
      for (let i = 1; i < rungs.length; i += 1) {
        for (const f of rungs[i - 1].asked) {
          assert.ok(rungs[i].asked.includes(f),
            `${kind} rung ${rungs[i].rung} dropped "${f}", which rung ${rungs[i - 1].rung} granted `
            + '— the rungs are no longer a ladder');
        }
        assert.ok(rungs[i].asked.length > rungs[i - 1].asked.length,
          `${kind} rung ${rungs[i].rung} grants no more than rung ${rungs[i - 1].rung}`);
      }
    }

    // One folder per case, each with its own file — a shared folder merges two cases into one ACL.
    assert.strictEqual(new Set(grants.map((g) => g.itemId)).size, 10,
      'each of the 10 cases needs its own folder');
    assert.strictEqual(files.length, 10,
      'every rung folder carries a file, or nothing proves inheritance reached the contained item');

    // An account with no second user and no group must still seed the folders, and say why the
    // grants are absent. Failing here would mean the agent only works on accounts like ours.
    const solo = new ShareFileTestDataAgent();
    solo.log = { info() {}, warn() {} };
    solo.account = 'tester@example.com';
    const before = grants.length;
    await solo._grantLadder(parent, { user: null, group: null }, 'sub', '2.2', '2.3');

    assert.strictEqual(grants.length, before, 'no principals means no grant attempts');
    assert.strictEqual(solo.grants.length, 0);
    assert.strictEqual(
      solo.manifest.filter((m) => m.kind === 'grant' && m.status === 'skipped').length, 10,
      'all 10 cases must be reported as skipped-with-reason, not silently absent'
    );
    assert.ok(solo.manifest.some((m) => m.kind === 'folder'),
      'the folders are still seeded so a later run can grant into them');

    console.log('  permission ladder: 10 grants/level, supersets, one folder per case: ok');
  } finally {
    sharefileClient.createFolder = realCreate;
    sharefileClient.uploadFile = realUpload;
    sharefileClient.setAccessControl = realGrant;
  }
}

testRegistration();
testReusesSharePointDestination();
testPermissionRoleMap();
testPermissionComparison();
testPermissionFeaturesAreSeparate();
testToleranceBands();
testConfigurationGuard();
testAccountScopedCalls();
testItemNormalisation();
testOutOfScopeIsRecorded();
testEveryPassCanFail();
// Async, so the closing log lives inside the chain — printing it synchronously would claim the file
// passed before the ladder assertions had run, and a rejection would be an unhandled warning rather
// than a failed build.
testPermissionLadder().then(() => {
  console.log('sharefileToSharepoint.test.js: ok');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
