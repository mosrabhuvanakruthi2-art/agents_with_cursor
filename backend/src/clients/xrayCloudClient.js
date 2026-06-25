/**
 * Xray **Cloud** — GraphQL API + client credentials (not Jira Basic auth).
 * @see https://docs.getxray.app/display/XRAYCLOUD/REST+API
 * @see https://us.xray.cloud.getxray.app/doc/graphql/query.doc.html
 */

const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');

let cachedToken = null;
let cachedTokenUntil = 0;

function normalizeJiraBase(url) {
  let u = String(url || '')
    .trim()
    .replace(/\/+$/, '');
  // UI links often end with /jira — REST API lives at site root
  u = u.replace(/\/jira\/?$/i, '');
  return u;
}

function jiraBasicAuthHeader() {
  const user = env.JIRA_USER;
  const token = env.JIRA_API_TOKEN;
  const basic = Buffer.from(`${user}:${token}`, 'utf8').toString('base64');
  return `Basic ${basic}`;
}

/** Jira Cloud sometimes returns 404 (not 401) for bad tokens — verify session first. */
async function assertJiraSession(base) {
  const url = `${base}/rest/api/3/myself`;
  const res = await axios.get(url, {
    headers: { Authorization: jiraBasicAuthHeader(), Accept: 'application/json' },
    timeout: 30000,
    validateStatus: () => true,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Jira rejected credentials (${res.status}) on GET /rest/api/3/myself. Regenerate an API token at id.atlassian.com → Security → API tokens, set JIRA_API_TOKEN, and ensure JIRA_USER is the exact same Atlassian account email.`
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Jira /myself failed (${res.status}). Check JIRA_BASE_URL (e.g. https://cf2020.atlassian.net with no /jira).`
    );
  }
}

function xrayApiBase() {
  const b = (env.XRAY_CLOUD_BASE_URL || '').trim();
  return (b || 'https://xray.cloud.getxray.app').replace(/\/+$/, '');
}

async function authenticate() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenUntil - 60_000) {
    return cachedToken;
  }
  const clientId = env.XRAY_CLIENT_ID;
  const clientSecret = env.XRAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Xray Cloud requires XRAY_CLIENT_ID and XRAY_CLIENT_SECRET (Xray → Global Settings → API Keys). Jira API token alone cannot call Xray GraphQL.'
    );
  }
  const url = `${xrayApiBase()}/api/v2/authenticate`;
  // Retry on 429 — auth endpoint shares the same rate-limit budget as the GraphQL endpoint.
  for (let attempt = 0; attempt < XRAY_429_MAX_ROUNDS; attempt += 1) {
    const res = await axios.post(
      url,
      { client_id: clientId, client_secret: clientSecret },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: () => true }
    );
    if (res.status === 429) {
      const waitMs = compute429WaitMs(res);
      logger.info(
        `Xray authenticate HTTP 429 — waiting ${Math.ceil(waitMs / 1000)}s before retry (${attempt + 1}/${XRAY_429_MAX_ROUNDS})`
      );
      await delay(waitMs);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      throw new Error(`Xray Cloud authenticate failed (${res.status}): ${body.slice(0, 400)}`);
    }
    const token =
      typeof res.data === 'string' ? res.data.trim().replace(/^"|"$/g, '') : res.data?.token || res.data?.access_token;
    if (!token) {
      throw new Error('Xray Cloud authenticate: unexpected response (no token string)');
    }
    cachedToken = token;
    cachedTokenUntil = now + 50 * 60 * 1000;
    return token;
  }
  throw new Error(`Xray authenticate: still receiving 429 after ${XRAY_429_MAX_ROUNDS} retries`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** nginx / gateway blips (common on long full-repo imports) — retry before failing. */
const XRAY_GRAPHQL_RETRY_HTTP = new Set([502, 503, 504]);
const XRAY_GRAPHQL_RETRY_DELAYS_MS = [3000, 10000, 20000];

/** Waits between retries when axios times out (large getTests payloads). */
const XRAY_GRAPHQL_TIMEOUT_RETRY_DELAYS_MS = [8000, 20000, 45000];

function isAxiosTimeoutError(err) {
  if (!err) return false;
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return true;
  const m = String(err.message || '');
  return /timeout|timed out/i.test(m);
}

/** When Xray returns 429 without nextValidRequestDate in body. */
const XRAY_429_FALLBACK_WAIT_MS = 90_000;
/** Cap a single wait so bad timestamps cannot sleep for hours. */
const XRAY_429_MAX_SINGLE_WAIT_MS = 15 * 60 * 1000;
/** Max HTTP 429 wait-and-retry cycles per GraphQL POST (then return last 429 response). */
const XRAY_429_MAX_ROUNDS = 40;

function getRetryAfterHeaderMs(headers) {
  if (!headers) return null;
  const ra = headers['retry-after'];
  if (ra == null) return null;
  const s = parseInt(String(ra), 10);
  return Number.isFinite(s) ? s * 1000 : null;
}

function getNextValidRequestDateMsFromBody(body) {
  if (body == null) return null;
  let obj = body;
  if (typeof body === 'string') {
    try {
      obj = JSON.parse(body);
    } catch {
      const m = body.match(/"nextValidRequestDate"\s*:\s*"([^"]+)"/);
      if (!m) return null;
      const t = Date.parse(m[1]);
      return Number.isFinite(t) ? t : null;
    }
  }
  const nested = obj?.error?.nextValidRequestDate ?? obj?.nextValidRequestDate;
  if (typeof nested === 'string') {
    const t = Date.parse(nested);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function compute429WaitMs(res) {
  const fromBody = getNextValidRequestDateMsFromBody(res?.data);
  const fromHeader = getRetryAfterHeaderMs(res?.headers);
  let waitMs;
  if (fromBody != null) {
    waitMs = Math.max(0, fromBody - Date.now()) + 1000;
  } else if (fromHeader != null) {
    waitMs = fromHeader;
  } else {
    waitMs = XRAY_429_FALLBACK_WAIT_MS;
  }
  waitMs = Math.min(waitMs, XRAY_429_MAX_SINGLE_WAIT_MS);
  return Math.max(waitMs, 1000);
}

/**
 * POST GraphQL to Xray Cloud with backoff on transient HTTP failures, HTTP 429 (nextValidRequestDate), and timeout.
 * @param {string} query
 * @param {Record<string, unknown>} variables
 * @param {string} token
 */
async function postXrayGraphql(query, variables, token) {
  const url = `${xrayApiBase()}/api/v2/graphql`;
  const timeout = env.XRAY_GRAPHQL_TIMEOUT_MS;
  const config = {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout,
    validateStatus: () => true,
  };

  const maxTimeoutRounds = 1 + XRAY_GRAPHQL_TIMEOUT_RETRY_DELAYS_MS.length;

  outer429: for (let r429 = 0; r429 < XRAY_429_MAX_ROUNDS; r429 += 1) {
    for (let round = 0; round < maxTimeoutRounds; round += 1) {
      try {
        let res = await axios.post(url, { query, variables }, config);
        for (let i = 0; i < XRAY_GRAPHQL_RETRY_DELAYS_MS.length; i += 1) {
          if (res.status >= 200 && res.status < 300) break;
          if (!XRAY_GRAPHQL_RETRY_HTTP.has(res.status)) break;
          await delay(XRAY_GRAPHQL_RETRY_DELAYS_MS[i]);
          res = await axios.post(url, { query, variables }, config);
        }
        if (res.status === 429) {
          if (r429 < XRAY_429_MAX_ROUNDS - 1) {
            const waitMs = compute429WaitMs(res);
            logger.info(
              `Xray GraphQL HTTP 429 — waiting ${Math.ceil(waitMs / 1000)}s before retry (${r429 + 1}/${XRAY_429_MAX_ROUNDS})`
            );
            await delay(waitMs);
            continue outer429;
          }
          return res;
        }
        return res;
      } catch (err) {
        if (!isAxiosTimeoutError(err) || round >= maxTimeoutRounds - 1) {
          throw err;
        }
        const waitMs = XRAY_GRAPHQL_TIMEOUT_RETRY_DELAYS_MS[round] ?? 45000;
        const tLabel = timeout === 0 ? 'no client timeout' : `${timeout}ms`;
        logger.info(
          `Xray GraphQL timed out (${tLabel}, round ${round + 1}/${maxTimeoutRounds - 1}), retrying in ${waitMs}ms…`
        );
        await delay(waitMs);
      }
    }
  }
}

async function graphql(query, variables) {
  const token = await authenticate();
  const res = await postXrayGraphql(query, variables, token);
  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    throw new Error(`Xray GraphQL HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  if (res.data?.errors?.length) {
    const msg = res.data.errors.map((e) => e.message).join('; ');
    throw new Error(`Xray GraphQL: ${msg}`);
  }
  return res.data?.data;
}

/** Same as graphql but returns errors instead of throwing (for schema fallback). */
async function graphqlRaw(query, variables) {
  const token = await authenticate();
  const res = await postXrayGraphql(query, variables, token);
  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return {
      data: null,
      errors: [{ message: `Xray GraphQL HTTP ${res.status}: ${body.slice(0, 400)}` }],
    };
  }
  return {
    data: res.data?.data ?? null,
    errors: res.data?.errors?.length ? res.data.errors : null,
  };
}

function isLikelySchemaFieldError(errors) {
  if (!errors?.length) return false;
  const msg = errors.map((e) => e.message || '').join(' ');
  return /cannot query field|field ['"][^'"]+['"] doesn't exist|unknown argument|undefined field/i.test(msg);
}

async function getJiraProject(projectKey) {
  const base = normalizeJiraBase(env.JIRA_BASE_URL);
  const user = env.JIRA_USER;
  const token = env.JIRA_API_TOKEN;
  if (!base || !user || !token) {
    throw new Error('JIRA_BASE_URL, JIRA_USER, and JIRA_API_TOKEN are required for Jira REST project lookup');
  }

  await assertJiraSession(base);

  const url = `${base}/rest/api/3/project/${encodeURIComponent(projectKey)}`;
  const res = await axios.get(url, {
    headers: { Authorization: jiraBasicAuthHeader(), Accept: 'application/json' },
    timeout: 60000,
    validateStatus: () => true,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Jira auth failed (${res.status}) loading project "${projectKey}". Check JIRA_USER, JIRA_API_TOKEN, and JIRA_BASE_URL (site root, e.g. https://yoursite.atlassian.net).`
    );
  }
  if (res.status === 404) {
    throw new Error(
      `Jira returned 404 for project "${projectKey}". Common causes: (1) Wrong/expired API token — Jira Cloud often returns 404 instead of 401; create a new token and update JIRA_API_TOKEN. (2) JIRA_USER must be the Atlassian email for that token. (3) Your account cannot browse this project — ask an admin for "Browse projects". (4) Wrong site — JIRA_BASE_URL must match the space (e.g. https://cf2020.atlassian.net). (5) Wrong key — Space key must match (yours is TEST).`
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Jira project lookup failed (${res.status}): ${JSON.stringify(res.data).slice(0, 400)}`);
  }
  const id = res.data?.id;
  if (id == null) {
    throw new Error('Jira project response missing id');
  }
  return {
    id: String(id),
    name: res.data?.name || projectKey,
    key: res.data?.key || projectKey,
  };
}

const GET_PROJECT_SETTINGS = `
  query XrayProjectId($k: String!) {
    getProjectSettings(projectIdOrKey: $k) {
      projectId
    }
  }
`;

/**
 * Xray folder path for getFolder root. Strips leading "Test Repository" if pasted from UI breadcrumbs.
 * @param {string} [input] e.g. "/trial/Sanity Cases" or "trial/Sanity Cases"
 * @returns {string} path starting with /
 */
function normalizeXrayRootPath(input) {
  if (input == null || String(input).trim() === '') return '/';
  let s = String(input).trim().replace(/\\/g, '/');
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/^\/Test Repository\/?/i, '/');
  if (s !== '/') s = s.replace(/\/+$/, '') || '/';
  return s === '' ? '/' : s;
}

/**
 * Numeric Jira project id for Xray GraphQL. Tries Jira REST first; on failure uses Xray getProjectSettings (works when Jira API token is wrong but Xray keys are valid).
 */
async function resolveProjectContext(projectKey) {
  const base = normalizeJiraBase(env.JIRA_BASE_URL);
  const hasJira = Boolean(base && env.JIRA_USER && env.JIRA_API_TOKEN);
  let jiraErrMsg = null;
  if (hasJira) {
    try {
      const proj = await getJiraProject(projectKey);
      return {
        projectId: proj.id,
        projectName: proj.name,
        projectKeyResolved: proj.key,
        projectResolveVia: 'jira-rest',
      };
    } catch (e) {
      jiraErrMsg = e?.message || String(e);
    }
  }

  let data;
  try {
    data = await graphql(GET_PROJECT_SETTINGS, { k: projectKey });
  } catch (e) {
    throw new Error(
      `Cannot resolve project "${projectKey}": ${jiraErrMsg ? `Jira REST: ${jiraErrMsg} ` : ''}Xray: ${e.message}. Set XRAY_CLIENT_ID / XRAY_CLIENT_SECRET (and fix Jira token if you also need Jira REST).`
    );
  }
  const pid = data?.getProjectSettings?.projectId;
  if (pid == null) {
    throw new Error(
      `Cannot resolve project "${projectKey}": Xray getProjectSettings returned no projectId.${jiraErrMsg ? ` Jira REST: ${jiraErrMsg}` : ''}`
    );
  }
  return {
    projectId: String(pid),
    projectName: projectKey,
    projectKeyResolved: projectKey,
    projectResolveVia: 'xray-graphql',
  };
}

/** Xray Cloud: `folders` is scalar JSON — no sub-selections (see getFolder docs). Use String! for projectId (this API does not expose GraphQL scalar `ID`). */
const GET_FOLDER = `
  query GetFolder($projectId: String!, $path: String!) {
    getFolder(projectId: $projectId, path: $path) {
      name
      path
      testsCount
      folders
    }
  }
`;

/**
 * @param {unknown} raw value from GraphQL JSON scalar (often array of { name, path, testsCount?, folders? })
 * @returns {Array<{ name?: string, path?: string, testsCount?: number }>}
 */
function parseFoldersJson(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const o = /** @type {Record<string, unknown>} */ (raw);
    if ('path' in o || 'name' in o) return [o];
    if (Array.isArray(o.children)) return /** @type {any[]} */ (o.children);
    if (Array.isArray(o.folders)) return /** @type {any[]} */ (o.folders);
    const vals = Object.values(o);
    if (vals.length && vals.every((v) => v && typeof v === 'object')) return vals;
  }
  return [];
}

/** Xray Cloud returns TestResults: { total, start, limit, results: [Test!] } — fields live under `results`. */
const GET_TESTS = `
  query GetTests($projectId: String!, $limit: Int!, $start: Int!, $folderPath: String!) {
    getTests(projectId: $projectId, limit: $limit, start: $start, folder: { path: $folderPath }) {
      total
      start
      limit
      results {
        issueId
        testType { name }
        jira(fields: ["key", "summary", "status"])
        folder { path name }
      }
    }
  }
`;

/**
 * @param {unknown} getTestsVal value of data.getTests
 * @returns {{ batch: Array<object>, total: number | null }}
 */
function normalizeGetTestsPage(getTestsVal) {
  if (getTestsVal == null) return { batch: [], total: null };
  if (Array.isArray(getTestsVal)) {
    return { batch: getTestsVal, total: getTestsVal.length };
  }
  const results = getTestsVal.results;
  const batch = Array.isArray(results) ? results : [];
  const total = typeof getTestsVal.total === 'number' ? getTestsVal.total : null;
  return { batch, total };
}

/**
 * Recursively load folder tree (one getFolder per folder — matches Xray shallow responses).
 * @param {Set<string>} [visited] avoids cycles if API returns duplicate paths.
 */
async function loadFolderTree(projectId, path, visited = new Set()) {
  const normPath = path === '' ? '/' : path.startsWith('/') ? path : `/${path}`;
  if (visited.has(normPath)) {
    return {
      id: normPath,
      name: '(cycle)',
      path: normPath,
      testsCount: 0,
      folders: [],
    };
  }
  visited.add(normPath);

  const data = await graphql(GET_FOLDER, { projectId: String(projectId), path: normPath });
  const f = data?.getFolder;
  if (!f) {
    throw new Error(`getFolder returned empty for path "${normPath}"`);
  }
  const nodePath = f.path != null && f.path !== '' ? (f.path.startsWith('/') ? f.path : `/${f.path}`) : normPath;
  const node = {
    id: nodePath,
    name: f.name || 'Test Repository',
    path: nodePath,
    testsCount: f.testsCount ?? 0,
    folders: [],
  };
  const kids = parseFoldersJson(f.folders);
  for (const c of kids) {
    const childPath = c.path != null && c.path !== '' ? (c.path.startsWith('/') ? c.path : `/${c.path}`) : null;
    if (!childPath) continue;
    node.folders.push(await loadFolderTree(projectId, childPath, visited));
  }
  return node;
}

function flattenTree(node, out) {
  if (!node) return;
  out.push({
    id: node.path,
    name: node.name,
    path: node.path,
    testsCount: node.testsCount ?? 0,
  });
  for (const c of node.folders || []) flattenTree(c, out);
}

function normalizeJiraFields(jiraVal) {
  if (jiraVal == null) return {};
  if (typeof jiraVal === 'object' && !Array.isArray(jiraVal)) return jiraVal;
  if (typeof jiraVal === 'string') {
    try {
      return JSON.parse(jiraVal);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * @param {string} projectKey
 * @param {{ rootPath?: string }} [options] optional Xray path to start tree (e.g. "/trial/Sanity Cases"); default "/"
 * @returns {{ treeRoot: object, flatFolders: Array, projectId: string, projectName: string, projectKeyResolved: string, projectResolveVia: string, importRootPath: string }}
 */
async function fetchFolderTree(projectKey, options = {}) {
  const ctx = await resolveProjectContext(projectKey);
  const importRootPath = normalizeXrayRootPath(options.rootPath);
  const treeRoot = await loadFolderTree(ctx.projectId, importRootPath);
  const flatFolders = [];
  flattenTree(treeRoot, flatFolders);
  const seen = new Set();
  const deduped = [];
  for (const x of flatFolders) {
    if (seen.has(x.path)) continue;
    seen.add(x.path);
    deduped.push(x);
  }
  return {
    treeRoot,
    flatFolders: deduped,
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    projectKeyResolved: ctx.projectKeyResolved,
    projectResolveVia: ctx.projectResolveVia,
    importRootPath,
  };
}

/**
 * Paginate getTests for a folder path (folder id = path for Cloud).
 */
async function fetchAllTestsInFolder(projectId, folderPath, limit = 100) {
  const folderPathNorm =
    folderPath === '-1' || folderPath === ''
      ? '/'
      : folderPath.startsWith('/')
        ? folderPath
        : `/${folderPath}`;

  const all = [];
  const seen = new Set();
  let start = 0;
  const maxIterations = 100000;

  for (let i = 0; i < maxIterations; i += 1) {
    const data = await graphql(GET_TESTS, {
      projectId: String(projectId),
      limit,
      start,
      folderPath: folderPathNorm,
    });
    const { batch, total } = normalizeGetTestsPage(data?.getTests);
    if (batch.length === 0) break;

    for (const t of batch) {
      const j = normalizeJiraFields(t.jira);
      const key = j.key;
      if (!key) continue;
      const dedupe = `${folderPathNorm}:${key}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      all.push({
        issueId: t.issueId != null ? String(t.issueId) : undefined,
        jiraKey: String(key),
        summary: j.summary || '',
        testType: t.testType?.name || t.testType,
        status: j.status?.name || j.status || (typeof j.status === 'string' ? j.status : undefined),
        labels: undefined,
        assignee: undefined,
        rank: undefined,
      });
    }

    if (batch.length < limit) break;
    if (total != null && start + batch.length >= total) break;
    start += limit;
  }

  return all;
}

/** Base Jira fields for expanded test (GraphQL jira(fields: [...]) — JSON blob returned). */
const BASE_JIRA_FIELDS_FOR_EXPANDED = [
  'key',
  'summary',
  'status',
  'description',
  'assignee',
  'reporter',
  'priority',
  'labels',
  'components',
  'fixVersions',
  'issuetype',
  'creator',
  'created',
  'updated',
  'environment',
  'resolution',
  'duedate',
];

function jiraFieldsLiteralForExpandedTest() {
  const merged = [...new Set([...BASE_JIRA_FIELDS_FOR_EXPANDED, ...env.JIRA_TEST_DETAIL_JIRA_FIELDS])];
  return merged
    .map((f) => `"${String(f).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(', ');
}

/**
 * @param {{ includeXrayStatus?: boolean, includeStepComment?: boolean, includeStepCustomfields?: boolean, includeStepCallIds?: boolean }} opts
 */
function buildGetExpandedTestQuery(opts) {
  const {
    includeXrayStatus = true,
    includeStepComment = true,
    includeStepCustomfields = true,
    includeStepCallIds = true,
  } = opts;
  const jf = jiraFieldsLiteralForExpandedTest();
  const statusBlock = includeXrayStatus
    ? `
      status {
        name
        color
        description
      }`
    : '';
  const callIds = includeStepCallIds
    ? `
        libStepId
        parentTestIssueId
        calledTestIssueId`
    : '';
  const commentLine = includeStepComment ? '\n        comment' : '';
  /** Xray schema field is `customFields` (camelCase). Alias as `customfields` so downstream code stays unchanged. */
  const cfBlock = includeStepCustomfields
    ? `
        customfields: customFields {
          id
          value
        }`
    : '';

  return `
  query GetExpandedTest($issueId: String!) {
    getExpandedTest(issueId: $issueId) {
      issueId
      versionId
      projectId
      lastModified
      scenarioType
      testType { name kind }
      folder { path name }
      warnings${statusBlock}
      jira(fields: [${jf}])
      steps {
        id${callIds}
        data
        action
        result${commentLine}
        attachments { id filename }${cfBlock}
      }
    }
  }`;
}

const EXPANDED_QUERY_LEVELS = [
  { minimal: false, includeXrayStatus: true,  includeStepComment: true,  includeStepCustomfields: true,  includeStepCallIds: true  },
  { minimal: false, includeXrayStatus: false, includeStepComment: true,  includeStepCustomfields: true,  includeStepCallIds: true  },
  // Levels 0+1 fail when `comment` is not in the Xray schema ("Cannot query field 'comment' on ExpandedStep").
  // This level retries with comment=false but keeps customFields so step-level custom field values are preserved.
  { minimal: false, includeXrayStatus: false, includeStepComment: false, includeStepCustomfields: true,  includeStepCallIds: true  },
  { minimal: false, includeXrayStatus: false, includeStepComment: false, includeStepCustomfields: true,  includeStepCallIds: false },
  { minimal: false, includeXrayStatus: false, includeStepComment: false, includeStepCustomfields: false, includeStepCallIds: true  },
  { minimal: false, includeXrayStatus: false, includeStepComment: false, includeStepCustomfields: false, includeStepCallIds: false },
  { minimal: true },
];

function buildGetExpandedTestMinimalQuery() {
  const jf = jiraFieldsLiteralForExpandedTest();
  return `
  query GetExpandedTest($issueId: String!) {
    getExpandedTest(issueId: $issueId) {
      issueId
      versionId
      testType { name kind }
      folder { path name }
      warnings
      jira(fields: [${jf}])
      steps {
        id
        data
        action
        result
        attachments { id filename }
      }
    }
  }`;
}

function buildExpandedTestQueryForLevel(level) {
  if (level.minimal) return buildGetExpandedTestMinimalQuery();
  return buildGetExpandedTestQuery(level);
}

function formatJiraUser(u) {
  if (u == null) return null;
  if (typeof u === 'string') return u;
  if (typeof u === 'object') {
    return u.displayName || u.emailAddress || u.name || u.accountId || null;
  }
  return null;
}

function formatLabels(labels) {
  if (labels == null) return null;
  if (Array.isArray(labels)) {
    const parts = labels.map((x) =>
      typeof x === 'string' ? x : x?.name || x?.value || (typeof x === 'object' ? JSON.stringify(x) : String(x))
    );
    return parts.length ? parts.join(', ') : null;
  }
  return String(labels);
}

function formatNameList(arr) {
  if (arr == null || !Array.isArray(arr) || arr.length === 0) return null;
  const parts = arr.map((x) => (typeof x === 'string' ? x : x?.name || stringifyGraphqlValue(x)));
  const s = parts.filter(Boolean).join(', ');
  return s || null;
}

function stringifyGraphqlValue(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const inner = v.map(stringifyGraphqlValue).filter((x) => x !== '');
    return inner.join(', ');
  }
  if (typeof v === 'object') {
    if (v.name != null) return String(v.name);
    if (v.displayName != null) return String(v.displayName);
    if (v.value != null) return stringifyGraphqlValue(v.value);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Atlassian Document Format → readable plain text (paragraphs, lists, line breaks).
 * Xray "Test Steps" / Action / Data often use orderedList, bulletList, listItem — old logic dropped list text.
 */
function adfDocToPlainText(doc) {
  if (!doc || typeof doc !== 'object') return '';
  const nodes = doc.type === 'doc' && Array.isArray(doc.content) ? doc.content : Array.isArray(doc) ? doc : [];

  const walkBlock = (n, depth = 0) => {
    if (!n || typeof n !== 'object') return '';
    const t = n.type;
    if (t === 'text' && n.text) return n.text;
    if (t === 'hardBreak') return '\n';

    if (t === 'paragraph' && Array.isArray(n.content)) {
      return `${walkInline(n.content)}\n`;
    }
    if (t === 'heading' && Array.isArray(n.content)) {
      return `${walkInline(n.content)}\n\n`;
    }
    if (t === 'orderedList' && Array.isArray(n.content)) {
      let i = 1;
      const lines = [];
      for (const item of n.content) {
        if (item?.type === 'listItem' && Array.isArray(item.content)) {
          const body = walkBlock({ type: 'fragment', content: item.content }, depth + 1).trim();
          lines.push(`${i}. ${body.replace(/\n+/g, '\n   ')}`);
          i += 1;
        }
      }
      return `${lines.join('\n')}\n`;
    }
    if (t === 'bulletList' && Array.isArray(n.content)) {
      const lines = [];
      for (const item of n.content) {
        if (item?.type === 'listItem' && Array.isArray(item.content)) {
          const body = walkBlock({ type: 'fragment', content: item.content }, depth + 1).trim();
          lines.push(`• ${body.replace(/\n+/g, '\n  ')}`);
        }
      }
      return `${lines.join('\n')}\n`;
    }
    if (t === 'taskList' && Array.isArray(n.content)) {
      return walkBlock({ type: 'fragment', content: n.content }, depth);
    }
    if (t === 'listItem' && Array.isArray(n.content)) {
      return walkBlock({ type: 'fragment', content: n.content }, depth);
    }
    if (t === 'codeBlock' && Array.isArray(n.content)) {
      return `${walkInline(n.content)}\n`;
    }
    if (t === 'blockquote' && Array.isArray(n.content)) {
      return walkBlock({ type: 'fragment', content: n.content }, depth);
    }
    if (
      (t === 'expand' ||
        t === 'nestedExpand' ||
        t === 'panel' ||
        t === 'notePanel' ||
        t === 'extension' ||
        t === 'bodiedExtension') &&
      Array.isArray(n.content)
    ) {
      return walkBlock({ type: 'fragment', content: n.content }, depth);
    }
    if (t === 'table' && Array.isArray(n.content)) {
      return n.content.map((row) => walkBlock(row, depth)).join('');
    }
    if (t === 'tableRow' && Array.isArray(n.content)) {
      return `${n.content.map((cell) => walkBlock(cell, depth).replace(/\n/g, ' ').trim()).join(' | ')}\n`;
    }
    if ((t === 'tableCell' || t === 'tableHeader') && Array.isArray(n.content)) {
      return walkBlock({ type: 'fragment', content: n.content }, depth);
    }
    if (t === 'fragment' && Array.isArray(n.content)) {
      return n.content.map((c) => walkBlock(c, depth)).join('');
    }
    if (Array.isArray(n.content)) {
      return n.content.map((c) => walkBlock(c, depth)).join('');
    }
    return '';
  };

  function walkInline(nodes) {
    if (!Array.isArray(nodes)) return '';
    return nodes
      .map((n) => {
        if (!n || typeof n !== 'object') return '';
        if (n.type === 'text' && n.text) return n.text;
        if (n.type === 'hardBreak') return '\n';
        if (n.content) return walkInline(n.content);
        return '';
      })
      .join('');
  }

  let out = '';
  for (const block of nodes) {
    out += walkBlock(block);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Xray sometimes stores the whole step grid as one ADF `table` row (Data vs Test steps columns).
 * @param {object} tableBlock
 * @returns {string[] | null}
 */
function extractFirstTableRowCellsAsPlainText(tableBlock) {
  if (!tableBlock || tableBlock.type !== 'table' || !Array.isArray(tableBlock.content)) return null;
  const row = tableBlock.content.find((r) => r && r.type === 'tableRow');
  if (!row || !Array.isArray(row.content)) return null;
  const texts = [];
  for (const cell of row.content) {
    if (cell?.type !== 'tableCell' && cell?.type !== 'tableHeader') continue;
    const inner = cell.content || [];
    const txt = adfDocToPlainText({ type: 'doc', content: inner }).trim();
    texts.push(txt);
  }
  return texts.length ? texts : null;
}

/** Plain text for step action / data / expected (handles ADF-like doc nodes). */
function stepTextField(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.type === 'doc' && Array.isArray(v.content)) {
    return adfDocToPlainText(v);
  }
  // Handle non-doc ADF root nodes (e.g. orderedList, bulletList, paragraph returned as top-level value).
  // Wrap in a synthetic doc so adfDocToPlainText can walk the nodes normally.
  if (typeof v === 'object' && typeof v.type === 'string' && Array.isArray(v.content)) {
    return adfDocToPlainText({ type: 'doc', content: [v] });
  }
  if (typeof v === 'object') return stringifyGraphqlValue(v);
  return String(v);
}

const JIRA_DETAIL_KEYS_USED = new Set([
  'key',
  'summary',
  'status',
  'description',
  'assignee',
  'reporter',
  'priority',
  'labels',
  'components',
  'fixVersions',
  'issuetype',
  'creator',
  'created',
  'updated',
  'environment',
  'resolution',
  'duedate',
]);

function extractJiraExtras(j) {
  if (!j || typeof j !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(j)) {
    if (JIRA_DETAIL_KEYS_USED.has(k)) continue;
    if (v == null || v === '') continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeStepCustomfields(cf) {
  if (!Array.isArray(cf) || cf.length === 0) return null;
  return cf.map((row) => {
    const raw = row.value;
    const plain = stepTextField(raw);
    return {
      id: row.id != null ? String(row.id) : '',
      value: row.value,
      valuePlain: plain,
      valueDisplay: plain || stringifyGraphqlValue(row.value),
    };
  });
}

/** Jira / Xray may return `customfield_123` vs `123` — match env pin to API ids. */
function customFieldIdsEqual(a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (!x || !y) return false;
  if (x === y) return true;
  const nx = x.replace(/^customfield_/i, '');
  const ny = y.replace(/^customfield_/i, '');
  return nx === ny;
}

/**
 * Unwrap Jira ADF layoutSection → layoutColumn so paragraph + list split across columns is visible as separate blocks.
 */
function unwrapLayoutBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return blocks || [];
  const out = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'layoutSection' && Array.isArray(b.content)) {
      for (const col of b.content) {
        if (col?.type === 'layoutColumn' && Array.isArray(col.content)) {
          for (const inner of col.content) {
            if (inner) out.push(inner);
          }
        }
      }
    } else {
      out.push(b);
    }
  }
  return out.length ? out : blocks;
}

/**
 * Xray often wraps [paragraph, orderedList] inside a single panel / expand / blockquote — unwrap so we see multiple top-level blocks.
 */
function expandContainerBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const t = block.type;
  if (
    (t === 'panel' ||
      t === 'notePanel' ||
      t === 'expand' ||
      t === 'nestedExpand' ||
      t === 'blockquote') &&
    Array.isArray(block.content) &&
    block.content.filter(Boolean).length > 1
  ) {
    return block.content.filter(Boolean);
  }
  return null;
}

function unwrapContainersUntilMultiple(docContent) {
  let blocks = unwrapLayoutBlocks(docContent.filter(Boolean));
  for (let guard = 0; guard < 14; guard += 1) {
    if (blocks.length === 1) {
      const b0 = blocks[0];
      if (
        (b0?.type === 'panel' || b0?.type === 'notePanel') &&
        Array.isArray(b0.content) &&
        b0.content.length === 1
      ) {
        const inner = b0.content[0];
        if (inner) {
          blocks = unwrapLayoutBlocks([inner]);
          continue;
        }
      }
    }
    if (blocks.length !== 1) break;
    const expanded = expandContainerBlock(blocks[0]);
    if (!expanded || expanded.length < 2) break;
    blocks = unwrapLayoutBlocks(expanded);
  }
  return blocks;
}

/**
 * Split when blocks are [ …paragraphs… , orderedList, … ] — Jira "Data" vs "Test steps" columns.
 * @returns {{ dataColumn: string, testStepsFromData: string } | null}
 */
function splitBlocksAtFirstList(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const idx = blocks.findIndex(
    (b) => b && (b.type === 'orderedList' || b.type === 'bulletList' || b.type === 'taskList')
  );
  if (idx === -1) return null;
  if (idx === 0) {
    const full = adfDocToPlainText({ type: 'doc', content: blocks }).trim();
    return { dataColumn: '', testStepsFromData: full };
  }
  const dataColumn = adfDocToPlainText({ type: 'doc', content: blocks.slice(0, idx) }).trim();
  const testStepsFromData = adfDocToPlainText({ type: 'doc', content: blocks.slice(idx) }).trim();
  return { dataColumn, testStepsFromData };
}

/**
 * When the whole "Data" cell is one paragraph node but plain text has "line1\\n1. step…", split for the Test steps column.
 */
function splitPlainTextLeadingVsNumberedSteps(full) {
  const t = (full || '').trim();
  if (!t) return { dataColumn: '', testStepsFromData: '' };
  const lines = t.split(/\r?\n/);
  if (lines.length < 2) return { dataColumn: t, testStepsFromData: '' };

  const isStepStart = (line) => {
    const s = line.trim();
    return /^\d+\.\s/.test(s) || /^[•▪·]\s/.test(s) || /^\*\s/.test(s) || /^-\s/.test(s);
  };

  if (isStepStart(lines[0])) {
    return { dataColumn: '', testStepsFromData: t };
  }

  const firstIdx = lines.findIndex((line, i) => i > 0 && isStepStart(line));
  if (firstIdx === -1) return { dataColumn: t, testStepsFromData: '' };

  const dataColumn = lines.slice(0, firstIdx).join('\n').trim();
  const testStepsFromData = lines.slice(firstIdx).join('\n').trim();
  if (!testStepsFromData) return { dataColumn: t, testStepsFromData: '' };
  return { dataColumn: dataColumn || t, testStepsFromData };
}

/**
 * Jira UI "Test Steps" column is often a step-level custom field — pick best candidate for display.
 * Optional env: JIRA_XRAY_STEP_TEST_STEPS_CUSTOMFIELD_ID (e.g. customfield_10042) to pin the column.
 * Xray Cloud returns only {id, value} for step customFields — no name field.
 * Matching priority: env pin → id pattern (test steps / instruction / step) → longest value fallback.
 */
function extractTestStepsColumn(normalizedCustomfields) {
  const envId = (env.JIRA_XRAY_STEP_TEST_STEPS_CUSTOMFIELD_ID || '').trim();
  if (envId && Array.isArray(normalizedCustomfields)) {
    const hit = normalizedCustomfields.find((c) => customFieldIdsEqual(envId, c.id));
    if (hit?.valuePlain) return hit.valuePlain.trim();
  }
  if (!Array.isArray(normalizedCustomfields) || normalizedCustomfields.length === 0) {
    return '';
  }
  // Single custom field — use it directly (no ambiguity)
  const nonEmpty = normalizedCustomfields.filter((c) => (c.valuePlain || '').trim());
  if (nonEmpty.length === 1) return nonEmpty[0].valuePlain.trim();

  // Multiple fields — prioritize by ID pattern, then by content heuristics
  let best = '';
  let bestScore = -1;
  for (const c of normalizedCustomfields) {
    const p = (c.valuePlain || '').trim();
    if (!p) continue;
    const idStr = String(c.id || '');
    if (/test\s*steps/i.test(idStr)) return p;
    if (/instruction/i.test(idStr)) return p;
    let score = p.length;
    if (/step/i.test(idStr)) score += 5000;
    if (/test/i.test(idStr)) score += 1000;
    // Prioritize fields whose content looks like a numbered/bulleted list (actual steps)
    if (/^\d+\.\s/m.test(p) || /^[•▪·\-]\s/m.test(p)) score += 3000;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (best.trim()) return best.trim();
  // Xray Cloud uses opaque numeric IDs — fall back to longest non-empty value
  let longest = '';
  for (const c of normalizedCustomfields) {
    const p = (c.valuePlain || '').trim();
    if (p.length > longest.length) longest = p;
  }
  return longest.trim();
}

/**
 * Jira shows "Data" as the first line/block and "Test steps" as numbered lists that often live in the same `data` ADF
 * as following blocks. Flattening everything into one string hid the list in the UI.
 * @returns {{ dataColumn: string, testStepsFromData: string }}
 */
function splitDataFieldForJiraColumns(dataRaw) {
  if (dataRaw == null) return { dataColumn: '', testStepsFromData: '' };
  if (typeof dataRaw === 'string') {
    const inlineSplit = splitPlainTextLeadingVsNumberedSteps(dataRaw.trim());
    if (inlineSplit.testStepsFromData) return inlineSplit;
    return { dataColumn: dataRaw.trim(), testStepsFromData: '' };
  }
  if (typeof dataRaw === 'object' && dataRaw.type === 'doc' && Array.isArray(dataRaw.content)) {
    const blocks = unwrapContainersUntilMultiple(dataRaw.content);
    if (blocks.length === 0) return { dataColumn: '', testStepsFromData: '' };

    if (blocks[0]?.type === 'table') {
      const cells = extractFirstTableRowCellsAsPlainText(blocks[0]);
      if (cells && cells.length >= 2) {
        const dataColumn = cells[0] || '';
        const testStepsFromData = cells
          .slice(1)
          .map((c) => c.trim())
          .filter(Boolean)
          .join('\n\n')
          .trim();
        return { dataColumn, testStepsFromData };
      }
    }

    const splitAtList = splitBlocksAtFirstList(blocks);
    if (splitAtList && splitAtList.testStepsFromData) {
      return splitAtList;
    }

    const firstType = blocks[0]?.type;
    if (firstType === 'orderedList' || firstType === 'bulletList' || firstType === 'taskList') {
      const full = adfDocToPlainText({ type: 'doc', content: blocks }).trim();
      return { dataColumn: '', testStepsFromData: full };
    }

    if (blocks.length === 1) {
      const only = adfDocToPlainText({ type: 'doc', content: blocks }).trim();
      const inlineSplit = splitPlainTextLeadingVsNumberedSteps(only);
      if (inlineSplit.testStepsFromData) {
        return inlineSplit;
      }
      return { dataColumn: only, testStepsFromData: '' };
    }

    const full = adfDocToPlainText({ type: 'doc', content: blocks }).trim();
    const inlineSplit2 = splitPlainTextLeadingVsNumberedSteps(full);
    if (inlineSplit2.testStepsFromData) return inlineSplit2;
    return { dataColumn: full, testStepsFromData: '' };
  }
  const full = stepTextField(dataRaw);
  const inlineSplit = splitPlainTextLeadingVsNumberedSteps(full.trim());
  if (inlineSplit.testStepsFromData) return inlineSplit;
  return { dataColumn: full, testStepsFromData: '' };
}

/**
 * Resolve Jira numeric issue id from issue key (e.g. TEST-40365). Requires Jira REST auth.
 * @param {string} issueKey
 * @returns {Promise<string | null>}
 */
async function resolveJiraIssueIdByKey(issueKey) {
  const base = normalizeJiraBase(env.JIRA_BASE_URL);
  const user = env.JIRA_USER;
  const token = env.JIRA_API_TOKEN;
  if (!base || !user || !token) return null;
  try {
    await assertJiraSession(base);
  } catch {
    return null;
  }
  const url = `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
  const res = await axios.get(url, {
    headers: { Authorization: jiraBasicAuthHeader(), Accept: 'application/json' },
    timeout: 30000,
    validateStatus: () => true,
  });
  if (res.status !== 200) return null;
  const id = res.data?.id;
  return id != null ? String(id) : null;
}

/**
 * Full test + steps for detail modal (Xray Cloud).
 * @param {string} issueId Jira numeric issue id
 */
async function fetchExpandedTestByIssueId(issueId) {
  const vars = { issueId: String(issueId) };
  let lastErr = null;

  for (const level of EXPANDED_QUERY_LEVELS) {
    const query = buildExpandedTestQueryForLevel(level);
    const { data, errors } = await graphqlRaw(query, vars);
    const t = data?.getExpandedTest;
    if (t && (!errors || errors.length === 0)) {
      return normalizeExpandedTestPayload(t, issueId);
    }
    if (errors?.length) {
      lastErr = errors.map((e) => e.message).join('; ');
      if (isLikelySchemaFieldError(errors)) continue;
      throw new Error(`Xray GraphQL: ${lastErr}`);
    }
  }

  throw new Error(lastErr || 'Xray returned no test for this issue id');
}

function normalizeExpandedTestPayload(t, issueId) {
  const j = normalizeJiraFields(t.jira);
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const jiraStatus = j.status?.name != null ? String(j.status.name) : j.status != null ? String(j.status) : null;

  return {
    issueId: t.issueId != null ? String(t.issueId) : String(issueId),
    versionId: t.versionId != null ? String(t.versionId) : null,
    projectId: t.projectId != null ? String(t.projectId) : null,
    lastModified: t.lastModified != null ? String(t.lastModified) : null,
    scenarioType: t.scenarioType != null ? String(t.scenarioType) : null,
    jiraKey: j.key ? String(j.key) : null,
    summary: j.summary != null ? String(j.summary) : '',
    description: j.description,
    /** Jira workflow status (e.g. To Do) */
    status: jiraStatus,
    /** Xray test status (e.g. Open Test Status) */
    xrayTestStatus: t.status?.name != null ? String(t.status.name) : null,
    xrayTestStatusColor: t.status?.color != null ? String(t.status.color) : null,
    xrayTestStatusDescription: t.status?.description != null ? String(t.status.description) : null,
    assignee: formatJiraUser(j.assignee),
    reporter: formatJiraUser(j.reporter),
    priority: j.priority?.name || j.priority,
    labels: formatLabels(j.labels),
    components: formatNameList(j.components),
    fixVersions: formatNameList(j.fixVersions),
    issueType: j.issuetype?.name != null ? String(j.issuetype.name) : j.issuetype != null ? String(j.issuetype) : null,
    creator: formatJiraUser(j.creator),
    created: j.created != null ? String(j.created) : null,
    updated: j.updated != null ? String(j.updated) : null,
    environment: j.environment != null ? String(j.environment) : null,
    resolution: j.resolution?.name != null ? String(j.resolution.name) : j.resolution != null ? String(j.resolution) : null,
    duedate: j.duedate != null ? String(j.duedate) : null,
    jiraExtras: extractJiraExtras(j),
    testType: t.testType?.name || t.testType?.kind,
    folder: t.folder
      ? {
          path: t.folder.path,
          name: t.folder.name,
        }
      : null,
    steps: steps.map((s, idx) => {
      // DEBUG: log raw step structure on first step so we can see what Xray sends
      if (idx === 0) {
        logger.info({
          rawAction: typeof s.action === 'object' ? JSON.stringify(s.action).slice(0, 300) : String(s.action || '').slice(0, 300),
          rawData:   typeof s.data   === 'object' ? JSON.stringify(s.data  ).slice(0, 300) : String(s.data   || '').slice(0, 300),
          rawResult: typeof s.result === 'object' ? JSON.stringify(s.result).slice(0, 300) : String(s.result || '').slice(0, 300),
          customFieldIds: Array.isArray(s.customfields ?? s.customFields) ? (s.customfields ?? s.customFields).map((c) => c.id) : [],
        }, '[DEBUG] raw Xray step[0] — check types to fix column mapping');
      }
      const attachments = Array.isArray(s.attachments) ? s.attachments : [];
      const commentRaw = s.comment;
      const commentStr =
        commentRaw == null || commentRaw === ''
          ? null
          : (() => {
              const x = stepTextField(commentRaw);
              return x === '' ? null : x;
            })();
      const cfs = normalizeStepCustomfields(s.customfields ?? s.customFields);
      let fromCustom = extractTestStepsColumn(cfs);
      if (!String(fromCustom || '').trim() && cfs?.length) {
        const plainParts = cfs.map((c) => String(c.valuePlain || '').trim()).filter(Boolean);
        const numbered = plainParts.find((p) => /^\d+\.\s/m.test(p) || /^\d+\.\s/.test(p));
        if (numbered) fromCustom = numbered;
      }
      const split = splitDataFieldForJiraColumns(s.data);
      let fromData = split.testStepsFromData;
      let dataColumnBase = split.dataColumn;
      if (!String(fromData || '').trim() && s.data != null) {
        const dataPlain = stepTextField(s.data).trim();
        const numbered = splitPlainTextLeadingVsNumberedSteps(dataPlain);
        if (numbered.testStepsFromData) {
          fromData = numbered.testStepsFromData;
          if (numbered.dataColumn) dataColumnBase = numbered.dataColumn;
        }
      }
      let testStepsMerged =
        [fromCustom, fromData].map((x) => (x || '').trim()).filter(Boolean).join('\n\n') || null;
      if (!testStepsMerged && cfs?.length) {
        const joined = cfs
          .map((c) => String(c.valuePlain || '').trim())
          .filter((p) => p && !/^n\/a$/i.test(p))
          .join('\n\n')
          .trim();
        if (joined) testStepsMerged = joined;
      }
      const hasStepsCol = Boolean(testStepsMerged);
      let dataColumn = dataColumnBase;
      if (!hasStepsCol) {
        dataColumn = stepTextField(s.data);
      } else if (dataColumn === '' && fromCustom && !fromData) {
        dataColumn = stepTextField(s.data);
      }

      // Strip any numbered/bulleted list that leaked into the action field.
      // In some Xray instances the action ADF contains the step instructions list —
      // that content belongs in testSteps, not in the Action column.
      let actionText;
      if (s.action != null && typeof s.action === 'object' && s.action.type === 'doc') {
        const splitAction = splitDataFieldForJiraColumns(s.action);
        if (splitAction.testStepsFromData) {
          actionText = splitAction.dataColumn || '';
          if (!testStepsMerged) testStepsMerged = splitAction.testStepsFromData;
        } else {
          actionText = stepTextField(s.action);
        }
      } else {
        const rawAction = stepTextField(s.action);
        if (/^\d+\.\s/m.test(rawAction)) {
          const splitAction = splitPlainTextLeadingVsNumberedSteps(rawAction.trim());
          if (splitAction.testStepsFromData) {
            actionText = splitAction.dataColumn || '';
            if (!testStepsMerged) testStepsMerged = splitAction.testStepsFromData;
          } else {
            actionText = rawAction;
          }
        } else {
          actionText = rawAction;
        }
      }

      return {
        stepNumber: idx + 1,
        id: s.id,
        action: actionText,
        /** First block/line of Data; rest of `data` ADF goes to testSteps when present. */
        data: dataColumn,
        /** Custom field OR remainder of `data` after first ADF block (e.g. numbered list). */
        testSteps: testStepsMerged || null,
        result: stepTextField(s.result),
        expectedResult: stepTextField(s.result),
        comment: commentStr,
        attachments,
        attachmentCount: attachments.length,
        customfields: cfs,
        libStepId: s.libStepId != null ? String(s.libStepId) : null,
        parentTestIssueId: s.parentTestIssueId != null ? String(s.parentTestIssueId) : null,
        calledTestIssueId: s.calledTestIssueId != null ? String(s.calledTestIssueId) : null,
      };
    }),
    warnings: Array.isArray(t.warnings) ? t.warnings : [],
  };
}

/**
 * Re-applies Test steps extraction on cached/saved detail (Mongo, snapshot) so older rows and ID mismatches still show steps.
 * @param {Array<object>|undefined} steps
 * @returns {Array<object>|undefined}
 */
function enrichStepsTestStepsDisplay(steps) {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step) => enrichSingleStepTestStepsDisplay(step));
}

function enrichSingleStepTestStepsDisplay(step) {
  if (!step || typeof step !== 'object') return step;
  const prevTs = step.testSteps != null ? String(step.testSteps).trim() : '';
  let nextTs = prevTs;
  let nextData = step.data;

  const cfsRaw = step.customfields ?? step.customFields;
  const cfs = Array.isArray(cfsRaw) ? cfsRaw : null;
  const fromCustom = cfs ? extractTestStepsColumn(cfs).trim() : '';
  if (!nextTs && fromCustom) nextTs = fromCustom;

  if (!nextTs && nextData != null && typeof nextData === 'object' && nextData.type === 'doc') {
    const split = splitDataFieldForJiraColumns(nextData);
    if (split.testStepsFromData) {
      nextTs = split.testStepsFromData.trim();
      nextData = split.dataColumn || stepTextField(nextData);
    }
  }

  if (!nextTs && typeof nextData === 'string') {
    const splitPlain = splitPlainTextLeadingVsNumberedSteps(nextData.trim());
    if (splitPlain.testStepsFromData) {
      nextTs = splitPlain.testStepsFromData;
      nextData = splitPlain.dataColumn;
    }
  }

  // On-the-fly repair: old splitDataFieldForJiraColumns put extra paragraphs from the Data ADF
  // into testStepsFromData. Those leaked paragraphs end up appended AFTER the real numbered steps.
  // Detect paragraph-separated trailing blocks that contain no step markers and move them back to data.
  if (nextTs && typeof nextData === 'string') {
    const paras = nextTs.split(/\n\n+/);
    let lastStepParaIdx = -1;
    for (let i = paras.length - 1; i >= 0; i--) {
      if (/^\d+\./m.test(paras[i]) || /^[•▪·*-]\s/m.test(paras[i])) {
        lastStepParaIdx = i;
        break;
      }
    }
    if (lastStepParaIdx >= 0 && lastStepParaIdx < paras.length - 1) {
      const leaked = paras.slice(lastStepParaIdx + 1).join('\n\n').trim();
      if (leaked) {
        nextTs = paras.slice(0, lastStepParaIdx + 1).join('\n\n').trim();
        nextData = (nextData.trim() ? nextData.trim() + '\n\n' : '') + leaked;
      }
    }
  }

  // Strip numbered list that leaked into the action column for cached steps
  let nextAction = step.action != null ? String(step.action) : '';
  if (/^\d+\.\s/m.test(nextAction)) {
    const splitAct = splitPlainTextLeadingVsNumberedSteps(nextAction.trim());
    if (splitAct.testStepsFromData) {
      nextAction = splitAct.dataColumn || '';
      if (!nextTs) nextTs = splitAct.testStepsFromData;
    }
  }

  if (nextData === step.data && nextTs === prevTs && nextAction === step.action) return step;
  return { ...step, action: nextAction, data: nextData, testSteps: nextTs || null };
}

/**
 * Fetch multiple expanded tests in a single GraphQL request using aliased queries.
 * Uses a minimal query body (only steps + jiraKey/summary) to keep request size small.
 * Reduces HTTP round-trips by batchSize× vs individual fetchExpandedTestByIssueId calls.
 *
 * @param {string[]} issueIds  array of numeric Jira issue ids
 * @returns {Promise<Array<{issueId: string, detail: object|null, error: string|null}>>}
 */
async function fetchExpandedTestsBatch(issueIds) {
  if (!issueIds || issueIds.length === 0) return [];

  // Minimal query body — only what toStepsOnlyTestDetail needs.
  // Using "key" and "summary" only for jira to keep query size small.
  // Avoid aliases inside step body (counts toward Xray's 25 ops/request limit).
  const stepBody = `{
        id
        action
        data
        result
        attachments { id filename }
        customFields { id value }
      }`;

  // Full Jira field list — same as the single-test query. Adding more fields here
  // does NOT increase Xray's operation count (jira(...) counts as 1 operation).
  const jf = jiraFieldsLiteralForExpandedTest();

  const aliasLines = issueIds
    .map((id, idx) => `  t${idx}: getExpandedTest(issueId: "${id}") {
      issueId
      testType { name kind }
      folder { path name }
      warnings
      status { name color description }
      jira(fields: [${jf}])
      steps ${stepBody}
    }`)
    .join('\n');

  const batchQuery = `query BatchGetExpandedTests {\n${aliasLines}\n}`;

  const token = await authenticate();
  const res = await postXrayGraphql(batchQuery, {}, token);

  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    throw new Error(`Xray batch GraphQL HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const body = res.data;
  const results = [];

  for (let idx = 0; idx < issueIds.length; idx++) {
    const id = issueIds[idx];
    const alias = `t${idx}`;
    const t = body?.data?.[alias];
    const errs = body?.errors?.filter((e) => e.path?.[0] === alias);
    if (t) {
      try {
        results.push({ issueId: id, detail: normalizeExpandedTestPayload(t, id), error: null });
      } catch (e) {
        results.push({ issueId: id, detail: null, error: e.message });
      }
    } else {
      const msg = errs?.length ? errs.map((e) => e.message).join('; ') : 'no data returned';
      results.push({ issueId: id, detail: null, error: msg });
    }
  }

  return results;
}

module.exports = {
  fetchFolderTree,
  fetchAllTestsInFolder,
  fetchExpandedTestByIssueId,
  fetchExpandedTestsBatch,
  resolveJiraIssueIdByKey,
  getJiraProject,
  authenticate,
  normalizeXrayRootPath,
  resolveProjectContext,
  enrichStepsTestStepsDisplay,
};
