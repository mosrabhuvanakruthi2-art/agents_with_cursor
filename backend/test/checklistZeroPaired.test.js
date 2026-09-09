'use strict';

/**
 * No feature row may claim PASS when nothing reached the destination.
 *
 * Why this file exists: a run where 0 of 316 source items migrated still reported
 *   10.1 Metadata        PASS  "Created and last-modified times preserved within tolerance"
 *   11.1 Long paths      PASS  "12 over-limit item(s) handled as placeholder links"
 *   12.1 File Conversion PASS  "All converted files carry the expected destination format"
 * Those loops iterate the paired set. With an empty destination the set is empty, every loop finds no
 * mismatch, and the check "passes" without comparing anything. A check with nothing to compare has
 * not been satisfied — it has not been run.
 *
 * The existing scanned === 0 guard does not cover this: the SOURCE read fine (316 items), it is the
 * DESTINATION that was empty.
 */

const assert = require('assert');
const {
  computeContentFunctionalityChecklist,
  summarizeChecklist,
} = require('../src/validation/shared/contentFunctionalityChecklist');

// A dcv shaped like the real zero-paired run: source fully read, nothing arrived.
function zeroPairedDcv(overrides = {}) {
  return {
    enabled: true,
    scannedSourceItems: 316,
    pairedCount: 0,
    missing: new Array(304).fill(0).map((_, i) => `/item-${i}`),
    extra: [],
    misplaced: [],
    // 12 over-limit items, as the real run had — without these 11.1 is legitimately NA rather than
    // a vacuous PASS, and the regression would not be exercised.
    placeholderLinks: new Array(12).fill(0).map((_, i) => ({ path: `/long-${i}`, url: `https://x/${i}` })),
    permissionObservations: [],
    linkObservations: [],
    // 12.1 keys off fileTypes carrying a convertible extension; without one it is legitimately NA
    // and the vacuous-PASS path is never reached.
    fileTypes: [{ ext: '.doc', total: 3, paired: 0 }],
    specialChars: { total: 8, arrived: 0 },
    metadataChecked: true,
    linksChecked: true,
    conversionMismatches: [],
    ...overrides,
  };
}

// ── The regression: nothing paired => no PASS anywhere ────────────────────────
{
  const { rows, nothingPaired } = computeContentFunctionalityChecklist(zeroPairedDcv(), { migrationType: 'FULL' });
  assert.strictEqual(nothingPaired, true, 'nothingPaired must be flagged');

  const passed = rows.filter((r) => r.status === 'pass');
  assert.strictEqual(passed.length, 0,
    `no row may PASS when nothing paired; got: ${passed.map((r) => `${r.id} ${r.feature}`).join(', ')}`);

  const infos = rows.filter((r) => r.status === 'info');
  assert.strictEqual(infos.length, 0, 'INFO is also a claim about migrated data — not allowed either');

  // The three that used to pass vacuously are named explicitly so this cannot regress quietly.
  for (const id of ['10.1', '11.1', '12.1']) {
    const row = rows.find((r) => r.id === id);
    assert.ok(row, `row ${id} should exist`);
    assert.notStrictEqual(row.status, 'pass', `row ${id} must not PASS on an empty destination`);
    assert.ok(/Not verifiable/.test(row.detail),
      `row ${id} detail should say it was not verifiable, got: ${row.detail}`);
    assert.ok(/0 of 316/.test(row.detail), `row ${id} detail should carry the counts, got: ${row.detail}`);
  }
}

// ── Rows that were genuinely NOT EXERCISED stay NA, not FAIL ──────────────────
// A feature the source never had is not a failure of the migration.
{
  const { rows } = computeContentFunctionalityChecklist(zeroPairedDcv(), { migrationType: 'FULL' });
  const na = rows.filter((r) => r.status === 'na');
  assert.ok(na.length > 0, 'not-exercised features should still report NA');
  // 1.2 Delta: this was a one-time run, so it is NA regardless of pairing.
  assert.strictEqual(rows.find((r) => r.id === '1.2').status, 'na', 'Delta stays NA on a one-time run');
}

// ── A healthy run is untouched: PASS still allowed when items paired ──────────
{
  const healthy = zeroPairedDcv({
    pairedCount: 316,
    missing: [],
    specialChars: { total: 8, arrived: 8 },
  });
  const { rows, nothingPaired } = computeContentFunctionalityChecklist(healthy, { migrationType: 'FULL' });
  assert.strictEqual(nothingPaired, false, 'a fully paired run is not nothingPaired');
  assert.ok(rows.some((r) => r.status === 'pass'), 'a healthy run must still be able to PASS');
}

// ── Source unreadable keeps its own message (the pre-existing guard) ──────────
{
  const { rows } = computeContentFunctionalityChecklist(
    zeroPairedDcv({ scannedSourceItems: 0, missing: [] }), { migrationType: 'FULL' });
  assert.ok(rows.every((r) => r.status === 'na'), 'scanned===0 stays all-NA');
  assert.ok(/No source items were read/.test(rows[0].detail), 'keeps the source-unreadable wording');
}

// ── The summary reflects it: zero passes ─────────────────────────────────────
{
  const { rows, coverage } = computeContentFunctionalityChecklist(zeroPairedDcv(), { migrationType: 'FULL' });
  const sum = summarizeChecklist(rows, coverage);
  assert.strictEqual(sum.pass, 0, `summary must report 0 pass, got ${sum.pass}`);
  assert.ok(sum.fail > 0, 'summary should report failures');
  assert.strictEqual(sum.total, rows.length);
}

console.log('checklistZeroPaired.test.js: ok');
