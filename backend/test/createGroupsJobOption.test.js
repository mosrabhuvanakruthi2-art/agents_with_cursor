/**
 * Run: npm test  (from backend/)
 *
 * A feature cannot be called a product defect until the job has actually asked for it.
 *
 * ShareFile→SharePoint lists Group Permissions as in-scope feature 2.3. CloudFuze carries a grant
 * made to a GROUP only if it also creates that group at the destination — without it there is no
 * principal to grant to, so the grant is dropped while user grants on the same folder arrive
 * normally. That asymmetry is exactly what this combination kept reporting.
 *
 * `createGroups` was sent by nothing, so every run used CloudFuze's default false (visible as
 * `"createGroups":false` in every job response), and the validator reported ten dropped group
 * grants as a CloudFuze defect. It may still be one — but the question was never actually put.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { resolve } = require('../src/orchestrator/agentRegistry');

function testShareFileRequestsGroupCreation() {
  const set = resolve('content', 'sharefile', 'sharepoint');
  assert.ok(set, 'the sharefile→sharepoint combination must be registered');
  assert.strictEqual(set.contentOptionDefaults?.createGroups, true,
    'this pair has Group Permissions (2.3) in scope, so its job must ask CloudFuze to create the '
    + 'groups those permissions are granted to');
  console.log('  sharefile→sharepoint asks for group creation: ok');
}

function testOtherCombinationsAreUnchanged() {
  // The job-options builder is shared by every content pair. A flag one pair needs must not change
  // the job any other pair sends.
  for (const [src, dst] of [['dropbox', 'sharepoint'], ['box', 'sharepoint'], ['googledrive', 'sharepoint']]) {
    const set = resolve('content', src, dst);
    if (!set) continue;
    assert.strictEqual(set.contentOptionDefaults, undefined,
      `${src}→${dst} must keep sending the job it sent before — no combination may change another`);
  }
  console.log('  no other content combination changed: ok');
}

function testBuilderSendsTheFlagAndDefaultsItOff() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'clients', 'migrationClient.js'), 'utf8');

  assert.ok(/createGroups=\$\{opt\('createGroups', false\)\}/.test(src),
    'the job must send createGroups, and it must default FALSE: the builder is shared, so a run '
    + 'that names no option has to send the job it sent before (opt() defaults to true, which is '
    + 'why the second argument is required)');

  // And it must sit with the other permission flags, not somewhere a reader would miss it.
  const i = src.indexOf("createGroups=${opt(");
  const j = src.indexOf("withPermissions=${opt(");
  assert.ok(i > 0 && j > 0 && Math.abs(i - j) < 1500,
    'createGroups belongs beside the other permission flags');
  console.log('  job builder sends createGroups, default off: ok');
}

function testTheUsersOwnChoiceStillWins() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'orchestrator', 'AgentOrchestrator.js'), 'utf8');
  assert.ok(/\{ \.\.\.comboDefaults, \.\.\.before \}/.test(src),
    'combination defaults must be the BASE and the run\'s own options the override — spread the '
    + 'other way and a user who deliberately turned an option off would be silently overruled');
  console.log('  an explicit run option still overrides the combination default: ok');
}

testShareFileRequestsGroupCreation();
testOtherCombinationsAreUnchanged();
testBuilderSendsTheFlagAndDefaultsItOff();
testTheUsersOwnChoiceStillWins();
console.log('createGroupsJobOption.test.js: ok');
