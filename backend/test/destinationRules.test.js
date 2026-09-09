/**
 * Run: npm test  (from backend/)
 *
 * Destination name and path rules, and the guarantee that extracting them changed nothing.
 *
 * These rules used to be hard-coded inside validation/shared/deepContentCore.js — SharePoint's
 * forbidden characters, reserved names and 400-character path limit applied to EVERY combination,
 * including ones migrating into Google where none of them exist. Supporting a new destination meant
 * editing an 1100-line file that all five live combinations depend on, so two people adding two
 * destinations collided on it.
 *
 * Two things are asserted, and the second is the one that protects the live runs:
 *   1. A destination can select its own rules, and they genuinely differ.
 *   2. A caller that names NO destination behaves exactly as SharePoint did before. That default is
 *      what makes the extraction safe: every existing validator passes no destination.
 */
const assert = require('assert');
const destinations = require('../src/validation/destinations');
const core = require('../src/validation/shared/deepContentCore');

/** Provider strings resolve to the right rules, including CloudFuze's own cloud names. */
function testResolution() {
  const cases = [
    ['sharepoint', 'sharepoint'],
    ['SHAREPOINT_ONLINE_BUSINESS', 'sharepoint'],
    ['onedrive', 'sharepoint'],            // same engine, same limits
    ['googledrive', 'googledrive'],
    ['googleshareddrive', 'googledrive'],  // same storage, different ownership model
    // Longest-match matters here: "GOOGLE_SHARED_DRIVES" contains both "googledrive" and
    // "googleshareddrive", and picking the shorter one would silently apply the wrong rules.
    ['GOOGLE_SHARED_DRIVES', 'googledrive'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(destinations.rulesFor(input).destination, expected,
      `${input} resolves to ${expected}`);
  }

  // Anything unregistered falls back to SharePoint rather than throwing, so an unknown provider
  // degrades to today's behaviour instead of failing the run.
  assert.strictEqual(destinations.rulesFor('dropbox').destination, 'sharepoint',
    'an unregistered destination falls back to SharePoint');
  assert.strictEqual(destinations.rulesFor('').destination, 'sharepoint',
    'an empty provider falls back to SharePoint');
  assert.strictEqual(destinations.forDestination('dropbox'), null,
    'forDestination reports honestly that it is not registered');
  console.log('  destination resolution, aliases and fallback: ok');
}

/** The rules genuinely differ — otherwise the whole split buys nothing. */
function testRulesActuallyDiffer() {
  const sp = destinations.rulesFor('sharepoint');
  const gd = destinations.rulesFor('googleshareddrive');

  assert.strictEqual(sp.sanitizeName('bad*chars?.txt', '_'), 'bad_chars_.txt',
    'SharePoint replaces the characters it rejects');
  assert.strictEqual(gd.sanitizeName('bad*chars?.txt', '_'), 'bad*chars?.txt',
    'Google stores the name as given — nothing is replaced');

  assert.strictEqual(sp.isReservedName('CON'), true, 'CON is reserved on SharePoint');
  assert.strictEqual(gd.isReservedName('CON'), false, 'CON is an ordinary name on Google');

  assert.strictEqual(sp.pathLengthLimit, 400);
  assert.strictEqual(gd.pathLengthLimit, Infinity, 'Google has no total-path limit');
  assert.strictEqual(sp.usesPlaceholderLinksOverPathLimit, true);
  assert.strictEqual(gd.usesPlaceholderLinksOverPathLimit, false,
    'nothing is relocated on Google, so a placeholder is never the expected outcome');
  console.log('  SharePoint and Google rules differ where they should: ok');
}

/**
 * The consequence that matters: the SAME over-limit item is a documented placeholder on SharePoint
 * and a genuine absence on Google. A validator that applied SharePoint's limit to a Google
 * destination would excuse missing data as expected behaviour.
 */
function testSameItemJudgedByDestination() {
  const deep = `/${'X'.repeat(200)}/${'Y'.repeat(200)}/f.txt`;
  const source = [{ path: deep, name: 'f.txt', type: 'file' }];

  const onSp = core.compareTrees(source, [], {
    destPrefix: '', rules: destinations.rulesFor('sharepoint'),
  });
  assert.strictEqual((onSp.placeholderLinks || []).length, 1,
    'over the 400-character limit SharePoint substitutes a placeholder link');
  assert.strictEqual(onSp.missing.length, 0, 'and it is therefore not missing');

  const onGd = core.compareTrees(source, [], {
    destPrefix: '', rules: destinations.rulesFor('googleshareddrive'),
  });
  assert.strictEqual((onGd.placeholderLinks || []).length, 0,
    'Google has no limit, so it never produces a placeholder');
  assert.strictEqual(onGd.missing.length, 1,
    'the item is simply absent, and that is a real failure');
  console.log('  the same item is judged by its destination, not by SharePoint: ok');
}

/**
 * The safety guarantee. Every existing validator calls these without naming a destination, so the
 * default must reproduce the old hard-coded behaviour exactly — otherwise the extraction silently
 * changed five live combinations.
 */
function testDefaultIsUnchanged() {
  assert.strictEqual(core.expectedDestName('bad*chars?.txt', null), 'bad_chars_.txt',
    'no destination named still means SharePoint sanitising');
  assert.strictEqual(core.PATH_LENGTH_LIMIT, 400, 'the exported limit is unchanged');
  assert.strictEqual(core.SEGMENT_LENGTH_LIMIT, 255, 'the exported segment limit is unchanged');
  assert.strictEqual(core.isReservedName('CON'), true, 'reserved-name checking is unchanged');
  assert.strictEqual(core.sanitizeForSharePoint('a<b>c.txt', '-'), 'a-b-c.txt',
    'the legacy helper name still works and still behaves the same');

  // The real special-character case from run 6a8d53d2, which one wrong character class broke before.
  assert.strictEqual(
    core.expectedDestName('Special !@#$%^&*()-_+=[] Folder', null, '-'),
    'Special !@#$%^&-()-_+=[] Folder',
    '# % & are preserved and only * is replaced — the observed destination name');

  // Google-native conversion is a SOURCE concern and must be unaffected by the destination split.
  assert.strictEqual(
    core.expectedDestName('QA Test Document', 'application/vnd.google-apps.document'),
    'QA Test Document.docx',
    'Google-native export naming is unchanged');
  console.log('  default behaviour identical to the hard-coded rules: ok');
}

testResolution();
testRulesActuallyDiffer();
testSameItemJudgedByDestination();
testDefaultIsUnchanged();
console.log('destinationRules.test.js: ok');
