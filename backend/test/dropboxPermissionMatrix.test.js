/**
 * Run: npm test  (from backend/)
 *
 * The Dropbox permission matrix — breadth of grants, mirroring DriveTestDataAgent.
 *
 * Seeding used ONE internal user, ONE group and ONE external address, which covered roughly two of
 * the eighteen combinations the scope's permission matrix asks for (internal x group x external, at
 * edit and view, on a root folder / an inner folder / a file). Group grants alone are 3,866 of the
 * manual suite's cases, and a company-managed Dropbox group migrates differently from a
 * user-managed one — so covering only one group type left the other untested while looking covered.
 *
 * Every write is stubbed. These tests exercise OUR decisions — which principal gets which role on
 * which item — and never touch Dropbox.
 */
const assert = require('assert');

const dropboxClient = require('../src/clients/dropboxClient');
const DropboxTestDataAgent = require('../src/agents/dropbox/DropboxTestDataAgent');

/** An agent whose file/folder creation and grant calls are captured instead of performed. */
function harness(groupsOnAccount = ['QA-Automation', 'Regression_Company-managed_Group']) {
  const grants = [];
  const saved = {
    listTeamGroups: dropboxClient.listTeamGroups,
    shareFolder: dropboxClient.shareFolder,
    addFolderMember: dropboxClient.addFolderMember,
    addFileMember: dropboxClient.addFileMember,
  };
  dropboxClient.listTeamGroups = async () =>
    groupsOnAccount.map((n, i) => ({ groupId: `g${i}`, name: n }));
  dropboxClient.shareFolder = async (p) => `sf:${p}`;
  dropboxClient.addFolderMember = async (sf, m, role) =>
    grants.push({ kind: 'folder', who: m.email || m.displayName, role });
  dropboxClient.addFileMember = async (id, m, role) =>
    grants.push({ kind: 'file', who: m.email || m.displayName, role });

  const agent = new DropboxTestDataAgent();
  const created = [];
  agent._mk = async (p) => { created.push(p); return { type: 'folder', path: p, id: 'F' }; };
  agent._put = async (p) => { created.push(p); return { type: 'file', path: p, id: 'X' }; };

  const report = { created: { grants: 0 }, skipped: [] };
  const log = { info: () => {}, warn: () => {} };
  const restore = () => Object.assign(dropboxClient, saved);
  return { agent, grants, created, report, log, restore };
}

/** Every role must meet every principal type, on both a folder and a file. */
async function testEveryRoleMeetsEveryPrincipalType() {
  const h = harness();
  try {
    await h.agent._seedPermissionMatrix('/QA-Automation', {}, {
      internalUsers: ['ben@filefuze.co', 'mia@filefuze.co'],
      groupNames: ['QA-Automation', 'Regression_Company-managed_Group'],
      external: 'warner@snapbot.io',
    }, h.log, h.report);

    // 2 roles x (folder + file) x (1 rotated user + 2 groups + 1 external) = 16
    assert.strictEqual(h.grants.length, 16, `expected 16 grants, got ${h.grants.length}`);

    for (const role of ['editor', 'viewer']) {
      for (const kind of ['folder', 'file']) {
        const cell = h.grants.filter((g) => g.role === role && g.kind === kind);
        assert.strictEqual(cell.length, 4,
          `${kind}/${role} must carry 4 principals (user + 2 groups + external), got ${cell.length}`);
        // Both group TYPES present — the whole point of accepting a list.
        assert.ok(cell.some((g) => g.who === 'QA-Automation'), `${kind}/${role} has the first group`);
        assert.ok(cell.some((g) => g.who === 'Regression_Company-managed_Group'),
          `${kind}/${role} has the company-managed group — one group type must not stand in for both`);
        assert.ok(cell.some((g) => g.who === 'warner@snapbot.io'), `${kind}/${role} has the external`);
      }
    }
    console.log('  every role meets user, both groups and external, on folder and file: ok');
  } finally { h.restore(); }
}

/**
 * The same ROLE must be held by a DIFFERENT person than another role.
 *
 * Taken from the Drive side, where giving one grantee the same role everywhere made leakage between
 * trees undetectable: if one tree's grants appear on another, the correct grantee is exactly what a
 * correct migration looks like there too.
 */
async function testPrincipalRotatesAcrossRoles() {
  const h = harness();
  try {
    await h.agent._seedPermissionMatrix('/QA-Automation', {}, {
      internalUsers: ['ben@filefuze.co', 'mia@filefuze.co', 'alex@filefuze.co'],
      groupNames: [],
      external: null,
    }, h.log, h.report);

    const userFor = (role) => h.grants.filter((g) => g.role === role).map((g) => g.who);
    const editor = [...new Set(userFor('editor'))];
    const viewer = [...new Set(userFor('viewer'))];
    assert.strictEqual(editor.length, 1, 'one internal user per role');
    assert.strictEqual(viewer.length, 1, 'one internal user per role');
    assert.notStrictEqual(editor[0], viewer[0],
      'editor and viewer must go to different people, or a leaked grant is indistinguishable');
    console.log('  internal principal rotates between roles: ok');
  } finally { h.restore(); }
}

/** Rotation must be DETERMINISTIC, so two runs of the same root stay comparable. */
async function testRotationIsDeterministic() {
  const runs = [];
  for (let i = 0; i < 2; i += 1) {
    const h = harness([]);
    try {
      await h.agent._seedPermissionMatrix('/QA-Automation', {}, {
        internalUsers: ['ben@filefuze.co', 'mia@filefuze.co', 'alex@filefuze.co'],
        groupNames: [], external: null,
      }, h.log, h.report);
      runs.push(h.grants.map((g) => `${g.kind}:${g.role}:${g.who}`).join('|'));
    } finally { h.restore(); }
  }
  assert.strictEqual(runs[0], runs[1],
    'the same root must seed the same principals, or two reports cannot be compared');

  // A different root must rotate differently, which is what makes leakage visible.
  const h2 = harness([]);
  let other;
  try {
    await h2.agent._seedPermissionMatrix('/QA-Automation-Other', {}, {
      internalUsers: ['ben@filefuze.co', 'mia@filefuze.co', 'alex@filefuze.co'],
      groupNames: [], external: null,
    }, h2.log, h2.report);
    other = h2.grants.map((g) => `${g.kind}:${g.role}:${g.who}`).join('|');
  } finally { h2.restore(); }
  assert.notStrictEqual(runs[0], other,
    'a different root must assign different people to the same roles');
  console.log('  rotation deterministic per root, different between roots: ok');
}

/** A missing principal is REPORTED, never silently skipped and never a pass. */
async function testMissingPrincipalsAreReported() {
  const h = harness([]);
  try {
    await h.agent._seedPermissionMatrix('/QA-Automation', {}, {
      internalUsers: [], groupNames: [], external: null,
    }, h.log, h.report);

    assert.strictEqual(h.grants.length, 0, 'nothing can be granted with no principals');
    assert.strictEqual(h.report.skipped.length, 1, 'the whole matrix is reported skipped once');
    assert.ok(/DROPBOX_TEST_INTERNAL_USERS/.test(h.report.skipped[0].reason),
      `the reason must name what to set, got: ${h.report.skipped[0].reason}`);
  } finally { h.restore(); }

  // A group NAME that does not exist on the account must not be invented.
  const h2 = harness(['SomeOtherGroup']);
  try {
    await h2.agent._seedPermissionMatrix('/QA-Automation', {}, {
      internalUsers: ['ben@filefuze.co'], groupNames: ['NoSuchGroup'], external: null,
    }, h2.log, h2.report);
    assert.ok(!h2.grants.some((g) => g.who === 'NoSuchGroup'),
      'a group that does not exist is never granted to');
    assert.ok(h2.report.skipped.some((x) => /NoSuchGroup|no group named/i.test(x.reason)),
      'and its absence is recorded');
  } finally { h2.restore(); }
  console.log('  missing principals reported, never invented: ok');
}

/**
 * Access mode: "open" grants the team-wide group, "restricted" grants only named people.
 *
 * Both seed the same named people on the Drive side; the everyone-group is the single variable, so
 * a difference between two runs is attributable to it and nothing else.
 */
async function testAccessModes() {
  const env = require('../src/config/env');
  const savedMode = env.DROPBOX_ACCESS_MODE;
  const savedEveryone = env.DROPBOX_TEST_EVERYONE_GROUP;

  try {
    // open
    env.DROPBOX_ACCESS_MODE = 'open';
    env.DROPBOX_TEST_EVERYONE_GROUP = 'Everyone at exinent';
    let h = harness(['Everyone at exinent']);
    try {
      await h.agent._applyAccessMode('/QA-Automation', {},
        { internalUsers: ['ben@filefuze.co', 'mia@filefuze.co'] }, h.log, h.report);
      assert.deepStrictEqual(h.grants.map((g) => g.who), ['Everyone at exinent'],
        'open mode grants the team-wide group');
    } finally { h.restore(); }

    // restricted — same people, no everyone-group
    env.DROPBOX_ACCESS_MODE = 'restricted';
    h = harness(['Everyone at exinent']);
    try {
      await h.agent._applyAccessMode('/QA-Automation', {},
        { internalUsers: ['ben@filefuze.co', 'mia@filefuze.co'] }, h.log, h.report);
      const who = h.grants.map((g) => g.who);
      assert.ok(!who.includes('Everyone at exinent'),
        'restricted mode must NOT grant the team-wide group — that is the whole distinction');
      assert.deepStrictEqual(who, ['ben@filefuze.co', 'mia@filefuze.co'],
        'restricted grants the named few');
    } finally { h.restore(); }

    // unset — nothing seeded, and said so
    env.DROPBOX_ACCESS_MODE = '';
    h = harness([]);
    try {
      await h.agent._applyAccessMode('/QA-Automation', {},
        { internalUsers: ['ben@filefuze.co'] }, h.log, h.report);
      assert.strictEqual(h.grants.length, 0, 'an unset mode seeds nothing');
      assert.ok(h.report.skipped.some((x) => /DROPBOX_ACCESS_MODE/.test(x.reason)),
        'and reports why, so the feature cannot come out green untested');
    } finally { h.restore(); }

    // an unrecognised value must not be treated as one of the two modes
    env.DROPBOX_ACCESS_MODE = 'everyone';
    h = harness(['Everyone at exinent']);
    try {
      await h.agent._applyAccessMode('/QA-Automation', {},
        { internalUsers: ['ben@filefuze.co'] }, h.log, h.report);
      assert.strictEqual(h.grants.length, 0, 'an unrecognised mode grants nothing');
    } finally { h.restore(); }
  } finally {
    env.DROPBOX_ACCESS_MODE = savedMode;
    env.DROPBOX_TEST_EVERYONE_GROUP = savedEveryone;
  }
  console.log('  open / restricted / unset / invalid access modes: ok');
}

/** The plural env vars parse as lists and fall back to the singular ones. */
function testEnvListParsing() {
  const env = require('../src/config/env');
  assert.ok(Array.isArray(env.DROPBOX_TEST_INTERNAL_USERS), 'internal users is a list');
  assert.ok(Array.isArray(env.DROPBOX_TEST_GROUPS), 'groups is a list');
  // Whatever this machine's .env holds, a configured singular value must appear in the list — that
  // fallback is what keeps an existing .env working unchanged.
  if (env.DROPBOX_TEST_INTERNAL_USER) {
    assert.ok(env.DROPBOX_TEST_INTERNAL_USERS.includes(env.DROPBOX_TEST_INTERNAL_USER),
      'the singular internal user falls back into the list');
  }
  if (env.DROPBOX_TEST_GROUP) {
    assert.ok(env.DROPBOX_TEST_GROUPS.includes(env.DROPBOX_TEST_GROUP),
      'the singular group falls back into the list');
  }
  console.log('  env lists parse and fall back to the singular vars: ok');
}

/**
 * Re-seeding must NOT delete the hand-authored Paper folder.
 *
 * Dropbox retired the Paper authoring API, so a Paper doc — 19 of the 36 in-scope features — has to
 * be created by hand once. That doc has to live INSIDE the seeding root, because the root is the
 * migration source and anything outside it is never migrated or validated. But the wipe deleted the
 * whole root, so a hand-authored doc lasted exactly one run.
 *
 * This is the test that protects somebody's manual effort: if the wipe ever goes back to deleting
 * the root wholesale, it fails here rather than silently costing 19 features and an afternoon.
 */
async function testWipePreservesPaper() {
  const deleted = [];
  const saved = { listFolder: dropboxClient.listFolder, deletePath: dropboxClient.deletePath };
  dropboxClient.listFolder = async () => ([
    { name: '01-Root-Folder-Permissions', path: '/QA-Automation/01-Root-Folder-Permissions' },
    { name: '11-Paper', path: '/QA-Automation/11-Paper' },
    { name: '13-Permission-Matrix', path: '/QA-Automation/13-Permission-Matrix' },
  ]);
  dropboxClient.deletePath = async (p) => { deleted.push(p); };

  try {
    const agent = new DropboxTestDataAgent();
    const report = { notSeeded: [], errors: [] };
    await agent._wipeRoot('/QA-Automation', {}, { info: () => {}, warn: () => {} }, report);

    assert.ok(!deleted.some((p) => /11-Paper/.test(p)),
      'the Paper folder must survive the wipe — it cannot be re-created by API');
    assert.ok(deleted.some((p) => /01-Root-Folder-Permissions/.test(p)),
      'everything else is still cleared, so a re-run starts clean');
    assert.ok(deleted.some((p) => /13-Permission-Matrix/.test(p)),
      'the seeded matrix is cleared like any other seeded folder');
    assert.ok(!deleted.includes('/QA-Automation'),
      'the root itself must not be deleted wholesale — that is what wiped the Paper doc');
  } finally { Object.assign(dropboxClient, saved); }

  // Nothing to preserve -> the fast path, deleting the root in one call, is still used.
  const env = require('../src/config/env');
  const savedPreserve = env.DROPBOX_PRESERVE_ON_WIPE;
  const deleted2 = [];
  const saved2 = { deletePath: dropboxClient.deletePath };
  dropboxClient.deletePath = async (p) => { deleted2.push(p); };
  try {
    env.DROPBOX_PRESERVE_ON_WIPE = [];
    const agent = new DropboxTestDataAgent();
    await agent._wipeRoot('/QA-Automation', {}, { info: () => {}, warn: () => {} },
      { notSeeded: [], errors: [] });
    assert.deepStrictEqual(deleted2, ['/QA-Automation'],
      'with nothing preserved, the root is deleted in one call');
  } finally {
    env.DROPBOX_PRESERVE_ON_WIPE = savedPreserve;
    Object.assign(dropboxClient, saved2);
  }

  // A preserved name that does not exist yet is REPORTED, so the Paper features are visibly
  // unexercised rather than quietly absent.
  const saved3 = { listFolder: dropboxClient.listFolder, deletePath: dropboxClient.deletePath };
  dropboxClient.listFolder = async () => ([{ name: '03-File-Formats', path: '/QA-Automation/03-File-Formats' }]);
  dropboxClient.deletePath = async () => {};
  try {
    const agent = new DropboxTestDataAgent();
    const report = { notSeeded: [], errors: [] };
    await agent._wipeRoot('/QA-Automation', {}, { info: () => {}, warn: () => {} }, report);
    assert.ok(report.notSeeded.some((x) => /Paper/i.test(x.feature)),
      'a missing Paper folder is reported as not seeded, naming the manual step');
  } finally { Object.assign(dropboxClient, saved3); }

  console.log('  re-seeding preserves the hand-authored Paper folder: ok');
}

/**
 * Dropbox grants must use SOURCE emails, and the configured list must outrank the run's mapping.
 *
 * Two faults found on run 85f442b1, both of which cost features 2.1, 2.2 and 2.4 their user-editor
 * dimension while the log said only "unavailable on this account":
 *
 *   1. `mapped` preferred m.destinationEmail — the GOOGLE side of the mapping. These grants happen
 *      on DROPBOX, and a destination address need not exist in the Dropbox team: the run's
 *      kamal.basha@cloudfuze.com mapping contributed "kamal@filefuze.co", which is real on Google
 *      and absent from the Dropbox team, so Dropbox refused it as cant_share_outside_team.
 *   2. The ladder fell through to mapped[0] instead of the configured plural list, so clearing the
 *      singular var in favour of the list silently discarded the operator's choice.
 */
function testGranteeResolutionUsesSourceEmails() {
  const env = require('../src/config/env');
  const savedSingular = env.DROPBOX_TEST_INTERNAL_USER;
  const savedPlural = env.DROPBOX_TEST_INTERNAL_USERS;
  const agent = new DropboxTestDataAgent();
  const log = { info: () => {}, warn: () => {} };

  try {
    // A mapping whose destination differs from its source — the case that broke.
    const context = {
      userEmailMappings: [
        { sourceEmail: 'kamal.basha@cloudfuze.com', destinationEmail: 'kamal@filefuze.co' },
      ],
    };

    // With no configured user at all, the fallback must take the SOURCE address.
    env.DROPBOX_TEST_INTERNAL_USER = '';
    env.DROPBOX_TEST_INTERNAL_USERS = [];
    let g = agent._resolveGrantees(context, log);
    assert.strictEqual(g.internal, 'kamal.basha@cloudfuze.com',
      'the Dropbox-side SOURCE address is used, never the Google-side destination');

    // With the plural list configured, it outranks the run's mapping.
    env.DROPBOX_TEST_INTERNAL_USERS = ['ben@filefuze.co', 'mia@filefuze.co'];
    g = agent._resolveGrantees(context, log);
    assert.strictEqual(g.internal, 'ben@filefuze.co',
      'the configured list wins over mapped[0] — clearing the singular must not discard it');
    assert.deepStrictEqual(g.internalUsers, ['ben@filefuze.co', 'mia@filefuze.co'],
      'and the full list is carried through for the matrix');

    // The singular still wins when explicitly set, so existing setups are unchanged.
    env.DROPBOX_TEST_INTERNAL_USER = 'alex@filefuze.co';
    g = agent._resolveGrantees(context, log);
    assert.strictEqual(g.internal, 'alex@filefuze.co', 'an explicit singular value still wins');
  } finally {
    env.DROPBOX_TEST_INTERNAL_USER = savedSingular;
    env.DROPBOX_TEST_INTERNAL_USERS = savedPlural;
  }
  console.log('  grantees resolve from source emails, configured list first: ok');
}

/**
 * A refused grant must never be logged as granted.
 *
 * The open-access branch logged "granted to the team-wide group" before checking the result, so run
 * 85f442b1 reported a grant that Dropbox had refused with bad_member/automatic_group. Reporting an
 * unexercised feature as done is the exact failure mode this validator exists to prevent.
 */
async function testRefusedGrantIsNotReportedAsGranted() {
  const env = require('../src/config/env');
  const savedMode = env.DROPBOX_ACCESS_MODE;
  const savedEveryone = env.DROPBOX_TEST_EVERYONE_GROUP;
  const saved = {
    listTeamGroups: dropboxClient.listTeamGroups,
    shareFolder: dropboxClient.shareFolder,
    addFolderMember: dropboxClient.addFolderMember,
  };
  const lines = [];

  try {
    env.DROPBOX_ACCESS_MODE = 'open';
    env.DROPBOX_TEST_EVERYONE_GROUP = 'Everyone at exinent';
    dropboxClient.listTeamGroups = async () => ([{ groupId: 'g', name: 'Everyone at exinent' }]);
    dropboxClient.shareFolder = async () => 'sf';
    dropboxClient.addFolderMember = async () => {
      const e = new Error('sharing/add_folder_member failed (HTTP 409): bad_member/automatic_group/');
      e.dropboxSummary = 'bad_member/automatic_group/';
      throw e;
    };

    const agent = new DropboxTestDataAgent();
    agent._mk = async (p) => ({ type: 'folder', path: p, id: 'F' });
    const report = { created: { grants: 0 }, skipped: [], notSeeded: [], errors: [] };
    await agent._applyAccessMode('/QA-Automation', {}, { internalUsers: ['ben@filefuze.co'] },
      { info: (m) => lines.push('INFO ' + m), warn: (m) => lines.push('WARN ' + m) }, report);

    assert.ok(!lines.some((l) => /^INFO .*granted to the team-wide group/.test(l)),
      'a refused grant must NOT be logged as granted');
    assert.ok(lines.some((l) => /^WARN .*did NOT succeed/.test(l)),
      'the failure is stated plainly instead');
    assert.strictEqual(report.errors.length, 0,
      'an automatic group is a Dropbox rule, not an error that should make a healthy run look broken');
    assert.ok(report.notSeeded.some((x) => /automatic_group/.test(x.reason)),
      'and it is recorded as a documented limitation, naming the API error');
    assert.ok(report.notSeeded.some((x) => /DROPBOX_TEST_EVERYONE_GROUP/.test(x.reason)),
      'with the remedy — point it at a user-created group');
  } finally {
    env.DROPBOX_ACCESS_MODE = savedMode;
    env.DROPBOX_TEST_EVERYONE_GROUP = savedEveryone;
    Object.assign(dropboxClient, saved);
  }
  console.log('  a refused grant is never reported as granted: ok');
}

(async () => {
  testEnvListParsing();
  testGranteeResolutionUsesSourceEmails();
  await testRefusedGrantIsNotReportedAsGranted();
  await testWipePreservesPaper();
  await testEveryRoleMeetsEveryPrincipalType();
  await testPrincipalRotatesAcrossRoles();
  await testRotationIsDeterministic();
  await testMissingPrincipalsAreReported();
  await testAccessModes();
  console.log('dropboxPermissionMatrix.test.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
