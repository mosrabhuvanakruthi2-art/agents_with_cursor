/**
 * Run: npm test  (from backend/)
 *
 * The scope document service: which files name a combination, and which keys are allowed to become
 * a file path.
 *
 * Both halves are regression guards for defects found in this file, not hypotheticals:
 *
 *   1. `listCombinations()` stripped only `-inscope.md` / `-outscope.md`. A third document type
 *      (`dropbox-to-google-testdata.md`) fell through the replace() unchanged and was served from
 *      GET /api/scope as a combination of its own — extension included — whose every fetch 404d.
 *
 *   2. The combination key came off the URL and was concatenated into a path with no containment.
 *      `PUT /api/scope/..%2F..%2F..%2F..%2Fpwned/inscope` — on an UNAUTHENTICATED router — wrote a
 *      caller-supplied file outside the data directory. Confirmed resolving onto the Desktop.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const scopeService = require('../src/services/scopeService');

const SCOPE_DIR = path.resolve(__dirname, '..', 'data', 'feature-scope');

/** Only a recognised suffix names a combination — anything else is a note, not a key. */
function testListCombinations() {
  const keys = scopeService.listCombinations();

  assert.ok(keys.includes('dropbox-to-google'), 'the Dropbox pair is listed once');
  for (const key of keys) {
    assert.ok(!key.endsWith('.md'),
      `a key must never carry a file extension — got "${key}"`);
    for (const type of scopeService.SCOPE_TYPES) {
      assert.ok(!key.endsWith(`-${type}`),
        `a key must never carry a document-type suffix — got "${key}"`);
    }
  }

  // Every scope file on disk must be accounted for by exactly one key, or a document exists that
  // no caller can reach.
  const onDisk = fs.readdirSync(SCOPE_DIR).filter((f) => f.endsWith('.md'));
  for (const f of onDisk) {
    const matched = scopeService.SCOPE_TYPES.some((t) => f.endsWith(`-${t}.md`));
    if (!matched) continue; // an unsuffixed note is deliberately not a combination
    const key = f.replace(/-[a-z]+\.md$/, '');
    assert.ok(keys.includes(key), `${f} is on disk but ${key} is not listed`);
  }

  assert.deepStrictEqual(keys, [...keys].sort(), 'keys come back in a stable order');
  console.log('  only -inscope/-outscope/-testdata files name a combination: ok');
}

/** testdata is a first-class type: the seeding spec has to be readable, not just present on disk. */
function testTestdataType() {
  assert.ok(scopeService.SCOPE_TYPES.includes('testdata'),
    'testdata is a recognised document type');
  assert.ok(scopeService.getScope('dropbox-to-google', 'testdata'),
    'the Dropbox seeding specification is readable through the service');
  assert.strictEqual(scopeService.getScope('dropbox-to-google', 'notatype'), null,
    'an unrecognised type reads as absent, never as a path to try');
  console.log('  testdata readable as a document type: ok');
}

/**
 * Path traversal. An allow-list, so encodings do not need enumerating — but the encodings that
 * actually reached the filesystem are asserted anyway.
 */
function testTraversalRejected() {
  const evil = [
    '../../../../pwned',
    '..\..\..\pwned',
    '/etc/passwd',
    'c:/windows/system32/x',
    'ok/../../nope',
    'trailing-',
    '-leading',
    'double--hyphen',
    '',
  ];

  for (const key of evil) {
    assert.strictEqual(scopeService.isValidCombination(key), false,
      `"${key}" must be rejected as a combination key`);
    assert.strictEqual(scopeService.getScope(key, 'inscope'), null,
      `"${key}" must not resolve to a readable file`);
    assert.throws(() => scopeService.saveScope(key, 'inscope', 'x'),
      `"${key}" must not be writable`);
  }

  // And the write really did not happen — a throw that still touched the disk would be worse than
  // no check at all.
  assert.ok(!fs.existsSync(path.resolve(SCOPE_DIR, '..', '..', '..', '..', 'pwned-inscope.md')),
    'no file was written outside the data directory');

  assert.strictEqual(scopeService.isValidCombination('dropbox-to-google'), true,
    'a real key still passes');
  assert.strictEqual(scopeService.isValidCombination('GmailToOutlook'), true,
    'and so does the camelCase spelling the service normalizes');
  assert.strictEqual(scopeService.isValidCombination('has space'), true,
    'a space is not traversal — normalizeKey folds it to a hyphen, which predates this guard');
  console.log('  traversal keys rejected for both read and write: ok');
}

testListCombinations();
testTestdataType();
testTraversalRejected();
console.log('scopeService.test.js: ok');
