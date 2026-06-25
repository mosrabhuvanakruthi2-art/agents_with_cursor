const testRepositoryService = require('../services/testRepositoryService');
const xrayCloudClient = require('../clients/xrayCloudClient');
const testExpandedDetailsMongoStore = require('../services/testExpandedDetailsMongoStore');
const env = require('../config/env');
const logger = require('../utils/logger');

async function importRepository(req, res) {
  const projectKey = String(
    req.body.projectKey || env.JIRA_PROJECT_KEY || ''
  ).trim();
  if (!projectKey) {
    return res.status(400).json({
      error: 'projectKey is required in body or set JIRA_PROJECT_KEY in .env',
    });
  }

  const rootPath =
    typeof req.body.rootPath === 'string' && req.body.rootPath.trim() !== ''
      ? req.body.rootPath.trim()
      : undefined;

  const resume = Boolean(req.body.resume);

  const log = logger.child({ route: 'test-repository/import', projectKey, rootPath, resume });
  log.info(
    `Import request received (projectKey=${projectKey}, rootPath=${rootPath ?? '(empty = full tree)'}, resume=${resume}) — Xray Cloud: MongoDB + JSON checkpoint after each folder; Server REST: single save at end.`
  );
  try {
    const doc = await testRepositoryService.runImport(
      projectKey,
      { pageSize: req.body.pageSize, rootPath, resume },
      log
    );
    log.info(
      `Import finished OK: ${doc.stats?.testCount ?? 0} tests, ${doc.stats?.folderCount ?? 0} folders (apiKind=${doc.apiKind})`
    );
    res.json({
      ok: true,
      projectKey: doc.projectKey,
      importedAt: doc.importedAt,
      stats: doc.stats,
      apiKind: doc.apiKind,
      importRootPath: doc.importRootPath,
      projectResolveVia: doc.projectResolveVia,
      importStatus: doc.importStatus,
    });
  } catch (err) {
    log.error(err.message);
    const status = err.message.includes('must be set') ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
}

async function getData(req, res) {
  try {
    const doc = await testRepositoryService.loadSnapshotForFrontend();
    if (!doc) {
      return res.status(404).json({
        error:
          'No Test Repository snapshot for the UI. Sync from Jira/Xray first: POST /api/test-repository/sync (or /import) with { "projectKey": "TEST" }. With MONGODB_URI set, data is stored in MongoDB and this endpoint reads from there; otherwise it reads backend/data/test-repository.json. You can set TEST_REPOSITORY_FRONTEND_FALLBACK_TO_FILE=true to use the JSON file when Mongo is empty.',
      });
    }
    res.json(doc);
  } catch (err) {
    logger.error(err.message);
    res.status(500).json({ error: err.message });
  }
}

/** Where sync vs UI read — see getSnapshotReadiness() */
async function getStatus(req, res) {
  try {
    const readiness = await testRepositoryService.getSnapshotReadiness();
    res.json(readiness);
  } catch (err) {
    logger.error(err.message);
    res.status(500).json({ error: err.message });
  }
}

/** Same body as POST /import — semantic alias: pull Test Repository from Xray into MongoDB (+ JSON backup). */
async function syncFromXray(req, res) {
  return importRepository(req, res);
}

function getDefaults(_req, res) {
  res.json({
    defaultProjectKey: env.JIRA_PROJECT_KEY || '',
    defaultRootPath: env.TEST_REPOSITORY_ROOT_PATH || '',
  });
}

/**
 * GET ?issueId=&key=TEST-40365 — test detail for modal.
 * Order: Mongo `test_expanded_details` → optional live Xray (if TEST_REPOSITORY_TEST_DETAIL_LIVE_FALLBACK) → snapshot `cachedDetail` → minimal.
 * Key-only: numeric issue id is read from the snapshot row before any optional Jira REST resolve.
 */
async function getTestDetail(req, res) {
  const issueIdRaw = req.query.issueId;
  const keyRaw = req.query.key;
  const issueId = typeof issueIdRaw === 'string' ? issueIdRaw.trim() : '';
  const issueKey = typeof keyRaw === 'string' ? keyRaw.trim().toUpperCase() : '';

  const log = logger.child({ route: 'test-repository/test-detail', issueKey, issueId });
  try {
    if (!issueId && !issueKey) {
      return res.status(400).json({ error: 'Query parameter issueId or key is required' });
    }

    const detail = await testRepositoryService.getTestDetailFromSnapshot(issueId, issueKey);
    if (!detail) {
      return res.status(404).json({
        error:
          'Test not found in the saved snapshot. Run **Import** first (while Xray is available) so data is stored in MongoDB or test-repository.json.',
      });
    }
    if (Array.isArray(detail.steps) && detail.steps.length > 0) {
      const originalStepsJson = JSON.stringify(detail.steps);
      detail.steps = xrayCloudClient.enrichStepsTestStepsDisplay(detail.steps);
      // Log custom field IDs on first step so the admin can set JIRA_XRAY_STEP_TEST_STEPS_CUSTOMFIELD_ID
      const firstStep = detail.steps[0];
      if (Array.isArray(firstStep?.customfields) && firstStep.customfields.length > 0) {
        log.info(
          {
            stepCustomfieldIds: firstStep.customfields.map((c) => c.id),
            stepCustomfieldPreviews: firstStep.customfields.map((c) => ({
              id: c.id,
              preview: String(c.valuePlain || '').slice(0, 80),
            })),
          },
          'Step custom fields — set JIRA_XRAY_STEP_TEST_STEPS_CUSTOMFIELD_ID in .env to pin the "Test Steps" column to the correct ID'
        );
      }
      // If enrich repaired any leaked paragraphs, persist corrected steps back to MongoDB in background.
      if (env.MONGODB_URI && JSON.stringify(detail.steps) !== originalStepsJson) {
        const repaired = { ...detail, steps: detail.steps };
        testExpandedDetailsMongoStore
          .upsertDetail(repaired, repaired.issueId || issueId, repaired.jiraKey || issueKey)
          .then(() => log.info('Repaired step data/testSteps split written back to MongoDB'))
          .catch((e) => log.warn({ err: e.message }, 'MongoDB write-back of repaired steps failed'));
      }
    }
    res.json(detail);
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
}

async function clearRepository(req, res) {
  const log = logger.child({ route: 'test-repository/clear' });
  try {
    const result = await testRepositoryService.clearSnapshot(log);
    res.json({ ok: true, ...result });
  } catch (err) {
    log.error(err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  importRepository,
  syncFromXray,
  getData,
  getStatus,
  getDefaults,
  getTestDetail,
  clearRepository,
};
