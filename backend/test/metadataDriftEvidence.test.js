/**
 * Feature 4.1 must cite the evidence it MEASURED, not an old anecdote.
 *
 * The WARN branch quoted run 54f9bfc2 verbatim on every run — "/13-Permission-Matrix/
 * file_viewer.txt, source 2026-09-10T04:49:06Z -> dest 2026-09-10T05:05:12Z". So run 60f0c1f2
 * reported "2 of 51 file(s) have a modified date outside the tolerance band" and then named one
 * file from a DIFFERENT run, sending anyone who investigated to the wrong place.
 *
 * The same detail called the permission correlation a "HYPOTHESIS needing a second run". It is
 * testable on every run, so it is now tested from the run's own data rather than restated.
 */
const assert = require('assert');
const Agent = require('../src/validation/combinations/content/dropboxToGoogledrive');

function metadataRow(drift, permissionObservations) {
  const rows = [];
  const push = (status, name, detail) => rows.push({ status, name, detail });
  const agent = new Agent();
  const totals = agent._emptyTotals({});
  totals.timestampDrift = drift;
  totals.permissionObservations = permissionObservations;
  totals.modifiedTimeRequested = true;
  totals.createdTimeRequested = false;
  totals.createdInfo = [];
  // itemDetails only needs to make tsCompared positive; the drift list drives the branch.
  // tsCompared counts itemDetails rows that carry a `timestamps` block — that is what the
  // check reads, so the fixture must carry it or the branch under test never runs.
  const itemDetails = Array.from({ length: 51 }, (_, i) => ({
    path: `/f${i}.txt`, type: 'file', timestamps: { modifiedPreserved: true },
  }));
  agent._rollUpItemChecks(push, totals, itemDetails);
  return rows.find((r) => r.name === '4.1 Metadata');
}

const DRIFT = [
  { path: '/13-Permission-Matrix/file_viewer.txt', source: '2026-09-16T04:00:00Z', dest: '2026-09-16T04:16:00Z', field: 'modifiedAt' },
  { path: '/03-File-Formats/document.txt', source: '2026-09-16T04:00:00Z', dest: '2026-09-16T04:05:00Z', field: 'modifiedAt' },
];

// ── The stale anecdote must be gone ──────────────────────────────────────────────────────
const granted = [{ path: '/13-Permission-Matrix/file_viewer.txt', checked: 1 }];
const row = metadataRow(DRIFT, granted);
assert.ok(row, '4.1 Metadata is reported');
assert.strictEqual(row.status, 'WARN', 'drift stays a WARN, matching googledriveToSharepoint');
assert.ok(!/54f9bfc2/.test(row.detail),
  `the old run id must never appear in a new run's detail, got: ${row.detail}`);
assert.ok(!/2026-09-10T04:49:06Z/.test(row.detail),
  'nor the old run\'s timestamps');

// ── It must name THIS run's files, with a readable gap ──────────────────────────────────
assert.ok(/\/03-File-Formats\/document\.txt/.test(row.detail),
  `every measured file is named, got: ${row.detail}`);
assert.ok(/16 min late/.test(row.detail), 'the gap is stated in minutes and direction');
assert.ok(/2 of 51/.test(row.detail), 'the count still matches the population');

// ── The permission correlation is COMPUTED, not asserted ────────────────────────────────
// One of two drifting files carries a grant → mixed, so the theory cannot be the only cause.
assert.ok(/1 of 2 drifting file\(s\) carry a direct permission grant/.test(row.detail),
  `the correlation is measured, got: ${row.detail}`);
assert.ok(/mixed result/.test(row.detail), 'and a mixed result is called mixed');

// All drifting files carry a grant → supports the theory.
const allGranted = metadataRow(DRIFT, DRIFT.map((d) => ({ path: d.path, checked: 1 })));
assert.ok(/supports the standing theory/.test(allGranted.detail),
  `a full correlation supports the theory, got: ${allGranted.detail}`);

// None carry a grant → contradicts it, and says so rather than repeating the theory.
const noneGranted = metadataRow(DRIFT, []);
assert.ok(/CONTRADICTS the standing theory/.test(noneGranted.detail),
  `no correlation must contradict, not restate, got: ${noneGranted.detail}`);
assert.ok(/Look elsewhere/.test(noneGranted.detail), 'and point the reader somewhere useful');

// ── No drift at all is still a clean PASS ───────────────────────────────────────────────
const clean = metadataRow([], []);
assert.strictEqual(clean.status, 'PASS', 'no drift is a pass');
assert.ok(/preserved/.test(clean.detail));

console.log('metadataDriftEvidence: OK');
