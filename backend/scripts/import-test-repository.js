/**
 * Full Xray Test Repository → backend/data/test-repository.json
 * Uses the same logic as POST /api/test-repository/import (no duplicate business logic).
 *
 * Prefer this for very large repositories (avoids browser or reverse-proxy timeouts).
 *
 *   node scripts/import-test-repository.js [PROJECT_KEY] [ROOT_PATH] [--resume]
 *
 * PROJECT_KEY defaults to JIRA_PROJECT_KEY from .env (e.g. TEST).
 * Optional ROOT_PATH: Xray folder path under Test Repository, e.g. "/trial/Sanity Cases"
 * (quotes recommended on Windows if the path contains spaces).
 *
 * --resume: continue from the last checkpoint (MongoDB or test-repository.json must show
 * importStatus=in_progress). Use after a timeout or network error so folders already
 * fetched are not lost.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const logger = require('../src/utils/logger');
const env = require('../src/config/env');
const { connectMongo, closeMongo } = require('../src/db/mongo');
const testRepositoryService = require('../src/services/testRepositoryService');

const argv = process.argv.slice(2);
const resume = argv.includes('--resume');
const positional = argv.filter((a) => a !== '--resume');

const projectKey = String(positional[0] || env.JIRA_PROJECT_KEY || '').trim();
if (!projectKey) {
  console.error(
    'Set JIRA_PROJECT_KEY in .env or pass project key: node scripts/import-test-repository.js TEST'
  );
  process.exit(1);
}

const rootPathArg = positional[1];
const rootPath =
  typeof rootPathArg === 'string' && rootPathArg.trim() !== '' ? rootPathArg.trim() : undefined;

const log = logger.child({ script: 'import-test-repository', projectKey, rootPath, resume });

log.info(
  resume
    ? 'Resuming Test Repository import from checkpoint…'
    : 'Starting Test Repository import (this may take a long time for large trees)…'
);

(async () => {
  try {
    await connectMongo(log);
  } catch (e) {
    const msg = e?.message || String(e);
    log.error(msg);
    if (env.MONGODB_URI) {
      console.error(
        'MongoDB connection failed — snapshots cannot be written to Atlas. Fix MONGODB_URI or run without it (JSON file only).'
      );
      process.exit(1);
    }
  }

  try {
    const doc = await testRepositoryService.runImport(
      projectKey,
      { pageSize: 100, rootPath, resume },
      log
    );
    log.info(
      `Done: ${doc.stats.testCount} tests, ${doc.stats.folderCount} folders → ${testRepositoryService._dataFilePath}`
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          projectKey: doc.projectKey,
          projectName: doc.projectName,
          apiKind: doc.apiKind,
          importRootPath: doc.importRootPath,
          projectResolveVia: doc.projectResolveVia,
          importStatus: doc.importStatus,
          stats: doc.stats,
          file: testRepositoryService._dataFilePath,
        },
        null,
        2
      )
    );
    process.exitCode = 0;
  } catch (err) {
    log.error(err.message);
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await closeMongo();
  }
  process.exit();
})();
