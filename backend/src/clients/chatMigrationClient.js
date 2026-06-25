const https = require('https');
const axios = require('axios');
const env = require('../config/env');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');
const channelCache = require('../services/channelCache');

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
    const loginBasic = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    let res;
    try {
      res = await retryWithBackoff(
        () => axios.post(`${cfg.url}/auth/user`, null, migrationAxiosConfig({
          headers: { 'Content-Type': 'application/json', Authorization: `Basic ${loginBasic}` },
          timeout: 30000,
        })),
        { label: 'CloudFuze /auth/user login', maxRetries: 3 }
      );
    } catch (err) {
      if (err.response?.status === 401) {
        throw new Error(
          `CloudFuze rejected ${cfg.username} (401). This usually means the account signs in with Google/SSO and has `
          + `no API password. Paste the "Authorization: Basic …" token from DevTools into the API Token field instead.`
        );
      }
      throw err;
    }
    const userId = res.data?.id;
    if (!userId) throw new Error('CloudFuze login failed: no user ID in response (check the migration server email/password).');
    session = { auth: `Basic ${Buffer.from(`${userId}:${cfg.password}`).toString('base64')}`, userId, baseURL: cfg.url };
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
  //    Fresh axios instance (no Content-Type:application/json default).
  //    Part uses only Content-Disposition — no per-part Content-Type so CF's parser
  //    treats it as plain text rather than trying to validate the MIME type.
  try {
    const boundary = `CFBoundary${Date.now()}`;
    const CRLF = '\r\n';
    // Strip BOM, normalise to \r\n, then force CF-expected headers
    let cleanCsv = rawCsvText.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const csvLines = cleanCsv.split('\n');
    // Ensure CF's expected header "Source User,Destination User" is present
    if (csvLines.length > 0) {
      const firstLine = csvLines[0].trim();
      const firstLineIsData = firstLine.includes('@');  // email addresses contain @
      if (firstLineIsData) {
        // No header at all — prepend it
        csvLines.unshift('Source User,Destination User');
        logger.info(`CF CSV: prepended missing header (first line looks like data: ${firstLine.slice(0, 60)})`);
      } else if (firstLine !== 'Source User,Destination User') {
        // Has a header but wrong column names — replace it
        csvLines[0] = 'Source User,Destination User';
        logger.info(`CF CSV: normalised header "${firstLine}" → "Source User,Destination User"`);
      }
    }
    cleanCsv = csvLines.join('\n').replace(/\n/g, '\r\n');
    const csvBuffer = Buffer.from(cleanCsv, 'utf8');
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="user_mapping.csv"${CRLF}${CRLF}`),
      csvBuffer,
      Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
    ]);

    const uploadClient = axios.create(migrationAxiosConfig({ baseURL, timeout: 60000 }));
    const rowCount = cleanCsv.split('\r\n').filter(Boolean).length - 1;
    logger.info(`CF CSV preview (${srcCloudId}→${dstCloudId}): rows=${rowCount} | first200: ${cleanCsv.slice(0, 200).replace(/\r\n/g, '\\n')}`);
    const uploadRes = await uploadClient.post(
      `messagemove/message/usermapping/csv?sourceCloudId=${srcCloudId}&destCloudId=${dstCloudId}`,
      multipartBody,
      { headers: { Authorization: auth, 'Content-Type': `multipart/form-data; boundary=${boundary}` } }
    );
    logger.info(`CF user mapping upload ${srcCloudId}→${dstCloudId}: ${rowCount} row(s) | HTTP ${uploadRes.status} | server response: ${JSON.stringify(uploadRes.data)}`);

    // Verify rows were actually saved — use pageSize=200 to get real total
    try {
      const vr = await jsonClient.get(
        `mapping/user/clouds/get/permissions?sourceCloudId=${srcCloudId}&destCloudId=${dstCloudId}&pageNo=1&pageSize=200`
      );
      const d = vr.data;
      const items = Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []);
      const total = d?.totalCount ?? d?.total ?? items.length;
      logger.info(`CF mapping verified ${srcCloudId}→${dstCloudId}: total=${total} | response: ${JSON.stringify(d).slice(0, 400)}`);
    } catch (err) {
      logger.warn(`CF mapping verify error: ${err.message}`);
    }
  } catch (err) {
    logger.warn(`CF user mapping upload failed ${srcCloudId}→${dstCloudId}: HTTP ${err.response?.status} — ${err.message}`);
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
 * Called immediately when the user uploads their mapping CSV in the wizard (step 2).
 * The raw CSV is uploaded as-is — no parsing or reformatting.
 *
 * Returns the count of cloud pairs the CSV was uploaded to (0 if no accounts found).
 */
async function uploadUserMappingCsvToAllPairs(csvText) {
  if (!csvText || !csvText.trim()) {
    logger.warn('CF uploadUserMappingCsvToAllPairs: empty CSV — skipping');
    return 0;
  }
  const rowCount = csvText.split('\n').filter(Boolean).length - 1;
  if (rowCount === 0) {
    logger.warn('CF uploadUserMappingCsvToAllPairs: no data rows in CSV — skipping');
    return 0;
  }

  // Use env-based credentials (no per-request context needed)
  const { auth, baseURL } = await getSession({});
  const accounts = await getCloudAccounts({});

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
    try {
      let cached = channelCache.get(combination, srcCloudId, dstCloudId);
      if (!cached || (!(cached.publicChannels || []).length && !(cached.privateChannels || []).length)) {
        const [pub, priv] = await Promise.all([
          getCloudChannels({ srcCloudId, dstCloudId, channelType: 'public', context }),
          getCloudChannels({ srcCloudId, dstCloudId, channelType: 'private', context }),
        ]);
        cached = { publicChannels: pub, privateChannels: priv };
        channelCache.set(combination, srcCloudId, dstCloudId, cached);
      }
      for (const c of (cached.publicChannels || []))  { const k = c.fromRootId || c.channelId || c.id; if (k) cfChannelMap[k] = { ...c, _cfType: 'public' }; }
      for (const c of (cached.privateChannels || [])) { const k = c.fromRootId || c.channelId || c.id; if (k) cfChannelMap[k] = { ...c, _cfType: 'private' }; }
      logger.info(`CloudFuze: enriched channel metadata from CF list (${Object.keys(cfChannelMap).length} channels available)`);
    } catch (err) {
      logger.warn(`CloudFuze: channel metadata enrich failed: ${err.message} — falling back to Slack metadata (may migrate 0 messages)`);
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
        channelDate:     cf.channelDate || enriched.channelDate || t.channelDate,
        cfChannelType:   cf._cfType || cf.channelType,
        destChannelName: enriched.destChannelName || cf.destChannelName,
        destTeamName:    enriched.destTeamName || cf.destTeamName,
        workSpaceName:   enriched.workSpaceName || cf.workSpaceName,
        cfMatched:       !!cf.channelDate,
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
          `using channelDate=now, which usually yields "No Messages". Ensure the channel is indexed in CloudFuze.`
        );
      }
      const obj = {
        fromRootId: t.id,
        toRootId: '/',
        channelDate: String(t.channelDate || Math.floor(Date.now() / 1000)),
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
        emailPairs: t.emailPairs || [],
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
      batch.forEach((t, i) => {
        const jobId = rawData[i]?.id || rawData[i]?.jobId || res.data?.id || 'initiated';
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
  clearToken,
  migrationAxiosConfig,
};
