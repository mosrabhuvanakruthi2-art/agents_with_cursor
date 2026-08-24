/**
 * Probe ONE CloudFuze content migration — no seeding, no validation, no bug ticket.
 *
 *   node scripts/content-migration-probe.js
 *
 * Why this exists: the full flow re-seeds (~4 min) and validates (~2 min) on every run, so testing a
 * change to the CloudFuze request costs seven minutes to learn one thing. This drives just the
 * migration step against data that already exists, then reports the two numbers that matter — what
 * CloudFuze says it moved, and what actually landed in SharePoint.
 *
 * It migrates REAL data on the real server. It is a debugging tool, not part of the flow.
 *
 * Options (all optional):
 *   --drive   <name>   Shared Drive holding the source folder. Default GOOGLE_SHARED_DRIVE_NAME.
 *   --folder  <name>   Source folder inside that drive.        Default "Agent Shared Drive".
 *   --dest    <path>   Destination path.                       Default "QA/Documents".
 *   --source  <email>  Source user for the CloudFuze pair.     Default erik@filefuze.co
 *   --read-as <email>  Google account used to READ the Shared Drive. Default --source.
 *                      Needed when the migrating user is an external member with no token here.
 *   --to      <email>  Destination user.                       Default granger@gajha.com
 *   --site    <path>   SharePoint site path for the after-check. Default SHAREPOINT_SITE_PATH.
 *   --user    <email>  CloudFuze login. Default bhuvana.mosra@cloudfuze.com (what the wizard uses).
 *   --dry-run          Resolve everything and print the plan, but do not start a migration.
 */
const path = require('path');

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
  }
  return out;
}

const args = parseArgs(process.argv);
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const env = require(path.join(__dirname, '..', 'src', 'config', 'env'));
const driveClient = require(path.join(__dirname, '..', 'src', 'clients', 'driveClient'));
const sharepointClient = require(path.join(__dirname, '..', 'src', 'clients', 'sharepointClient'));
const migrationClient = require(path.join(__dirname, '..', 'src', 'clients', 'migrationClient'));

const SOURCE_EMAIL = args.source || 'erik@filefuze.co';
const DEST_EMAIL = args.to || 'granger@gajha.com';
// The migrating user is not always readable from here: an external Shared Drive member (different
// Google domain) has no stored OAuth token and cannot be impersonated, so reading the source tree
// as them fails before CloudFuze is touched. Shared Drive content is identical for every member,
// so read as any credentialed member while still migrating the real pair.
const READ_AS = args['read-as'] || SOURCE_EMAIL;
const DRIVE_NAME = args.drive || env.GOOGLE_SHARED_DRIVE_NAME;
const FOLDER_NAME = args.folder || 'Agent Shared Drive';
const DEST_PATH = args.dest || 'QA/Documents';
const SITE_PATH = args.site || env.SHAREPOINT_SITE_PATH;
const SITE_HOST = env.SHAREPOINT_HOSTNAME;

const line = (s) => console.log(s);
const rule = () => line('─'.repeat(72));

/** Items directly under the destination folder, or null when the folder is absent. */
async function destSnapshot(siteId) {
  return sharepointClient
    .listFolderChildren(siteId, `/${FOLDER_NAME}`, DEST_EMAIL)
    .catch(() => null);
}

(async () => {
  rule();
  line('CloudFuze content migration probe — migration step only');
  rule();

  // ── Source: the folder must already exist; this script never seeds ──────────
  const drive = await driveClient.resolveSharedDriveByName(DRIVE_NAME, READ_AS);
  if (!drive) throw new Error(`Shared Drive "${DRIVE_NAME}" is not visible to ${READ_AS}`);
  const hits = (await driveClient.findFoldersByName(FOLDER_NAME, READ_AS))
    .filter((h) => h.driveId === drive.id);
  if (hits.length === 0) {
    throw new Error(`"${FOLDER_NAME}" does not exist in "${drive.name}" — seed it first `
      + '(node scripts/seed-drive-test-data.js …)');
  }
  const folderId = hits[0].id;
  const tree = await driveClient.buildFolderTree(folderId, READ_AS, { maxDepth: 25, driveId: drive.id });
  line(`source     : "${FOLDER_NAME}" in "${drive.name}"`);
  line(`             ${tree.length} items (${tree.filter((i) => i.type === 'file').length} files)`);
  line(`             folderId=${folderId}  driveId=${drive.id}`);
  if (READ_AS !== SOURCE_EMAIL) line(`             read as ${READ_AS}; migrating as ${SOURCE_EMAIL}`);

  // ── Destination: record what is there BEFORE, so "did anything arrive" is answerable ──
  const site = await sharepointClient.getSite(SITE_HOST, SITE_PATH, DEST_EMAIL);
  const before = await destSnapshot(site.id);
  line(`destination: ${SITE_HOST}${SITE_PATH} → ${DEST_PATH}`);
  line(`             "${FOLDER_NAME}" before: ${before === null ? 'does not exist' : `${before.length} item(s)`}`);

  // ── CloudFuze clouds ────────────────────────────────────────────────────────
  migrationClient.setRuntimeConfig({
    baseUrl: env.CONTENT_MIGRATION_SERVER_URL || 'https://qarelease.cloudfuze.com',
    // Credentials come from .env — the wizard's password is deliberately never persisted.
    // CONTENT_MIGRATION_SERVER_EMAIL/_PASSWORD are the documented vars for this server; if they are
    // stale the login succeeds but getClouds 403s, which is what a wrong password looks like here.
    email: args.user || env.CONTENT_MIGRATION_SERVER_EMAIL,
    password: env.CONTENT_MIGRATION_SERVER_PASSWORD,
  });
  await migrationClient.login();
  const clouds = await migrationClient.getClouds();
  const src = migrationClient.findCloudId(clouds, SOURCE_EMAIL, 'GOOGLE_SHARED_DRIVES');
  const dst = migrationClient.findCloudId(clouds, DEST_EMAIL, 'SHAREPOINT_ONLINE_BUSINESS');
  if (!src || !dst) throw new Error(`cloud lookup failed — src=${!!src} dst=${!!dst}`);
  line(`clouds     : ${src.id} (${src.cloudName}) → ${dst.id} (${dst.cloudName})`);
  rule();

  if (args.dryRun) {
    line('--dry-run: resolved everything, no migration started.');
    return;
  }

  // ── Drive the migration exactly as MigrationAgent does ──────────────────────
  const context = {
    domain: 'content',
    sourceProvider: 'googleshareddrive',
    destinationProvider: 'sharepoint',
    sourceEmail: SOURCE_EMAIL,
    destinationEmail: DEST_EMAIL,
    sourceCloudId: src.id,
    destCloudId: dst.id,
    sourceCloudName: src.cloudName,
    destCloudName: dst.cloudName,
    sourceTestDataPath: `/${FOLDER_NAME}`,
    sourceRootId: folderId,
    sourceDriveId: drive.id,
    destinationPath: DEST_PATH,
    migrationType: 'FULL',
    userEmailMappings: [{ sourceEmail: SOURCE_EMAIL, destinationEmail: DEST_EMAIL }],
    userFolderMappings: [{
      sourceEmail: SOURCE_EMAIL,
      destinationEmail: DEST_EMAIL,
      sourcePath: `/${FOLDER_NAME}`,
      sourceRootId: folderId,
      destinationPath: DEST_PATH,
    }],
  };

  const res = await migrationClient.triggerMigration(context);
  line(`job        : ${res.jobId}`);
  const status = await migrationClient.pollReports(false, SOURCE_EMAIL, { maxMinutes: 6, intervalMs: 20000 });
  line(`status     : ${status}`);

  // ── Did anything actually land? ─────────────────────────────────────────────
  const after = await destSnapshot(site.id);
  rule();
  line(`RESULT     : "${FOLDER_NAME}" after: ${after === null ? 'does not exist' : `${after.length} item(s)`}`);
  if (after && after.length > 0) {
    line(`             ${after.slice(0, 12).map((k) => k.name).join(', ')}`);
    line('             ✅ files arrived');
  } else {
    line('             ❌ nothing arrived — download the job report for this job id');
  }
  rule();
})()
  .catch((err) => {
    console.error(`\nPROBE FAILED: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    migrationClient.clearRuntimeConfig();
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
