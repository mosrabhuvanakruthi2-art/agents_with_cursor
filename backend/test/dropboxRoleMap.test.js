/**
 * Run: npm test  (from backend/)
 *
 * Dropbox → Google role and link translation, asserted against the combination's scope document
 * (`data/feature-scope/dropbox-to-google-inscope.md`, sections 2 and 3).
 *
 * Every expectation here traces to a line in that document rather than to a guess. That matters: on
 * the Google Shared Drive combination, two guessed rules produced a false failure on 92 ordinary
 * notification emails and a pass reading "handled as documented" printed directly above a FAIL for
 * the same thing.
 *
 * The map is registered by directory scan, so this also proves a new pair is an ADDED FILE — no edit
 * to contentRoleMap.js, which every live combination imports.
 */
const assert = require('assert');
const roleMaps = require('../src/validation/roleMaps');

const map = roleMaps.forCombination('dropbox_to_googleshareddrive');

/** One map serves both destinations, because the scope document covers them together. */
function testRegistration() {
  assert.ok(map, 'the Dropbox pair is registered for Shared Drive');
  assert.ok(roleMaps.forCombination('dropbox_to_googledrive'), 'and for My Drive');
  assert.strictEqual(roleMaps.forCombination('dropbox_to_googledrive'), map,
    'both resolve to the same map — one scope document covers the pair');

  // No fallback, deliberately: a combination with no registered pair must keep its own map rather
  // than silently receive the wrong translation.
  assert.strictEqual(roleMaps.forCombination('box_to_sharepoint'), null,
    'an uncovered combination resolves to null, never to a default');
  assert.deepStrictEqual(roleMaps.pairs(), ['dropbox_to_google']);
  console.log('  pair registered by directory scan, no fallback: ok');
}

/**
 * Scope §2: Dropbox exposes two collaborator levels. `Can edit` → Editor, `Can view` → Viewer.
 * Both the API spellings and the UI labels have to resolve, since figures and payloads differ.
 */
function testRoleTranslation() {
  for (const role of ['Can edit', 'editor', 'write']) {
    assert.strictEqual(map.compareDriveAccess(role, ['writer']).expectedSpLabel, 'Editor',
      `${role} is expected to become Editor`);
    assert.strictEqual(map.compareDriveAccess(role, ['writer']).match, true,
      `${role} arriving as writer matches`);
  }
  for (const role of ['Can view', 'viewer', 'read']) {
    assert.strictEqual(map.compareDriveAccess(role, ['reader']).expectedSpLabel, 'Viewer',
      `${role} is expected to become Viewer`);
    assert.strictEqual(map.compareDriveAccess(role, ['reader']).match, true,
      `${role} arriving as reader matches`);
  }
  console.log('  Can edit -> Editor, Can view -> Viewer: ok');
}

/**
 * Dropbox has NO commenter. So a source Viewer arriving as Google Commenter is the same access level
 * and matches, but Commenter must never be the EXPECTED label — otherwise a downgrade from Editor
 * would be accepted.
 */
function testNoDropboxCommenter() {
  const asCommenter = map.compareDriveAccess('Can view', ['commenter']);
  assert.strictEqual(asCommenter.match, true,
    'Commenter is the same access level as Viewer, so it satisfies a view grant');
  assert.notStrictEqual(map.compareDriveAccess('Can edit', ['commenter']).match, true,
    'but Commenter must NOT satisfy an edit grant');
  assert.strictEqual(map.compareDriveAccess('Can edit', ['commenter']).underGranted, true,
    'an Editor arriving as Commenter is under-granted');
  console.log('  no Dropbox commenter: Editor never satisfied by Commenter: ok');
}

/** Escalation is a finding, never a pass. "They can do more than before" is not success. */
function testEscalationIsCaught() {
  const esc = map.compareDriveAccess('Can view', ['writer']);
  assert.strictEqual(esc.match, false, 'a Viewer arriving as Editor does not match');
  assert.strictEqual(esc.overGranted, true, 'and is reported as over-granted');

  const ok = map.compareDriveAccess('Can edit', ['writer']);
  assert.strictEqual(ok.overGranted, false, 'equal access is not an escalation');
  console.log('  privilege escalation reported, not accepted: ok');
}

/**
 * The destination account owns every migrated copy, so the source owner's ownership is not re-granted.
 * Comparing it as an ordinary grant failed every run on its own owner permission on the Google
 * combination, which is why it is excluded here from the start.
 */
function testOwnerNotComparable() {
  assert.strictEqual(map.isComparableDriveRole('owner'), false, 'owner is not a comparable grant');
  assert.strictEqual(map.isComparableDriveRole('Can edit'), true);
  assert.ok(/not re-granted/.test(map.nonComparableReason('owner')),
    'and the report says why, rather than showing a bare mismatch');
  console.log('  source owner excluded from comparison, with a reason: ok');
}

/**
 * Scope §3: "Anyone with the link" → anonymous, "Team members" → organization.
 *
 * The organization scope shows in Google as the tenant's own name — "Sync Orbit" in the document's
 * figures. Matching must be on the SCOPE: a check keyed to that string would fail in every other
 * account.
 */
function testLinkScopes() {
  for (const audience of ['Anyone with the link', 'anyone', 'public']) {
    assert.strictEqual(map.expectedLinkScope(audience), 'anonymous', `${audience} is anonymous`);
  }
  for (const audience of ['Team members', 'team', 'team_only', 'members']) {
    assert.strictEqual(map.expectedLinkScope(audience), 'organization', `${audience} is organization`);
  }
  assert.strictEqual(map.expectedLinkScope('something else'), null,
    'an unrecognised audience is null, not guessed');

  // Nothing anywhere may key on the tenant's display name.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'validation', 'roleMaps', 'dropbox_to_google.js'),
    'utf8');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/Sync Orbit/.test(codeOnly),
    'the organisation display name appears only in comments, never in matching logic');
  console.log('  link scopes by audience, never by tenant name: ok');
}

/** Both axes of a link are asserted — who it reaches AND what they can do. */
function testLinkComparison() {
  const viewLink = { type: 'Anyone with the link', role: 'Can view' };
  assert.strictEqual(
    map.compareSharedLink(viewLink, [{ scope: 'anonymous', type: 'view' }]).match, true,
    'a viewing link arriving as anonymous/view matches');

  // Scope right, access wrong: must fail, or a viewing link that became editable would pass.
  const wrongType = map.compareSharedLink(viewLink, [{ scope: 'anonymous', type: 'edit' }]);
  assert.strictEqual(wrongType.scopeMatch, true, 'the scope is right');
  assert.strictEqual(wrongType.typeMatch, false, 'but the access level is not');
  assert.strictEqual(wrongType.match, false, 'so it does not match');

  // Access right, scope wrong: a team link that became public is a real exposure.
  const teamLink = { type: 'Team members', role: 'Can view' };
  const wrongScope = map.compareSharedLink(teamLink, [{ scope: 'anonymous', type: 'view' }]);
  assert.strictEqual(wrongScope.match, false,
    'a team-only link arriving as anyone-with-the-link does not match');
  assert.strictEqual(
    map.compareSharedLink(teamLink, [{ scope: 'organization', type: 'view' }]).match, true,
    'and matches when it arrives as organization scope');
  console.log('  link scope AND access level both asserted: ok');
}

testRegistration();
testRoleTranslation();
testNoDropboxCommenter();
testEscalationIsCaught();
testOwnerNotComparable();
testLinkScopes();
testLinkComparison();
console.log('dropboxRoleMap.test.js: ok');
