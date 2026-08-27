/**
 * One-off remediation: check in every checked-out file under a destination SharePoint folder.
 *
 * Files migrated by CloudFuze land checked out when the destination library has
 * "Require documents to be checked out" = Yes. Checked-out files are invisible to everyone
 * except the checking-out identity, so the QA report flags them (row "1b. Destination files
 * available to the user"). Checking them in makes them visible without touching the bytes.
 *
 * Read-mostly: the only write is POST /checkin per file. Run with --dry-run to list only.
 * Not wired into any npm script.
 */
const axios = require('axios');
const { getAppAccessToken, getMsTenant } = require('../src/clients/outlookClient');
const { retryWithBackoff } = require('../src/utils/retry');
const sp = require('../src/clients/sharepointClient');

const GRAPH = 'https://graph.microsoft.com/v1.0';

const HOST = process.env.SP_HOST || 'trydemos.sharepoint.com';
const SITE = process.env.SP_SITE || '/sites/QA';
const EMAIL = process.env.SP_EMAIL || 'granger@gajha.com';
const ROOT = process.env.SP_ROOT || '/Agent Shared Drive';
const DRY = process.argv.includes('--dry-run');

const SELECT = 'id,name,size,folder,file,publication';

async function token() {
  return getAppAccessToken(getMsTenant(EMAIL) || '1');
}

/** Recursively collect every file under folderPath, with its publication facet. */
async function collect(siteId, folderPath, out = [], depth = 0) {
  if (depth > 12) return out;
  let kids;
  try {
    kids = await sp.listFolderChildren(siteId, folderPath, EMAIL, { select: SELECT });
  } catch (e) {
    console.log(`  ! cannot list "${folderPath}": ${e.message.slice(0, 100)}`);
    return out;
  }
  for (const k of kids) {
    if (k.folder) await collect(siteId, `${folderPath}/${k.name}`, out, depth + 1);
    else out.push({ id: k.id, name: k.name, path: `${folderPath}/${k.name}`, level: k.publication?.level || null });
  }
  return out;
}

async function checkin(driveId, itemId) {
  const t = await token();
  return retryWithBackoff(
    () => axios.post(
      `${GRAPH}/drives/${driveId}/items/${itemId}/checkin`,
      { comment: 'Checked in by Migration QA agent so migrated files are visible to the destination user' },
      { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    ),
    { label: 'SharePoint checkin', maxRetries: 2 }
  );
}

(async () => {
  const site = await sp.getSite(HOST, SITE, EMAIL);
  const drive = await sp.getDefaultDrive(site.id, EMAIL);
  console.log(`site  ${HOST}${SITE}`);
  console.log(`drive ${drive.id}`);
  console.log(`root  ${ROOT}${DRY ? '   [DRY RUN]' : ''}\n`);

  const files = await collect(site.id, ROOT);
  const stuck = files.filter((f) => f.level === 'checkout');
  console.log(`${files.length} file(s) under root; ${stuck.length} checked out\n`);

  if (!stuck.length) { console.log('Nothing to check in.'); process.exit(0); }
  if (DRY) {
    for (const f of stuck) console.log(`  would check in: ${f.path}`);
    process.exit(0);
  }

  let ok = 0;
  const failed = [];
  for (const f of stuck) {
    try {
      await checkin(drive.id, f.id);
      ok += 1;
      console.log(`  [${String(ok).padStart(2)}/${stuck.length}] checked in  ${f.path}`);
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      failed.push(`${f.path}: ${msg.slice(0, 120)}`);
      console.log(`  FAILED  ${f.path} -> ${msg.slice(0, 120)}`);
    }
  }

  console.log(`\nchecked in ${ok}/${stuck.length}`);
  if (failed.length) {
    console.log(`\n${failed.length} failure(s):`);
    for (const f of failed) console.log(`  ${f}`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message, e.response?.status || ''); process.exit(1); });
