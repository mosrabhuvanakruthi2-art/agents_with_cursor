/**
 * Run: npm test  (from backend/)
 *
 * Content tolerance bands: they load per combination, and a band is only useful if just-inside passes
 * and just-outside fails. A band wide enough to hide a real defect is a bug, so the edges are asserted.
 */
const assert = require('assert');
const tolerance = require('../src/utils/contentTolerance');
const core = require('../src/validation/shared/deepContentCore');

const COMBINATION = 'googledrive_to_sharepoint';

function testLoading() {
  const bands = tolerance.forCombination(COMBINATION);
  assert.ok(bands, 'the combination auto-loads from its own file');
  assert.strictEqual(bands.combination, COMBINATION);
  assert.ok(tolerance.fileSize[COMBINATION], 'fileSize is indexed');
  assert.ok(tolerance.convertedFileSize[COMBINATION], 'convertedFileSize is indexed');
  assert.strictEqual(tolerance.forCombination('not_a_combination'), null);

  // Values the validator depends on
  assert.strictEqual(bands.pathLengthLimit, 400, 'SharePoint path limit');
  assert.strictEqual(bands.segmentLengthLimit, 255, 'per-segment limit');
  assert.strictEqual(bands.countDelta, 0, 'structure is exact — no count tolerance');
  assert.strictEqual(bands.timestampDriftMs, 5 * 60 * 1000);

  // DriveTestDataAgent seeds a 20-level path; a shallower cap would silently drop it from comparison
  assert.ok(bands.treeDepth > 20, 'tree depth must exceed the 20-level seeded nesting');
}

function testFileSizeEdges() {
  const bands = tolerance.forCombination(COMBINATION);
  const pdf = { type: 'file', name: 'a.pdf', size: 1000, mimeType: 'application/pdf' };
  const at = (size) => core.compareSize(pdf, { size }, bands).status;

  // Pass-through formats migrate byte-for-byte
  assert.strictEqual(at(1000), 'PASS', 'identical size passes');
  assert.strictEqual(at(1000 * bands.fileSize.infoMax), 'PASS', 'the info edge is inside');
  assert.strictEqual(at(1000 * bands.fileSize.infoMin), 'PASS');
  // Just outside info, still inside warn
  assert.strictEqual(at(1000 * (bands.fileSize.infoMax + 0.01)), 'WARN');
  assert.strictEqual(at(1000 * bands.fileSize.warnMax), 'WARN', 'the warn edge is still a warning');
  // Outside warn is a failure
  assert.strictEqual(at(1000 * (bands.fileSize.warnMax + 0.01)), 'FAIL');
  assert.strictEqual(at(1000 * (bands.fileSize.warnMin - 0.01)), 'FAIL');
  assert.strictEqual(at(1), 'FAIL', 'a truncated file fails');
}

function testConvertedSizeEdges() {
  const bands = tolerance.forCombination(COMBINATION);
  const doc = { type: 'file', name: 'legacy.doc', size: 1000 };
  const native = {
    type: 'file', name: 'Notes', size: 1000, mimeType: 'application/vnd.google-apps.document',
  };

  // Converted files get the wide band, because a converter legitimately changes the size
  assert.strictEqual(core.compareSize(doc, { size: 2500 }, bands).status, 'PASS');
  assert.strictEqual(core.compareSize(native, { size: 3000 }, bands).status, 'PASS');
  assert.strictEqual(
    core.compareSize(doc, { size: 1000 * bands.convertedFileSize.infoMax }, bands).status, 'PASS'
  );
  // Even a wide band has an outside: an empty or absurd destination file still fails
  assert.strictEqual(
    core.compareSize(doc, { size: 1000 * (bands.convertedFileSize.warnMax + 1) }, bands).status, 'FAIL'
  );
  assert.strictEqual(core.compareSize(doc, { size: 1 }, bands).status, 'FAIL',
    'a near-empty converted file is still a failure');

  // The wide band must NOT be applied to a pass-through file
  const pdf = { type: 'file', name: 'a.pdf', size: 1000, mimeType: 'application/pdf' };
  assert.strictEqual(core.compareSize(pdf, { size: 2500 }, bands).status, 'FAIL',
    'a pass-through file may not borrow the converted-file tolerance');
}

function testTimestampEdges() {
  const bands = tolerance.forCombination(COMBINATION);
  const base = Date.parse('2026-08-20T10:00:00.000Z');
  const at = (offsetMs) => core.compareTimestamps(
    { modifiedAt: new Date(base).toISOString() },
    { modifiedAt: new Date(base + offsetMs).toISOString() },
    bands.timestampDriftMs
  ).match;

  assert.strictEqual(at(0), true, 'no drift');
  assert.strictEqual(at(bands.timestampDriftMs), true, 'exactly at the band is preserved');
  assert.strictEqual(at(bands.timestampDriftMs + 1), false, 'one millisecond past the band fails');
  assert.strictEqual(at(-bands.timestampDriftMs), true, 'drift is symmetric');
  assert.strictEqual(at(60 * 60 * 1000), false, 'an hour of drift is not "preserved"');
}

function testPathLimitFromBands() {
  const bands = tolerance.forCombination(COMBINATION);
  const under = `/${'a'.repeat(bands.pathLengthLimit - 2)}`;
  const over = `/${'a'.repeat(bands.pathLengthLimit)}`;
  assert.strictEqual(core.exceedsPathLimit(under, bands.pathLengthLimit), false);
  assert.strictEqual(core.exceedsPathLimit(over, bands.pathLengthLimit), true);
  assert.strictEqual(
    core.oversizedSegments(`/${'s'.repeat(bands.segmentLengthLimit)}`, bands.segmentLengthLimit).length, 0
  );
  assert.strictEqual(
    core.oversizedSegments(`/${'s'.repeat(bands.segmentLengthLimit + 1)}`, bands.segmentLengthLimit).length,
    1
  );
}

function run() {
  testLoading();
  testFileSizeEdges();
  testConvertedSizeEdges();
  testTimestampEdges();
  testPathLimitFromBands();
  console.log('contentTolerance.test.js: ok');
}

run();
