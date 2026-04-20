const localRepoMongoStore = require('../services/localRepoMongoStore');
const logger = require('../utils/logger');

async function getLocalData(req, res) {
  try {
    const [folders, tests] = await Promise.all([
      localRepoMongoStore.listFolders(),
      localRepoMongoStore.listTests(),
    ]);
    res.json({ folders, tests });
  } catch (err) {
    logger.error(`getLocalData: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function createFolder(req, res) {
  const { name, parentPath } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const folder = await localRepoMongoStore.createFolder({
      name: String(name).trim(),
      parentPath: parentPath ?? '',
    });
    res.json({ ok: true, folder });
  } catch (err) {
    logger.error(`createFolder: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function deleteFolder(req, res) {
  const id = decodeURIComponent(req.params.id || '');
  if (!id) return res.status(400).json({ error: 'id is required' });
  try {
    const result = await localRepoMongoStore.deleteFolder(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error(`deleteFolder: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function createTest(req, res) {
  const { summary, folderPath, testType, steps, description } = req.body || {};
  if (!summary || !String(summary).trim()) {
    return res.status(400).json({ error: 'summary is required' });
  }
  try {
    const test = await localRepoMongoStore.createTest({
      summary: String(summary).trim(),
      folderPath,
      testType,
      steps,
      description,
    });
    res.json({ ok: true, test });
  } catch (err) {
    logger.error(`createTest: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function deleteTest(req, res) {
  const id = decodeURIComponent(req.params.id || '');
  if (!id) return res.status(400).json({ error: 'id is required' });
  try {
    const result = await localRepoMongoStore.deleteTest(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error(`deleteTest: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { getLocalData, createFolder, deleteFolder, createTest, deleteTest };
