/**
 * Grafana / Loki log client for CloudFuze migration log analysis.
 *
 * Auth: Bearer token from a Grafana Service Account (Viewer role).
 *       Set GRAFANA_TOKEN in .env.  Falls back to basic auth if GRAFANA_USER + GRAFANA_PASSWORD set.
 *
 * Auto-detects data source type (Loki / Elasticsearch / Prometheus) on first use.
 * Queries are built around migration identifiers: workspaceId, source/dest email, time window.
 */

const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');

// ── config ────────────────────────────────────────────────────────────────────

const BASE_URL = (env.GRAFANA_BASE_URL || 'http://logwatch.cloudfuze.com').replace(/\/$/, '');

function getAuthHeader() {
  if (env.GRAFANA_TOKEN) return `Bearer ${env.GRAFANA_TOKEN}`;
  if (env.GRAFANA_USER && env.GRAFANA_PASSWORD) {
    return 'Basic ' + Buffer.from(`${env.GRAFANA_USER}:${env.GRAFANA_PASSWORD}`).toString('base64');
  }
  return null;
}

function http() {
  const auth = getAuthHeader();
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth) headers.Authorization = auth;
  return axios.create({ baseURL: BASE_URL, headers, timeout: 5000 });
}

// ── datasource discovery ──────────────────────────────────────────────────────

let _dsCache = null;
let _dsFailed = false;

async function discoverDataSources() {
  if (_dsCache) return _dsCache;
  if (_dsFailed) return [];
  try {
    const res = await http().get('/api/datasources');
    if (res.status !== 200) {
      logger.warn(`[grafana] datasources returned HTTP ${res.status}`);
      _dsFailed = true;
      return [];
    }
    _dsCache = res.data || [];
    logger.info(`[grafana] discovered ${_dsCache.length} data source(s): ${_dsCache.map((d) => `${d.name}(${d.type})`).join(', ')}`);
    return _dsCache;
  } catch (err) {
    logger.warn(`[grafana] discoverDataSources failed: ${err.message}`);
    _dsFailed = true;
    return [];
  }
}

async function findLokiDatasource() {
  const all = await discoverDataSources();
  return all.find((d) => d.type === 'loki');
}

async function findElasticsearchDatasource() {
  const all = await discoverDataSources();
  return all.find((d) => d.type === 'elasticsearch' || d.type === 'opensearch');
}

// ── Loki queries ──────────────────────────────────────────────────────────────

/**
 * Query Loki via Grafana proxy for a time range.
 * @param {string} dsUid - datasource UID
 * @param {string} logql  - LogQL query e.g. {job="cloudfuze"} |= "12345"
 * @param {Date}   from
 * @param {Date}   to
 * @param {number} limit  - max log lines to return
 */
async function queryLoki(dsUid, logql, from, to, limit = 500) {
  const params = {
    query: logql,
    start: Math.floor(from.getTime() / 1000),
    end:   Math.floor(to.getTime()   / 1000),
    limit,
    direction: 'forward',
  };
  try {
    const res = await http().get(`/api/datasources/proxy/uid/${dsUid}/loki/api/v1/query_range`, { params });
    if (res.data?.data?.result) {
      return extractLokiLines(res.data.data.result);
    }
    return [];
  } catch (err) {
    logger.warn(`[grafana] Loki query failed: ${err.message}`);
    return [];
  }
}

function extractLokiLines(streams) {
  const lines = [];
  for (const stream of streams || []) {
    for (const [tsNs, line] of stream.values || []) {
      lines.push({ ts: new Date(Number(tsNs) / 1e6).toISOString(), line });
    }
  }
  return lines.sort((a, b) => a.ts.localeCompare(b.ts));
}

// ── Elasticsearch / OpenSearch queries ───────────────────────────────────────

async function queryElasticsearch(dsUid, must, from, to, size = 500) {
  const query = {
    query: {
      bool: {
        must,
        filter: [{ range: { '@timestamp': { gte: from.toISOString(), lte: to.toISOString() } } }],
      },
    },
    sort: [{ '@timestamp': 'asc' }],
    size,
  };
  try {
    const res = await http().post(`/api/datasources/proxy/uid/${dsUid}/_search`, query);
    return (res.data?.hits?.hits || []).map((h) => ({
      ts: h._source?.['@timestamp'] || h._source?.timestamp || '',
      line: h._source?.message || h._source?.log || JSON.stringify(h._source),
    }));
  } catch (err) {
    logger.warn(`[grafana] Elasticsearch query failed: ${err.message}`);
    return [];
  }
}

// ── main search entry point ───────────────────────────────────────────────────

/**
 * Searches Grafana for CloudFuze migration logs related to an execution.
 *
 * Strategy:
 *   1. Build search terms from workspaceId, source/dest emails, and mismatch subjects.
 *   2. Auto-detect data source type (Loki or Elasticsearch).
 *   3. Query within ±15 minutes of the execution window.
 *   4. Return log lines grouped by relevance category.
 *
 * @param {object} context    - MigrationContext (sourceEmail, destinationEmail, testType, etc.)
 * @param {object} jobDetails - { workspaceId, cfStatus, processedCount, totalCount }
 * @param {Date}   startTime  - execution start time
 * @param {Date}   endTime    - execution end time
 * @param {Array}  mismatches - array of mismatch objects for targeted log search
 * @returns {Promise<{available: boolean, lines: Array, evidence: object}>}
 */
async function searchMigrationLogs(context, jobDetails, startTime, endTime, mismatches = []) {
  if (!getAuthHeader()) {
    return { available: false, reason: 'GRAFANA_TOKEN not set in .env', lines: [], evidence: {} };
  }

  const workspaceId = jobDetails?.workspaceId;
  const from = new Date(startTime.getTime() - 2 * 60 * 1000);  // 2 min before
  const to   = new Date(endTime.getTime()   + 5 * 60 * 1000);  // 5 min after

  // ── detect data source ────────────────────────────────────────────────────
  const lokiDs = await findLokiDatasource();
  const esDs   = !lokiDs ? await findElasticsearchDatasource() : null;

  if (!lokiDs && !esDs) {
    return { available: false, reason: 'No Loki or Elasticsearch datasource found in Grafana', lines: [], evidence: {} };
  }

  // ── build search terms ────────────────────────────────────────────────────
  const searchTerms = [];
  if (workspaceId && workspaceId !== 'initiated') searchTerms.push(workspaceId);
  searchTerms.push(context.sourceEmail.toLowerCase());
  searchTerms.push(context.destinationEmail.toLowerCase());

  // Subjects from not-found mismatches for targeted search
  const notFoundSubjects = mismatches
    .filter((m) => m.category === 'deepMail' && String(m.actual || '').includes('No Gmail message'))
    .map((m) => m.messageSubject)
    .filter(Boolean)
    .slice(0, 5); // limit to top 5 to avoid overly long queries

  let allLines = [];

  if (lokiDs) {
    logger.info(`[grafana] querying Loki (${lokiDs.name}) with ${searchTerms.length} search term(s)`);

    // Base query: any log stream containing any of our identifiers
    const baseFilter = searchTerms.map((t) => `|~ \`(?i)${escapeRegex(t)}\``).join(' ');
    const lokiQuery = `{job=~".+"} ${baseFilter}`;
    allLines = await queryLoki(lokiDs.uid, lokiQuery, from, to, 1000);

    // If no lines with workspace ID, try email-only (workspace might not be in all logs)
    if (allLines.length === 0 && workspaceId) {
      const emailQuery = `{job=~".+"} |~ \`(?i)${escapeRegex(context.sourceEmail)}\``;
      allLines = await queryLoki(lokiDs.uid, emailQuery, from, to, 500);
    }
  } else if (esDs) {
    logger.info(`[grafana] querying Elasticsearch (${esDs.name})`);
    const mustClauses = [
      { multi_match: { query: searchTerms.join(' '), fields: ['message', 'log', 'msg'] } },
    ];
    allLines = await queryElasticsearch(esDs.uid, mustClauses, from, to, 500);
  }

  logger.info(`[grafana] fetched ${allLines.length} log line(s) for execution`);

  if (allLines.length === 0) {
    return { available: true, reason: 'Query returned no log lines', lines: [], evidence: {} };
  }

  // ── categorize lines ──────────────────────────────────────────────────────
  const evidence = categorizeLogLines(allLines, mismatches, context);

  return {
    available: true,
    totalLines: allLines.length,
    lines: allLines.slice(0, 200), // trim for prompt size
    evidence,
  };
}

/**
 * Categorize log lines into buckets relevant to specific mismatch types.
 */
function categorizeLogLines(lines, mismatches, context) {
  const evidence = {
    errors: [],
    warnings: [],
    archiveRelated: [],
    missingMessageHints: [],
    folderMappingIssues: [],
    throttlingOrRateLimit: [],
    authErrors: [],
  };

  const archivePattern = /archive/i;
  const errorPattern   = /error|exception|failed|failure|cannot|unable|invalid/i;
  const warnPattern    = /warn|skip|ignore|fallback/i;
  const throttlePattern = /throttl|rate.?limit|429|too.many|backoff/i;
  const authPattern    = /401|403|unauthorized|forbidden|token.*expir/i;

  for (const { ts, line } of lines) {
    const entry = { ts, line };
    if (errorPattern.test(line))   evidence.errors.push(entry);
    if (warnPattern.test(line))    evidence.warnings.push(entry);
    if (archivePattern.test(line)) evidence.archiveRelated.push(entry);
    if (throttlePattern.test(line)) evidence.throttlingOrRateLimit.push(entry);
    if (authPattern.test(line))    evidence.authErrors.push(entry);
  }

  // Subject-targeted search for not-found messages
  const notFoundSubjects = mismatches
    .filter((m) => m.category === 'deepMail' && String(m.actual || '').includes('No Gmail message'))
    .map((m) => m.messageSubject)
    .filter(Boolean);

  for (const subj of notFoundSubjects) {
    const words = subj.split(/\s+/).filter((w) => w.length > 4).slice(0, 3);
    const pattern = new RegExp(words.map(escapeRegex).join('|'), 'i');
    const hits = lines.filter(({ line }) => pattern.test(line));
    if (hits.length > 0) {
      evidence.missingMessageHints.push({ subject: subj, logLines: hits.slice(0, 5) });
    }
  }

  // Folder mapping log lines
  const folderNames = [...new Set(
    mismatches
      .filter((m) => m.category === 'comparison')
      .map((m) => m.field?.split('→')[0]?.trim())
      .filter(Boolean)
  )];
  for (const folder of folderNames) {
    const pattern = new RegExp(escapeRegex(folder), 'i');
    const hits = lines.filter(({ line }) => pattern.test(line));
    if (hits.length > 0) {
      evidence.folderMappingIssues.push({ folder, logLines: hits.slice(0, 5) });
    }
  }

  // Deduplicate and trim
  for (const key of Object.keys(evidence)) {
    if (Array.isArray(evidence[key])) {
      if (key !== 'missingMessageHints' && key !== 'folderMappingIssues') {
        evidence[key] = dedup(evidence[key]).slice(0, 20);
      }
    }
  }

  return evidence;
}

function dedup(entries) {
  const seen = new Set();
  return entries.filter(({ line }) => {
    const key = line.trim().substring(0, 120);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { searchMigrationLogs, discoverDataSources };
