/**
 * Run: npm test  (from backend/)
 *
 * Every file format that can appear in a Google Shared Drive → SharePoint migration, in one place.
 *
 * Formats come from feature 12.1 of
 * backend/data/feature-scope/google-shared-drive-to-sharepoint-inscope.md, plus the Google native
 * types the Drive API can return. Each format is checked on four axes:
 *
 *   1. expected destination extension  — does it convert, and to what
 *   2. hashability                     — can Tier B compare its bytes at all
 *   3. tolerance band                  — converted files get the wide band, pass-through the tight one
 *   4. tree pairing                    — does the item pair with its destination counterpart
 *
 * A format that migrates unchanged, one that converts, and one that cannot migrate at all are three
 * different expected outcomes. Getting them confused is how a validator either fails a correct
 * migration or passes a broken one.
 */
const assert = require('assert');
const core = require('../src/validation/shared/deepContentCore');
const tolerance = require('../src/utils/contentTolerance');

const BANDS = tolerance.forCombination('googledrive_to_sharepoint');
const G = 'application/vnd.google-apps.';

/**
 * The format matrix.
 *   kind: 'convert'  — arrives with a different extension, bytes legitimately differ
 *         'through'  — arrives byte-identical with the same extension
 *         'native'   — Google editor file, exported to an Office format
 *         'blocked'  — Google-only type with no destination equivalent; never arrives
 */
const FORMATS = [
  // ── Feature 12.1: legacy Office upgrades
  { name: 'legacy.doc', mime: 'application/msword', kind: 'convert', expect: '.docx' },
  { name: 'legacy.xls', mime: 'application/vnd.ms-excel', kind: 'convert', expect: '.xlsx' },
  { name: 'legacy.ppt', mime: 'application/vnd.ms-powerpoint', kind: 'convert', expect: '.pptx' },

  // ── Feature 12.1: the 16 formats migrated unchanged
  { name: 'macro.xlsm', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12', kind: 'through', expect: '.xlsm' },
  { name: 'macro.docm', mime: 'application/vnd.ms-word.document.macroEnabled.12', kind: 'through', expect: '.docm' },
  { name: 'macro.pptm', mime: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12', kind: 'through', expect: '.pptm' },
  { name: 'notebook.one', mime: 'application/onenote', kind: 'through', expect: '.one' },
  { name: 'diagram.vsdx', mime: 'application/vnd.visio', kind: 'through', expect: '.vsdx' },
  { name: 'report.pdf', mime: 'application/pdf', kind: 'through', expect: '.pdf' },
  { name: 'notes.txt', mime: 'text/plain', kind: 'through', expect: '.txt' },
  { name: 'data.csv', mime: 'text/csv', kind: 'through', expect: '.csv' },
  { name: 'feed.xml', mime: 'application/xml', kind: 'through', expect: '.xml' },
  { name: 'config.json', mime: 'application/json', kind: 'through', expect: '.json' },
  { name: 'photo.jpg', mime: 'image/jpeg', kind: 'through', expect: '.jpg' },
  { name: 'logo.png', mime: 'image/png', kind: 'through', expect: '.png' },
  { name: 'clip.mp4', mime: 'video/mp4', kind: 'through', expect: '.mp4' },
  { name: 'audio.mp3', mime: 'audio/mpeg', kind: 'through', expect: '.mp3' },
  { name: 'bundle.zip', mime: 'application/zip', kind: 'through', expect: '.zip' },
  { name: 'bundle.rar', mime: 'application/vnd.rar', kind: 'through', expect: '.rar' },

  // ── Modern Office formats (named in feature 2.1 as supported types)
  { name: 'modern.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'through', expect: '.docx' },
  { name: 'modern.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'through', expect: '.xlsx' },
  { name: 'modern.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'through', expect: '.pptx' },

  // ── Google editor files: exported to Office formats
  { name: 'Q1 Notes', mime: `${G}document`, kind: 'native', expect: '.docx' },
  { name: 'Budget', mime: `${G}spreadsheet`, kind: 'native', expect: '.xlsx' },
  { name: 'Kickoff', mime: `${G}presentation`, kind: 'native', expect: '.pptx' },

  // ── Google-only types: no destination equivalent, so they never arrive
  { name: 'Survey', mime: `${G}form`, kind: 'blocked' },
  { name: 'Team Site', mime: `${G}site`, kind: 'blocked' },
  { name: 'Office Map', mime: `${G}map`, kind: 'blocked' },
  { name: 'Whiteboard', mime: `${G}jam`, kind: 'blocked' },
  { name: 'Automation', mime: `${G}script`, kind: 'blocked' },
  { name: 'Sketch', mime: `${G}drawing`, kind: 'blocked' },
  { name: 'Pointer', mime: `${G}shortcut`, kind: 'blocked' },
];

const asFile = (fmt, path) => ({
  type: 'file', path: path || `/${fmt.name}`, name: fmt.name, mimeType: fmt.mime, size: 1000,
});

function testExtensions() {
  for (const fmt of FORMATS) {
    const actual = core.expectedDestExtension(fmt.name, fmt.mime);
    if (fmt.kind === 'blocked') continue; // no destination file, so no expected extension
    assert.strictEqual(actual, fmt.expect,
      `${fmt.name} (${fmt.kind}) should arrive as ${fmt.expect}, got "${actual}"`);
  }

  // The converted name, not just the extension
  assert.strictEqual(core.expectedDestName('legacy.doc', 'application/msword'), 'legacy.docx');
  assert.strictEqual(core.expectedDestName('Q1 Notes', `${G}document`), 'Q1 Notes.docx');
  assert.strictEqual(core.expectedDestName('report.pdf', 'application/pdf'), 'report.pdf');
  // A native file that somehow already carries the extension is not double-suffixed
  assert.strictEqual(core.expectedDestName('Notes.docx', `${G}document`), 'Notes.docx');
}

function testHashability() {
  for (const fmt of FORMATS) {
    const item = asFile(fmt);
    const hashable = core.isHashable(item);
    if (fmt.kind === 'through') {
      assert.strictEqual(hashable, true, `${fmt.name} migrates byte-for-byte, so Tier B applies`);
    } else {
      assert.strictEqual(hashable, false, `${fmt.name} (${fmt.kind}) cannot be byte-compared`);
      assert.ok(core.notHashableReason(item), `${fmt.name} must carry a reason for the skip`);
    }
  }

  // Converted and native files say WHY, so a skip is never mistaken for a pass
  assert.ok(/cannot match/.test(core.notHashableReason(asFile(FORMATS[0]))), 'legacy conversion reason');
  const native = FORMATS.find((f) => f.kind === 'native');
  assert.ok(/native/i.test(core.notHashableReason(asFile(native))), 'native export reason');
}

function testBlockedTypes() {
  const blocked = FORMATS.filter((f) => f.kind === 'blocked');
  assert.ok(blocked.length >= 7, 'the Google-only types are enumerated');

  for (const fmt of blocked) {
    assert.strictEqual(core.isUnmigratableNative(fmt.mime), true, `${fmt.name} has no export path`);
    assert.ok(core.unmigratableReason(fmt.mime), `${fmt.name} explains why it cannot migrate`);
  }

  // Types that DO convert must not be misclassified as blocked
  for (const fmt of FORMATS.filter((f) => f.kind !== 'blocked')) {
    assert.strictEqual(core.isUnmigratableNative(fmt.mime), false,
      `${fmt.name} does migrate — it must not be treated as blocked`);
  }

  // A blocked type absent from the destination is EXPECTED, not a defect. Reporting it as missing
  // would fail every run that has a Google Form anywhere in the tree.
  const res = core.compareTrees(blocked.map((f) => asFile(f)), []);
  assert.strictEqual(res.status, 'PASS', 'Google-only types absent at the destination is not a failure');
  assert.strictEqual(res.missing.length, 0, 'and they are not counted as missing');
  assert.strictEqual(res.notMigratable.length, blocked.length, 'they are reported in their own bucket');
  assert.ok(res.notMigratable.every((n) => n.reason), 'each with its reason');
}

function testToleranceBandSelection() {
  // Pass-through: byte-identical, so the tight band applies and a big size change fails
  const pdf = asFile(FORMATS.find((f) => f.name === 'report.pdf'));
  assert.strictEqual(core.compareSize(pdf, { size: 1000 }, BANDS).status, 'PASS');
  assert.strictEqual(core.compareSize(pdf, { size: 2500 }, BANDS).status, 'FAIL',
    'a pass-through format may not borrow the converted-file tolerance');

  // Converted: a converter legitimately changes the size, so the wide band applies
  for (const fmt of FORMATS.filter((f) => f.kind === 'convert' || f.kind === 'native')) {
    const item = asFile(fmt);
    assert.strictEqual(core.compareSize(item, { size: 2500 }, BANDS).status, 'PASS',
      `${fmt.name} is converted — a 2.5x size change is expected`);
    assert.strictEqual(core.compareSize(item, { size: 1 }, BANDS).status, 'FAIL',
      `${fmt.name} arriving near-empty is still a failure`);
  }
}

function testTreePairingPerFormat() {
  // Every migratable format pairs with its correctly-named destination counterpart
  const migratable = FORMATS.filter((f) => f.kind !== 'blocked');
  const source = migratable.map((f) => asFile(f));
  const dest = migratable.map((f) => ({
    ...asFile(f),
    name: core.expectedDestName(f.name, f.mime),
    path: `/${core.expectedDestName(f.name, f.mime)}`,
  }));

  const res = core.compareTrees(source, dest);
  assert.strictEqual(res.status, 'PASS', `all formats pair: ${res.missing.map((m) => m.name).join(', ')}`);
  assert.strictEqual(res.matchedCount, migratable.length, 'every format matched exactly once');
  assert.strictEqual(res.extra.length, 0, 'and nothing was left over');

  // A file that arrives UNCONVERTED still pairs — deliberately, and this replaces the opposite
  // assertion. Presence and format are two different questions and belong in two different checks:
  //
  //   compareTrees   answers "did the item reach the destination, in the right place?"
  //   feature 12.1   answers "was it converted to the right format?"
  //
  // Refusing to pair conflated them and reported one file three times — missing (nothing matched
  // .docx), extra (the .doc nobody claimed), and misplaced — while the conversion check skipped
  // every unpaired file and so reported PASS. Run 6a8d53d2 passed feature 12.1 with all six legacy
  // Office files sitting unconverted at the destination. Pairing them makes the structure check
  // truthful and leaves the defect to the check that names it.
  const unconverted = core.compareTrees(
    [asFile(FORMATS.find((f) => f.name === 'legacy.doc'))],
    [{ type: 'file', path: '/legacy.doc', name: 'legacy.doc' }]
  );
  assert.strictEqual(unconverted.matchedCount, 1, 'the file IS present, so structure must pair it');
  assert.strictEqual(unconverted.missing.length, 0, 'and must not also call it missing');
  assert.strictEqual(unconverted.extra.length, 0, 'and must not also call it extra');

  // The converted name still wins when BOTH names are present at the destination.
  const both = core.compareTrees(
    [asFile(FORMATS.find((f) => f.name === 'legacy.doc'))],
    [
      { type: 'file', path: '/legacy.doc', name: 'legacy.doc' },
      { type: 'file', path: '/legacy.docx', name: 'legacy.docx' },
    ]
  );
  assert.strictEqual(both.matchedCount, 1, 'exactly one destination item may claim the source');
  assert.strictEqual(both.extra.length, 1, 'the other is left over');
  assert.strictEqual(both.extra[0].name, 'legacy.doc',
    'the CONVERTED name must be preferred, leaving the unconverted copy as the extra');

  // Same rule for a Google native file that arrives without its export extension.
  const nativeUnconverted = core.compareTrees(
    [asFile(FORMATS.find((f) => f.mime === `${G}document`))],
    [{ type: 'file', path: '/Q1 Notes', name: 'Q1 Notes' }]
  );
  assert.strictEqual(nativeUnconverted.matchedCount, 1,
    'a Google Doc that arrived without .docx is still present — 12.1 reports the format defect');

  // A file that is genuinely absent must STILL be reported missing — the fallback must not
  // manufacture a pair out of nothing.
  const absent = core.compareTrees(
    [asFile(FORMATS.find((f) => f.name === 'legacy.doc'))],
    []
  );
  assert.strictEqual(absent.matchedCount, 0, 'nothing to pair with');
  assert.strictEqual(absent.missing.length, 1, 'a truly absent file is still missing');
}

function testFormatsWithAwkwardNames() {
  // Dots in the middle of a name must not be mistaken for the extension (QA covers "combination of
  // . and words" cases explicitly)
  assert.strictEqual(core.expectedDestExtension('report.final.v2.pdf'), '.pdf');
  assert.strictEqual(core.expectedDestName('report.final.v2.doc'), 'report.final.v2.docx');
  assert.strictEqual(core.expectedDestExtension('my.folder.name'), '.name',
    'an unknown trailing segment is left alone rather than guessed at');

  // No extension at all
  assert.strictEqual(core.expectedDestExtension('README'), '');
  assert.strictEqual(core.expectedDestName('README'), 'README');

  // Extension case is normalised for the lookup but the name keeps its own case
  assert.strictEqual(core.expectedDestExtension('LEGACY.DOC'), '.docx');
  assert.strictEqual(core.expectedDestName('LEGACY.DOC'), 'LEGACY.docx');

  // A format plus an invalid character: both rules apply
  assert.strictEqual(core.expectedDestName('a:b.doc'), 'a_b.docx');
  assert.ok(core.namesMatch(core.convertName('a:b.doc'), 'a-b.docx'),
    'either replacement character still pairs after conversion');
}

function run() {
  testExtensions();
  testHashability();
  testBlockedTypes();
  testToleranceBandSelection();
  testTreePairingPerFormat();
  testFormatsWithAwkwardNames();
  const counts = FORMATS.reduce((a, f) => ({ ...a, [f.kind]: (a[f.kind] || 0) + 1 }), {});
  console.log(`contentFileFormats.test.js: ok — ${FORMATS.length} formats `
    + `(${counts.through} unchanged, ${counts.convert} converted, ${counts.native} native, ${counts.blocked} blocked)`);
}

run();
