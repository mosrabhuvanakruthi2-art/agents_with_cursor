const { getDb } = require('../db/mongo');
const crypto = require('crypto');

const FOLDERS_COL = 'test_repository_local_folders';
const TESTS_COL   = 'test_repository_local_tests';

function newId() {
  return `local-${crypto.randomUUID()}`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ensureIndexes() {
  const db = getDb();
  if (!db) return;
  await db.collection(FOLDERS_COL).createIndex({ parentPath: 1 });
  await db.collection(TESTS_COL).createIndex({ folderPath: 1 });
}

async function createFolder({ name, parentPath }) {
  const db = getDb();
  if (!db) throw new Error('MongoDB not connected');
  const norm = parentPath != null ? String(parentPath).replace(/\/+$/, '') : '';
  const path = norm ? `${norm}/${name}` : `/${name}`;
  const doc = {
    _id: newId(),
    name: String(name).trim(),
    parentPath: norm,
    path,
    createdAt: new Date().toISOString(),
  };
  await db.collection(FOLDERS_COL).insertOne(doc);
  return doc;
}

async function deleteFolder(id) {
  const db = getDb();
  if (!db) throw new Error('MongoDB not connected');
  const folder = await db.collection(FOLDERS_COL).findOne({ _id: id });
  if (!folder) return { deleted: 0, testsDeleted: 0 };
  const pathRe = new RegExp(`^${escapeRegex(folder.path)}(/|$)`);
  const r1 = await db.collection(FOLDERS_COL).deleteMany({ path: { $regex: pathRe } });
  const r2 = await db.collection(TESTS_COL).deleteMany({ folderPath: { $regex: pathRe } });
  return { deleted: r1.deletedCount, testsDeleted: r2.deletedCount };
}

async function createTest({ summary, folderPath, testType, steps, description }) {
  const db = getDb();
  if (!db) throw new Error('MongoDB not connected');
  const doc = {
    _id: newId(),
    summary: String(summary).trim(),
    folderId: folderPath || '/',
    folderPath: folderPath || '/',
    testType: testType || 'Manual',
    status: 'To Do',
    description: description || '',
    steps: Array.isArray(steps) ? steps : [],
    createdAt: new Date().toISOString(),
    _local: true,
  };
  await db.collection(TESTS_COL).insertOne(doc);
  return doc;
}

async function deleteTest(id) {
  const db = getDb();
  if (!db) throw new Error('MongoDB not connected');
  const r = await db.collection(TESTS_COL).deleteOne({ _id: id });
  return { deleted: r.deletedCount };
}

async function listFolders() {
  const db = getDb();
  if (!db) return [];
  return db.collection(FOLDERS_COL).find({}).toArray();
}

async function listTests() {
  const db = getDb();
  if (!db) return [];
  return db.collection(TESTS_COL).find({}).toArray();
}

module.exports = {
  createFolder,
  deleteFolder,
  createTest,
  deleteTest,
  listFolders,
  listTests,
  ensureIndexes,
  FOLDERS_COL,
  TESTS_COL,
};
