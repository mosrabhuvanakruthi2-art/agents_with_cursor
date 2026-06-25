/**
 * Uploads backend/data/test-repository.json → MongoDB (test_repository / current).
 * Use when you already ran import-test-repository while Mongo was not connected (CLI did not call connectMongo),
 * or to repair Atlas after a successful JSON-only import.
 *
 *   node scripts/push-test-repository-json-to-mongo.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const logger = require('../src/utils/logger');
const env = require('../src/config/env');
const { connectMongo, closeMongo } = require('../src/db/mongo');
const testRepositoryMongoStore = require('../src/services/testRepositoryMongoStore');
const testRepositoryService = require('../src/services/testRepositoryService');

const log = logger.child({ script: 'push-test-repository-json-to-mongo' });

(async () => {
  if (!env.MONGODB_URI) {
    console.error('Set MONGODB_URI in backend/.env');
    process.exit(1);
  }

  const doc = testRepositoryService.loadFromFile();
  if (!doc || !doc.tests) {
    console.error(`No data at ${testRepositoryService._dataFilePath}. Run import-test-repository first.`);
    process.exit(1);
  }

  try {
    await connectMongo(log);
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }

  try {
    const ok = await testRepositoryMongoStore.saveSnapshot(doc);
    if (!ok) {
      console.error('saveSnapshot returned false (Mongo not connected?)');
      process.exitCode = 1;
    } else {
      log.info(
        `Pushed snapshot to MongoDB (${doc.stats?.testCount ?? doc.tests?.length} tests, ${doc.stats?.folderCount ?? '?'} folders)`
      );
      console.log(JSON.stringify({ ok: true, mongo: true, stats: doc.stats }, null, 2));
    }
  } finally {
    await closeMongo();
  }
  process.exit(process.exitCode || 0);
})();
