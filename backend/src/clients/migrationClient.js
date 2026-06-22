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
    // Auto-add /proxyservices/v1 for devemail URLs that arrive without the path prefix
    if (lc.includes('devemail') && !lc.includes('/proxyservices/')) {
      url = url + '/proxyservices/v1';
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

    const appLoginUrls = [
      `${appLoginBase}/app/login`,                   // /proxyservices/v1/app/login
      ...(rootBase !== appLoginBase ? [`${rootBase}/app/login`] : []),  // /app/login (root)
      `${appLoginBase}/email/app/login`,             // /proxyservices/v1/email/app/login
    ];

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

  // 3. cloudName prefix match — for content clouds without email fields (e.g. qarelease).
  // 'box' → 'BOX_BUSINESS', 'sharepoint' → 'SHAREPOINT_ONLINE_BUSINESS', etc.
  if (cloudNameHint) {
    const hint = String(cloudNameHint).toUpperCase().trim();
    const nameHit = clouds.find((c) => {
      const cn = String(c.cloudName || '').toUpperCase();
      return cn === hint || cn.startsWith(hint + '_') || cn.startsWith(hint);
    });
    if (nameHit) {
      logger.info(`CloudFuze findCloudId: matched "${nameHit.cloudName}" via cloudNameHint "${cloudNameHint}"`);
      return { id: extractId(nameHit), cloudName: nameHit.cloudName, memberId: nameHit.memberId };
    }
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
  'IN_PROGRESS',
  'INPROGRESS',
  'NOT_PROCESSED',
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
};
