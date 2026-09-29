'use strict';

/**
 * Features 2.1 (Root Folder Permissions) and 2.2 (Root File Permissions) need grants on items at
 * depth <= 1, and 8.1 (Embedded Links) needs a control link the migration cannot rewrite.
 *
 * Execution 84fb9f41 reported all three N/A. The validator was right to: every grant this agent
 * seeded lived inside `Permission Matrix/` or `Agent Permissions/`, both at depth 2, so 2.1 and 2.2
 * had no evidence that could possibly be theirs — while 2.3 and 2.4 carried nine and five grants.
 * The gap was in the SEED DATA, and nothing in the tree made it visible: the run looked complete and
 * two documented features quietly went unexercised on every single run.
 *
 * These assertions pin the part that has no other guard — the depth of the items the agent creates
 * and the cleanup allowlist that has to know their names. The Drive API calls themselves are not
 * exercised here; they need live credentials and belong to a real run.
 */

const assert = require('assert');
const {
  permissionFeatureIds,
  PERM_FEATURE_CHECK_NAMES,
} = require('../src/validation/combinations/content/googledriveToGoogledrive');
const {
  EMBEDDED_LINK_OUT_OF_SET_ID,
} = require('../src/agents/drive/DriveTestDataAgent');
const { isSeededContentName, SEEDED_CONTENT_NAMES } = require('../src/agents/cleanup/CleanupAgent');

const SOURCE_FOLDER = 'qa-src-mydrive';
const INTERNAL = { email: 'alex@filefuze.co', role: 'writer' };
const EXTERNAL = { email: 'outside@example.org', role: 'reader' };
const SOURCE_DOMAIN = 'filefuze.co';

// ── The names _createRootPermissions seeds, and the depth they sit at ─────────
// Paths are relative to the migrated root, exactly as core.compareTrees produces them, so a folder
// created directly in the root is "/root_folder_reader" — one segment, depth 1.
const ROOT_FOLDERS = ['root_folder_reader', 'root_folder_commenter', 'root_folder_writer'];
const ROOT_FILES = ['root_file_reader.txt', 'root_file_commenter.txt', 'root_file_writer.txt'];

for (const name of ROOT_FOLDERS) {
  const ids = permissionFeatureIds({ path: `/${name}`, type: 'folder' }, INTERNAL, SOURCE_DOMAIN);
  assert.ok(ids.includes('2.1'),
    `a grant on the root folder "${name}" must be evidence for 2.1, got ${ids.join(', ')}`);
  assert.ok(!ids.includes('2.3'),
    `"${name}" sits at the root, so it must NOT be counted as a sub-folder (2.3)`);
}

for (const name of ROOT_FILES) {
  const ids = permissionFeatureIds({ path: `/${name}`, type: 'file' }, INTERNAL, SOURCE_DOMAIN);
  assert.ok(ids.includes('2.2'),
    `a grant on the root file "${name}" must be evidence for 2.2, got ${ids.join(', ')}`);
  assert.ok(!ids.includes('2.4'),
    `"${name}" sits at the root, so it must NOT be counted as an inner file (2.4)`);
}

// ── The regression itself: the pre-existing seeding could only ever reach 2.3 / 2.4 ──
// Kept as an assertion rather than a comment, so that if anyone "fixes" 2.1 by moving the matrix up
// a level, the swap is caught here instead of in a report three weeks later.
assert.deepStrictEqual(
  permissionFeatureIds({ path: '/Permission Matrix/folder_reader', type: 'folder' }, INTERNAL, SOURCE_DOMAIN),
  ['2.3'],
  'the Permission Matrix folders are two levels down and must stay 2.3 evidence');
assert.deepStrictEqual(
  permissionFeatureIds({ path: '/Agent Permissions/shared_file.txt', type: 'file' }, INTERNAL, SOURCE_DOMAIN),
  ['2.4'],
  'Agent Permissions files are two levels down and must stay 2.4 evidence');

// An external grantee on a ROOT folder is evidence for 2.1 and 2.5 at once — the test-data spec's
// item 2, and the reason 2.5 has no standalone seeded scenario.
{
  const ids = permissionFeatureIds({ path: '/root_folder_reader', type: 'folder' }, EXTERNAL, SOURCE_DOMAIN);
  assert.ok(ids.includes('2.1') && ids.includes('2.5'),
    `an external grant on a root folder covers 2.1 and 2.5, got ${ids.join(', ')}`);
}

// Every feature the seeding now targets must have a check name, or the checklist cannot find its
// verdict and renders the feature N/A however much evidence was collected.
for (const id of ['2.1', '2.2', '2.3', '2.4', '2.5']) {
  assert.ok(PERM_FEATURE_CHECK_NAMES[id]?.includes(`(${id})`),
    `feature ${id} needs a check name carrying "(${id})" for the checklist lookup`);
}

// ── Cleanup must know the new root items by name ──────────────────────────────
// They sit DIRECTLY in the migrated root, so unlike the Permission Matrix rows they are matched
// individually. Left off the allowlist they survive every run and stack up as "… 1", "… 2".
for (const name of [...ROOT_FOLDERS, ...ROOT_FILES, 'root_folder_fileOrganizer']) {
  assert.strictEqual(isSeededContentName(name, SOURCE_FOLDER), true,
    `"${name}" is seeded test data and must be cleaned`);
  assert.strictEqual(isSeededContentName(`${name} 2`, SOURCE_FOLDER), true,
    `"${name} 2" is a CloudFuze duplicate of seeded data and must be cleaned`);
}

// 'Embedded Links' was seeded on every run and was never on the allowlist — the one seeded folder
// cleanup always walked past.
assert.strictEqual(isSeededContentName('Embedded Links', SOURCE_FOLDER), true,
  '"Embedded Links" is seeded by _createEmbeddedLinks and must be cleaned');
assert.ok(SEEDED_CONTENT_NAMES.includes('Embedded Links'),
  '"Embedded Links" must be on the allowlist explicitly, not matched by accident');

// Neighbours that merely start with the same words must still be spared — this predicate deletes.
for (const spared of ['root_folder', 'root_file', 'Embedded Links Archive', 'root_folder_reader_backup']) {
  assert.strictEqual(isSeededContentName(spared, SOURCE_FOLDER), false,
    `"${spared}" is not seeded by this agent and must never be deleted`);
}

// ── 8.1's control link ────────────────────────────────────────────────────────
// The seed and the check live in different files and must agree on the exact string. The validator
// imports this constant rather than spelling it again; assert it is the kind of value that cannot
// collide with a real Drive id, or the control would flag a genuine file as "rewritten".
assert.strictEqual(typeof EMBEDDED_LINK_OUT_OF_SET_ID, 'string');
assert.ok(EMBEDDED_LINK_OUT_OF_SET_ID.length > 20,
  'the control id must be long enough not to appear inside an unrelated URL by chance');
assert.ok(/QA-AGENT-NOT-IN-MIGRATION-SET/.test(EMBEDDED_LINK_OUT_OF_SET_ID),
  'the control id must say what it is, so anyone reading a failing report knows it is deliberate');

console.log('driveRootPermissions.test.js — all assertions passed');
