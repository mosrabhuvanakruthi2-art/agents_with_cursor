const { getDb } = require('../db/mongo');

const COLLECTION = 'test_expanded_details';

let indexesEnsured = false;

async function ensureIndexes() {
  if (indexesEnsured) return;
  const db = getDb();
  if (!db) return;
  const col = db.collection(COLLECTION);
  await col.createIndex({ jiraKey: 1 }, { unique: true, sparse: true });
  await col.createIndex({ issueId: 1 }, { sparse: true });
  indexesEnsured = true;
}

/**
 * @param {Record<string, unknown>} detail steps-primary payload (see testRepositoryService.toStepsOnlyTestDetail)
 * @param {string} issueId
 * @param {string|null} jiraKey
 */
async function upsertDetail(detail, issueId, jiraKey) {
  const db = getDb();
  if (!db) return false;
  await ensureIndexes();

  const key = jiraKey ? String(jiraKey).trim().toUpperCase() : '';
  const id = issueId != null ? String(issueId).trim() : '';
  if (!key && !id) return false;

  const _id = key || `id:${id}`;
  const col = db.collection(COLLECTION);
  await col.replaceOne(
    { _id },
    {
      _id,
      jiraKey: key || null,
      issueId: id || null,
      detail,
      updatedAt: new Date().toISOString(),
    },
    { upsert: true }
  );
  return true;
}

/**
 * @param {string} jiraKeyUpper e.g. TEST-29
 * @param {string} [issueId]
 * @returns {Promise<{ detail: Record<string, unknown> } | null>}
 */
async function findByJiraKeyOrIssueId(jiraKeyUpper, issueId) {
  const db = getDb();
  if (!db) return null;
  await ensureIndexes();
  const col = db.collection(COLLECTION);

  const conditions = [];
  if (jiraKeyUpper) {
    const k = String(jiraKeyUpper).trim().toUpperCase();
    conditions.push({ jiraKey: k }, { _id: k });
  }
  if (issueId) {
    const id = String(issueId).trim();
    conditions.push({ issueId: id }, { _id: `id:${id}` });
  }
  if (conditions.length === 0) return null;

  const row = await col.findOne(
    { $or: conditions },
    { projection: { detail: 1 } }
  );
  return row?.detail ? { detail: row.detail } : null;
}

/**
 * Issue ids already present in `test_expanded_details` (for resume / skip-existing backfill).
 * @returns {Promise<Set<string>>}
 */
async function listStoredIssueIds() {
  const db = getDb();
  if (!db) return new Set();
  await ensureIndexes();
  const col = db.collection(COLLECTION);
  const ids = new Set();
  const cursor = col.find({}, { projection: { issueId: 1, _id: 1 } });
  for await (const doc of cursor) {
    if (doc.issueId != null && String(doc.issueId).trim() !== '') {
      ids.add(String(doc.issueId).trim());
    }
    const id = doc._id != null ? String(doc._id) : '';
    const m = id.match(/^id:(\d+)$/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** Remove all cached expanded rows (e.g. when clearing snapshot). */
async function deleteAll() {
  const db = getDb();
  if (!db) return { attempted: false, deleted: 0 };
  const r = await db.collection(COLLECTION).deleteMany({});
  return { attempted: true, deleted: r.deletedCount };
}

module.exports = {
  COLLECTION,
  upsertDetail,
  findByJiraKeyOrIssueId,
  listStoredIssueIds,
  deleteAll,
  ensureIndexes,
};
