/**
 * devemailBrowserClient — headless session-based CSV upload.
 *
 * The /email/user/csv endpoint rejects all JWT auth (401) and crashes on Basic auth (500).
 * This module uses Playwright headlessly ONLY to obtain valid browser session cookies,
 * then immediately fires the CSV upload as a plain HTTP request using those cookies.
 * No visible browser window is ever shown.
 */

const { chromium } = require('playwright');
const env    = require('../config/env');
const logger = require('../utils/logger');

const DEVEMAIL_BASE  = 'https://devemail.cloudfuze.com';
const DEVEMAIL_API   = `${DEVEMAIL_BASE}/proxyservices/v1`;
const LOGIN_PAGE     = `${DEVEMAIL_BASE}/pages/index.html`;

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Upload user-mapping CSV via a headless browser session.
 * Logs in to devemail, extracts session credentials, then POSTs the CSV directly.
 * No browser window is shown.
 *
 * @param {Array<{sourceEmail:string, destinationEmail:string}>} pairs
 * @param {{ sourceCloudId:string, destCloudId:string }} opts
 */
async function uploadCSVViaBrowser(pairs, { sourceCloudId, destCloudId, loginEmail: emailOverride, loginPassword: passwordOverride } = {}) {
  const loginEmail    = emailOverride    || env.CLOUDFUZE_OWNER_EMAIL;
  const loginPassword = passwordOverride || env.MIGRATION_APP_LOGIN_PASSWORD;

  if (!loginEmail || !loginPassword) {
    throw new Error(
      'devemailBrowserClient: CLOUDFUZE_OWNER_EMAIL and MIGRATION_APP_LOGIN_PASSWORD must be set'
    );
  }
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error('devemailBrowserClient: pairs must be a non-empty array');
  }
  if (!sourceCloudId || !destCloudId) {
    throw new Error('devemailBrowserClient: sourceCloudId and destCloudId are required');
  }

  // ── build CSV content ────────────────────────────────────────────────
  const csvLines = ['Source Email Address,Destination Email Address'];
  for (const p of pairs) csvLines.push(`${p.sourceEmail},${p.destinationEmail}`);
  const csvContent = csvLines.join('\r\n');

  logger.info(
    `devemailBrowserClient: launching headless Chromium to get session (${pairs.length} pair(s))`
  );

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  // Intercept requests to see what Authorization header the portal uses
  let portalAuthHeader = null;
  page.on('request', (req) => {
    try {
      const url = req.url();
      if (!url.includes('/proxyservices/')) return;
      const auth = req.headers()['authorization'] || '';
      if (auth && !portalAuthHeader) {
        portalAuthHeader = auth;
        logger.info(`devemailBrowserClient: portal request Authorization header: ${auth.slice(0, 60)}...`);
      }
    } catch {}
  });

  // Also intercept login API responses to capture the JWT from the response body/headers.
  // More reliable than scanning localStorage — the portal may use a non-standard storage key.
  let capturedLoginJwt = null;
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.includes('/proxyservices/')) return;
      if (capturedLoginJwt) return;

      const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

      const hdrs = response.headers();
      const hdrToken = (hdrs['authorization'] || hdrs['x-auth-token'] || hdrs['x-access-token'] || hdrs['token'] || '')
        .replace(/^Bearer\s*/i, '').trim();
      if (hdrToken && JWT_RE.test(hdrToken)) {
        logger.info(`devemailBrowserClient: captured JWT from response header of ${url}`);
        capturedLoginJwt = hdrToken;
        return;
      }

      const text = await response.text().catch(() => '');
      if (!text) return;
      const trimmed = text.trim();
      if (JWT_RE.test(trimmed)) {
        logger.info(`devemailBrowserClient: captured JWT from plain-string response of ${url}`);
        capturedLoginJwt = trimmed;
        return;
      }
      try {
        const data = JSON.parse(trimmed);
        const t = data?.token || data?.accessToken || data?.jwtToken ||
          data?.data?.token || data?.result?.token || data?.userVO?.token || data?.response?.token;
        if (t && JWT_RE.test(String(t).trim())) {
          logger.info(`devemailBrowserClient: captured JWT from JSON response of ${url}`);
          capturedLoginJwt = String(t).trim().replace(/^Bearer\s*/i, '').trim();
        }
      } catch { /* not JSON */ }
    } catch { /* closed page */ }
  });

  try {
    // ── 1. Navigate to login page ────────────────────────────────────────
    logger.info(`devemailBrowserClient: navigating to login page…`);
    await page.goto(LOGIN_PAGE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8_000 }); } catch {}

    // ── 2. Fill login form ───────────────────────────────────────────────
    const emailSel = [
      'input[name="email"]',
      'input[name="username"]',
      'input[type="email"]',
      'input[placeholder*="Email" i]',
      'input[placeholder*="mail" i]',
      'input[placeholder*="user" i]',
      'input[id*="email" i]',
      'input[id*="user" i]',
    ].join(', ');

    const emailInput = page.locator(emailSel).first();
    await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
    await emailInput.fill(loginEmail);
    await page.locator('input[type="password"]').first().fill(loginPassword);

    logger.info(`devemailBrowserClient: credentials filled — submitting login…`);

    const submitSel = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Sign In")',
      'button:has-text("Login")',
      'button:has-text("Log In")',
      'button:has-text("SIGN IN")',
      '#loginBtn',
      '#signInBtn',
      '.btn-login',
      '.login-btn',
    ].join(', ');

    await page.locator(submitSel).first().click();

    // Wait for redirect away from login page
    try {
      await page.waitForURL(
        (url) => !url.toString().includes('index.html') && !url.toString().includes('login'),
        { timeout: 20_000 }
      );
    } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 10_000 }); } catch {}

    logger.info(`devemailBrowserClient: logged in — URL = ${page.url()}`);

    // ── 3. Extract JWT from portal localStorage (may differ from API JWT) ──
    const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    const portalJwt = await page.evaluate(() => {
      const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
      const stores = [localStorage, sessionStorage];
      for (const store of stores) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          const val = store.getItem(key);
          if (!val) continue;
          const trimmed = val.trim();
          if (JWT_RE.test(trimmed)) return trimmed;
          try {
            const obj = JSON.parse(trimmed);
            const t = obj?.token || obj?.jwtToken || obj?.accessToken || obj?.userVO?.token || obj?.data?.token;
            if (t && JWT_RE.test(String(t).trim())) return String(t).trim();
          } catch {}
        }
      }
      return null;
    }).catch(() => null);

    if (portalJwt) {
      try {
        const parts = portalJwt.split('.');
        const payload = JSON.parse(Buffer.from(parts[1] + '==', 'base64').toString('utf8'));
        logger.info(`devemailBrowserClient: portal JWT found — sub=${payload.sub} userId=${payload.userId || payload.id || '?'} email=${payload.email || payload.sub || '?'}`);
      } catch {}
    } else {
      logger.info('devemailBrowserClient: no JWT found in portal localStorage — relying on session cookies only');
    }

    // ── 4. POST CSV using portal JWT (if found) + session cookies ────────
    const uploadUrl = `${DEVEMAIL_API}/email/user/csv/${sourceCloudId}/${destCloudId}`;
    logger.info(`devemailBrowserClient: POST ${uploadUrl}`);

    const jsonBody = pairs.map((p) => ({
      sourceEmail:      p.sourceEmail,
      destinationEmail: p.destinationEmail,
    }));
    logger.info(`devemailBrowserClient: JSON body: ${JSON.stringify(jsonBody)}`);

    const uploadHeaders = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    // Priority: localStorage JWT → response-intercepted JWT → request-intercepted auth header → cookies only
    const authToUse = portalJwt
      ? `Bearer ${portalJwt}`
      : capturedLoginJwt
        ? `Bearer ${capturedLoginJwt}`
        : portalAuthHeader || null;
    if (authToUse) {
      uploadHeaders['Authorization'] = authToUse;
      logger.info(`devemailBrowserClient: CSV upload auth method: ${
        portalJwt ? 'localStorage JWT' : capturedLoginJwt ? 'response-intercepted JWT' : 'request-intercepted header'
      } (${authToUse.slice(0, 40)}...)`);
    } else {
      logger.warn('devemailBrowserClient: no auth token found — attempting CSV upload with session cookies only');
    }

    const res = await ctx.request.post(uploadUrl, {
      data:    JSON.stringify(jsonBody),
      headers: uploadHeaders,
    });

    const status = res.status();
    const body   = await res.text().catch(() => '');

    if (!res.ok()) {
      throw new Error(
        `devemailBrowserClient: CSV upload returned HTTP ${status} — ${body.slice(0, 200)}`
      );
    }

    logger.info(`devemailBrowserClient: CSV upload succeeded (HTTP ${status})`);
    return body;

  } finally {
    try { await browser.close(); } catch {}
    logger.info('devemailBrowserClient: headless browser closed');
  }
}

// ─── JWT extraction via browser login ────────────────────────────────────────

/**
 * Log in headlessly and capture the JWT from the login API response.
 * Used as a last-resort fallback when POST /auth/user and POST /mail/login both return 500.
 *
 * Strategy:
 *   1. Intercept all JSON responses during the login flow looking for a JWT-shaped token.
 *   2. After redirect, scan localStorage for a stored token.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string>} JWT token (without "Bearer " prefix)
 */
async function getJwtViaBrowser(email, password) {
  if (!email || !password) {
    throw new Error('devemailBrowserClient.getJwtViaBrowser: email and password are required');
  }

  logger.info(`devemailBrowserClient: getJwtViaBrowser — launching headless Chromium for ${email}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  let capturedJwt = null;

  // Intercept ALL devemail responses — the portal login may use a different path than /proxyservices/.
  page.on('response', async (response) => {
    try {
      if (capturedJwt) return;
      const url = response.url();
      if (!url.includes('devemail.cloudfuze.com')) return;

      const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

      // 1. Check response headers
      const hdrs = response.headers();
      const hdrToken = (hdrs['authorization'] || hdrs['x-auth-token'] || hdrs['x-access-token'] || hdrs['token'] || '')
        .replace(/^Bearer\s*/i, '').trim();
      if (hdrToken && JWT_RE.test(hdrToken)) {
        logger.info(`devemailBrowserClient: captured JWT from response header of ${url}`);
        capturedJwt = hdrToken;
        return;
      }

      // 2. Check response body (plain string or JSON)
      const text = await response.text().catch(() => '');
      if (!text) return;

      const trimmed = text.trim();
      if (JWT_RE.test(trimmed)) {
        logger.info(`devemailBrowserClient: captured JWT from plain-string response body of ${url}`);
        capturedJwt = trimmed;
        return;
      }

      // 3. Try JSON body — check all known token field paths
      try {
        const data = JSON.parse(trimmed);
        const t =
          data?.token || data?.accessToken || data?.jwtToken || data?.jwt ||
          data?.data?.token || data?.data?.accessToken || data?.data?.jwtToken ||
          data?.result?.token || data?.result?.jwtToken ||
          data?.userVO?.token || data?.userVO?.jwtToken || data?.userVO?.accessToken ||
          data?.response?.token || data?.response?.jwtToken ||
          data?.user?.token || data?.auth?.token || data?.session?.token;
        if (t && JWT_RE.test(String(t).trim())) {
          logger.info(`devemailBrowserClient: captured JWT from JSON response body of ${url}`);
          capturedJwt = String(t).trim().replace(/^Bearer\s*/i, '').trim();
        }
      } catch { /* not JSON */ }
    } catch { /* closed page — ignore */ }
  });

  try {
    await page.goto(LOGIN_PAGE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8_000 }); } catch {}

    const emailSel = [
      'input[name="email"]', 'input[name="username"]', 'input[type="email"]',
      'input[placeholder*="Email" i]', 'input[placeholder*="mail" i]',
      'input[id*="email" i]', 'input[id*="user" i]',
    ].join(', ');

    const emailInput = page.locator(emailSel).first();
    await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
    await emailInput.fill(email);
    await page.locator('input[type="password"]').first().fill(password);

    const submitSel = [
      'button[type="submit"]', 'input[type="submit"]',
      'button:has-text("Sign In")', 'button:has-text("Login")',
      'button:has-text("Log In")', 'button:has-text("SIGN IN")',
      '#loginBtn', '#signInBtn', '.btn-login', '.login-btn',
    ].join(', ');

    await page.locator(submitSel).first().click();

    try {
      await page.waitForURL(
        (url) => !url.toString().includes('index.html') && !url.toString().includes('login'),
        { timeout: 20_000 }
      );
    } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 10_000 }); } catch {}

    logger.info(`devemailBrowserClient: getJwtViaBrowser — post-login URL = ${page.url()}`);

    // If response interception didn't catch it, scan localStorage + sessionStorage
    if (!capturedJwt) {
      const storageResult = await page.evaluate(() => {
        const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
        const stores = [localStorage, sessionStorage];
        const allKeys = [];
        for (const store of stores) {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            const val = store.getItem(key);
            allKeys.push(`${key}=${String(val).slice(0, 60)}`);
            if (!val) continue;
            const stripped = val.trim().replace(/^Bearer\s+/i, '');
            if (JWT_RE.test(stripped)) return { jwt: stripped, keys: allKeys };
            try {
              const obj = JSON.parse(val);
              const t = obj?.token || obj?.jwtToken || obj?.accessToken ||
                obj?.userVO?.token || obj?.userVO?.jwtToken ||
                obj?.data?.token || obj?.auth?.token || obj?.session?.token;
              if (t && JWT_RE.test(String(t).trim())) return { jwt: String(t).trim(), keys: allKeys };
            } catch { /* not JSON */ }
          }
        }
        return { jwt: null, keys: allKeys };
      }).catch(() => ({ jwt: null, keys: [] }));

      if (storageResult.jwt) {
        capturedJwt = storageResult.jwt;
        logger.info('devemailBrowserClient: getJwtViaBrowser — JWT found in localStorage');
      } else {
        logger.info(`devemailBrowserClient: getJwtViaBrowser — localStorage keys: ${storageResult.keys.join(' | ')}`);
      }
    }

    if (!capturedJwt) {
      throw new Error('devemailBrowserClient: getJwtViaBrowser — login succeeded but no JWT found in responses or localStorage');
    }

    logger.info('devemailBrowserClient: getJwtViaBrowser — JWT captured successfully');
    return capturedJwt;

  } finally {
    try { await browser.close(); } catch {}
    logger.info('devemailBrowserClient: getJwtViaBrowser — headless browser closed');
  }
}

module.exports = { uploadCSVViaBrowser, getJwtViaBrowser };
