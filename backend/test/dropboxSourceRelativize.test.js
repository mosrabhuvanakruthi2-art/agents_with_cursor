/**
 * Run: npm test  (from backend/)
 *
 * The Dropbox source tree must be relativized against the root's DISPLAY path.
 *
 * Dropbox resolves paths case-insensitively but returns `path_display` in tree entries. The seeding
 * agent deliberately reports the lower-cased root ("/qa-automation"), so the tree comes back at
 * "/QA-Automation/…". `core.relativize` strips a case-SENSITIVE prefix, so it stripped nothing:
 * every source path kept its "/QA-Automation" prefix while the destination tree was relative to the
 * migrated root. Execution eb9b26d5 then reported
 *
 *     source 67, dest 68, matched 0, missing 0, extra 1, misplaced 67
 *
 * on a migration where all 67 items had arrived. Everything keyed on item paths went with it —
 * permissions reported "no comparable source permissions" against grants that were demonstrably
 * present on 01-Root-Folder-Permissions and 02-root-file-viewer.txt, and the long-path check
 * reported "0 encoded chars" for a 1,172-character path.
 *
 * Two things are asserted: that core.relativize really is case-sensitive (so the trap is documented
 * where someone will find it), and that the Dropbox validator no longer depends on the case it was
 * handed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../src/validation/shared/deepContentCore');

/**
 * The trap itself. This is asserted rather than fixed: core.relativize is shared by every content
 * combination, and making it case-insensitive would silently change Box→SharePoint and
 * Drive→SharePoint comparisons too. Dropbox is the only source whose reported case can differ from
 * its tree, so the fix belongs in that combination.
 */
function testRelativizeIsCaseSensitive() {
  const tree = [
    { path: '/QA-Automation/01-Root-Folder-Permissions', name: '01-Root-Folder-Permissions', type: 'folder' },
    { path: '/QA-Automation/02-root-file-viewer.txt', name: '02-root-file-viewer.txt', type: 'file' },
  ];

  const wrongCase = core.relativize(tree, '/qa-automation');
  assert.ok(
    wrongCase.every((i) => i.path.startsWith('/QA-Automation/')),
    'relativize is case-sensitive: a lower-cased root strips nothing — this is the bug, documented'
  );

  const rightCase = core.relativize(tree, '/QA-Automation');
  assert.deepStrictEqual(
    rightCase.map((i) => i.path).sort(),
    ['/01-Root-Folder-Permissions', '/02-root-file-viewer.txt'],
    'the display-cased root strips correctly'
  );
  console.log('  core.relativize is case-sensitive (trap documented): ok');
}

/** The validator must resolve the display path and relativize against that. */
function testValidatorUsesDisplayPath() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'validation', 'combinations', 'content',
      'dropboxToGoogledrive.js'), 'utf8');

  const start = src.indexOf('sourceTree = await dropboxClient.buildFolderTree(');
  assert.ok(start > -1, 'the source tree build was found');
  // Bounded by the next check rather than a byte count: a fixed window silently stopped covering
  // the relativize call as soon as lines were added between the two, and this test then failed for
  // the wrong reason.
  const end = src.indexOf('if (sourceTree.length === 0)', start);
  assert.ok(end > start, 'the region end marker was found');
  const region = src.slice(start, end);

  assert.ok(/getMetadata\(sourcePath, dbxOpts\)/.test(region),
    'the root display path is resolved through Dropbox');
  assert.ok(/const rootPath = \(rootMeta && rootMeta\.path\) \|\| sourcePath;/.test(region),
    'and falls back to the requested path when metadata is unavailable');
  assert.ok(/core\.relativize\(sourceTree, rootPath\)/.test(region),
    'relativize uses the display path, not the requested one');
  assert.ok(!/core\.relativize\(sourceTree, sourcePath\)/.test(region),
    'and never the requested path — that is what produced "misplaced 67"');
  console.log('  validator relativizes against the display path: ok');
}

/**
 * The fallback must be safe: an unresolvable root leaves behaviour exactly as before rather than
 * throwing, because a tree that was read successfully is still worth comparing.
 */
function testFallbackIsSafe() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'validation', 'combinations', 'content',
      'dropboxToGoogledrive.js'), 'utf8');
  const idx = src.indexOf('const rootMeta = await dropboxClient.getMetadata(');
  assert.ok(idx > -1, 'the metadata call was found');
  assert.ok(/\.catch\(\(\) => null\)/.test(src.slice(idx, idx + 220)),
    'a failed metadata lookup degrades to null rather than aborting the whole validation');
  console.log('  unresolvable root degrades safely: ok');
}

testRelativizeIsCaseSensitive();
testValidatorUsesDisplayPath();
testFallbackIsSafe();
console.log('dropboxSourceRelativize.test.js: ok');
