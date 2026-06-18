const https = require('https');
const axios = require('axios');
const env = require('../config/env');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

// { auth: "Basic ..." | "Bearer ...", userId: string|null }
let cfAuth = null;

// Chat migration uses a DEDICATED CloudFuze account when configured (CHAT_MIGRATION_API_*),
// since the Slack/Teams/Google-Chat clouds typically live in a different subscriber account
// than the mail clouds. Each field falls back to the shared MIGRATION_API_* (mail) value.
const CHAT = {
  url:       env.CHAT_MIGRATION_API_URL || env.MIGRATION_API_URL,
  basicAuth: env.CHAT_MIGRATION_API_BASIC_AUTH || env.MIGRATION_API_BASIC_AUTH || '',
  key:       env.CHAT_MIGRATION_API_KEY || env.MIGRATION_API_KEY || '',
  bearer:    env.CHAT_MIGRATION_API_BEARER_TOKEN || env.MIGRATION_API_BEARER_TOKEN || '',
  username:  env.CHAT_MIGRATION_API_USERNAME || env.MIGRATION_API_USERNAME || '',
  password:  env.CHAT_MIGRATION_API_PASSWORD || env.MIGRATION_API_PASSWORD || '',
};

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

function normalizeBearerFromEnv(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, '').trim();
  return s;
}

function basicAuthPayload() {
  let raw = (CHAT.basicAuth || CHAT.key || '').trim();
  if (!raw) return '';
  if (/^basic\s+/i.test(raw)) raw = raw.replace(/^basic\s+/i, '').trim();
  return raw;
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
async function login() {
  if (cfAuth) return cfAuth;

  // 1. MIGRATION_API_BASIC_AUTH (already post-login userId:apiSecret)
  const basic = basicAuthPayload();
  if (basic) {
    let userId = null;
    try {
      const decoded = Buffer.from(basic, 'base64').toString();
      userId = decoded.split(':')[0] || null;
    } catch { /* ignore decode errors */ }
    cfAuth = { auth: `Basic ${basic}`, userId };
    logger.info('CloudFuze (chat): using CHAT/MIGRATION_API_BASIC_AUTH (skipping /auth/user)');
    return cfAuth;
  }

  // 2. Bearer token (legacy)
  const staticBearer = normalizeBearerFromEnv(CHAT.bearer);
  if (staticBearer) {
    cfAuth = { auth: `Bearer ${staticBearer}`, userId: null };
    logger.info('CloudFuze (chat): using CHAT/MIGRATION_API_BEARER_TOKEN (skipping /auth/user)');
    return cfAuth;
  }

  // 3. Full two-step login with username + password
  const username = (CHAT.username || '').trim();
  const password = (CHAT.password || '').trim();
  if (!username || !password) {
    throw new Error(
      'CloudFuze chat auth missing: set CHAT_MIGRATION_API_BASIC_AUTH / CHAT_MIGRATION_API_BEARER_TOKEN / ' +
      'CHAT_MIGRATION_API_USERNAME + CHAT_MIGRATION_API_PASSWORD (or the shared MIGRATION_API_* equivalents) ' +
      'for the CloudFuze account that has the Slack/Teams/Google-Chat clouds connected'
    );
  }

  logger.info(`CloudFuze (chat): logging in via POST /auth/user as ${username}…`);
  const loginBasic = Buffer.from(`${username}:${password}`).toString('base64');
  const res = await retryWithBackoff(
    () =>
      axios.post(
        `${CHAT.url}/auth/user`,
        null,
        migrationAxiosConfig({
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${loginBasic}`,
          },
          timeout: 30000,
        })
      ),
    { label: 'CloudFuze /auth/user login', maxRetries: 3 }
  );

  const userId = res.data?.id;
  if (!userId) throw new Error('CloudFuze login failed: no user ID in response');

  const postLoginBasic = Buffer.from(`${userId}:${password}`).toString('base64');
  cfAuth = { auth: `Basic ${postLoginBasic}`, userId };
  logger.info(`CloudFuze login successful (userId=${userId})`);
  return cfAuth;
}

/**
 * Create an axios instance with the CloudFuze auth header.
 * auth is the full Authorization value, e.g. "Basic xxx" or "Bearer xxx".
 */
function getAuthClient(auth) {
  return axios.create(
    migrationAxiosConfig({
      baseURL: CHAT.url,
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
async function validateUser(email) {
  if (!email || typeof email !== 'string') throw new Error('validateUser: email is required');

  const { auth } = await login();
  const client = getAuthClient(auth);

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
async function getCloudAccounts() {
  const { auth, userId } = await login();
  if (!userId) {
    logger.warn('CloudFuze getCloudAccounts: no userId available (Bearer token mode) — skipping cloud lookup');
    return [];
  }
  const client = getAuthClient(auth);
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
  const { auth } = await login();
  const client = getAuthClient(auth);

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
  const base = env.MIGRATION_API_URL;
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
  const { auth } = await login();
  const client = getAuthClient(auth);

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
    const accounts = await getCloudAccounts();
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

  const results = [];

  // Enrich target list with metadata from context.channelObjects / context.dmObjects
  const channelObjects = Array.isArray(context.channelObjects) ? context.channelObjects : [];
  const dmObjects      = Array.isArray(context.dmObjects)      ? context.dmObjects      : [];

  // Batch channels and DMs separately (different endpoints)
  const channels = targets
    .filter((t) => !t.isDm)
    .map((t) => {
      const enriched = channelObjects.find((c) => c.id === t.id) || {};
      return { ...t, ...enriched };
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
      const obj = {
        fromRootId: t.id,
        toRootId: '/',
        channelDate: String(t.channelDate || Math.floor(Date.now() / 1000)),
        dateChanged: false,
        channelType: toChannelType(t.kind),
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

async function getCloudChannels({ srcCloudId, dstCloudId, channelType = 'public' } = {}) {
  const { auth } = await login();
  const client = getAuthClient(auth);

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
async function getCloudDMs({ srcCloudId, dstCloudId } = {}) {
  const { auth } = await login();
  const client = getAuthClient(auth);

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
async function getMigrationReports({ combination = '', migrationStatus = 'All' } = {}) {
  const { auth } = await login();
  const client = getAuthClient(auth);
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
async function closeChatMigrationJobs(jobIds) {
  const { auth } = await login();
  const client = getAuthClient(auth);
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
async function addCloudAccount({ cloudName, adminEmail, tenantId, accessToken, refreshToken } = {}) {
  const { auth, userId } = await login();
  if (!userId) throw new Error('addCloudAccount: userId required — use MIGRATION_API_USERNAME/PASSWORD auth');

  const client = getAuthClient(auth);

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
  cfAuth = null;
}

/**
 * Pre-flight check before initiating a chat migration: confirm the source and
 * destination platforms are actually connected as clouds in this CloudFuze
 * subscriber account. Returns { ok, srcCloud, dstCloud, available, ... } so the
 * caller can fail fast with a clear message instead of hitting a raw HTTP 500.
 */
async function preflightClouds(context) {
  const srcCloudName = CF_PLATFORM[(context.sourcePlatform || '').toLowerCase()] || 'SLACK';
  const dstCloudName = CF_PLATFORM[(context.destinationPlatform || '').toLowerCase()] || 'MICROSOFT_TEAMS';

  let accounts = [];
  try {
    accounts = await getCloudAccounts();
  } catch (err) {
    return {
      ok: false,
      reason: `Could not list CloudFuze cloud accounts: ${err.message}`,
      srcCloudName, dstCloudName, srcCloud: null, dstCloud: null, available: [],
    };
  }

  const srcCloud = findCloudAccount(accounts, srcCloudName, context.sourceEmail);
  const dstCloud = findCloudAccount(accounts, dstCloudName, context.destinationEmail);
  const available = accounts.map((a) => `${a.cloudName}/${a.emailId || '?'}`);

  const missing = [];
  if (!srcCloud) missing.push(`source ${srcCloudName} (for "${context.sourceEmail}")`);
  if (!dstCloud) missing.push(`destination ${dstCloudName} (for "${context.destinationEmail}")`);

  return {
    ok: missing.length === 0,
    reason: missing.length
      ? `Not connected in CloudFuze: ${missing.join(' and ')}. `
        + `Connected clouds: ${available.length ? available.join(', ') : '(none)'}. `
        + `Connect the ${srcCloudName} and ${dstCloudName} clouds in the CloudFuze subscriber account, then retry.`
      : null,
    srcCloudName, dstCloudName, srcCloud, dstCloud, available,
  };
}

module.exports = {
  login,
  validateUser,
  triggerMigration,
  triggerChatMigration,
  preflightClouds,
  getCloudAccounts,
  addCloudAccount,
  getCloudChannels,
  getCloudDMs,
  getMigrationReports,
  closeChatMigrationJobs,
  clearToken,
  migrationAxiosConfig,
};
