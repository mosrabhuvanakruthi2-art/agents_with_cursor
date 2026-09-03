/**
 * Backend run of content: dropbox → googleshareddrive.
 *
 * Same shape as a wizard run, built here so the flow can be iterated on without the UI:
 * CleanupAgent → DropboxTestDataAgent → MigrationAgent (qarelease) → validation.
 *
 * Throwaway QA harness — not part of the product. Run from backend/:
 *   node scripts/tmp-run-dropbox-gsd.js
 */
const env = require('../src/config/env');
// AgentOrchestrator exports a singleton instance, not the class — same as the controller uses.
const orchestrator = require('../src/orchestrator/AgentOrchestrator');
const { connectMongo } = require('../src/db/mongo');

const SOURCE_EMAIL = 'erik@filefuze.co';
const DEST_EMAIL = 'erik@filefuze.co';
const DEST_DRIVE = process.env.DEST_DRIVE_OVERRIDE || 'QA-Automation-Dropbox-Dest';
// A subfolder under the destination drive, so a run into a SHARED drive (e.g. the QA drive that
// already holds other teams' data) stays in its own folder.
const DEST_SUBFOLDER = process.env.DEST_SUBFOLDER || '';

// Seeding is ~3 of the ~4.5 minutes, and the data it creates does not change between iterations.
//   node scripts/tmp-run-dropbox-gsd.js          → full run, re-seeds
//   node scripts/tmp-run-dropbox-gsd.js reuse    → skip seeding, migrate + validate what is there
const REUSE_SOURCE = process.argv.slice(2).includes('reuse');

// `mydrive` swaps the destination to Google My Drive (the pair Lavanya's combination targets).
// It splits the failure in half: if My Drive moves data the Dropbox SOURCE scanner is fine and a
// Shared Drive DESTINATION is the unsupported half; if it also reports 0, the source scan is the
// problem regardless of destination.
const TO_MY_DRIVE = process.argv.slice(2).includes('mydrive');

(async () => {
  try {
    await connectMongo();
  } catch (err) {
    console.log('mongo (non-fatal):', err.message);
  }

  const executionId = 'dbx-gsd-' + Date.now();
  const ctx = {
    executionId,
    domain: 'content',
    mode: 'content',
    sourceProvider: 'dropbox',
    destinationProvider: TO_MY_DRIVE ? 'googledrive' : 'googleshareddrive',
    sourceEmail: SOURCE_EMAIL,
    destinationEmail: DEST_EMAIL,
    sourceAdminEmail: SOURCE_EMAIL,
    destAdminEmail: DEST_EMAIL,
    userEmailMappings: [{ sourceEmail: SOURCE_EMAIL, destinationEmail: DEST_EMAIL }],
    migrationType: 'FULL',
    testType: 'E2E',
    includeMail: true,
    includeCalendar: false,
    includeContacts: false,
    // The destination Shared Drive is resolved BY NAME; the first path segment IS the drive.
    destinationPath: TO_MY_DRIVE ? '' : ('/' + DEST_DRIVE + (DEST_SUBFOLDER ? '/' + DEST_SUBFOLDER : '')),
    destinationSharedDriveName: TO_MY_DRIVE ? '' : DEST_DRIVE,
    sourcePath: env.DROPBOX_TEST_ROOT || '/QA-Automation',
    // reuse mode: keep the seeded tree, skip CleanupAgent and the seeding agent. sourceFolderName
    // is what the useExistingSource branch resolves to a real Dropbox folder id.
    useExistingSource: REUSE_SOURCE,
    skipCleanup: REUSE_SOURCE,
    sourceFolderName: env.DROPBOX_TEST_ROOT || '/QA-Automation',
    migrationServerUrl: env.CONTENT_MIGRATION_SERVER_URL,
    migrationServerEmail: env.CONTENT_MIGRATION_SERVER_EMAIL,
    migrationServerPassword: env.CONTENT_MIGRATION_SERVER_PASSWORD,
  };

  console.log("=== RUN " + executionId + " : dropbox -> googleshareddrive " + (REUSE_SOURCE ? "(reuse source, no seeding)" : "(full, re-seeds)") + " ===");
  console.log('source ' + SOURCE_EMAIL + ' ' + ctx.sourcePath
    + '  ->  dest ' + DEST_EMAIL + ' /' + DEST_DRIVE);

  const started = Date.now();
  const mins = () => ((Date.now() - started) / 60000).toFixed(1);

  try {
    const result = await orchestrator.runFullFlow(ctx);
    console.log('=== FINISHED in ' + mins() + ' min ===');
    console.log('status: ' + (result && result.status));

    const agents = (result && result.agents) || {};
    for (const name of Object.keys(agents)) {
      const a = agents[name] || {};
      console.log('  ' + name.padEnd(26) + ' ' + a.status
        + (a.error ? ' :: ' + String(a.error).slice(0, 160) : ''));
    }

    const v = (result && (result.validationSummary || result.validationResult)) || null;
    if (v) {
      console.log('verdict: ' + (v.overallStatus || v.status));
      const checks = v.checks || [];
      const fails = checks.filter((c) => c.status === 'FAIL');
      console.log('checks: ' + checks.length + ' total, ' + fails.length + ' FAIL');
      fails.slice(0, 30).forEach((c) => {
        console.log('  FAIL ' + c.name + ': ' + String(c.details || '').slice(0, 150));
      });
    } else {
      console.log('no validationResult on the run result');
    }
  } catch (err) {
    console.log('=== THREW after ' + mins() + ' min ===');
    console.log(err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n') : String(err));
  }
  // The orchestrator finishes by firing off the Mongo status/result write and (on FAIL) the
  // Neutara ticket POST without awaiting either. Exiting immediately truncated both: run
  // dbx-gsd-1788351282084 migrated 67/67 and still sits in Mongo as RUNNING with no result,
  // and its verdict was lost. Wait briefly rather than exiting mid-write.
  await new Promise((r) => setTimeout(r, 20000));
  process.exit(0);
})();
