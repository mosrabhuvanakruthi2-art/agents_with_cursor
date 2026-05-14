const https = require('https');
const axios = require('axios');
const env = require('../config/env');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

// JWT from POST /mail/register — scoped only for /mail/reports polling
let bearerToken = null;
// JWT from MIGRATION_API_BEARER_TOKEN or POST /mail/login — for all UI-flow endpoints
let loginToken = null;
// Last observed job details from /email/user/jobs polling — cleared on each new run
let lastJobDetails = { workspaceId: null, totalCount: null, processedCount: null };

// ── Runtime config: set by MigrationAgent when context provides a server URL ──
// { baseUrl: string, email: string, password: string }
// When set, all API calls use this server instead of env.MIGRATION_API_URL.
let runtimeConfig = null;

function setRuntimeConfig(cfg) {
  runtimeConfig = cfg ? { ...cfg } : null;
  // Clear cached tokens whenever we switch servers
  bearerToken = null;
  loginToken = null;
  if (cfg?.baseUrl) {
    logger.info(`CloudFuze: runtime server override set to ${cfg.baseUrl}`);
  }
}

function clearRuntimeConfig() {
  runtimeConfig = null;
  bearerToken = null;
  loginToken = null;
  lastJobDetails = { workspaceId: null, totalCount: null, processedCount: null };
}

function getLastJobDetails() {
  return { ...lastJobDetails };
}

/** Returns the active API base URL (runtime override takes priority over env) */
function getActiveBaseUrl() {
  return runtimeConfig?.baseUrl || env.MIGRATION_API_URL;
}

/** Returns the email-endpoint base URL (strips /proxyservices/v1 for legacy servers) */
function getActiveEmailBaseUrl() {
  if (runtimeConfig?.baseUrl) return runtimeConfig.baseUrl;
  try {
    return new URL(env.MIGRATION_API_URL).origin;
  } catch {
    return env.MIGRATION_API_URL.replace(/\/proxyservices\/v1.*$/i, '');
  }
}

/** True when a runtime server override is active (newtestemail5 style API paths) */
function isNewServer() {
  return Boolean(runtimeConfig?.baseUrl);
}

const migrationHttpsAgent = env.MIGRATION_API_TLS_INSECURE
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

if (migrationHttpsAgent) {
  logger.warn(
    'MIGRATION_API_TLS_INSECURE=true: TLS certificate verification is disabled for Migration API (lab / self-signed only).'
  );
}

function migrationAxiosConfig(overrides = {}) {
  const cfg = { ...overrides };
  if (migrationHttpsAgent) cfg.httpsAgent = migrationHttpsAgent;
  return cfg;
}

function basicAuthPayload() {
  let raw = (env.MIGRATION_API_BASIC_AUTH || env.MIGRATION_API_KEY || '').trim();
  if (!raw) return '';
  if (/^basic\s+/i.test(raw)) raw = raw.replace(/^basic\s+/i, '').trim();
  return raw;
}

function normalizeBearerFromEnv(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, '').trim();
  return s;
}

/** Returns true if the JWT is expired (with 60s buffer). Non-JWT tokens are assumed valid. */
function isJwtExpired(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (!payload.exp) return false;
    return payload.exp < Math.floor(Date.now() / 1000) + 60;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 0 — Register: POST /mail/register → fresh Bearer JWT
// Skipped for new server (uses /app/login instead).
// ─────────────────────────────────────────────────────────────
async function register() {
  // New server uses email+password login — no /mail/register endpoint
  if (isNewServer()) {
    logger.info('CloudFuze: new server detected — skipping /mail/register, will use /app/login');
    return await login();
  }

  const basic = basicAuthPayload();
  if (!basic) throw new Error('CloudFuze: MIGRATION_API_KEY or MIGRATION_API_BASIC_AUTH required for /mail/register');

  const res = await retryWithBackoff(
    () =>
      axios.post(
        `${env.MIGRATION_API_URL}/mail/register`,
        null,
        migrationAxiosConfig({
          headers: { Authorization: `Basic ${basic}` },
          timeout: 30000,
        })
      ),
    { label: 'CloudFuze register', maxRetries: 3 }
  );

  const raw = res.data;
  const token = typeof raw === 'string'
    ? raw.replace(/^Bearer\s*/i, '').trim()
    : raw?.token || raw?.accessToken || raw?.jwtToken || String(raw || '');

  bearerToken = token;
  logger.info('CloudFuze: fresh JWT obtained via POST /mail/register');
  return token;
}

// ─────────────────────────────────────────────────────────────
// Login:
//   New server → POST /app/login { email, password }
//   Legacy     → MIGRATION_API_BEARER_TOKEN or POST /mail/login (Basic)
// ─────────────────────────────────────────────────────────────
async function login() {
  if (loginToken && !isJwtExpired(loginToken)) return loginToken;

  // New server: email + MD5-hashed password + ent via POST /email/app/login
  if (isNewServer() && runtimeConfig.email && runtimeConfig.password) {
    const crypto = require('crypto');
    const hashedPassword = crypto.createHash('md5').update(runtimeConfig.password).digest('hex');
    const ent = (() => { try { return new URL(runtimeConfig.baseUrl).host; } catch { return runtimeConfig.baseUrl; } })();
    const res = await retryWithBackoff(
      () =>
        axios.post(
          `${runtimeConfig.baseUrl}/email/app/login`,
          { email: runtimeConfig.email, password: hashedPassword, ent },
          migrationAxiosConfig({ timeout: 30000 })
        ),
      { label: 'CloudFuze email/app/login', maxRetries: 3 }
    );
    const raw = res.data;
    logger.info(`CloudFuze /email/app/login raw response: ${JSON.stringify(raw)}`);
    logger.info(`CloudFuze /email/app/login response headers: ${JSON.stringify(res.headers)}`);
    const headerToken = (
      res.headers?.['authorization'] ||
      res.headers?.['x-auth-token'] ||
      res.headers?.['x-access-token'] ||
      res.headers?.['token'] ||
      ''
    ).replace(/^Bearer\s*/i, '').trim();
    const token = raw?.token || raw?.accessToken || raw?.jwtToken || raw?.data?.token ||
      raw?.data?.accessToken || raw?.result?.token || headerToken ||
      (typeof raw === 'string' ? raw.replace(/^Bearer\s*/i, '').trim() : '');
    if (!token) throw new Error(`CloudFuze /email/app/login: no token in response — body: ${JSON.stringify(raw)}`);
    loginToken = token;
    logger.info(`CloudFuze: logged in via POST /email/app/login (${runtimeConfig.baseUrl})`);
    return loginToken;
  }

  // Legacy: static Bearer env token
  const staticBearer = normalizeBearerFromEnv(env.MIGRATION_API_BEARER_TOKEN);
  if (staticBearer) {
    if (isJwtExpired(staticBearer)) {
      logger.warn('CloudFuze: MIGRATION_API_BEARER_TOKEN is expired — falling back to /mail/login');
    } else {
      loginToken = staticBearer;
      logger.info('CloudFuze: using MIGRATION_API_BEARER_TOKEN (skipping /mail/login)');
      return loginToken;
    }
  }

  const basic = basicAuthPayload();
  if (!basic) {
    throw new Error(
      'CloudFuze auth missing: set MIGRATION_API_BEARER_TOKEN, or MIGRATION_API_BASIC_AUTH / MIGRATION_API_KEY'
    );
  }

  const res = await retryWithBackoff(
    () =>
      axios.post(
        `${env.MIGRATION_API_URL}/mail/login`,
        null,
        migrationAxiosConfig({
          headers: { Authorization: `Basic ${basic}` },
          timeout: 30000,
        })
      ),
    { label: 'CloudFuze login', maxRetries: 3 }
  );

  const tokenData = res.data;
  loginToken = typeof tokenData === 'string'
    ? tokenData.replace(/^Bearer\s*/i, '').trim()
    : tokenData;

  logger.info('CloudFuze login successful');
  return loginToken;
}

function getAuthClient(token) {
  return axios.create(
    migrationAxiosConfig({
      baseURL: getActiveBaseUrl(),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      timeout: 60000,
    })
  );
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — Get connected cloud accounts
//   New server → GET /email/user/clouds  (Bearer)
//   Legacy     → GET /mail/clouds        (Bearer or Basic)
// ─────────────────────────────────────────────────────────────
async function getClouds() {
  const token = await login();
  const base = getActiveBaseUrl();
  const emailBase = getActiveEmailBaseUrl();

  // New server exposes clouds at /email/user/clouds
  const cloudsUrl = isNewServer()
    ? `${emailBase}/email/user/clouds`
    : `${base}/mail/clouds`;

  // Build ordered list of tokens to try
  const candidates = [
    loginToken && { label: 'login JWT', value: loginToken },
    bearerToken && { label: 'register JWT', value: bearerToken },
  ].filter(Boolean);

  if (!isNewServer()) {
    const staticBearer = normalizeBearerFromEnv(env.MIGRATION_API_BEARER_TOKEN);
    if (staticBearer && !isJwtExpired(staticBearer)) {
      candidates.push({ label: 'static Bearer', value: staticBearer });
    }
  }

  let lastErr;

  for (const cand of candidates) {
    try {
      const res = await axios.get(
        cloudsUrl,
        migrationAxiosConfig({
          headers: { Authorization: `Bearer ${cand.value}` },
          params: { _: Date.now() },
          timeout: 30000,
        })
      );
      const clouds = Array.isArray(res.data) ? res.data : [];
      if (clouds.length > 0) {
        logger.info(`CloudFuze getClouds: ${clouds.length} cloud(s) via ${cand.label}`);
        return clouds;
      }
      logger.warn(`CloudFuze getClouds: 0 clouds with ${cand.label} — trying next token`);
    } catch (err) {
      lastErr = err;
      logger.warn(`CloudFuze getClouds with ${cand.label} failed (${err.response?.status || err.message}) — trying next`);
    }
  }

  // Legacy fallback: Basic auth on /mail/clouds
  if (!isNewServer()) {
    const basic = basicAuthPayload();
    if (basic) {
      try {
        const res = await axios.get(
          cloudsUrl,
          migrationAxiosConfig({
            headers: { Authorization: `Basic ${basic}` },
            params: { _: Date.now() },
            timeout: 30000,
          })
        );
        const clouds = Array.isArray(res.data) ? res.data : [];
        logger.info(`CloudFuze getClouds: ${clouds.length} cloud(s) via Basic auth`);
        return clouds;
      } catch (err) {
        lastErr = err;
        logger.warn(`CloudFuze getClouds Basic auth failed (${err.response?.status || err.message})`);
      }
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('CloudFuze: no valid token available for getClouds');
}

/**
 * Find the cloud ID for a given email from the clouds list.
 * Handles both old-server (id field) and new-server (vendorId field).
 * Priority: 1. Exact match on adminEmailId/email  2. Domain match
 */
function findCloudId(clouds, email) {
  const norm = String(email || '').toLowerCase().trim();

  const extractId = (c) => c.id || c.vendorId || c.cloudId;

  // 1. Exact match
  const exact = clouds.find(
    (c) =>
      String(c.adminEmailId || '').toLowerCase() === norm ||
      String(c.email || '').toLowerCase() === norm
  );
  if (exact) return { id: extractId(exact), cloudName: exact.cloudName, memberId: exact.memberId };

  // 2. Domain match
  const domain = norm.includes('@') ? norm.split('@')[1] : null;
  if (domain) {
    const domainHit = clouds.find((c) => {
      const adminEmail = String(c.adminEmailId || c.email || '').toLowerCase();
      return adminEmail.endsWith('@' + domain);
    });
    if (domainHit) return { id: extractId(domainHit), cloudName: domainHit.cloudName, memberId: domainHit.memberId };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// STEP 1→2 — GET /email/move/domains/{destCloudId}
// ─────────────────────────────────────────────────────────────
async function getDomains(destCloudId) {
  const token = await login();
  const emailBase = getActiveEmailBaseUrl();
  const res = await retryWithBackoff(
    () =>
      axios.get(
        `${emailBase}/email/move/domains/${destCloudId}`,
        migrationAxiosConfig({
          headers: { Authorization: `Bearer ${token}` },
          params: { _: Date.now() },
          timeout: 30000,
        })
      ),
    { label: 'CloudFuze getDomains', maxRetries: 2 }
  );
  return res.data;
}

// ─────────────────────────────────────────────────────────────
// STEP 1→3 — GET /email/user/cache/{sourceCloudId}/{destCloudId}
// Fetches the full permission mapping (Step 3 in CloudFuze UI).
// Used by deep mail validation to check From/To/CC/BCC rewriting.
// Returns [{sourceEmail, destinationEmail}] or [] on failure.
// ─────────────────────────────────────────────────────────────
async function getPermissionMapping(sourceCloudId, destCloudId, { pageSize = 500 } = {}) {
  const token = await login();
  const emailBase = getActiveEmailBaseUrl();
  try {
    const res = await axios.get(
      `${emailBase}/email/user/cache/${sourceCloudId}/${destCloudId}`,
      migrationAxiosConfig({
        headers: { Authorization: `Bearer ${token}` },
        params: { pageNo: 0, pageSize, _: Date.now() },
        timeout: 30000,
      })
    );
    const raw = Array.isArray(res.data) ? res.data : (res.data?.content || res.data?.data || []);
    return raw
      .map((item) => ({
        sourceEmail: String(item.sourceEmail || item.fromMailId || item.fromEmail || item.source || '').trim().toLowerCase(),
        destinationEmail: String(item.destinationEmail || item.toMailId || item.toEmail || item.destination || '').trim().toLowerCase(),
      }))
      .filter((p) => p.sourceEmail && p.destinationEmail);
  } catch (err) {
    logger.warn(`CloudFuze getPermissionMapping failed (${err.response?.status || err.message}) — skipping`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 2a — POST /email/user/csv/{sourceCloudId}/{destCloudId}
// Upload user mapping CSV (built from mappedPairs)
// ─────────────────────────────────────────────────────────────
async function uploadUserCSV(sourceCloudId, destCloudId, pairs) {
  const token = await login();
  const emailBase = getActiveEmailBaseUrl();

  const csvLines = ['Source Email Address,Destination Email Address'];
  for (const p of pairs) csvLines.push(`${p.sourceEmail},${p.destinationEmail}`);
  const csvContent = csvLines.join('\r\n');

  logger.info(`CloudFuze uploadUserCSV body:\n${csvContent}`);

  const res = await retryWithBackoff(
    () =>
      axios.post(
        `${emailBase}/email/user/csv/${sourceCloudId}/${destCloudId}`,
        csvContent,
        migrationAxiosConfig({
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'text/csv',
          },
          timeout: 30000,
        })
      ),
    { label: 'CloudFuze uploadUserCSV', maxRetries: 2 }
  );
  return res.data;
}

// ─────────────────────────────────────────────────────────────
// STEP 2b — Cache/confirm user mapping
//   New server → GET /email/user/cache/{srcId}/{dstId}
//   Legacy     → GET /mail/cache/{srcId}/{dstId}
// ─────────────────────────────────────────────────────────────
async function cacheUserMapping(sourceCloudId, destCloudId) {
  const token = await login();
  const base = getActiveBaseUrl();
  const emailBase = getActiveEmailBaseUrl();

  const cacheUrl = isNewServer()
    ? `${emailBase}/email/user/cache/${sourceCloudId}/${destCloudId}`
    : `${base}/mail/cache/${sourceCloudId}/${destCloudId}`;

  const res = await retryWithBackoff(
    () =>
      axios.get(
        cacheUrl,
        migrationAxiosConfig({
          headers: { Authorization: `Bearer ${token}` },
          params: { pageNo: 0, pageSize: 20, _: Date.now() },
          timeout: 30000,
        })
      ),
    { label: 'CloudFuze cacheUserMapping', maxRetries: 2 }
  );
  return res.data;
}

// ─────────────────────────────────────────────────────────────
// STEP 5 — Initiate migration
//   New server → POST /email/move/initiate  (fromCloud/toCloud fields)
//   Legacy     → POST /mail/move/initiate   (fromCloudName/toCloudName fields)
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// Pre-scan: POST /email/mail/move/initiate/preScan
// Triggers server-side folder indexing for the source mailbox.
// This populates EmailFolderInfo records which are required by /email/move/initiate.
// Fire-and-forget — caller waits a few seconds after calling this.
// ─────────────────────────────────────────────────────────────
async function triggerPreScan(fromMailId, fromCloud) {
  if (!isNewServer()) return null;
  const token = await login();
  const emailBase = getActiveEmailBaseUrl();
  const res = await axios.post(
    `${emailBase}/email/mail/move/initiate/preScan`,
    [{ fromMailId, fromCloud: fromCloud || 'GMAIL' }],
    migrationAxiosConfig({
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    })
  );
  return res.data;
}

function initiatePathCandidates() {
  if (isNewServer()) return ['email/move/initiate'];
  const custom = (env.MIGRATION_API_INITIATE_PATH || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const defaults = ['mail/move/initiate', 'mail/initiate', 'initiate'];
  const out = [];
  if (custom) out.push(custom);
  for (const d of defaults) {
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

async function triggerMigration(context) {
  const token = await login();
  const client = getAuthClient(token);

  let payload;
  if (isNewServer()) {
    // New server payload (newtestemail5 API)
    // fromFolderId / toFolderId must always be "/" — omitting them causes
    // EmailFolderInfo.getSourceId() to return null and the server throws HTTP 500.
    const newItem = {
      fromCloud: context.sourceCloudName || 'GMAIL',
      toCloud: context.destCloudName || 'OUTLOOK',
      fromMailId: context.sourceEmail,
      toMailId: context.destinationEmail,
      ownerEmailId: runtimeConfig.email || env.CLOUDFUZE_OWNER_EMAIL || context.sourceEmail,
      deltaMigration: context.migrationType === 'DELTA',
      calendar: Boolean(context.includeCalendar),
      contacts: Boolean(context.includeContacts),
      archive: context.sourceProvider === 'microsoft',
      gmailNoUserLabel: false,
      mailRules: false,
      folder: true,
      excludeGroups: false,
      changeHours: 0,
      pickEmailsFromDate: null,
      pickEmailsBeforeDate: null,
      metadata: true,
      fromFolderId: context.fromFolderId || '/',
      toFolderId: context.toFolderId || '/',
    };
    payload = [newItem];
  } else {
    // Legacy devemail payload
    payload = [
      {
        fromCloudName: context.sourceCloudName || 'GMAIL',
        toCloudName: context.destCloudName || 'OUTLOOK',
        fromMailId: context.sourceEmail,
        toMailId: context.destinationEmail,
        ownerEmailId: env.CLOUDFUZE_OWNER_EMAIL || context.sourceEmail,
        fromRootId: '/',
        toRootId: '/',
        deltaMigration: context.migrationType === 'DELTA',
        onlineMove: false,
        contacts: Boolean(context.includeContacts),
        drawings: false,
        backup: false,
        orphanWorkSpace: false,
        teamFolder: false,
        cronExpression: '1H0M',
        disableGroups: false,
        processedCount: null,
        inProgressCount: null,
      },
    ];
  }

  const paths = initiatePathCandidates();
  const base = getActiveBaseUrl();
  let lastErr;

  logger.info(`CloudFuze triggerMigration payload: ${JSON.stringify(payload)}`);

  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    try {
      const res = await retryWithBackoff(
        () => client.post(path, payload),
        { label: `CloudFuze POST ${path}`, maxRetries: 1 }
      );

      logger.info(`Migration initiated via ${base}/${path}`, {
        executionId: context.executionId,
        response: JSON.stringify(res.data),
      });

      return {
        jobId: res.data?.id || res.data?.[0]?.id || res.data?.jobId || 'initiated',
        status: 'INITIATED',
        rawResponse: res.data,
        initiatePath: path,
      };
    } catch (err) {
      lastErr = err;
      const st = err.response?.status;
      const allow = err.response?.headers?.allow || err.response?.headers?.Allow;
      const errBody = err.response?.data ? JSON.stringify(err.response.data) : '(no body)';
      logger.error(`CloudFuze POST ${path} HTTP ${st} error body: ${errBody}`);
      if ((st === 405 || st === 404) && i < paths.length - 1) {
        logger.warn(`POST ${base}/${path} → HTTP ${st}${allow ? `; Allow: ${allow}` : ''} — trying next path…`);
        continue;
      }
      if (st === 405) {
        throw new Error(
          `${err.message || 'HTTP 405'}${allow ? ` (Allow: ${allow})` : ''}. Set MIGRATION_API_INITIATE_PATH from DevTools.`
        );
      }
      throw err;
    }
  }

  throw lastErr || new Error('Migration initiate failed: no path candidates');
}

// ─────────────────────────────────────────────────────────────
// STEP 6 — Poll for migration completion
//   New server → GET /email/user/jobs?deltaMigration=&pageNo=0&pageSize=50
//   Legacy     → GET /mail/reports
// Terminal statuses: PROCESSED | PROCESSED_WITH_CONFLICTS | CONFLICT | PAUSE
// New server may return "PROCESS" (without D) — include both forms.
const TERMINAL_STATUSES = new Set([
  'PROCESSED',
  'PROCESS',
  'PROCESSED_WITH_CONFLICTS',
  'PROCESS_WITH_CONFLICTS',
  'PROCESSED_WITH_CONFLICT_AND_PAUSE',
  'CONFLICT',
  'PAUSE',
  'FAILED',
  'ERROR',
]);

async function pollReports(deltaMigration, fromMailId, {
  maxMinutes = 30,
  intervalMs = 60000,
  onProgress,
  executionId,
} = {}) {
  const tokenCandidates = [
    loginToken,
    bearerToken,
    !isNewServer() ? normalizeBearerFromEnv(env.MIGRATION_API_BEARER_TOKEN) : null,
  ].filter(Boolean);

  if (tokenCandidates.length === 0) {
    logger.warn('CloudFuze: no Bearer JWT for reports polling — falling back to Outlook polling');
    return null;
  }

  let token = tokenCandidates.find((t) => !isJwtExpired(t)) || null;
  if (!token) {
    logger.warn('CloudFuze: all report tokens expired — falling back to Outlook polling');
    return null;
  }

  const reportsUrl = isNewServer()
    ? `${getActiveEmailBaseUrl()}/email/user/jobs`
    : `${env.MIGRATION_API_URL}/mail/reports`;

  const maxPolls = Math.ceil((maxMinutes * 60 * 1000) / intervalMs);
  const executionService = require('../services/executionService');
  const MAX_NO_MATCH = 5;
  let noMatchStreak = 0;

  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    const sliceMs = 5000;
    const slices = Math.ceil(intervalMs / sliceMs);
    for (let s = 0; s < slices; s++) {
      await new Promise((r) => setTimeout(r, sliceMs));
      if (executionId && executionService.isCancelled(executionId)) return 'CANCELLED';
    }
    if (executionId && executionService.isCancelled(executionId)) return 'CANCELLED';

    try {
      const res = await axios.get(
        reportsUrl,
        migrationAxiosConfig({
          headers: { Authorization: `Bearer ${token}` },
          params: { pageNo: 0, pageSize: 50, deltaMigration, _: Date.now() },
          timeout: 30000,
        })
      );

      const jobs = Array.isArray(res.data) ? res.data : (res.data?.content || []);
      const normFrom = String(fromMailId || '').toLowerCase().trim();

      let matchedDetail = null;
      let matchedJob = null;
      for (const j of jobs) {
        if (String(j.fromMailId || j.fromEmail || '').toLowerCase() === normFrom) {
          matchedJob = j;
          break;
        }
        const details = j.mailMigrationDetails || j.details || j.pairs || [];
        if (Array.isArray(details)) {
          const d = details.find(
            (d) => String(d.fromMailId || d.fromEmail || '').toLowerCase() === normFrom
          );
          if (d) { matchedJob = j; matchedDetail = d; break; }
        }
      }

      if (!matchedJob) {
        noMatchStreak++;
        if (attempt === 1 && jobs.length > 0) {
          const sample = jobs[0];
          logger.info(`CloudFuze reports sample job keys: ${Object.keys(sample).join(', ')}`);
          const sampleDetails = sample.mailMigrationDetails || sample.details || sample.pairs || [];
          if (sampleDetails.length > 0) {
            logger.info(`CloudFuze reports sample detail keys: ${Object.keys(sampleDetails[0]).join(', ')}`);
          }
        }
        logger.info(
          `CloudFuze reports poll ${attempt}/${maxPolls}: job for ${fromMailId} not found ` +
          `(${jobs.length} job(s) returned, no-match streak ${noMatchStreak}/${MAX_NO_MATCH})`
        );
        if (noMatchStreak >= MAX_NO_MATCH) {
          logger.warn(
            `CloudFuze reports: ${noMatchStreak} consecutive polls without finding ${fromMailId} — ` +
            `falling back to Outlook polling`
          );
          return 'TIMEOUT';
        }
        if (onProgress) onProgress(attempt, maxPolls, null);
        continue;
      }
      noMatchStreak = 0;

      const status = String(
        matchedDetail?.syncStatus   || matchedDetail?.status         ||
        matchedDetail?.processStatus || matchedDetail?.migrationStatus ||
        matchedJob.syncStatus       || matchedJob.status              ||
        matchedJob.processStatus    || matchedJob.migrationStatus      || ''
      ).toUpperCase().trim();

      // Count-based completion detection: totalCount === processedCount and > 0
      const totalCount     = Number(matchedDetail?.totalCount     || matchedJob.totalCount     || 0);
      const processedCount = Number(matchedDetail?.processedCount || matchedJob.processedCount || 0);
      const countsDone     = totalCount > 0 && processedCount >= totalCount;

      // Track latest job details so MigrationAgent can surface them in the report
      lastJobDetails = {
        workspaceId: matchedJob.workspaceId || matchedJob.id || matchedJob.jobId || matchedDetail?.workspaceId || null,
        totalCount: totalCount || null,
        processedCount: processedCount || null,
      };

      if (!status && attempt === 1) {
        // Log field names once on first match so we can identify the correct key
        logger.info(`CloudFuze reports job keys: ${Object.keys(matchedJob).join(', ')}`);
        if (matchedDetail) logger.info(`CloudFuze reports detail keys: ${Object.keys(matchedDetail).join(', ')}`);
      }

      logger.info(
        `CloudFuze reports poll ${attempt}/${maxPolls}: ${fromMailId} → ` +
        `status="${status}" counts=${processedCount}/${totalCount}`
      );
      if (onProgress) onProgress(attempt, maxPolls, status || (countsDone ? 'PROCESSED' : null));

      if (TERMINAL_STATUSES.has(status)) {
        return status;
      }

      if (countsDone) {
        logger.info(`CloudFuze reports: processedCount (${processedCount}) === totalCount (${totalCount}) — treating as PROCESSED`);
        return 'PROCESSED';
      }
    } catch (err) {
      logger.warn(`CloudFuze reports poll ${attempt} error: ${err.message}`);
    }
  }

  logger.warn(`CloudFuze reports: max wait (${maxMinutes} min) reached for ${fromMailId}`);
  return 'TIMEOUT';
}

async function validateUser(email) {
  if (!email || typeof email !== 'string') throw new Error('validateUser: email is required');
  // New server doesn't have /users/validateUser — skip gracefully
  if (isNewServer()) {
    logger.info('CloudFuze: new server detected — skipping validateUser');
    return null;
  }
  const token = await login();
  const client = getAuthClient(token);
  const res = await retryWithBackoff(
    () => client.get('users/validateUser', { params: { searchUser: email.trim(), _: Date.now() } }),
    { label: 'CloudFuze validateUser', maxRetries: 2 }
  );
  return res.data;
}

function clearToken() {
  bearerToken = null;
  loginToken = null;
}

module.exports = {
  login,
  register,
  getClouds,
  findCloudId,
  getDomains,
  getPermissionMapping,
  uploadUserCSV,
  cacheUserMapping,
  triggerPreScan,
  triggerMigration,
  pollReports,
  validateUser,
  clearToken,
  setRuntimeConfig,
  clearRuntimeConfig,
  getLastJobDetails,
  migrationAxiosConfig,
};
