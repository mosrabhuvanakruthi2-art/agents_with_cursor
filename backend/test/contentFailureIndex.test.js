'use strict';

/**
 * The content report's Failure Index must collapse repeated causes.
 *
 * Content checks list every affected item on one line joined by " | ", each shaped "<path> — <reason>".
 * Run 0b4a49cb reported "8. Permissions — 77 mismatch" as 77 segments naming ONE underlying cause, and
 * "9. Shared links — 80 mismatch" likewise. The mail report opens with a Failure Index; the content
 * report had none, so a reviewer had to read every table to find out what was actually wrong.
 *
 * Grouping on the reason is what turns 77 lines into one row saying "x77".
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// groupFailureReasons is internal to the generator; exercise it through the module source so the
// test stays honest about what ships, without widening the public surface just for a test.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'pdfGenerator.js'), 'utf8');
const start = SRC.indexOf('function groupFailureReasons(');
assert.notStrictEqual(start, -1, 'groupFailureReasons should exist in pdfGenerator.js');
const end = SRC.indexOf('\n}', start) + 2;
// eslint-disable-next-line no-new-func
const groupFailureReasons = new Function(`${SRC.slice(start, end)}; return groupFailureReasons;`)();

// ── The real permissions detail: one cause, many paths ────────────────────────
{
  const REASON = 'everyone_at_exinent@filefuze.co: Drive "fileOrganizer" (expect Edit) → SharePoint no access';
  const paths = ['/', '/Agent Files', '/Agent Files/qa_archive.zip', '/Agent Files/qa_config.json',
    '/Agent Native Files', '/Agent Versions/versioned_doc_1.txt'];
  const detail = paths.map((p) => `${p} — ${REASON}`).join(' | ');

  const groups = groupFailureReasons(detail);
  assert.strictEqual(groups.length, 1, '6 paths sharing one cause must collapse to a single row');
  assert.strictEqual(groups[0].count, 6, 'and the row must carry the affected count');
  assert.strictEqual(groups[0].reason, REASON);
}

// ── The real shared-links detail ──────────────────────────────────────────────
{
  const REASON = 'Drive anyone/reader (expect anonymous/view) → no link on destination: no anonymous link on the destination';
  const detail = ['/', '/Agent Files', '/Agent Files/qa_logo.png'].map((p) => `${p} — ${REASON}`).join(' | ');
  const groups = groupFailureReasons(detail);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].count, 3);
}

// ── Distinct causes stay distinct, ordered by impact ─────────────────────────
{
  const detail = [
    '/a — cause A', '/b — cause A', '/c — cause A',
    '/d — cause B', '/e — cause B',
    '/f — cause C',
  ].join(' | ');
  const groups = groupFailureReasons(detail);
  assert.deepStrictEqual(groups.map((g) => [g.reason, g.count]),
    [['cause A', 3], ['cause B', 2], ['cause C', 1]],
    'distinct causes are kept and sorted most-affected first');
}

// ── Details with no em dash are used whole, not dropped ──────────────────────
{
  const groups = groupFailureReasons('3 arrived unconverted, 0 wrong or absent');
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].count, 1);
  assert.ok(groups[0].reason.includes('unconverted'), 'the text must survive intact');
}

// ── Degenerate input must not throw ─────────────────────────────────────────
for (const bad of [undefined, null, '', '   ', 0]) {
  const groups = groupFailureReasons(bad);
  assert.ok(Array.isArray(groups), `groupFailureReasons(${JSON.stringify(bad)}) should return an array`);
  assert.strictEqual(groups.length, 0, 'and no rows for empty input');
}

// ── A single failing item still reports cleanly ──────────────────────────────
{
  const groups = groupFailureReasons('/File Formats/legacy_deck.ppt: still .ppt, expected .pptx');
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].count, 1);
}

console.log('contentFailureIndex.test.js: ok');
