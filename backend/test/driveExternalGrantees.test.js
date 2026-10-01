'use strict';

/**
 * Check 2.5 (External Shares) is scored per GRANT, and only a grantee outside BOTH tenants counts
 * (`permissionFeatureIds` in validation/combinations/content/googledriveToGoogledrive.js). So the
 * strength of 2.5 is decided entirely by how many outside principals the seeder actually granted to.
 *
 * `GOOGLE_TEST_EXTERNAL_EMAIL` used to be read as ONE address, and the seeder granted to that one
 * address per role. Every run therefore proved the remap path for a single external identity —
 * every execution through 03f70f65 did exactly that — while the configured QA population was larger.
 * The setting now takes a comma-separated list and every address is granted at every role.
 *
 * The fan-out is what these assertions pin. Granting to N principals on one item is only sound
 * because Drive stores at most one role per principal per item; if anyone reduces this back to a
 * rotation (the way GROUP grants deliberately work), most of the configured list stops being
 * exercised and 2.5 quietly narrows again without any report saying so.
 *
 * The Drive API itself is stubbed — the calls need live credentials and belong to a real run. What
 * is exercised here is which grants the agent decides to make.
 */

const assert = require('assert');

const clientPath = require.resolve('../src/clients/driveClient');
const agentPath = require.resolve('../src/agents/drive/DriveTestDataAgent');

require(clientPath);
const realClient = { ...require.cache[clientPath].exports };

/** Build the agent with every Drive write recorded instead of performed. */
function agentWithRecorder({ failFor = [] } = {}) {
  let folderSeq = 0;
  let fileSeq = 0;

  require.cache[clientPath].exports = {
    ...realClient,
    createFolder: async (name) => ({ id: `folder-${++folderSeq}`, name }),
    uploadFile: async (name) => ({ id: `file-${++fileSeq}`, name }),
    shareFile: async (itemId, grantee) => {
      if (failFor.includes(grantee)) throw new Error(`simulated refusal for ${grantee}`);
    },
  };
  delete require.cache[agentPath];
  const Agent = require(agentPath);
  const agent = new Agent();
  agent.results = {};
  agent.errors = [];
  return agent;
}

function restore() {
  require.cache[clientPath].exports = realClient;
  delete require.cache[agentPath];
}

const EXTERNALS = [
  'mia@pepperwood.club',
  'dan@pepperwood.club',
  'alex@pepperwood.club',
  'warner@pepperwood.club',
  'granger@gajha.com',
  'zara@storefuze.com',
  'presales1@storefuze.com',
  'presales2@storefuze.com',
  'admin@migrationn.com',
  'alex@migrationn.com',
];
const GROUPS = ['qa-group-view@filefuze.co', 'qa-group-edit@filefuze.co'];
const ROLES = ['reader', 'commenter', 'writer'];

const seedArgs = (overrides) => ({
  parentId: 'root',
  folderPrefix: 'root_folder_',
  filePrefix: 'root_file_',
  roles: ROLES,
  grantees: ['alex@filefuze.co', 'mia@filefuze.co'],
  groupEmails: GROUPS,
  externalEmails: EXTERNALS,
  ownerEmail: 'mia@cloudfuze.com',
  driveOffset: 0,
  scenario: 'rootPermissions',
  ...overrides,
});

// ── Every configured external is granted at every role ───────────────────────
async function testEveryExternalGetsEveryRole() {
  const agent = agentWithRecorder();
  const seeded = await agent._seedRoleGrants(seedArgs());

  const externalGrants = seeded.filter((g) => g.principal === 'external');
  assert.strictEqual(externalGrants.length, EXTERNALS.length * ROLES.length,
    `every external must be granted at every role — expected ${EXTERNALS.length * ROLES.length}, `
    + `got ${externalGrants.length}. A rotation would give only ${ROLES.length}.`);

  for (const email of EXTERNALS) {
    const roles = externalGrants.filter((g) => g.grantee === email).map((g) => g.role).sort();
    assert.deepStrictEqual(roles, [...ROLES].sort(),
      `${email} must hold every role, so 2.5 has evidence for each — got ${roles.join(', ') || 'none'}`);
  }

  // Groups keep their rotation: one group per role, deliberately, so a grant that leaked between
  // drives shows up as the wrong group. The external change must not have altered that.
  const groupGrants = seeded.filter((g) => g.principal === 'group');
  assert.strictEqual(groupGrants.length, ROLES.length,
    'group grants stay rotated one-per-role — the external fan-out must not change them');
}

// ── One refusal does not cost the other externals their grants ───────────────
// A test population spans tenants, and any one address can be unlicensed, deleted or blocked from
// external sharing. If a single failure aborted the loop, one bad address would silently shrink 2.5
// to whatever happened to be seeded before it.
async function testOneRefusalDoesNotStopTheRest() {
  const blocked = 'granger@gajha.com';
  const agent = agentWithRecorder({ failFor: [blocked] });
  const seeded = await agent._seedRoleGrants(seedArgs());

  const survivors = new Set(seeded.filter((g) => g.principal === 'external').map((g) => g.grantee));
  assert.ok(!survivors.has(blocked), 'a refused grant must not be recorded as seeded');
  for (const email of EXTERNALS.filter((e) => e !== blocked)) {
    assert.ok(survivors.has(email),
      `${email} must still be granted even though ${blocked} was refused`);
  }

  // The failure has to be reported per address, not once per folder — otherwise the errors collapse
  // and the run cannot say WHICH external could not be granted.
  const blockedErrors = agent.errors.filter((e) => String(e.item).includes(blocked));
  assert.strictEqual(blockedErrors.length, ROLES.length,
    `each refusal is its own error naming the address — expected ${ROLES.length}, got ${blockedErrors.length}`);
}

// ── A single address still works, and a comma list never reaches the API whole ─
async function testBareStringStillWorks() {
  const agent = agentWithRecorder();
  const seeded = await agent._seedRoleGrants(seedArgs({
    externalEmails: 'solo@example.org', // pre-list callers passed a bare string
    grantees: ['alex@filefuze.co'],
    scenario: 'permissionMatrix',
  }));

  const externals = seeded.filter((g) => g.principal === 'external');
  assert.strictEqual(externals.length, ROLES.length,
    'a bare string must still be treated as one grantee, not iterated character by character');
  assert.ok(externals.every((g) => g.grantee === 'solo@example.org'));

  for (const g of seeded) {
    assert.ok(!String(g.grantee).includes(','),
      `a comma-separated value must never be handed to the Drive API as one grantee: ${g.grantee}`);
  }
}

// ── Nothing configured stays a no-op, not a crash ────────────────────────────
async function testNoExternalsConfigured() {
  const agent = agentWithRecorder();
  const seeded = await agent._seedRoleGrants(seedArgs({ externalEmails: [] }));
  assert.strictEqual(seeded.filter((g) => g.principal === 'external').length, 0,
    'with nothing configured, 2.5 must report "not exercised" rather than be given invented grants');
  assert.ok(seeded.some((g) => g.principal === 'group'),
    'the other principals must still be seeded when no external is configured');
}

// ── The configured population is actually outside both tenants ───────────────
// 2.5 discards any grantee inside the source or destination domain, so an address from the wrong
// tenant is not a weaker test — it is no test at all, and the feature reports N/A instead.
function testPopulationCountsAsExternal() {
  const {
    permissionFeatureIds,
  } = require('../src/validation/combinations/content/googledriveToGoogledrive');
  for (const email of EXTERNALS) {
    const ids = permissionFeatureIds(
      { path: '/root_folder_reader', type: 'folder' },
      { email, role: 'reader' },
      'cloudfuze.com'
    );
    assert.ok(ids.includes('2.5'),
      `${email} must count as external for a cloudfuze.com source, or it proves nothing for 2.5`);
  }
}

async function run() {
  try {
    await testEveryExternalGetsEveryRole();
    await testOneRefusalDoesNotStopTheRest();
    await testBareStringStillWorks();
    await testNoExternalsConfigured();
    testPopulationCountsAsExternal();
  } finally {
    restore();
  }
  console.log('driveExternalGrantees.test.js — all assertions passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
