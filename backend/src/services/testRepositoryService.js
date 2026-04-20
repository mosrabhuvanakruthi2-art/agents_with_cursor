const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/mongo');
const env = require('../config/env');
const logger = require('../utils/logger');
const jiraXrayClient = require('../clients/jiraXrayClient');
const xrayCloudClient = require('../clients/xrayCloudClient');
const testRepositoryMongoStore = require('./testRepositoryMongoStore');
const testExpandedDetailsMongoStore = require('./testExpandedDetailsMongoStore');

const dataDir = path.resolve(__dirname, '../../data');
const dataFile = path.join(dataDir, 'test-repository.json');

function ensureDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function loadFromFile() {
  try {
    if (!fs.existsSync(dataFile)) return null;
    const raw = fs.readFileSync(dataFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Prefer MongoDB when connected and a snapshot exists; otherwise JSON file.
 * @returns {Promise<object | null>}
 */
async function load() {
  if (env.MONGODB_URI) {
    try {
      const fromMongo = await testRepositoryMongoStore.loadSnapshot();
      if (fromMongo) return fromMongo;
    } catch {
      /* fall back to file */
    }
  }
  return loadFromFile();
}

/**
 * Snapshot for the UI (GET /data, test-detail): when MONGODB_URI is set, read **MongoDB only**
 * so the flow is: sync from Xray → Mongo → frontend. Optional file fallback for local dev.
 * @returns {Promise<object | null>}
 */
async function loadSnapshotForFrontend() {
  if (env.MONGODB_URI) {
    try {
      const fromMongo = await testRepositoryMongoStore.loadSnapshot();
      if (fromMongo) return fromMongo;
    } catch {
      /* treat as empty unless fallback */
    }
    if (env.TEST_REPOSITORY_FRONTEND_FALLBACK_TO_FILE) {
      return loadFromFile();
    }
    return null;
  }
  return loadFromFile();
}

/**
 * For GET /api/test-repository/status — explains where sync stores data and what the UI reads.
 * @returns {Promise<object>}
 */
async function getSnapshotReadiness() {
  const mongoUriConfigured = Boolean(env.MONGODB_URI);
  const fallbackToFile = env.TEST_REPOSITORY_FRONTEND_FALLBACK_TO_FILE;
  let mongoConnected = false;
  let mongoHasSnapshot = false;
  if (mongoUriConfigured) {
    mongoConnected = Boolean(getDb());
    try {
      const doc = await testRepositoryMongoStore.loadSnapshot();
      mongoHasSnapshot = Boolean(doc);
    } catch {
      mongoHasSnapshot = false;
    }
  }
  const fileHasSnapshot = Boolean(loadFromFile());
  let uiReadsFrom = 'json_file';
  if (mongoUriConfigured && !fallbackToFile) {
    uiReadsFrom = 'mongodb_only';
  } else if (mongoUriConfigured && fallbackToFile) {
    uiReadsFrom = 'mongodb_then_file';
  }
  return {
    mongoUriConfigured,
    mongoConnected,
    mongoHasSnapshot,
    fileHasSnapshot,
    fallbackToFileEnabled: fallbackToFile,
    uiReadsFrom,
    /** When false, GET /test-detail never calls Jira REST or Xray (Mongo/snapshot/file only). */
    testDetailLiveFallback: env.TEST_REPOSITORY_TEST_DETAIL_LIVE_FALLBACK,
  };
}

function saveFile(doc) {
  ensureDir();
  fs.writeFileSync(dataFile, JSON.stringify(doc, null, 2), 'utf8');
}

/**
 * Writes JSON file (always) and MongoDB snapshot when URI is configured.
 * @param {object} doc
 * @param {import('winston').Logger} [log]
 * @param {{ quiet?: boolean }} [opts] quiet: omit routine "saved to MongoDB" log (checkpoints)
 */
async function persist(doc, log, opts = {}) {
  const quiet = Boolean(opts.quiet);
  saveFile(doc);
  if (!env.MONGODB_URI) return;
  try {
    const ok = await testRepositoryMongoStore.saveSnapshot(doc);
    if (ok && log && !quiet) log.info('Test Repository: snapshot saved to MongoDB');
  } catch (e) {
    const msg = e?.message || String(e);
    if (log) {
      log.warn(`Test Repository: MongoDB save failed (${msg}) — data is still in test-repository.json`);
    }
  }
}

/**
 * Deletes saved snapshot: MongoDB document (if configured) then local JSON file.
 * @param {import('winston').Logger} [log]
 */
async function clearSnapshot(log) {
  let mongo = { attempted: false, deleted: false };
  if (env.MONGODB_URI) {
    try {
      mongo = await testRepositoryMongoStore.deleteSnapshot();
    } catch (e) {
      const msg = e?.message || String(e);
      if (log) log.error(`Test Repository: MongoDB delete failed (${msg})`);
      throw new Error(`Could not clear MongoDB snapshot: ${msg}`);
    }
  }

  let fileRemoved = false;
  try {
    if (fs.existsSync(dataFile)) {
      fs.unlinkSync(dataFile);
      fileRemoved = true;
    }
  } catch (e) {
    const msg = e?.message || String(e);
    if (log) log.error(`Test Repository: failed to remove JSON file (${msg})`);
    throw new Error(`Could not remove test-repository.json: ${msg}`);
  }

  if (log) {
    log.info(
      `Test Repository: snapshot cleared (fileRemoved=${fileRemoved}, mongoAttempted=${mongo.attempted}, mongoDeleted=${mongo.deleted})`
    );
  }
  return { fileRemoved, mongo };
}

/**
 * Parallel fetch of getExpandedTest for offline modal (stored as test.cachedDetail).
 * @param {Array<object>} tests
 * @param {import('winston').Logger} [log]
 */
async function enrichTestsWithExpandedDetailsFromXray(tests, log) {
  if (!env.TEST_REPOSITORY_IMPORT_EXPANDED) {
    if (log) log.info('Test Repository: expanded cache disabled (TEST_REPOSITORY_IMPORT_EXPANDED=false)');
    return;
  }
  const ids = [...new Set(tests.map((t) => t.issueId).filter(Boolean).map((id) => String(id)))];
  if (ids.length === 0) {
    if (log) log.warn('Test Repository: no issueIds to expand — modal will show summary-only until re-import');
    return;
  }

  const detailById = new Map();
  const parallel = 5;
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= ids.length) return;
      const id = ids[i];
      try {
        const d = await xrayCloudClient.fetchExpandedTestByIssueId(id);
        let slim = toStepsOnlyTestDetail(d);
        if (slim?.steps?.length) {
          slim = { ...slim, steps: xrayCloudClient.enrichStepsTestStepsDisplay(slim.steps) };
        }
        const toAttach = slim || d;
        detailById.set(id, toAttach);
        if (slim && env.MONGODB_URI) {
          try {
            await testExpandedDetailsMongoStore.upsertDetail(slim, slim.issueId || id, slim.jiraKey);
          } catch (e) {
            if (log) log.warn(`Test Repository: Mongo expanded cache ${id}: ${e.message}`);
          }
        }
      } catch (e) {
        if (log) log.warn(`Test Repository: expand ${id}: ${e.message}`);
      }
      if (log && ((i + 1) % 50 === 0 || i + 1 === ids.length)) {
        log.info(`Test Repository: caching expanded tests ${i + 1}/${ids.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(parallel, ids.length) }, () => worker()));

  let attached = 0;
  for (const t of tests) {
    const id = t.issueId != null ? String(t.issueId) : '';
    if (id && detailById.has(id)) {
      t.cachedDetail = detailById.get(id);
      attached += 1;
    }
  }
  if (log) log.info(`Test Repository: expanded payload on ${attached} of ${tests.length} row(s)`);
}

function findTestRow(doc, issueId, issueKey) {
  const list = doc?.tests || [];
  const idStr = issueId ? String(issueId).trim() : '';
  const keyStr = issueKey ? String(issueKey).trim().toUpperCase() : '';
  if (idStr) {
    const hit = list.find((t) => t.issueId != null && String(t.issueId) === idStr);
    if (hit) return hit;
  }
  if (keyStr) {
    return list.find((t) => String(t.jiraKey || '').toUpperCase() === keyStr) || null;
  }
  return null;
}

function buildMinimalTestDetail(row) {
  return {
    issueId: row.issueId != null ? String(row.issueId) : null,
    jiraKey: row.jiraKey || null,
    summary: row.summary || '',
    description: null,
    status: row.status,
    assignee: row.assignee || null,
    reporter: null,
    priority: null,
    labels: row.labels || null,
    testType: row.testType,
    folder: row.folderPath ? { path: row.folderPath, name: null } : null,
    steps: [],
    warnings: [],
    partial: true,
    source: 'snapshot',
    hideJiraSidebar: true,
  };
}

/**
 * Xray "Test details" (steps + folder + summary) for offline UI — omits Jira issue sidebar fields (assignee, reporter, …).
 * @param {Record<string, unknown>} expanded output of xrayCloudClient.fetchExpandedTestByIssueId / normalize
 * @returns {Record<string, unknown> | null}
 */
function toStepsOnlyTestDetail(expanded) {
  if (!expanded || typeof expanded !== 'object') return null;
  return {
    issueId: expanded.issueId != null ? String(expanded.issueId) : null,
    jiraKey: expanded.jiraKey != null ? String(expanded.jiraKey) : null,
    summary: expanded.summary != null ? String(expanded.summary) : '',
    description: expanded.description ?? null,
    status: expanded.status ?? null,
    testType: expanded.testType ?? null,
    xrayTestStatus: expanded.xrayTestStatus ?? null,
    folder: expanded.folder && typeof expanded.folder === 'object' ? expanded.folder : null,
    steps: Array.isArray(expanded.steps) ? expanded.steps : [],
    warnings: Array.isArray(expanded.warnings) ? expanded.warnings : [],
    partial: false,
    source: 'snapshot',
    hideJiraSidebar: true,
  };
}

/**
 * Fetch expanded test from Xray, persist to MongoDB test_expanded_details, return payload.
 * Called both when test is not in MongoDB and when cached steps are missing testSteps text.
 * Xray credentials must be present; TEST_REPOSITORY_TEST_DETAIL_LIVE_FALLBACK gates first-time
 * fetches but missing-steps re-fetches always run when credentials exist.
 * @param {string} resolvedIssueId numeric Jira issue id
 * @param {{ allowWithoutFallbackFlag?: boolean }} [opts]
 * @returns {Promise<object | null>}
 */
async function tryLiveFetchExpandedTest(resolvedIssueId, opts = {}) {
  const { allowWithoutFallbackFlag = false } = opts;
  if (!allowWithoutFallbackFlag && !env.TEST_REPOSITORY_TEST_DETAIL_LIVE_FALLBACK) return null;
  if (!env.XRAY_CLIENT_ID || !env.XRAY_CLIENT_SECRET) return null;
  const id = resolvedIssueId ? String(resolvedIssueId).trim() : '';
  if (!id) return null;
  const log = logger.child({ fn: 'tryLiveFetchExpandedTest', issueId: id });
  try {
    log.info('Fetching expanded test from Xray...');
    const d = await xrayCloudClient.fetchExpandedTestByIssueId(id);
    let slim = toStepsOnlyTestDetail(d);
    if (!slim) {
      log.warn('Xray returned no usable payload');
      return null;
    }
    if (slim.steps?.length) {
      slim = { ...slim, steps: xrayCloudClient.enrichStepsTestStepsDisplay(slim.steps) };
    }
    if (env.MONGODB_URI) {
      try {
        await testExpandedDetailsMongoStore.upsertDetail(slim, slim.issueId || id, slim.jiraKey);
        log.info({ stepCount: slim.steps?.length }, 'Saved to MongoDB test_expanded_details');
      } catch (dbErr) {
        log.warn({ err: dbErr.message }, 'MongoDB upsert failed — returning payload anyway');
      }
    }
    return { ...slim, source: 'live-cached', partial: false };
  } catch (err) {
    log.warn({ err: err.message }, 'Live Xray fetch failed');
    return null;
  }
}

/**
 * Modal payload: Mongo expanded → (optional) live Xray + cache → snapshot cachedDetail → minimal.
 * Key-only requests resolve numeric issue id from the saved snapshot first; Jira REST is used only
 * when TEST_REPOSITORY_TEST_DETAIL_LIVE_FALLBACK is true and the snapshot row has no issueId.
 * @param {string} [issueId]
 * @param {string} [issueKey]
 */
function stepsMissingTestInstructions(detail) {
  if (!detail || !Array.isArray(detail.steps) || detail.steps.length === 0) return true;
  return detail.steps.some((s) => !String(s?.testSteps ?? '').trim());
}

async function getTestDetailFromSnapshot(issueId, issueKey) {
  const keyU = issueKey ? String(issueKey).trim().toUpperCase() : '';
  let idStr = issueId ? String(issueId).trim() : '';

  if (env.MONGODB_URI) {
    try {
      const hit = await testExpandedDetailsMongoStore.findByJiraKeyOrIssueId(keyU, idStr);
      if (hit?.detail && typeof hit.detail === 'object' && Array.isArray(hit.detail.steps)) {
        const fromMongo = { ...hit.detail, source: 'mongodb-expanded', partial: false };
        // Only re-fetch from Xray when the live-fallback flag is explicitly enabled.
        // Backfill is complete — the flag is false, so we serve MongoDB directly.
        if (env.TEST_REPOSITORY_TEST_DETAIL_LIVE_FALLBACK && env.XRAY_CLIENT_ID && env.XRAY_CLIENT_SECRET && stepsMissingTestInstructions(fromMongo)) {
          const rid = fromMongo.issueId || idStr;
          if (rid) {
            const live = await tryLiveFetchExpandedTest(String(rid));
            if (live?.steps?.length) return live;
          }
        }
        return fromMongo;
      }
    } catch {
      /* continue */
    }
  }

  const doc = await loadSnapshotForFrontend();
  if (!idStr && keyU && doc) {
    const rowForId = findTestRow(doc, null, issueKey);
    if (rowForId?.issueId != null) idStr = String(rowForId.issueId);
  }

  let resolvedId = idStr;
  if (!resolvedId && keyU && env.TEST_REPOSITORY_TEST_DETAIL_LIVE_FALLBACK) {
    resolvedId = (await xrayCloudClient.resolveJiraIssueIdByKey(keyU)) || '';
  }

  const liveFromParams = await tryLiveFetchExpandedTest(resolvedId);
  if (liveFromParams) return liveFromParams;

  if (!doc) return null;
  const row = findTestRow(doc, issueId, issueKey);
  if (!row) return null;

  if (!resolvedId && row.issueId) {
    resolvedId = String(row.issueId);
  }
  const liveFromRow = await tryLiveFetchExpandedTest(resolvedId);
  if (liveFromRow) return liveFromRow;

  if (row.cachedDetail && typeof row.cachedDetail === 'object') {
    const slim = toStepsOnlyTestDetail(row.cachedDetail);
    if (slim) {
      return { ...slim, source: 'snapshot', partial: false };
    }
    return {
      ...row.cachedDetail,
      source: 'snapshot',
      partial: false,
      hideJiraSidebar: true,
    };
  }
  return buildMinimalTestDetail(row);
}

/**
 * Build partial or final snapshot document for Xray Cloud import.
 * @param {object} p
 */
function buildCloudSnapshotDoc(p) {
  const {
    importedAt,
    projectKeyResolved,
    projectKey,
    projectName,
    projectResolveVia,
    importRootPath,
    treeRoot,
    flatFolders,
    projectId,
    tests,
    importStatus,
    checkpoint,
  } = p;
  return {
    importedAt,
    projectKey: projectKeyResolved || projectKey,
    projectName: projectName || projectKey,
    projectId: projectId != null ? String(projectId) : null,
    jiraBrowseBaseUrl: env.JIRA_BASE_URL || null,
    apiKind: 'xray-cloud-graphql',
    projectResolveVia: projectResolveVia || null,
    importRootPath: importRootPath || '/',
    folderTreeRoot: treeRoot,
    folders: flatFolders,
    tests,
    stats: {
      folderCount: flatFolders.length,
      testCount: tests.length,
    },
    importStatus,
    ...(checkpoint ? { checkpoint } : {}),
  };
}

async function runCloudImport(projectKey, pageSize, log, options = {}) {
  const resume = Boolean(options.resume);
  let treeRoot;
  let flatFolders;
  let projectId;
  let projectName;
  let projectKeyResolved;
  let projectResolveVia;
  let importRootPath;
  /** @type {Array<object>} */
  let tests = [];
  let importStartedAt = new Date().toISOString();
  let startFolderIdx = 0;

  if (resume) {
    const prev = options.existingDoc || (await load());
    if (!prev || prev.importStatus !== 'in_progress' || prev.apiKind !== 'xray-cloud-graphql') {
      throw new Error(
        'Cannot resume: no in-progress Xray Cloud snapshot. Run import without --resume (or clear snapshot) first.'
      );
    }
    if (String(prev.projectKey || '').toUpperCase() !== String(projectKey).toUpperCase()) {
      throw new Error(`Resume project mismatch: snapshot has ${prev.projectKey}, CLI passed ${projectKey}`);
    }
    if (!prev.checkpoint || typeof prev.checkpoint.resumeFromFolderIndex !== 'number') {
      throw new Error('Cannot resume: snapshot is missing checkpoint.resumeFromFolderIndex');
    }
    if (!prev.projectId || !Array.isArray(prev.folders) || !prev.folderTreeRoot) {
      throw new Error('Cannot resume: snapshot missing projectId, folders, or folderTreeRoot');
    }
    treeRoot = prev.folderTreeRoot;
    flatFolders = prev.folders;
    projectId = prev.projectId;
    projectName = prev.projectName;
    projectKeyResolved = prev.projectKey;
    projectResolveVia = prev.projectResolveVia;
    importRootPath = prev.importRootPath || '/';
    tests = Array.isArray(prev.tests) ? [...prev.tests] : [];
    importStartedAt = prev.importedAt || importStartedAt;
    startFolderIdx = prev.checkpoint.resumeFromFolderIndex;
    if (log) {
      log.info(
        `Resuming Xray import: next folder index ${startFolderIdx}/${flatFolders.length} (${tests.length} test rows already stored)`
      );
    }
  } else {
    if (log) {
      log.info(
        `Resolving Jira project + walking entire Xray folder tree from root "${options.rootPath ?? '/'}" — no per-folder progress until this step finishes (large repos: many minutes, many GraphQL calls).`
      );
    }
    const ctx = await xrayCloudClient.fetchFolderTree(projectKey, { rootPath: options.rootPath });
    treeRoot = ctx.treeRoot;
    flatFolders = ctx.flatFolders;
    projectId = ctx.projectId;
    projectName = ctx.projectName;
    projectKeyResolved = ctx.projectKeyResolved;
    projectResolveVia = ctx.projectResolveVia;
    importRootPath = ctx.importRootPath;
    if (log) {
      log.info(
        `Folder tree loaded: ${flatFolders.length} folder path(s), projectId=${projectId} — fetching tests per folder (checkpoints save to Mongo after each folder)…`
      );
    }
  }

  const totalFolders = flatFolders.length;

  if (startFolderIdx >= totalFolders) {
    if (log) log.info('All folders already fetched from snapshot; running expanded enrichment if enabled…');
    await enrichTestsWithExpandedDetailsFromXray(tests, log);
    const doc = buildCloudSnapshotDoc({
      importedAt: importStartedAt,
      projectKeyResolved,
      projectKey,
      projectName,
      projectResolveVia,
      importRootPath,
      treeRoot,
      flatFolders,
      projectId,
      tests,
      importStatus: 'complete',
    });
    await persist(doc, log);
    if (log) log.info(`Cloud import finished: ${tests.length} test row(s) — snapshot saved (complete).`);
    return doc;
  }

  for (let folderIndex = startFolderIdx; folderIndex < totalFolders; folderIndex += 1) {
    const folder = flatFolders[folderIndex];
    const n = folderIndex + 1;
    if (log && (n === 1 || n % 100 === 0 || n === totalFolders)) {
      log.info(`Xray Cloud import: folder ${n}/${totalFolders} — ${folder.path}`);
    }
    const list = await xrayCloudClient.fetchAllTestsInFolder(projectId, folder.id, pageSize);
    for (const t of list) {
      tests.push({
        ...t,
        folderId: folder.id,
        folderPath: folder.path,
      });
    }

    const partialDoc = buildCloudSnapshotDoc({
      importedAt: importStartedAt,
      projectKeyResolved,
      projectKey,
      projectName,
      projectResolveVia,
      importRootPath,
      treeRoot,
      flatFolders,
      projectId,
      tests,
      importStatus: 'in_progress',
      checkpoint: {
        resumeFromFolderIndex: folderIndex + 1,
        totalFolders,
        updatedAt: new Date().toISOString(),
      },
    });
    await persist(partialDoc, log, { quiet: true });
    if (log && (n % 25 === 0 || n === totalFolders || n === 1)) {
      log.info(
        `Test Repository checkpoint: folder ${n}/${totalFolders}, ${tests.length} test rows → MongoDB + test-repository.json`
      );
    }
  }

  await enrichTestsWithExpandedDetailsFromXray(tests, log);

  if (log) {
    log.info(`Cloud import gathered ${tests.length} test row(s); saving final snapshot…`);
  }

  const doc = buildCloudSnapshotDoc({
    importedAt: importStartedAt,
    projectKeyResolved,
    projectKey,
    projectName,
    projectResolveVia,
    importRootPath,
    treeRoot,
    flatFolders,
    projectId,
    tests,
    importStatus: 'complete',
  });
  await persist(doc, log);
  return doc;
}

async function runServerImport(projectKey, pageSize, log) {
  if (log) {
    log.info('Xray Server REST: resolving folder tree (may take a while before next log)…');
  }
  const { treeRoot, flatFolders } = await jiraXrayClient.fetchFolderTree(projectKey);
  if (log) {
    log.info(`Server folder tree loaded: ${flatFolders.length} folder(s) — fetching tests…`);
  }

  const tests = [];
  let folderIndex = 0;
  for (const folder of flatFolders) {
    folderIndex += 1;
    if (log && (folderIndex === 1 || folderIndex % 100 === 0 || folderIndex === flatFolders.length)) {
      log.info(`Xray Server import: folder ${folderIndex}/${flatFolders.length} — ${folder.path}`);
    }
    const list = await jiraXrayClient.fetchAllTestsInFolder(projectKey, folder.id, pageSize);
    for (const t of list) {
      tests.push({
        ...t,
        folderId: folder.id,
        folderPath: folder.path,
      });
    }
  }

  return {
    importedAt: new Date().toISOString(),
    projectKey,
    projectName: null,
    jiraBrowseBaseUrl: env.JIRA_BASE_URL || null,
    apiKind: 'xray-server-rest',
    projectResolveVia: 'jira-server-rest',
    importRootPath: '/',
    folderTreeRoot: treeRoot,
    folders: flatFolders,
    tests,
    stats: {
      folderCount: flatFolders.length,
      testCount: tests.length,
    },
  };
}

/**
 * One-time style import: full folder tree + all tests per folder with pagination.
 * Uses Xray **Cloud** GraphQL when XRAY_CLIENT_ID + XRAY_CLIENT_SECRET are set; otherwise Xray Server REST.
 * @param {string} projectKey Jira project key (e.g. TEST)
 * @param {{ pageSize?: number, rootPath?: string, resume?: boolean }} options rootPath: Xray folder path e.g. "/trial/Sanity Cases" (Cloud only); resume: continue from Mongo/file checkpoint
 * @param {import('winston').Logger} log
 */
async function runImport(projectKey, options = {}, log) {
  const pageSize = Number(options.pageSize) > 0 ? Number(options.pageSize) : 100;
  const rootPath =
    typeof options.rootPath === 'string' && options.rootPath.trim() !== ''
      ? options.rootPath.trim()
      : undefined;
  const useCloud = Boolean(env.XRAY_CLIENT_ID && env.XRAY_CLIENT_SECRET);

  if (log) {
    log.info(
      `Starting import (mode=${useCloud ? 'Xray Cloud GraphQL' : 'Xray Server REST'}, pageSize=${pageSize}${options.resume ? ', resume=true' : ''})`
    );
  }

  if (useCloud && !env.MONGODB_URI && log) {
    log.warn(
      'Test Repository: MONGODB_URI is not set — the snapshot is saved only to backend/data/test-repository.json. Set MONGODB_URI so the UI can read from MongoDB after sync.'
    );
  }

  if (useCloud) {
    let existingDoc = null;
    if (options.resume) {
      existingDoc = await load();
    } else {
      const prev = await load();
      if (
        prev &&
        prev.apiKind === 'xray-cloud-graphql' &&
        prev.importStatus === 'in_progress'
      ) {
        throw new Error(
          'A previous Xray Cloud import is in progress (checkpoint on disk/Mongo). Re-run with resume=true (API) or --resume (CLI), or clear the snapshot first (POST /api/test-repository/clear or Clear saved snapshot in the UI).'
        );
      }
    }
    return runCloudImport(projectKey, pageSize, log, {
      rootPath,
      resume: options.resume,
      existingDoc,
    });
  }

  try {
    const doc = await runServerImport(projectKey, pageSize, log);
    await persist(doc, log);
    return doc;
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('404')) {
      throw new Error(
        `${msg} — On Jira Cloud, Xray uses the Cloud API: set XRAY_CLIENT_ID and XRAY_CLIENT_SECRET (Xray → Global Settings → API Keys) in backend .env, then run import again.`
      );
    }
    throw err;
  }
}

/**
 * Fetches Xray getExpandedTest for each unique issue id in test-repository.json and stores steps-focused rows in MongoDB `test_expanded_details` (for fast offline modal without loading the full snapshot).
 * @param {import('winston').Logger} log
 * @param {{ concurrency?: number, skipExisting?: boolean }} options
 */
async function runBackfillExpandedDetails(log, options = {}) {
  if (!env.XRAY_CLIENT_ID || !env.XRAY_CLIENT_SECRET) {
    throw new Error('XRAY_CLIENT_ID and XRAY_CLIENT_SECRET are required for expanded backfill');
  }
  if (!env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required to store expanded details in MongoDB');
  }
  const concurrency = Math.max(1, Math.min(20, Number(options.concurrency) || 5));
  const tests = loadFromFile()?.tests || [];
  let ids = [...new Set(tests.map((t) => t.issueId).filter(Boolean).map((id) => String(id)))];
  const totalUniqueInFile = ids.length;
  if (ids.length === 0) {
    if (log) log.warn('No tests in test-repository.json — nothing to backfill');
    return { ok: true, total: 0, totalUniqueInFile: 0, skippedAlreadyInMongo: 0, saved: 0, failed: 0 };
  }

  let skippedAlreadyInMongo = 0;
  if (options.skipExisting) {
    try {
      const have = await testExpandedDetailsMongoStore.listStoredIssueIds();
      const before = ids.length;
      ids = ids.filter((id) => !have.has(String(id).trim()));
      skippedAlreadyInMongo = before - ids.length;
      if (log) {
        log.info(
          `Skip-existing: ${skippedAlreadyInMongo} issue id(s) already in MongoDB — ${ids.length} remaining to fetch`
        );
      }
    } catch (e) {
      if (log) log.warn(`Skip-existing: could not list Mongo (${e.message}) — fetching all`);
    }
  }

  if (ids.length === 0) {
    if (log) log.info('Backfill expanded: nothing to do (all ids already cached).');
    return {
      ok: true,
      total: 0,
      totalUniqueInFile,
      skippedAlreadyInMongo,
      saved: 0,
      failed: 0,
    };
  }

  if (log) {
    log.info(`Backfill expanded details: ${ids.length} issue id(s) to fetch, concurrency=${concurrency}`);
  }

  // Batch size: number of tests fetched per GraphQL request (aliased queries).
  // BACKFILL_BATCH_SIZE env var overrides. 10 is safe; up to 20 if no rate limit issues.
  const batchSize = Math.max(1, Math.min(50, Number(env.BACKFILL_BATCH_SIZE) || 10));
  // Minimum gap between batch requests to avoid 429s.
  // BACKFILL_DELAY_MS env var overrides (e.g. 2000 for safer, 500 for faster).
  const delayMs = Math.max(0, Number(env.BACKFILL_DELAY_MS) || 1500);

  let nextBatch = 0;
  let saved = 0;
  let failed = 0;
  let processed = 0;
  const startTime = Date.now();

  // Pre-split ids into batches
  const batches = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    batches.push(ids.slice(i, i + batchSize));
  }

  if (log) log.info(`Backfill: ${ids.length} tests in ${batches.length} batches of ${batchSize} (delay=${delayMs}ms/batch)`);

  async function worker() {
    for (;;) {
      const bi = nextBatch;
      nextBatch += 1;
      if (bi >= batches.length) return;
      const batch = batches[bi];
      const t0 = Date.now();
      try {
        const results = await xrayCloudClient.fetchExpandedTestsBatch(batch);
        for (const r of results) {
          if (r.detail) {
            let slim = toStepsOnlyTestDetail(r.detail);
            if (slim?.steps?.length) {
              slim = { ...slim, steps: xrayCloudClient.enrichStepsTestStepsDisplay(slim.steps) };
            }
            if (slim) {
              await testExpandedDetailsMongoStore.upsertDetail(slim, slim.issueId || r.issueId, slim.jiraKey);
              saved += 1;
            }
          } else {
            failed += 1;
            if (log) log.warn(`Backfill expanded ${r.issueId}: ${r.error}`);
          }
          processed += 1;
        }
      } catch (e) {
        // Batch-level error — count all as failed
        failed += batch.length;
        processed += batch.length;
        if (log) log.warn(`Backfill batch [${batch[0]}…${batch[batch.length - 1]}]: ${e.message}`);
      }
      if (log && (bi % 5 === 0 || bi === batches.length - 1)) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const rate = processed / (elapsed || 1);
        const remaining = Math.round((ids.length - processed) / (rate || 1));
        log.info(
          `Backfill: ${processed}/${ids.length} processed | saved=${saved} failed=${failed} | ~${remaining}s remaining`
        );
      }
      // Respect rate limit between batch requests
      const spent = Date.now() - t0;
      const wait = delayMs - spent;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));

  if (log) {
    log.info(
      `Backfill expanded done: saved≈${saved} failed=${failed} (fetched batch size=${ids.length}; file had ${totalUniqueInFile} unique ids)`
    );
  }
  return {
    ok: true,
    total: ids.length,
    totalUniqueInFile,
    skippedAlreadyInMongo,
    saved,
    failed,
  };
}

module.exports = {
  load,
  loadSnapshotForFrontend,
  /** @internal sync file read */
  loadFromFile,
  runImport,
  persist,
  clearSnapshot,
  getTestDetailFromSnapshot,
  getSnapshotReadiness,
  findTestRow,
  toStepsOnlyTestDetail,
  runBackfillExpandedDetails,
  /** @internal */
  _dataFilePath: dataFile,
};
