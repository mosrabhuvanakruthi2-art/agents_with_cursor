/**
 * Seed the Google Drive / Shared Drive QA test data — seeding ONLY.
 *
 *   node scripts/seed-drive-test-data.js --source you@domain.com [options]
 *
 * Why this exists: POST /api/agents/create-test-data only handles mail (it hardcodes the Gmail and
 * Outlook test-data agents), and the content flow seeds inside runFullFlow — which also migrates and
 * validates. This script runs DriveTestDataAgent on its own, so the test account can be populated
 * without starting a server, touching CloudFuze, or running a migration.
 *
 * Options (flags override .env):
 *   --source   <email>   REQUIRED. The Drive account that will own the data.
 *   --drive    <name>    Shared Drive name. Falls back to GOOGLE_SHARED_DRIVE_NAME.
 *                        Omit both and it seeds into My Drive instead.
 *   --folder   <name>    Root folder to create/reuse. Default "Agent My Drive".
 *   --editor   <email>   Granted writer/contributor access.
 *   --viewer   <email>   Granted reader/viewer access.
 *   --group    <email>   Google group granted access. Falls back to GOOGLE_TEST_GROUP_EMAIL.
 *   --external <email>   User outside the source domain. Falls back to GOOGLE_TEST_EXTERNAL_EMAIL.
 *   --dry-run            Print what would be seeded and exit without writing anything.
 *
 * Re-running is safe: the root folder is reused if it already exists. Scenario folders inside it are
 * created again, so repeated runs add duplicates — clean the root folder first for a pristine set.
 */
const path = require('path');

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv);

if (!args.source) {
  console.error('ERROR: --source <email> is required.\n');
  console.error('Example:');
  console.error('  node scripts/seed-drive-test-data.js --source qa@yourdomain.com \\');
  console.error('    --drive "QA Shared Drive" --editor editor@yourdomain.com \\');
  console.error('    --viewer viewer@yourdomain.com --group qa-team@yourdomain.com');
  process.exit(1);
}

// Loaded after the arg check so --help-style mistakes fail fast and cheap.
const env = require(path.resolve(__dirname, '../src/config/env'));
const logger = require(path.resolve(__dirname, '../src/utils/logger'));
const DriveTestDataAgent = require(path.resolve(__dirname, '../src/agents/drive/DriveTestDataAgent'));
const driveClient = require(path.resolve(__dirname, '../src/clients/driveClient'));

const cfg = {
  sourceEmail: args.source,
  sourceSharedDriveName: args.drive || env.GOOGLE_SHARED_DRIVE_NAME || '',
  sourceFolderName: args.folder || 'Agent My Drive',
  editorEmail: args.editor || '',
  viewerEmail: args.viewer || '',
  groupEmail: args.group || env.GOOGLE_TEST_GROUP_EMAIL || '',
  externalEmail: args.external || env.GOOGLE_TEST_EXTERNAL_EMAIL || '',
};

/** Dimensions that are only exercised when their grantee is configured. */
function coverageNotes() {
  const notes = [];
  if (!cfg.sourceSharedDriveName) {
    notes.push('No --drive / GOOGLE_SHARED_DRIVE_NAME → seeding into MY DRIVE. The Content Manager '
      + '(fileOrganizer) role only exists on Shared Drives, so features 4.5 / 5.5 / 5.9 cannot be seeded.');
  }
  if (!cfg.editorEmail && !cfg.viewerEmail) {
    notes.push('No --editor / --viewer → user permissions (features 4.2–4.8) will not be seeded.');
  }
  if (!cfg.groupEmail) {
    notes.push('No --group / GOOGLE_TEST_GROUP_EMAIL → GROUP permissions will not be seeded. Group '
      + 'grants are the majority of the manual QA suite for this combination.');
  }
  if (!cfg.externalEmail) {
    notes.push('No --external / GOOGLE_TEST_EXTERNAL_EMAIL → external shares (feature 4.9) will not be seeded.');
  }
  return notes;
}

async function main() {
  console.log('\nDrive test-data seeding');
  console.log('─'.repeat(72));
  console.log(`  source account : ${cfg.sourceEmail}`);
  console.log(`  shared drive   : ${cfg.sourceSharedDriveName || '(none — My Drive)'}`);
  console.log(`  root folder    : ${cfg.sourceFolderName}`);
  console.log(`  editor         : ${cfg.editorEmail || '(none)'}`);
  console.log(`  viewer         : ${cfg.viewerEmail || '(none)'}`);
  console.log(`  group          : ${cfg.groupEmail || '(none)'}`);
  console.log(`  external user  : ${cfg.externalEmail || '(none)'}`);
  console.log('─'.repeat(72));

  const notes = coverageNotes();
  if (notes.length > 0) {
    console.log('\nCoverage gaps for this run:');
    for (const n of notes) console.log(`  - ${n}`);
  }

  // Fail early with a clear message rather than part-way through seeding.
  if (cfg.sourceSharedDriveName && !args.dryRun) {
    const drive = await driveClient.resolveSharedDriveByName(cfg.sourceSharedDriveName, cfg.sourceEmail);
    if (!drive) {
      console.error(`\nERROR: no Shared Drive named "${cfg.sourceSharedDriveName}" is visible to `
        + `${cfg.sourceEmail}. Check the name, and that the account is a member of that drive.`);
      process.exit(1);
    }
    console.log(`\nResolved Shared Drive "${drive.name}" (${drive.id})`);
  }

  if (args.dryRun) {
    console.log('\n--dry-run: nothing was written. Drop the flag to seed for real.\n');
    return;
  }

  console.log('\nSeeding…\n');
  const agent = new DriveTestDataAgent();
  const result = await agent.run(cfg);

  const scenarios = result?.scenarios || {};
  console.log('\nDone.');
  console.log('─'.repeat(72));
  console.log(`  root folder id     : ${result?.rootFolderId || '—'}`);
  console.log(`  shared drive       : ${scenarios.sharedDrive ? `${scenarios.sharedDrive.name} (${scenarios.sharedDrive.id})` : '(My Drive)'}`);
  console.log(`  file formats       : ${(scenarios.legacyOfficeFiles || []).length} file(s)`);
  console.log(`  permission matrix  : ${Array.isArray(scenarios.permissionMatrix) ? scenarios.permissionMatrix.length : 0} grant(s)`);
  console.log(`  shared-link matrix : ${Array.isArray(scenarios.linkMatrix) ? scenarios.linkMatrix.length : 0} link(s)`);
  console.log(`  over-limit path    : ${scenarios.overLimitPath ? `${scenarios.overLimitPath.approxLength} chars` : '(not created)'}`);

  const warnings = result?.warnings || [];
  if (warnings.length > 0) {
    console.log(`\n  ${warnings.length} warning(s) — scenarios that could not be seeded:`);
    for (const w of warnings.slice(0, 20)) {
      console.log(`    - ${w.scenario}${w.item ? `/${w.item}` : ''}: ${w.error}`);
    }
    console.log('\n  Anything listed here will report as "not exercised" in the validation report.');
  }
  console.log('');
}

main().catch((err) => {
  logger.error(`[seed-drive-test-data] ${err.stack || err.message}`);
  console.error(`\nFAILED: ${err.message}\n`);
  process.exit(1);
});
