/**
 * Run: npm test  (from backend/)
 *
 * deepContentCore.comparePermissions must compare with the role vocabulary its CALLER chose.
 *
 * The bug. That function hardcoded the module-level `contentRoleMap` — the Box/Drive to SharePoint
 * tables, which know 'writer' and 'reader'. Dropbox's only two collaborator roles are 'editor' and
 * 'viewer', and contentRoleMap reports BOTH as not-comparable:
 *
 *     contentRoleMap.isComparableDriveRole('editor') === false
 *     contentRoleMap.isComparableDriveRole('viewer') === false
 *
 * So every Dropbox grant was skipped, `checked` stayed 0, and execution eb9b26d5 reported
 * "No comparable source permissions were found" for features 2.1–2.5 against a source that
 * demonstrably carried ben@filefuze.co as editor on 01-Root-Folder-Permissions (verified against
 * the live API: 3 members returned).
 *
 * The Dropbox validator already selects validation/roleMaps/dropbox_to_google and refuses to fall
 * back to the SharePoint map — this shared function was discarding that choice underneath it.
 *
 * deepContentCore is imported by EVERY content combination, so the default-unchanged assertions
 * below matter more than the feature one.
 */
const assert = require('assert');
const core = require('../src/validation/shared/deepContentCore');
const contentRoleMap = require('../src/validation/contentRoleMap');
const roleMaps = require('../src/validation/roleMaps');

// Destination permissions arrive from GoogleDriveValidationAgent.readPermissions in this shape:
//   { email, displayName, roles: [role], principalType }
// roles is an ARRAY. A fixture using a bare `role` yields destRoles: [] and the comparison
// looks broken when it is not.
const identity = (e) => String(e || '').toLowerCase();
const dropboxMap = roleMaps.forCombination('dropbox_to_googleshareddrive');

/** The premise: the two maps genuinely disagree about Dropbox's roles. */
function testTheMapsDisagree() {
  assert.strictEqual(contentRoleMap.isComparableDriveRole('editor'), false,
    "contentRoleMap does not recognise Dropbox 'editor' — this is why the default was wrong");
  assert.strictEqual(contentRoleMap.isComparableDriveRole('viewer'), false,
    "nor 'viewer'");
  assert.strictEqual(dropboxMap.isComparableDriveRole('editor'), true,
    'the Dropbox map does');
  assert.strictEqual(dropboxMap.isComparableDriveRole('viewer'), true);
  console.log('  the two role maps genuinely disagree on editor/viewer: ok');
}

/** Without the override, a Dropbox grant is skipped — the bug, pinned so it cannot come back. */
function testDefaultSkipsDropboxRoles() {
  const src = [{ email: 'ben@filefuze.co', role: 'editor', type: 'user' }];
  const dest = [{ email: 'ben@filefuze.co', roles: ['writer'], principalType: 'user' }];

  const withDefault = core.comparePermissions(src, dest, identity);
  assert.strictEqual(withDefault.checked, 0,
    'with the default map a Dropbox editor grant is not compared at all');
  console.log('  default map skips Dropbox roles (bug reproduced): ok');
}

/** With the Dropbox map passed through, the same grant is actually compared. */
function testOverrideComparesDropboxRoles() {
  const src = [{ email: 'ben@filefuze.co', role: 'editor', type: 'user' }];
  const dest = [{ email: 'ben@filefuze.co', roles: ['writer'], principalType: 'user' }];

  const withOverride = core.comparePermissions(src, dest, identity, { roleMap: dropboxMap });
  assert.strictEqual(withOverride.checked, 1, 'the grant is compared');
  assert.strictEqual(withOverride.mismatches.length, 0,
    "Dropbox 'editor' equals Google 'writer', so it matches");
  assert.strictEqual(withOverride.matches.length, 1);
  console.log('  override compares editor -> writer as a match: ok');
}

/** A genuine downgrade must still fail — the override must not make everything pass. */
function testOverrideStillCatchesMismatch() {
  const src = [{ email: 'ben@filefuze.co', role: 'editor', type: 'user' }];
  const dest = [{ email: 'ben@filefuze.co', roles: ['reader'], principalType: 'user' }];

  const cmp = core.comparePermissions(src, dest, identity, { roleMap: dropboxMap });
  assert.strictEqual(cmp.checked, 1, 'still compared');
  assert.strictEqual(cmp.mismatches.length, 1,
    'an editor arriving as reader is reported, not passed');
  console.log('  a real downgrade is still reported: ok');
}

/**
 * Blast radius. Every existing content combination calls this with no opts, so the default path
 * must behave exactly as before for the SharePoint role vocabulary.
 */
function testExistingCombinationsUnchanged() {
  const src = [{ email: 'mia@filefuze.co', role: 'writer', type: 'user' }];
  const dest = [{ email: 'mia@gajha.com', roles: ['write'], principalType: 'user' }];
  const map = (e) => (String(e).toLowerCase() === 'mia@filefuze.co' ? 'mia@gajha.com' : e);

  const noOpts = core.comparePermissions(src, dest, map);
  const explicitDefault = core.comparePermissions(src, dest, map, { roleMap: contentRoleMap });

  assert.strictEqual(noOpts.checked, 1, 'a Drive writer grant is still compared by default');
  assert.deepStrictEqual(
    { checked: noOpts.checked, m: noOpts.matches.length, x: noOpts.mismatches.length },
    { checked: explicitDefault.checked, m: explicitDefault.matches.length, x: explicitDefault.mismatches.length },
    'omitting opts is identical to passing contentRoleMap explicitly'
  );

  // And a non-comparable source role still reports its reason rather than silently vanishing.
  //
  // 'owner', not 'organizer'. contentRoleMap treats organizer as comparable — the SharePoint
  // report compares it and prints "Source \"organizer\" → SP no access". Only owner is excluded.
  const owner = core.comparePermissions(
    [{ email: 'erik@filefuze.co', role: 'owner', type: 'user' }], [], map);
  assert.strictEqual(owner.checked, 0, 'owner is still not comparable by default');
  assert.ok((owner.notComparable || []).length >= 1,
    'and is recorded as not-comparable with a reason, not dropped');
  console.log('  Box/Drive to SharePoint behaviour unchanged by default: ok');
}

/** The Dropbox validator must actually pass the map through. */
function testValidatorPassesTheMap() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'validation', 'combinations',
    'content', 'dropboxToGoogledrive.js'), 'utf8');

  assert.ok(/core\.comparePermissions\([\s\S]{0,160}\{\s*roleMap\s*\}/.test(src),
    'the Dropbox validator passes { roleMap } to comparePermissions');
  console.log('  Dropbox validator passes its own role map: ok');
}

testTheMapsDisagree();
testDefaultSkipsDropboxRoles();
testOverrideComparesDropboxRoles();
testOverrideStillCatchesMismatch();
testExistingCombinationsUnchanged();
testValidatorPassesTheMap();
console.log('comparePermissionsRoleMap.test.js: ok');
