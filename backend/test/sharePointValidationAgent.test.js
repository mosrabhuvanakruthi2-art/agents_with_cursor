/**
 * Run: npm test  (from backend/)
 *
 * The SharePoint DESTINATION-side agent — shared by every content combination that lands in
 * SharePoint, so a mistake here is a mistake in all of them.
 *
 * The migrated-root probe is the part worth testing hardest: CloudFuze may rename a folder
 * (SharePoint-invalid characters → `_` or `-`) and may append a counter when the name is taken, so
 * "the folder is missing" and "the folder is somewhere I did not look" are easy to confuse. The
 * scenario suite cannot cover this — its fixture always matches on the first candidate.
 */
const assert = require('assert');

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.SHAREPOINT_HOSTNAME = 'qa.sharepoint.com';
process.env.SHAREPOINT_SITE_PATH = '/sites/QA';

const spPath = require.resolve('../src/clients/sharepointClient');
const olPath = require.resolve('../src/clients/outlookClient');
const agentPath = require.resolve('../src/agents/sharepoint/SharePointValidationAgent');
require(spPath);
require(olPath);
const realSp = { ...require.cache[spPath].exports };
const realOl = { ...require.cache[olPath].exports };

/** Build the agent with the destination client stubbed. `existing` = paths that exist in SharePoint. */
function agentWith({ existing = [], tree = [], perms = {}, versions = {}, messages = [], getSite, findSiteByName, childrenByPath, throwOn } = {}) {
  const probed = [];
  require.cache[spPath].exports = {
    ...realSp,
    getSite: getSite || (async () => ({ id: 'site1' })),
    findSiteByName: findSiteByName || (async () => null),
    getFolderItem: async (siteId, p) => {
      probed.push(p);
      if (throwOn && throwOn === p) throw new Error('boom');
      return existing.includes(p) ? { id: `id${p}`, name: p.split('/').filter(Boolean).pop() } : null;
    },
    listFolderChildren: async (s, p) => (childrenByPath ? (childrenByPath[p] || []) : []),
    buildFolderTree: async () => tree,
    getItemPermissions: async (s, p) => perms[p] || { permissions: [], links: [] },
    getItemVersions: async (s, p) => (p in versions ? { totalVersions: versions[p] } : { totalVersions: 0 }),
    downloadItemContent: async () => Buffer.from('bytes'),
  };
  require.cache[olPath].exports = { ...realOl, getMessages: async () => messages };
  delete require.cache[agentPath];
  const Agent = require(agentPath);
  return { agent: new Agent(), probed };
}

function restore() {
  require.cache[spPath].exports = realSp;
  require.cache[olPath].exports = realOl;
  delete require.cache[agentPath];
}

async function testResolveSite() {
  let { agent } = agentWith({});
  let res = await agent.resolveSite({ destinationEmail: 'q@d.com' });
  assert.strictEqual(res.siteId, 'site1');
  assert.strictEqual(res.check.status, 'PASS');
  assert.ok(res.check.detail.includes('qa.sharepoint.com/sites/QA'), 'reports which site');

  // A site that resolves but returns no id must FAIL, not silently continue
  ({ agent } = agentWith({ getSite: async () => ({}) }));
  res = await agent.resolveSite({ destinationEmail: 'q@d.com' });
  assert.strictEqual(res.siteId, null);
  assert.strictEqual(res.check.status, 'FAIL');

  // A throwing getSite is a FAIL row, not an exception escaping into the run
  ({ agent } = agentWith({ getSite: async () => { throw new Error('403 forbidden'); } }));
  res = await agent.resolveSite({ destinationEmail: 'q@d.com' });
  assert.strictEqual(res.siteId, null);
  assert.strictEqual(res.check.status, 'FAIL');
  assert.ok(/403/.test(res.check.detail), 'the reason survives');

  // Context overrides env
  ({ agent } = agentWith({}));
  res = await agent.resolveSite({ destinationEmail: 'q@d.com', sharepointHostname: 'other.sharepoint.com', sharepointSitePath: '/sites/Other' });
  assert.ok(res.check.detail.includes('other.sharepoint.com/sites/Other'));
}

// The migration destination path names the site the data landed in. Validating the configured site
// instead compares two unrelated places and reads as a clean miss — the failure this guards.
async function testResolveSiteFromDestinationPath() {
  // A site path only the tenant knows the slug for. getSite answers for real paths, 404s otherwise.
  const pathAware = (known) => async (host, p) => {
    if (!known.includes(p)) { const e = new Error('404'); e.response = { status: 404 }; throw e; }
    return { id: `id:${p}`, webUrl: `https://${host}${p}` };
  };

  // Preferred route: the slug is derived from the name and read directly — no search permission needed
  let { agent } = agentWith({
    getSite: pathAware(['/sites/QA', '/sites/SANITYDATAA']),
    findSiteByName: async () => { throw new Error('search must not be needed when the path resolves'); },
  });
  let res = await agent.resolveSite({ destinationEmail: 'q@d.com' }, 'SANITY DATAA');
  assert.strictEqual(res.sitePath, '/sites/SANITYDATAA');
  assert.strictEqual(res.check.status, 'PASS');
  assert.ok(res.check.detail.includes('SANITY DATAA'), 'says which site it used and why');

  // A site whose slug is nothing like its name still resolves, via search
  ({ agent } = agentWith({
    getSite: pathAware(['/sites/QA']),
    findSiteByName: async () => ({ id: 'site2', webUrl: 'https://qa.sharepoint.com/sites/Renamed' }),
  }));
  res = await agent.resolveSite({ destinationEmail: 'q@d.com' }, 'SANITY DATAA');
  assert.strictEqual(res.siteId, 'site2');
  assert.strictEqual(res.sitePath, '/sites/Renamed');

  // Neither route works — FAIL, and never a silent fallback to the configured site
  ({ agent } = agentWith({ getSite: pathAware(['/sites/QA']), findSiteByName: async () => null }));
  res = await agent.resolveSite({ destinationEmail: 'q@d.com' }, 'Missing Site');
  assert.strictEqual(res.siteId, null);
  assert.strictEqual(res.check.status, 'FAIL');
  assert.ok(/Refusing to validate/.test(res.check.detail), 'says it refused to substitute');
  assert.ok(/sites[/]MissingSite/.test(res.check.detail), 'lists the slugs it probed');

  // Search blocked by permissions reads as a permission problem, not "site does not exist"
  ({ agent } = agentWith({
    getSite: pathAware(['/sites/QA']),
    findSiteByName: async () => { const e = new Error('403'); e.response = { status: 403 }; throw e; },
  }));
  res = await agent.resolveSite({ destinationEmail: 'q@d.com' }, 'Missing Site');
  assert.strictEqual(res.check.status, 'FAIL');
  assert.ok(/Sites[.]Read[.]All/.test(res.check.detail), 'names the permission that would fix it');

  // Hint matching the configured site (spacing/case aside) keeps the normal path — no probing at all
  ({ agent } = agentWith({ findSiteByName: async () => { throw new Error('must not be called'); } }));
  res = await agent.resolveSite({ destinationEmail: 'q@d.com' }, 'qa');
  assert.strictEqual(res.siteId, 'site1');
  assert.strictEqual(res.check.status, 'PASS');
}

async function testFindMigratedRootExactName() {
  const { agent } = agentWith({ existing: ['/Docs'] });
  const res = await agent.findMigratedRoot('site1', '/', 'Docs', 'q@d.com');
  assert.strictEqual(res.path, '/Docs');
  assert.ok(res.item);
  assert.strictEqual(res.renameNote, '', 'an unchanged name carries no rename note');
}

async function testFindMigratedRootRenamed() {
  // Underscore replacement
  let { agent, probed } = agentWith({ existing: ['/Special _ Chars'] });
  let res = await agent.findMigratedRoot('site1', '/', 'Special : Chars', 'q@d.com');
  assert.strictEqual(res.path, '/Special _ Chars', 'finds the underscore-renamed folder');
  assert.ok(probed[0] === '/Special : Chars', 'probes the unchanged name first');

  // Hyphen replacement — the variant a single-replacement probe would miss
  ({ agent } = agentWith({ existing: ['/Special - Chars'] }));
  res = await agent.findMigratedRoot('site1', '/', 'Special : Chars', 'q@d.com');
  assert.strictEqual(res.path, '/Special - Chars', 'finds the hyphen-renamed folder');

  // Nothing anywhere → not found, and NOT a bogus placeholder
  ({ agent } = agentWith({ existing: [] }));
  res = await agent.findMigratedRoot('site1', '/', 'Docs', 'q@d.com');
  assert.strictEqual(res.item, null, 'a missing root is null so the caller can FAIL');
  assert.strictEqual(res.path, null);
}

async function testFindMigratedRootDedupCounter() {
  // CloudFuze appends " 1" when the name is already taken
  let { agent } = agentWith({ existing: ['/Docs 1'] });
  let res = await agent.findMigratedRoot('site1', '/', 'Docs', 'q@d.com');
  assert.strictEqual(res.path, '/Docs 1');
  assert.ok(/appended a counter/.test(res.renameNote), 'and the report says why the name differs');

  // Later counters are probed too
  ({ agent } = agentWith({ existing: ['/Docs 4'] }));
  res = await agent.findMigratedRoot('site1', '/', 'Docs', 'q@d.com');
  assert.strictEqual(res.path, '/Docs 4');

  // Beyond the probe window it is reported missing rather than found by accident
  ({ agent } = agentWith({ existing: ['/Docs 99'] }));
  res = await agent.findMigratedRoot('site1', '/', 'Docs', 'q@d.com');
  assert.strictEqual(res.item, null, 'the probe window is bounded, and says nothing found');

  // The unchanged name wins over a dedup variant when both exist
  ({ agent } = agentWith({ existing: ['/Docs', '/Docs 1'] }));
  res = await agent.findMigratedRoot('site1', '/', 'Docs', 'q@d.com');
  assert.strictEqual(res.path, '/Docs', 'exact match takes precedence');
}

// A failed run leaves an empty folder behind; the next run lands its content in "<name> 1". Probing
// in order would compare against the empty shell and report a successful migration as a total loss.
async function testFindMigratedRootPrefersTheRootWithContent() {
  let { agent } = agentWith({
    existing: ['/Docs', '/Docs 1'],
    childrenByPath: { '/Docs': [], '/Docs 1': [{ name: 'a.txt' }, { name: 'b.txt' }] },
  });
  let res = await agent.findMigratedRoot('site1', '/', 'Docs', 'q@d.com');
  assert.strictEqual(res.path, '/Docs 1', 'the folder holding content is the migrated root');

  // The plain name wins when it is the one with content
  ({ agent } = agentWith({
    existing: ['/Docs', '/Docs 1'],
    childrenByPath: { '/Docs': [{ name: 'a.txt' }], '/Docs 1': [] },
  }));
  res = await agent.findMigratedRoot('site1', '/', 'Docs', 'q@d.com');
  assert.strictEqual(res.path, '/Docs');

  // Every candidate empty → still returns one, so a genuinely empty migration reports as empty
  // rather than as "destination not found".
  ({ agent } = agentWith({
    existing: ['/Docs', '/Docs 1'],
    childrenByPath: { '/Docs': [], '/Docs 1': [] },
  }));
  res = await agent.findMigratedRoot('site1', '/', 'Docs', 'q@d.com');
  assert.strictEqual(res.path, '/Docs');
  assert.ok(res.item, 'an empty root is still a found root');
}

async function testFindMigratedRootWholeAccount() {
  // No source folder name = whole-account migration: items land under the destination base itself
  let { agent } = agentWith({ existing: ['/Documents'] });
  let res = await agent.findMigratedRoot('site1', '/Documents', '', 'q@d.com');
  assert.strictEqual(res.path, '/Documents');
  assert.ok(res.item);

  // If that base does NOT exist, the agent must report null — returning a placeholder made the
  // caller print "Destination location: PASS" for a path it never found.
  ({ agent } = agentWith({ existing: [] }));
  res = await agent.findMigratedRoot('site1', '/Documents', '', 'q@d.com');
  assert.strictEqual(res.item, null, 'an unreadable destination root is not a pass');
  assert.strictEqual(res.path, null);
}

async function testReadHelpersSwallowFailures() {
  const { agent } = agentWith({
    tree: [{ path: '/root/a.pdf', name: 'a.pdf', type: 'file' }],
    perms: { '/root/a.pdf': { permissions: [{ email: 'x@d.com', roles: ['read'] }], links: [] } },
    versions: { '/root/a.pdf': 5 },
  });

  // readTree relativizes to the migrated root so it compares against source-relative paths
  const tree = await agent.readTree('site1', '/root', 'q@d.com', 5);
  assert.strictEqual(tree[0].path, '/a.pdf', 'destination paths are relativized');

  assert.strictEqual((await agent.readPermissions('site1', '/root/a.pdf', 'q@d.com')).permissions.length, 1);
  assert.strictEqual(await agent.readVersionCount('site1', '/root/a.pdf', 'q@d.com'), 5);

  // Unreadable items degrade to empty rather than throwing mid-run
  require.cache[spPath].exports = {
    ...require.cache[spPath].exports,
    getItemPermissions: async () => { throw new Error('403'); },
    getItemVersions: async () => { throw new Error('403'); },
  };
  assert.deepStrictEqual(await agent.readPermissions('site1', '/x', 'q@d.com'), { permissions: [], links: [] });
  assert.strictEqual(await agent.readVersionCount('site1', '/x', 'q@d.com'), 0);
}

async function testSharingNotifications() {
  const started = '2026-08-20T10:00:00.000Z';
  const mail = (subject, from, received) => ({
    subject, from: { emailAddress: { address: from } }, receivedDateTime: received,
  });

  // Clean: only unrelated mail
  let { agent } = agentWith({ messages: [mail('Lunch?', 'bob@d.com', '2026-08-20T11:00:00.000Z')] });
  let res = await agent.findSharingNotifications('q@d.com', started);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.leaks.length, 0);

  // A sharing notification after the run started IS a leak
  ({ agent } = agentWith({
    messages: [mail('Bob shared a file with you', 'no-reply@sharepointonline.com', '2026-08-20T11:00:00.000Z')],
  }));
  res = await agent.findSharingNotifications('q@d.com', started);
  assert.strictEqual(res.leaks.length, 1);

  // The same mail from BEFORE the run is not attributable to it
  ({ agent } = agentWith({
    messages: [mail('Bob shared a file with you', 'no-reply@sharepointonline.com', '2026-08-20T09:00:00.000Z')],
  }));
  res = await agent.findSharingNotifications('q@d.com', started);
  assert.strictEqual(res.leaks.length, 0, 'mail predating the run is ignored');

  // With no start time we cannot filter, so everything matching counts (conservative)
  ({ agent } = agentWith({
    messages: [mail('Bob shared a file with you', 'no-reply@sharepointonline.com', '2026-08-20T09:00:00.000Z')],
  }));
  res = await agent.findSharingNotifications('q@d.com', null);
  assert.strictEqual(res.leaks.length, 1);

  // A mailbox we cannot read is reported as NOT ok — never as "no leaks"
  ({ agent } = agentWith({}));
  require.cache[olPath].exports = { ...realOl, getMessages: async () => { throw new Error('401'); } };
  delete require.cache[agentPath];
  const Agent = require(agentPath);
  res = await new Agent().findSharingNotifications('q@d.com', started);
  assert.strictEqual(res.ok, false, 'an unreadable mailbox is not a pass');
  assert.ok(/401/.test(res.error));
}

async function run() {
  try {
    await testResolveSite();
    await testResolveSiteFromDestinationPath();
    await testFindMigratedRootExactName();
    await testFindMigratedRootRenamed();
    await testFindMigratedRootDedupCounter();
    await testFindMigratedRootPrefersTheRootWithContent();
    await testFindMigratedRootWholeAccount();
    await testReadHelpersSwallowFailures();
    await testSharingNotifications();
  } finally {
    restore();
  }
  console.log('sharePointValidationAgent.test.js: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
