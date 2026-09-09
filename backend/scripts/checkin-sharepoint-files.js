/**
 * Check in every checked-out file under a SharePoint folder, so the destination user can see them.
 *
 * Why this exists: the QA destination library has "Require documents to be checked out" = Yes, so
 * CloudFuze's migration leaves every migrated file checked out to "SharePoint App". The bytes are
 * present and our app-only reads see them, but no other user can — which is why validation check
 * "1b. Destination files available to the user" fails with 44 of 44 invisible. Presence is not
 * availability.
 *
 * The real fix is at the destination: Library settings -> Versioning settings -> "Require documents
 * to be checked out" = No. Until that is changed, this script clears the backlog after each run.
 *
 * Usage (from backend/):
 *   node scripts/checkin-sharepoint-files.js
 *   node scripts/checkin-sharepoint-files.js "/Agent Shared Drive" --dry-run
 *   node scripts/checkin-sharepoint-files.js "/Agent Shared Drive" --depth=30
 *   node scripts/checkin-sharepoint-files.js --email=granger@gajha.com   (selects the Graph tenant)
 *
 * Site comes from SHAREPOINT_HOSTNAME + SHAREPOINT_SITE_PATH. --email picks the Graph tenant the
 * same way the validator does — the destination address, e.g. --email=granger@gajha.com. Without it
 * the default tenant is used, which answers "Invalid hostname for this tenancy" for another tenant.
 */
const axios = require('axios');
const env = require('../src/config/env');
const logger = require('../src/utils/logger');
const sharepointClient = require('../src/clients/sharepointClient');
const { getAppAccessToken, getMsTenant } = require('../src/clients/outlookClient');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const depthArg = args.find((a) => a.startsWith('--depth='));
const maxDepth = depthArg ? parseInt(depthArg.split('=')[1], 10) : 30;
const rootPath = args.find((a) => !a.startsWith('--')) || '/Agent Shared Drive';
const emailArg = args.find((a) => a.startsWith('--email='));

/** POST .../items/{id}/checkin — 204 on success. */
async function checkin(siteId, itemId, email) {
  const tenant = getMsTenant(email || '');
  const token = await getAppAccessToken(tenant || '1');
  await axios.post(
    `${GRAPH_BASE}/sites/${siteId}/drive/items/${itemId}/checkin`,
    { comment: 'Checked in by QA agent so the destination user can see the migrated file.' },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
  );
}

async function main() {
  const hostname = env.SHAREPOINT_HOSTNAME;
  const sitePath = env.SHAREPOINT_SITE_PATH;
  // Selects the tenant for the app-only token, nothing else.
  const email = emailArg ? emailArg.split('=').slice(1).join('=') : '';
  if (!hostname || !sitePath) {
    console.error('SHAREPOINT_HOSTNAME and SHAREPOINT_SITE_PATH must be set in .env');
    process.exit(1);
  }

  console.log(`site      : ${hostname}${sitePath}`);
  console.log(`folder    : ${rootPath}`);
  console.log(`mode      : ${dryRun ? 'DRY RUN — nothing will be changed' : 'CHECK IN'}`);

  const site = await sharepointClient.getSite(hostname, sitePath, email);
  if (!site?.id) {
    console.error('Could not resolve the site.');
    process.exit(1);
  }

  const tree = await sharepointClient.buildFolderTree(site.id, rootPath, email, maxDepth);
  const files = tree.filter((t) => t.type === 'file');
  const stuck = files.filter((t) => t.checkedOut && t.id);

  console.log(`files     : ${files.length} found, ${stuck.length} checked out`);
  if (stuck.length === 0) {
    console.log('\nNothing to do — every file is already checked in and visible.');
    return;
  }

  const by = [...new Set(stuck.map((s) => s.checkedOutBy).filter(Boolean))];
  if (by.length) console.log(`checked out by: ${by.join(', ')}`);

  if (dryRun) {
    stuck.slice(0, 20).forEach((s) => console.log(`  would check in: ${s.path}`));
    if (stuck.length > 20) console.log(`  … and ${stuck.length - 20} more`);
    return;
  }

  let ok = 0;
  const failed = [];
  for (const item of stuck) {
    try {
      await checkin(site.id, item.id, email);
      ok++;
    } catch (err) {
      const detail = err?.response?.data?.error?.message || err.message;
      failed.push(`${item.path}: ${detail}`);
    }
  }

  console.log(`\nchecked in: ${ok}/${stuck.length}`);
  if (failed.length) {
    console.log(`failed    : ${failed.length}`);
    failed.slice(0, 10).forEach((f) => console.log(`  ${f}`));
  }
  console.log(
    ok === stuck.length
      ? '\nAll files are now visible to the destination user. Refresh SharePoint.'
      : '\nSome files could not be checked in — see above.'
  );
}

main().catch((err) => {
  logger.error(`checkin-sharepoint-files failed: ${err.message}`);
  console.error(err?.response?.data || err.message);
  process.exit(1);
});
