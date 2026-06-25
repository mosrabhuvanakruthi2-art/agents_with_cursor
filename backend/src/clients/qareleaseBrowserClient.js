/**
 * qareleaseBrowserClient — headless login for content migration servers.
 *
 * Content servers (e.g. qarelease.cloudfuze.com) block direct POST /app/login
 * from non-browser IPs (WAF/Cloudflare returns 403 with empty body).
 * This module uses Playwright headlessly to log in via the portal and capture
 * the JWT from response interception + localStorage.
 *
 * Used ONLY by migrationClient.js for content migrations when all API login
 * attempts return 403. Does NOT affect mail (devemailClient) or message flows.
 */

const { chromium } = require('playwright');
const logger = require('../utils/logger');

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Log in to a content migration server portal headlessly and return the JWT.
 *
 * @param {string} serverUrl  - Base URL, e.g. 'https://qarelease.cloudfuze.com'
 * @param {string} email      - User email entered in Run Agent Migration Server section
 * @param {string} password   - User password entered in Run Agent Migration Server section
 * @returns {Promise<string>} JWT token (without 'Bearer ' prefix)
 */
async function getTokenViaBrowser(serverUrl, email, password) {
  if (!serverUrl || !email || !password) {
    throw new Error('qareleaseBrowserClient: serverUrl, email and password are required');
  }

  const origin = serverUrl.replace(/\/proxyservices\/.*/i, '').replace(/\/$/, '');
  const loginPage = `${origin}/pages/index.html`;

  logger.info(`qareleaseBrowserClient: launching headless Chromium for ${email} → ${origin}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  let capturedJwt = null;

  // ── Intercept all responses from this server to capture the JWT ──────────
  page.on('response', async (response) => {
    try {
      if (capturedJwt) return;
      const url = response.url();
      // Only inspect responses from the target server
      if (!url.includes(new URL(origin).hostname)) return;

      // 1. Response headers
      const hdrs = response.headers();
      const hdrToken = (
        hdrs['authorization'] || hdrs['x-auth-token'] ||
        hdrs['x-access-token'] || hdrs['token'] || ''
      ).replace(/^Bearer\s*/i, '').trim();
      if (hdrToken && JWT_RE.test(hdrToken)) {
        logger.info(`qareleaseBrowserClient: JWT from response header of ${url}`);
        capturedJwt = hdrToken;
        return;
      }

      // 2. Response body — plain string
      const text = await response.text().catch(() => '');
      if (!text) return;
      const trimmed = text.trim();
      if (JWT_RE.test(trimmed)) {
        logger.info(`qareleaseBrowserClient: JWT from plain-string response of ${url}`);
        capturedJwt = trimmed;
        return;
      }

      // 3. Response body — JSON — check all known token field paths
      try {
        const data = JSON.parse(trimmed);
        const t =
          data?.token || data?.accessToken || data?.jwtToken || data?.jwt ||
          data?.data?.token || data?.data?.accessToken || data?.data?.jwtToken ||
          data?.result?.token || data?.result?.jwtToken ||
          data?.userVO?.token || data?.userVO?.jwtToken || data?.userVO?.accessToken ||
          data?.response?.token || data?.user?.token || data?.auth?.token || data?.session?.token;
        if (t && JWT_RE.test(String(t).trim())) {
          logger.info(`qareleaseBrowserClient: JWT from JSON response of ${url}`);
          capturedJwt = String(t).trim().replace(/^Bearer\s*/i, '').trim();
        }
      } catch { /* not JSON */ }
    } catch { /* closed page — ignore */ }
  });

  try {
    // ── 1. Navigate to portal login page ────────────────────────────────────
    logger.info(`qareleaseBrowserClient: navigating to ${loginPage}`);
    await page.goto(loginPage, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try { await page.waitForLoadState('networkidle', { timeout: 8_000 }); } catch {}

    // ── 2. Fill login form ───────────────────────────────────────────────────
    const emailSel = [
      'input[name="email"]', 'input[name="username"]',
      'input[type="email"]',
      'input[placeholder*="Email" i]', 'input[placeholder*="mail" i]',
      'input[placeholder*="user" i]',
      'input[id*="email" i]', 'input[id*="user" i]',
    ].join(', ');

    const emailInput = page.locator(emailSel).first();
    await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
    await emailInput.fill(email);
    await page.locator('input[type="password"]').first().fill(password);

    logger.info(`qareleaseBrowserClient: credentials filled — submitting login…`);

    const submitSel = [
      'button[type="submit"]', 'input[type="submit"]',
      'button:has-text("Sign In")', 'button:has-text("Login")',
      'button:has-text("Log In")', 'button:has-text("SIGN IN")',
      '#loginBtn', '#signInBtn', '.btn-login', '.login-btn',
    ].join(', ');

    await page.locator(submitSel).first().click();

    // ── 3. Wait for redirect away from login page ────────────────────────────
    try {
      await page.waitForURL(
        (url) => !url.toString().includes('index.html') && !url.toString().includes('login'),
        { timeout: 20_000 }
      );
    } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 10_000 }); } catch {}

    logger.info(`qareleaseBrowserClient: post-login URL = ${page.url()}`);

    // ── 4. Scan localStorage + sessionStorage if response interception missed it
    if (!capturedJwt) {
      const storageResult = await page.evaluate(() => {
        const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
        const stores = [localStorage, sessionStorage];
        const allKeys = [];
        for (const store of stores) {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            const val = store.getItem(key);
            allKeys.push(`${key}=${String(val || '').slice(0, 60)}`);
            if (!val) continue;
            const stripped = val.trim().replace(/^Bearer\s+/i, '');
            if (JWT_RE.test(stripped)) return { jwt: stripped, keys: allKeys };
            try {
              const obj = JSON.parse(val);
              const t =
                obj?.token || obj?.jwtToken || obj?.accessToken ||
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
        logger.info('qareleaseBrowserClient: JWT found in localStorage/sessionStorage');
      } else {
        logger.info(`qareleaseBrowserClient: storage keys scanned: ${storageResult.keys.join(' | ')}`);
      }
    }

    if (!capturedJwt) {
      throw new Error(
        'qareleaseBrowserClient: login succeeded but no JWT found in responses or storage — ' +
        'server may use session cookies only (not supported for API calls)'
      );
    }

    logger.info(`qareleaseBrowserClient: JWT captured for ${email}`);
    return capturedJwt;

  } finally {
    try { await browser.close(); } catch {}
    logger.info('qareleaseBrowserClient: headless browser closed');
  }
}

module.exports = { getTokenViaBrowser };
