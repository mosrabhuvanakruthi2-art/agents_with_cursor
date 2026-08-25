'use strict';

/**
 * isSeededContentName — the allowlist that decides what content cleanup DELETES.
 *
 * This is the highest-consequence predicate in the repo: a false positive deletes somebody else's
 * data from a shared QA SharePoint site. It is deliberately an allowlist of the names
 * DriveTestDataAgent seeds, never "delete everything at the destination".
 *
 * Real names from trydemos.sharepoint.com/sites/QA are used below, including the two that must be
 * spared: `Test` (created 2024, predates this project) and `Long File Names.csv` (produced by
 * CloudFuze, not by any agent here).
 */

const assert = require('assert');
const { isSeededContentName, SEEDED_CONTENT_NAMES } = require('../src/agents/cleanup/CleanupAgent');

const SOURCE_FOLDER = 'Agent Shared Drive';

// ── Must be deleted: seeded folders and their counter copies ───────────────────
const DELETE = [
  'Agent Shared Drive', 'Agent Shared Drive 1', 'Agent Shared Drive 4',
  'Agent Files', 'Agent Files 1', 'Agent Files 4',
  'Agent Native Files', 'Agent Native Files 2',
  'Agent Permissions', 'Agent Permissions 3',
  'Agent Versions', 'Agent Versions 4',
  'File Formats', 'File Formats 2',
  'Long Folder Path', 'Long Folder Path 3',
  'Over Limit Path', 'Over Limit Path 1',
  'Shared Link Matrix', 'Shared Link Matrix 4',
  'Permission Matrix', 'Agent Shared Links',
  'Special !@#$%^&-()-_+=[] Folder', 'Special !@#$%^&-()-_+=[] Folder 2',
  `Long Name Folder ${'A'.repeat(80)}`, `Long Name Folder ${'A'.repeat(80)} 3`,
  'root_readme.txt', 'root_readme(1).txt', 'root_readme(4).txt',
];
for (const name of DELETE) {
  assert.strictEqual(isSeededContentName(name, SOURCE_FOLDER), true,
    `"${name}" is seeded test data and should be cleaned`);
}

// ── Must be spared: the two real items on that site, plus plausible neighbours ──
const SPARE = [
  'Test',                    // created 2024-02-28, predates this project
  'Long File Names.csv',     // CloudFuze report, not produced by any agent here
  'Documents',
  'Shared Documents',
  'Finance',
  'HR Policies',
  'Customer Contracts 2026',
  'Agentic',                 // starts with "Agent" but is NOT a seeded name
  'Agents',
  'Agent',                   // bare word, not one of ours
  'My Agent Files',          // seeded name embedded, but not the whole name
  'Agent Files Archive',     // ditto
  'Long Name Folder',        // no A-run, so not the 200-char folder
  'Special Folder',          // "Special … Folder" needs the middle section
  'root_readme_backup.txt',
  'notes.txt',
];
for (const name of SPARE) {
  assert.strictEqual(isSeededContentName(name, SOURCE_FOLDER), false,
    `"${name}" is NOT seeded test data and must never be deleted`);
}

// ── The source folder name is honoured dynamically ────────────────────────────
{
  // A different run uses a different base folder; that name must match too.
  assert.strictEqual(isSeededContentName('Agent Box Data', 'Agent Box Data'), true);
  assert.strictEqual(isSeededContentName('Agent Box Data 2', 'Agent Box Data'), true);
  // …and must NOT match when it is not the configured source folder.
  assert.strictEqual(isSeededContentName('Agent Box Data', 'Agent Shared Drive'), false);
}

// ── Multiple roots: the wizard's per-user overrides, not one base folder ───────
{
  // The run wizard leaves the BASE folder blank whenever every user has a per-user override, so
  // cleanup must read the override list. Passing only the (empty) base found nothing to clean on
  // exactly the runs that had accumulated duplicates.
  const roots = ['Agent Shared Drive', 'Agent My Drive'];
  assert.strictEqual(isSeededContentName('Agent Shared Drive 1', roots), true);
  assert.strictEqual(isSeededContentName('Agent My Drive 3', roots), true);
  assert.strictEqual(isSeededContentName('Agent Box Data', roots), false,
    'a root that is not part of THIS run must still be spared');
  // An empty list must not turn the predicate into "delete anything".
  assert.strictEqual(isSeededContentName('Test', []), false);
  assert.strictEqual(isSeededContentName('Agent Shared Drive', []), false,
    'with no roots configured, a run-specific folder is not identifiable and must be spared');
  // Blank entries must never match a blank-ish name.
  assert.strictEqual(isSeededContentName('', ['', null, undefined]), false);
  // Seeded names still match regardless of roots.
  assert.strictEqual(isSeededContentName('Agent Files 2', []), true);
}

// ── Degenerate input must not throw and must not delete ───────────────────────
for (const bad of [undefined, null, '', 0, false]) {
  assert.strictEqual(isSeededContentName(bad, SOURCE_FOLDER), false,
    `degenerate input ${JSON.stringify(bad)} must not be treated as seeded`);
}

// ── The allowlist itself stays an allowlist ───────────────────────────────────
{
  assert.ok(Array.isArray(SEEDED_CONTENT_NAMES), 'SEEDED_CONTENT_NAMES should be an array');
  assert.ok(SEEDED_CONTENT_NAMES.length > 0, 'the allowlist must not be empty');
  assert.ok(!SEEDED_CONTENT_NAMES.some((n) => n === '' || n === '*' || n === '/'),
    'the allowlist must never contain a wildcard or empty entry');
}

console.log('cleanupContentNames.test.js: ok');
