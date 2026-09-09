const fs = require('fs');
const https = require('https');
const axios = require('axios');
const md5 = require('md5');
const env = require('../config/env');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');
const channelCache = require('../services/channelCache');
// Lazy-loaded to avoid circular deps — resolved on first use inside pollAndCloseTeams
let _executionService = null;
function getExecService() {
  if (!_executionService) _executionService = require('../services/executionService');
  return _executionService;
}
let _outlookClient = null;
function getOutlookClient() {
  if (!_outlookClient) _outlookClient = require('./outlookClient');
  return _outlookClient;
}

// Per-server session cache: key (serverUrl + credential) → { auth, userId, baseURL }.
// CloudFuze credentials come from the FRONTEND (wizard "Migration Server" step) per
// migration — NO dedicated/hardcoded account. Any CloudFuze server works. The env vars
// are only an optional dev fallback used when the request supplies no credentials.
const sessionCache = new Map();

/**
 * Normalise whatever CloudFuze URL the user pastes into the API base.
 * CloudFuze's REST base is always `<origin>/proxyservices/v1`, but users often paste
 * the browser/UI URL (e.g. https://s2cdev.cloudfuze.com/pages or .../pages/reports.html)
 * or just the host. Coerce any of those to the correct API base so login doesn't 404.
 */
function normalizeCfApiUrl(raw) {
  let u = (raw || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  // Respect an explicit proxyservices/vN base if the user already provided one.
  const explicit = u.match(/^(https?:\/\/[^/]+\/proxyservices\/v\d+)/i);
  if (explicit) return explicit[1];
  const origin = (u.match(/^(https?:\/\/[^/]+)/i) || [])[1] || u;
  return `${origin}/proxyservices/v1`;
}

/**
 * Resolve the CloudFuze server URL + credentials for this migration.
 * Priority: frontend-supplied creds (context.migrationServer*) → optional env fallback.
 */
function cfConfigFromContext(context = {}) {
  const feUrl      = (context.migrationServerUrl || '').trim();
  const feUser     = (context.migrationServerEmail || '').trim();
  const fePass     = (context.migrationServerPassword || '').trim();
  const feBasic    = (context.migrationServerBasicAuth || context.migrationServerToken || '').trim();
  const url = normalizeCfApiUrl(feUrl || env.CHAT_MIGRATION_API_URL || env.MIGRATION_API_URL || '');

  // Frontend creds win entirely when provided — never mix with env.
  if (feBasic)            return { url, basicAuth: feBasic, bearer: '', username: '', password: '', source: 'frontend' };
  if (feUser && fePass)   return { url, basicAuth: '', bearer: '', username: feUser, password: fePass, source: 'frontend' };

  // Optional env fallback (dev only). Remove these env vars to force frontend creds.
  return {
    url,
    basicAuth: (env.CHAT_MIGRATION_API_BASIC_AUTH || env.CHAT_MIGRATION_API_KEY || env.MIGRATION_API_BASIC_AUTH || env.MIGRATION_API_KEY || '').trim(),
    bearer:    (env.CHAT_MIGRATION_API_BEARER_TOKEN || env.MIGRATION_API_BEARER_TOKEN || '').trim(),
    username:  (env.CHAT_MIGRATION_API_USERNAME || env.MIGRATION_API_USERNAME || '').trim(),
    password:  (env.CHAT_MIGRATION_API_PASSWORD || env.MIGRATION_API_PASSWORD || '').trim(),
    source: 'env',
  };
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

function normalizeBearer(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, '').trim();
  return s;
}

function normalizeBasic(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^basic\s+/i.test(s)) s = s.replace(/^basic\s+/i, '').trim();
  return s;
}

/**
 * Authenticate with CloudFuze.
 *
 * Priority:
 *   1. MIGRATION_API_BASIC_AUTH — already the post-login "Basic base64(userId:apiSecret)" captured
 *      from DevTools; use it directly and extract userId from the decoded payload.
 *   2. MIGRATION_API_BEARER_TOKEN — legacy Bearer token from DevTools; use as-is.
 *   3. MIGRATION_API_USERNAME + MIGRATION_API_PASSWORD — do two-step login:
 *      POST /auth/user with Basic base64(username:password) → get userId
 *      then use Basic base64(userId:password) for subsequent calls.
 *
 * Returns { auth: string, userId: string|null }
 */
/**
 * Resolve (and cache) a CloudFuze session for the given migration context.
 * Credentials come from the frontend (wizard) per context; falls back to env only
 * if none supplied. Returns { auth, userId, baseURL }.
 */
async function getSession(context = {}) {
  const cfg = cfConfigFromContext(context);
  if (!cfg.url) {
    throw new Error('CloudFuze migration server URL is missing — enter it in the wizard (Migration Server step).');
  }
  const key = `${cfg.url}::${cfg.basicAuth || cfg.bearer || cfg.username || 'anon'}`;
  if (sessionCache.has(key)) return sessionCache.get(key);

  let session;
  const basic = normalizeBasic(cfg.basicAuth);
  const bearer = normalizeBearer(cfg.bearer);

  if (basic) {
    let userId = null;
    try { userId = Buffer.from(basic, 'base64').toString().split(':')[0] || null; } catch { /* ignore */ }
    session = { auth: `Basic ${basic}`, userId, baseURL: cfg.url };
    logger.info(`CloudFuze: using Basic auth for ${cfg.url} (${cfg.source})`);
  } else if (bearer) {
    session = { auth: `Bearer ${bearer}`, userId: null, baseURL: cfg.url };
    logger.info(`CloudFuze: using Bearer token for ${cfg.url} (${cfg.source})`);
  } else if (cfg.username && cfg.password) {
    logger.info(`CloudFuze: logging in as ${cfg.username} @ ${cfg.url} (${cfg.source})…`);
    const md5Pass = md5(cfg.password);

    // Strategy 1: GET /users/validateUser → userId → Basic base64(userId:md5(password))
    let userId = null;
    try {
      const valRes = await axios.get(`${cfg.url}/users/validateUser`, migrationAxiosConfig({
        params: { searchUser: cfg.username.trim(), _: Date.now() },
        timeout: 20000,
      }));
      const d = valRes.data;
      userId = (typeof d === 'string' && d.length > 5) ? d.trim() : (d?.id || d?.userId || null);
      if (userId) logger.info(`CloudFuze: validateUser → userId=${userId}`);
    } catch (e) {
      logger.warn(`CloudFuze: validateUser failed (${e.response?.status || e.message}) — trying auth endpoints`);
    }

    // Strategy 2: POST to multiple CF auth path candidates
    // Try both md5-hashed password (CF default) and plain password (some CF versions).
    if (!userId) {
      const md5B64       = Buffer.from(`${cfg.username}:${md5Pass}`).toString('base64');
      const plainB64     = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
      const authCandidates = [
        { path: 'auth/user',          token: md5B64  },
        { path: 'auth/login',         token: md5B64  },
        { path: 'auth/user',          token: plainB64 },
        { path: 'auth/login',         token: plainB64 },
        { path: 'users/login',        token: md5B64  },
        { path: 'users/authenticate', token: md5B64  },
      ];
      let lastErr = null;
      for (const { path, token } of authCandidates) {
        try {
          const res = await axios.post(`${cfg.url}/${path}`, null, migrationAxiosConfig({
            headers: { 'Content-Type': 'application/json', Authorization: `Basic ${token}` },
            timeout: 20000,
          }));
          userId = res.data?.id || res.data?.userId || res.data?.user?.id || null;
          if (userId) { logger.info(`CloudFuze: /${path} → userId=${userId}`); break; }
        } catch (err) {
          const st = err.response?.status;
          if (st === 404 || st === 405 || st === 400) {
            logger.warn(`CloudFuze: /${path} → HTTP ${st} — trying next`);
            lastErr = err;
            continue;
          }
          // Non-404 error (e.g. 401 wrong password, 500 server error) — fail immediately
          throw new Error(
            `CloudFuze login failed for ${cfg.username} (${st || err.message}). ` +
            `Check the email and password entered in the Migration Server step.`
          );
        }
      }
      if (!userId && lastErr) {
        throw new Error(
          `CloudFuze login failed for ${cfg.username} — all auth endpoints returned 404/405. ` +
          `Verify the Migration Server URL is correct (currently: ${cfg.url}). ` +
          `The CF API base should be https://<your-cf-server>/proxyservices/v1.`
        );
      }
    }

    if (!userId) throw new Error(`CloudFuze login failed — no userId returned for ${cfg.username}. Check email and password.`);
    const token = Buffer.from(`${userId}:${md5Pass}`).toString('base64');
    session = { auth: `Basic ${token}`, userId, baseURL: cfg.url };
    logger.info(`CloudFuze login successful (userId=${userId}) @ ${cfg.url}`);
  } else {
    throw new Error('CloudFuze credentials missing — enter the migration server, email and password in the wizard (Migration Server step).');
  }

  sessionCache.set(key, session);
  return session;
}

/** Back-compat alias — returns the session for a context. */
async function login(context = {}) {
  return getSession(context);
}

/**
 * Create an axios instance with the CloudFuze auth header for a given server.
 * auth is the full Authorization value, e.g. "Basic xxx" or "Bearer xxx".
 */
function getAuthClient(auth, baseURL) {
  return axios.create(
    migrationAxiosConfig({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
      },
      timeout: 60000,
    })
  );
}

/**
 * Resolve CloudFuze subscriber profile.
 * GET /users/validateUser?searchUser=<email>
 */
async function validateUser(email, context = {}) {
  if (!email || typeof email !== 'string') throw new Error('validateUser: email is required');

  const { auth, baseURL } = await getSession(context);
  const client = getAuthClient(auth, baseURL);

  const res = await retryWithBackoff(
    () => client.get('users/validateUser', { params: { searchUser: email.trim(), _: Date.now() } }),
    { label: 'CloudFuze validateUser', maxRetries: 2 }
  );
  return res.data;
}

/**
 * List all cloud accounts connected to this CloudFuze user.
 * GET /users/{userId}/get/all/cloud
 *
 * Each account: { id, cloudName, emailId, domainList, cloudUserId, cloudStatus, ... }
 */
async function getCloudAccounts(context = {}) {
  const { auth, userId, baseURL } = await getSession(context);
  if (!userId) {
    logger.warn('CloudFuze getCloudAccounts: no userId available (Bearer token mode) — skipping cloud lookup');
    return [];
  }
  const client = getAuthClient(auth, baseURL);
  const res = await retryWithBackoff(
    () => client.get(`users/${userId}/get/all/cloud`),
    { label: 'CloudFuze getCloudAccounts', maxRetries: 2 }
  );
  return Array.isArray(res.data) ? res.data : [];
}

// ── Email migration ───────────────────────────────────────────────────────────

function initiatePathCandidates() {
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
  const { auth, baseURL } = await getSession(context);
  const client = getAuthClient(auth, baseURL);

  const payload = [
    {
      fromCloudName: 'GMAIL',
      toCloudName: 'OUTLOOK',
      fromMailId: context.sourceEmail,
      toMailId: context.destinationEmail,
      ownerEmailId: env.CLOUDFUZE_OWNER_EMAIL || context.sourceEmail,
      fromRootId: '/',
      toRootId: '/',
      deltaMigration: context.migrationType === 'DELTA',
      onlineMove: false,
      contacts: false,
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

  const paths = initiatePathCandidates();
  const base = baseURL;
  let lastErr;

  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    try {
      const res = await retryWithBackoff(
        () => client.post(path, payload),
        { label: `CloudFuze POST ${path}`, maxRetries: 3 }
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
      if ((st === 405 || st === 404) && i < paths.length - 1) {
        logger.warn(`POST ${base}/${path} → HTTP ${st}${allow ? `; Allow: ${allow}` : ''} — trying next initiate path…`);
        continue;
      }
      if (st === 405) {
        throw new Error(
          `${err.message || 'HTTP 405'}${allow ? ` (Allow: ${allow})` : ''}. ` +
          `Set MIGRATION_API_INITIATE_PATH from DevTools → Network → initiate.`
        );
      }
      throw err;
    }
  }

  throw lastErr || new Error('Migration initiate failed: no path candidates');
}

// ── Chat / message migration ──────────────────────────────────────────────────

// CloudFuze internal cloud name → combination letter
const CF_PLATFORM = {
  slack:            'SLACK',
  teams:            'MICROSOFT_TEAMS',
  microsoft:        'MICROSOFT_TEAMS',
  microsoft_teams:  'MICROSOFT_TEAMS',
  google:           'GOOGLE_CHAT',
  googlechat:       'GOOGLE_CHAT',
  google_chat:      'GOOGLE_CHAT',
};

// Combination codes used in the CloudFuze payload
const COMBINATION_CODE = {
  SLACK_MICROSOFT_TEAMS:           'S2T',
  SLACK_GOOGLE_CHAT:               'S2C',
  SLACK_SLACK:                     'S2S',
  MICROSOFT_TEAMS_MICROSOFT_TEAMS: 'T2T',
  MICROSOFT_TEAMS_GOOGLE_CHAT:     'T2C',
  MICROSOFT_TEAMS_SLACK:           'T2S',
  GOOGLE_CHAT_MICROSOFT_TEAMS:     'C2T',
  GOOGLE_CHAT_GOOGLE_CHAT:         'C2C',
  GOOGLE_CHAT_SLACK:               'C2S',
};

function getCombination(srcCloud, dstCloud) {
  return COMBINATION_CODE[`${srcCloud}_${dstCloud}`] || `${srcCloud[0]}2${dstCloud[0]}`;
}

/**
 * Find the first cloud account matching the given CloudFuze cloudName and admin email.
 * Falls back to domain match if exact email match fails.
 */
function findCloudAccount(accounts, cfCloudName, adminEmail) {
  const emailLower = (adminEmail || '').toLowerCase();
  const domainLower = emailLower.split('@')[1] || '';

  // Exact email match
  let match = accounts.find(
    (a) => a.cloudName === cfCloudName && (a.emailId || '').toLowerCase() === emailLower
  );
  if (match) return match;

  // Domain match (admin manages the domain)
  match = accounts.find(
    (a) => a.cloudName === cfCloudName &&
      Array.isArray(a.domainList) &&
      a.domainList.some((d) => (d || '').toLowerCase() === domainLower)
  );
  if (match) return match;

  // Fallback: first account of the right platform
  return accounts.find((a) => a.cloudName === cfCloudName) || null;
}

/**
 * Parse a raw user-mapping CSV string into [ { sourceEmail, destinationEmail } ] pairs.
 * Handles headers named "Source Email", "Source User", or positional first two columns.
 */
function parseMappingCsv(text) {
  const lines = (text || '').split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const firstLower = lines[0].toLowerCase();
  const start = (firstLower.includes('source') || firstLower.includes('email') || firstLower.includes('user')) ? 1 : 0;
  const pairs = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    if (cols[0] && cols[1]) pairs.push({ sourceEmail: cols[0], destinationEmail: cols[1] });
  }
  return pairs;
}

/**
 * Upload the user email-mapping CSV to CF for one src→dst cloud pair.
 *
 * Sequence (per USER_MAPPING_API_COLLECTION):
 *   1. GET  /mapping/get/permissioncachedetails/{src}/{dst}   — check cache
 *   2. POST /mapping/permissiondetiails/{src}/{dst}           — create if missing
 *   3. POST /messagemove/message/usermapping/csv?sourceCloudId=...&destCloudId=...  — upload
 *
 * The multipart body is built manually (Buffer.concat) to avoid axios/FormData
 * serialisation quirks in Node.js server environments.
 */
async function setupUserMappingInCF(auth, baseURL, srcCloudId, dstCloudId, rawCsvText) {
  if (!srcCloudId || !dstCloudId) return;
  if (!rawCsvText || !rawCsvText.trim()) return;

  const jsonClient = getAuthClient(auth, baseURL);

  // 1. Check permission cache
  let cacheExists = false;
  try {
    const res = await jsonClient.get(`mapping/get/permissioncachedetails/${srcCloudId}/${dstCloudId}`);
    const d = res.data;
    cacheExists = Array.isArray(d) ? d.length > 0 : !!(d && typeof d === 'object' && Object.keys(d).length > 0);
    logger.info(`CF permission cache ${cacheExists ? 'exists' : 'missing'} for ${srcCloudId}→${dstCloudId}`);
  } catch (err) {
    logger.warn(`CF permission cache check error ${srcCloudId}→${dstCloudId}: ${err.message}`);
  }

  // 2. Create cache if missing
  if (!cacheExists) {
    try {
      const cr = await jsonClient.post(`mapping/permissiondetiails/${srcCloudId}/${dstCloudId}`);
      logger.info(`CF permission cache created ${srcCloudId}→${dstCloudId} | ${JSON.stringify(cr.data).slice(0, 80)}`);
    } catch (err) {
      logger.warn(`CF permission cache create failed ${srcCloudId}→${dstCloudId}: ${err.message}`);
    }
  }

  // 3. Upload CSV — POST /messagemove/message/usermapping/csv?sourceCloudId=...&destCloudId=...
  //
  //    Network capture of CF web UI manual upload shows:
  //      Content-Type: application/json
  //      Body: raw CSV text (no wrapping, no multipart)
  //    Multipart form-data returns HTTP 200 + [] (server ignores it silently).
  try {
    // Normalise CSV: strip BOM, ensure LF line endings, correct header
    let cleanCsv = rawCsvText.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const csvLines = cleanCsv.split('\n');
    if (csvLines.length > 0) {
      const firstLine = csvLines[0].trim();
      if (firstLine.includes('@')) {
        csvLines.unshift('Source User,Destination User');
      } else if (firstLine !== 'Source User,Destination User') {
        csvLines[0] = 'Source User,Destination User';
      }
    }
    cleanCsv = csvLines.filter((l, i) => i === 0 || l.trim()).join('\n');
    const rowCount = csvLines.filter(Boolean).length - 1;
    logger.info(`CF CSV (${srcCloudId}→${dstCloudId}): rows=${rowCount} | preview: ${cleanCsv.slice(0, 200)}`);

    const uploadUrl = `messagemove/message/usermapping/csv?sourceCloudId=${srcCloudId}&destCloudId=${dstCloudId}`;
    const uploadClient = axios.create(migrationAxiosConfig({ baseURL, timeout: 60000 }));

    // Primary: raw CSV body with application/json Content-Type (matches CF web UI network capture)
    let uploadRes = null;
    let lastErr = null;
    const contentTypes = ['application/json', 'text/plain', 'text/csv'];

    for (const ct of contentTypes) {
      try {
        uploadRes = await uploadClient.post(uploadUrl, cleanCsv, {
          headers: { Authorization: auth, 'Content-Type': ct },
        });
        logger.info(`CF CSV upload [raw:${ct}] ${srcCloudId}→${dstCloudId}: HTTP ${uploadRes.status} | ${JSON.stringify(uploadRes.data).slice(0, 120)}`);
        lastErr = null;
        break;
      } catch (err) {
        logger.warn(`CF CSV upload [raw:${ct}] ${srcCloudId}→${dstCloudId}: ${err.response?.status ?? err.message} — trying next`);
        lastErr = err;
      }
    }

    if (lastErr) {
      logger.error(`CF CSV upload FAILED all content-type strategies ${srcCloudId}→${dstCloudId}: ${lastErr.message}`);
    }

    // Verify — GET /mapping/user/clouds/get/permissions (correct endpoint from CF API spec)
    try {
      const verifyRes = await jsonClient.get(
        `mapping/user/clouds/get/permissions?sourceCloudId=${srcCloudId}&destCloudId=${dstCloudId}&pageNo=1&pageSize=200`
      );
      const vd = verifyRes.data;
      const verifiedRows = Array.isArray(vd) ? vd.length : (vd?.totalCount ?? vd?.total ?? (Array.isArray(vd?.data) ? vd.data.length : 0));
      if (verifiedRows > 0) {
        logger.info(`CF CSV upload confirmed — ${verifiedRows} mapping(s) on CF server for ${srcCloudId}→${dstCloudId}`);
      } else {
        logger.warn(`CF CSV verify ${srcCloudId}→${dstCloudId}: 0 rows after upload (sent ${rowCount} rows)`);
      }
    } catch (verifyErr) {
      logger.warn(`CF CSV verify failed ${srcCloudId}→${dstCloudId}: ${verifyErr.message}`);
    }
  } catch (err) {
    logger.error(`CF CSV upload FAILED ${srcCloudId}→${dstCloudId}: ${err.message}`);
  }
}

/**
 * Return the raw CSV text from context (reads the saved file, or builds from
 * in-memory pairs). Returns null if no mapping data is available.
 */
function resolveCsvFromContext(context) {
  const fs = require('fs');
  if (context.userMappingCsvPath) {
    try {
      const text = fs.readFileSync(context.userMappingCsvPath, 'utf8');
      if (text && text.trim()) return text;
    } catch (_) { /* fall through to in-memory pairs */ }
  }
  const pairs = (context.userMappings || []).filter((p) => p.sourceEmail && p.destinationEmail);
  if (pairs.length > 0) {
    const lines = ['Source User,Destination User'];
    for (const p of pairs) lines.push(`${p.sourceEmail},${p.destinationEmail}`);
    return lines.join('\n');
  }
  return null;
}

/**
 * Upload the CSV to EVERY connected cloud-account pair (called from step-2 wizard
 * upload so all combinations have the mapping before any migration runs).
 */
async function uploadUserMappingForAllCombinations(context, accounts, auth, baseURL) {

  // Prefer the saved CSV file — it's the exact content the user provided
  let rawCsvText = null;
  if (context.userMappingCsvPath) {
    try {
      rawCsvText = fs.readFileSync(context.userMappingCsvPath, 'utf8');
      const rows = rawCsvText.split('\n').filter(Boolean).length - 1;
      logger.info(`CF: using saved CSV file (${rows} rows) from ${context.userMappingCsvPath}`);
    } catch (err) {
      logger.warn(`CF: could not read CSV file at ${context.userMappingCsvPath}: ${err.message}`);
    }
  }

  // Fallback: build CSV from in-memory pairs
  if (!rawCsvText) {
    const pairs = (context.userMappings || []).filter((p) => p.sourceEmail && p.destinationEmail);
    if (pairs.length > 0) {
      const lines = ['Source User,Destination User'];
      for (const p of pairs) lines.push(`${p.sourceEmail},${p.destinationEmail}`);
      rawCsvText = lines.join('\n');
      logger.info(`CF: built CSV from ${pairs.length} in-memory mapping pair(s)`);
    }
  }

  if (!rawCsvText) {
    logger.info('CF: no user mapping data available — skipping CF user mapping upload');
    return;
  }

  // Upload for every unique (src, dst) cloud pair — covers all combinations
  const seen = new Set();
  for (const src of accounts) {
    for (const dst of accounts) {
      if (!src.id || !dst.id || src.id === dst.id) continue;
      const key = `${src.id}:${dst.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await setupUserMappingInCF(auth, baseURL, src.id, dst.id, rawCsvText);
    }
  }

  if (seen.size === 0) {
    logger.warn('CF: no cloud account pairs found — user mapping CSV was NOT uploaded to CF');
  } else {
    logger.info(`CF: user mapping uploaded for ${seen.size} cloud pair(s) across all combinations`);
  }
}

/**
 * Upload a raw CSV string to the CF server for every connected cloud-account pair.
 * context carries the server credentials (migrationServerUrl/Email/Password) from the
 * wizard step-2 upload request. Falls back to env vars when context is empty.
 *
 * Returns the count of cloud pairs the CSV was uploaded to (0 if no accounts found).
 */
async function uploadUserMappingCsvToAllPairs(csvText, context = {}) {
  if (!csvText || !csvText.trim()) {
    logger.warn('CF uploadUserMappingCsvToAllPairs: empty CSV — skipping');
    return 0;
  }
  const rowCount = csvText.split('\n').filter(Boolean).length - 1;
  if (rowCount === 0) {
    logger.warn('CF uploadUserMappingCsvToAllPairs: no data rows in CSV — skipping');
    return 0;
  }

  const { auth, baseURL } = await getSession(context);
  const accounts = await getCloudAccounts(context);

  if (accounts.length === 0) {
    logger.warn('CF uploadUserMappingCsvToAllPairs: no cloud accounts found — cannot upload mapping');
    return 0;
  }

  const seen = new Set();
  for (const src of accounts) {
    for (const dst of accounts) {
      if (!src.id || !dst.id || src.id === dst.id) continue;
      const key = `${src.id}:${dst.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await setupUserMappingInCF(auth, baseURL, src.id, dst.id, csvText);
    }
  }

  logger.info(`CF: user mapping CSV (${rowCount} rows) uploaded to ${seen.size} cloud pair(s)`);
  return seen.size;
}

/**
 * Path candidates for chat migration initiate.
 * Primary: /messagemove/create/messagemove/custom  (channels)
 *         /messagemove/create                       (DMs with directOrGroupMessage=true)
 */
function chatInitiatePath(isDm) {
  const custom = (env.CHAT_MIGRATION_API_INITIATE_PATH || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (custom) return custom;
  if (isDm) return 'messagemove/create';
  return 'messagemove/create/messagemove/custom';
}

/**
 * Trigger CloudFuze chat/message migration for one or more channels/DMs.
 *
 * context must contain:
 *   sourcePlatform, destinationPlatform, sourceEmail, destinationEmail,
 *   channelIds[], dmIds[], migrationType, executionId
 */
async function triggerChatMigration(context) {
  const { auth, baseURL } = await getSession(context);
  const client = getAuthClient(auth, baseURL);

  const srcCloudName = CF_PLATFORM[(context.sourcePlatform || '').toLowerCase()] || 'SLACK';
  const dstCloudName = CF_PLATFORM[(context.destinationPlatform || '').toLowerCase()] || 'MICROSOFT_TEAMS';
  const combination = getCombination(srcCloudName, dstCloudName);
  const isDelta = context.migrationType === 'DELTA';

  const targets = [
    ...(context.channelIds || []).map((id) => ({ id, kind: 'channel', isDm: false })),
    ...(context.dmIds     || []).map((id) => ({ id, kind: 'dm',      isDm: true  })),
  ];

  if (targets.length === 0) {
    return { status: 'SKIPPED', totalTargets: 0, initiated: 0, failed: 0, results: [] };
  }

  // Get cloud account IDs
  let srcCloudId = null;
  let dstCloudId = null;
  let srcAcct    = null;
  try {
    const accounts = await getCloudAccounts(context);
    srcAcct        = findCloudAccount(accounts, srcCloudName, context.sourceEmail);
    const dstAcct  = findCloudAccount(accounts, dstCloudName, context.destinationEmail);
    srcCloudId = srcAcct?.id || null;
    dstCloudId = dstAcct?.id || null;
    if (srcCloudId) logger.info(`CloudFuze: source cloud ${srcCloudName} → id=${srcCloudId} (${srcAcct?.emailId})`);
    if (dstCloudId) logger.info(`CloudFuze: dest cloud ${dstCloudName} → id=${dstCloudId} (${dstAcct?.emailId})`);
    if (!srcCloudId) logger.warn(`CloudFuze: no cloud account found for ${srcCloudName}/${context.sourceEmail}`);
    if (!dstCloudId) logger.warn(`CloudFuze: no cloud account found for ${dstCloudName}/${context.destinationEmail}`);
  } catch (err) {
    logger.warn(`CloudFuze: getCloudAccounts failed: ${err.message} — continuing without cloud IDs`);
  }

  // Upload user mapping CSV to CF server before migration
  const rawCsvText = resolveCsvFromContext(context);
  if (srcCloudId && dstCloudId && rawCsvText) {
    logger.info(`CF: uploading user mapping CSV to server for ${srcCloudId}→${dstCloudId}`);
    await setupUserMappingInCF(auth, baseURL, srcCloudId, dstCloudId, rawCsvText);
  }

  // Map our internal kind → CloudFuze channelType string
  function toChannelType(kind) {
    if (kind === 'dm' || kind === 'im') return 'im';
    if (kind === 'group_dm' || kind === 'group_chat') return 'group_chat';
    if (kind === 'private') return 'private';
    return 'public';
  }

  // ── Enrich selected channels with CloudFuze's own channel metadata ──────────
  // CRITICAL: CloudFuze scopes the message scan by `channelDate`. Our wizard lists
  // channels from Slack's API (which has NO channelDate), so without this the payload
  // defaults channelDate to "now" and CloudFuze finds 0 messages ("No Messages").
  // CF's channel list keys on `fromRootId` === the Slack channel id, so we match by id
  // and pull the REAL channelDate + dest names + privacy. Cached per combination.
  let cfChannelMap = {};
  if (srcCloudId && dstCloudId && targets.some((t) => !t.isDm)) {
    async function fetchCFChannelMap() {
      let cached = channelCache.get(combination, srcCloudId, dstCloudId);
      if (!cached || (!(cached.publicChannels || []).length && !(cached.privateChannels || []).length)) {
        const [pub, priv] = await Promise.all([
          getCloudChannels({ srcCloudId, dstCloudId, channelType: 'public', context }),
          getCloudChannels({ srcCloudId, dstCloudId, channelType: 'private', context }),
        ]);
        cached = { publicChannels: pub, privateChannels: priv };
        channelCache.set(combination, srcCloudId, dstCloudId, cached);
      }
      const map = {};
      for (const c of (cached.publicChannels || []))  { const k = c.fromRootId || c.channelId || c.id; if (k) map[k] = { ...c, _cfType: 'public' }; }
      for (const c of (cached.privateChannels || [])) { const k = c.fromRootId || c.channelId || c.id; if (k) map[k] = { ...c, _cfType: 'private' }; }
      return map;
    }
    try {
      cfChannelMap = await fetchCFChannelMap();
      logger.info(`CloudFuze: enriched channel metadata from CF list (${Object.keys(cfChannelMap).length} channels available)`);
    } catch (err) {
      // 401 = CF session expired between wizard step and migration initiation — clear cache and retry once
      if (err.response?.status === 401 || String(err.message).includes('401')) {
        logger.warn(`CloudFuze: channel metadata enrich got 401 — clearing session cache and retrying…`);
        const cfg = cfConfigFromContext(context);
        const staleKey = `${cfg.url}::${cfg.basicAuth || cfg.bearer || cfg.username || 'anon'}`;
        sessionCache.delete(staleKey);
        channelCache.set(combination, srcCloudId, dstCloudId, { publicChannels: [], privateChannels: [] });
        try {
          cfChannelMap = await fetchCFChannelMap();
          logger.info(`CloudFuze: channel metadata enrich succeeded after session refresh (${Object.keys(cfChannelMap).length} channels)`);
        } catch (retryErr) {
          logger.warn(
            `CloudFuze: channel metadata enrich failed after retry (${retryErr.message}) — ` +
            `using channelDate=0 (all history). Migration will still proceed with all messages.`
          );
        }
      } else {
        logger.warn(
          `CloudFuze: channel metadata enrich failed (${err.message}) — ` +
          `using channelDate=0 (all history). Migration will still proceed with all messages.`
        );
      }
    }
  }

  const results = [];

  // Enrich target list with metadata from context.channelObjects / context.dmObjects
  const channelObjects = Array.isArray(context.channelObjects) ? context.channelObjects : [];
  const dmObjects      = Array.isArray(context.dmObjects)      ? context.dmObjects      : [];

  // Batch channels and DMs separately (different endpoints). CF metadata wins for the
  // fields CloudFuze actually uses (channelDate, privacy, dest names).
  const channels = targets
    .filter((t) => !t.isDm)
    .map((t) => {
      const enriched = channelObjects.find((c) => c.id === t.id) || {};
      const cf = cfChannelMap[t.id] || {};
      return {
        ...t,
        ...enriched,
        channelName:     enriched.name || enriched.channelName || cf.channelName || t.name,
        channelDate:     cf.channelDate ?? enriched.channelDate ?? t.channelDate,
        cfChannelType:   cf._cfType || cf.channelType,
        destChannelName: enriched.destChannelName || cf.destChannelName,
        destTeamName:    enriched.destTeamName || cf.destTeamName,
        workSpaceName:   enriched.workSpaceName || cf.workSpaceName,
        cfMatched:       cf.channelDate != null,
      };
    });
  const dms = targets
    .filter((t) => t.isDm)
    .map((t) => {
      const enriched = dmObjects.find((d) => d.id === t.id) || {};
      return { ...t, kind: 'dm', ...enriched };
    });

  async function initiateTargets(batch, isDm) {
    if (batch.length === 0) return;

    const payload = batch.map((t) => {
      const channelName = t.name || t.channelName || t.id;
      // Warn loudly if a channel wasn't found in CloudFuze's list — without the real
      // channelDate CloudFuze will report "No Messages" (0 migrated).
      if (!isDm && !t.cfMatched) {
        logger.warn(
          `CloudFuze: channel "${channelName}" (${t.id}) not found in CF channel list — ` +
          `using channelDate=0 (all history). Ensure the channel is indexed in CloudFuze.`
        );
      }
      // Use ?? (not ||) so that channelDate=0 (epoch start = all history) is preserved.
      // Fallback to 0 so CF scans all historical messages when no date is available.
      const channelDateValue = t.channelDate ?? 0;
      logger.info(`CF channel ${t.id}: channelDate=${channelDateValue}`);
      const obj = {
        fromRootId: t.id,
        toRootId: '/',
        channelDate: String(channelDateValue),
        dateChanged: false,
        channelType: t.cfChannelType || toChannelType(t.kind),
        channelName,
        workSpaceName: t.workSpaceName || srcAcct?.metadataUrl || '',
        destChannelName: t.destChannelName || channelName,
        // Never send '/' — CF uses this literally as the destination team name in reports
        destTeamName: t.destTeamName || t.workSpaceName || channelName || '',
        specialCharacter: '-',
        migrateAsSubChannel: false,
        toSplit: false,
        reactionToPick: false,
        skipFileContent: false,
        externalShared: t.externalShared || false,
        combination,
      };
      if (srcCloudId) obj.fromCloudId = { id: srcCloudId };
      if (dstCloudId) obj.toCloudId   = { id: dstCloudId };
      if (isDm) obj.directOrGroupMessage = true;
      // Fallback fields for servers that still accept the old format
      if (!srcCloudId) {
        obj.fromCloudName = srcCloudName;
        obj.fromMailId    = context.sourceEmail;
      }
      if (!dstCloudId) {
        obj.toCloudName = dstCloudName;
        obj.toMailId    = context.destinationEmail;
      }
      return obj;
    });

    const pathBase = chatInitiatePath(isDm);
    const url = isDm
      ? `${pathBase}?directOrGroupMessage=true&isDelta=${isDelta}&DisableQueueJob=false`
      : `${pathBase}?willHaveDelta=${isDelta}&deltaMigration=false`;

    try {
      const res = await retryWithBackoff(
        () => client.post(url, payload),
        { label: `CF chat POST ${url}`, maxRetries: 2 }
      );
      const rawData = Array.isArray(res.data) ? res.data : [res.data];
      // Log the first item so we can see all fields (helps verify messageJobId field name)
      if (rawData[0]) logger.info(`CF initiation raw[0]: ${JSON.stringify(rawData[0]).slice(0, 400)}`);
      batch.forEach((t, i) => {
        const r = rawData[i] || {};
        // messageJobId is the Teams-job ID used by closeCreatedTeams.
        // .id is the channel-record ID (one ObjectID earlier) — prefer messageJobId.
        const jobId = r.messageJobId || r.teamJobId || r.wsid || r.id || r.jobId || res.data?.messageJobId || res.data?.id || 'initiated';
        results.push({ target: t.id, kind: t.kind, jobId, status: 'INITIATED' });
        logger.info(`CF chat migration initiated: ${t.id} (${t.kind}) → job ${jobId} via ${url}`, { executionId: context.executionId });
      });
    } catch (err) {
      const st = err.response?.status;
      logger.error(`CF chat POST ${url} → HTTP ${st || 'ERR'}: ${err.message}`);
      batch.forEach((t) => results.push({ target: t.id, kind: t.kind, error: err.message, status: 'FAILED' }));
    }
  }

  await initiateTargets(channels, false);
  await initiateTargets(dms, true);

  const allOk = results.every((r) => r.status === 'INITIATED');
  const anyOk = results.some((r) => r.status === 'INITIATED');

  // Poll for completion then close each Teams job so migrated content becomes visible.
  const initiatedTargets = results
    .filter((r) => r.status === 'INITIATED')
    .map((r) => ({ channelId: r.target, jobId: r.jobId, kind: r.kind }));
  if (initiatedTargets.length > 0) {
    // Fire-and-forget: poll runs in the background so the agent returns immediately
    // instead of blocking for up to 30 minutes waiting for CF to finish.
    pollAndCloseTeams(initiatedTargets, auth, baseURL, context, 30 * 60 * 1000).catch((err) => {
      logger.error(`CF: pollAndCloseTeams background error: ${err.message}`);
    });
  }

  return {
    status:       allOk ? 'INITIATED' : anyOk ? 'PARTIAL' : 'FAILED',
    totalTargets: targets.length,
    initiated:    results.filter((r) => r.status === 'INITIATED').length,
    failed:       results.filter((r) => r.status === 'FAILED').length,
    results,
  };
}

/**
 * Fetch ALL channels from CloudFuze by paginating until fewer results than PAGE_SIZE.
 * Tries common CF pagination params (page/pageSize, start/limit, pageNumber/noOfRecords).
 * Deduplicates by fromRootId so duplicate pages don't inflate counts.
 *
 * GET /messagemove/get/slack/channel?adminCloudId=...&destAdminCloudId=...&channelType=...
 */
const CHANNEL_PAGE_SIZE = 100;

async function getCloudChannels({ srcCloudId, dstCloudId, channelType = 'public', context = {} } = {}) {
  const { auth, baseURL } = await getSession(context);
  const client = getAuthClient(auth, baseURL);

  const allChannels = [];
  const seen = new Set();
  let pageNo = 1;

  while (true) {
    const params = {};
    if (srcCloudId)  params.adminCloudId     = srcCloudId;
    if (dstCloudId)  params.destAdminCloudId = dstCloudId;
    if (channelType) params.channelType      = channelType;
    // Send all common pagination param names; CF will use whichever it recognises
    params.page         = pageNo;
    params.pageNo       = pageNo;
    params.pageNumber   = pageNo;
    params.pageSize     = CHANNEL_PAGE_SIZE;
    params.noOfRecords  = CHANNEL_PAGE_SIZE;
    params.limit        = CHANNEL_PAGE_SIZE;
    params.start        = (pageNo - 1) * CHANNEL_PAGE_SIZE;
    params.offset       = (pageNo - 1) * CHANNEL_PAGE_SIZE;

    const res = await retryWithBackoff(
      () => client.get('messagemove/get/slack/channel', { params }),
      { label: `getCloudChannels p${pageNo} type=${channelType}`, maxRetries: 2 }
    );

    const batch = Array.isArray(res.data) ? res.data : [];

    let newCount = 0;
    for (const ch of batch) {
      const id = ch.fromRootId || ch.channelId || ch.id || JSON.stringify(ch);
      if (!seen.has(id)) { seen.add(id); allChannels.push(ch); newCount++; }
    }

    // Stop when: no new results, batch < PAGE_SIZE, or safety cap reached
    if (newCount === 0 || batch.length < CHANNEL_PAGE_SIZE || pageNo >= 20) break;
    pageNo++;
  }

  logger.info(`getCloudChannels (${channelType}): ${allChannels.length} total across ${pageNo} page(s)`);
  return allChannels;
}

/**
 * Fetch ALL DMs from CloudFuze with pagination.
 * GET /messagemove/get/slackdms?adminCloudId=...&destAdminCloudId=...&channelType=all
 */
async function getCloudDMs({ srcCloudId, dstCloudId, context = {} } = {}) {
  const { auth, baseURL } = await getSession(context);
  const client = getAuthClient(auth, baseURL);

  const allDms = [];
  const seen = new Set();
  let pageNo = 1;

  while (true) {
    const params = { channelType: 'all' };
    if (srcCloudId) params.adminCloudId     = srcCloudId;
    if (dstCloudId) params.destAdminCloudId = dstCloudId;
    params.page        = pageNo;
    params.pageNo      = pageNo;
    params.pageNumber  = pageNo;
    params.pageSize    = CHANNEL_PAGE_SIZE;
    params.noOfRecords = CHANNEL_PAGE_SIZE;
    params.limit       = CHANNEL_PAGE_SIZE;
    params.start       = (pageNo - 1) * CHANNEL_PAGE_SIZE;
    params.offset      = (pageNo - 1) * CHANNEL_PAGE_SIZE;

    const res = await retryWithBackoff(
      () => client.get('messagemove/get/slackdms', { params }),
      { label: `getCloudDMs p${pageNo}`, maxRetries: 2 }
    );

    const batch = Array.isArray(res.data) ? res.data : [];

    let newCount = 0;
    for (const dm of batch) {
      const id = dm.fromRootId || dm.channelId || dm.id || JSON.stringify(dm);
      if (!seen.has(id)) { seen.add(id); allDms.push(dm); newCount++; }
    }

    if (newCount === 0 || batch.length < CHANNEL_PAGE_SIZE || pageNo >= 20) break;
    pageNo++;
  }

  logger.info(`getCloudDMs: ${allDms.length} total across ${pageNo} page(s)`);
  return allDms;
}

/**
 * Get migration jobs/reports from CloudFuze.
 * GET /messagemove/get/moveJob?combination=S2T&migrationStatus=All
 */
async function getMigrationReports({ combination = '', migrationStatus = 'All', context = {} } = {}) {
  const { auth, baseURL } = await getSession(context);
  const client = getAuthClient(auth, baseURL);
  const params = { migrationStatus };
  if (combination) params.combination = combination;
  const res = await retryWithBackoff(
    () => client.get('messagemove/get/moveJob', { params }),
    { label: 'CloudFuze getMigrationReports', maxRetries: 2 }
  );
  return Array.isArray(res.data) ? res.data : [];
}

// ── Close-completion tracker ──────────────────────────────────────────────────
// Maps channelId → { promise, resolve, reject }.
// pollAndCloseTeams resolves each entry when its job is closed.
// waitForChannelsClosed() lets MessageValidationAgent await close before reading Teams.
const _closePending = new Map(); // channelId → { resolve, reject }

// ── Teams destination registry ─────────────────────────────────────────────────
// After CF closes a migration job, stores the actual Teams team+channel IDs so
// MessageValidationAgent can directly access the Teams channel without name-guessing.
// key: Slack channelId  →  value: { teamId, channelId, channelName, teamName }
const _teamsDestinations = new Map();

/**
 * Extract and cache Teams team+channel IDs from a CF job report or close response.
 * CF returns the destination IDs under various field names depending on version.
 * This is called both when a CF report reaches terminal status AND when closeCreatedTeams
 * returns its response body — each may carry different fields.
 *
 * @param {string} slackChannelId  - Slack source channel ID (the cache key)
 * @param {object} data            - CF report job or close response object
 */
function _captureTeamsDestination(slackChannelId, data) {
  if (!slackChannelId || !data || typeof data !== 'object') return;

  // Azure AD / Teams object IDs are always GUIDs: 8-4-4-4-12 hex segments.
  // Teams channel thread IDs look like "19:xxx@thread.tacv2" — NOT GUIDs.
  // When CF populates toRootId after migration, for S2T it typically stores the
  // Teams TEAM ID (a GUID), not the channel thread ID.
  const rawToRootId = String(data.toRootId || '').trim();
  const toRootIsGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawToRootId);

  // Try all known CF field name variants for destination Teams team ID.
  // If toRootId is a GUID, treat it as teamId (team IDs are GUIDs; channel IDs are thread strings).
  const teamId =
    data.teamId           || data.toTeamId      || data.msTeamId       ||
    data.teamsTeamId      || data.destTeamId    || data.targetTeamId   ||
    data.destinationTeamId || (toRootIsGuid ? rawToRootId : null) || null;

  // channelId: use toRootId only when it is NOT a GUID (i.e. it's a thread ID like "19:...")
  const channelId =
    data.toChannelId      || data.msChannelId   || data.teamsChannelId ||
    data.destChannelId    || data.targetChannelId || data.destinationChannelId ||
    (!toRootIsGuid && rawToRootId && rawToRootId !== '/' ? rawToRootId : null) || null;

  const channelName =
    data.destChannelName || data.toChannelName || data.msChannelName || null;
  const teamName =
    data.destTeamName  || data.toTeamName  || data.workSpaceName   || null;

  if (teamId || channelId) {
    const existing = _teamsDestinations.get(slackChannelId) || {};
    _teamsDestinations.set(slackChannelId, {
      teamId:      teamId      || existing.teamId      || null,
      channelId:   channelId   || existing.channelId   || null,
      channelName: channelName || existing.channelName || null,
      teamName:    teamName    || existing.teamName    || null,
    });
    logger.info(
      `CF: stored Teams destination for Slack ch ${slackChannelId}: ` +
      `teamId=${teamId} channelId=${channelId} channel="${channelName}" team="${teamName}"`
    );
  }
}

/**
 * Return the cached Teams team+channel IDs for a given Slack channel ID.
 * Used by MessageValidationAgent to directly access the Teams destination channel
 * without relying on name-based search (which can fail when the team is newly created
 * or has a different name than the Slack channel/workspace).
 *
 * @param {string} slackChannelId
 * @returns {{ teamId: string|null, channelId: string|null, channelName: string|null, teamName: string|null } | null}
 */
function getTeamsDestination(slackChannelId) {
  return _teamsDestinations.get(slackChannelId) || null;
}

function _notifyChannelClosed(channelId) {
  const entry = _closePending.get(channelId);
  if (entry) { entry.resolve(); _closePending.delete(channelId); }
}

/**
 * Returns a Promise that resolves once all supplied channelIds have been closed
 * (or after timeoutMs, whichever comes first).
 * Call this in MessageValidationAgent before reading the Teams destination.
 */
function waitForChannelsClosed(channelIds, timeoutMs) {
  if (timeoutMs == null) timeoutMs = 90_000;
  const ids = (channelIds || []).filter(Boolean);
  if (ids.length === 0) return Promise.resolve();

  const promises = ids.map((id) => {
    if (!_closePending.has(id)) return Promise.resolve(); // already closed or not tracked
    const { promise } = _closePending.get(id);
    return promise;
  });

  return Promise.race([
    Promise.all(promises),
    new Promise((_, rej) => setTimeout(() => rej(new Error('close-timeout')), timeoutMs)),
  ]).catch(() => { /* timeout — continue anyway */ });
}

/**
 * Register channelIds as pending-close so waitForChannelsClosed can track them.
 * Called by pollAndCloseTeams before it starts polling.
 */
function _registerPendingClose(channelIds) {
  for (const id of channelIds) {
    if (_closePending.has(id)) continue;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    _closePending.set(id, { promise, resolve, reject });
  }
}

/**
 * MongoDB ObjectIDs encode: 4-byte timestamp | 5-byte machine+pid | 3-byte counter.
 * When CF initiates a migration, it writes the channel-record first (counter N) then
 * the Teams-job record (counter N+1). The initiation response returns the channel-record
 * ID; closeCreatedTeams needs the Teams-job ID (counter N+1).
 * Returns null for any non-ObjectID input.
 */
function teamsJobIdFromChannelId(hexId) {
  if (!hexId || hexId.length !== 24 || !/^[0-9a-f]+$/i.test(hexId)) return null;
  const counter = parseInt(hexId.slice(18), 16); // last 3 bytes = counter
  return hexId.slice(0, 18) + ((counter + 1) & 0xFFFFFF).toString(16).padStart(6, '0');
}

/**
 * Close a single CF Teams migration job.
 * POST /messagemove/close/createdteams?messageJobId=<id>
 * This makes the migrated Slack content visible in the destination Teams channel.
 * Returns the full response body (may contain Teams team/channel IDs).
 */
async function closeCreatedTeams(jobId, client) {
  const res = await client.post(`messagemove/close/createdteams`, null, {
    params: { messageJobId: jobId },
  });
  // Log the full close response — CF may return Teams team/channel IDs here
  logger.info(`CF: closeCreatedTeams job=${jobId} HTTP=${res.status} response=${JSON.stringify(res.data).slice(0, 600)}`);
  return res.data;
}

/**
 * Poll CF migration reports until every job in `jobIds` reaches a terminal
 * status (Processed / Partially Processed / Completed), then close each one.
 *
 * Runs as an awaited step inside triggerChatMigration with a max-wait cap so
 * the agent never blocks indefinitely.
 */
async function pollAndCloseTeams(initiatedTargets, auth, baseURL, context, maxWaitMs = 10 * 60 * 1000) {
  // initiatedTargets: [{ channelId, jobId, kind }]
  const valid = initiatedTargets.filter((t) => t.channelId || (t.jobId && t.jobId !== 'initiated'));
  if (valid.length === 0) return;

  const executionId = context && context.executionId;
  const bump = (msg) => {
    logger.info(msg);
    if (executionId) {
      try { getExecService().update(executionId, { progress: msg }); } catch (_) {}
    }
  };

  // Register all channels as pending-close so waitForChannelsClosed() can track them
  _registerPendingClose(valid.map((t) => t.channelId).filter(Boolean));

  const client = getAuthClient(auth, baseURL);
  const combination = getCombination(
    CF_PLATFORM[(context.sourcePlatform || '').toLowerCase()] || 'SLACK',
    CF_PLATFORM[(context.destinationPlatform || '').toLowerCase()] || 'MICROSOFT_TEAMS'
  );

  // Primary key: Slack channel ID (fromRootId in CF reports)
  const pendingChannels = new Set(valid.map((t) => t.channelId).filter(Boolean));
  // Fallback key: job ID from initiation response.
  const jobIdToChannel = new Map();
  for (const t of valid) {
    if (!t.jobId || t.jobId === 'initiated') continue;
    jobIdToChannel.set(t.jobId, t.channelId);
    const teamsId = teamsJobIdFromChannelId(t.jobId);
    if (teamsId) {
      jobIdToChannel.set(teamsId, t.channelId);
      logger.info(`CF: channel ${t.channelId} → initiation ID ${t.jobId}, expected Teams job ID ${teamsId}`);
    }
  }

  const POLL_INTERVAL_MS = 20_000;
  const deadline = Date.now() + maxWaitMs;

  bump(`CF: Waiting for ${pendingChannels.size} channel job(s) to complete before closing Teams…`);

  let pollRound = 0;
  let firstPoll = true;
  while (pendingChannels.size > 0 && Date.now() < deadline) {
    pollRound++;
    try {
      const reports = await getMigrationReports({ combination, migrationStatus: 'All', context });
      if (firstPoll) {
        firstPoll = false;
        if (reports.length > 0) {
          logger.info(`CF poll: ${reports.length} report(s) — first entry keys: ${JSON.stringify(reports[0]).slice(0, 400)}`);
        } else {
          logger.info(`CF poll: 0 reports returned for combination=${combination}`);
        }
      }

      const elapsed = Math.round((maxWaitMs - (deadline - Date.now())) / 1000);
      bump(`CF: Polling CF reports (round ${pollRound}) — ${pendingChannels.size} job(s) still pending… (${elapsed}s elapsed)`);

      for (const job of reports) {
        const reportJobId   = String(job.id || job._id || job.jobId || '');
        const reportChannel = String(job.fromRootId || job.channelId || job.fromChannelId || '');

        let matchedChannel = null;
        if (reportChannel && pendingChannels.has(reportChannel)) {
          matchedChannel = reportChannel;
        } else if (reportJobId && jobIdToChannel.has(reportJobId)) {
          const ch = jobIdToChannel.get(reportJobId);
          if (pendingChannels.has(ch)) matchedChannel = ch;
        }

        if (!matchedChannel) continue;

        const rawStatus = job.jobStatus || job.migrationStatus || job.status || '';
        const st = rawStatus.toLowerCase().replace(/\s+/g, '');
        const isDone = st.includes('processed') || st.includes('completed') || st.includes('partial');
        if (!isDone) {
          bump(`CF: channel ${matchedChannel} job ${reportJobId} — status "${rawStatus}", still processing…`);
          continue;
        }

        // Log the FULL CF report so we can see all available fields (teamId, toRootId, etc.)
        logger.info(`CF: completed report for Slack ch ${matchedChannel}: ${JSON.stringify(job)}`);

        // Capture Teams destination IDs from the CF migration report.
        // The CF report may contain the Teams team ID and channel ID under various field names.
        _captureTeamsDestination(matchedChannel, job);

        pendingChannels.delete(matchedChannel);
        bump(`CF: Channel ${matchedChannel} migration "${rawStatus}" — closing Teams channel now…`);
        try {
          const closeData = await closeCreatedTeams(reportJobId, client);
          // Also capture Teams IDs from the close response (may have different/more fields)
          _captureTeamsDestination(matchedChannel, closeData);
          bump(`CF: Teams channel ${matchedChannel} closed — calling Teams completeMigration…`);

          // Call Microsoft Teams completeMigration API to take the channel out of migration
          // mode. CF's closeCreatedTeams only tells CF's backend the job is done — it does NOT
          // call the Graph API. Without this, the channel stays in migration mode: visible via
          // API but messages are unreadable until completeMigration succeeds.
          const dstEmail = context && context.destinationEmail;
          if (dstEmail) {
            const dest = _teamsDestinations.get(matchedChannel);
            if (dest && dest.teamId) {
              try {
                const oc = getOutlookClient();
                await oc.completeMigrationForTeam(dstEmail, dest.teamId);
                if (dest.channelId) {
                  await oc.completeMigrationForChannel(dstEmail, dest.teamId, dest.channelId);
                  bump(`CF: Teams channel ${matchedChannel} completeMigration done — messages are now readable`);
                } else {
                  // No channelId stored — enumerate and complete all channels in the team.
                  // Stores the first non-General channel (or General) back so validation
                  // can find it directly via TIER-0 without a name-based search.
                  const chs = await oc.listTeamChannels(dstEmail, dest.teamId).catch(() => []);
                  for (const ch of chs) {
                    await oc.completeMigrationForChannel(dstEmail, dest.teamId, ch.id).catch(() => {});
                  }
                  const primary = chs.find((c) => c.displayName.toLowerCase() !== 'general') || chs[0];
                  if (primary) {
                    _teamsDestinations.set(matchedChannel, {
                      ...dest,
                      channelId:   primary.id,
                      channelName: primary.displayName,
                    });
                  }
                  bump(`CF: Teams channel ${matchedChannel} completeMigration done for ${chs.length} channel(s) — messages are now readable`);
                }
              } catch (completeErr) {
                bump(`CF: completeMigration for ${matchedChannel}: ${completeErr.message} — validation will retry`);
              }
            }
          }

          _notifyChannelClosed(matchedChannel);
        } catch (closeErr) {
          bump(`CF: closeCreatedTeams failed for ${matchedChannel} (job ${reportJobId}): ${closeErr.message}`);
          _notifyChannelClosed(matchedChannel);
        }
      }
    } catch (pollErr) {
      bump(`CF: poll error (round ${pollRound}): ${pollErr.message}`);
    }

    if (pendingChannels.size === 0) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (pendingChannels.size > 0) {
    bump(`CF: ${pendingChannels.size} channel(s) did not complete within ${Math.round(maxWaitMs / 60000)} min — proceeding to validation anyway`);
    for (const ch of pendingChannels) _notifyChannelClosed(ch);
  } else {
    bump(`CF: All channels closed successfully — Teams channels are ready for validation`);
  }
}

/**
 * Close completed migration jobs (teams) in CloudFuze.
 * POST /messagemove/close  (configurable via CHAT_MIGRATION_CLOSE_PATH env)
 * Body: array of job objects with { id }
 */
async function closeChatMigrationJobs(jobIds, context = {}) {
  const { auth, baseURL } = await getSession(context);
  const client = getAuthClient(auth, baseURL);
  const closePath = (env.CHAT_MIGRATION_CLOSE_PATH || 'messagemove/close')
    .trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const payload = jobIds.map((id) => {
    const num = Number(id);
    return { id: Number.isFinite(num) ? num : id };
  });
  const res = await retryWithBackoff(
    () => client.post(closePath, payload),
    { label: 'CF closeChatMigrationJobs', maxRetries: 2 }
  );
  logger.info(`CF closeChatMigrationJobs: closed ${jobIds.length} job(s) via ${closePath}`);
  return Array.isArray(res.data) ? res.data : [res.data];
}

/**
 * Add / connect a cloud account to CloudFuze via REST API.
 * Tries several candidate path patterns because the exact path differs by CF version.
 * Returns { success: true, path, data } or throws on a non-404/405 error.
 *
 * @param {{ cloudName: string, adminEmail: string, tenantId?: string, accessToken?: string, refreshToken?: string }} opts
 */
async function addCloudAccount({ cloudName, adminEmail, tenantId, accessToken, refreshToken, context = {} } = {}) {
  const { auth, userId, baseURL } = await getSession(context);
  if (!userId) throw new Error('addCloudAccount: userId required — use email/password auth');

  const client = getAuthClient(auth, baseURL);

  const payload = { cloudName, emailId: adminEmail };
  if (tenantId)     payload.tenantId     = tenantId;
  if (accessToken)  payload.accessToken  = accessToken;
  if (refreshToken) payload.refreshToken = refreshToken;

  const pathCandidates = [
    `users/${userId}/add/cloud`,
    `users/${userId}/cloud/add`,
    `users/${userId}/cloud`,
    `cloud/add`,
    `cloud`,
    `users/${userId}/clouds/add`,
    `users/${userId}/clouds`,
  ];

  let lastErr;
  for (const p of pathCandidates) {
    try {
      const res = await client.post(p, payload);
      logger.info(`CF addCloudAccount: ${cloudName}/${adminEmail} added via POST ${p}`);
      return { success: true, path: p, data: res.data };
    } catch (err) {
      const st = err.response?.status;
      // 404/405 = wrong path — keep trying; anything else is a real error
      if (st === 404 || st === 405) {
        logger.debug(`CF addCloudAccount: POST ${p} → HTTP ${st}, trying next`);
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('CF addCloudAccount: all endpoint candidates returned 404/405');
}

function clearToken() {
  sessionCache.clear();
}

module.exports = {
  login,
  validateUser,
  triggerMigration,
  triggerChatMigration,
  getCloudAccounts,
  addCloudAccount,
  getCloudChannels,
  getCloudDMs,
  getMigrationReports,
  closeChatMigrationJobs,
  uploadUserMappingCsvToAllPairs,
  clearToken,
  migrationAxiosConfig,
  waitForChannelsClosed,
  getTeamsDestination,
};
