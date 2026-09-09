/**
 * Run: npm test  (from backend/)
 *
 * The 21 permission and shared-link features of Google Shared Drive → SharePoint, feature by feature.
 * Reference: backend/data/feature-scope/google-shared-drive-to-sharepoint-inscope.md §4 and §5
 *
 * Drive API role names differ from the Shared Drive UI labels the feature doc uses:
 *   reader = Viewer, commenter = Commenter, writer = Contributor/Editor, fileOrganizer = Content Manager
 */
const assert = require('assert');
const roleMap = require('../src/validation/contentRoleMap');

// SharePoint roles as Graph reports them.
const SP_READ = ['read'];
const SP_WRITE = ['write'];
const SP_NONE = [];

/** Features 4.2 – 4.8: source role → the destination access the doc requires. */
const PERMISSION_FEATURES = [
  { id: '4.2', item: 'folder', uiLabel: 'Viewer', role: 'reader', expect: 'Read' },
  { id: '4.3', item: 'folder', uiLabel: 'Commenter', role: 'commenter', expect: 'Read' },
  { id: '4.4', item: 'folder', uiLabel: 'Contributor', role: 'writer', expect: 'Edit' },
  { id: '4.5', item: 'folder', uiLabel: 'Content Manager', role: 'fileOrganizer', expect: 'Edit' },
  { id: '4.6', item: 'file', uiLabel: 'Viewer', role: 'reader', expect: 'Read' },
  { id: '4.7', item: 'file', uiLabel: 'Commenter', role: 'commenter', expect: 'Read' },
  { id: '4.8', item: 'file', uiLabel: 'Editor', role: 'writer', expect: 'Edit' },
];

/** Features 5.2 – 5.15: source link (scope + role) → the Graph link it must become. */
const LINK_FEATURES = [
  { id: '5.2', item: 'folder', type: 'anyone', role: 'reader', scope: 'anonymous', linkType: 'view' },
  { id: '5.3', item: 'folder', type: 'anyone', role: 'commenter', scope: 'anonymous', linkType: 'view' },
  { id: '5.4', item: 'folder', type: 'anyone', role: 'writer', scope: 'anonymous', linkType: 'edit' },
  { id: '5.5', item: 'folder', type: 'anyone', role: 'fileOrganizer', scope: 'anonymous', linkType: 'edit' },
  { id: '5.6', item: 'folder', type: 'domain', role: 'reader', scope: 'organization', linkType: 'view' },
  { id: '5.7', item: 'folder', type: 'domain', role: 'commenter', scope: 'organization', linkType: 'view' },
  { id: '5.8', item: 'folder', type: 'domain', role: 'writer', scope: 'organization', linkType: 'edit' },
  { id: '5.9', item: 'folder', type: 'domain', role: 'fileOrganizer', scope: 'organization', linkType: 'edit' },
  { id: '5.10', item: 'file', type: 'anyone', role: 'reader', scope: 'anonymous', linkType: 'view' },
  { id: '5.11', item: 'file', type: 'anyone', role: 'commenter', scope: 'anonymous', linkType: 'view' },
  { id: '5.12', item: 'file', type: 'anyone', role: 'writer', scope: 'anonymous', linkType: 'edit' },
  { id: '5.13', item: 'file', type: 'domain', role: 'reader', scope: 'organization', linkType: 'view' },
  { id: '5.14', item: 'file', type: 'domain', role: 'commenter', scope: 'organization', linkType: 'view' },
  { id: '5.15', item: 'file', type: 'domain', role: 'writer', scope: 'organization', linkType: 'edit' },
];

function testPermissionFeatures() {
  for (const f of PERMISSION_FEATURES) {
    const label = `feature ${f.id} (${f.item} ${f.uiLabel} → ${f.expect})`;

    // The documented SharePoint label
    assert.strictEqual(roleMap.expectedSpLabelForDrive(f.role), f.expect, `${label}: expected label`);

    // A correct migration passes
    const correct = roleMap.compareDriveAccess(f.role, f.expect === 'Edit' ? SP_WRITE : SP_READ);
    assert.strictEqual(correct.match, true, `${label}: correct mapping must pass`);
    assert.strictEqual(correct.exact, true, `${label}: correct mapping is an exact level match`);
    assert.strictEqual(correct.overGranted, false, `${label}: correct mapping is not an escalation`);

    // No access at all fails
    assert.strictEqual(
      roleMap.compareDriveAccess(f.role, SP_NONE).match, false, `${label}: no access must fail`
    );
  }

  // A Contributor arriving with view-only access is a downgrade and must FAIL
  assert.strictEqual(roleMap.compareDriveAccess('writer', SP_READ).match, false,
    'Contributor downgraded to view-only must fail');
  assert.strictEqual(roleMap.compareDriveAccess('fileOrganizer', SP_READ).match, false,
    'Content Manager downgraded to view-only must fail');

  // A Commenter arriving with edit access is a privilege escalation and must be surfaced.
  // `match` stays true (at-least semantics, as the Box comparator has always used) but the caller can
  // see it — a silently escalated permission is a real defect, not a pass.
  const escalated = roleMap.compareDriveAccess('commenter', SP_WRITE);
  assert.strictEqual(escalated.overGranted, true, 'Commenter granted edit is flagged as over-granted');
  assert.strictEqual(escalated.exact, false);

  // Shared drives have no owner role
  assert.strictEqual(roleMap.driveRoleLevel('owner'), 'NONE', 'owner does not exist in shared drives');
  // Case-insensitive: the API returns camelCase
  assert.strictEqual(roleMap.driveRoleLevel('fileOrganizer'), roleMap.driveRoleLevel('fileorganizer'));
  assert.strictEqual(roleMap.driveRoleLevel('nonsense'), 'NONE');
}

function testLinkFeatures() {
  for (const f of LINK_FEATURES) {
    const label = `feature ${f.id} (${f.item} ${f.type}/${f.role} → ${f.scope} can ${f.linkType})`;

    assert.strictEqual(roleMap.expectedLinkScope(f.type), f.scope, `${label}: expected scope`);
    assert.strictEqual(roleMap.expectedLinkType(f.role), f.linkType, `${label}: expected type`);

    // A correctly migrated link passes
    const ok = roleMap.compareSharedLink(
      { type: f.type, role: f.role },
      [{ scope: f.scope, type: f.linkType }]
    );
    assert.strictEqual(ok.match, true, `${label}: correct link must pass`);
    assert.strictEqual(ok.scopeMatch, true, `${label}: scope matches`);
    assert.strictEqual(ok.typeMatch, true, `${label}: type matches`);

    // No link at all fails
    const absent = roleMap.compareSharedLink({ type: f.type, role: f.role }, []);
    assert.strictEqual(absent.match, false, `${label}: a missing link must fail`);
    assert.strictEqual(absent.found, false);

    // The WRONG scope must fail — this is the check that catches a public link quietly narrowed to the
    // organization, which a simple "does a link exist" test would wave through.
    const wrongScope = f.scope === 'anonymous' ? 'organization' : 'anonymous';
    const scopeSwapped = roleMap.compareSharedLink(
      { type: f.type, role: f.role },
      [{ scope: wrongScope, type: f.linkType }]
    );
    assert.strictEqual(scopeSwapped.match, false, `${label}: wrong scope must fail`);
    assert.strictEqual(scopeSwapped.scopeMatch, false);

    // The WRONG type must fail — right audience, wrong power
    const wrongType = f.linkType === 'view' ? 'edit' : 'view';
    const typeSwapped = roleMap.compareSharedLink(
      { type: f.type, role: f.role },
      [{ scope: f.scope, type: wrongType }]
    );
    assert.strictEqual(typeSwapped.match, false, `${label}: wrong type must fail`);
    assert.strictEqual(typeSwapped.scopeMatch, true, `${label}: but the scope was still right`);
    assert.strictEqual(typeSwapped.typeMatch, false);
  }

  // Every documented case is covered
  assert.strictEqual(PERMISSION_FEATURES.length + LINK_FEATURES.length, 21,
    'features 4.2–4.8 and 5.2–5.15 are 21 cases in total');

  // An unknown link type has no expected scope rather than a wrong one
  assert.strictEqual(roleMap.expectedLinkScope('mystery'), null);
}

function testBoxPathUnchanged() {
  // The Box→SharePoint validator depends on these; the Drive additions must not have altered them.
  assert.strictEqual(roleMap.boxRoleLevel('editor'), 'EDIT');
  assert.strictEqual(roleMap.boxRoleLevel('viewer'), 'READ');
  assert.strictEqual(roleMap.boxRoleLevel('owner'), 'FULL');
  assert.strictEqual(roleMap.expectedSpLabel('editor'), 'Edit');
  assert.strictEqual(roleMap.compareAccess('editor', SP_WRITE).match, true);
  assert.strictEqual(roleMap.compareAccess('editor', SP_READ).match, false);
  assert.strictEqual(roleMap.spRolesLevel(['read', 'write']), 'EDIT', 'best level wins');
}

function run() {
  testPermissionFeatures();
  testLinkFeatures();
  testBoxPathUnchanged();
  console.log('contentPermissionMatrix.test.js: ok');
}

run();
