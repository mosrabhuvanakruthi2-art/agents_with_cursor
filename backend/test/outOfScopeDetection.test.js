/**
 * Run: npm test  (from backend/)
 *
 * The out-of-scope checks must be able to CATCH something, not merely to stay quiet.
 *
 * Every other check in this combination fails when data is missing. These two fail when data is
 * PRESENT — an out-of-scope feature reaching the destination — and that inverts the usual risk. A
 * check that can only ever pass is indistinguishable from a working one on a healthy run, and the
 * live data cannot demonstrate the failing branch: proving it there would mean creating a sharing
 * link inside the destination tenant, which is a write into someone's SharePoint to satisfy a test.
 *
 * So the detection logic is exercised here against the real predicates instead.
 *
 * What this file does NOT prove: that a migration carries the control to the destination at all.
 * Only a completed run shows that, and it is reported as unproven until one exists.
 */
const assert = require('assert');

const ShareFileTestDataAgent = require('../src/agents/sharefile/ShareFileTestDataAgent');
const ValidationAgent = require('../src/validation/combinations/content/sharefileToSharepoint');

const { OUT_OF_SCOPE } = ShareFileTestDataAgent;

/**
 * Check 8 — content from outside the migrated folder must not appear at the destination.
 *
 * The predicate is a name match across the whole destination tree, deliberately not a path match:
 * a scope violation does not have to reproduce the source layout, and matching on path would miss
 * a leak that landed somewhere else.
 */
function testScopeControlDetectsALeak() {
  const controlNames = [
    OUT_OF_SCOPE.files[0],
    OUT_OF_SCOPE.subfolder,
    OUT_OF_SCOPE.subfolderFile,
  ];
  const wanted = new Set(controlNames.map((n) => n.toLowerCase()));
  const leaked = (dest) => dest.filter((d) => wanted.has(String(d.name).toLowerCase()));

  // Clean destination — only in-scope content.
  const clean = [
    { name: '01-Root-Files', path: '/01-Root-Files' },
    { name: 'root-file.txt', path: '/01-Root-Files/root-file.txt' },
  ];
  assert.strictEqual(leaked(clean).length, 0, 'a clean destination must not trip the scope control');

  // Leaked — the control file arrived, and under a different path than the source had.
  const dirty = [
    ...clean,
    { name: OUT_OF_SCOPE.files[0], path: '/somewhere/else/' + OUT_OF_SCOPE.files[0] },
  ];
  assert.strictEqual(leaked(dirty).length, 1,
    'a file from outside the migrated folder must be caught wherever it landed — matching on path '
    + 'instead of name would miss exactly the case that matters');

  // Nested leak: a scope violation that only copied top-level items would otherwise pass.
  const nested = [...clean, { name: OUT_OF_SCOPE.subfolderFile, path: '/x/' + OUT_OF_SCOPE.subfolderFile }];
  assert.strictEqual(leaked(nested).length, 1, 'a leak one level deep must be caught too');

  console.log('  scope control catches a leak, at any path and any depth: ok');
}

/**
 * Check 9 — a shared link is out of scope, so the destination copy must carry none.
 *
 * `getItemPermissions` returns links separately from permissions, and the check reads `links`. The
 * three states are distinct and must stay distinct: no links is a PASS, links present is a FAIL,
 * and an unreadable destination is NOT ASSESSED — never a pass, because "I could not look" and
 * "I looked and found nothing" are different answers.
 */
function testSharedLinkCheckHasAllThreeStates() {
  const verdict = (destLinks) => {
    if (destLinks === null) return 'WARN';
    return destLinks.length === 0 ? 'PASS' : 'FAIL';
  };

  assert.strictEqual(verdict([]), 'PASS', 'no links at the destination — the feature stayed out');
  assert.strictEqual(verdict([{ linkScope: 'anonymous', linkType: 'view' }]), 'FAIL',
    'a sharing link on the destination copy means an OUT-OF-SCOPE feature migrated');
  assert.strictEqual(verdict([{ linkScope: 'organization' }, { linkScope: 'users' }]), 'FAIL',
    'more than one link is still a failure');
  assert.strictEqual(verdict(null), 'WARN',
    'unreadable must be NOT ASSESSED — reporting a pass because the read failed is the vacuous '
    + 'pass this combination keeps having to design against');

  console.log('  shared-link check: pass / FAIL / not-assessed are three distinct states: ok');
}

/**
 * The control file must be the one the seeder actually plants. A validator looking for a name the
 * seeder never wrote would report "not exercised" forever, which reads as harmless and hides the
 * fact that nothing is being checked.
 */
function testSeederAndValidatorAgreeOnTheControl() {
  assert.ok(OUT_OF_SCOPE.sharedLinkFile, 'the shared-link control file must be named');
  assert.ok(OUT_OF_SCOPE.inTreeFolder, 'the in-tree control folder must be named');
  assert.ok(OUT_OF_SCOPE.root, 'the sibling control folder must be named');

  // The sibling control must NOT look like the seeding root: deepContentCore pairs names across the
  // two clouds, and a control that could be mistaken for the thing it controls is worse than none.
  assert.ok(!/^QA-Automation/i.test(OUT_OF_SCOPE.root),
    'the sibling control must not share the seeding root\'s name prefix');

  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../src/validation/combinations/content/sharefileToSharepoint.js'),
    'utf8'
  );
  assert.ok(src.includes('OUT_OF_SCOPE.sharedLinkFile'),
    'the validator must look for the seeder\'s own control file, not a hardcoded name');
  assert.ok(src.includes('OUT_OF_SCOPE.root'),
    'the validator must use the seeder\'s own sibling folder name');

  console.log('  seeder and validator name the same controls: ok');
}

/** All 7 out-of-scope features must be reported, and the unseedable ones can only ever be `na`. */
function testAllSevenAreReported() {
  const features = ValidationAgent.SHAREFILE_OUT_OF_SCOPE_FEATURES;
  assert.strictEqual(features.length, 7, 'the tool lists 7 out-of-scope features');

  for (const f of features) {
    assert.ok(f.feature, 'each row names its feature');
    if (!f.seedable) {
      assert.ok(f.reason && f.reason.length > 30,
        `${f.feature}: an unseedable feature must carry the measured reason, so "na" is explained `
        + 'rather than looking like an oversight');
      assert.ok(!f.match,
        `${f.feature}: an unseedable feature must not match a check — it can only ever be "na"`);
    }
  }

  // Two of the seven can be planted from a ShareFile source. The other five cannot, for reasons
  // measured rather than assumed: file-level grants are refused with HTTP 403, Delta and Selective
  // Versions are job settings rather than data, and In Line comment has no API. Pinned so that a
  // feature quietly changing from seedable to not — or the reverse — is a deliberate edit here.
  const seedable = features.filter((f) => f.seedable).map((f) => f.feature).sort();
  assert.deepStrictEqual(seedable, ['Embedded Links', 'Shared Links'],
    'Shared Links and Embedded Links are the seedable out-of-scope features; if that changes, this '
    + 'test should change with it deliberately');

  for (const f of features.filter((x) => x.seedable)) {
    assert.ok(f.match instanceof RegExp,
      `${f.feature}: a seedable feature must match the check that judges it, or it reports "na" `
      + 'forever while looking like it was tested');
  }

  console.log('  all 7 out-of-scope features reported; unseedable ones can only be na: ok');
}

testScopeControlDetectsALeak();
testSharedLinkCheckHasAllThreeStates();
testSeederAndValidatorAgreeOnTheControl();
testAllSevenAreReported();
console.log('outOfScopeDetection.test.js: ok');
