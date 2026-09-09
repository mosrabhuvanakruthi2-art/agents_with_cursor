/**
 * Run: npm test  (from backend/)
 *
 * End-to-end scenarios for content: Google Shared Drive → SharePoint.
 *
 * Unlike the other content test files (which exercise pure functions), this one drives the REAL
 * validation agent with stubbed cloud clients. Every line of the validator runs — resolution, tree
 * pairing, all three tiers, the feature rollup — without a network call or a credential.
 *
 * The scenarios are the ones that matter: one clean migration that must PASS, and a set of broken
 * migrations that must each FAIL. A validator that passes a clean run is worthless if it also passes
 * a broken one, so every negative case asserts the failure is actually caught.
 *
 * Scenario dimensions follow the manually-executed QA suite for this combination
 * (Test Repository → /Google SharedDrive to SharePoint Online): user AND group principals, all four
 * item scopes, both version formats, external shares, renames, conversions and long paths.
 */
const assert = require('assert');
const path = require('path');

// ── Stub the cloud clients before the validator is loaded ────────────────────
const drivePath = require.resolve('../src/clients/driveClient');
const spPath = require.resolve('../src/clients/sharepointClient');
const olPath = require.resolve('../src/clients/outlookClient');
const validatorPath = require.resolve('../src/validation/combinations/content/googledriveToSharepoint');
// The destination-side base agent captures sharepointClient at load time, so it must be re-required
// after the stubs are installed — otherwise it keeps a reference to the real client.
const destAgentPath = require.resolve('../src/agents/sharepoint/SharePointValidationAgent');

// The validator logs per-unit progress; 18 scenarios would bury the result line.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.ENABLE_DEEP_CONTENT_VALIDATION = 'true';
process.env.CONTENT_DEEP_VALIDATE_METADATA = 'true';
process.env.CONTENT_DEEP_VALIDATE_LINKS = 'true';
process.env.CONTENT_DEEP_VALIDATE_FILE_HASH = 'true';
process.env.GOOGLE_SHARED_DRIVE_NAME = 'QA Shared Drive';

require(drivePath);
require(spPath);
require(olPath);
const realDrive = { ...require.cache[drivePath].exports };
const realSp = { ...require.cache[spPath].exports };
const realOl = { ...require.cache[olPath].exports };

const SRC = 'qa@src.com';
const DST = 'qa@dst.com';
const GROUP = 'team@src.com';
const EXTERNAL = 'partner@other.com';
const ROOT = '/QA';
const TS = '2026-08-20T10:00:00.000Z';

const file = (p, n, extra = {}) => ({
  id: 'id' + p, name: n, type: 'file', path: p, size: 100, mimeType: 'application/pdf',
  createdAt: TS, modifiedAt: TS, createdBy: SRC, modifiedBy: SRC, ...extra,
});
const folder = (p, n) => ({
  id: 'id' + p, name: n, type: 'folder', path: p, size: null,
  mimeType: 'application/vnd.google-apps.folder', createdAt: TS, modifiedAt: TS,
});

// ── The source tree: what DriveTestDataAgent seeds ───────────────────────────
const SOURCE_TREE = [
  folder('/Docs', 'Docs'),                                   // rootFolder
  file('/root_readme.txt', 'root_readme.txt', { mimeType: 'text/plain' }), // rootFile
  folder('/Docs/Reports', 'Reports'),                        // subFolder
  file('/Docs/Reports/q1.pdf', 'q1.pdf'),                    // innerFile
  file('/Docs/legacy.doc', 'legacy.doc', { mimeType: 'application/msword' }),
  file('/Docs/Q1 Notes', 'Q1 Notes', { mimeType: 'application/vnd.google-apps.document' }),
  folder('/Special : Chars', 'Special : Chars'),
  file('/Special : Chars/report<2026>.pdf', 'report<2026>.pdf'),
  folder('/Links', 'Links'),
  file('/Links/public.pdf', 'public.pdf'),
];

const SOURCE_PERMS = {
  '/Docs': { grants: [{ email: 'bob@src.com', role: 'writer', type: 'user' }, { email: GROUP, role: 'fileOrganizer', type: 'group' }], links: [] },
  '/Docs/Reports': { grants: [{ email: 'alice@src.com', role: 'commenter', type: 'user' }], links: [] },
  '/Docs/Reports/q1.pdf': { grants: [{ email: 'carol@src.com', role: 'writer', type: 'user' }], links: [] },
  '/root_readme.txt': { grants: [{ email: 'alice@src.com', role: 'reader', type: 'user' }, { email: EXTERNAL, role: 'reader', type: 'user' }], links: [] },
  '/Links': { grants: [], links: [{ type: 'anyone', role: 'reader' }] },
  '/Links/public.pdf': { grants: [], links: [{ type: 'domain', role: 'writer', domain: 'src.com' }] },
  // Renamed at the destination: "/Special : Chars/report<2026>.pdf" → "/Special _ Chars/report_2026_.pdf"
  '/Special : Chars/report<2026>.pdf': {
    grants: [{ email: 'bob@src.com', role: 'writer', type: 'user' }],
    links: [{ type: 'anyone', role: 'reader' }],
  },
  // Converted at the destination: "/Docs/legacy.doc" → "/Docs/legacy.docx"
  '/Docs/legacy.doc': { grants: [{ email: 'alice@src.com', role: 'reader', type: 'user' }], links: [] },
};

const DEST_PERMS = {
  '/QA/Docs': { permissions: [{ email: 'bob@dst.com', roles: ['write'], principalType: 'user' }, { email: 'team@dst.com', roles: ['write'], principalType: 'group' }], links: [] },
  '/QA/Docs/Reports': { permissions: [{ email: 'alice@dst.com', roles: ['read'], principalType: 'user' }], links: [] },
  // carol has no direct grant — her access comes from the group. Must NOT be a failure.
  '/QA/Docs/Reports/q1.pdf': { permissions: [{ email: 'team@dst.com', roles: ['write'], principalType: 'group' }], links: [] },
  '/QA/root_readme.txt': { permissions: [{ email: 'alice@dst.com', roles: ['read'], principalType: 'user' }, { email: EXTERNAL, roles: ['read'], principalType: 'user' }], links: [] },
  '/QA/Links': { permissions: [], links: [{ scope: 'anonymous', type: 'view' }] },
  '/QA/Links/public.pdf': { permissions: [], links: [{ scope: 'organization', type: 'edit' }] },
  // Keyed on the RENAMED / CONVERTED destination paths — the only paths that actually exist there.
  '/QA/Special _ Chars/report_2026_.pdf': {
    permissions: [{ email: 'bob@dst.com', roles: ['write'], principalType: 'user' }],
    links: [{ scope: 'anonymous', type: 'view' }],
  },
  '/QA/Docs/legacy.docx': {
    permissions: [{ email: 'alice@dst.com', roles: ['read'], principalType: 'user' }],
    links: [],
  },
};

const MAPPINGS = [
  { sourceEmail: 'alice@src.com', destinationEmail: 'alice@dst.com' },
  { sourceEmail: 'bob@src.com', destinationEmail: 'bob@dst.com' },
  { sourceEmail: 'carol@src.com', destinationEmail: 'carol@dst.com' },
  { sourceEmail: GROUP, destinationEmail: 'team@dst.com' },
  { sourceEmail: EXTERNAL, destinationEmail: EXTERNAL },
];

const core = require('../src/validation/shared/deepContentCore');
const leaf = (p) => p.split('/').filter(Boolean).pop();

/** The destination as a correct migration would leave it: renamed and converted, under ROOT. */
function buildDestTree() {
  return SOURCE_TREE.map((i) => {
    const segs = i.path.split('/').filter(Boolean);
    const renamed = segs.map((s, idx) => (idx === segs.length - 1
      ? core.expectedDestName(s, i.mimeType)
      : core.expectedDestName(s, undefined)));
    return {
      ...i,
      id: 'sp' + i.path,
      name: core.expectedDestName(i.name, i.mimeType),
      path: `${ROOT}/${renamed.join('/')}`,
    };
  });
}

let restoreDriveName = () => {};

/** Install stubs for one scenario, run the real validator, restore. */
async function runScenario(cfg = {}) {
  let destTree = cfg.destTree ? cfg.destTree(buildDestTree()) : buildDestTree();
  const destPerms = cfg.destPerms ? cfg.destPerms({ ...DEST_PERMS }) : DEST_PERMS;

  // config/env reads process.env once at load, so the scenario has to clear the resolved value.
  const envModule = require('../src/config/env');
  const sharedDriveName = envModule.GOOGLE_SHARED_DRIVE_NAME;
  if (cfg.noSharedDriveName) envModule.GOOGLE_SHARED_DRIVE_NAME = '';
  restoreDriveName = () => { envModule.GOOGLE_SHARED_DRIVE_NAME = sharedDriveName; };
  require.cache[drivePath].exports = {
    ...realDrive,
    resolveSharedDriveByName: async () => ({ id: 'drive1', name: 'QA Shared Drive' }),
    listSharedDrives: cfg.listSharedDrives || (async () => [{ id: 'drive1', name: 'QA Shared Drive' }]),
    findFoldersByName: cfg.findFoldersByName || (async () => [{ id: 'f1', name: 'QA', driveId: 'drive1' }]),
    getSharedDriveById: cfg.getSharedDriveById || (async (id) => ({ id, name: 'QA Shared Drive' })),
    resolveFolderByPath: cfg.resolveFolderByPath
      || (async () => ({ id: 'root1', name: 'QA', path: ROOT })),
    buildFolderTree: async () => (cfg.sourceTree ? cfg.sourceTree(SOURCE_TREE) : SOURCE_TREE),
    listPermissions: async (id) => {
      const item = SOURCE_TREE.find((i) => i.id === id);
      return (item && SOURCE_PERMS[item.path]) || { grants: [], links: [] };
    },
    listRevisions: async (id) => {
      const item = SOURCE_TREE.find((i) => i.id === id);
      return item?.path === '/Docs/Reports/q1.pdf'
        ? { totalVersions: 7, revisions: [] }
        : { totalVersions: 1, revisions: [] };
    },
    downloadFile: async () => Buffer.from('original bytes'),
  };
  require.cache[spPath].exports = {
    ...realSp,
    getSite: cfg.getSite || (async () => ({ id: 'site1' })),
    // The destination path names site "SANITY DATAA"; the validator looks it up rather than
    // trusting SHAREPOINT_SITE_PATH. Stubbed so the suite never reaches the network.
    findSiteByName: cfg.findSiteByName || (async (name) => ({
      id: 'site1', displayName: name, webUrl: 'https://qa.sharepoint.com/sites/SANITYDATAA',
    })),
    getFolderItem: async (s, p) => (p === ROOT ? { id: 'sp-root', name: 'QA' } : null),
    buildFolderTree: async () => destTree,
    getItemPermissions: async (s, p) => destPerms[p] || { permissions: [], links: [] },
    getItemVersions: async () => ({ totalVersions: cfg.destVersions ?? 4 }),
    downloadItemContent: async () => Buffer.from(cfg.corrupt ? 'CORRUPTED' : 'original bytes'),
  };
  require.cache[olPath].exports = { ...realOl, getMessages: async () => (cfg.messages || []) };

  delete require.cache[validatorPath];
  delete require.cache[destAgentPath];
  const Agent = require(validatorPath);
  try {
    return await new Agent().execute({
      domain: 'content', sourceProvider: 'googledrive', destinationProvider: 'sharepoint',
      sourceEmail: SRC, destinationEmail: DST,
      sourceTestDataPath: '/QA', destinationPath: '/SANITY DATAA/Documents',
      migrationType: cfg.migrationType || 'FULL', startTime: '2026-08-20T09:00:00.000Z',
      contentMigrationReport: { status: 'PROCESSED', processedCount: 10, totalCount: 10 },
      userEmailMappings: MAPPINGS,
      ...(cfg.context || {}),
    });
  } finally {
    restoreDriveName();
    require.cache[drivePath].exports = realDrive;
    require.cache[spPath].exports = realSp;
    require.cache[olPath].exports = realOl;
    delete require.cache[validatorPath];
    delete require.cache[destAgentPath];
  }
}

const featureById = (r) => Object.fromEntries((r.featureChecklist || []).map((x) => [x.id, x]));
const failedNames = (r) => r.checks.filter((c) => c.status === 'FAIL')
  .map((c) => c.name.replace(/^\[.*?\]\s*/, ''));

// Destination path names site "SANITY DATAA"; neither the slug probe nor the name search finds it.
const unreachableSite = {
  getSite: async (host, p) => { const e = new Error('404'); e.response = { status: 404 }; throw e; },
  findSiteByName: async () => null,
};

// ── Scenarios ────────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    name: 'clean migration passes and exercises every dimension',
    async run() {
      const r = await runScenario();
      assert.notStrictEqual(r.overallStatus, 'FAIL', `clean run must not fail: ${failedNames(r).join('; ')}`);
      const d = r.deepContentValidation;
      assert.strictEqual(d.missing.length, 0, 'nothing missing');
      assert.strictEqual(d.extra.length, 0, 'nothing extra');
      assert.strictEqual(d.misplaced.length, 0, 'nothing misplaced');
      assert.ok(d.scannedSourceItems > 0, 'items were actually scanned');
      assert.strictEqual(d.pairedCount, SOURCE_TREE.length, 'every source item paired');

      const f = featureById(r);
      assert.strictEqual(f['3.1'].status, 'pass', 'structure');
      assert.strictEqual(f['12.1'].status, 'pass', 'conversion');
      assert.strictEqual(f['7.1'].status, 'pass', 'special characters');
      assert.strictEqual(f['10.1'].status, 'pass', 'timestamps');
    },
  },
  {
    name: 'destination names match hard-coded expectations, not just the code under test',
    async run() {
      // buildDestTree() derives names via expectedDestName — the same function the validator uses —
      // so on its own it cannot detect a wrong rule. These literals are taken from the feature doc.
      const dest = buildDestTree();
      const byName = (n) => dest.find((d) => d.path === n);
      assert.ok(byName('/QA/Special _ Chars'), 'invalid characters become underscores');
      assert.ok(byName('/QA/Special _ Chars/report_2026_.pdf'), 'and in file names too');
      assert.ok(byName('/QA/Docs/legacy.docx'), '.doc converts to .docx');
      assert.ok(byName('/QA/Docs/Q1 Notes.docx'), 'a Google Doc gains .docx');
      assert.ok(byName('/QA/root_readme.txt'), 'a pass-through file is unchanged');
      // And the validator agrees with those literals end to end.
      const r = await runScenario();
      assert.notStrictEqual(r.overallStatus, 'FAIL');
    },
  },
  {
    name: 'a renamed parent folder does not orphan its children',
    async run() {
      const r = await runScenario();
      // "/Special : Chars" becomes "/Special _ Chars"; its child must still pair.
      assert.ok(!r.deepContentValidation.missing.some((m) => /report/.test(m.path)),
        'the child of a renamed folder must not be reported missing');
      assert.strictEqual(r.deepContentValidation.misplaced.length, 0,
        'nor misplaced');
    },
  },
  {
    name: 'access granted through a group is accepted, not failed',
    async run() {
      const r = await runScenario();
      const perm = r.checks.find((c) => /Permissions \(features/.test(c.name));
      assert.strictEqual(perm.status, 'PASS', `carol has no direct grant but the group carries it: ${perm.detail}`);
      const viaGroup = r.deepContentValidation.permissionObservations.filter((o) => o.viaGroup);
      assert.ok(viaGroup.length >= 1, 'and it is reported as resolved via group, not silently');
    },
  },
  {
    name: 'group and user principals are both recorded',
    async run() {
      const r = await runScenario();
      const obs = r.deepContentValidation.permissionObservations;
      assert.ok(obs.some((o) => o.principalType === 'group'), 'group grants observed');
      assert.ok(obs.some((o) => o.principalType === 'user'), 'user grants observed');
      assert.ok(!r.featureSummary.coverageGaps.some((g) => /GROUP/.test(g)),
        'so no group-coverage gap is reported');
    },
  },
  {
    name: 'all four item scopes are covered',
    async run() {
      const r = await runScenario();
      const cov = r.featureSummary.coverage;
      for (const scope of ['rootFolder', 'rootFile', 'subFolder', 'innerFile']) {
        assert.ok(cov.scopes[scope] > 0, `${scope} was exercised`);
      }
      assert.deepStrictEqual(cov.untestedScopes, [], 'no scope left untested');
    },
  },
  {
    name: 'external shares are detected',
    async run() {
      const r = await runScenario();
      assert.ok(r.deepContentValidation.externalShares.length > 0, 'an out-of-domain grantee is seen');
      assert.strictEqual(featureById(r)['4.9'].status, 'pass');
    },
  },
  {
    name: 'converted files are not byte-hashed, and say why',
    async run() {
      const r = await runScenario();
      const d = r.deepContentValidation;
      assert.ok(d.hashedCount > 0, 'binary files are hashed');
      assert.ok(d.notHashedCount > 0, 'converted/native files are not');
      assert.strictEqual(d.hashMismatches.length, 0, 'and nothing reports as corrupt');
    },
  },
  {
    name: 'version count difference is informational, never a failure',
    async run() {
      // Source has 7 revisions, destination reports 4 — Google merges revisions, so this is expected.
      const r = await runScenario({ destVersions: 4 });
      const versionCheck = r.checks.find((c) => /Version history/.test(c.name));
      assert.notStrictEqual(versionCheck.status, 'FAIL', 'a count difference cannot fail the run');
      assert.notStrictEqual(featureById(r)['8.1'].status, 'fail');
    },
  },
  {
    name: 'no version history at all IS reported',
    async run() {
      const r = await runScenario({ destVersions: 0 });
      const row = featureById(r)['8.1'];
      // Reported, not failed — the same severity the validator raises (WARN), since the in-scope doc
      // makes version history conditional on the destination library. What matters is that it is
      // never a silent pass and the reason travels with it.
      assert.strictEqual(row.status, 'info');
      assert.notStrictEqual(row.status, 'pass');
      assert.ok(/versioning is enabled/.test(row.detail), 'and says what to check');
      const check = r.checks.find((c) => /Version history/.test(c.name));
      assert.strictEqual(check.status, 'WARN', 'the check row and the feature row agree');
    },
  },
  {
    name: 'NEGATIVE — a file that did not migrate fails the run',
    async run() {
      const r = await runScenario({ destTree: (t) => t.filter((i) => !/q1\.pdf$/.test(i.name)) });
      assert.strictEqual(r.overallStatus, 'FAIL');
      assert.strictEqual(r.deepContentValidation.missing.length, 1);
      assert.strictEqual(featureById(r)['3.1'].status, 'fail');
    },
  },
  {
    name: 'NEGATIVE — an extra item at the destination fails the run',
    async run() {
      const r = await runScenario({
        destTree: (t) => t.concat([{ ...file(`${ROOT}/junk.tmp`, 'junk.tmp'), path: `${ROOT}/junk.tmp` }]),
      });
      assert.strictEqual(r.overallStatus, 'FAIL');
      assert.strictEqual(r.deepContentValidation.extra.length, 1);
    },
  },
  {
    name: 'NEGATIVE — a file moved to another folder fails the run',
    async run() {
      const r = await runScenario({
        destTree: (t) => t.map((i) => (/q1\.pdf$/.test(i.name) ? { ...i, path: `${ROOT}/q1.pdf` } : i)),
      });
      assert.strictEqual(r.overallStatus, 'FAIL');
      assert.strictEqual(r.deepContentValidation.misplaced.length, 1, 'reported as moved, not missing');
      assert.strictEqual(r.deepContentValidation.missing.length, 0);
    },
  },
  {
    name: 'NEGATIVE — an editor downgraded to read-only fails the run',
    async run() {
      const r = await runScenario({
        destPerms: (p) => ({ ...p, '/QA/Docs': { permissions: [{ email: 'bob@dst.com', roles: ['read'], principalType: 'user' }], links: [] } }),
      });
      assert.strictEqual(r.overallStatus, 'FAIL');
      assert.ok(r.deepContentValidation.permissionMismatches.length > 0);
      assert.strictEqual(featureById(r)['4.4'].status, 'fail', 'Contributor row fails');
    },
  },
  {
    name: 'NEGATIVE — a public link narrowed to the organization fails the run',
    async run() {
      const r = await runScenario({
        destPerms: (p) => ({ ...p, '/QA/Links': { permissions: [], links: [{ scope: 'organization', type: 'view' }] } }),
      });
      assert.strictEqual(r.overallStatus, 'FAIL');
      assert.ok(r.deepContentValidation.sharedLinkMismatches.length > 0,
        'scope narrowing is caught — a presence-only check would miss it');
      assert.strictEqual(featureById(r)['5.2'].status, 'fail');
    },
  },
  {
    name: 'NEGATIVE — a view-only link upgraded to edit fails the run',
    async run() {
      const r = await runScenario({
        destPerms: (p) => ({ ...p, '/QA/Links': { permissions: [], links: [{ scope: 'anonymous', type: 'edit' }] } }),
      });
      assert.strictEqual(r.overallStatus, 'FAIL', 'an escalated link is a defect too');
    },
  },
  {
    name: 'NEGATIVE — corrupted file content fails the run',
    async run() {
      const r = await runScenario({ corrupt: true });
      assert.strictEqual(r.overallStatus, 'FAIL');
      assert.ok(r.deepContentValidation.hashMismatches.length > 0, 'Tier B catches identical-looking but wrong bytes');
    },
  },
  {
    name: 'NEGATIVE — an empty source tree fails instead of vacuously passing',
    async run() {
      const r = await runScenario({ sourceTree: () => [] });
      assert.strictEqual(r.overallStatus, 'FAIL', 'reading nothing must never be a pass');
      const scanCheck = r.checks.find((c) => /Source items scanned/.test(c.name));
      assert.strictEqual(scanCheck.status, 'FAIL');
      assert.ok(/nothing was validated/.test(scanCheck.detail));
      assert.ok(r.featureChecklist.every((f) => f.status === 'na'), 'and no feature is claimed');
    },
  },
  {
    name: 'the report carries the fields the PDF renderer reads',
    async run() {
      const r = await runScenario();
      const u = r.perUser[0];
      assert.ok(u.mapping, 'user header mapping');
      assert.ok(Array.isArray(u.checks) && u.checks.length > 0, 'checks table');
      assert.ok(u.folderStructure, 'folder structure section');
      assert.ok(Array.isArray(u.folderStructure.sourceFolderPaths), 'source tree paths');
      assert.ok(Array.isArray(u.folderStructure.destFolderPaths), 'destination tree paths');
      assert.ok(u.folderStructure.sourceRootName, 'source root name for the ASCII tree');
      assert.ok(u.folderStructure.destRootName, 'destination root name for the ASCII tree');
      assert.ok(Array.isArray(u.items) && u.items.length > 0, 'per-item tree');
      const withPerm = u.items.find((i) => (i.permissions || []).length > 0);
      assert.ok(withPerm, 'at least one item carries permission rows');
      assert.ok('sourceRole' in withPerm.permissions[0], 'permission rows carry the source role');
      assert.ok(Array.isArray(r.featureChecklist) && r.featureChecklist.length === 38, '38 features');
      assert.ok(r.featureSummary?.line, 'summary line for the report header');
    },
  },
  {
    name: 'destination site that cannot be found fails instead of validating the configured site',
    async run() {
      const r = await runScenario({ ...unreachableSite });
      assert.strictEqual(r.overallStatus, 'FAIL', 'an unresolvable destination site cannot pass');
      const site = r.checks.find((c) => /site accessible/i.test(c.name));
      assert.strictEqual(site.status, 'FAIL');
      assert.ok(/Refusing to validate/.test(site.detail), 'says it refused to substitute another site');
      assert.ok(r.deepContentValidation.scannedSourceItems === 0, 'nothing was compared');
    },
  },
  {
    name: 'a failing run carries its failures as mismatches so the raised bug has evidence',
    async run() {
      const r = await runScenario({ ...unreachableSite });
      assert.ok(Array.isArray(r.mismatches) && r.mismatches.length > 0,
        'a FAIL with no mismatches raises an empty low-priority ticket');
      const failCount = r.checks.filter((c) => c.status === 'FAIL').length;
      assert.strictEqual(r.mismatches.length, failCount, 'every FAIL check is represented');
      const infra = r.mismatches.find((m) => m.kind === 'infrastructure');
      assert.ok(infra, '"nothing could be compared" is infrastructure, which drives urgent priority');
      assert.strictEqual(infra.severity, 'critical');
      assert.ok(infra.summaryLine.length > 0 && infra.field.length > 0);

      // A clean run carries none — mismatches must not fire on a pass
      const clean = await runScenario();
      assert.strictEqual((clean.mismatches || []).length, 0);
    },
  },
  {
    name: 'the Shared Drive is discovered from the folder the run migrates when nothing names it',
    async run() {
      const r = await runScenario({
        noSharedDriveName: true,
        context: { sourceCloudName: 'GOOGLE_SHARED_DRIVES' },
        findFoldersByName: async () => [{ id: 'f1', name: 'QA', driveId: 'drive1' }],
        getSharedDriveById: async (id) => ({ id, name: 'QA Shared Drive' }),
      });
      const drive = r.checks.find((c) => /Shared Drive resolved/i.test(c.name));
      assert.strictEqual(drive.status, 'PASS', drive.detail);
      assert.ok(/QA Shared Drive/.test(drive.detail), 'names the drive it picked');
      assert.notStrictEqual(r.overallStatus, 'FAIL', `discovery must not break the run: ${failedNames(r).join('; ')}`);
    },
  },
  {
    name: 'discovery is one search, not a walk per drive (a QA admin can see a thousand)',
    async run() {
      let listCalls = 0;
      let searchCalls = 0;
      await runScenario({
        noSharedDriveName: true,
        context: { sourceCloudName: 'GOOGLE_SHARED_DRIVES' },
        listSharedDrives: async () => { listCalls++; return Array.from({ length: 1000 }, (_, i) => ({ id: `d${i}`, name: `Drive ${i}` })); },
        findFoldersByName: async () => { searchCalls++; return [{ id: 'f1', name: 'QA', driveId: 'drive1' }]; },
      });
      assert.strictEqual(searchCalls, 1, 'exactly one Drive search');
      assert.strictEqual(listCalls, 0, 'the drive list is never enumerated to find one folder');
    },
  },
  {
    name: 'a source folder in several Shared Drives is ambiguous, not a guess',
    async run() {
      const r = await runScenario({
        noSharedDriveName: true,
        context: { sourceCloudName: 'GOOGLE_SHARED_DRIVES' },
        findFoldersByName: async () => [
          { id: 'f1', name: 'QA', driveId: 'driveA' },
          { id: 'f2', name: 'QA', driveId: 'driveB' },
        ],
      });
      const drive = r.checks.find((c) => /Shared Drive resolved/i.test(c.name));
      assert.strictEqual(drive.status, 'FAIL');
      assert.ok(/ambiguous/i.test(drive.detail), 'says why it refused to pick');
      assert.strictEqual(r.overallStatus, 'FAIL');
    },
  },
  {
    name: 'a source folder that exists nowhere fails instead of comparing an empty tree',
    async run() {
      const r = await runScenario({
        noSharedDriveName: true,
        context: { sourceCloudName: 'GOOGLE_SHARED_DRIVES' },
        findFoldersByName: async () => [],
      });
      const drive = r.checks.find((c) => /Shared Drive resolved/i.test(c.name));
      assert.strictEqual(drive.status, 'FAIL');
      assert.ok(/exists anywhere/i.test(drive.detail), 'distinguishes missing data from a wrong drive');
      assert.strictEqual(r.overallStatus, 'FAIL');
    },
  },
  {
    name: 'a source folder that is only in My Drive says so, rather than "not found"',
    async run() {
      // A Shared Drive run pointed at My Drive data: the folder exists, just not where the run looks.
      const r = await runScenario({
        noSharedDriveName: true,
        context: { sourceCloudName: 'GOOGLE_SHARED_DRIVES' },
        findFoldersByName: async () => [{ id: 'f1', name: 'QA' }],
      });
      const drive = r.checks.find((c) => /Shared Drive resolved/i.test(c.name));
      assert.strictEqual(drive.status, 'FAIL');
      assert.ok(/My Drive/.test(drive.detail), 'points at the real problem — wrong source type');
      assert.strictEqual(r.overallStatus, 'FAIL');
    },
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const results = [];
  for (const s of SCENARIOS) {
    try {
      await s.run();
      results.push({ name: s.name, ok: true });
    } catch (err) {
      results.push({ name: s.name, ok: false, error: err.message });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const rate = ((passed / total) * 100).toFixed(1);

  for (const r of results) {
    if (!r.ok) console.log(`  FAIL  ${r.name}\n        ${r.error}`);
  }
  console.log(`contentCombinationSuite.test.js: ${passed}/${total} scenarios passed (${rate}%)`);

  if (passed !== total) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
