const https = require('https');
const axios = require('axios');
const md5 = require('md5');
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
  const key = `${cfg.url}::${cfg.basicAuth || cfg.bearer || (cfg.username ? `${cfg.username}:${cfg.password}` : '') || 'anon'}`;
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
    logger.info(`CloudFuze: resolving session for ${cfg.username} @ ${cfg.url} (${cfg.source})…`);

    const md5Pass = md5(cfg.password);

    // Strategy 1 — GET /users/validateUser (no auth required).
    // CF exposes this endpoint without authentication; it returns the internal userId for
    // an email address.  We combine userId + md5(password) to form the Basic credential.
    // This mirrors the approach used by devemailClient.js for the devemail server.
    let userId = null;
    try {
      const valRes = await axios.get(`${cfg.url}/users/validateUser`, migrationAxiosConfig({
        params:  { searchUser: cfg.username.trim(), _: Date.now() },
        timeout: 20000,
      }));
      const data = valRes.data;
      userId = (typeof data === 'string' && data.length > 5)
        ? data.trim()
        : (data?.id || data?.userId || null);
      if (userId) logger.info(`CloudFuze: validateUser → userId=${userId} for ${cfg.username}`);
    } catch (valErr) {
      logger.warn(`CloudFuze: validateUser failed for ${cfg.username} (${valErr.response?.status || valErr.message}) — trying /auth/user next`);
    }

    if (userId) {
      const token = Buffer.from(`${userId}:${md5Pass}`).toString('base64');
      session = { auth: `Basic ${token}`, userId, baseURL: cfg.url };
      sessionCache.set(key, session);
      return session;
    }

    // Strategy 2 — POST /auth/user (some CF deployments return userId here).
    const plainB64 = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    const md5B64   = Buffer.from(`${cfg.username}:${md5Pass}`).toString('base64');

    const loginAttempts = [
      { label: 'Basic-md5',          useMd5: true,  body: null,
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${md5B64}` } },
      { label: 'JSON-email-md5',     useMd5: true,  body: { email: cfg.username, password: md5Pass },
        headers: { 'Content-Type': 'application/json' } },
      { label: 'JSON-userName-md5',  useMd5: true,  body: { userName: cfg.username, passWord: md5Pass },
        headers: { 'Content-Type': 'application/json' } },
      { label: 'Basic-plain',        useMd5: false, body: null,
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${plainB64}` } },
      { label: 'JSON-email-plain',   useMd5: false, body: { email: cfg.username, password: cfg.password },
        headers: { 'Content-Type': 'application/json' } },
      { label: 'JSON-userName-plain', useMd5: false, body: { userName: cfg.username, passWord: cfg.password },
        headers: { 'Content-Type': 'application/json' } },
    ];

    let loginData     = null;
    let winningAttempt = null;
    let lastLoginErr  = null;
    let lastLoginStatus = null;

    for (const attempt of loginAttempts) {
      try {
        const r = await axios.post(`${cfg.url}/auth/user`, attempt.body, migrationAxiosConfig({
          headers: attempt.headers,
          timeout: 30000,
        }));
        loginData      = r.data;
        winningAttempt = attempt;
        logger.info(`CloudFuze login succeeded with format '${attempt.label}' for ${cfg.username}`);
        break;
      } catch (err) {
        const st    = err.response?.status;
        const cfMsg = err.response?.data?.message || err.response?.data?.error || JSON.stringify(err.response?.data || '');
        logger.warn(`CloudFuze login '${attempt.label}' → HTTP ${st || 'no-response'}: ${cfMsg || err.message}`);
        if (err.response) { lastLoginErr = err; lastLoginStatus = st; continue; }
        throw new Error(`Cannot reach CloudFuze server at ${cfg.url}: ${err.message}`);
      }
    }

    if (!loginData) {
      // Strategy 3 — env pre-fetched token fallback.
      // Accounts that use Google / SSO have no CF API password, so all direct login
      // attempts return 401.  Fall back to the stored Basic token from env — identical
      // pattern to devemailClient.js which falls back to MIGRATION_API_BASIC_AUTH via
      // POST /mail/login when browser login is unavailable.
      const envBasicRaw = (env.CHAT_MIGRATION_API_BASIC_AUTH || env.CHAT_MIGRATION_API_KEY || '').trim();
      const envBasic    = normalizeBasic(envBasicRaw);
      if (envBasic) {
        logger.info(`CloudFuze: API login failed for ${cfg.username} — using CHAT_MIGRATION_API_BASIC_AUTH from env (same fallback as devemailClient)`);
        let envUserId = null;
        try { envUserId = Buffer.from(envBasic, 'base64').toString().split(':')[0] || null; } catch { /* ignore */ }
        session = { auth: `Basic ${envBasic}`, userId: envUserId, baseURL: cfg.url };
        sessionCache.set(key, session);
        return session;
      }
      const statusInfo = lastLoginStatus ? ` (HTTP ${lastLoginStatus})` : '';
      const cfBody     = lastLoginErr?.response?.data;
      const cfDetail   = cfBody?.message || cfBody?.error || '';
      throw new Error(
        `CloudFuze login failed for ${cfg.username}${statusInfo}.` +
        (cfDetail ? ` Server said: "${cfDetail}".` : '') +
        ` Verify the email and password are correct for ${cfg.url}.`
      );
    }

    const resolvedUserId = loginData.id || loginData.userId || loginData.user?.id || loginData.user_id || null;
    const bearerTok      = loginData.token || loginData.accessToken || loginData.jwtToken || loginData.jwt || null;
    const sessionPass    = winningAttempt?.useMd5 ? md5Pass : cfg.password;

    if (bearerTok && !resolvedUserId) {
      session = { auth: `Bearer ${bearerTok}`, userId: null, baseURL: cfg.url };
      logger.info(`CloudFuze login → Bearer token for ${cfg.username} @ ${cfg.url}`);
    } else if (resolvedUserId) {
      session = { auth: `Basic ${Buffer.from(`${resolvedUserId}:${sessionPass}`).toString('base64')}`, userId: resolvedUserId, baseURL: cfg.url };
      logger.info(`CloudFuze login OK (userId=${resolvedUserId}, format=${winningAttempt?.label}) @ ${cfg.url}`);
    } else {
      throw new Error('CloudFuze login failed: response had no user ID or token — check credentials.');
    }
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
  } catch (_) { /* will create below */ }

  // 2. Create cache if missing
  if (!cacheExists) {
    try {
      await jsonClient.post(`mapping/permissiondetiails/${srcCloudId}/${dstCloudId}`);
    } catch (_) { /* non-fatal */ }
  }

  // 3. Upload CSV — POST /messagemove/message/usermapping/csv?sourceCloudId=...&destCloudId=...
  //    multipart/form-data, field name = "file"
  const boundary = `----CloudFuzeFormBoundary${Date.now()}`;
  const CRLF = '\r\n';
  const csvBuffer = Buffer.from(rawCsvText, 'utf8');
  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="user_mapping.csv"${CRLF}Content-Type: text/csv${CRLF}${CRLF}`),
    csvBuffer,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  ]);

  try {
    const uploadRes = await jsonClient.post(
      `messagemove/message/usermapping/csv?sourceCloudId=${srcCloudId}&destCloudId=${dstCloudId}`,
      multipartBody,
      {
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': multipartBody.length,
        },
        timeout: 60000,
      }
    );
    const rowCount = rawCsvText.split('\n').filter(Boolean).length - 1;
    logger.info(`CF user mapping: ${rowCount} row(s) uploaded for ${srcCloudId}→${dstCloudId} | server: ${JSON.stringify(uploadRes.data).slice(0, 150)}`);
  } catch (err) {
    logger.warn(`CF user mapping upload failed ${srcCloudId}→${dstCloudId}: ${err.message}`);
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
  let allAccounts = [];
  try {
    allAccounts    = await getCloudAccounts(context);
    srcAcct        = findCloudAccount(allAccounts, srcCloudName, context.sourceEmail);
    const dstAcct  = findCloudAccount(allAccounts, dstCloudName, context.destinationEmail);
    srcCloudId = srcAcct?.id || null;
    dstCloudId = dstAcct?.id || null;
    if (srcCloudId) logger.info(`CloudFuze: source cloud ${srcCloudName} → id=${srcCloudId} (${srcAcct?.emailId})`);
    if (dstCloudId) logger.info(`CloudFuze: dest cloud ${dstCloudName} → id=${dstCloudId} (${dstAcct?.emailId})`);
    if (!srcCloudId) logger.warn(`CloudFuze: no cloud account found for ${srcCloudName}/${context.sourceEmail}`);
    if (!dstCloudId) logger.warn(`CloudFuze: no cloud account found for ${dstCloudName}/${context.destinationEmail}`);
  } catch (err) {
    logger.warn(`CloudFuze: getCloudAccounts failed: ${err.message} — continuing without cloud IDs`);
  }

  // Upload user mapping CSV for ONLY this src→dst pair before triggering migration.
  // (The wizard step-2 upload already covers all pairs globally; this is a targeted
  // refresh so the mapping is current even if credentials changed.)
  if (srcCloudId && dstCloudId) {
    const rawCsvText = resolveCsvFromContext(context);
    if (rawCsvText) {
      logger.info(`CF: uploading user mapping for ${srcCloudId}→${dstCloudId} before migration`);
      await setupUserMappingInCF(auth, baseURL, srcCloudId, dstCloudId, rawCsvText);
    }
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

  // Build channels enriched purely from CF metadata (cfChannelMap built above)
  const channels = targets
    .filter((t) => !t.isDm)
    .map((t) => {
      const cf = cfChannelMap[t.id] || {};
      return {
        ...t,
        channelName:     cf.channelName || t.name,
        channelDate:     cf.channelDate || t.channelDate,
        cfChannelType:   cf._cfType || cf.channelType,
        destChannelName: cf.destChannelName,
        destTeamName:    cf.destTeamName,
        workSpaceName:   cf.workSpaceName,
        cfMatched:       !!cf.channelDate,
      };
    });

  // Build DM metadata from CF cache — CF's DM object carries participant user IDs in
  // emailPairs (e.g. ["U01...", "U08..."]) which are required by the migration payload.
  let cfDmMap = {};
  if (targets.some((t) => t.isDm)) {
    try {
      const cached = channelCache.get(combination, srcCloudId, dstCloudId);
      for (const d of (cached?.dms || [])) {
        const k = d.fromRootId || d.channelId || d.id;
        if (k) cfDmMap[k] = d;
      }
      if (Object.keys(cfDmMap).length === 0 && srcCloudId && dstCloudId) {
        logger.info('CF: DM metadata not in cache — fetching from CF now');
        const dmList = await getCloudDMs({ srcCloudId, dstCloudId, context });
        for (const d of dmList) {
          const k = d.fromRootId || d.channelId || d.id;
          if (k) cfDmMap[k] = d;
        }
      }
      logger.info(`CF: DM metadata loaded (${Object.keys(cfDmMap).length} DMs available)`);
    } catch (err) {
      logger.warn(`CF: DM metadata fetch failed: ${err.message}`);
    }
  }

  const dms = targets
    .filter((t) => t.isDm)
    .map((t) => {
      const cf = cfDmMap[t.id] || {};
      // Prefer CF's channelName / emailPairs (participant user IDs) over bare ID
      return {
        ...t,
        kind:       'dm',
        channelName: cf.channelName || t.channelName || t.id,
        channelDate: cf.channelDate || t.channelDate,
        channelType: cf.channelType || 'im',
        workSpaceName: cf.workSpaceName,
        emailPairs:  cf.emailPairs || [],
      };
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
        channelType: t.cfChannelType || t.channelType || toChannelType(t.kind),
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
        // Channels: emailPairs omitted — user mapping was uploaded to CF via CSV above.
        // DMs:      emailPairs = Slack participant user IDs from CF's DM object.
        ...(isDm && Array.isArray(t.emailPairs) && t.emailPairs.length > 0
          ? { emailPairs: t.emailPairs }
          : {}),
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
async function getMigrationReports({ combination = '', migrationStatus = 'All', pageNo = 1, pageSize = 50, context = {} } = {}) {
  const { auth, baseURL } = await getSession(context);
  const client = getAuthClient(auth, baseURL);
  const params = {
    migrationStatus,
    teamStatus: 'All',
    deltaMessages: 'ALL',
    page_nbr: pageNo,
    page_size: pageSize,
  };
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

/**
 * Test CF credentials without running a full migration.
 * Attempts login + getCloudAccounts so we can verify both auth and API access.
 * Returns { ok: true, userId, accountCount } on success or throws with a user-readable message.
 */
/**
 * Fetch per-channel migration status (workspaces) for a given job.
 * GET /messagemove/list/Channelworkspaces?jobId=...&page_nbr=1&page_size=50&...
 *
 * Returns array of channel-level objects, each with processStatus (PICKING/MOVING/PROCESSED)
 * and message counts. Used to show live picking/moving status per channel in reports.
 */
async function getJobWorkspaces({ jobId, pageNo = 1, pageSize = 50, processStatus = 'all', context = {} } = {}) {
  if (!jobId) throw new Error('getJobWorkspaces: jobId is required');
  const { auth, baseURL } = await getSession(context);
  const client = getAuthClient(auth, baseURL);
  const params = {
    jobId,
    page_nbr:    pageNo,
    page_size:   pageSize,
    isAscen:     false,
    orderField:  'createdTime',
    processStatus,
    Jobtype:     'all',
  };
  const res = await retryWithBackoff(
    () => client.get('messagemove/list/Channelworkspaces', { params }),
    { label: `getJobWorkspaces jobId=${jobId}`, maxRetries: 2 }
  );
  return Array.isArray(res.data) ? res.data : [];
}

async function testCFAuth(context = {}) {
  // This will throw with a descriptive message on 401 / missing credentials / network error
  const { userId } = await getSession(context);
  let accountCount = 0;
  try {
    const accounts = await getCloudAccounts(context);
    accountCount = Array.isArray(accounts) ? accounts.length : 0;
  } catch { /* auth worked, accounts call is bonus info */ }
  return { ok: true, userId, accountCount };
}

module.exports = {
  login,
  testCFAuth,
  validateUser,
  triggerMigration,
  triggerChatMigration,
  getCloudAccounts,
  addCloudAccount,
  getCloudChannels,
  getCloudDMs,
  getMigrationReports,
  getJobWorkspaces,
  closeChatMigrationJobs,
  uploadUserMappingCsvToAllPairs,
  clearToken,
  migrationAxiosConfig,
};
