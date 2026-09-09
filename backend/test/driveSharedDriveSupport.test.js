'use strict';

/**
 * Every Drive write that can touch a Shared Drive must pass supportsAllDrives.
 *
 * Without it the Drive API cannot resolve a Shared Drive parent or file and answers
 * "File not found: <id>" — a confusing error that looks like missing data rather than a missing flag.
 * Two calls shipped without it and broke seeding silently:
 *
 *   createNativeFile  -> all three Google native files (Doc/Sheet/Slide) failed to seed
 *   uploadVersion     -> every versioned_doc_*.txt failed to get versions 2-5
 *
 * Between them that parked ~27 content validation checks at NA for as long as the omission existed,
 * and the run log blamed "File not found: <parentId>" rather than naming the cause.
 *
 * This is a static check over the client source: it needs no credentials, so it runs in the normal
 * test chain rather than only against a live Shared Drive.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'clients', 'driveClient.js');
const source = fs.readFileSync(SRC, 'utf8');

// Locate every files.create / files.update / files.delete call and check the following lines — up to
// the closing of that call — mention shared-drive support in one of its two accepted spellings.
const CALL_RE = /drive\.files\.(create|update|delete)\s*\(/g;
const ACCEPTED = /supportsAllDrives|\.\.\.ALL_DRIVES/;

const offenders = [];
let m;
while ((m = CALL_RE.exec(source)) !== null) {
  const line = source.slice(0, m.index).split('\n').length;
  // Take a generous window: the longest of these calls spans ~14 lines.
  const window = source.slice(m.index, m.index + 900);
  // Cut the window at the end of this call's argument object so a later call cannot vouch for it.
  const end = window.indexOf('});');
  const scoped = end === -1 ? window : window.slice(0, end);
  if (!ACCEPTED.test(scoped)) {
    offenders.push(`driveClient.js:${line}  files.${m[1]}()`);
  }
}

assert.deepStrictEqual(
  offenders, [],
  'These Drive writes are missing supportsAllDrives (or ...ALL_DRIVES) and will fail against a '
  + `Shared Drive with "File not found":\n  ${offenders.join('\n  ')}`
);

// The constant itself must keep both properties — listing needs includeItemsFromAllDrives too.
{
  const decl = /const ALL_DRIVES = \{([^}]*)\}/.exec(source);
  assert.ok(decl, 'ALL_DRIVES constant should still exist in driveClient.js');
  assert.ok(/supportsAllDrives:\s*true/.test(decl[1]), 'ALL_DRIVES must set supportsAllDrives: true');
  assert.ok(/includeItemsFromAllDrives:\s*true/.test(decl[1]),
    'ALL_DRIVES must set includeItemsFromAllDrives: true or listings miss Shared Drive items');
}

// Guard the two specific functions by name, so a rewrite that drops the flag is caught even if the
// regex above is loosened later.
for (const fn of ['createNativeFile', 'uploadVersion']) {
  const start = source.indexOf(`async function ${fn}(`);
  assert.notStrictEqual(start, -1, `${fn} should exist in driveClient.js`);
  const body = source.slice(start, start + 1200);
  assert.ok(ACCEPTED.test(body),
    `${fn} must pass supportsAllDrives — it seeds into a Shared Drive and silently failed without it`);
}

console.log('driveSharedDriveSupport.test.js: ok');
