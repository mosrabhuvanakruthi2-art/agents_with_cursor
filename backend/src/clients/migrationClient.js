const axios = require('axios');
const env = require('../config/env');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

let bearerToken = null;

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

/**
 * Login to CloudFuze to get a Bearer token.
 * POST /mail/login with Basic auth header.
 */
async function login() {
  if (bearerToken) return bearerToken;

  const basic = basicAuthPayload();
  if (!basic) {
    throw new Error(
      'CloudFuze Basic auth missing: set MIGRATION_API_BASIC_AUTH (Email Migration UI) or MIGRATION_API_KEY in .env'
    );
  }

  const res = await retryWithBackoff(
    () =>
      axios.post(`${env.MIGRATION_API_URL}/mail/login`, null, {
        headers: {
          Authorization: `Basic ${basic}`,
        },
        timeout: 30000,
      }),
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
  return axios.create({
    baseURL: env.MIGRATION_API_URL,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    timeout: 60000,
  });
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
      client.get('/users/validateUser', {
        params: {
          searchUser: email.trim(),
          _: Date.now(),
        },
      }),
    { label: 'CloudFuze validateUser', maxRetries: 2 }
  );

  return res.data;
}

/**
 * Trigger migration via CloudFuze.
 * POST /mail/move/initiate with the CloudFuze payload format.
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

  const res = await retryWithBackoff(
    () => client.post('/mail/move/initiate', payload),
    { label: 'CloudFuze triggerMigration', maxRetries: 3 }
  );

  logger.info('Migration initiated via CloudFuze', {
    executionId: context.executionId,
    response: JSON.stringify(res.data),
  });

  return {
    jobId: res.data?.id || res.data?.[0]?.id || res.data?.jobId || 'initiated',
    status: 'INITIATED',
    rawResponse: res.data,
  };
}

function clearToken() {
  bearerToken = null;
}

module.exports = { login, validateUser, triggerMigration, clearToken };
