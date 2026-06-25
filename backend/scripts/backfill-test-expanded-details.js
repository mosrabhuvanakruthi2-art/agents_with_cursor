/**
 * For each test in backend/data/test-repository.json, calls Xray getExpandedTest and stores
 * steps-focused payloads in MongoDB collection `test_expanded_details` (keyed by TEST-xx).
 * The Test Repository modal then loads details from Mongo without pulling the full GridFS snapshot.
 *
 * Requires: MONGODB_URI, XRAY_CLIENT_ID, XRAY_CLIENT_SECRET, JIRA_* for Xray.
 *
 *   node scripts/backfill-test-expanded-details.js [concurrency]
 *
 * Example (5 parallel requests — default):
 *   node scripts/backfill-test-expanded-details.js 5
 *   node scripts/backfill-test-expanded-details.js 5 --skip-existing
 *
 * --skip-existing: only fetch issue ids not already present in MongoDB `test_expanded_details` (faster resume).
 *
 * Large repos: runs a long time (~64k GraphQL calls). Prefer running in a persistent terminal / screen.
 * Xray may return HTTP 429; the client waits until nextValidRequestDate (or capped backoff) and retries.
 * Progress logs every 200 issue ids processed (success or failure). Under heavy throttling use concurrency 1.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const logger = require('../src/utils/logger');
const { connectMongo, closeMongo } = require('../src/db/mongo');
const env = require('../src/config/env');
const testRepositoryService = require('../src/services/testRepositoryService');

const argv = process.argv.slice(2);
const skipExisting = argv.includes('--skip-existing');
const numArg = argv.find((a) => /^\d+$/.test(a));
const concurrency = Math.max(1, Math.min(20, parseInt(numArg, 10) || 5));

const log = logger.child({ script: 'backfill-test-expanded-details', concurrency, skipExisting });

(async () => {
  try {
    await connectMongo(log);
  } catch (e) {
    console.error(e?.message || e);
    console.error(
      '\nTip: Run this from the backend folder only (do not run `cd backend` twice). Example:\n' +
        '  cd path\\to\\agents with cursor\\backend\n' +
        '  npm run backfill-test-expanded-details -- 1\n'
    );
    process.exit(1);
  }

  if (!env.MONGODB_URI) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  try {
    const r = await testRepositoryService.runBackfillExpandedDetails(log, { concurrency, skipExisting });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = 0;
  } catch (e) {
    log.error(e.message);
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await closeMongo();
  }
  process.exit();
})();
