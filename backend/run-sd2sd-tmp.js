/**
 * Drive the Shared Drive → Shared Drive flow directly, the same path the HTTP route takes
 * (MigrationContext → orchestrator.runFullFlow), so no auth token has to be minted.
 */
const MigrationContext = require('./src/models/MigrationContext');
const orchestrator = require('./src/orchestrator/AgentOrchestrator');
const executionService = require('./src/services/executionService');

const SRC = 'erik@filefuze.co';
const DST = 'mia@cloudfuze.com';
const DRIVE = 'QA_Team1';
const FOLDER = 'Agent Shared Drive';
const DEST = '/QA-SharedDrive-Dest';

(async () => {
  const context = new MigrationContext({
    sourceEmail: SRC,
    destinationEmail: DST,
    migrationType: 'FULL',
    testType: 'E2E',
    mode: 'content',
    sourceProvider: 'googleshareddrive',
    destinationProvider: 'googleshareddrive',
    userEmailMappings: [{ sourceEmail: SRC, destinationEmail: DST }],
    sourceAdminEmail: SRC,
    destAdminEmail: DST,
    migrationServerUrl: 'https://qarelease.cloudfuze.com',
    sourceFolderName: FOLDER,
    destinationPath: DEST,
    contentUserFolders: [{
      sourceEmail: SRC,
      destinationEmail: DST,
      sourceDriveName: DRIVE,
      sourceFolderName: FOLDER,
      destinationPath: DEST,
    }],
    useExistingSource: false,
  });
  context.validate();
  context.userEmail = 'selftest@local';
  executionService.create(context);
  console.log(`EXECUTION ${context.executionId}`);
  try {
    await orchestrator.runFullFlow(context);
    console.log(`\nFLOW FINISHED — execution ${context.executionId}`);
  } catch (err) {
    console.log(`\nFLOW FAILED — ${err.message}`);
  }
  process.exit(0);
})();
