/**
 * Run: npm test  (from backend/)
 *
 * `useExistingSource` must never let cleanup empty the source folder.
 *
 * This is a DATA LOSS guard, and the failure it prevents reports itself as success. Measured on
 * execution 6552614f:
 *
 *     11:57:55  CleanupAgent: "/QA-Automation" emptied — 10 of 10 top-level items deleted
 *     11:57:58  Content: useExistingSource=true → skipping data creation
 *     11:57:59  Step 1: Skipping ShareFileTestDataAgent
 *     11:59:47  CloudFuze: PROCESSED, workspace scanned 1 item(s)
 *     11:59:50  Full flow COMPLETED
 *
 * Cleanup ran before the flag was acted on and emptied the folder the flag exists to preserve;
 * seeding was skipped, so nothing put the data back; and the run finished GREEN over a migration
 * that moved one item out of an empty tree. The two options are independent checkboxes in the
 * wizard, so anyone ticking "use existing source folder" destroys their own source and is told it
 * worked.
 *
 * Asserted behaviourally against the real function rather than by reading the source, because the
 * thing that matters is that no delete call is made — a guard can be present and still be wrong.
 */
const assert = require('assert');

const CleanupAgent = require('../src/agents/cleanup/CleanupAgent');
const sharefileClient = require('../src/clients/sharefileClient');
const sharepointClient = require('../src/clients/sharepointClient');

const { cleanContentSides } = CleanupAgent;
const SILENT = { info() {}, warn() {}, error() {} };

function freshSummary() {
  return {
    sourceContent: { foldersEmptied: 0, itemsDeleted: 0, errors: [] },
    destContent: { foldersDeleted: 0, errors: [] },
  };
}

function baseContext(extra) {
  return {
    executionId: 'test-ues',
    domain: 'content',
    mode: 'content',
    sourceProvider: 'sharefile',
    destinationProvider: 'sharepoint',
    sourceEmail: 'zara@storefuze.com',
    destinationEmail: 'granger@gajha.com',
    sourceFolderName: 'QA-Automation',
    destinationPath: '/QA/Documents/',
    contentUserFolders: [{
      sourceEmail: 'zara@storefuze.com',
      destinationEmail: 'granger@gajha.com',
      sourceFolderName: 'QA-Automation',
      destinationPath: '/QA/Documents/',
    }],
    ...extra,
  };
}

/**
 * Stub every outbound call cleanup can make, and record the destructive ones. The source listing
 * returns a populated folder so that a cleanup which DID run would have something to delete —
 * a test whose source is empty would pass whether the guard worked or not.
 */
function withStubs(fn) {
  const real = {
    getRoot: sharefileClient.getRoot,
    listChildren: sharefileClient.listChildren,
    deleteItem: sharefileClient.deleteItem,
    resolveTenantHostname: sharepointClient.resolveTenantHostname,
    getSite: sharepointClient.getSite,
    listFolderChildren: sharepointClient.listFolderChildren,
    deleteItemByPath: sharepointClient.deleteItemByPath,
  };
  const calls = { sourceDeletes: [], destDeletes: [] };

  sharefileClient.getRoot = async () => ({ id: 'root', name: 'Personal Folders' });
  sharefileClient.listChildren = async (email, parentId) => {
    if (parentId === 'root') return [{ id: 'qa', name: 'QA-Automation', type: 'folder' }];
    return [
      { id: 'c1', name: '01-Root-Files', type: 'folder' },
      { id: 'c2', name: '02-Nested-Structure', type: 'folder' },
    ];
  };
  sharefileClient.deleteItem = async (email, id) => { calls.sourceDeletes.push(id); return { id }; };

  sharepointClient.resolveTenantHostname = async () => 'trydemos.sharepoint.com';
  sharepointClient.getSite = async () => ({ id: 'site-1' });
  sharepointClient.listFolderChildren = async () => ([
    { name: 'QA-Automation', folder: {} },
    { name: 'Someone Elses Folder', folder: {} },
  ]);
  sharepointClient.deleteItemByPath = async (siteId, p) => { calls.destDeletes.push(p); };

  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      sharefileClient.getRoot = real.getRoot;
      sharefileClient.listChildren = real.listChildren;
      sharefileClient.deleteItem = real.deleteItem;
      sharepointClient.resolveTenantHostname = real.resolveTenantHostname;
      sharepointClient.getSite = real.getSite;
      sharepointClient.listFolderChildren = real.listFolderChildren;
      sharepointClient.deleteItemByPath = real.deleteItemByPath;
    });
}

async function testUseExistingSourceLeavesSourceAlone() {
  await withStubs(async (calls) => {
    const summary = freshSummary();
    await cleanContentSides(baseContext({ useExistingSource: true }), SILENT, summary);

    assert.strictEqual(calls.sourceDeletes.length, 0,
      'useExistingSource means MIGRATE WHAT IS THERE — cleanup must not delete a single source '
      + 'item, or seeding (which is skipped) never puts it back and the run migrates an empty tree');

    // The destination is still cleaned: the flag preserves the source, it does not license
    // migrating on top of the previous run's output.
    assert.deepStrictEqual(calls.destDeletes, ['/QA-Automation'],
      'the destination must still be cleaned, and only the seeded name');

    assert.ok(
      summary.sourceContent.errors.some((e) => /useExistingSource/.test(e)),
      'the summary must say WHY the source was left alone — a silent skip is indistinguishable '
      + 'from a cleanup that failed'
    );
  });
  console.log('  useExistingSource: source untouched, destination still cleaned: ok');
}

async function testWithoutTheFlagTheSourceIsStillCleaned() {
  await withStubs(async (calls) => {
    const summary = freshSummary();
    await cleanContentSides(baseContext({ useExistingSource: false }), SILENT, summary);

    // The other half of the guard. A fix that simply stopped cleaning would also pass the test
    // above, and would reintroduce the defect this file's header records: seeding on top of the
    // previous run, version chains growing 10 -> 40, and "extra"/"misplaced" findings blamed on
    // the migration.
    assert.deepStrictEqual(calls.sourceDeletes.sort(), ['c1', 'c2'],
      'without the flag the source folder must still be emptied, child by child');
    assert.strictEqual(summary.sourceContent.foldersEmptied, 1);
  });
  console.log('  without the flag the source is still emptied: ok');
}

(async () => {
  await testUseExistingSourceLeavesSourceAlone();
  await testWithoutTheFlagTheSourceIsStillCleaned();
  console.log('useExistingSourceCleanup.test.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
