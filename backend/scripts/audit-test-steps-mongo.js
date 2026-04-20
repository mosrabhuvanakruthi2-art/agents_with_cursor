/**
 * Reports how many documents in `test_expanded_details` have at least one non-empty `steps[].testSteps`.
 *
 *   cd backend && npm run audit-test-steps-mongo
 *
 * Requires MONGODB_URI in backend/.env (same as the app).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const env = require('../src/config/env');
const { connectMongo, closeMongo, getDb } = require('../src/db/mongo');
const { COLLECTION } = require('../src/services/testExpandedDetailsMongoStore');

function hasAnyTestSteps(detail) {
  const steps = detail?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps.some((s) => s && String(s.testSteps ?? '').trim() !== '');
}

function stepCount(detail) {
  const steps = detail?.steps;
  return Array.isArray(steps) ? steps.length : 0;
}

(async () => {
  const log = { info: console.log, warn: console.warn, error: console.error };
  if (!env.MONGODB_URI) {
    console.error('MONGODB_URI is not set in backend/.env');
    process.exit(1);
  }
  try {
    await connectMongo(log);
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }

  const db = getDb();
  if (!db) {
    console.error('MongoDB client not available');
    process.exit(1);
  }

  const col = db.collection(COLLECTION);
  const total = await col.countDocuments({});
  let withTestStepsText = 0;
  let withStepsButNoTestStepsColumn = 0;
  let noStepsArray = 0;

  const cursor = col.find({}, { projection: { detail: 1, jiraKey: 1, issueId: 1 } });
  for await (const doc of cursor) {
    const d = doc.detail;
    const n = stepCount(d);
    if (n === 0) {
      noStepsArray += 1;
      continue;
    }
    if (hasAnyTestSteps(d)) {
      withTestStepsText += 1;
    } else {
      withStepsButNoTestStepsColumn += 1;
    }
  }

  console.log(JSON.stringify({
    collection: COLLECTION,
    database: env.MONGODB_DB_NAME || 'migration_qa',
    totalDocuments: total,
    withAtLeastOneNonEmptyTestStepsField: withTestStepsText,
    withStepsButAllTestStepsEmpty: withStepsButNoTestStepsColumn,
    documentsWithNoStepsArray: noStepsArray,
    note:
      'withAtLeastOneNonEmptyTestStepsField = rows where some step has detail.steps[].testSteps text. ' +
      'If total tests in Jira > totalDocuments, backfill/import may still be running or incomplete.',
  }, null, 2));

  await closeMongo();
  process.exit(0);
})().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
