/**
 * Run: npm test  (from backend/)
 *
 * Four ways this validator could report a GREEN feature having verified nothing, and the guards
 * that now stop each one. The project rule they all serve: "the run completed" is never a pass, and
 * a validator reporting SUCCESS while validating nothing is a bug.
 *
 *   - 9.2 Selective Versions pushed exactly one row, an INFO whose own text read "there is no N to
 *     verify". `worst()` returned 'pass' for anything that was not FAIL or WARN, so the checklist
 *     rendered a green check beside that sentence.
 *   - 10.1 mapped a WARN to 'pass' in its own branch, while the generic path mapped WARN to 'na'.
 *     Four branches spelled the row-to-feature mapping out separately and three of them disagreed,
 *     so `statusFor` is now the single place that decides.
 *   - 5.1 Special Characters skipped every risky item that failed to pair, then read the empty
 *     rename list as success — "0 name(s) with special characters arrived UNCHANGED", as a PASS.
 *   - 7.1 Long paths passed whenever nothing was missing, which is also true of a source that never
 *     held a long path. A shallow fixture tree reported the feature green having tested no limit.
 *
 * Plus the two Tier-2 gaps: Tier B byte hashing was advertised in the file header and never called,
 * and the shared-link CSV contributed a PASS to features 3.1 and 3.2 on the file merely existing.
 *
 * Every assertion is a pure function or a method driven with fixtures. No network, no Dropbox
 * account, no Drive account.
 */
const assert = require('assert');

const ValidationAgent = require('../src/validation/combinations/content/dropboxToGoogledrive');

// ── Helpers ─────────────────────────────────────────────────────────────────────────

/** `totals` shaped as _buildChecklist reads it, with deep validation on and a scanned source. */
function totalsFor(extra = {}) {
  return {
    enabled: true,
    scannedSourceItems: 40,
    migrationType: 'FULL',
    paperItems: [],
    paperSourceCount: 0,
    ...extra,
  };
}

const featureIn = (checklist, id) => checklist.find((f) => f.id === id);

/** Collect pushed rows the way the validator's own `push` does. */
function collector() {
  const rows = [];
  return { rows, push: (status, name, detail) => rows.push({ status, name, detail }) };
}

const rowNamed = (rows, re) => rows.find((r) => re.test(r.name));

// ── 1. An INFO-only feature is not a pass ───────────────────────────────────────────

function testInfoOnlyFeatureIsNotAPass() {
  const agent = new ValidationAgent();

  // Exactly what 9.2 pushes on a run with version data: one INFO saying there is no N to verify.
  const infoOnly = agent._buildChecklist(totalsFor(), [
    {
      name: '[Dest] 9.2 Selective Versions',
      status: 'INFO',
      detail: 'This run requested ALL versions, so there is no N to verify.',
    },
  ]);
  assert.strictEqual(featureIn(infoOnly, '9.2').status, 'na',
    'a feature whose only row is INFO has been described, not verified — it cannot pass');

  // A real PASS beside an INFO still passes: the INFO is an observation, not a veto.
  const passAndInfo = agent._buildChecklist(totalsFor(), [
    { name: '[Dest] 9.1 Version History', status: 'PASS', detail: '3 file(s) have history' },
    { name: '[Dest] 9.1 Version History note', status: 'INFO', detail: 'context' },
  ]);
  assert.strictEqual(featureIn(passAndInfo, '9.1').status, 'pass',
    'an INFO alongside a genuine PASS must not downgrade the feature');

  // And a FAIL still wins over everything.
  const failed = agent._buildChecklist(totalsFor(), [
    { name: '[Dest] 9.1 Version History', status: 'FAIL', detail: 'no history at the destination' },
    { name: '[Dest] 9.1 Version History note', status: 'INFO', detail: 'context' },
  ]);
  assert.strictEqual(featureIn(failed, '9.1').status, 'fail', 'a FAIL is never softened');

  console.log('  an INFO-only feature is na, not a pass (9.2): ok');
}

// ── 2. One mapping for every branch ─────────────────────────────────────────────────

function testWarnIsNeverAPassInAnyBranch() {
  const agent = new ValidationAgent();

  // 10.1 has its own branch, which used to read `v === 'fail' ? 'fail' : 'pass'` — so a WARN there
  // became a green check while the very same WARN became 'na' on the generic path.
  const paperWarn = agent._buildChecklist(totalsFor({ paperSourceCount: 2 }), [
    {
      name: '[Dest] 10.1 Dropbox Papers Migration',
      status: 'WARN',
      detail: 'Papers arrived but none could be exported',
    },
  ]);
  assert.strictEqual(featureIn(paperWarn, '10.1').status, 'na',
    'a WARN on 10.1 is "measured but not assessable" — na, never a pass');

  // The generic path agrees, and so does an INFO there.
  const genericWarn = agent._buildChecklist(totalsFor(), [
    { name: '[Dest] 5.1 Special Characters Replacement', status: 'WARN', detail: 'not exercised' },
  ]);
  assert.strictEqual(featureIn(genericWarn, '5.1').status, 'na',
    'the generic path maps WARN to na too');

  // 1.2 derives from the structure comparison; a WARN there must not become a pass either.
  const structureWarn = agent._buildChecklist(totalsFor(), [
    { name: '[Dest] 1.1 Data Migration', status: 'WARN', detail: 'partially compared' },
  ]);
  assert.strictEqual(featureIn(structureWarn, '1.2').status, 'na',
    'One Time Migration inherits the structure verdict, and a WARN is not a pass');

  console.log('  WARN is na in every branch, not a pass in some (10.1): ok');
}

// ── 3. 5.1 cannot pass on zero comparisons ──────────────────────────────────────────

function testSpecialCharactersNeedsAComparison() {
  const agent = new ValidationAgent();
  const rules = { special: null };

  const risky = [
    { path: '/Special ~!@#$%^&()_+[]{};,.= chars.txt', name: 'Special ~!@#$%^&()_+[]{};,.= chars.txt', type: 'file' },
  ];

  // The risky item exists at the source but never paired — the case that used to report
  // "0 name(s) ... arrived UNCHANGED" as a PASS.
  const none = collector();
  agent._checkSpecialCharacters(none.push, risky, { matched: new Map() }, rules,
    { specialChars: { arrived: 0 } });
  const noneRow = rowNamed(none.rows, /^5\.1 Special Characters/);
  assert.strictEqual(noneRow.status, 'WARN',
    'no risky name paired, so not one could be compared — that is unverified, not a pass');
  assert.ok(/UNVERIFIED/.test(noneRow.detail),
    `the reason must say it was not verified, got: ${noneRow.detail}`);
  assert.ok(/1\.1/.test(noneRow.detail),
    'and must hand the absence to the structure check that owns it');

  // One that DID pair, unchanged, is still a genuine pass.
  const paired = collector();
  agent._checkSpecialCharacters(paired.push, risky, {
    matched: new Map([[risky[0].path, { source: risky[0], dest: { name: risky[0].name } }]]),
  }, rules, { specialChars: { arrived: 0 } });
  const pairedRow = rowNamed(paired.rows, /^5\.1 Special Characters/);
  assert.strictEqual(pairedRow.status, 'PASS',
    'a name that arrived unchanged is the documented Google outcome and still passes');

  console.log('  5.1 needs at least one real comparison to pass: ok');
}

// ── 4. 7.1 cannot pass on a source with no long path ────────────────────────────────

function testLongPathsMustBeExercised() {
  const agent = new ValidationAgent();
  const rules = { pathLengthLimit: Infinity };
  const bandRules = { pathLengthLimit: Infinity };

  // A shallow tree where everything arrived. Nothing is missing, but nothing deep was tried.
  const shallow = [
    { path: '/a.txt', name: 'a.txt', type: 'file' },
    { path: '/b/c.txt', name: 'c.txt', type: 'file' },
  ];
  const allArrived = {
    matchedCount: shallow.length,
    matched: new Map(shallow.map((i) => [i.path, { source: i, dest: { name: i.name } }])),
    missing: [],
    totalSource: shallow.length,
  };
  const flat = collector();
  agent._checkLongPaths(flat.push, shallow, allArrived, rules, { longPathEvidence: [] });
  const flatRow = rowNamed(flat.rows, /^7\.1 Long-File/);
  assert.strictEqual(flatRow.status, 'WARN',
    '"nothing was missing" is not evidence about long paths when no long path existed');
  assert.ok(/not exercised/i.test(flatRow.detail),
    `the reason must say it was not exercised, got: ${flatRow.detail}`);
  assert.ok(/_seedLongPath|08-Long-Paths/.test(flatRow.detail),
    'and must name where the seeded chain comes from, so a reader can check seeding');

  // The seeded 20-level chain, all arrived: a real pass.
  const deep = [];
  let p = '';
  for (let i = 1; i <= 20; i++) {
    p += `/Level-with-a-deliberately-long-name-to-grow-the-path`;
    deep.push({ path: `${p}/checkpoint-depth-${i}.txt`, name: `checkpoint-depth-${i}.txt`, type: 'file' });
  }
  const deepArrived = {
    matchedCount: deep.length,
    matched: new Map(deep.map((i) => [i.path, { source: i, dest: { name: i.name } }])),
    missing: [],
    totalSource: deep.length,
  };
  const deepC = collector();
  agent._checkLongPaths(deepC.push, deep, deepArrived, bandRules, { longPathEvidence: [] });
  const deepRow = rowNamed(deepC.rows, /^7\.1 Long-File/);
  assert.strictEqual(deepRow.status, 'PASS',
    'a genuinely deep source that arrived intact is the documented Google outcome');

  console.log('  7.1 passes only when a long path was actually exercised: ok');
}

// ── 5. Tier B byte hashing actually runs, and says so when it does not ──────────────

async function testTierBHashesRunAndAreHonestWhenOff() {
  const agent = new ValidationAgent();
  const env = require('../src/config/env');
  const original = env.CONTENT_DEEP_VALIDATE_FILE_HASH;

  const pair = (path, id) => [path, {
    source: { path, dbxPath: `/root${path}`, name: path.slice(1), type: 'file', size: 10 },
    dest: { path, id, name: path.slice(1), type: 'file', size: 10 },
  }];

  try {
    // OFF: the absence of a hash finding must not read as "the bytes were checked".
    env.CONTENT_DEEP_VALIDATE_FILE_HASH = false;
    const off = collector();
    await agent._checkContentHashes(off.push, { matched: new Map([pair('/a.txt', 'd1')]) },
      'dest@x.com', {}, { hashedCount: 0, notHashedCount: 0, hashMismatches: [] }, []);
    const offRow = rowNamed(off.rows, /File content hashes \(Tier B\)/);
    assert.strictEqual(offRow.status, 'INFO', 'a skipped Tier B is stated, never silent');
    assert.ok(/NOT run/.test(offRow.detail),
      `it must say it did not run, got: ${offRow.detail}`);
    assert.ok(/content was not/i.test(offRow.detail),
      'and must be explicit that file CONTENT went unchecked');

    // ON, with bytes that differ: a corrupted file is a FAIL, not a size-band pass.
    env.CONTENT_DEEP_VALIDATE_FILE_HASH = true;
    const totals = { hashedCount: 0, notHashedCount: 0, hashMismatches: [] };
    const rows = [{ path: '/a.txt' }];
    const bad = collector();
    const realDownload = require('../src/clients/dropboxClient').downloadFile;
    const realDriveDownload = require('../src/clients/driveClient').downloadFile;
    require('../src/clients/dropboxClient').downloadFile = async () => Buffer.from('the source bytes');
    require('../src/clients/driveClient').downloadFile = async () => Buffer.from('TRUNCATED');
    try {
      await agent._checkContentHashes(bad.push, { matched: new Map([pair('/a.txt', 'd1')]) },
        'dest@x.com', {}, totals, rows);
    } finally {
      require('../src/clients/dropboxClient').downloadFile = realDownload;
      require('../src/clients/driveClient').downloadFile = realDriveDownload;
    }
    const badRow = rowNamed(bad.rows, /File content hashes \(Tier B\)/);
    assert.strictEqual(badRow.status, 'FAIL',
      'destination bytes that differ from the source are a defect, whatever the size band says');
    assert.strictEqual(totals.hashMismatches.length, 1,
      'the mismatch is recorded on totals, which were previously initialised and never written');
    assert.strictEqual(rows[0].contentHash.ok, false,
      'and carried onto the per-item row so the report can show it beside the item');
  } finally {
    env.CONTENT_DEEP_VALIDATE_FILE_HASH = original;
  }

  console.log('  Tier B byte hashing runs, and reports honestly when switched off: ok');
}

// ── 6. The shared-link CSV can no longer decide 3.1 / 3.2 ───────────────────────────

function testSharedLinkCsvIsSupportingEvidenceOnly() {
  const agent = new ValidationAgent();

  // The old defect: a written CSV contributed a pass to both documented features.
  const csvOnly = agent._buildChecklist(totalsFor(), [
    {
      name: '[Dest] 3.x Shared Link CSV (supporting evidence)',
      status: 'INFO',
      detail: '"Erik E shared links.csv" present with 0 row(s) total',
    },
  ]);
  assert.strictEqual(featureIn(csvOnly, '3.1').status, 'na',
    'a CSV existing says nothing about whether a link resolves — 3.1 cannot rest on it');
  assert.strictEqual(featureIn(csvOnly, '3.2').status, 'na',
    'nor can 3.2');

  // The live link comparison still decides the feature.
  const live = agent._buildChecklist(totalsFor(), [
    { name: '[Dest] 3.1 Shared Links (Anyone with the Link)', status: 'FAIL', detail: 'link missing' },
    {
      name: '[Dest] 3.x Shared Link CSV (supporting evidence)',
      status: 'INFO',
      detail: 'present with 12 row(s)',
    },
  ]);
  assert.strictEqual(featureIn(live, '3.1').status, 'fail',
    'a missing live link fails 3.1 even though CloudFuze wrote its report');

  console.log('  the shared-link CSV is supporting evidence, not a verdict (3.1/3.2): ok');
}

// ── 7. An empty destination produces no green feature ───────────────────────────────
//
// Run 2335a339 is the reason this exists. CloudFuze ended the job CONFLICT having moved nothing
// (totalFilesAndFolders=0) because the destination folder did not exist, so validation ran against
// an empty destination. That is the single most dangerous shape for this report to get wrong: every
// feature is genuinely unexercised, and any green check would be a claim about a migration that
// never happened.

function testEmptyDestinationHasNoGreenFeature() {
  const agent = new ValidationAgent();

  // Shape A — the destination ROOT would not resolve at all, so _validateUnit is never reached and
  // _buildResult is called with scannedSourceItems: 0.
  const rootUnresolved = agent._buildChecklist(
    { enabled: true, scannedSourceItems: 0, migrationType: 'FULL', paperItems: [] },
    [{
      name: 'Destination location',
      status: 'FAIL',
      detail: '"QA-dropbox-mydrive-dst" not found under "root"',
    }]
  );
  const greenA = rootUnresolved.filter((f) => f.status === 'pass');
  assert.strictEqual(greenA.length, 0,
    `nothing was read, so no feature may pass — got: ${greenA.map((f) => f.id).join(', ')}`);

  // Shape B — run 2335a339 exactly: the source WAS scanned (38 folders + 46 files seeded) and the
  // migration moved nothing, so the migrated folder was never found and the unit returned early.
  const destMissing = agent._buildChecklist(
    {
      enabled: true,
      scannedSourceItems: 84,
      migrationType: 'FULL',
      paperItems: [],
      paperSourceCount: 1,
    },
    [
      {
        name: '[QA-dropbox-mydrive-dst] Source items scanned',
        status: 'PASS',
        detail: '84 item(s) read from Dropbox /QA-dropbox-mydrive',
      },
      {
        name: '[QA-dropbox-mydrive-dst] Destination location',
        status: 'FAIL',
        detail: 'Nothing named "QA-dropbox-mydrive" exists under Google My Drive',
      },
    ]
  );
  const greenB = destMissing.filter((f) => f.status === 'pass');
  assert.strictEqual(greenB.length, 0,
    'an empty destination must produce no green feature, got: '
    + greenB.map((f) => `${f.id} ${f.feature}`).join(', '));

  // A scanned source must not be mistaken for a validated one either: the "Source items scanned"
  // PASS above is deliberately named so that no feature pattern can match it.
  assert.ok(destMissing.every((f) => String(f.detail || '').trim().length > 0),
    'every feature carries a reason, so an "na" is never unexplained in the report');

  console.log('  an empty destination yields no green feature (run 2335a339 shape): ok');
}

// ── Run ─────────────────────────────────────────────────────────────────────────────

(async () => {
  testInfoOnlyFeatureIsNotAPass();
  testWarnIsNeverAPassInAnyBranch();
  testSpecialCharactersNeedsAComparison();
  testLongPathsMustBeExercised();
  await testTierBHashesRunAndAreHonestWhenOff();
  testSharedLinkCsvIsSupportingEvidenceOnly();
  testEmptyDestinationHasNoGreenFeature();
  console.log('dropbox → google honest verdicts: all assertions passed');
})();
