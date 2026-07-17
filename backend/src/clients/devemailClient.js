/**
 * devemailClient.js
 *
 * Standalone dedicated client for https://devemail.cloudfuze.com/proxyservices/v1
 *
 * Correct auth flow (from official API docs):
 *   Step 1 — POST /auth/user          (no auth)   → App JWT string
 *   Step 2 — POST /mail/register      (App JWT)   → Mail JWT string
 *   Step 3 — POST /mail/move/initiate (Mail JWT)  → starts migration
 *
 * Key design decisions:
 *   • /auth/user receives the plaintext password — the server hashes internally.
 *   • /mail/register requires App JWT, NOT Basic auth (contrary to migrationClient).
 *   • /mail/move/initiate uses Mail JWT, NOT App JWT.
 *   • /mail/clouds returns HTTP 500 (JAX-RS bug) → use /users/{id}/get/all/cloud instead.
 *   • archivedMailBox (not "archive") is the correct field name on the initiate payload.
 *
 * This file is INDEPENDENT of migrationClient.js and must NOT be merged with it.
 */

'use strict';

const https  = require('https');
const axios  = require('axios');
const md5    = require('md5');
const env    = require('../config/env');
const { retryWithBackoff } = require('../utils/retry');
const logger = require('../utils/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = 'https://devemail.cloudfuze.com/proxyservices/v1';

/** Terminal statuses returned by /mail/reports */
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

// ─── Module-level token cache ─────────────────────────────────────────────────

/** App JWT obtained from POST /auth/user */
let appJwt = null;
/** Mail JWT obtained from POST /mail/register (scoped for /mail/* and /email/* endpoints) */
let mailJwt = null;
/** userId from GET /users/validateUser — cached for the session */
let cachedUserId = null;
/** When true, appJwt came from /mail/login and IS already the Mail JWT — skip /mail/register */
let appJwtIsMailJwt = false;
/** Last observed job details (populated by pollReports) — cleared on each triggerMigration */
let lastJobDetails = { jobId: null, jobName: null, workspaceId: null, totalCount: null, processedCount: null };

/**
 * Optional runtime credentials injected by MigrationAgent from the form submission.
 * Shape: { email: string, password: string }
 * Overrides env.CLOUDFUZE_OWNER_EMAIL / env.MIGRATION_APP_LOGIN_PASSWORD when set.
 */
let runtimeConfig = null;

// ─── TLS agent ────────────────────────────────────────────────────────────────

const devemailHttpsAgent = env.MIGRATION_API_TLS_INSECURE
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

if (devemailHttpsAgent) {
  logger.warn(
    'MIGRATION_API_TLS_INSECURE=true: TLS certificate verification disabled for devemailClient (lab only).'
  );
}

function axiosCfg(overrides = {}) {
  const cfg = { ...overrides };
  if (devemailHttpsAgent) cfg.httpsAgent = devemailHttpsAgent;
  return cfg;
}

// ─── Runtime config ───────────────────────────────────────────────────────────

/**
 * Inject per-run credentials (email + password) from the agent context / form.
 * Clears all cached tokens so the next authenticate() call uses the new credentials.
 *
 * @param {{ email?: string, password?: string } | null} cfg
 */
function setRuntimeConfig(cfg) {
  runtimeConfig = cfg ? { ...cfg } : null;
  appJwt        = null;
  mailJwt       = null;
  cachedUserId  = null;
  if (cfg?.email) {
    logger.info(`devemailClient: runtime credentials set for ${cfg.email}`);
  }
}

function clearRuntimeConfig() {
  runtimeConfig  = null;
  appJwt         = null;
  mailJwt        = null;
  cachedUserId   = null;
  lastJobDetails = { jobId: null, jobName: null, workspaceId: null, totalCount: null, processedCount: null };
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

/** True when the JWT is expired (60-second safety buffer). Non-JWT tokens assumed valid. */
function isJwtExpired(token) {
  if (!token) return true;
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (!payload.exp) return false;
    return payload.exp < Math.floor(Date.now() / 1000) + 60;
  } catch {
    return false;
  }
}

/** Strip "Bearer " prefix from a raw server-returned token string. */
function stripBearer(raw) {
  return String(raw ?? '').replace(/^Bearer\s*/i, '').trim();
}

// ─── Response-body unwrap ───────────────────────────────────────────────────
// The devemail proxyservices reports endpoints DOUBLE-JSON-encode their bodies: the HTTP
// response is a JSON *string* whose content is itself a stringified JSON array, e.g.
//   "\"[{\\\"id\\\":\\\"…\\\"}]\""
// axios parses only the OUTER layer, leaving a string. A plain `Array.isArray(res.data)`
// check therefore fails and the payload looks "empty" — which is exactly why the reports
// list appeared report-blind. Unwrap by JSON.parsing until we stop getting a string.

/** Recursively JSON.parse a (possibly multiply-)stringified body. Returns the decoded value. */
function _unwrapJson(data) {
  let d = data;
  for (let i = 0; i < 4 && typeof d === 'string'; i++) {
    const s = d.trim();
    if (!s) return null;
    try { d = JSON.parse(s); } catch { return d; } // not JSON → return the string as-is
  }
  return d;
}

/** Unwrap a body and coerce it to an array (handles arrays, {content|jobs|data|details|…}). */
function _asArray(data) {
  const d = _unwrapJson(data);
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    return d.content || d.jobs || d.data || d.details || d.mailMigrationDetails || [];
  }
  return [];
}

// ─── Credential resolution ────────────────────────────────────────────────────

function resolveEmail() {
  return (runtimeConfig?.email || env.CLOUDFUZE_OWNER_EMAIL || '').trim();
}

function resolvePassword() {
  // Docs specify plaintext — the server hashes it internally.
  return (runtimeConfig?.password || env.MIGRATION_APP_LOGIN_PASSWORD || '').trim();
}

// ─── Step 1 — POST /auth/user → App JWT ──────────────────────────────────────

/**
 * Obtain an App-level JWT by posting credentials to POST /auth/user.
 * No prior authentication is required by this endpoint.
 *
 * The devemail server expects the password in plaintext (it hashes server-side).
 *
 * @param {string} email
 * @param {string} password  Plaintext password
 * @returns {Promise<string>} Raw JWT token (without "Bearer " prefix)
 */
async function getAppJwt(email, password) {
  if (!email)    throw new Error('devemailClient.getAppJwt: email is required');
  if (!password) throw new Error('devemailClient.getAppJwt: password is required');

  const md5Password = md5(password);

  // Strategy 1: for non-default users, use headless browser login to get THEIR own JWT.
  // /auth/user is broken server-side (returns 500 for all users).
  // Basic auth matches by password hash only — all users sharing the same password would get
  // the wrong account. Browser login is the only reliable way to get the correct user's JWT.
  let res;
  const isDefaultUser = email.toLowerCase() === (env.CLOUDFUZE_OWNER_EMAIL || '').toLowerCase().trim();
  if (!isDefaultUser) {
    try {
      const { getJwtViaBrowser } = require('./devemailBrowserClient');
      logger.info(`devemailClient: trying browser login for ${email}`);
      const browserJwt = await getJwtViaBrowser(email, password);
      logger.info('devemailClient: browser login succeeded — JWT captured for current user');
      // emailToken from localStorage is already Mail-scoped — use it as mailJwt directly.
      // Do NOT go through /mail/register with env Basic auth (that would give bhuvana's JWT).
      mailJwt = browserJwt;
      appJwtIsMailJwt = false;
      res = { data: browserJwt, headers: {} };
    } catch (browserErr) {
      logger.warn(`devemailClient: browser login failed (${browserErr.message}) — falling back to Basic auth`);
    }
  }

  // Strategy 2 (fallback): POST /mail/login with env Basic auth token.
  // Used for the default env user, or when browser login fails.
  if (!res) {
    const basicCred = (env.MIGRATION_API_BASIC_AUTH || '').trim();
    if (!basicCred) throw new Error('devemailClient: no auth method succeeded and MIGRATION_API_BASIC_AUTH not set');
    logger.info('devemailClient: using POST /mail/login (Basic auth)');
    try {
      res = await retryWithBackoff(
        () =>
          axios.post(
            `${BASE_URL}/mail/login`,
            null,
            axiosCfg({
              headers: { Authorization: `Basic ${basicCred}` },
              timeout: 30000,
            })
          ),
        { label: 'devemailClient POST /mail/login (Basic)', maxRetries: 2 }
      );
      logger.info('devemailClient: POST /mail/login (Basic auth) succeeded — JWT is already Mail-scoped, skipping /mail/register');
      appJwtIsMailJwt = true;
    } catch (err2) {
      throw new Error(`devemailClient: all auth methods failed. /mail/login: ${err2.message}`);
    }
  }

  const raw = res.data;
  const headerToken = stripBearer(
    res.headers?.['authorization'] ||
    res.headers?.['x-auth-token']  ||
    res.headers?.['x-access-token'] ||
    res.headers?.['token'] ||
    ''
  );
  const token =
    (typeof raw === 'string' ? stripBearer(raw) : '') ||
    raw?.token || raw?.accessToken || raw?.jwtToken ||
    raw?.data?.token || raw?.result?.token || raw?.userVO?.token ||
    headerToken || '';

  if (!token) {
    throw new Error(`devemailClient: no token in auth response — body: ${JSON.stringify(raw)}`);
  }

  logger.info('devemailClient: JWT obtained successfully');
  return token;
}

// ─── Step 2 — GET /users/validateUser → userId ───────────────────────────────

/**
 * Look up a CloudFuze platform user by email address (no auth required).
 *
 * @param {string} email
 * @returns {Promise<{ id: string, userName: string, role: string }>}
 */
async function validateUser(email) {
  if (!email || typeof email !== 'string') {
    throw new Error('devemailClient.validateUser: email is required');
  }

  logger.info(`devemailClient: GET /users/validateUser?searchUser=${email}`);

  const res = await retryWithBackoff(
    () =>
      axios.get(
        `${BASE_URL}/users/validateUser`,
        axiosCfg({
          params:  { searchUser: email.trim(), _: Date.now() },
          timeout: 30000,
        })
      ),
    { label: 'devemailClient validateUser', maxRetries: 2 }
  );

  const data = res.data;

  // Server may return the userId as a plain string (e.g. "68e79cb0a78a857d7cc6335d")
  // or as an object { id, userName, role }
  if (typeof data === 'string' && data.length > 0) {
    logger.info(`devemailClient: validateUser returned plain userId string: ${data}`);
    return { id: data, userName: email };
  }

  if (!data || (!data.id && !data.userId)) {
    throw new Error(
      `devemailClient validateUser: unexpected response for ${email} — ${JSON.stringify(data)}`
    );
  }

  // Normalise: some builds return the id in data.userId
  if (!data.id && data.userId) data.id = data.userId;
  return data;
}

// ─── Step 3 — POST /mail/register → Mail JWT ─────────────────────────────────

/**
 * Obtain a Mail-scoped JWT by calling POST /mail/register with the App JWT.
 *
 * The docs explicitly require the App JWT in the Authorization header here —
 * Basic auth (as used by the old migrationClient code path) is incorrect.
 *
 * @param {string} currentAppJwt  Raw App JWT (no "Bearer " prefix)
 * @param {string} cloudName      e.g. "OUTLOOK" or "GMAIL"
 * @param {string} email          The cloud account email address
 * @param {string} userId         CloudFuze userId from validateUser()
 * @returns {Promise<string>} Raw Mail JWT token (without "Bearer " prefix)
 */
async function getMailJwt(currentAppJwt, cloudName, email, userId) {
  if (!currentAppJwt) throw new Error('devemailClient.getMailJwt: appJwt is required');
  if (!cloudName)     throw new Error('devemailClient.getMailJwt: cloudName is required');
  if (!email)         throw new Error('devemailClient.getMailJwt: email is required');
  if (!userId)        throw new Error('devemailClient.getMailJwt: userId is required');

  logger.info(`devemailClient: POST /mail/register (cloudName=${cloudName}, email=${email}, userId=${userId})`);

  const res = await retryWithBackoff(
    () =>
      axios.post(
        `${BASE_URL}/mail/register`,
        { cloudName, email, userId },
        axiosCfg({
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${currentAppJwt}`,
          },
          timeout: 30000,
        })
      ),
    { label: 'devemailClient POST /mail/register', maxRetries: 3 }
  );

  const raw = res.data;
  const headerToken = stripBearer(
    res.headers?.['authorization'] ||
    res.headers?.['x-auth-token']  ||
    res.headers?.['token'] ||
    ''
  );
  const token =
    (typeof raw === 'string' ? stripBearer(raw) : '') ||
    raw?.token || raw?.accessToken || raw?.jwtToken ||
    raw?.data?.token || raw?.result?.token ||
    headerToken || '';

  if (!token) {
    throw new Error(
      `devemailClient POST /mail/register: no token in response — body: ${JSON.stringify(raw)}`
    );
  }

  logger.info('devemailClient: Mail JWT obtained via POST /mail/register');
  return token;
}

// ─── Main authenticate() ──────────────────────────────────────────────────────

/**
 * Full three-step auth flow: validateUser → getAppJwt → getMailJwt.
 *
 * Cached tokens are reused when still valid; only expired tokens trigger a refresh.
 * Call this before any endpoint that requires a Mail JWT.
 *
 * @param {string} [emailOverride]
 * @param {string} [passwordOverride]
 * @returns {Promise<{ appJwt: string, mailJwt: string, userId: string }>}
 */
async function authenticate(emailOverride, passwordOverride) {
  const email    = emailOverride    || resolveEmail();
  const password = passwordOverride || resolvePassword();

  if (!email) {
    throw new Error(
      'devemailClient: email is required (set CLOUDFUZE_OWNER_EMAIL or pass via form)'
    );
  }
  if (!password) {
    throw new Error(
      'devemailClient: password is required (set MIGRATION_APP_LOGIN_PASSWORD or pass via form)'
    );
  }

  // ── userId ────────────────────────────────────────────────────────────────
  if (!cachedUserId) {
    const userInfo = await validateUser(email);
    cachedUserId   = String(userInfo.id);
    logger.info(`devemailClient: userId → ${cachedUserId}`);
  }

  // ── App JWT ───────────────────────────────────────────────────────────────
  if (!appJwt || isJwtExpired(appJwt)) {
    appJwt = await getAppJwt(email, password);
  } else {
    logger.info('devemailClient: reusing cached App JWT');
  }

  // ── Mail JWT ──────────────────────────────────────────────────────────────
  if (appJwtIsMailJwt) {
    // appJwt came from POST /mail/login (Basic auth).
    // On devemail, POST /mail/register also accepts Basic auth and returns a
    // broader-scoped Bearer token that works for /email/* endpoints like getDomains.
    if (!mailJwt || isJwtExpired(mailJwt)) {
      const basicCred = (env.MIGRATION_API_BASIC_AUTH || '').trim();
      if (basicCred) {
        try {
          const regRes = await retryWithBackoff(
            () =>
              axios.post(
                `${BASE_URL}/mail/register`,
                null,
                axiosCfg({
                  headers: { Authorization: `Basic ${basicCred}` },
                  timeout: 30000,
                })
              ),
            { label: 'devemailClient POST /mail/register (Basic auth)', maxRetries: 1 }
          );
          const raw = regRes.data;
          const headerToken = stripBearer(
            regRes.headers?.['authorization'] ||
            regRes.headers?.['x-auth-token']  ||
            regRes.headers?.['token'] || ''
          );
          const registerJwt =
            (typeof raw === 'string' ? stripBearer(raw) : '') ||
            raw?.token || raw?.accessToken || raw?.jwtToken ||
            raw?.data?.token || raw?.result?.token ||
            headerToken || '';
          if (registerJwt) {
            mailJwt = registerJwt;
            logger.info('devemailClient: /mail/register (Basic auth) succeeded — using broader-scope Mail JWT');
          } else {
            mailJwt = appJwt;
            logger.warn('devemailClient: /mail/register (Basic auth) returned no token — falling back to /mail/login JWT');
          }
        } catch (err) {
          mailJwt = appJwt;
          logger.warn(`devemailClient: /mail/register (Basic auth) failed (${err.message}) — falling back to /mail/login JWT`);
        }
      } else {
        mailJwt = appJwt;
      }
    } else {
      logger.info('devemailClient: reusing cached Mail JWT');
    }
  } else if (!mailJwt || isJwtExpired(mailJwt)) {
    mailJwt = await getMailJwt(appJwt, 'OUTLOOK', email, cachedUserId);
  } else {
    logger.info('devemailClient: reusing cached Mail JWT');
  }

  return { appJwt, mailJwt, userId: cachedUserId };
}

// ─── isAuthenticated ─────────────────────────────────────────────────────────

/** True when both JWTs are present and not expired. */
function isAuthenticated() {
  return Boolean(appJwt && !isJwtExpired(appJwt) && mailJwt && !isJwtExpired(mailJwt));
}

// ─── getClouds — GET /users/{userId}/get/all/cloud ────────────────────────────

/**
 * List all cloud accounts registered to this CloudFuze user.
 *
 * NOTE: GET /mail/clouds returns HTTP 500 on devemail due to a known JAX-RS bug.
 * This endpoint (/users/{id}/get/all/cloud) is used instead and requires the App JWT.
 *
 * @returns {Promise<Array>} Array of cloud account objects
 */
/**
 * Fetch all cloud accounts for the current user.
 *
 * Tries endpoints in order:
 *   1. GET /mail/clouds           (Basic auth) — preferred, uses adminCloudId as the migration ID
 *   2. GET /users/{id}/get/all/cloud (Basic auth) — fallback
 */
async function getClouds() {
  const { userId, mailJwt: jwt } = await authenticate();
  const basicHeader = `Basic ${(env.MIGRATION_API_BASIC_AUTH || '').trim()}`;

  // ── Strategy 1: GET /mail/clouds (Mail JWT — same token the browser uses) ────
  logger.info('devemailClient: GET /mail/clouds');
  const mailCloudsHeaders = [
    { label: 'Mail JWT', header: `Bearer ${jwt}` },
    { label: 'Basic auth', header: basicHeader },
  ];
  for (const { label, header } of mailCloudsHeaders) {
    try {
      const res = await retryWithBackoff(
        () =>
          axios.get(
            `${BASE_URL}/mail/clouds`,
            axiosCfg({
              headers: { Authorization: header },
              params:  { _: Date.now() },
              timeout: 30000,
            })
          ),
        { label: `devemailClient getClouds /mail/clouds (${label})`, maxRetries: 1 }
      );
      logger.info(`devemailClient getClouds /mail/clouds (${label}) raw response: ${JSON.stringify(res.data).substring(0, 500)}`);
      let parsed = res.data;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { parsed = []; }
      }
      const clouds = Array.isArray(parsed)
        ? parsed
        : (parsed?.clouds || parsed?.data || parsed?.content || parsed?.cloudList || []);
      if (clouds.length > 0) {
        logger.info(`devemailClient getClouds: ${clouds.length} cloud(s) via /mail/clouds (${label})`);
        clouds.forEach((c, i) => logger.info(`  cloud[${i}]: ${JSON.stringify(c)}`));
        return clouds;
      }
      logger.warn(`devemailClient getClouds /mail/clouds (${label}): 200 OK but 0 clouds — trying next`);
    } catch (err) {
      logger.warn(`devemailClient getClouds /mail/clouds (${label}) failed (${err.response?.status || err.message}) — trying next`);
    }
  }

  // ── Strategy 2: GET /users/{userId}/get/all/cloud ─────────────
  logger.info(`devemailClient: GET /users/${userId}/get/all/cloud`);
  try {
    const res = await retryWithBackoff(
      () =>
        axios.get(
          `${BASE_URL}/users/${userId}/get/all/cloud`,
          axiosCfg({
            headers: { Authorization: basicHeader },
            params:  { _: Date.now() },
            timeout: 30000,
          })
        ),
      { label: 'devemailClient getClouds (/users/get/all/cloud)', maxRetries: 1 }
    );
    const clouds = Array.isArray(res.data)
      ? res.data
      : (res.data?.clouds || res.data?.data || []);
    if (clouds.length > 0) {
      logger.info(`devemailClient getClouds: ${clouds.length} cloud(s) via /users/get/all/cloud`);
      clouds.forEach((c, i) => logger.info(`  cloud[${i}]: ${JSON.stringify(c)}`));
      return clouds;
    }
    logger.warn('devemailClient getClouds /users/get/all/cloud: 200 OK but 0 clouds');
  } catch (err) {
    logger.warn(`devemailClient getClouds /users/get/all/cloud failed (${err.response?.status || err.message})`);
  }

  throw new Error('devemailClient getClouds: all endpoints failed.');
}

// ─── findCloudId ─────────────────────────────────────────────────────────────

/**
 * Find the cloud record for a given email from a clouds list.
 *
 * Priority: 1. exact email match  2. domain match
 *
 * @param {Array}  clouds  From getClouds()
 * @param {string} email
 * @returns {{ id: string, cloudName: string, memberId?: string } | null}
 */
function findCloudId(clouds, email) {
  const norm = String(email || '').toLowerCase().trim();
  // Use adminCloudId when present — that is the admin-level ID used by migration endpoints
  const extractId = (c) => c.adminCloudId || c.id || c.vendorId || c.cloudId;
  const domain = norm.includes('@') ? norm.split('@')[1] : norm;

  // Helper: all email-like strings on a cloud object
  const cloudEmails = (c) => [
    c.adminEmailId, c.email, c.emailId,          // direct email fields
    c.domainName,                                  // domain field
    ...(Array.isArray(c.domainList) ? c.domainList : []),  // domainList array
    c.cloudUserId ? c.cloudUserId.split('|').pop() : null, // "OUTLOOK|email" format
  ].filter(Boolean).map((v) => String(v).toLowerCase());

  // 1. Exact email match against all known fields
  const exact = clouds.find((c) => cloudEmails(c).includes(norm));
  if (exact) return { id: extractId(exact), cloudName: exact.cloudName, memberId: exact.memberId };

  // 2. Domain match — check if any field contains the lookup domain
  if (domain) {
    const hit = clouds.find((c) =>
      cloudEmails(c).some((v) => v === domain || v.endsWith('@' + domain))
    );
    if (hit) return { id: extractId(hit), cloudName: hit.cloudName, memberId: hit.memberId };
  }

  return null;
}

// ─── getDomains — GET /email/move/domains/{cloudId} ──────────────────────────

/**
 * Fetch available destination domains for a destination cloud ID.
 * Tries Mail JWT first, falls back to Basic auth (devemail /mail/login JWT may be wrong scope).
 *
 * @param {string} destCloudId
 * @returns {Promise<any>}
 */
async function getDomains(destCloudId) {
  if (!destCloudId) throw new Error('devemailClient.getDomains: destCloudId is required');

  const { mailJwt } = await authenticate();

  logger.info(`devemailClient: GET /email/move/domains/${destCloudId} (Mail JWT)`);

  const res = await retryWithBackoff(
    () =>
      axios.get(
        `${BASE_URL}/email/move/domains/${destCloudId}`,
        axiosCfg({
          headers: { Authorization: `Bearer ${mailJwt}` },
          params:  { _: Date.now() },
          timeout: 30000,
        })
      ),
    { label: 'devemailClient getDomains', maxRetries: 2 }
  );
  return res.data;
}

// ─── getUserMapping — GET /mail/users/mapping/{srcId}/{dstId} ────────────────

/**
 * Fetch user mappings for the given source/destination cloud pair.
 * Requires Mail JWT.
 *
 * @param {string} srcCloudId
 * @param {string} dstCloudId
 * @returns {Promise<any>}
 */
async function getUserMapping(srcCloudId, dstCloudId) {
  if (!srcCloudId || !dstCloudId) {
    throw new Error('devemailClient.getUserMapping: srcCloudId and dstCloudId are required');
  }

  const { mailJwt: jwt } = await authenticate();

  logger.info(`devemailClient: GET /mail/users/mapping/${srcCloudId}/${dstCloudId}`);

  const res = await retryWithBackoff(
    () =>
      axios.get(
        `${BASE_URL}/mail/users/mapping/${srcCloudId}/${dstCloudId}`,
        axiosCfg({
          headers: { Authorization: `Bearer ${jwt}` },
          params:  { _: Date.now() },
          timeout: 30000,
        })
      ),
    { label: 'devemailClient getUserMapping', maxRetries: 2 }
  );

  return res.data;
}

// ─── getCachedMailboxMetadata — GET /mail/cache/{srcId}/{dstId} ───────────────

/**
 * Fetch cached mailbox metadata for a source/destination cloud pair.
 * Requires Mail JWT.
 *
 * @param {string} srcCloudId
 * @param {string} dstCloudId
 * @param {{ pageNo?: number, pageSize?: number }} [opts]
 * @returns {Promise<any>}
 */
async function getCachedMailboxMetadata(
  srcCloudId,
  dstCloudId,
  { pageNo = 0, pageSize = 20 } = {}
) {
  if (!srcCloudId || !dstCloudId) {
    throw new Error(
      'devemailClient.getCachedMailboxMetadata: srcCloudId and dstCloudId are required'
    );
  }

  const { mailJwt: jwt } = await authenticate();

  logger.info(`devemailClient: GET /mail/cache/${srcCloudId}/${dstCloudId}`);

  const res = await retryWithBackoff(
    () =>
      axios.get(
        `${BASE_URL}/mail/cache/${srcCloudId}/${dstCloudId}`,
        axiosCfg({
          headers: { Authorization: `Bearer ${jwt}` },
          params:  { pageNo, pageSize, _: Date.now() },
          timeout: 30000,
        })
      ),
    { label: 'devemailClient getCachedMailboxMetadata', maxRetries: 2 }
  );

  return res.data;
}

// ─── uploadUserCSV — POST /email/user/csv/{srcId}/{dstId} ────────────────────

/**
 * Upload a user mapping CSV to the migration server.
 * Requires Mail JWT.
 *
 * @param {string} sourceCloudId
 * @param {string} destCloudId
 * @param {Array<{ sourceEmail: string, destinationEmail: string }>} pairs
 * @returns {Promise<any>}
 */
async function uploadUserCSV(sourceCloudId, destCloudId, pairs) {
  if (!sourceCloudId || !destCloudId) {
    throw new Error('devemailClient.uploadUserCSV: sourceCloudId and destCloudId are required');
  }
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error(
      'devemailClient.uploadUserCSV: pairs must be a non-empty array of { sourceEmail, destinationEmail }'
    );
  }

  const { mailJwt: jwt } = await authenticate();

  const csvLines = ['Source Email Address,Destination Email Address'];
  for (const p of pairs) csvLines.push(`${p.sourceEmail},${p.destinationEmail}`);
  const csvContent = csvLines.join('\r\n');

  logger.info(
    `devemailClient: POST /email/user/csv/${sourceCloudId}/${destCloudId}\n${csvContent}`
  );

  const res = await retryWithBackoff(
    () =>
      axios.post(
        `${BASE_URL}/email/user/csv/${sourceCloudId}/${destCloudId}`,
        csvContent,
        axiosCfg({
          headers: {
            Authorization:  `Bearer ${jwt}`,
            'Content-Type': 'text/csv',
          },
          timeout: 30000,
        })
      ),
    { label: 'devemailClient uploadUserCSV', maxRetries: 2 }
  );
  return res.data;
}

// ─── cacheUserMapping — GET /mail/cache/{srcId}/{dstId} ──────────────────────

/**
 * Confirm/cache the user mapping selection on legacy servers (devemail uses /mail/cache).
 * Tries Mail JWT first, falls back to Basic auth.
 *
 * @param {string} srcCloudId
 * @param {string} dstCloudId
 * @returns {Promise<any>}
 */
async function cacheUserMapping(srcCloudId, dstCloudId) {
  if (!srcCloudId || !dstCloudId) {
    throw new Error('devemailClient.cacheUserMapping: srcCloudId and dstCloudId are required');
  }

  const { mailJwt: jwt } = await authenticate();

  logger.info(`devemailClient: GET /mail/cache/${srcCloudId}/${dstCloudId}`);

  const res = await retryWithBackoff(
    () =>
      axios.get(
        `${BASE_URL}/mail/cache/${srcCloudId}/${dstCloudId}`,
        axiosCfg({
          headers: { Authorization: `Bearer ${jwt}` },
          params:  { pageNo: 0, pageSize: 20, _: Date.now() },
          timeout: 30000,
        })
      ),
    { label: 'devemailClient cacheUserMapping', maxRetries: 2 }
  );
  return res.data;
}

// ─── getPermissionMapping — GET /email/user/cache/{srcId}/{dstId} ────────────

/**
 * Read back the stored permission mapping after CSV upload.
 * Returns [{sourceEmail, destinationEmail}] or [] on failure.
 * Tries Mail JWT first, falls back to Basic auth.
 *
 * @param {string} srcCloudId
 * @param {string} dstCloudId
 * @param {{ pageSize?: number }} [opts]
 * @returns {Promise<Array<{sourceEmail: string, destinationEmail: string}>>}
 */
async function getPermissionMapping(srcCloudId, dstCloudId, { pageSize = 500 } = {}) {
  if (!srcCloudId || !dstCloudId) {
    throw new Error('devemailClient.getPermissionMapping: srcCloudId and dstCloudId are required');
  }

  const { mailJwt: jwt } = await authenticate();

  logger.info(`devemailClient: GET /email/user/cache/${srcCloudId}/${dstCloudId}`);

  try {
    const res = await axios.get(
      `${BASE_URL}/email/user/cache/${srcCloudId}/${dstCloudId}`,
      axiosCfg({
        headers: { Authorization: `Bearer ${jwt}` },
        params:  { pageNo: 0, pageSize, _: Date.now() },
        timeout: 30000,
      })
    );
    const items = Array.isArray(res.data) ? res.data : (res.data?.content || []);
    return items
      .map((item) => ({
        sourceEmail:      String(item.sourceEmail      || item.fromMailId || item.fromEmail || item.source      || '').trim().toLowerCase(),
        destinationEmail: String(item.destinationEmail || item.toMailId   || item.toEmail   || item.destination || '').trim().toLowerCase(),
      }))
      .filter((p) => p.sourceEmail && p.destinationEmail);
  } catch (err) {
    logger.warn(`devemailClient getPermissionMapping failed (${err.response?.status || err.message}) — skipping`);
    return [];
  }
}

// ─── triggerMigration — POST /mail/move/initiate ─────────────────────────────

/**
 * Initiate a migration job on the devemail server.
 * Requires Mail JWT (NOT App JWT — a common source of confusion).
 *
 * @param {object} context
 * @param {string}  context.sourceEmail        Source mailbox address
 * @param {string}  context.destinationEmail   Destination mailbox address
 * @param {string}  [context.sourceCloudName]  Default "GMAIL"
 * @param {string}  [context.destCloudName]    Default "OUTLOOK"
 * @param {string}  [context.sourceProvider]   "microsoft" → archivedMailBox=true
 * @param {string}  [context.migrationType]    "DELTA" for delta migration
 * @param {boolean} [context.includeCalendar]
 * @param {boolean} [context.includeContacts]
 * @param {string}  [context.executionId]      For logging / cancellation
 * @returns {Promise<{ jobId: string, status: 'INITIATED', rawResponse: any }>}
 */
async function triggerMigration(context) {
  const { mailJwt: jwt } = await authenticate();
  const ownerEmailId = resolveEmail() || context.sourceEmail;

  // Reset job details so getLastJobDetails() reflects this run only
  lastJobDetails = { jobId: null, jobName: null, workspaceId: null, totalCount: null, processedCount: null };

  const fromCloud = (context.sourceCloudName || 'GMAIL').toUpperCase();
  const toCloud   = (context.destCloudName   || 'OUTLOOK').toUpperCase();

  // Build jobName in the format the server expects: OneTime-FROM-TO-YYYYMMDD-HHMMSS
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const jobName  = `OneTime-${fromCloud}-${toCloud}-${datePart}-${timePart}`;

  // Build one workspace entry per mapped pair so all users land in one job.
  // Falls back to the single context.sourceEmail/destinationEmail for single-user runs.
  const pairsToMigrate = (Array.isArray(context.userEmailMappings) && context.userEmailMappings.length > 0)
    ? context.userEmailMappings
    : [{ sourceEmail: context.sourceEmail, destinationEmail: context.destinationEmail }];

  const payload = pairsToMigrate.map((pair) => ({
    fromCloudName:   fromCloud,
    toCloudName:     toCloud,
    fromMailId:      pair.sourceEmail || context.sourceEmail,
    toMailId:        pair.destinationEmail || context.destinationEmail,
    ownerEmailId,
    fromRootId:      '/',
    toRootId:        '/',
    deltaMigration:  context.migrationType === 'DELTA',
    jobName,
    onlineMove:      false,
    contacts:        Boolean(context.includeContacts),
    drawings:        false,
    backup:          true,
    orphanWorkSpace: Boolean(context.migrateOrphanedLabels),
    archivedMailBox: false,
    teamFolder:      false,
    cronExpression:  '1H0M',
    disableGroups:   false,
    processedCount:  null,
    inProgressCount: null,
  }));

  logger.info(`devemailClient triggerMigration payload: ${JSON.stringify(payload)}`);

  // Also check env path override for cases where the server uses a different path segment
  const pathCandidates = ['mail/move/initiate'];
  const envPath = (env.MIGRATION_API_INITIATE_PATH || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (envPath && !pathCandidates.includes(envPath)) {
    pathCandidates.push(envPath);
  }

  let lastErr;
  for (let i = 0; i < pathCandidates.length; i++) {
    const path = pathCandidates[i];
    try {
      const res = await retryWithBackoff(
        () =>
          axios.post(
            `${BASE_URL}/${path}`,
            payload,
            axiosCfg({
              headers: {
                Authorization:  `Bearer ${jwt}`,
                'Content-Type': 'application/json',
              },
              timeout: 60000,
            })
          ),
        { label: `devemailClient POST ${path}`, maxRetries: 1 }
      );

      logger.info('devemailClient migration initiated', {
        executionId: context.executionId,
        path,
        response: JSON.stringify(res.data),
      });

      return {
        jobId:       res.data?.id || res.data?.[0]?.id || res.data?.jobId || 'initiated',
        jobName,
        status:      'INITIATED',
        rawResponse: res.data,
        initiatePath: path,
      };
    } catch (err) {
      lastErr     = err;
      const st    = err.response?.status;
      const allow = err.response?.headers?.allow || err.response?.headers?.Allow;
      const errBody = err.response?.data ? JSON.stringify(err.response.data) : '(no body)';
      logger.error(`devemailClient POST ${BASE_URL}/${path} HTTP ${st} — ${errBody}`);
      if ((st === 405 || st === 404) && i < pathCandidates.length - 1) {
        logger.warn(
          `devemailClient POST ${path} → HTTP ${st}${allow ? `; Allow: ${allow}` : ''} — trying next path`
        );
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error('devemailClient: migration initiate failed — no path candidates succeeded');
}

// ─── pollReports — GET /mail/reports ─────────────────────────────────────────

/**
 * Poll GET /mail/reports until a terminal status is reached or max time expires.
 * Uses the Mail JWT.
 *
 * @param {string}   fromMailId              Source mailbox email to match in the jobs list
 * @param {number}   [maxMinutes=30]         Maximum polling duration in minutes
 * @param {number}   [intervalMs=60000]      Interval between polls in milliseconds
 * @param {Function} [onProgress]            Callback(attempt, maxPolls, status) → void
 * @param {string}   [executionId]           Used to check for cancellation via executionService
 * @returns {Promise<string>} Terminal status, 'TIMEOUT', 'CANCELLED', or null (fallback)
 */
async function pollReports(fromMailId, maxMinutes = 30, intervalMs = 30000, onProgress, executionId) {
  // Ensure tokens are valid before entering the loop
  const { mailJwt: initialJwt } = await authenticate();
  let   activeJwt = initialJwt;

  const maxPolls    = Math.ceil((maxMinutes * 60 * 1000) / intervalMs);
  const normFrom    = String(fromMailId || '').toLowerCase().trim();
  const execService = require('../services/executionService');
  // /mail/reports only shows COMPLETED jobs; /email/user/jobs may return them earlier.
  // We try /mail/reports first; if it returns 0 jobs once, we permanently switch to /email/user/jobs.
  // MAX_NO_MATCH = maxPolls means we never give up the full window just due to no-match streak.
  const MAX_NO_MATCH = maxPolls;
  let noMatchStreak  = 0;
  let consecutiveAuthErrors = 0;

  const reportsUrlCandidates = [`${BASE_URL}/mail/reports`, `${BASE_URL}/email/user/jobs`];
  let reportsUrl = reportsUrlCandidates[0];
  let reportsUrlFallbackIdx = 1;

  logger.info(
    `devemailClient pollReports: watching ${fromMailId}, max ${maxMinutes} min (${maxPolls} polls)`
  );

  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    // Chunked sleep for responsive cancellation
    const sliceMs = 5000;
    const slices  = Math.ceil(intervalMs / sliceMs);
    for (let s = 0; s < slices; s++) {
      await new Promise((r) => setTimeout(r, sliceMs));
      if (executionId && execService.isCancelled(executionId)) return 'CANCELLED';
    }
    if (executionId && execService.isCancelled(executionId)) return 'CANCELLED';

    // Proactively refresh Mail JWT if it has expired mid-run
    if (isJwtExpired(activeJwt)) {
      try {
        mailJwt   = null; // force re-fetch
        const res = await authenticate();
        activeJwt = res.mailJwt;
        logger.info('devemailClient pollReports: refreshed expired Mail JWT');
      } catch (e) {
        logger.warn(`devemailClient pollReports: JWT refresh failed — ${e.message}`);
      }
    }

    try {
      const res = await axios.get(
        reportsUrl,
        axiosCfg({
          headers: { Authorization: `Bearer ${activeJwt}` },
          params:  { pageNo: 0, pageSize: 50, _: Date.now() },
          timeout: 30000,
        })
      );

      consecutiveAuthErrors = 0;
      const jobs = _asArray(res.data);

      let matchedJob    = null;
      let matchedDetail = null;

      for (const j of jobs) {
        const details = j.mailMigrationDetails || j.details || j.pairs || [];

        // Per-user detail row carries accurate email counts — prefer over job-level counts
        if (Array.isArray(details) && details.length > 0) {
          const d = details.find(
            (d) => String(d.fromMailId || d.fromEmail || '').toLowerCase() === normFrom
          );
          if (d) {
            matchedJob    = j;
            matchedDetail = d;
            break;
          }
        }

        // Legacy fallback: fromMailId at job level with no nested details
        if (String(j.fromMailId || j.fromEmail || '').toLowerCase() === normFrom) {
          matchedJob = j;
          break;
        }
      }

      if (!matchedJob) {
        // If current URL returned 0 jobs and a fallback exists, switch once immediately
        if (jobs.length === 0 && reportsUrlFallbackIdx < reportsUrlCandidates.length) {
          const nextUrl = reportsUrlCandidates[reportsUrlFallbackIdx++];
          logger.info(`devemailClient reports poll ${attempt}: 0 jobs from ${reportsUrl} — switching to ${nextUrl}`);
          reportsUrl = nextUrl;
          continue;
        }
        noMatchStreak++;
        if (attempt === 1 && jobs.length > 0) {
          logger.info(`devemailClient reports sample job keys: ${Object.keys(jobs[0]).join(', ')}`);
        }
        logger.info(
          `devemailClient pollReports ${attempt}/${maxPolls} [${reportsUrl.split('/').pop()}]: job for ${fromMailId} not found ` +
          `(${jobs.length} job(s), no-match streak ${noMatchStreak}/${MAX_NO_MATCH})`
        );
        if (noMatchStreak >= MAX_NO_MATCH) {
          logger.warn(
            `devemailClient pollReports: ${noMatchStreak} consecutive no-match polls for ` +
            `${fromMailId} — returning TIMEOUT`
          );
          return 'TIMEOUT';
        }
        if (onProgress) onProgress(attempt, maxPolls, null);
        continue;
      }
      noMatchStreak = 0;

      const status = String(
        matchedDetail?.syncStatus    || matchedDetail?.status          ||
        matchedDetail?.processStatus || matchedDetail?.migrationStatus ||
        matchedJob.syncStatus        || matchedJob.status              ||
        matchedJob.processStatus     || matchedJob.migrationStatus     || ''
      ).toUpperCase().trim();

      const totalCount     = Number(matchedDetail?.totalCount     || matchedJob.totalCount     || 0);
      const processedCount = Number(matchedDetail?.processedCount || matchedJob.processedCount || 0);
      const countsDone     = totalCount > 0 && processedCount >= totalCount;

      // Keep module-level lastJobDetails current for getLastJobDetails() / fetchCurrentJobStatus()
      // jobId = parent migration job (shared across pairs); workspaceId = this pair's sub-task.
      lastJobDetails = {
        jobId:          matchedJob.id || matchedJob.jobId || null,
        jobName:        matchedJob.jobName || matchedJob.name || null,
        workspaceId:    matchedDetail?.id || matchedDetail?.workspaceId || matchedJob.workspaceId || matchedJob.id || matchedJob.jobId || null,
        totalCount:     totalCount     || null,
        processedCount: processedCount || null,
      };

      if (!status && attempt === 1) {
        logger.info(`devemailClient reports job keys: ${Object.keys(matchedJob).join(', ')}`);
        if (matchedDetail) {
          logger.info(`devemailClient reports detail keys: ${Object.keys(matchedDetail).join(', ')}`);
        }
      }

      logger.info(
        `devemailClient pollReports ${attempt}/${maxPolls}: ${fromMailId} → ` +
        `status="${status}" counts=${processedCount}/${totalCount}`
      );

      if (onProgress) onProgress(attempt, maxPolls, status || (countsDone ? 'PROCESSED' : null));

      if (TERMINAL_STATUSES.has(status)) return status;

      if (countsDone) {
        logger.info(
          `devemailClient pollReports: processedCount (${processedCount}) === totalCount ` +
          `(${totalCount}) — treating as PROCESSED`
        );
        return 'PROCESSED';
      }
    } catch (err) {
      const httpStatus = err?.response?.status;
      if (httpStatus === 401) {
        consecutiveAuthErrors++;
        if (consecutiveAuthErrors >= 3) {
          logger.warn(
            'devemailClient pollReports: persistent 401 on /mail/reports — falling back to Outlook polling'
          );
          return null;
        }
        // Force token refresh on next iteration
        mailJwt   = null;
        activeJwt = '';
        logger.warn(
          `devemailClient pollReports ${attempt}: 401 — will refresh token next cycle ` +
          `(consecutive auth errors: ${consecutiveAuthErrors})`
        );
      } else {
        consecutiveAuthErrors = 0;
        logger.warn(`devemailClient pollReports ${attempt} error: ${err.message}`);
      }
    }
  }

  logger.warn(
    `devemailClient pollReports: max wait (${maxMinutes} min) reached for ${fromMailId}`
  );
  return 'TIMEOUT';
}

// ─── fetchCurrentJobStatus ───────────────────────────────────────────────────

/**
 * Single-shot GET /mail/reports lookup — returns the current status for
 * fromMailId without entering a polling loop.
 *
 * Used by validation agents to populate the "CloudFuze Migration Status" table
 * in their reports without blocking on a full polling cycle.
 *
 * @param {string} fromMailId
 * @returns {Promise<{ workspaceId, totalCount, processedCount, cfStatus } | null>}
 */
async function fetchCurrentJobStatus(fromMailId) {
  let jwt;
  try {
    const auth = await authenticate();
    jwt = auth.mailJwt;
  } catch (e) {
    logger.warn(`devemailClient fetchCurrentJobStatus: auth failed — ${e.message}`);
    const cached = getLastJobDetails();
    if (cached.workspaceId || cached.totalCount) {
      return { ...cached, cfStatus: null };
    }
    return null;
  }

  const normFrom = String(fromMailId || '').toLowerCase().trim();

  try {
    // Try page sizes in ascending order — larger page increases chance of finding the job
    for (const pageSize of [50, 200]) {
      const res = await axios.get(
        `${BASE_URL}/mail/reports`,
        axiosCfg({
          headers: { Authorization: `Bearer ${jwt}` },
          params:  { pageNo: 0, pageSize, _: Date.now() },
          timeout: 30000,
        })
      );

      const jobs = _asArray(res.data);
      if (jobs.length === 0 && pageSize === 50) continue;

      let matchedJob    = null;
      let matchedDetail = null;

      for (const j of jobs) {
        const details = j.mailMigrationDetails || j.details || j.pairs || [];
        if (Array.isArray(details) && details.length > 0) {
          const d = details.find(
            (d) => String(d.fromMailId || d.fromEmail || '').toLowerCase() === normFrom
          );
          if (d) { matchedJob = j; matchedDetail = d; break; }
        }
        if (String(j.fromMailId || j.fromEmail || '').toLowerCase() === normFrom) {
          matchedJob = j;
          break;
        }
      }

      if (!matchedJob) {
        if (pageSize < 200) continue;
        logger.info(
          `devemailClient fetchCurrentJobStatus: no job for ${fromMailId} (${jobs.length} jobs)`
        );
        break;
      }

      const status = String(
        matchedDetail?.syncStatus    || matchedDetail?.status          ||
        matchedDetail?.processStatus || matchedDetail?.migrationStatus ||
        matchedJob.syncStatus        || matchedJob.status              ||
        matchedJob.processStatus     || matchedJob.migrationStatus     || ''
      ).toUpperCase().trim();

      const totalCount     = Number(matchedDetail?.totalCount     || matchedJob.totalCount     || 0) || null;
      const processedCount = Number(matchedDetail?.processedCount || matchedJob.processedCount || 0) || null;
      const workspaceId    =
        matchedJob.workspaceId || matchedJob.id || matchedJob.jobId ||
        matchedDetail?.workspaceId || null;

      logger.info(
        `devemailClient fetchCurrentJobStatus: ${fromMailId} → workspaceId=${workspaceId} ` +
        `status="${status}" ${processedCount}/${totalCount}`
      );
      return { workspaceId, totalCount, processedCount, cfStatus: status || null };
    }
  } catch (err) {
    logger.warn(`devemailClient fetchCurrentJobStatus error: ${err.message}`);
  }

  // Fallback: use lastJobDetails populated by pollReports() in this session
  const cached = getLastJobDetails();
  if (cached.workspaceId || cached.totalCount) {
    logger.info(
      `devemailClient fetchCurrentJobStatus: using cached lastJobDetails for ${fromMailId}`
    );
    return { ...cached, cfStatus: null };
  }

  return null;
}

// ─── getLastJobDetails ────────────────────────────────────────────────────────

/** Return a shallow copy of the last observed job details from pollReports(). */
function getLastJobDetails() {
  return { ...lastJobDetails };
}

/**
 * GET /mail/reports/{jobId} — per-user-pair sub-task breakdown for a specific migration job.
 * Returns the raw array of pair sub-tasks, e.g.
 *   [{ id, fromMailId, toMailId, fromCloud, toCloud, processStatus, totalCount, processedCount }]
 * Used to populate the validation report's CloudFuze Migration Status table (Job ID + per-pair
 * Workspace ID / counts) after the migration completes, with fresh auth.
 *
 * @param {string} jobId  Parent migration job id (matchedJob.id from /mail/reports)
 * @returns {Promise<Array>} pair sub-tasks, or [] on failure
 */
async function getJobReport(jobId) {
  if (!jobId || jobId === 'initiated') return [];
  try {
    const { mailJwt: jwt } = await authenticate();
    const res = await axios.get(
      `${BASE_URL}/mail/reports/${encodeURIComponent(jobId)}`,
      axiosCfg({ headers: { Authorization: `Bearer ${jwt}` }, params: { _: Date.now() }, timeout: 30000 })
    );
    return _asArray(res.data);
  } catch (err) {
    logger.warn(`devemailClient getJobReport(${jobId}) failed: ${err.response?.status || err.message}`);
    return [];
  }
}

/**
 * GET /mail/workSpaces/{jobDetailId} — folder-level migration records for one pair sub-task
 * (the deepest drill-down). jobDetailId is the per-pair `id` from /mail/reports/{jobId}.
 * Returns the raw array, e.g. [{ id, sourceId, destId, destFolderPath, processStatus, ... }].
 *
 * @param {string} jobDetailId  per-pair sub-task (workspace) id from /mail/reports/{jobId}
 * @returns {Promise<Array>} folder-level workspace records, or [] on failure
 */
async function getWorkspaceRecords(jobDetailId) {
  if (!jobDetailId) return [];
  try {
    const { mailJwt: jwt } = await authenticate();
    const res = await axios.get(
      `${BASE_URL}/mail/workSpaces/${encodeURIComponent(jobDetailId)}`,
      axiosCfg({ headers: { Authorization: `Bearer ${jwt}` }, params: { pageNo: 0, pageSize: 50, _: Date.now() }, timeout: 30000 })
    );
    return _asArray(res.data);
  } catch (err) {
    logger.warn(`devemailClient getWorkspaceRecords(${jobDetailId}) failed: ${err.response?.status || err.message}`);
    return [];
  }
}

// ─── Reports job resolver ─────────────────────────────────────────────────────
// Resolves Job ID + Workspace ID + counts + per-folder breakdown from /mail/reports so the
// validation report can show them. The reports endpoints DOUBLE-JSON-encode their responses; once
// _asArray() unwraps that, our own Basic-auth Mail JWT reads them fine — the earlier "report-blind"
// symptom was that parsing bug, not a token-scope limitation. A captured SSO token (data/
// devemail-sso-token.json, optional) is used automatically if present, but is no longer required.

const _fs = require('fs');
const _path = require('path');
const SSO_TOKEN_FILE = (process.env.DEVEMAIL_SSO_TOKEN_FILE || '').trim()
  || _path.resolve(__dirname, '..', '..', 'data', 'devemail-sso-token.json');

function loadSsoToken() {
  try {
    const j = JSON.parse(_fs.readFileSync(SSO_TOKEN_FILE, 'utf8'));
    const tok = (j.token || '').trim();
    if (!tok) return null;
    const exp = (() => { try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString()).exp * 1000; } catch { return 0; } })();
    if (exp && exp < Date.now()) {
      logger.warn(`devemailClient: saved SSO token expired (${new Date(exp).toISOString()}) — re-run capture-migration-details.js`);
      return null;
    }
    return tok;
  } catch { return null; }
}

/**
 * Resolve a migration job's Job ID + per-pair Workspace ID + counts + per-folder breakdown.
 *
 * Token source: prefers a captured SSO token if present, else falls back to our own Basic-auth
 * Mail JWT — both read /mail/reports correctly now that double-encoded bodies are unwrapped.
 *
 * Job selection: when a concrete `jobId` is known (from the initiate/poll response) it is used
 * directly (most reliable); otherwise the job is matched from /mail/reports by `jobName`, falling
 * back to the newest job.
 *
 * @param {{ jobId?: string, jobName?: string, fromMailId?: string }} opts
 * @returns {Promise<{ jobId, workspaceId, totalCount, processedCount, status, folderBreakdown }|null>}
 */
async function resolveJobViaSsoToken({ jobId: knownJobId, jobName, fromMailId } = {}) {
  // Token source: prefer a captured SSO token if one is present, but our own Basic-auth Mail JWT
  // reads /mail/reports fine now that responses are unwrapped — so no manual token is required.
  let token = loadSsoToken();
  let tokenSource = 'SSO token';
  if (!token) {
    try {
      const auth = await authenticate();
      token = auth.mailJwt;
      tokenSource = 'Basic-auth Mail JWT';
    } catch (e) {
      logger.warn(`devemailClient resolveJobViaSsoToken: no SSO token and Basic auth failed — ${e.message}`);
      return null;
    }
  }
  if (!token) return null;
  logger.info(`devemailClient resolveJobViaSsoToken: resolving via ${tokenSource}`);
  const H = axiosCfg({ headers: { Authorization: `Bearer ${token}` }, timeout: 30000, params: { _: Date.now() } });
  const norm = (s) => String(s || '').toLowerCase().trim();
  try {
    // Resolve the parent Job ID: use a known id directly, else match it from the reports list.
    let jobId = (knownJobId && knownJobId !== 'initiated') ? knownJobId : null;
    let job = null;
    if (!jobId) {
      const listRes = await axios.get(`${BASE_URL}/mail/reports`, H);
      const jobs = _asArray(listRes.data);
      if (!Array.isArray(jobs) || jobs.length === 0) {
        logger.warn('devemailClient resolveJobViaSsoToken: reports list returned no jobs');
        return null;
      }
      job = (jobName && jobs.find((j) => norm(j.jobName || j.name) === norm(jobName))) || jobs[0];
      jobId = job.id || job.jobId;
    }
    if (!jobId) return null;
    const r = await axios.get(`${BASE_URL}/mail/reports/${encodeURIComponent(jobId)}`, H);
    const arr = _asArray(r.data);
    const pair = (arr || []).find((p) => norm(p.fromMailId || p.fromEmail) === norm(fromMailId)) || (arr || [])[0] || {};
    const result = {
      jobId,
      // Workspace ID = the per-pair sub-task id. Different API shapes name it differently
      // (id / jobDetailId / emailWorkSpaceId / uniqueEmailWorkSpaceId / workSpaceId) — accept any.
      workspaceId: pair.id || pair.jobDetailId || pair.emailWorkSpaceId || pair.uniqueEmailWorkSpaceId || pair.workSpaceId || pair.workspaceId || null,
      totalCount: pair.totalCount ?? pair.total ?? null,
      processedCount: pair.processedCount ?? pair.processed ?? null,
      status: pair.processStatus || pair.syncStatus || (job && job.status) || null,
      folderBreakdown: [],
    };

    // Per-folder breakdown via GET /mail/workSpaces/{workspaceId} — CloudFuze's own source→dest
    // folder records + per-folder counts, for a cross-check against our folder validation.
    if (result.workspaceId) {
      try {
        const wr = await axios.get(
          `${BASE_URL}/mail/workSpaces/${encodeURIComponent(result.workspaceId)}`,
          axiosCfg({ headers: { Authorization: `Bearer ${token}` }, timeout: 30000, params: { pageNo: 0, pageSize: 500, type: 'all', folder: true, _: Date.now() } })
        );
        const recs = _asArray(wr.data);
        result.folderBreakdown = (recs || [])
          .filter((f) => f && (f.mailFolder || f.destFolderName || f.movedFolder)) // skip the root "/" placeholder
          .map((f) => {
            const destPath = String(f.destFolderPath || '/').replace(/\/+$/, '');
            const destName = f.destFolderName || f.movedFolder || f.mailFolder || '';
            return {
              folder: f.mailFolder || f.movedFolder || destName || '(unknown)',
              destPath: `${destPath}/${destName}`.replace(/^\/+/, '/'),
              total: f.totalCount ?? null,
              messages: f.messagesCount ?? null,
              unread: f.unreadCount ?? null,
              status: f.processStatus || null,
              subFolder: !!f.subFolder,
            };
          });
        logger.info(`devemailClient resolveJobViaSsoToken: folderBreakdown = ${result.folderBreakdown.length} folder record(s)`);
      } catch (we) {
        logger.warn(`devemailClient resolveJobViaSsoToken: workSpaces fetch failed (non-fatal): ${we.response?.status || we.message}`);
      }
    }
    logger.info(`devemailClient resolveJobViaSsoToken: jobId=${result.jobId}, workspaceId=${result.workspaceId}, counts=${result.processedCount}/${result.totalCount}`);
    return result;
  } catch (e) {
    logger.warn(`devemailClient resolveJobViaSsoToken failed: ${e.response?.status || e.message}`);
    return null;
  }
}

// ─── clearToken / clearState ──────────────────────────────────────────────────

function clearToken() {
  appJwt       = null;
  mailJwt      = null;
  cachedUserId = null;
}

/** Alias kept for backward compat with any code that calls clearState() */
const clearState = clearToken;

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Auth lifecycle
  authenticate,
  isAuthenticated,
  setRuntimeConfig,
  clearRuntimeConfig,
  clearToken,
  clearState,

  // Individual auth steps (exposed for testing)
  getAppJwt,
  getMailJwt,
  validateUser,

  // Cloud accounts
  getClouds,
  findCloudId,

  // Domain / mapping helpers
  getDomains,
  getUserMapping,
  getCachedMailboxMetadata,
  uploadUserCSV,
  cacheUserMapping,
  getPermissionMapping,

  // Migration lifecycle
  triggerMigration,
  pollReports,
  fetchCurrentJobStatus,
  getLastJobDetails,
  getJobReport,
  getWorkspaceRecords,
  loadSsoToken,
  resolveJobViaSsoToken,

  // Constants
  BASE_URL,
  TERMINAL_STATUSES,
};
