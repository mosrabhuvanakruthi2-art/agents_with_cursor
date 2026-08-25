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
// Full raw job object from last successful report match (for content migration report)
let lastJobReport = null;
// Workspace ID returned by POST /mail/register on some legacy servers
let registeredWorkspaceId = null;
// Move ID returned by POST /move/consumer/create (content server migrations)
let contentMoveId = null;

// ── Runtime config: set by MigrationAgent when context provides a server URL ──
// { baseUrl: string, email: string, password: string }
// When set, all API calls use this server instead of env.MIGRATION_API_URL.
let runtimeConfig = null;

/**
 * If the caller provides a bare root URL like https://qarelease.cloudfuze.com/,
 * automatically append /proxyservices/v1 so all relative paths resolve correctly.
 */
function normalizeBaseUrl(url) {
  if (!url) return url;
  // Strip trailing slashes only. Do NOT auto-append /proxyservices/v1 — login discovery
  // below probes both root-level and proxyservices-level paths automatically.
  return url.replace(/\/+$/, '');
}


function setRuntimeConfig(cfg) {
  if (cfg?.baseUrl) {
    let url = normalizeBaseUrl(cfg.baseUrl);
    const lc = url.toLowerCase();
    // Auto-add /proxyservices/v1 ONLY for devemail (a legacy server). Content servers like
    // qarelease must stay bare — isNewServer() treats a /proxyservices/ URL as legacy, and the
    // content path (Basic auth via validateUser) builds /proxyservices/v1 itself. Appending it
    // here would force the legacy login branch and break content auth.
    if (lc.includes('devemail') && !lc.includes('/proxyservices/')) {
      url = url.replace(/\/+$/, '') + '/proxyservices/v1';
      logger.info(`CloudFuze: auto-appended /proxyservices/v1 to devemail URL → ${url}`);
    }
    cfg = { ...cfg, baseUrl: url };
  }
  runtimeConfig = cfg ? { ...cfg } : null;
  // Clear cached tokens whenever we switch servers
  bearerToken = null;
  loginToken = null;
  registeredWorkspaceId = null;
  lastJobReport = null;
  contentMoveId = null;
  if (cfg?.baseUrl) {
    logger.info(`CloudFuze: runtime server override set to ${cfg.baseUrl}`);
  }
}

function clearRuntimeConfig() {
  runtimeConfig = null;
  bearerToken = null;
  loginToken = null;
  lastJobDetails = { workspaceId: null, totalCount: null, processedCount: null };
  lastJobReport = null;
  registeredWorkspaceId = null;
  contentMoveId = null;
}

function getLastJobDetails() {
  return { ...lastJobDetails };
}

function getLastJobReport() {
  return lastJobReport ? { ...lastJobReport } : null;
}

/** Returns the active API base URL (runtime override takes priority over env) */
function getActiveBaseUrl() {
  return runtimeConfig?.baseUrl || env.MIGRATION_API_URL;
}

/** Returns the email-endpoint base URL. For legacy servers the /email/* paths live
 *  under the same /proxyservices/v1 prefix as /mail/* — do NOT strip it. */
function getActiveEmailBaseUrl() {
  if (runtimeConfig?.baseUrl) return runtimeConfig.baseUrl;
  return env.MIGRATION_API_URL;
}

/**
 * Returns the API module ('report' for content-migration servers like qarelease,
 * 'email' for email-migration new-servers like newtestemail5).
 * Derived from the active base URL — login updates it to include the module path.
 * e.g. .../proxyservices/v1/report → 'report'
 *      .../proxyservices/v1/email  → 'email'
 */
function getApiModule() {
  const base = getActiveEmailBaseUrl();
  if (/\/report(\/|$)/.test(base)) return 'report';
  return 'email';
}

/**
 * True when the active server is a content-migration server (qarelease style).
 * Content servers expose /report/* and the newmultiuser Team-Migration API; they have no
 * /email/* JAX-RS resources, so the mail-only mapping steps must not be sent there — CXF answers
 * an unmatched path with a 500, not a 404.
 * Marker: Basic-auth login via validateUser stores userId and rewrites baseUrl to /report.
 */
function isContentServer() {
  return Boolean(runtimeConfig?.userId) || getApiModule() === 'report';
}

/**
 * True when the active server uses the NEW API format (newtestemail5 style).
 * New servers require email + MD5 password for login and use /email/* paths.
 * Legacy servers (devemail) use Basic auth and /mail/* paths.
 * Detection: new server requires runtime credentials (email + password).
 * A runtime URL with no credentials is treated as a legacy server override.
 */
function isNewServer() {
  // forceNewServer is set when Basic auth via validateUser succeeds (content server with WAF)
  // so that new-server API paths (entuser/clouds, entmove/initiate, etc.) are used correctly.
  if (runtimeConfig?.forceNewServer) return true;
  if (!runtimeConfig?.baseUrl || !runtimeConfig?.email || !runtimeConfig?.password) return false;
  const url = runtimeConfig.baseUrl.toLowerCase();
  // devemail and /proxyservices/v1 URLs are legacy servers even when credentials are provided
  return !url.includes('devemail') && !url.includes('/proxyservices/');
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
  // Runtime override: user provided a Basic auth token via UI (password field, no email)
  if (runtimeConfig?.basicAuth) {
    let raw = String(runtimeConfig.basicAuth).trim();
    if (/^basic\s+/i.test(raw)) raw = raw.replace(/^basic\s+/i, '').trim();
    return raw;
  }
  let raw = (env.MIGRATION_API_BASIC_AUTH || env.MIGRATION_API_KEY || '').trim();
  if (!raw) return '';
  if (/^basic\s+/i.test(raw)) raw = raw.replace(/^basic\s+/i, '').trim();
  return raw;
}

/** Returns the Authorization header value, handling both Bearer JWT and Basic auth tokens. */
function buildAuthHeader(token) {
  const s = String(token || '').trim();
  if (/^Basic\s+/i.test(s)) return s;
  return `Bearer ${s}`;
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

  const legacyBase = runtimeConfig?.baseUrl || env.MIGRATION_API_URL;
  const res = await retryWithBackoff(
    () =>
      axios.post(
        `${legacyBase}/mail/register`,
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

  // Some legacy servers (e.g. qarelease) return a workspace/job ID alongside the token
  const wsId = raw?.workspaceId || raw?.workspace_id || raw?.id || raw?.jobId || null;
  if (wsId && typeof wsId === 'string') {
    registeredWorkspaceId = wsId;
    logger.info(`CloudFuze register: workspace ID captured: ${wsId}`);
  }

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

  // Diagnostic: shows why we take the content-server (browser-login) path vs the legacy one.
  logger.info(`CloudFuze login(): isNewServer=${isNewServer()} runtimeBaseUrl=${runtimeConfig?.baseUrl || '(none)'} hasEmail=${!!runtimeConfig?.email} hasPassword=${!!runtimeConfig?.password}`);

  // New server: email + password via POST /email/app/login
  // Different CloudFuze servers (newtestemail5, qarelease, etc.) vary in:
  //   (a) whether the API lives at root or under /proxyservices/v1
  //   (b) whether the password is MD5-hashed or sent as plain text
  // Probe URL candidates × password variants until one succeeds.
  if (isNewServer() && runtimeConfig.email && runtimeConfig.password) {
    const crypto = require('crypto');
    const baseUrl = runtimeConfig.baseUrl;
    const origin = (() => { try { return new URL(baseUrl).origin; } catch { return baseUrl; } })();
    const ent = (() => { try { return new URL(baseUrl).host; } catch { return baseUrl; } })();

    // Password variants: try MD5, plain, and SHA-256 — different CloudFuze servers expect different formats
    const md5Password    = crypto.createHash('md5').update(runtimeConfig.password).digest('hex');
    const sha256Password = crypto.createHash('sha256').update(runtimeConfig.password).digest('hex');

    // ent field variants — all of these returned 403 previously, so try WITHOUT ent first.
    const entFull  = ent;                // 'qarelease.cloudfuze.com'
    const entShort = ent.split('.')[0];  // 'qarelease'

    // No-ent variants come FIRST — if ent field is causing the 403, these will find the working combo.
    // SHA-256 added because all MD5+plain variants returned 403 on previous run.
    const bodyVariants = [
      { label: 'md5-noEnt',       body: { email: runtimeConfig.email, password: md5Password            } },
      { label: 'plain-noEnt',     body: { email: runtimeConfig.email, password: runtimeConfig.password } },
      { label: 'sha256-noEnt',    body: { email: runtimeConfig.email, password: sha256Password          } },
      { label: 'md5+entFull',     body: { email: runtimeConfig.email, password: md5Password,            ent: entFull  } },
      { label: 'plain+entFull',   body: { email: runtimeConfig.email, password: runtimeConfig.password, ent: entFull  } },
      { label: 'sha256+entFull',  body: { email: runtimeConfig.email, password: sha256Password,         ent: entFull  } },
      { label: 'md5+entShort',    body: { email: runtimeConfig.email, password: md5Password,            ent: entShort } },
      { label: 'plain+entShort',  body: { email: runtimeConfig.email, password: runtimeConfig.password, ent: entShort } },
      { label: 'sha256+entShort', body: { email: runtimeConfig.email, password: sha256Password,         ent: entShort } },
      // Some CloudFuze APIs use emailId instead of email
      { label: 'md5+emailId',     body: { emailId: runtimeConfig.email, password: md5Password,          ent: entFull  } },
      { label: 'plain+emailId',   body: { emailId: runtimeConfig.email, password: runtimeConfig.password, ent: entFull } },
    ];

    // Ordered URL candidates — first success wins.
    // Content servers (qarelease, etc.) use /app/login or /users/app/login — no /email/ prefix.
    // Email servers (newtestemail5, etc.) use /email/app/login or /entapp/login.
    // Try content-server paths FIRST so content migrations don't waste time on email-only paths.
    const loginCandidates = [...new Set([
      `${origin}/proxyservices/v1/app/login`,           // content server primary
      `${origin}/proxyservices/v1/users/app/login`,     // content server alternative
      `${origin}/proxyservices/v1/users/login`,         // content server alternative
      `${origin}/proxyservices/v1/email/app/login`,     // email server (403 on content servers)
      `${origin}/proxyservices/v1/entapp/login`,        // email server alternative
      `${origin}/proxyservices/v1/report/entapp/login`,
      `${origin}/proxyservices/v1/report/app/login`,
      `${baseUrl}/email/app/login`,
      `${origin}/email/app/login`,
      `${origin}/app/login`,
    ])];

    const extractToken = (res) => {
      const raw = res.data;
      logger.info(`CloudFuze login response body: ${JSON.stringify(raw)}`);
      const headerToken = (
        res.headers?.['authorization'] ||
        res.headers?.['x-auth-token'] ||
        res.headers?.['x-access-token'] ||
        res.headers?.['token'] ||
        ''
      ).replace(/^Bearer\s*/i, '').trim();
      return raw?.token || raw?.accessToken || raw?.jwtToken || raw?.data?.token ||
        raw?.data?.accessToken || raw?.result?.token || headerToken ||
        (typeof raw === 'string' ? raw.replace(/^Bearer\s*/i, '').trim() : '');
    };

    let lastErr;
    const failedSummary = [];
    let wafBlocked = false; // set on first 403 — skip remaining URLs (WAF blocks all at once)
    for (const loginUrl of loginCandidates) {
      if (wafBlocked) break;
      for (const variant of bodyVariants) {
        try {
          const res = await retryWithBackoff(
            () =>
              axios.post(
                loginUrl,
                variant.body,
                migrationAxiosConfig({
                  timeout: 30000,
                  headers: { 'Content-Type': 'application/json' },
                })
              ),
            { label: `CloudFuze login (${loginUrl}, ${variant.label})`, maxRetries: 1 }
          );
          const token = extractToken(res);
          if (!token) throw new Error(`no token in response — body: ${JSON.stringify(res.data)}`);

          loginToken = token;
          // Strip the login suffix so the module prefix (/report/ or /email/) is preserved in baseUrl.
          // Handles both /app/login and /entapp/login patterns.
          const successBase = loginUrl.replace(/\/(ent)?app\/login$/, '');
          if (successBase !== baseUrl) {
            logger.info(`CloudFuze: base URL updated to ${successBase} (login via ${loginUrl})`);
            runtimeConfig = { ...runtimeConfig, baseUrl: successBase };
          }
          logger.info(`CloudFuze: logged in via POST ${loginUrl} (variant: ${variant.label})`);
          return loginToken;
        } catch (err) {
          lastErr = err;
          const status = err?.response?.status;
          failedSummary.push(`${loginUrl.replace(/^https?:\/\/[^/]+/, '')}[${variant.label}]:${status || 'net'}`);
          if (status === 403 || status === 401) {
            logger.warn(`CloudFuze login (${loginUrl}, ${variant.label}) → HTTP ${status}: ${JSON.stringify(err?.response?.data)}`);
          } else {
            logger.warn(`CloudFuze login (${loginUrl}, ${variant.label}) → HTTP ${status || 'network'}: ${err?.message}`);
          }
          // 401 = definitively wrong credentials — stop all remaining candidates
          if (status === 401) throw err;
          // 403 = WAF-blocking; all URLs on this server are blocked — skip the rest
          if (status === 403) { wafBlocked = true; break; }
        }
      }
    }
    // ── WAF-blocked fallback (content servers only, e.g. qarelease) ─────────────
    // Some API login paths returned 403 — server is WAF-blocking direct POST login.
    // (Other paths may return 404 because they don't exist on this server.)
    // isNewServer() = true here, so this block never runs for devemail or message flows.
    const hadAny403 = failedSummary.some((s) => s.endsWith(':403'));
    if (hadAny403 && runtimeConfig?.email && runtimeConfig?.password) {
      // Approach 1: Basic auth via validateUser (GET — not WAF-blocked).
      // Content servers store userId:md5(password) as Basic auth in the browser portal.
      // We reproduce this by getting userId from the validateUser GET endpoint.
      try {
        logger.info('CloudFuze: all API login attempts returned 403 — trying Basic auth via validateUser');
        const vOrigin = (() => { try { return new URL(runtimeConfig.baseUrl).origin; } catch { return runtimeConfig.baseUrl; } })();
        const vRes = await axios.get(
          `${vOrigin}/proxyservices/v1/users/validateUser`,
          migrationAxiosConfig({ params: { searchUser: runtimeConfig.email }, timeout: 10000 })
        );
        const userId = typeof vRes.data === 'string'
          ? vRes.data.trim()
          : String(vRes.data?.id || vRes.data?.userId || '').trim();
        if (userId && userId.length > 8) {
          const md5pw = crypto.createHash('md5').update(runtimeConfig.password).digest('hex');
          const b64 = Buffer.from(`${userId}:${md5pw}`).toString('base64');
          // Set base URL to content module path so getApiModule() returns 'report'
          // and forceNewServer ensures new-server API paths (entuser/clouds, entmove/initiate) are used.
          // Store userId for getClouds() to use the /users/{id}/get/all/cloud endpoint.
          runtimeConfig = { ...runtimeConfig, baseUrl: `${vOrigin}/proxyservices/v1/report`, basicAuth: b64, forceNewServer: true, userId };
          loginToken = `Basic ${b64}`;
          logger.info(`CloudFuze: Basic auth via validateUser for ${runtimeConfig.email} at ${vOrigin}`);
          return loginToken;
        }
        logger.warn(`CloudFuze: validateUser returned no valid userId: ${JSON.stringify(vRes.data).slice(0, 100)}`);
      } catch (vErr) {
        logger.warn(`CloudFuze: Basic auth via validateUser failed (${vErr.message})`);
      }
      // Approach 2: Headless browser fallback
      try {
        logger.info('CloudFuze: trying browser login (content server fallback)');
        const { getTokenViaBrowser } = require('./qareleaseBrowserClient');
        const browserToken = await getTokenViaBrowser(
          runtimeConfig.baseUrl,
          runtimeConfig.email,
          runtimeConfig.password
        );
        loginToken = browserToken;
        logger.info('CloudFuze: browser login succeeded — token captured for content server');
        return loginToken;
      } catch (browserErr) {
        logger.warn(`CloudFuze: browser login failed (${browserErr.message})`);
      }
    }

    const summary = failedSummary.join(', ');
    logger.error(`CloudFuze: all login candidates exhausted. Attempts: ${summary}`);
    throw lastErr || new Error(`CloudFuze: all login candidates exhausted [${summary}] — check server URL and credentials`);
  }

  // Legacy: static Bearer env token
  const staticBearer = normalizeBearerFromEnv(env.MIGRATION_API_BEARER_TOKEN);
  if (staticBearer) {
    if (isJwtExpired(staticBearer)) {
      logger.warn('CloudFuze: MIGRATION_API_BEARER_TOKEN is expired — will try POST /app/login to auto-refresh');
    } else {
      loginToken = staticBearer;
      logger.info('CloudFuze: using MIGRATION_API_BEARER_TOKEN (skipping /mail/login)');
      return loginToken;
    }
  }

  const legacyBase = runtimeConfig?.baseUrl || env.MIGRATION_API_URL;

  // /app/login lives under the same path prefix as /mail/* (i.e. /proxyservices/v1/app/login).
  // Use legacyBase directly — it already includes /proxyservices/v1 after setRuntimeConfig normalisation.
  const appLoginBase = legacyBase.replace(/\/+$/, '');

  // ── Runtime credentials from form (email + password) ──────────────────────
  // Try multiple URL candidates for /app/login since the path varies by server build:
  //   1. /proxyservices/v1/app/login  (legacy path prefix)
  //   2. /app/login                   (root level, no prefix)
  //   3. /proxyservices/v1/email/app/login  (email-API path variant)
  if (runtimeConfig?.email && runtimeConfig?.password) {
    const crypto = require('crypto');
    const runtimeMd5 = crypto.createHash('md5').update(runtimeConfig.password).digest('hex');
    // Root base = strip /proxyservices/... suffix so we can try root-level /app/login
    const rootBase = appLoginBase.replace(/\/proxyservices\/.*/i, '');
    const ent = (() => { try { return new URL(appLoginBase).host; } catch { return ''; } })();
    // The API lives under /proxyservices/v1 even when CONTENT_MIGRATION_SERVER_URL is set
    // without that prefix (e.g. https://qarelease.cloudfuze.com). Build the API base so the
    // login doesn't hit the website root (which returns a 404 HTML page).
    const apiBase = appLoginBase.includes('/proxyservices/') ? appLoginBase : `${rootBase}/proxyservices/v1`;

    const appLoginUrls = [...new Set([
      `${apiBase}/app/login`,            // /proxyservices/v1/app/login  (content server primary)
      `${apiBase}/users/app/login`,      // /proxyservices/v1/users/app/login
      `${apiBase}/email/app/login`,      // /proxyservices/v1/email/app/login
      `${rootBase}/app/login`,           // /app/login (root-level fallback)
    ])];

    for (const loginUrl of appLoginUrls) {
      try {
        const body = { email: runtimeConfig.email, password: runtimeMd5 };
        if (ent) body.ent = ent;
        const res = await retryWithBackoff(
          () => axios.post(loginUrl, body, migrationAxiosConfig({ timeout: 30000 })),
          { label: `CloudFuze /app/login (runtime) @ ${loginUrl}`, maxRetries: 1 }
        );
        const raw = res.data;
        const headerToken = (res.headers?.['authorization'] || res.headers?.['x-auth-token'] || '')
          .replace(/^Bearer\s*/i, '').trim();
        const token = (typeof raw === 'string' ? raw.replace(/^Bearer\s*/i, '').trim() : '') ||
          raw?.token || raw?.accessToken || raw?.jwtToken || raw?.data?.token ||
          raw?.userVO?.token || headerToken;
        if (token) {
          loginToken = token;
          logger.info(`CloudFuze: logged in via /app/login (runtime credentials: ${runtimeConfig.email}) at ${loginUrl}`);
          return loginToken;
        }
        logger.warn(`CloudFuze /app/login (runtime) @ ${loginUrl}: 200 OK but no token — ${JSON.stringify(raw)}`);
      } catch (err) {
        const status = err?.response?.status;
        const body2 = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : '';
        logger.warn(`CloudFuze /app/login (runtime) @ ${loginUrl} failed (${status || err.message})${body2 ? ': ' + body2 : ''}`);
      }
    }
    logger.warn('CloudFuze /app/login (runtime): all URL candidates failed — falling back to env credentials');
  }

  // Try POST /app/login directly — same call that /mail/login makes internally.
  // /mail/login: authenticates Basic auth → cfUser → calls /app/login{ email, password: cfUser.getPassword(), ent }
  // cfUser.getPassword() == second part of MIGRATION_API_BASIC_AUTH == appLoginPasswordMd5 here.
  const apiKey = (env.MIGRATION_API_KEY || '').trim();
  if (apiKey) {
    let appLoginEmail = '';
    let appLoginPasswordPlain = '';
    let appLoginPasswordMd5 = '';
    try {
      const decoded = Buffer.from(apiKey, 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx > 0) {
        appLoginEmail = decoded.slice(0, colonIdx).trim();
        appLoginPasswordMd5 = decoded.slice(colonIdx + 1).trim(); // already md5
      }
    } catch { /* ignore */ }
    appLoginPasswordPlain = (env.MIGRATION_APP_LOGIN_PASSWORD || '').trim();

    const crypto = require('crypto');
    // ent = hostname of the legacy server (devemail.cloudfuze.com) — required by /app/login
    const ent = (() => { try { return new URL(appLoginBase).host; } catch { return ''; } })();

    const passwordsToTry = [];
    // cfUser.getPassword() = dda0e3600... = second part of MIGRATION_API_BASIC_AUTH.
    // /mail/login internally calls /app/login with exactly this value as the password.
    // Try it first — it is the confirmed-correct credential for this server.
    if (appLoginPasswordMd5) passwordsToTry.push({ label: 'md5', password: appLoginPasswordMd5 });
    if (appLoginPasswordPlain) {
      passwordsToTry.push({ label: 'plaintext', password: appLoginPasswordPlain });
      // MD5 of the plaintext password — fallback in case verifyUser expects client-side hashing
      const md5OfPlain = crypto.createHash('md5').update(appLoginPasswordPlain).digest('hex');
      passwordsToTry.push({ label: 'md5-of-plain', password: md5OfPlain });
    }

    for (const { label, password } of passwordsToTry) {
      if (!appLoginEmail || !password) continue;
      try {
        const body = { email: appLoginEmail, password };
        if (ent) body.ent = ent;
        const res = await retryWithBackoff(
          () =>
            axios.post(
              `${appLoginBase}/app/login`,
              body,
              migrationAxiosConfig({ timeout: 30000 })
            ),
          { label: `CloudFuze /app/login (${label})`, maxRetries: 1 }
        );
        const raw = res.data;
        logger.info(`CloudFuze /app/login (${label}) raw response: ${JSON.stringify(raw)}`);
        const headerToken = (
          res.headers?.['authorization'] || res.headers?.['x-auth-token'] || ''
        ).replace(/^Bearer\s*/i, '').trim();
        const token = (typeof raw === 'string' ? raw.replace(/^Bearer\s*/i, '').trim() : '') ||
          raw?.token || raw?.accessToken || raw?.jwtToken || raw?.data?.token ||
          raw?.userVO?.token || headerToken;
        if (token) {
          loginToken = token;
          logger.info(`CloudFuze: auto-refreshed app-level JWT via POST /app/login (${label} password)`);
          return loginToken;
        }
        logger.warn(`CloudFuze /app/login (${label}): 200 OK but no token in response — ${JSON.stringify(raw)}`);
      } catch (appLoginErr) {
        const status = appLoginErr?.response?.status;
        const body = appLoginErr?.response?.data ? JSON.stringify(appLoginErr.response.data).slice(0, 200) : '';
        logger.warn(`CloudFuze /app/login (${label}) failed (${status || appLoginErr.message})${body ? ': ' + body : ''}`);
      }
    }
    if (passwordsToTry.length > 0) {
      logger.warn('CloudFuze /app/login exhausted all password variants — trying /mail/register JWT next');
    }
  }

  // Use the bearerToken obtained from POST /mail/register (Step 0 of MigrationAgent).
  // This uses the same Basic auth credentials as MIGRATION_API_BEARER_TOKEN and should
  // have identical permission scope — avoiding the wrong-scope /mail/login JWT that
  // causes HTTP 500 on /mail/move/initiate.
  if (!isNewServer() && bearerToken && !isJwtExpired(bearerToken)) {
    loginToken = bearerToken;
    logger.info('CloudFuze: using /mail/register JWT as loginToken for legacy server (auto-refresh, no manual step needed)');
    return loginToken;
  }

  const basic = basicAuthPayload();
  if (!basic) {
    throw new Error(
      'CloudFuze auth missing: set MIGRATION_API_BEARER_TOKEN, or MIGRATION_API_BASIC_AUTH / MIGRATION_API_KEY'
    );
  }

  // Use runtime URL if set (legacy server override), otherwise fall back to env
  const res = await retryWithBackoff(
    () =>
      axios.post(
        `${legacyBase}/mail/login`,
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
    : (tokenData?.token || tokenData?.accessToken || tokenData?.jwtToken ||
       tokenData?.sessionToken || tokenData?.authToken ||
       String(tokenData || ''));

  logger.info('CloudFuze login successful');
  return loginToken;
}

function getAuthClient(token) {
  return axios.create(
    migrationAxiosConfig({
      baseURL: getActiveBaseUrl(),
      headers: {
        'Content-Type': 'application/json',
        Authorization: buildAuthHeader(token),
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

  // Content server with Basic auth (e.g. qarelease): use /users/{userId}/get/all/cloud
  // This endpoint is only reachable when login() stored a userId via validateUser.
  if (runtimeConfig?.userId) {
    const contentOrigin = (() => { try { return new URL(runtimeConfig.baseUrl).origin; } catch { return runtimeConfig.baseUrl; } })();
    const contentCloudsUrl = `${contentOrigin}/proxyservices/v1/users/${runtimeConfig.userId}/get/all/cloud`;
    try {
      const res = await axios.get(
        contentCloudsUrl,
        migrationAxiosConfig({ headers: { Authorization: token }, params: { _: Date.now() }, timeout: 30000 })
      );
      const clouds = Array.isArray(res.data) ? res.data : [];
      logger.info(`CloudFuze getClouds (content server): ${clouds.length} cloud(s) via /users/{id}/get/all/cloud`);
      return clouds;
    } catch (err) {
      logger.warn(`CloudFuze getClouds (content server) failed (${err?.response?.status || err?.message}) — falling back`);
    }
  }

  // New server exposes clouds at /email/user/clouds (email) or /report/entuser/clouds (content/qarelease)
  const apiModule = getApiModule();
  const cloudsUrl = isNewServer()
    ? apiModule === 'report'
      ? `${emailBase}/entuser/clouds`      // content migration: .../report/entuser/clouds
      : `${emailBase}/user/clouds`         // email migration:   .../email/user/clouds
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
          headers: { Authorization: buildAuthHeader(cand.value) },
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
      logger.warn(`CloudFuze getClouds with ${cand.label} failed (${err?.response?.status || err?.message}) — trying next`);
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
        logger.warn(`CloudFuze getClouds Basic auth failed (${err?.response?.status || err?.message})`);
      }
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('CloudFuze: no valid token available for getClouds');
}

/**
 * Find the cloud ID for a given email from the clouds list.
 * Handles both old-server (id field) and new-server (vendorId field).
 * Priority: 1. Exact match on adminEmailId/email  2. Domain match  3. cloudNameHint match
 *
 * @param {Array} clouds
 * @param {string} email
 * @param {string} [cloudNameHint] - provider key (e.g. 'box', 'sharepoint') used as fallback
 *   for content clouds that have no adminEmailId/email fields (e.g. qarelease).
 */
function findCloudId(clouds, email, cloudNameHint) {
  const norm = String(email || '').toLowerCase().trim();
  const extractId = (c) => c.id || c.vendorId || c.cloudId;

  // Extract any email-like field — qarelease uses 'emailId', other servers use 'adminEmailId'/'email'
  const cloudEmail = (c) => String(
    c.adminEmailId || c.email || c.emailId || c.memberEmail || c.userEmail || ''
  ).toLowerCase();

  // When cloudNameHint is provided, build a type-filtered subset for scoped matching.
  // This prevents cross-type domain matches (e.g. Box filefuze.co matching instead of SharePoint filefuze.co).
  // Compare on alphanumerics only. The provider key has no separators ('googleshareddrive') while the
  // cloud name does ('GOOGLE_SHARED_DRIVES'), so a literal startsWith never matched and the Shared
  // Drive cloud was invisible to type-scoped matching.
  const squash = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hint = cloudNameHint ? squash(cloudNameHint) : null;
  const typedClouds = hint
    ? clouds.filter((c) => {
        const cn = squash(c.cloudName);
        return cn === hint || cn.startsWith(hint) || hint.startsWith(cn);
      })
    : [];

  // 1. Exact email match — within the requested type first
  const exactScoped = typedClouds.find((c) => cloudEmail(c) === norm);
  if (exactScoped) return { id: extractId(exactScoped), cloudName: exactScoped.cloudName, memberId: exactScoped.memberId };

  // 2. Domain match — within the requested type
  const domain = norm.includes('@') ? norm.split('@')[1] : null;
  const domainScoped = domain ? typedClouds.find((c) => cloudEmail(c).endsWith('@' + domain)) : null;
  if (domainScoped) return { id: extractId(domainScoped), cloudName: domainScoped.cloudName, memberId: domainScoped.memberId };

  // Cross-type fallback is allowed ONLY when the requested type has no registrations at all. With
  // clouds of the right type present, matching a different type by email is never correct: it is how a
  // SharePoint destination silently resolved to the same user's Box registration and the whole run
  // failed downstream on a mismatched cloud id.
  if (!hint || typedClouds.length === 0) {
    const exactAll = clouds.find((c) => cloudEmail(c) === norm);
    if (exactAll) {
      if (hint) {
        logger.warn(`CloudFuze findCloudId: no "${cloudNameHint}" cloud registered — falling back to `
          + `"${exactAll.cloudName}" for ${norm}. Verify this is the intended cloud.`);
      }
      return { id: extractId(exactAll), cloudName: exactAll.cloudName, memberId: exactAll.memberId };
    }
    if (domain) {
      const domainAll = clouds.find((c) => cloudEmail(c).endsWith('@' + domain));
      if (domainAll) {
        if (hint) {
          logger.warn(`CloudFuze findCloudId: no "${cloudNameHint}" cloud registered — falling back to `
            + `"${domainAll.cloudName}" by domain for ${norm}. Verify this is the intended cloud.`);
        }
        return { id: extractId(domainAll), cloudName: domainAll.cloudName, memberId: domainAll.memberId };
      }
    }
  } else {
    // Type exists but this account is not registered on it — say so, and name what IS registered.
    const registered = typedClouds.map((c) => `${c.cloudName} (${cloudEmail(c) || 'no email'})`).join(', ');
    logger.warn(`CloudFuze findCloudId: ${norm} has no "${cloudNameHint}" registration. `
      + `Registered ${cloudNameHint} cloud(s): ${registered}. `
      + 'Add the cloud in CloudFuze, or pin the id with CONTENT_SOURCE_CLOUD_ID / CONTENT_DEST_CLOUD_ID.');
  }

  // 3. cloudName-only fallback — ONLY for servers whose cloud records carry no email at all.
  //
  // Taking typedClouds[0] whenever the type matched was actively dangerous: it returned a cloud
  // belonging to a DIFFERENT user and the caller had no way to tell. Observed on 2026-08-25 —
  // the granger@gajha.com SharePoint registration was removed from the qarelease account, this
  // fallback silently substituted erik@voohalu.co's SharePoint cloud, and the job was built to
  // migrate into the wrong tenant. CloudFuze rejected it with "destination user granger@gajha.com
  // is not provisioned; Please Make this as Licensed user", which sent the investigation after a
  // licence that was never the problem.
  //
  // Guessing a destination is worse than failing: at best it wastes a run, at worst it writes
  // somebody else's data into somebody else's tenant. So substitute only when no email is
  // available to match against, and otherwise return null and let the caller fail loudly.
  const anyEmailKnown = typedClouds.some((c) => cloudEmail(c) !== '');
  if (hint && typedClouds.length > 0 && !anyEmailKnown) {
    const nameHit = typedClouds[0];
    logger.info(`CloudFuze findCloudId: matched "${nameHit.cloudName}" via cloudNameHint `
      + `"${cloudNameHint}" — this server exposes no email on its cloud records, so the type is `
      + 'the only thing available to match on.');
    return { id: extractId(nameHit), cloudName: nameHit.cloudName, memberId: nameHit.memberId };
  }
  if (hint && typedClouds.length > 0) {
    logger.error(`CloudFuze findCloudId: refusing to guess a "${cloudNameHint}" cloud for ${norm}. `
      + `${typedClouds.length} cloud(s) of that type are registered but none belong to that account. `
      + 'Register the cloud in CloudFuze (Manage Clouds), or pin the id with '
      + 'CONTENT_SOURCE_CLOUD_ID / CONTENT_DEST_CLOUD_ID.');
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// STEP 1→2 — GET /email/move/domains/{destCloudId}
// Same path on both devemail and newtestemail5 — only the base URL differs:
//   devemail:      https://devemail.cloudfuze.com/proxyservices/v1/email/move/domains/{id}
//   newtestemail5: https://newtestemail5.cloudfuze.com/email/move/domains/{id}
// ─────────────────────────────────────────────────────────────
async function getDomains(destCloudId) {
  const emailBase = getActiveEmailBaseUrl();
  const tokens = [await login(), bearerToken].filter(Boolean);
  let lastErr;
  for (const token of tokens) {
    try {
      const res = await retryWithBackoff(
        () =>
          axios.get(
            `${emailBase}/email/move/domains/${destCloudId}`,
            migrationAxiosConfig({
              headers: { Authorization: buildAuthHeader(token) },
              params: { _: Date.now() },
              timeout: 30000,
            })
          ),
        { label: 'CloudFuze getDomains', maxRetries: 2 }
      );
      return res.data;
    } catch (err) {
      lastErr = err;
      if (err?.response?.status !== 401) throw err;
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────
// STEP 1→3 — GET /email/user/cache/{sourceCloudId}/{destCloudId}
// Fetches the full permission mapping (Step 3 in CloudFuze UI).
// Used by deep mail validation to check From/To/CC/BCC rewriting.
// Returns [{sourceEmail, destinationEmail}] or [] on failure.
// ─────────────────────────────────────────────────────────────
async function getPermissionMapping(sourceCloudId, destCloudId, { pageSize = 500 } = {}) {
  const emailBase = getActiveEmailBaseUrl();
  const tokens = [await login(), bearerToken].filter(Boolean);
  for (const token of tokens) {
    try {
      const res = await axios.get(
        `${emailBase}/email/user/cache/${sourceCloudId}/${destCloudId}`,
        migrationAxiosConfig({
          headers: { Authorization: buildAuthHeader(token) },
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
      if (err?.response?.status === 401) continue;
      logger.warn(`CloudFuze getPermissionMapping failed (${err.response?.status || err.message}) — skipping`);
      return [];
    }
  }
  logger.warn('CloudFuze getPermissionMapping failed (401 on all tokens) — skipping');
  return [];
}

// ─────────────────────────────────────────────────────────────
// STEP 2a — POST /email/user/csv/{sourceCloudId}/{destCloudId}
// Upload user mapping CSV (built from mappedPairs)
// ─────────────────────────────────────────────────────────────
async function uploadUserCSV(sourceCloudId, destCloudId, pairs) {
  const emailBase = getActiveEmailBaseUrl();

  const csvLines = ['Source Email Address,Destination Email Address'];
  for (const p of pairs) csvLines.push(`${p.sourceEmail},${p.destinationEmail}`);
  const csvContent = csvLines.join('\r\n');

  logger.info(`CloudFuze uploadUserCSV body:\n${csvContent}`);

  const tokens = [await login(), bearerToken].filter(Boolean);
  let lastErr;
  for (const token of tokens) {
    try {
      const res = await retryWithBackoff(
        () =>
          axios.post(
            `${emailBase}/email/user/csv/${sourceCloudId}/${destCloudId}`,
            csvContent,
            migrationAxiosConfig({
              headers: {
                Authorization: buildAuthHeader(token),
                'Content-Type': 'text/csv',
              },
              timeout: 30000,
            })
          ),
        { label: 'CloudFuze uploadUserCSV', maxRetries: 2 }
      );
      return res.data;
    } catch (err) {
      lastErr = err;
      if (err?.response?.status !== 401) throw err;
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────
// STEP 2b — Cache/confirm user mapping
//   New server → GET /email/user/cache/{srcId}/{dstId}
//   Legacy     → GET /mail/cache/{srcId}/{dstId}
// ─────────────────────────────────────────────────────────────
async function cacheUserMapping(sourceCloudId, destCloudId) {
  const base = getActiveBaseUrl();
  const emailBase = getActiveEmailBaseUrl();

  const cacheUrl = isNewServer()
    ? `${emailBase}/email/user/cache/${sourceCloudId}/${destCloudId}`
    : `${base}/mail/cache/${sourceCloudId}/${destCloudId}`;

  const tokens = [await login(), bearerToken].filter(Boolean);
  let lastErr;
  for (const token of tokens) {
    try {
      const res = await retryWithBackoff(
        () =>
          axios.get(
            cacheUrl,
            migrationAxiosConfig({
              headers: { Authorization: buildAuthHeader(token) },
              params: { pageNo: 0, pageSize: 20, _: Date.now() },
              timeout: 30000,
            })
          ),
        { label: 'CloudFuze cacheUserMapping', maxRetries: 2 }
      );
      return res.data;
    } catch (err) {
      lastErr = err;
      if (err?.response?.status !== 401) throw err;
    }
  }
  throw lastErr;
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
      headers: { Authorization: buildAuthHeader(token), 'Content-Type': 'application/json' },
      timeout: 30000,
    })
  );
  return res.data;
}

function initiatePathCandidates(sourceCloudId) {
  if (isNewServer()) {
    // Content migration servers (qarelease, /report/ prefix) use different paths.
    // DevTools pattern: entuser/*, entapp/* — trigger is likely entmove/initiate or move/initiate.
    if (getApiModule() === 'report') {
      return ['entmove/initiate', 'move/initiate', 'content/initiate', 'email/move/initiate'];
    }
    return ['email/move/initiate'];
  }
  const custom = (env.MIGRATION_API_INITIATE_PATH || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const defaults = ['mail/move/initiate', 'mail/initiate', 'initiate'];
  const out = [];
  if (custom) out.push(custom);
  // When a runtime server URL is set (e.g. qarelease), also try the newmultiuser paths.
  // These use Basic auth rather than Bearer — handled separately in triggerMigration.
  if (runtimeConfig?.baseUrl) {
    if (registeredWorkspaceId) out.push(`move/newmultiuser/create/${registeredWorkspaceId}`);
    if (sourceCloudId && sourceCloudId !== registeredWorkspaceId) out.push(`move/newmultiuser/create/${sourceCloudId}`);
    out.push('move/newmultiuser/create');
  }
  for (const d of defaults) {
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

async function triggerMigration(context) {
  // ── Content server (qarelease/Basic auth): Team Migration via newmultiuser API ──
  // 4-step flow matching the qarelease Team Migration UI:
  //   1. POST /mapping/user/path/csv — upload path-based CSV mapping
  //   2. POST /move/newmultiuser/create/job — create migration job
  //   3. PUT  /move/newmultiuser/update/{jobId} — set migration options
  //   4. POST /move/newmultiuser/create/{jobId} — start migration
  if (runtimeConfig?.userId) {
    const token = await login();
    const contentOrigin = (() => { try { return new URL(runtimeConfig.baseUrl).origin; } catch { return runtimeConfig.baseUrl; } })();

    // The qarelease Team-Migration UI authenticates content calls with HTTP Basic auth —
    // base64(`${userId}:${md5(password)}`) — NOT the JWT bearer token. The path-mapping
    // endpoint resolves the user's clouds from this Basic credential; with the JWT it can't,
    // so cfMappingCachesList comes back empty (confirmed via a DevTools capture of the working
    // request). Build the same credential here and use it for all content newmultiuser calls.
    const contentAuth = (() => {
      if (runtimeConfig.basicAuth) {
        const raw = String(runtimeConfig.basicAuth).trim();
        return raw.toLowerCase().startsWith('basic ') ? raw : `Basic ${raw}`;
      }
      const md5pw = require('crypto').createHash('md5').update(runtimeConfig.password || '').digest('hex');
      const b64 = Buffer.from(`${runtimeConfig.userId}:${md5pw}`).toString('base64');
      return `Basic ${b64}`;
    })();
    logger.info(`CloudFuze content: using Basic auth for userId=${runtimeConfig.userId}`);

    // Resolve the destination path/folder-id defaults by cloud type.
    const resolveDestPath = (p) => {
      if (p) return p;
      const dcn = String(context.destCloudName || context.destinationProvider || '').toUpperCase();
      if (dcn.includes('SHAREPOINT')) return '/SANITY DATAA/Documents';
      if (dcn.includes('SHARED_DRIVE') || dcn.includes('GOOGLEDRIVE') || dcn.includes('GOOGLE_DRIVE')) return '/OSM';
      return '/';
    };
    const dcnUpper = String(context.destCloudName || context.destinationProvider || '').toUpperCase();
    // '200' is NOT a valid SharePoint id and never was. Real destination ids from /filefolder have
    // the form `/<cloudId>/<graphSiteId>:<TYPE>` with TYPE in { SITE, DOCUMENT_LIBRARY, FOLDER }, and
    // the wizard depends on that `:TYPE` suffix — for GOOGLE_SHARED_DRIVES → SHAREPOINT_ONLINE_BUSINESS
    // it splits toRootId on ':' and branches on FOLDER / DOCUMENT_LIBRARY (multiUserMapping.js ~16987).
    // It is left as-is only because the isCSV route in use does not send root ids at all; switching to
    // the folder route (folder:"true") requires resolving the real composite id first.
    const destFolderId = context.destRootId || (dcnUpper.includes('SHAREPOINT') ? '200' : 'root');

    const pathOverride   = (env.CONTENT_SOURCE_PATH_OVERRIDE || '').trim();
    const rootIdOverride = (env.CONTENT_SOURCE_ROOT_ID_OVERRIDE || '').trim();

    // ── Build transfer units: one CloudFuze workspace pair per selected user ──
    // Multi-user: context.userFolderMappings has one entry per Map-Users pair (each with its
    // own seeded folder). Single-user / legacy: synthesize one unit from the seeded folder.
    // A diagnostic CONTENT_SOURCE_PATH_OVERRIDE forces the single-unit path.
    // A Shared Drive folder id on its own is not enough for CloudFuze to read the folder: given one,
    // it reports the folder as a single object (job …aad8, "Total: 1") or, with pickInsideFolder=true,
    // finds nothing inside it at all (job …ab66, "Total: 0") — while the folder really held 77 files.
    // Passing the DRIVE id as the root gives the scan its Shared Drive context; sourceFolderPath still
    // says which folder inside the drive to take.
    // A Google Shared Drive migrates as the DRIVE, not as a folder inside it. Proven by comparing
    // job 6a8c4f2d — the only Shared Drive job on this server that ever moved data — against every
    // failing one:
    //
    //   worked   sourceFolderPath "/QA_TeamDrive"        fromRootId "0AJoAzUBzPvRXUk9PVA"  396 items
    //   failed   sourceFolderPath "/Agent Shared Drive"  fromRootId "1Jtyvw…"                0 items
    //
    // Passing the drive id while still naming a subfolder as the path (an earlier attempt) also
    // scans nothing: the id and the path have to describe the same object. Reproducing the worked
    // configuration migrated 63 items (37 files, 26 folders) end to end.
    //
    // The seeded folder still arrives as a folder at the destination, because it is a child of the
    // drive and the tree is preserved — so the validator's expectations do not change.
    const isSharedDrive = /SHARED_DRIVE/i.test(String(context.sourceCloudName || ''));
    const sharedDriveRootId = isSharedDrive ? (context.sourceDriveId || null) : null;
    const sharedDriveName = isSharedDrive
      ? String(context.sourceDriveName || env.GOOGLE_SHARED_DRIVE_NAME || '').trim()
      : '';
    if (sharedDriveRootId) {
      logger.info(`CloudFuze content: Shared Drive source — migrating the drive itself `
        + `(id ${sharedDriveRootId}${sharedDriveName ? `, "${sharedDriveName}"` : ''}); a subfolder id scans nothing`);
    }

    let units;
    if (Array.isArray(context.userFolderMappings) && context.userFolderMappings.length > 0 && !pathOverride) {
      units = context.userFolderMappings.map((u) => ({
        sourceEmail: u.sourceEmail || context.sourceEmail,
        destinationEmail: u.destinationEmail || context.destinationEmail,
        // For a Shared Drive both fields describe the DRIVE; otherwise keep the caller's folder.
        sourcePath: (sharedDriveRootId && sharedDriveName) ? `/${sharedDriveName}` : (u.sourcePath || '/'),
        fromRootId: sharedDriveRootId || u.sourceRootId || u.sourcePath || '/',
        folderRootId: sharedDriveRootId || u.sourceRootId || null,
        // Kept for the report so the QA output still names the folder the run seeded.
        seededFolderPath: u.sourcePath || null,
        destinationPath: resolveDestPath(u.destinationPath),
      }));
    } else {
      const sourcePath = pathOverride || context.sourceTestDataPath || context.sourcePath || '/';
      units = [{
        sourceEmail: context.sourceEmail,
        destinationEmail: context.destinationEmail,
        sourcePath: (sharedDriveRootId && sharedDriveName && !pathOverride) ? `/${sharedDriveName}` : sourcePath,
        fromRootId: rootIdOverride || sharedDriveRootId || context.sourceRootId || sourcePath,
        folderRootId: rootIdOverride || sharedDriveRootId || context.sourceRootId || null,
        seededFolderPath: sourcePath,
        destinationPath: resolveDestPath(context.destinationPath),
      }];
    }

    logger.info(`CloudFuze triggerMigration (content team): ${units.length} unit(s), adminSrc=${context.sourceCloudId}, adminDst=${context.destCloudId}`);

    // ── Per-user sub-clouds ───────────────────────────────────────────────────
    // Each provisioned user has its OWN source/dest sub-cloud id under the admin cloud
    // (e.g. alex = 69e73afd…c91, not the admin 69e73af9…c8b). Using the admin cloud id makes
    // EVERY workspace show admin→admin. So we initiate the permission mapping, read
    // get/permissions, and attach each user's sub-cloud ids — the migration is then attributed
    // to the right source/destination user.
    try {
      await axios.post(`${contentOrigin}/proxyservices/v1/mapping/permissiondetiails/${context.sourceCloudId}/${context.destCloudId}`, {},
        migrationAxiosConfig({ headers: { Authorization: contentAuth, 'Content-Type': 'application/json' }, timeout: 40000 }));
    } catch (e) { logger.warn(`CloudFuze permission init failed (${e?.response?.status || e.message})`); }

    // Upload OUR permission mapping (Map Users pairs) as the manual mapping CSV — the same
    // step + endpoint the CloudFuze UI uses. This OVERRIDES the email auto-match with our
    // explicit source→destination user pairs (e.g. leo@gmail.com.com → leo@fuzebot.io) before
    // the migration reads them. Header: "Source Email,Destination Email".
    if (context.contentOptions?.permissions !== false) {
      const permRows = (context.userEmailMappings || [])
        .filter((m) => m?.sourceEmail && m?.destinationEmail)
        .map((m) => `${m.sourceEmail},${m.destinationEmail}`);
      if (permRows.length > 0) {
        const permCsv = ['Source Email,Destination Email', ...permRows].join('\r\n');
        const mmUrl = `${contentOrigin}/proxyservices/v1/mapping/user/manualmapping/csv`
          + `?sourceCloudId=${encodeURIComponent(context.sourceCloudId)}&destCloudId=${encodeURIComponent(context.destCloudId)}`;
        try {
          const mmRes = await axios.post(mmUrl, permCsv, migrationAxiosConfig({
            headers: { Authorization: contentAuth, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            timeout: 40000,
          }));
          const errLines = Array.isArray(mmRes.data) ? mmRes.data.length : 0;
          logger.info(`CloudFuze permission mapping CSV uploaded (manualmapping/csv): ${permRows.length} pair(s), HTTP ${mmRes.status}${errLines ? `, ${errLines} unmatched/error line(s)` : ''}`);
        } catch (mmErr) {
          logger.warn(`CloudFuze manualmapping/csv upload failed (${mmErr?.response?.status || mmErr.message}) — falling back to CloudFuze email auto-match`);
        }
      }
    }

    const subCloudByEmail = {};        // by SOURCE email → { src sub-cloud, auto-dst, destEmail }
    const destSubCloudByEmail = {};    // by DEST email → that user's DEST sub-cloud id
    const permissionMapping = []; // surfaced in the result + logged for visibility
    try {
      const gp = `${contentOrigin}/proxyservices/v1/mapping/user/clouds/get/permissions`
        + `?sourceCloudId=${encodeURIComponent(context.sourceCloudId)}&destCloudId=${encodeURIComponent(context.destCloudId)}&pageNo=1&pageSize=500`;
      const gpRes = await axios.get(gp, migrationAxiosConfig({ headers: { Authorization: contentAuth, 'X-Requested-With': 'XMLHttpRequest' }, timeout: 40000 }));
      for (const p of (Array.isArray(gpRes.data) ? gpRes.data : [])) {
        const email = String(p?.sourceCloudDetails?.emailId || '').toLowerCase();
        const destEmail = p?.destCloudDetails?.emailId || null;
        // Index each user's DESTINATION sub-cloud by their email so we can route a unit to its
        // MAPPED destination user (e.g. alex→erik uses erik's dest sub-cloud, not alex's).
        const destEmailLc = String(destEmail || '').toLowerCase();
        if (destEmailLc && p?.destCloudDetails?.id) destSubCloudByEmail[destEmailLc] = p.destCloudDetails.id;
        if (email && p?.sourceCloudDetails?.id) {
          subCloudByEmail[email] = { src: p.sourceCloudDetails.id, dst: p?.destCloudDetails?.id, destEmail };
          permissionMapping.push({
            sourceEmail: p.sourceCloudDetails.emailId,
            destinationEmail: destEmail,
            sourceSubCloudId: p.sourceCloudDetails.id,
            destSubCloudId: p?.destCloudDetails?.id || null,
            provisioned: p?.sourceCloudDetails?.provisionedUser !== false,
          });
        }
      }
      // ── PERMISSION MAPPING (this is what the migration applies) ──────────────
      logger.info(`CloudFuze PERMISSION MAPPING — ${permissionMapping.length} user pair(s) (source user → destination user, by CloudFuze email match):`);
      for (const pm of permissionMapping) {
        logger.info(`  • ${pm.sourceEmail}  →  ${pm.destinationEmail}  ${pm.sourceEmail.toLowerCase() === String(pm.destinationEmail || '').toLowerCase() ? '(same)' : '(remapped)'} [src ${pm.sourceSubCloudId} → dst ${pm.destSubCloudId}]`);
      }
    } catch (e) {
      logger.warn(`CloudFuze content get/permissions failed (${e?.response?.status || e.message}) — falling back to admin cloud (workspaces will show admin)`);
    }
    // Which mapping each migrated user actually uses (intersection of Map-Users selection × permission mapping).
    logger.info(`CloudFuze PERMISSION MAPPING applied to this run (${units.length} user(s)):`);
    for (const u of units) {
      const sc = subCloudByEmail[String(u.sourceEmail || '').toLowerCase()];
      u.srcCloudId = sc?.src || context.sourceCloudId;
      // Destination sub-cloud = the MAPPED destination user's sub-cloud (from Map Users), NOT
      // the source user's auto-matched dest. This is what makes alex→erik route to erik.
      const mappedDestSub = destSubCloudByEmail[String(u.destinationEmail || '').toLowerCase()];
      u.dstCloudId = mappedDestSub || sc?.dst || context.destCloudId;
      u.attributed = Boolean(sc?.src);
      u.permDestEmail = u.destinationEmail || sc?.destEmail;
      logger.info(`  • ${u.sourceEmail} → ${u.permDestEmail}  | folder "${u.sourcePath}" (id=${u.fromRootId}) → "${u.destinationPath}"  | src-cloud ${u.srcCloudId} → dst-cloud ${u.dstCloudId}${u.attributed ? '' : ' (admin fallback)'}${mappedDestSub ? '' : ' [dest not in permission list — using source auto-dest]'}`);
    }

    // ── Force explicit permission overrides into CloudFuze's permission store ──────────
    // manualmapping/csv only fills users with NO email auto-match; it can't override an
    // existing same-email match (e.g. a swap alex→erik). PUT /mapping/user/permission/update
    // (source user's sub-cloud → MAPPED dest user's sub-cloud, empty body) forces it — the same
    // call the UI's pencil-edit makes. We apply it only where our mapped dest differs from the
    // current (auto) dest, so the Permission Mapping store matches our mapping.
    if (context.contentOptions?.permissions !== false) {
      for (const m of (context.userEmailMappings || [])) {
        const se = String(m?.sourceEmail || '').toLowerCase();
        const de = String(m?.destinationEmail || '').toLowerCase();
        if (!se || !de) continue;
        const sc = subCloudByEmail[se];
        const currentDest = String(sc?.destEmail || '').toLowerCase();
        if (!sc?.src || currentDest === de) continue; // not resolvable, or already correct
        const dstSub = destSubCloudByEmail[de];
        if (!dstSub) continue; // mapped dest user not provisioned on destination
        try {
          const upUrl = `${contentOrigin}/proxyservices/v1/mapping/user/permission/update`
            + `?sourceAdminCloudId=${encodeURIComponent(context.sourceCloudId)}&destAdminCloudId=${encodeURIComponent(context.destCloudId)}`
            + `&sourceCloudId=${encodeURIComponent(sc.src)}&destCloudId=${encodeURIComponent(dstSub)}`;
          await axios.put(upUrl, {}, migrationAxiosConfig({ headers: { Authorization: contentAuth, 'Content-Type': 'application/json' }, timeout: 30000 }));
          logger.info(`CloudFuze permission override forced: ${m.sourceEmail} → ${m.destinationEmail} (was → ${sc.destEmail || '?'})`);
        } catch (upErr) {
          logger.warn(`CloudFuze permission/update ${se}→${de} failed (${upErr?.response?.status || upErr.message})`);
        }
      }
    }

    // ── Step 1: Map each unit's source folder → destination (creates one pair each) ──
    // POST /mapping/user/unmapped/list with the user's SUB-cloud ids attributes the pair to that
    // user. Clear stale mappings once, then map every unit.
    try {
      const delUrl = `${contentOrigin}/proxyservices/v1/mapping/deleteAll/mapplist`
        + `?sourceAdminCloudId=${encodeURIComponent(context.sourceCloudId)}&destAdminCloudId=${encodeURIComponent(context.destCloudId)}`;
      const delRes = await axios.delete(delUrl, migrationAxiosConfig({
        headers: { Authorization: contentAuth, 'X-Requested-With': 'XMLHttpRequest' },
        timeout: 30000,
      }));
      logger.info(`CloudFuze content: cleared stale mappings (HTTP ${delRes.status})`);
    } catch (delErr) {
      logger.warn(`CloudFuze content deleteAll/mapplist failed (${delErr?.response?.status || delErr.message}) — continuing`);
    }

    // NOTE ON ORDER: this must run AFTER deleteAll/mapplist above. It was originally placed
    // before it, so the mappings were registered and then wiped one second later — the upload
    // returned 200 with an empty cfMappingCachesList and the migration still saw nothing.
    // ── Step 1a: Register the PATH mapping (source folder → destination folder) ───────
    // This step is described at the top of this function as step 1 of the Team Migration flow
    // ("POST /mapping/user/path/csv — upload path-based CSV mapping") but was never implemented:
    // the only CSV we ever uploaded was manualmapping/csv, which maps USERS, not PATHS. Without a
    // registered path pair CloudFuze knows who to migrate but not which folder, so its scan returns
    // nothing — every content job in this project's history has reported 0 items moved.
    //
    // The column header is not documented anywhere we have. CloudFuze echoes unmatched/error rows
    // back the way manualmapping/csv does, so the full response is logged verbatim: if the header is
    // wrong the reply tells us what it wanted, which is far cheaper than guessing blind.
    let pathCsvId = null;
    let pathCsvName = null;
    try {
      const pathRows = units
        .filter((u) => u.sourcePath && u.destinationPath)
        .map((u) => `${u.sourceEmail},${u.sourcePath},${u.destinationEmail},${u.destinationPath}`);
      if (pathRows.length > 0) {
        const pathCsv = ['Source User,Source Folder,Destination User,Destination Path', ...pathRows].join(String.fromCharCode(13,10));
        const pathUrl = `${contentOrigin}/proxyservices/v1/mapping/user/path/csv`
          + `?sourceCloudId=${encodeURIComponent(context.sourceCloudId)}&destCloudId=${encodeURIComponent(context.destCloudId)}`;
        logger.info(`CloudFuze path mapping CSV → POST ${pathUrl}
${pathCsv}`);
        // Content-Type MUST be */* here. Proven by probing the endpoint directly:
        //   application/json      → 200 but the body is never read (empty list for a real CSV, for
        //                            garbage, and for an empty body alike)
        //   text/csv, text/plain, application/octet-stream, application/csv → 500
        //   multipart/form-data   → the parser reads the MIME headers as rows and stops at the
        //                            blank line before the content, so the CSV is never reached
        //   */*                   → cfMappingCachesList comes back populated — the mapping registers
        const pathRes = await axios.post(pathUrl, pathCsv, migrationAxiosConfig({
          headers: { Authorization: contentAuth, 'Content-Type': '*/*', 'X-Requested-With': 'XMLHttpRequest' },
          timeout: 40000,
          validateStatus: () => true,
        }));
        logger.info(`CloudFuze path mapping CSV response: HTTP ${pathRes.status} ${JSON.stringify(pathRes.data).slice(0, 500)}`);
        const uploaded = Array.isArray(pathRes.data?.cfMappingCachesList) ? pathRes.data.cfMappingCachesList : [];
        pathCsvId = uploaded[0]?.csvId ?? null;
        pathCsvName = uploaded[0]?.csvName ?? null;
        const errorLines = pathRes.data?.errorLines;
        if (Array.isArray(errorLines) && errorLines.length > 0) {
          logger.warn(`CloudFuze path/csv rejected ${errorLines.length} line(s): ${JSON.stringify(errorLines).slice(0, 300)}`);
        }
      }
    } catch (pathErr) {
      logger.warn(`CloudFuze path/csv upload failed (${pathErr?.response?.status || pathErr.message}) — continuing`);
    }

    // ── Step 1b: run CloudFuze's OWN mapping validation, then read its verdict ──────
    // Previously this step POSTed /mapping/user/unmapped/list and declared PASS whenever a row came
    // back. That was our verdict, not CloudFuze's: the row comes back for an unvalidated mapping
    // too, so every run logged "PASS ✓" while CloudFuze still held mapped:false. Worse,
    // unmapped/list CREATES a second mapping row, so cache/list reported 2 pairs for one uploaded
    // pair. Both behaviours are gone.
    //
    // The real sequence, from the Team-Migration wizard (multiUserMapping.js —
    // fetchCsvValidationStatus ~22215, fetchNewValidationStatus ~22253):
    //   1. POST /mapping/download/csvcreator/{csvId}/asynchronous?...&first=true  ← starts validation
    //   2. POST /mapping/check/csvvalidationstatus/{csvId}?...                    ← poll until ready
    // Both are POST. csvId is the SMALL INTEGER csvId off the mapping row, not the Mongo id — the
    // Mongo id returns HTTP 500. Calling step 2 without step 1 returns "Total Saved Count :0" and
    // validates nothing, which is why the mapping never resolved.
    const cfUserId = runtimeConfig.userId;
    if (pathCsvId != null && cfUserId) {
      const vQuery = `userId=${encodeURIComponent(cfUserId)}`
        + `&sourceAdminCloudId=${encodeURIComponent(context.sourceCloudId)}`
        + `&destAdminCloudId=${encodeURIComponent(context.destCloudId)}`;
      try {
        const kickUrl = `${contentOrigin}/proxyservices/v1/mapping/download/csvcreator/${pathCsvId}/asynchronous`
          + `?${vQuery}&csvName=${encodeURIComponent(pathCsvName || '')}&first=true`;
        const kickRes = await axios.post(kickUrl, null, migrationAxiosConfig({
          headers: { Authorization: contentAuth, 'Content-Type': 'application/json' },
          timeout: 60000,
        }));
        logger.info(`CloudFuze mapping validation started (csvId=${pathCsvId}): ${JSON.stringify(kickRes.data)}`);
      } catch (kickErr) {
        logger.warn(`CloudFuze csvcreator/asynchronous failed (${kickErr?.response?.status || kickErr.message}) — polling anyway`);
      }

      const statusUrl = `${contentOrigin}/proxyservices/v1/mapping/check/csvvalidationstatus/${pathCsvId}?${vQuery}`;
      let ready = false;
      for (let attempt = 1; attempt <= CSV_VALIDATION_MAX_POLLS; attempt++) {
        await new Promise((r) => setTimeout(r, CSV_VALIDATION_POLL_MS));
        let body = '';
        try {
          const res = await axios.post(statusUrl, null, migrationAxiosConfig({
            headers: { Authorization: contentAuth, 'Content-Type': 'application/json' },
            timeout: 30000,
          }));
          body = String(res.data ?? '');
        } catch (pollErr) {
          logger.warn(`CloudFuze csvvalidationstatus poll ${attempt} failed (${pollErr?.response?.status || pollErr.message})`);
          continue;
        }
        logger.info(`CloudFuze mapping validation poll ${attempt}/${CSV_VALIDATION_MAX_POLLS}: ${body}`);
        if (/report is ready/i.test(body)) { ready = true; break; }
      }
      if (!ready) {
        logger.warn(`CloudFuze mapping validation did not report ready within ${CSV_VALIDATION_MAX_POLLS} `
          + `poll(s) (${Math.round((CSV_VALIDATION_MAX_POLLS * CSV_VALIDATION_POLL_MS) / 1000)}s) — reading `
          + 'whatever verdict exists. An unresolved mapping is the known precursor to a 1-item scan; '
          + 'raise CONTENT_CSV_VALIDATION_MAX_POLLS if this keeps timing out.');
      }
    } else {
      logger.warn(`CloudFuze mapping validation skipped (csvId=${pathCsvId}, userId=${cfUserId ? 'set' : 'missing'}) — the verdict below is therefore unvalidated`);
    }

    // ── Step 1c: read CloudFuze's verdict off the mapping rows ──────────────────
    // cache/list is now authoritative. CloudFuze states the reason a pair cannot migrate in
    // userErrorDescription (e.g. "Please Make this as Licensed user" for an unlicensed destination
    // user) and flags it via provisionedUser / licenced / failMapping / pathException. None of those
    // fields were read before, so a pair CloudFuze had already rejected was reported as PASS and
    // submitted anyway — the job then ran to PROCESSED having moved nothing.
    let cachedRows = [];
    try {
      const cacheUrl = `${contentOrigin}/proxyservices/v1/mapping/user/cache/list`
        + `?sourceCloudId=${encodeURIComponent(context.sourceCloudId)}&destCloudId=${encodeURIComponent(context.destCloudId)}&pageNo=1&pageSize=500&matchBy=`;
      const cacheRes = await axios.get(cacheUrl, migrationAxiosConfig({
        headers: { Authorization: contentAuth, 'X-Requested-With': 'XMLHttpRequest' },
        timeout: 30000,
      }));
      const raw = cacheRes.data;
      cachedRows = Array.isArray(raw)
        ? raw
        : (Array.isArray(raw?.cfMappingCachesList) ? raw.cfMappingCachesList
          : (Array.isArray(raw?.content) ? raw.content : []));
      logger.info(`CloudFuze content cache/list: ${cachedRows.length} mapping row(s)`);
    } catch (cacheErr) {
      logger.warn(`CloudFuze content cache/list failed (${cacheErr?.response?.status || cacheErr.message})`);
    }

    const norm = (v) => String(v || '').trim().toLowerCase();
    for (const u of units) {
      // Match on source email + source folder path; fall back to source email alone when exactly one
      // row carries it, so a path CloudFuze normalised ("QA/Documents" → "/QA/Documents") still pairs.
      const byBoth = cachedRows.filter((r) => norm(r?.sourceCloudDetails?.emailId) === norm(u.sourceEmail)
        && norm(r?.sourceCloudDetails?.folderPath) === norm(u.sourcePath));
      const byEmail = cachedRows.filter((r) => norm(r?.sourceCloudDetails?.emailId) === norm(u.sourceEmail));
      const row = byBoth[0] || (byEmail.length === 1 ? byEmail[0] : null);

      if (!row) {
        u.validated = false;
        u.srcReview = 'FAIL';
        u.dstReview = 'FAIL';
        u.blockReason = 'no mapping row returned by CloudFuze for this pair';
        logger.warn(`CloudFuze CSV VALIDATION [${u.sourceEmail} "${u.sourcePath}"]: FAIL ✗ — ${u.blockReason}`);
        continue;
      }

      const verdict = contentMappingVerdict(row, u);

      // Per-user SUB-cloud ids as CloudFuze resolved them. These are what the pair must carry: a
      // named user in the CSV resolves to their own sub-cloud, not the admin cloud we started from.
      if (verdict.srcCloudId) u.srcCloudId = verdict.srcCloudId;
      if (verdict.dstCloudId) u.dstCloudId = verdict.dstCloudId;
      u.teamFolder = verdict.teamFolder;
      u.migrateFolderName = verdict.migrateFolderName;
      // THE paths as CloudFuze stored them. It normalises what the CSV gave it — "QA/Documents"
      // becomes "/QA/Documents" — and then create/job must send back exactly that. Sending the
      // un-normalised form makes the server reject the pair with
      //   errorDescription: "Migration not Allowed for wrong CSV paths", processStatus: CONFLICT
      // and attach 0 pairs. That error is set on the WORKSPACE, not returned by any call we make,
      // which is why every content run since June looked silent rather than rejected.
      u.registeredSourcePath = (row.sourceCloudDetails || {}).folderPath || null;
      u.registeredDestPath = (row.destCloudDetails || {}).folderPath || null;
      u.srcReview = verdict.srcReview;
      u.dstReview = verdict.dstReview;
      u.validated = verdict.validated;
      u.blockReason = verdict.blockReason;

      // CloudFuze leaves the mapping unresolved: `mapped` stays false and neither side gets a
      // pathRootFolderId, so the job attaches 0 pairs and nothing migrates. Cause still unknown —
      // these have been tested and ELIMINATED, so do not re-spend time on them:
      //   • source type            — My Drive (G_SUITE) fails identically to Shared Drive
      //   • destination membership — a site the destination user IS a member of fails the same way
      //   • destination licensing  — provisionedUser true, no userErrorDescription
      //   • CSV header             — correct now; the row registers and validation reports ready
      //   • validation not run     — csvcreator + csvvalidationstatus complete first
      //   • route / root ids       — folder:"true" with real composite ids, and teamFolder, all 0 pairs
      // Warn rather than fail: which field flips on a successful run has never been observed, so this
      // is not safe to treat as a hard gate. The hard stop is the totalPairsCount check after start.
      const dstPathRoot = (row.destCloudDetails || {}).pathRootFolderId;
      const srcPathRoot = (row.sourceCloudDetails || {}).pathRootFolderId;
      // Report this at INFO, not WARN, and do not predict failure from it. A control run of the
      // known-working Box combination (job 6a8d0b9e, BOX_BUSINESS → SHAREPOINT) returned exactly the
      // same mapped=false with both pathRootFolderId null. This endpoint reports that for healthy
      // pairs too, so it does not indicate that the job will migrate nothing — the earlier wording
      // claimed it did, and that claim sent two days of debugging down the wrong path.
      if (verdict.mapped !== true || dstPathRoot == null) {
        logger.info(
          `CloudFuze mapping row unresolved for ${u.sourceEmail} "${u.sourcePath}" → "${u.destinationPath}" `
          + `(mapped=${verdict.mapped}, source pathRootFolderId=${srcPathRoot}, destination pathRootFolderId=${dstPathRoot}). `
          + 'Informational only: the working Box combination reports the same values. Judge the job by '
          + 'the workspace totalFilesAndFolders and by what reaches the destination, not by this row.'
        );
      }

      if (u.validated) {
        logger.info(`CloudFuze CSV VALIDATION [${u.sourceEmail} "${u.sourcePath}" → "${u.destinationPath}"]: PASS ✓  (Source Path Review: ${u.srcReview}, Destination Path Review: ${u.dstReview}, mapped=${verdict.mapped}, teamFolder=${u.teamFolder})`);
      } else {
        logger.error(`CloudFuze CSV VALIDATION [${u.sourceEmail} "${u.sourcePath}" → "${u.destinationPath}"]: FAIL ✗ — ${u.blockReason}`);
      }
    }

    // ── Validation gate: per-pair — skip failed, migrate the rest ──────────────
    // Each pair is validated via CloudFuze's unmapped/list resolution. Pairs that FAIL are
    // dropped (never submitted to create/job, so they don't even produce a conflict row);
    // passing pairs migrate. Only abort if NOTHING passes (a 0-pair job is pointless).
    const passedUnits = units.filter((u) => u.validated);
    const failedUnits = units.filter((u) => !u.validated);
    logger.info(`CloudFuze CSV VALIDATION summary: ${passedUnits.length}/${units.length} PASS, ${failedUnits.length} FAIL`);
    for (const u of failedUnits) {
      logger.warn(`CloudFuze CSV VALIDATION: SKIPPING ${u.sourceEmail} "${u.sourcePath}" — ${u.blockReason || `Source ${u.srcReview}/Destination ${u.dstReview}`}; this pair is NOT migrated`);
    }
    if (passedUnits.length === 0 && env.CONTENT_REQUIRE_CSV_MAPPING !== 'false') {
      throw new Error(
        `CloudFuze content: ALL ${units.length} pair(s) failed validation — nothing to migrate. `
        + failedUnits.map((u) => `${u.sourceEmail} "${u.sourcePath}" → ${u.destinationEmail}: ${u.blockReason || 'unknown reason'}`).join(' | ')
      );
    }
    logger.info(`CloudFuze CSV VALIDATION: migrating ${passedUnits.length} passed pair(s)${failedUnits.length ? `, skipping ${failedUnits.length} failed` : ''} (destFolderId="${destFolderId}")`);

    // (Permission mapping was initialized + our overrides forced earlier — do NOT re-run
    // permissiondetiails here; it would reset our explicit overrides back to email auto-match.)

    // ── Step 2: Create multiuser migration job (documented body shape) ────────
    // Body uses fromRootId/toRootId (real folder IDs), sourceFolderPath/destFolderPath, and
    // folder:"true" — NOT fromMailId/cloudName. totalPairsCount is 0 in this immediate
    // response; it appears as 1+ in the get/moveJob job list once the pair is attached.
    // One workspace pair per VALIDATED transfer unit (failed pairs are never migrated). The
    // folder IDs are the real Box folder ids; toRootId is the resolved destination root.
    // `folder:"true"` and `isCSV:"true"` are two MUTUALLY EXCLUSIVE routes on the server, and we
    // were taking the wrong one. The Team-Migration UI (multiUserMapping.js ~16800) sends
    // `folder:"true"` with real fromRootId/toRootId only when the user picked a folder in the
    // folder-picker; when the pair came from a path CSV it sends `isCSV:"true"` with the PATHS and
    // NO root ids, and the server resolves the paths against the mapping cache we registered in
    // step 1a. We were uploading the path CSV and then asking for the folder-id route, so the
    // registered mapping was never consumed (it stayed mapped:false) and the scan treated the
    // Shared Drive folder id as a single opaque object — CloudFuze's own report said
    // "Total No of Files/Folders: 1", the folder and nothing inside it.
    //
    // Every content pair here comes from the path CSV, so every pair takes the isCSV route.
    // Matching the UI byte-for-byte also drops fromMailId/toMailId (the UI keeps those in a
    // separate EmailObj) and the drive-id fromRootId experiment, which was never justified.
    const workspacePairs = passedUnits.map((u) => ({
      // Per-user SUB-cloud ids (fallback to admin) so CloudFuze attributes each workspace to the
      // right source/destination user instead of the admin.
      fromCloudId: { id: u.srcCloudId },
      toCloudId: { id: u.dstCloudId },
      // Echo back the registered paths, not the ones we typed into the CSV — see the note above.
      // Falls back to the requested path only when the mapping row carried none.
      sourceFolderPath: u.registeredSourcePath || u.sourcePath,
      destFolderPath: u.registeredDestPath || u.destinationPath,
      // fromRootId is REQUIRED on this route, despite the wizard's generic builder omitting it.
      // Proof: the only content jobs on this server that ever scanned anything are Box→SharePoint
      // isCSV jobs, and every one carries a real source root id —
      //   job 6a84316c… sourceFolderPath "/"    fromRootId "0"             totalFilesAndFolders 55
      //   job 6a843cf4… sourceFolderPath "/LFN" fromRootId "409671580491"  totalFilesAndFolders 20
      // i.e. the id OF the folder named in sourceFolderPath. Ours sent null, so CloudFuze had no
      // folder to scan from and rejected the pair with "Migration not Allowed for wrong CSV paths"
      // and totalFilesAndFolders 0.
      // The id must be of the FOLDER named in sourceFolderPath, not the drive containing it.
      // Working job 6a843cf4 pairs sourceFolderPath "/LFN" with fromRootId "409671580491" — the
      // folder id. u.fromRootId prefers the Shared DRIVE id (set further up for the folder-picker
      // route), which makes the scan look at the drive root and find nothing, so prefer the folder.
      fromRootId: u.folderRootId || u.fromRootId || null,
      // The wizard sends the mapping row's own migrateFolderName here and omits teamFolder entirely
      // on the isCSV route (multiUserMapping.js ~16878); teamFolder appears only on the
      // DROPBOX_BUSINESS→G_SUITE variant. We were sending the literal STRING 'null' plus a
      // teamFolder the server never asked for on this route.
      // The wizard sends '' here, never null, on the isCSV route.
      destinationFolderName: u.migrateFolderName ?? '',
      isCSV: 'true',
    }));

    const createJobUrl = `${contentOrigin}/proxyservices/v1/move/newmultiuser/create/job`;
    logger.info(`CloudFuze create multiuser job: POST ${createJobUrl} pairs=${JSON.stringify(workspacePairs)}`);
    const createJobRes = await axios.post(createJobUrl, workspacePairs, migrationAxiosConfig({
      headers: { Authorization: contentAuth, 'Content-Type': 'application/json' },
      timeout: 30000,
    }));
    logger.info(`CloudFuze multiuser job created: ${JSON.stringify(createJobRes.data)}`);

    const jobId =
      createJobRes.data?.id ||
      createJobRes.data?.jobId ||
      (Array.isArray(createJobRes.data) ? createJobRes.data[0]?.id : null);

    if (!jobId) {
      throw new Error(`CloudFuze: newmultiuser create/job returned no job ID — ${JSON.stringify(createJobRes.data)}`);
    }

    // ── Step 3: Update job options (migration settings) ───────────────────────
    const isDelta = context.migrationType === 'DELTA';
    const jobName = (context.jobName || `Agent-${context.sourceProvider || 'content'}-to-${context.destinationProvider || 'content'}-${jobId}`).slice(0, 80);
    // CloudFuze applies this as a "migrate files up to this date" filter (it lands on the workspace
    // as pickFilestoDate). Using TODAY at 00:00 excluded every file the QA flow had just seeded:
    // seeding runs minutes before the migration, so its files are always newer than midnight and
    // fell outside the window. Job 6a8c830c (seeded 17:32, toDate 2026-08-24 00:00) picked 0 files
    // for this reason, while job 6a8c4f2d moved data because its source had been seeded on an
    // earlier day and so fell inside the window.
    //
    // Use the END of today so anything seeded during this run is inside the range. Overridable for
    // a deliberate historical cut.
    // The Shared Drive job that moved data carried pickFilestoDate=null — no cutoff at all — so send
    // no filter for that source. Elsewhere keep a cutoff but use TOMORROW: the previous 'today
    // 00:00' excluded everything the run had just seeded, since seeding happens minutes earlier.
    const toDate = env.CONTENT_MIGRATION_TO_DATE
      || (isSharedDrive ? 'null'
        : new Date(Date.now() + 86400000).toISOString().slice(0, 10) + ' 00:00:00');

    // Migration options selected in the Run Agent "Options" step (context.contentOptions).
    // Each maps to a CloudFuze newmultiuser param. Default = true to preserve prior
    // behaviour when the caller doesn't pass explicit options.
    const o = context.contentOptions || {};
    const opt = (key, def = true) => (o[key] === undefined ? def : Boolean(o[key]));

    const updateParams = [
      `jobName=${encodeURIComponent(jobName)}`,
      // The wizard sends this EMPTY. We were sending "/", and that is the one input that differs
      // between a job CloudFuze accepts and one it rejects with "Migration not Allowed for wrong
      // CSV paths" — with "/" the server also derives a toRootId (a SharePoint drive id) that the
      // wizard job never has, which is what makes the pair mismatch the registered mapping.
      `migrateFolderName=${encodeURIComponent(env.CONTENT_MIGRATE_FOLDER_NAME || '')}`,
      `isDeltaMigration=${isDelta}`,
      // pickInsideFolder was hardcoded true here on the theory that without it CloudFuze treats the
      // pair as one opaque object (job 6a88539a reported "Total No of Files/Folders: 1"). But the
      // same findings doc records job 6a885ddc WITH pickInsideFolder=true reporting "Total: 0" —
      // worse, not better — and a network capture of the wizard's own update call sends neither
      // pickInsideFolder nor teamFoldersMigrate. Since the only content jobs on this server that ever
      // scanned anything came from that UI, default to omitting it and make it opt-in.
      // Both flags were present on the job that moved data and are required together: with only one
      // of them set the scan still reports a single item. Forced on for Shared Drive sources; still
      // opt-in for Box/OneDrive/My Drive, whose working jobs carry neither.
      ...((isSharedDrive || env.CONTENT_PICK_INSIDE_FOLDER === 'true') ? ['pickInsideFolder=true'] : []),
      // "Team Folders" is Google's original name for Shared Drives. It is the only field in the
      // job whose meaning is specific to this source type, and it had been false on every run
      // while migrating a GOOGLE_SHARED_DRIVES cloud — the scan found the folder but never its
      // contents. Set only for Shared Drive sources so Box/OneDrive/My Drive are unaffected.
      // Also omitted by the wizard. Previously implied by "source is a Shared Drive"; now opt-in so
      // the two flags can be varied independently while the scan behaviour is still unexplained.
      ...((isSharedDrive || env.CONTENT_TEAM_FOLDERS_MIGRATE === 'true') ? ['teamFoldersMigrate=true'] : []),
      `fileFolderLink=${opt('sharedLinks')}`,            // Shared Links
      `externalUsers=${opt('externalShares')}`,          // External Shares
      `metaData=${opt('customMetadata')}`,               // Custom Metadata
      `sendComments=${opt('comments')}`,                 // Comments
      `innerFolderPerms=${opt('subFolderPermissions')}`, // Sub-Folder Permissions
      `innerFilePerms=${opt('subFilePermissions')}`,     // Sub-File Permissions
      `versioning=${opt('versionHistory')}`,             // Version History
      `embeddedLinks=${opt('workbookLinks')}`,           // Workbook / embedded links
      `rootFolderPerms=${opt('rootFolderPermissions')}`, // Root Folder Permissions
      `rootFilePerms=${opt('rootFilePermissions')}`,     // Root File Permissions
      `addExternalUserAsGuest=${opt('externalShares')}`,
      `withPermissions=${opt('permissions')}`,
      `notifyInternalUsers=${opt('notifyInternalUsers', false)}`,
      `notifyExternalUsers=${opt('notifyExternalUsers', false)}`,
      'fromDate=null',
      `toDate=${encodeURIComponent(toDate)}`,
      'createdTimeForFiles=false',
      `modifiedTimeForFiles=${opt('preserveTimestamp')}`, // Preserve Timestamp
      // Job Options step: "Replace special characters with" + "Exclude file types"
      `specialCharacter=${encodeURIComponent(context.replaceSpecialChar || '-')}`,
      // notToMoveExtension: comma-separated extensions (no dots), e.g. mp3,mp4,psd
      ...(context.excludeFileTypes ? [`notToMoveExtension=${encodeURIComponent(context.excludeFileTypes)}`] : []),
    ].join('&');

    const updateUrl = `${contentOrigin}/proxyservices/v1/move/newmultiuser/update/${jobId}?${updateParams}`;
    logger.info(`CloudFuze update job options: PUT ${updateUrl}`);
    const updateRes = await axios.put(updateUrl, null, migrationAxiosConfig({
      headers: { Authorization: contentAuth },
      timeout: 30000,
    }));
    logger.info(`CloudFuze update job options response: ${JSON.stringify(updateRes.data)}`);

    // ── Step 4: Start migration ───────────────────────────────────────────────
    const startUrl = `${contentOrigin}/proxyservices/v1/move/newmultiuser/create/${jobId}`;
    logger.info(`CloudFuze start migration: POST ${startUrl}`);
    const startRes = await axios.post(startUrl, null, migrationAxiosConfig({
      headers: { Authorization: contentAuth },
      timeout: 60000,
    }));
    logger.info(`CloudFuze start migration response: ${JSON.stringify(startRes.data)}`);

    // The server echoes the pairs it actually registered in previewDetail. A job that starts with
    // fewer pairs than were submitted migrates nothing for the missing ones and still reports
    // PROCESSED, so the gap has to be raised here — the status alone cannot show it.
    const registered = Array.isArray(startRes.data?.previewDetail) ? startRes.data.previewDetail.length : 0;
    if (registered === 0) {
      throw new Error(`CloudFuze started job ${jobId} with 0 registered pair(s) — ${passedUnits.length} were submitted; nothing would migrate`);
    }
    // previewDetail being populated is NOT proof the job has work. It echoes the submitted pair;
    // totalPairsCount is the count CloudFuze will actually process. Every content job in this
    // project's history started with previewDetail=[1 pair] and totalPairsCount=0, passed this guard
    // on the previewDetail check alone, ran to PROCESSED, and moved nothing.
    // A job that starts with no attached pairs will migrate nothing. That is a migration FAILURE and
    // must never be reported as success — but it is not a crash either: the caller still needs to
    // produce a QA report saying exactly this. Throwing here aborted the whole flow and took the
    // report with it, which is worse for the user than the false success it replaced. Hand the
    // condition back as a verdict and let MigrationAgent route it to the content-report path.
    // CloudFuze records why it refused a pair on the WORKSPACE record, not in any response we get
    // from create/update/start. Read it — it is the difference between "nothing happened" and
    // "Migration not Allowed for wrong CSV paths".
    let workspaceError = null;
    try {
      const wsRes = await axios.get(
        `${contentOrigin}/proxyservices/v1/move/newmultiuser/get/list/${jobId}?page_nbr=1&page_size=5`,
        migrationAxiosConfig({ headers: { Authorization: contentAuth }, timeout: 30000 })
      );
      const ws = (Array.isArray(wsRes.data) ? wsRes.data : [])[0] || {};
      workspaceError = ws.errorDescription || ws.exceptionMessage || null;
      if (workspaceError) {
        logger.error(`CloudFuze workspace rejected the pair: "${workspaceError}" `
          + `(processStatus=${ws.processStatus}, sourceFolderPath=${JSON.stringify(ws.sourceFolderPath)}, `
          + `destFolderPath=${JSON.stringify(ws.destFolderPath)}, toRootId=${JSON.stringify(ws.toRootId)})`);
      } else {
        logger.info(`CloudFuze workspace: processStatus=${ws.processStatus}, no errorDescription`);
      }
    } catch (wsErr) {
      logger.warn(`CloudFuze workspace read failed (${wsErr?.response?.status || wsErr.message})`);
    }

    const attachedPairs = Number(startRes.data?.totalPairsCount ?? 0) || 0;
    // Only a workspace errorDescription means CloudFuze refused the pair. Do NOT gate on
    // attachedPairs: totalPairsCount is 0 in this response even for a healthy job — it is populated
    // only in GET /move/newmultiuser/get/moveJob. Gating on it failed every run on a non-problem.
    const zeroPairsReason = workspaceError
      ? `CloudFuze refused the migration pair: "${workspaceError}". Job ${jobId}; `
        + `${registered} pair(s) submitted, so nothing will migrate. `
        + 'The most common cause is a pair whose paths or root ids do not match the registered '
        + 'mapping — see docs/content-migration-path-mapping-findings.md.'
      : null;
    if (zeroPairsReason) logger.error(zeroPairsReason);
    if (registered < passedUnits.length) {
      logger.warn(`CloudFuze job ${jobId}: only ${registered}/${passedUnits.length} submitted pair(s) were registered by the server`);
    }

    contentMoveId = jobId;

    return {
      jobId,
      status: zeroPairsReason ? 'NO_WORK_ATTACHED' : 'INITIATED',
      zeroPairs: Boolean(zeroPairsReason),
      zeroPairsReason,
      attachedPairs,
      registeredPairs: registered,
      pairsSubmitted: passedUnits.length,
      pairsRegistered: registered,
      rawResponse: startRes.data,
      initiatePath: 'move/newmultiuser',
      // Permission mapping used (source user → destination user, per CloudFuze email match) +
      // the per-user units actually migrated — surfaced for the UI / report.
      permissionMapping,
      migratedUsers: passedUnits.map((u) => ({
        sourceEmail: u.sourceEmail,
        destinationEmail: u.permDestEmail || u.destinationEmail,
        // Report the SEEDED folder, not the drive we asked CloudFuze to migrate. For a Shared
        // Drive those differ: the request names the drive ("/QA_TeamDrive") because that is the
        // only form CloudFuze scans, while what lands at the destination — and what validation
        // must compare — is the seeded folder ("/Agent Shared Drive"), a child of that drive.
        // deepContentCore.resolveUnits() prefers migratedUsers over userFolderMappings, so leaking
        // the drive path here made validation hunt for "QA_TeamDrive" on both sides and find
        // neither, reporting 0 matched against a migration that had moved 83 items.
        sourcePath: u.seededFolderPath || u.sourcePath,
        // The path actually sent to CloudFuze, kept for diagnosis.
        requestedSourcePath: u.sourcePath,
        destinationPath: u.destinationPath,
        attributed: Boolean(u.attributed),
      })),
      // Pairs that failed validation and were skipped (not migrated) — surfaced for the report.
      skippedUsers: failedUnits.map((u) => ({
        sourceEmail: u.sourceEmail,
        destinationEmail: u.destinationEmail,
        sourcePath: u.sourcePath,
        reason: `validation failed (Source ${u.srcReview}/Destination ${u.dstReview})`,
      })),
    };
  }

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
        calendar: Boolean(context.includeCalendar),
        contacts: Boolean(context.includeContacts),
        folder: true,
        metadata: true,
        onlineMove: false,
        archive: context.sourceProvider === 'microsoft',
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

  const paths = initiatePathCandidates(context.sourceCloudId);
  const base = getActiveBaseUrl();
  const basic = basicAuthPayload();
  let lastErr;

  logger.info(`CloudFuze triggerMigration payload: ${JSON.stringify(payload)}`);

  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    // Determine auth clients to try for this path
    // newmultiuser paths may require Basic auth (as seen on qarelease DevTools)
    const isNewMultiuserPath = path.startsWith('move/newmultiuser/create');
    const authVariants = isNewMultiuserPath && basic
      ? [
          { label: 'Bearer', req: () => client.post(path, payload) },
          { label: 'Basic', req: () => axios.post(`${base}/${path}`, payload, migrationAxiosConfig({ headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` }, timeout: 60000 })) },
        ]
      : [{ label: 'Bearer', req: () => client.post(path, payload) }];

    let authErr;
    for (const variant of authVariants) {
      try {
        const res = await retryWithBackoff(variant.req, { label: `CloudFuze POST ${path} (${variant.label})`, maxRetries: 1 });

        logger.info(`Migration initiated via ${base}/${path} (${variant.label})`, {
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
        authErr = err;
        const st = err?.response?.status;
        const errBody = err?.response?.data ? JSON.stringify(err?.response?.data) : '(no body)';
        logger.warn(`CloudFuze POST ${path} (${variant.label}) HTTP ${st}: ${errBody}`);
      }
    }

    lastErr = authErr;
    const st = lastErr?.response?.status;
    const allow = lastErr?.response?.headers?.allow || lastErr?.response?.headers?.Allow;
    if ((st === 405 || st === 404) && i < paths.length - 1) {
      logger.warn(`POST ${base}/${path} → HTTP ${st}${allow ? `; Allow: ${allow}` : ''} — trying next path…`);
      continue;
    }
    if (st === 405) {
      throw new Error(
        `${lastErr?.message || 'HTTP 405'}${allow ? ` (Allow: ${allow})` : ''}. Set MIGRATION_API_INITIATE_PATH from DevTools.`
      );
    }
    if (st === 404 && i < paths.length - 1) continue;
    if (lastErr) throw lastErr;
  }

  throw lastErr || new Error('Migration initiate failed: no path candidates');
}

/**
 * CloudFuze's verdict on one path-CSV mapping row, as a pure function so the pass/fail rule is
 * testable without a live server. `row` is one entry of cfMappingCachesList / cache/list.
 *
 * CloudFuze reports why a pair cannot migrate on the row itself — provisionedUser=false and a
 * human-readable userErrorDescription (e.g. "Please Make this as Licensed user") — plus failMapping
 * and pathException flags. A row is returned even when the mapping is unvalidated, so the row's
 * mere existence proves nothing and must never be read as PASS.
 */
function contentMappingVerdict(row, unit) {
  const src = (row && row.sourceCloudDetails) || {};
  const dst = (row && row.destCloudDetails) || {};
  const sourceEmail = (unit && unit.sourceEmail) || 'source user';
  const destinationEmail = (unit && unit.destinationEmail) || 'destination user';

  const blockers = [];
  if (src.provisionedUser === false) blockers.push(`source user ${sourceEmail} is not provisioned`);
  if (dst.provisionedUser === false) blockers.push(`destination user ${destinationEmail} is not provisioned`);
  if (src.userErrorDescription) blockers.push(`source: ${String(src.userErrorDescription).trim()}`);
  if (dst.userErrorDescription) blockers.push(`destination: ${String(dst.userErrorDescription).trim()}`);
  if (row && row.failMapping === true) blockers.push('CloudFuze flagged failMapping');
  if (row && row.pathException === true) blockers.push('CloudFuze flagged pathException');

  const mapped = Boolean(row && row.mapped === true);
  return {
    validated: blockers.length === 0,
    blockReason: blockers.join('; '),
    // CloudFuze's own review columns; null until validation has run, reported as UNVALIDATED.
    srcReview: src.sourcePathReview || (mapped ? 'PASS' : 'UNVALIDATED'),
    dstReview: dst.destPathReview || (mapped ? 'PASS' : 'UNVALIDATED'),
    mapped,
    // teamFolder belongs to THIS row — the wizard reads it here (multiUserMapping.js ~16605).
    teamFolder: String(Boolean(row && row.teamFolder === true)),
    migrateFolderName: (row && row.migrateFolderName) != null ? row.migrateFolderName : null,
    srcCloudId: src.id || null,
    dstCloudId: dst.id || null,
  };
}

// ─────────────────────────────────────────────────────────────
// STEP 6 — Poll for migration completion
//   New server → GET /email/user/jobs?deltaMigration=&pageNo=0&pageSize=50
//   Legacy     → GET /mail/reports
// Terminal statuses: PROCESSED | PROCESSED_WITH_CONFLICTS | CONFLICT | PAUSE
// New server may return "PROCESS" (without D) — include both forms.
// Content migration statuses (qarelease / newmultiuser):
//   Success (proceed to validation): VERSION_PROCESSED
//   Stop (show report, skip validation): VERSION_NOT_PROCESSED, IN_PROGRESS, CONFLICTS, INPROGRESS
const TERMINAL_STATUSES = new Set([
  'PROCESSED',
  'PROCESS',
  'PROCESSED_WITH_CONFLICTS',
  'PROCESS_WITH_CONFLICTS',
  'PROCESSED_WITH_CONFLICT_AND_PAUSE',
  'CONFLICT',
  'CONFLICTS',
  'PAUSE',
  'FAILED',
  'ERROR',
  // Content migration statuses
  'VERSION_PROCESSED',
  'VERSION_NOT_PROCESSED',
  'NOT_PROCESSED',
]);

// ─────────────────────────────────────────────────────────────
// Content server polling — newmultiuser jobs (team migration)
//   Primary:  GET /proxyservices/v1/move/queue/status?jobId={jobId}
//   Fallback: GET /proxyservices/v1/move/clouds/status/{moveId}  (legacy consumer jobs)
// ─────────────────────────────────────────────────────────────
// Content migration: real terminal states. NOT_PROCESSED / VERSION_NOT_PROCESSED /
// IN_PROGRESS / QUEUED are TRANSIENT (the job is queued or running) — keep polling.
// CloudFuze validates an uploaded path CSV asynchronously (csvcreator → csvvalidationstatus).
// It has answered "CSV report is ready" on the first poll for a single-row CSV; the ceiling is for
// a large CSV, not the normal case.
// Path-CSV validation is what populates pathRootFolderId on the mapping row, and the old ceiling of
// 15 polls x 4s did time out ("still under processing" at the last poll) on a run whose mapping row
// was stale. Raised to a 5-minute margin so the wait is the server's to end, not ours.
//
// This is NOT the cure for the 1-item scan. Probe job 6a8c8932 cleared the stale mappings first,
// validation then answered "CSV report is ready" on poll 1/60 — and the row still came back
// mapped=false with both pathRootFolderId null. Validation completing and the path resolving are
// separate things; only the first is ours to wait for.
// Overridable so this can be tuned without a code change.
const CSV_VALIDATION_POLL_MS = env.CONTENT_CSV_VALIDATION_POLL_MS;
const CSV_VALIDATION_MAX_POLLS = env.CONTENT_CSV_VALIDATION_MAX_POLLS;

const CONTENT_TERMINAL_STATUSES = new Set([
  'PROCESSED', 'PROCESS', 'PROCESSED_WITH_CONFLICTS', 'PROCESS_WITH_CONFLICTS',
  'PROCESSED_WITH_CONFLICT_AND_PAUSE', 'CONFLICT', 'CONFLICTS', 'PAUSE',
  'FAILED', 'ERROR', 'VERSION_PROCESSED',
]);

async function pollContentMigration(moveId, { maxMinutes = 30, intervalMs = 30000, onProgress, executionId } = {}) {
  const contentOrigin = (() => { try { return new URL(runtimeConfig.baseUrl).origin; } catch { return runtimeConfig.baseUrl; } })();
  const queueStatusUrl = `${contentOrigin}/proxyservices/v1/move/queue/status?jobId=${moveId}`;
  const listUrl = `${contentOrigin}/proxyservices/v1/move/newmultiuser/get/list/${moveId}?page_nbr=1&page_size=30`;
  const cloudsStatusUrl = `${contentOrigin}/proxyservices/v1/move/clouds/status/${moveId}`;
  const token = await login();
  const executionService = require('../services/executionService');
  const maxPolls = Math.ceil((maxMinutes * 60 * 1000) / intervalMs);

  // Stop early if the job sits NOT_PROCESSED with 0 files for this many consecutive polls.
  let stuckPolls = 0;
  const STUCK_LIMIT = 6;

  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    const sliceMs = 5000;
    const slices = Math.ceil(intervalMs / sliceMs);
    for (let s = 0; s < slices; s++) {
      await new Promise((r) => setTimeout(r, sliceMs));
      if (executionId && executionService.isCancelled(executionId)) return 'CANCELLED';
    }
    if (executionId && executionService.isCancelled(executionId)) return 'CANCELLED';

    // Try queue/status → get/list → clouds/status in order; use first successful response
    let data = null;
    for (const pollUrl of [queueStatusUrl, listUrl, cloudsStatusUrl]) {
      try {
        const res = await axios.get(
          pollUrl,
          migrationAxiosConfig({ headers: { Authorization: token }, timeout: 30000 })
        );
        // queue/status may return an array; get/list returns a page object with content[]
        const raw = res.data;
        data = Array.isArray(raw)
          ? (raw[0] || null)
          : (raw?.content?.[0] || raw?.data?.[0] || raw);
        if (data) break;
      } catch (err) {
        logger.warn(`CloudFuze content poll ${attempt} via ${pollUrl}: ${err.message}`);
      }
    }

    if (!data) {
      logger.warn(`CloudFuze content poll ${attempt}/${maxPolls} (jobId=${moveId}): no response from any endpoint`);
      if (onProgress) onProgress(attempt, maxPolls, null);
      continue;
    }

    logger.info(`CloudFuze content poll ${attempt}/${maxPolls} (jobId=${moveId}): ${JSON.stringify(data)}`);

    const status = String(
      data?.status || data?.moveStatus || data?.syncStatus || data?.processStatus || data?.jobStatus || ''
    ).toUpperCase().trim();

    const totalCount     = Number(data?.totalCount     || data?.totalFiles     || data?.totalFileAndFolder || 0) || null;
    const processedCount = Number(data?.processedCount || data?.processedFiles || data?.migratedCount || 0) || null;

    lastJobDetails = { workspaceId: moveId, totalCount, processedCount };
    lastJobReport  = data;

    if (onProgress) onProgress(attempt, maxPolls, status || null);

    // Real terminal state → done. A terminal PROCESSED that demonstrably moved nothing is reported as
    // PROCESSED_EMPTY, because 'the run completed' is not a pass when zero files landed.
    //
    // But ABSENT counts are not evidence of zero. This poll response (move/queue/status,
    // move/clouds/status) carries no count fields at all, so totalCount/processedCount are almost
    // always null — and treating null as zero reported PROCESSED_EMPTY on a run that had genuinely
    // migrated 71 items, turning a success into a spurious FAIL in the report. Only a real, non-null
    // zero counts; when the counts are unknown, ask the workspace, and if that is unavailable too,
    // return the status and let validation decide from the destination itself.
    if (CONTENT_TERMINAL_STATUSES.has(status)) {
      const isProcessed = status === 'PROCESSED' || status === 'PROCESS';
      if (!isProcessed) return status;

      const countsKnown = totalCount !== null || processedCount !== null;
      if (countsKnown) {
        if ((processedCount || 0) === 0 && (totalCount || 0) === 0) {
          logger.error(`CloudFuze content job ${moveId} reached ${status} with totalCount=${totalCount}, `
            + `processedCount=${processedCount} — nothing migrated, treating as PROCESSED_EMPTY`);
          return 'PROCESSED_EMPTY';
        }
        return status;
      }

      // Counts unknown: the workspace record does carry totalFilesAndFolders.
      try {
        const wsRes = await axios.get(
          `${contentOrigin}/proxyservices/v1/move/newmultiuser/get/list/${moveId}?page_nbr=1&page_size=5`,
          migrationAxiosConfig({ headers: { Authorization: token }, timeout: 30000 })
        );
        const ws = (Array.isArray(wsRes.data) ? wsRes.data : [])[0] || {};
        const scanned = Number(ws.totalFilesAndFolders ?? NaN);
        if (Number.isFinite(scanned)) {
          lastJobDetails = { workspaceId: moveId, totalCount: scanned, processedCount: scanned };
          if (scanned === 0) {
            logger.error(`CloudFuze content job ${moveId} reached ${status} but the workspace reports `
              + `totalFilesAndFolders=0 — nothing migrated, treating as PROCESSED_EMPTY`);
            return 'PROCESSED_EMPTY';
          }
          logger.info(`CloudFuze content job ${moveId}: ${status}, workspace scanned ${scanned} item(s)`);
          return status;
        }
      } catch (wsErr) {
        logger.warn(`CloudFuze workspace count read failed (${wsErr?.response?.status || wsErr.message})`);
      }

      logger.info(`CloudFuze content job ${moveId}: ${status} with no counts available — reporting `
        + `${status}; validation compares the destination and decides.`);
      return status;
    }

    // NOT_PROCESSED / IN_PROGRESS / QUEUED are transient — keep polling so a queued job
    // gets time to start and scan. Guard: if it stays NOT_PROCESSED with zero files for
    // several consecutive polls, the job has nothing to migrate (e.g. empty path mapping)
    // — stop early instead of waiting the full window.
    if (status === 'NOT_PROCESSED' || status === 'VERSION_NOT_PROCESSED') {
      if (!totalCount) {
        stuckPolls += 1;
        if (stuckPolls >= STUCK_LIMIT) {
          logger.warn(`CloudFuze content poll: status ${status} with 0 files for ${stuckPolls} polls — job has nothing to migrate (check path mapping). Stopping.`);
          return status;
        }
      } else {
        stuckPolls = 0; // files detected — it's progressing
      }
      logger.info(`CloudFuze content poll ${attempt}/${maxPolls}: ${status} (queued, total=${totalCount || 0}) — continuing`);
    } else {
      stuckPolls = 0;
    }
  }

  logger.warn(`CloudFuze content poll: max wait (${maxMinutes} min) reached for jobId=${moveId}`);
  return 'TIMEOUT';
}

async function pollReports(deltaMigration, fromMailId, {
  maxMinutes = 30,
  intervalMs = 60000,
  onProgress,
  executionId,
} = {}) {
  // Content server (qarelease): poll by moveId instead of email
  if (runtimeConfig?.userId && contentMoveId) {
    logger.info(`CloudFuze pollReports: content server detected — polling /move/clouds/status/${contentMoveId}`);
    return pollContentMigration(contentMoveId, { maxMinutes, intervalMs, onProgress, executionId });
  }

  const tokenCandidates = [
    loginToken,
    bearerToken,
    !isNewServer() ? normalizeBearerFromEnv(env.MIGRATION_API_BEARER_TOKEN) : null,
  ].filter(Boolean).filter((t, i, a) => a.indexOf(t) === i); // deduplicate

  if (tokenCandidates.length === 0) {
    logger.warn('CloudFuze: no Bearer JWT for reports polling — falling back to Outlook polling');
    return null;
  }

  // New server: only /email/user/jobs.
  // Legacy (devemail): /mail/reports is the native endpoint — try it first.
  // Fall back to /email/user/jobs in case the server also serves the new-API path.
  const reportsUrlCandidates = isNewServer()
    ? [`${getActiveEmailBaseUrl()}/email/user/jobs`]
    : [`${getActiveBaseUrl()}/mail/reports`, `${getActiveEmailBaseUrl()}/email/user/jobs`];
  let reportsUrl = reportsUrlCandidates[0];
  let reportsUrlFallbackIdx = 1;

  // Active token index — rotated on 401
  let tokenIdx = 0;
  let consecutiveAuthErrors = 0;
  // After all Bearer tokens 401 persistently, try Basic auth on /mail/reports (legacy only)
  let basicAuthExhausted = false;

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

    const activeToken = tokenCandidates[tokenIdx] || null;

    // Build request headers — rotate to Basic auth after all Bearer tokens fail
    let authHeader;
    if (activeToken && !isJwtExpired(activeToken)) {
      authHeader = buildAuthHeader(activeToken);
    } else if (!isNewServer() && !basicAuthExhausted) {
      const basic = basicAuthPayload();
      authHeader = basic ? `Basic ${basic}` : null;
      basicAuthExhausted = true; // only try once
    }

    if (!authHeader) {
      logger.warn('CloudFuze: all report tokens exhausted — falling back to Outlook polling');
      return null;
    }

    try {
      const res = await axios.get(
        reportsUrl,
        migrationAxiosConfig({
          headers: { Authorization: authHeader },
          params: { pageNo: 0, pageSize: 50, deltaMigration, _: Date.now() },
          timeout: 30000,
        })
      );

      const jobs = Array.isArray(res.data) ? res.data : (res.data?.content || []);
      const normFrom = String(fromMailId || '').toLowerCase().trim();

      let matchedDetail = null;
      let matchedJob = null;
      for (const j of jobs) {
        const details = j.mailMigrationDetails || j.details || j.pairs || [];

        // Step 1: find the detail row for this specific fromMailId.
        // The detail row carries the actual per-user email counts (totalCount / processedCount)
        // — these are the numbers shown in the CloudFuze Reports UI under each user pair.
        // The job-level totalCount is always 1 (number of pairs), never email count.
        if (Array.isArray(details) && details.length > 0) {
          const d = details.find(
            (d) => String(d.fromMailId || d.fromEmail || '').toLowerCase() === normFrom
          );
          if (d) {
            matchedJob    = j;
            matchedDetail = d;   // counts MUST come from this row, never job-level
            break;
          }
        }

        // Step 2: some legacy servers put fromMailId at the job level with no details.
        // Only match here if no detail row was found above.
        if (String(j.fromMailId || j.fromEmail || '').toLowerCase() === normFrom) {
          matchedJob = j;
          // matchedDetail stays null — no per-user detail available, counts will be job-level
          break;
        }
      }

      if (!matchedJob) {
        // If the current URL returned 0 jobs and a fallback URL exists, switch to it once
        if (jobs.length === 0 && reportsUrlFallbackIdx < reportsUrlCandidates.length) {
          const nextUrl = reportsUrlCandidates[reportsUrlFallbackIdx++];
          logger.info(`CloudFuze reports poll ${attempt}: 0 jobs from ${reportsUrl} — switching to ${nextUrl}`);
          reportsUrl = nextUrl;
          continue;
        }
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
          `(${jobs.length} job(s) returned via ${reportsUrl}, no-match streak ${noMatchStreak}/${MAX_NO_MATCH})`
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
      // Store full job object for content migration report display
      lastJobReport = { ...matchedJob, _matchedDetail: matchedDetail || null };

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
      const status = err?.response?.status;
      if (status === 401) {
        consecutiveAuthErrors++;
        // Rotate to next token
        if (tokenIdx < tokenCandidates.length - 1) {
          tokenIdx++;
          logger.warn(`CloudFuze reports poll ${attempt}: 401 — rotating to token ${tokenIdx + 1}/${tokenCandidates.length}`);
        } else {
          // All Bearer tokens have failed — if we've had enough consecutive 401s, bail out
          if (consecutiveAuthErrors >= tokenCandidates.length + 1) {
            logger.warn(
              `CloudFuze reports: ${consecutiveAuthErrors} consecutive 401s across all tokens — ` +
              `falling back to Outlook polling`
            );
            return null;
          }
          // Reset to first token and try again next poll
          tokenIdx = 0;
          logger.warn(`CloudFuze reports poll ${attempt}: 401 on all tokens — will retry next cycle`);
        }
      } else {
        consecutiveAuthErrors = 0;
        logger.warn(`CloudFuze reports poll ${attempt} error: ${err.message}`);
      }
    }
  }

  logger.warn(`CloudFuze reports: max wait (${maxMinutes} min) reached for ${fromMailId}`);
  return 'TIMEOUT';
}

/**
 * Single-shot fetch of the current CloudFuze job status for a source email.
 * Used by validation agents to populate the "CloudFuze Migration Status" table
 * without running a polling loop — returns immediately with whatever the API
 * currently reports, or null if the job cannot be found / auth fails.
 *
 * @param {string} fromMailId  Source (from) email to look up
 * @returns {Promise<{workspaceId, totalCount, processedCount, cfStatus}|null>}
 */
async function fetchCurrentJobStatus(fromMailId) {
  // Try cached tokens first; if all are expired or absent, auto-refresh via /mail/register
  // so validation-only runs (no MigrationAgent in the same session) still get a valid token.
  let token = [
    loginToken,
    bearerToken,
    !isNewServer() ? normalizeBearerFromEnv(env.MIGRATION_API_BEARER_TOKEN) : null,
  ].filter(Boolean).find((t) => !isJwtExpired(t)) || null;

  if (!token) {
    try {
      token = await register();
      logger.info('CloudFuze fetchCurrentJobStatus: refreshed JWT via /mail/register');
    } catch (e) {
      logger.warn(`CloudFuze fetchCurrentJobStatus: token refresh failed — ${e.message}`);
      // Fall through to lastJobDetails fallback below
    }
  }

  const reportsUrlList = isNewServer()
    ? [`${getActiveEmailBaseUrl()}/email/user/jobs`]
    : [`${getActiveBaseUrl()}/mail/reports`, `${getActiveEmailBaseUrl()}/email/user/jobs`];

  if (token) {
    try {
      // Try both page sizes — some servers paginate; use 200 to capture more historical jobs
      for (const reportsUrl of reportsUrlList) {
      for (const pageSize of [50, 200]) {
        const res = await axios.get(
          reportsUrl,
          migrationAxiosConfig({
            headers: { Authorization: buildAuthHeader(token) },
            params: { pageNo: 0, pageSize, _: Date.now() },
            timeout: 30000,
          })
        );

        const jobs = Array.isArray(res.data) ? res.data : (res.data?.content || []);
        if (jobs.length === 0 && pageSize === 50) continue; // try larger page
        const normFrom = String(fromMailId || '').toLowerCase().trim();

        let matchedJob = null;
        let matchedDetail = null;
        for (const j of jobs) {
          const details = j.mailMigrationDetails || j.details || j.pairs || [];
          // Find the specific detail row for this fromMailId — counts come from here only
          if (Array.isArray(details) && details.length > 0) {
            const d = details.find(
              (d) => String(d.fromMailId || d.fromEmail || '').toLowerCase() === normFrom
            );
            if (d) {
              matchedJob    = j;
              matchedDetail = d;  // totalCount/processedCount MUST come from this row
              break;
            }
          }
          // Legacy fallback: fromMailId at job level with no details
          if (String(j.fromMailId || j.fromEmail || '').toLowerCase() === normFrom) {
            matchedJob = j;
            break;
          }
        }

        if (!matchedJob) {
          if (pageSize < 200) continue; // retry with bigger page
          logger.info(`CloudFuze fetchCurrentJobStatus: no job for ${fromMailId} via ${reportsUrl} (${jobs.length} jobs)`);
          break; // try next reportsUrl
        }

        const status = String(
          matchedDetail?.syncStatus    || matchedDetail?.status          ||
          matchedDetail?.processStatus || matchedDetail?.migrationStatus ||
          matchedJob.syncStatus        || matchedJob.status              ||
          matchedJob.processStatus     || matchedJob.migrationStatus      || ''
        ).toUpperCase().trim();

        const totalCount     = Number(matchedDetail?.totalCount     || matchedJob.totalCount     || 0) || null;
        const processedCount = Number(matchedDetail?.processedCount || matchedJob.processedCount || 0) || null;
        const workspaceId    = matchedJob.workspaceId || matchedJob.id || matchedJob.jobId || matchedDetail?.workspaceId || null;

        logger.info(`CloudFuze fetchCurrentJobStatus: ${fromMailId} → workspaceId=${workspaceId} status="${status}" ${processedCount}/${totalCount} (via ${reportsUrl})`);
        return { workspaceId, totalCount, processedCount, cfStatus: status || null };
      }
      } // end for reportsUrl
    } catch (err) {
      logger.warn(`CloudFuze fetchCurrentJobStatus error: ${err.message}`);
    }
  }

  // Fallback: use in-memory lastJobDetails populated by pollReports() during this session.
  // This covers the case where /mail/reports returns empty (devemail legacy behaviour) but
  // MigrationAgent already extracted job details while polling.
  const cached = getLastJobDetails();
  if (cached.workspaceId || cached.totalCount) {
    logger.info(`CloudFuze fetchCurrentJobStatus: using cached lastJobDetails for ${fromMailId}`);
    return {
      workspaceId: cached.workspaceId,
      totalCount: cached.totalCount,
      processedCount: cached.processedCount,
      cfStatus: null,
    };
  }

  return null;
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
  isContentServer,
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
  getActiveBaseUrl,
  isNewServer,
  fetchCurrentJobStatus,
  getLastJobReport,
  migrationAxiosConfig,
  contentMappingVerdict,
};
