const { GridFSBucket, ObjectId } = require('mongodb');
const { getDb } = require('../db/mongo');

const COLLECTION = 'test_repository';
/** One canonical snapshot—the same model as test-repository.json root (frontend + GET /data). */
const DOC_ID = 'current';
/** Stay under MongoDB 16MB BSON cap; large snapshots use GridFS. */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;
const GRIDFS_BUCKET = 'test_repository_fs';

/** @param {import('mongodb').Db} db */
function gridFsBucket(db) {
  return new GridFSBucket(db, { bucketName: GRIDFS_BUCKET });
}

/**
 * @param {import('mongodb').GridFSBucket} bucket
 * @param {string} json
 * @returns {Promise<import('mongodb').ObjectId>}
 */
function uploadJson(bucket, json) {
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream('snapshot.json', {
      contentType: 'application/json',
    });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(uploadStream.id));
    uploadStream.end(Buffer.from(json, 'utf8'));
  });
}

/** @param {import('mongodb').Db} db */
async function deleteGridFsFile(db, fileId) {
  if (!fileId) return;
  try {
    await gridFsBucket(db).delete(toGridFsObjectId(fileId));
  } catch {
    /* already removed */
  }
}

/**
 * GridFS file ids must be ObjectId for openDownloadStream; Atlas / extended JSON may round-trip as strings.
 * @param {unknown} raw
 * @returns {import('mongodb').ObjectId | string}
 */
function toGridFsObjectId(raw) {
  if (raw == null) return raw;
  if (raw instanceof ObjectId) return raw;
  if (typeof raw === 'string' && ObjectId.isValid(raw)) {
    return new ObjectId(raw);
  }
  return /** @type {import('mongodb').ObjectId} */ (raw);
}

function gridFsFileIdFromRow(row) {
  return row?.gridFsFileId ?? row?.gridFSFileId;
}

/**
 * @param {Record<string, unknown>} doc same shape as test-repository.json root
 */
async function saveSnapshot(doc) {
  const db = getDb();
  if (!db) return false;

  const now = new Date().toISOString();
  const envelope = { ...doc, mongoSavedAt: now };
  const json = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(json, 'utf8');

  const col = db.collection(COLLECTION);
  const prev = await col.findOne({ _id: DOC_ID });

  if (bytes <= MAX_INLINE_BYTES) {
    const prevGfs = gridFsFileIdFromRow(prev);
    if (prev?.storageFormat === 'gridfs' && prevGfs) {
      await deleteGridFsFile(db, prevGfs);
    }
    await col.replaceOne(
      { _id: DOC_ID },
      { _id: DOC_ID, storageFormat: 'inline', ...envelope },
      { upsert: true }
    );
    return true;
  }

  const bucket = gridFsBucket(db);
  const prevGfs2 = gridFsFileIdFromRow(prev);
  if (prev?.storageFormat === 'gridfs' && prevGfs2) {
    await deleteGridFsFile(db, prevGfs2);
  }

  const fileId = await uploadJson(bucket, json);
  await col.replaceOne(
    { _id: DOC_ID },
    {
      _id: DOC_ID,
      storageFormat: 'gridfs',
      gridFsFileId: fileId,
      mongoSavedAt: now,
    },
    { upsert: true }
  );
  return true;
}

/**
 * @returns {Promise<Record<string, unknown> | null>} API payload (no _id / mongoSavedAt / storage meta)
 */
async function loadSnapshot() {
  const db = getDb();
  if (!db) return null;

  const row = await db.collection(COLLECTION).findOne({ _id: DOC_ID });
  if (!row) return null;

  const fileIdRaw = gridFsFileIdFromRow(row);
  const looksLikePointerOnly =
    fileIdRaw &&
    row.tests === undefined &&
    row.folderTreeRoot === undefined &&
    row.folders === undefined;
  const shouldReadGridFs =
    (row.storageFormat === 'gridfs' && fileIdRaw) || looksLikePointerOnly;

  if (shouldReadGridFs && fileIdRaw) {
    const bucket = gridFsBucket(db);
    const chunks = [];
    const stream = bucket.openDownloadStream(toGridFsObjectId(fileIdRaw));
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) {
      throw new Error('test_repository GridFS snapshot is empty');
    }
    const parsed = JSON.parse(text);
    const {
      mongoSavedAt,
      storageFormat: _sf,
      gridFsFileId: _g1,
      gridFSFileId: _g2,
      ...rest
    } = parsed;
    return /** @type {Record<string, unknown>} */ (rest);
  }

  const { _id, storageFormat, gridFsFileId, gridFSFileId, mongoSavedAt, ...rest } = row;
  return /** @type {Record<string, unknown>} */ (rest);
}

/**
 * Removes the cached snapshot document. No-op if Mongo is not connected.
 * @returns {Promise<{ attempted: boolean, deleted: boolean }>}
 */
async function deleteSnapshot() {
  const db = getDb();
  if (!db) return { attempted: false, deleted: false };

  const row = await db.collection(COLLECTION).findOne({ _id: DOC_ID });
  const gfsId = gridFsFileIdFromRow(row);
  if (row?.storageFormat === 'gridfs' && gfsId) {
    await deleteGridFsFile(db, gfsId);
  }

  const r = await db.collection(COLLECTION).deleteOne({ _id: DOC_ID });
  return { attempted: true, deleted: r.deletedCount > 0 };
}

module.exports = {
  saveSnapshot,
  loadSnapshot,
  deleteSnapshot,
  COLLECTION,
  DOC_ID,
  GRIDFS_BUCKET,
};
