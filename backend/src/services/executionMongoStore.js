const { getDb } = require('../db/mongo');
const logger = require('../utils/logger');

/** One document per execution, keyed by executionId (=_id). */
const COLLECTION = 'executions';

/** Stay under MongoDB's 16 MB BSON document cap (leave headroom for encoding). */
const MAX_DOC_BYTES = 15 * 1024 * 1024;

/** True once MongoDB is connected — callers use the file fallback until then. */
function isReady() {
  return !!getDb();
}

/**
 * Upsert a single execution document. No-op (returns false) when Mongo is not
 * connected. Oversized executions (huge log/result payloads) are skipped so a
 * single bad run can't spam write errors on every progress tick — the file
 * fallback still holds them.
 * @param {Record<string, any>} execution — must have an executionId
 * @returns {Promise<boolean>}
 */
async function upsertExecution(execution) {
  const db = getDb();
  if (!db || !execution || !execution.executionId) return false;

  const doc = { _id: execution.executionId, ...execution };
  const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
  if (bytes > MAX_DOC_BYTES) {
    logger.warn(
      `[executionMongoStore] execution ${execution.executionId} is ${(bytes / 1e6).toFixed(1)} MB ` +
      `— exceeds the ${(MAX_DOC_BYTES / 1e6).toFixed(0)} MB inline limit, not persisted to Mongo (kept in file fallback)`
    );
    return false;
  }

  await db.collection(COLLECTION).replaceOne(
    { _id: execution.executionId },
    doc,
    { upsert: true }
  );
  return true;
}

/**
 * Load every persisted execution. Returns them in the original service shape
 * (the Mongo `_id` mirror of executionId is stripped).
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function loadAllExecutions() {
  const db = getDb();
  if (!db) return [];
  const rows = await db.collection(COLLECTION).find({}).toArray();
  return rows.map(({ _id, ...rest }) => rest);
}

/**
 * Delete a single execution document. No-op when Mongo is not connected.
 * @returns {Promise<boolean>}
 */
async function deleteExecution(executionId) {
  const db = getDb();
  if (!db || !executionId) return false;
  const r = await db.collection(COLLECTION).deleteOne({ _id: executionId });
  return r.deletedCount > 0;
}

module.exports = {
  isReady,
  upsertExecution,
  loadAllExecutions,
  deleteExecution,
  COLLECTION,
};
