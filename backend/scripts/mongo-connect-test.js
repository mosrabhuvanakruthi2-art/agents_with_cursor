/**
 * Quick check that MONGODB_URI works (same options as src/db/mongo.js).
 *   node scripts/mongo-connect-test.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const logger = require('../src/utils/logger');
const { connectMongo, closeMongo } = require('../src/db/mongo');

(async () => {
  const log = logger.child({ script: 'mongo-connect-test' });
  try {
    await connectMongo(log);
    console.log('MongoDB: OK');
    process.exitCode = 0;
  } catch (e) {
    console.error(e.message || e);
    process.exitCode = 1;
  } finally {
    await closeMongo();
  }
  process.exit();
})();
