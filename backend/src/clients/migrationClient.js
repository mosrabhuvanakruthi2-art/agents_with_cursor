const https = require('https');
const axios = require('axios');
const env = require('../config/env');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

let bearerToken = null;

const migrationHttpsAgent = env.MIGRATION_API_TLS_INSECURE
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

if (migrationHttpsAgent) {
  logger.warn(
    'MIGRATION_API_TLS_INSECURE=true: TLS certificate verification is disabled for Migration API (lab / self-signed only).'
  );
}

/** Merge into axios options for all Migration API requests (self-signed HTTPS when configured). */
function migrationAxiosConfig(overrides = {}) {
  const cfg = { ...overrides };
  if (migrationHttpsAgent) cfg.httpsAgent = migrationHttpsAgent;
  return cfg;
}

/**
 * Credential for POST /mail/login (Basic).
 * Prefer MIGRATION_API_BASIC_AUTH when set — same as Email Migration UI (emailMigration.html):
 * Base64( userMongoId : apiSecret ), from DevTools → Request Headers → Authorization (paste only the part after "Basic ").
 * Otherwise MIGRATION_API_KEY: Base64( email : apiSecret ).
 */
function basicAuthPayload() {
  let raw = (env.MIGRATION_API_BASIC_AUTH || env.MIGRATION_API_KEY || '').trim();
  if (!raw) return '';
  if (/^basic\s+/i.test(raw)) {
    raw = raw.replace(/^basic\s+/i, '').trim();
  }
  return raw;
}

function normalizeBearerFromEnv(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, '').trim();
  return s;
}

/**
 * Login to CloudFuze to get a Bearer token.
 * If MIGRATION_API_BEARER_TOKEN is set (from UI DevTools), uses it and skips POST /mail/login.
 * Otherwise POST /mail/login with Basic auth.
 */
async function login() {
  if (bearerToken) return bearerToken;

  const staticBearer = normalizeBearerFromEnv(env.MIGRATION_API_BEARER_TOKEN);
  if (staticBearer) {
    bearerToken = staticBearer;
    logger.info('CloudFuze: using MIGRATION_API_BEARER_TOKEN (skipping /mail/login)');
    return bearerToken;
  }

  const basic = basicAuthPayload();
  if (!basic) {
    throw new Error(
      'CloudFuze auth missing: set MIGRATION_API_BEARER_TOKEN (Bearer from DevTools), or MIGRATION_API_BASIC_AUTH / MIGRATION_API_KEY for /mail/login'
    );
  }

  const res = await retryWithBackoff(
    () =>
      axios.post(
        `${env.MIGRATION_API_URL}/mail/login`,
        null,
        migrationAxiosConfig({
          headers: {
            Authorization: `Basic ${basic}`,
          },
          timeout: 30000,
        })
      ),
    { label: 'CloudFuze login', maxRetries: 3 }
  );

  const tokenData = res.data;
  bearerToken = typeof tokenData === 'string'
    ? tokenData.replace(/^Bearer\s*/i, '').trim()
    : tokenData;

  logger.info('CloudFuze login successful');
  return bearerToken;
}

function getAuthClient(token) {
  return axios.create(
    migrationAxiosConfig({
      baseURL: env.MIGRATION_API_URL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      timeout: 60000,
    })
  );
}

/**
 * Resolve CloudFuze subscriber profile (same contract as the web UI).
 * GET /users/validateUser?searchUser=<email>&_=<cacheBuster>
 *
 * @param {string} email - CloudFuze userName to look up
 * @returns {Promise<Object>} User JSON (id, userName, enabled, role, feature flags, …)
 */
async function validateUser(email) {
  if (!email || typeof email !== 'string') {
    throw new Error('validateUser: email is required');
  }

  const token = await login();
  const client = getAuthClient(token);

  const res = await retryWithBackoff(
    () =>
      client.get('users/validateUser', {
        params: {
          searchUser: email.trim(),
          _: Date.now(),
        },
      }),
    { label: 'CloudFuze validateUser', maxRetries: 2 }
  );

  return res.data;
}

/** Ordered POST paths (no leading slash) — some deployments use mail/initiate instead of mail/move/initiate. */
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

/**
 * Trigger migration via CloudFuze.
 * POST …/mail/move/initiate (or MIGRATION_API_INITIATE_PATH / fallbacks on 405).
 * This is fire-and-forget — CloudFuze has no status-check REST API.
 */
async function triggerMigration(context) {
  const token = await login();
  const client = getAuthClient(token);

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
        logger.warn(
          `POST ${base}/${path} → HTTP ${st}${allow ? `; Allow: ${allow}` : ''} — trying next initiate path…`
        );
        continue;
      }
      if (st === 405) {
        throw new Error(
          `${err.message || 'HTTP 405'}${allow ? ` (Allow: ${allow})` : ''}. Set MIGRATION_API_INITIATE_PATH from DevTools → Network → initiate (path under MIGRATION_API_URL, e.g. mail/initiate).`
        );
      }
      throw err;
    }
  }

  throw lastErr || new Error('Migration initiate failed: no path candidates');
}

function clearToken() {
  bearerToken = null;
}

module.exports = { login, validateUser, triggerMigration, clearToken, migrationAxiosConfig };
