/**
 * Run: npm test  (from backend/)
 *
 * A size RATIO is not a meaningful measure of a small CONVERTED file.
 *
 * An Office file is a zip of XML parts — styles, relationships, content types — and that scaffolding
 * costs a fixed few kilobytes whatever the document says. On a large file it is noise; on a small
 * one it IS the file.
 *
 * Measured on run d5381fca (googleshareddrive → sharepoint), all three correct conversions:
 *   QA Test Document      1,024 → 14,525  (14.18x)
 *   QA Test Presentation  3,664 → 40,271  (10.99x)
 *   QA Test Spreadsheet   1,024 → 13,039  (12.73x)
 *
 * All three were reported as outside the tolerance band. The same check also carried ONE genuine
 * finding — a PASSTHROUGH .docx that grew 1.77x — and the heading read "4 outside the band", so a
 * real defect arrived looking like a quarter of the problem. That is the cost being fixed here:
 * scoring what cannot be scored does not merely add noise, it hides signal.
 *
 * This module is SHARED by every content combination, so the passthrough and large-conversion cases
 * are asserted too — the floor must change nothing except small converted files.
 */
const assert = require('assert');

const core = require('../src/validation/shared/deepContentCore');
const tolerance = require('../src/utils/contentTolerance');

const GDOC = 'application/vnd.google-apps.document';
const GSLIDES = 'application/vnd.google-apps.presentation';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF = 'application/pdf';

const bands = tolerance.forCombination('googledrive_to_sharepoint');

/** The three conversions from the real run must be reported, not scored. */
function testSmallConversionsAreNotScored() {
  const observed = [
    ['QA Test Document', 1024, 14525, GDOC],
    ['QA Test Presentation', 3664, 40271, GSLIDES],
    ['QA Test Spreadsheet', 1024, 13039, GSHEET],
  ];
  for (const [name, s, d, mimeType] of observed) {
    const r = core.compareSize({ name, size: s, mimeType }, { size: d }, bands);
    assert.strictEqual(r.comparable, false,
      `${name}: a ${(d / s).toFixed(2)}x ratio on a ${s}-byte converted file is not comparable`);
    assert.strictEqual(r.status, 'INFO',
      `${name}: reported at INFO, never scored as a defect — got ${r.status}`);
    assert.ok(/floor|overhead|dominates/i.test(String(r.note)),
      `${name}: the note must explain WHY, got: ${r.note}`);
    // The measured numbers are still carried, so a reader can see them.
    assert.strictEqual(r.sourceSize, s, 'the source size is still reported');
    assert.strictEqual(r.destSize, d, 'and the destination size');
  }
  console.log('  small converted files reported, not scored: ok');
}

/** The genuine finding in the same run must still FAIL. */
function testTheRealFindingSurvives() {
  // A PASSTHROUGH .docx that grew 1.77x — no conversion, so the strict band applies.
  const r = core.compareSize(
    { name: 'embedded_link_doc.docx', size: 8788, mimeType: DOCX }, { size: 15540 }, bands
  );
  assert.strictEqual(r.comparable, true, 'a passthrough file is always comparable');
  assert.strictEqual(r.status, 'FAIL',
    'a passthrough .docx growing 1.77x is a real finding and must still fail');
  console.log('  the genuine passthrough finding still fails: ok');
}

/** The floor must not excuse a LARGE conversion, where the ratio does mean something. */
function testLargeConversionsStillJudged() {
  const wild = core.compareSize({ name: 'Big', size: 1048576, mimeType: GDOC },
    { size: 31457280 }, bands);
  assert.strictEqual(wild.comparable, true, 'a 1MB source is above the floor');
  assert.strictEqual(wild.status, 'FAIL', 'a 30x growth on a 1MB file is still a defect');

  const sane = core.compareSize({ name: 'Big', size: 1048576, mimeType: GDOC },
    { size: 2097152 }, bands);
  assert.strictEqual(sane.status, 'PASS', 'a 2x growth on a large conversion is inside the band');
  console.log('  large conversions still judged: ok');
}

/** Passthrough formats are untouched by the floor, at any size. */
function testPassthroughUnaffected() {
  const small = core.compareSize({ name: 'a.pdf', size: 500, mimeType: PDF }, { size: 900 }, bands);
  assert.strictEqual(small.comparable, true,
    'a small PASSTHROUGH file is still compared — no converter overhead applies to it');
  assert.strictEqual(small.status, 'FAIL', 'and a 1.8x change in passthrough bytes is a defect');

  const exact = core.compareSize({ name: 'a.pdf', size: 5000, mimeType: PDF }, { size: 5000 }, bands);
  assert.strictEqual(exact.status, 'PASS', 'identical passthrough bytes pass');
  console.log('  passthrough files unaffected at any size: ok');
}

/** A combination can tune or disable the floor through its own band. */
function testFloorIsTunable() {
  const custom = {
    convertedFileSize: { infoMin: 0.25, infoMax: 4, warnMin: 0.05, warnMax: 20, minComparableBytes: 0 },
    fileSize: bands.fileSize,
  };
  const r = core.compareSize({ name: 'QA Test Document', size: 1024, mimeType: GDOC },
    { size: 14525 }, custom);
  assert.strictEqual(r.comparable, true,
    'minComparableBytes: 0 opts out, so the ratio is scored again');

  const higher = {
    convertedFileSize: { ...custom.convertedFileSize, minComparableBytes: 1048576 },
    fileSize: bands.fileSize,
  };
  const r2 = core.compareSize({ name: 'Big', size: 65536, mimeType: GDOC }, { size: 900000 }, higher);
  assert.strictEqual(r2.comparable, false, 'a higher floor suppresses more');
  console.log('  the floor is tunable per combination: ok');
}

/** Every combination with bands must still produce a usable verdict — this module is shared. */
function testEveryCombinationStillWorks() {
  for (const key of Object.keys(tolerance.bands)) {
    const b = tolerance.forCombination(key);
    if (!b || !b.fileSize) continue;
    const pass = core.compareSize({ name: 'a.pdf', size: 50000, mimeType: PDF }, { size: 50000 }, b);
    assert.strictEqual(pass.status, 'PASS', `${key}: identical passthrough bytes must pass`);
    // And a converted file above any sane floor is still scored.
    const conv = core.compareSize({ name: 'D', size: 2097152, mimeType: GDOC }, { size: 4194304 }, b);
    assert.ok(['PASS', 'WARN', 'FAIL'].includes(conv.status),
      `${key}: a large conversion still receives a verdict, got ${conv.status}`);
  }
  console.log(`  all ${Object.keys(tolerance.bands).length} combination band set(s) still work: ok`);
}

testSmallConversionsAreNotScored();
testTheRealFindingSurvives();
testLargeConversionsStillJudged();
testPassthroughUnaffected();
testFloorIsTunable();
testEveryCombinationStillWorks();
console.log('convertedSizeFloor.test.js: ok');
