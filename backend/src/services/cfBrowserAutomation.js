/**
 * CloudFuze Browser Automation — Playwright-based
 *
 * Full automated flow:
 *   1.  Login → wait for dashboard
 *   2.  Inject jQuery modal polyfill (fixes "$(...).modal is not a function")
 *   3.  Ensure source + destination clouds are connected; add them if missing
 *   4.  Navigate to Message Migration page via sidebar link
 *   5.  Select source cloud
 *   6.  Select destination cloud
 *   7.  Skip pre-migration page (if present)
 *   8.  Handle user mapping — auto-map, confirm, proceed
 *   9.  Select EXACTLY the channels / DMs chosen in the tool
 *   10. Click "Start Migration" → dismiss all dialogs
 *   11. Navigate to Reports page
 */

const { chromium }     = require('playwright');
const { EventEmitter } = require('events');
const fs               = require('fs');
const path             = require('path');
const os               = require('os');
const env              = require('../config/env');
const logger           = require('../utils/logger');

/* ── Base URLs ────────────────────────────────────────────────────────────── */

const CF_BASE = (env.MIGRATION_API_URL || 'https://s2cdev.cloudfuze.com/proxyservices/v1')
  .replace(/\/proxyservices\/v1\/?$/, '');

const CF_LOGIN_URL   = `${CF_BASE}/`;
const CF_REPORTS_URL = `${CF_BASE}/pages/reports.html`;

/* ── Timeouts (ms) ────────────────────────────────────────────────────────── */
const NAV_TIMEOUT    = 30_000;
const ACTION_TIMEOUT = 15_000;
const WAIT_S         = 500;    // short
const WAIT_M         = 1_000;  // medium
const WAIT_L         = 2_000;  // long

/* ── Platform label variants in the CloudFuze UI ─────────────────────────── */
const CF_CLOUD_LABELS = {
  slack:      ['Slack', 'SLACK'],
  microsoft:  ['Microsoft Teams', 'Teams', 'MICROSOFT_TEAMS', 'MicrosoftTeams'],
  teams:      ['Microsoft Teams', 'Teams', 'MICROSOFT_TEAMS'],
  google:     ['Google Chat', 'GoogleChat', 'GOOGLE_CHAT'],
  googlechat: ['Google Chat', 'GoogleChat', 'GOOGLE_CHAT'],
};

/* ── jQuery modal polyfill (injected into every page before CF scripts run) ─ */
const MODAL_POLYFILL = () => {
  const install = () => {
    if (window.$ && window.$.fn && !window.$.fn.modal) {
      window.$.fn.modal = function (cmd) {
        if (cmd === 'hide' || cmd === 'dispose') {
          this.hide().removeClass('in show');
          document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
          document.body.classList.remove('modal-open');
        } else {
          this.show().addClass('in show');
          if (!document.querySelector('.modal-backdrop')) {
            const bd = document.createElement('div');
            bd.className = 'modal-backdrop fade in show';
            document.body.appendChild(bd);
          }
          document.body.classList.add('modal-open');
        }
        return this;
      };
    }
  };
  install();
  // Retry until jQuery loads (handles async script loading)
  let n = 0;
  const t = setInterval(() => { install(); if (++n > 40) clearInterval(t); }, 250);
};

/* ════════════════════════════════════════════════════════════════════════════
   CFBrowserAutomation
   ════════════════════════════════════════════════════════════════════════════ */

class CFBrowserAutomation extends EventEmitter {
  constructor(opts) {
    super();
    this.opts    = opts;
    this.browser = null;
    this.page    = null;
    this.aborted = false;
  }

  log(step, detail = '') {
    const msg = detail ? `${step}: ${detail}` : step;
    logger.info(`[CFBrowser] ${msg}`);
    this.emit('progress', { step, detail, ts: Date.now() });
  }

  err(step, detail) {
    logger.error(`[CFBrowser] ERROR ${step}: ${detail}`);
    this.emit('error-step', { step, detail, ts: Date.now() });
  }

  async abort() {
    this.aborted = true;
    if (this.browser) await this.browser.close().catch(() => {});
  }

  /* ── Main entry point ────────────────────────────────────────────────────── */

  async run() {
    const {
      sourceEmail, destinationEmail,
      sourcePlatform, destinationPlatform,
      channelIds     = [],
      dmIds          = [],
      channelObjects = [],
      dmObjects      = [],
      cfSrcCloudId   = null,
      cfDstCloudId   = null,
      cfUsername     = env.MIGRATION_API_USERNAME,
      cfPassword     = env.MIGRATION_API_PASSWORD,
      headless       = false,
      mappingType    = 'auto',
      userMappings   = [],
      userMappingCsvPath = null,
    } = this.opts;

    this.log('LAUNCH', `Opening CloudFuze — ${CF_BASE}`);

    this.browser = await chromium.launch({
      headless,
      slowMo: 100,
      args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'],
    });

    const ctx = await this.browser.newContext({ viewport: null });

    // Fix "$(...).modal is not a function" on every page load
    await ctx.addInitScript(MODAL_POLYFILL);

    this.page = await ctx.newPage();
    this.page.setDefaultTimeout(ACTION_TIMEOUT);
    this.page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    try {
      // 1 — Login
      await this._login(cfUsername, cfPassword);
      if (this.aborted) return;

      // 2 — Ensure clouds are connected (add missing ones)
      await this._ensureCloudsConnected(sourcePlatform, sourceEmail, destinationPlatform, destinationEmail);
      if (this.aborted) return;

      // 3 — Message Migration page
      await this._goToMessageMigration();
      if (this.aborted) return;

      // 4 — Select source cloud
      await this._selectSourceCloud(sourcePlatform, sourceEmail, cfSrcCloudId);
      if (this.aborted) return;

      // 5 — Select destination cloud
      await this._selectDestinationCloud(destinationPlatform, destinationEmail, cfDstCloudId);
      if (this.aborted) return;

      // 5.5 — Select migration combination (Slack→Teams etc.) if the UI requires it
      await this._selectMigrationCombination();
      if (this.aborted) return;

      // 5.6 — Advance from Step 1 (Selection) → Step 2 (Pre-Migration) by clicking "Next >"
      await this._clickWizardNext('SELECTION');
      if (this.aborted) return;

      // 6 — Step 2: Skip pre-migration → lands on Step 3 (User Mapping)
      await this._skipPreMigration();
      if (this.aborted) return;

      // 7 — Step 3 Users tab: upload CSV (provided path or generated from pairs); fallback Auto Map
      await this._handleUserMapping(mappingType, userMappings, userMappingCsvPath);
      if (this.aborted) return;

      // 8 — Step 3 Public/Private Channels tabs: select channels, then click Next → Step 4
      await this._selectChannels(channelIds, channelObjects, dmIds, dmObjects);
      if (this.aborted) return;

      // 9 — Step 4: click "Start Migration >" in the browser
      await this._startMigration();
      if (this.aborted) return;

      // 9.5 — Also initiate via CF API directly (ensures migration is recorded even if browser click fails)
      await this._initiateMigrationViaAPI();
      if (this.aborted) return;

      // 10 — Reports page
      await this._openReports();

      this.log('DONE', 'Migration started — Reports page open. Picking and moving data.');
      this.emit('done', { reportsUrl: CF_REPORTS_URL });
    } catch (e) {
      logger.error(`[CFBrowser] Automation failed: ${e.message}`);
      this.err('FAILED', e.message);
      this.emit('failed', { error: e.message });
    }
  }

  /* ── Page state helpers ──────────────────────────────────────────────────── */

  async _is404Page() {
    try {
      const t = await this.page.evaluate(() => document.body?.textContent?.trim() || '');
      return t.includes('404') ||
             t.toLowerCase().includes('caught us on cloud') ||
             t.toLowerCase().includes('page not found') ||
             t.toLowerCase().includes('ooops');
    } catch { return false; }
  }

  async _isLoginPage() {
    try {
      const email = await this.page.$('input[type="email"], input[name="email"], input[name="username"], input[placeholder*="email" i]');
      const pass  = await this.page.$('input[type="password"]');
      return !!(email && pass);
    } catch { return false; }
  }

  /* ── 1: Login ────────────────────────────────────────────────────────────── */

  async _login(username, password) {
    const page = this.page;
    this.log('LOGIN', `→ ${CF_LOGIN_URL}`);
    await page.goto(CF_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_M);

    if (!(await this._isLoginPage())) {
      this.log('LOGIN', `Already logged in — ${page.url()}`);
      return;
    }

    const emailSel = [
      'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
      'input[placeholder*="email" i]', 'input[placeholder*="user" i]',
    ].join(', ');

    await page.waitForSelector(emailSel, { timeout: 15_000 });
    await page.fill(emailSel, username);
    await page.fill('input[type="password"]', password);
    this.log('LOGIN', `Credentials entered for ${username}`);

    const submitSel = [
      'button[type="submit"]', 'input[type="submit"]',
      'button:has-text("Sign In")', 'button:has-text("Login")',
      'button:has-text("Log In")', 'button:has-text("Sign in")',
    ].join(', ');
    await page.click(submitSel);
    this.log('LOGIN', 'Sign In clicked');

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(WAIT_L);
    this.log('LOGIN', `Logged in — ${page.url()}`);
  }

  /* ── 2: Ensure clouds are connected — add if missing ─────────────────────── */

  async _ensureCloudsConnected(srcPlatform, srcEmail, dstPlatform, dstEmail) {
    this.log('CLOUDS', `Verifying: ${srcPlatform}(${srcEmail}) → ${dstPlatform}(${dstEmail})`);

    // CF internal platform names
    const CF_PLATFORM_MAP = {
      slack: 'SLACK', microsoft: 'MICROSOFT_TEAMS', teams: 'MICROSOFT_TEAMS',
      microsoft_teams: 'MICROSOFT_TEAMS', google: 'GOOGLE_CHAT',
      googlechat: 'GOOGLE_CHAT', google_chat: 'GOOGLE_CHAT',
    };
    const srcCfName = CF_PLATFORM_MAP[srcPlatform?.toLowerCase()] || srcPlatform?.toUpperCase() || '';
    const dstCfName = CF_PLATFORM_MAP[dstPlatform?.toLowerCase()] || dstPlatform?.toUpperCase() || '';

    // ── Step A: use the CF API to check which accounts are actually connected ──
    // Email-exact match is critical for same-platform combos (Teams→Teams).
    let srcFound = false;
    let dstFound = false;
    try {
      const { getCloudAccounts } = require('../clients/migrationClient');
      const accounts = await getCloudAccounts();
      this.log('CLOUDS', `CF has ${accounts.length} connected cloud(s)`);

      srcFound = accounts.some(a =>
        a.cloudName === srcCfName &&
        (a.emailId || '').toLowerCase() === (srcEmail || '').toLowerCase()
      );
      dstFound = accounts.some(a =>
        a.cloudName === dstCfName &&
        (a.emailId || '').toLowerCase() === (dstEmail || '').toLowerCase()
      );

      // Domain-level fallback (admin manages whole domain)
      if (!srcFound && srcEmail) {
        const srcDomain = srcEmail.split('@')[1]?.toLowerCase() || '';
        srcFound = accounts.some(a =>
          a.cloudName === srcCfName &&
          Array.isArray(a.domainList) &&
          a.domainList.some(d => (d || '').toLowerCase() === srcDomain)
        );
      }
      if (!dstFound && dstEmail) {
        const dstDomain = dstEmail.split('@')[1]?.toLowerCase() || '';
        dstFound = accounts.some(a =>
          a.cloudName === dstCfName &&
          Array.isArray(a.domainList) &&
          a.domainList.some(d => (d || '').toLowerCase() === dstDomain)
        );
      }

      if (srcFound) this.log('CLOUDS', `Source ${srcPlatform}(${srcEmail}) ✓ already in CF`);
      if (dstFound) this.log('CLOUDS', `Dest   ${dstPlatform}(${dstEmail}) ✓ already in CF`);
    } catch (e) {
      this.log('CLOUDS', `CF API check failed (${e.message}) — will verify via browser page`);
    }

    if (srcFound && dstFound) return; // nothing to add

    // ── Step B: Navigate to Cloud Accounts page in the browser ────────────────
    const onCloudsPage = await this._goToCloudAccountsPage();
    if (!onCloudsPage) {
      this.log('CLOUDS', 'Cloud Accounts page not reachable — skipping auto-add');
      return;
    }

    // If API check was skipped, do a page-text fallback (per-email check)
    if (!srcFound) {
      const pgSrc = await this.page.evaluate(() => document.body?.textContent || '').catch(() => '');
      srcFound = pgSrc.toLowerCase().includes((srcEmail || '').toLowerCase()) ||
                 pgSrc.toLowerCase().includes((srcEmail || '').split('@')[1]?.toLowerCase() || '___');
    }
    if (!dstFound) {
      const pgDst = await this.page.evaluate(() => document.body?.textContent || '').catch(() => '');
      dstFound = pgDst.toLowerCase().includes((dstEmail || '').toLowerCase()) ||
                 pgDst.toLowerCase().includes((dstEmail || '').split('@')[1]?.toLowerCase() || '___');
    }

    if (!srcFound) {
      this.log('CLOUDS', `Source cloud ${srcPlatform}(${srcEmail}) missing — adding now`);
      await this._addCloud(srcPlatform, srcEmail);
    }
    if (!dstFound) {
      this.log('CLOUDS', `Dest cloud ${dstPlatform}(${dstEmail}) missing — adding now`);
      await this._addCloud(dstPlatform, dstEmail);
    }
  }

  /* ── Navigate to Cloud Accounts page ─────────────────────────────────────── */

  async _goToCloudAccountsPage() {
    const navSels = [
      'a:has-text("Cloud Accounts")', 'a:has-text("Clouds")', 'a[href*="cloud.html" i]',
      'a[href*="clouds" i]:not([href*="report" i]):not([href*="message" i])',
    ];
    for (const sel of navSels) {
      const el = await this.page.$(sel).catch(() => null);
      if (!el || !(await el.isVisible().catch(() => false))) continue;
      await el.click();
      await this.page.waitForTimeout(WAIT_L);
      if (!(await this._is404Page()) && !(await this._isLoginPage())) {
        this.log('CLOUDS', `Cloud Accounts page: ${this.page.url()}`);
        return true;
      }
      await this.page.goBack().catch(() => {});
      await this.page.waitForTimeout(WAIT_S);
    }

    // URL candidates
    for (const url of [
      `${CF_BASE}/pages/clouds.html`,
      `${CF_BASE}/pages/cloud-accounts.html`,
      `${CF_BASE}/pages/cloudaccounts.html`,
    ]) {
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        if (!(await this._is404Page())) {
          this.log('CLOUDS', `Cloud Accounts page: ${url}`);
          return true;
        }
      } catch { /* try next */ }
    }
    return false;
  }

  /* ── Add a cloud account via the CF browser UI ───────────────────────────── */

  async _addCloud(platform, email) {
    this.log('ADD_CLOUD', `Adding ${platform} / ${email}`);

    // Make sure we're on the Cloud Accounts page before clicking Add
    const onPage = await this._goToCloudAccountsPage();
    if (!onPage) { this.log('ADD_CLOUD', 'Cannot reach Cloud Accounts page'); return; }

    // Click "Add Cloud" / "+ Add" button
    let clicked = false;
    for (const sel of [
      'button:has-text("Add Cloud")', 'a:has-text("Add Cloud")',
      'button:has-text("+ Add")', 'button:has-text("Add")',
      '[class*="add-cloud"]', '[id*="add-cloud"]',
      'button:has-text("Connect Cloud")', 'a:has-text("Connect")',
    ]) {
      const btn = await this.page.$(sel).catch(() => null);
      if (!btn || !(await btn.isVisible().catch(() => false))) continue;
      await btn.click();
      await this.page.waitForTimeout(WAIT_L);
      this.log('ADD_CLOUD', `Add button clicked: ${sel}`);
      clicked = true;
      break;
    }
    if (!clicked) { this.log('ADD_CLOUD', 'Add Cloud button not found on page'); return; }

    // Select the platform in the modal/dialog
    const labels = CF_CLOUD_LABELS[platform?.toLowerCase()] || [platform];
    let platformSelected = false;
    for (const lbl of labels) {
      for (const sel of [
        `button:has-text("${lbl}")`, `a:has-text("${lbl}")`,
        `[title="${lbl}"]`, `img[alt="${lbl}"]`,
        `li:has-text("${lbl}")`, `div:has-text("${lbl}")`,
        `span:has-text("${lbl}")`,
      ]) {
        const el = await this.page.$(sel).catch(() => null);
        if (!el || !(await el.isVisible().catch(() => false))) continue;
        await el.click();
        await this.page.waitForTimeout(WAIT_M);
        this.log('ADD_CLOUD', `Platform selected: ${lbl}`);
        platformSelected = true;
        break;
      }
      if (platformSelected) break;
    }
    if (!platformSelected) this.log('ADD_CLOUD', `Platform selector not found for ${platform} — may need manual selection`);

    // Fill admin email if an input is present
    if (email) {
      await this.page.waitForTimeout(WAIT_M);
      for (const sel of [
        'input[type="email"]', 'input[name="email"]', 'input[name="adminEmail"]',
        'input[placeholder*="email" i]', 'input[placeholder*="admin" i]',
        'input[placeholder*="tenant" i]',
      ]) {
        const inp = await this.page.$(sel).catch(() => null);
        if (!inp || !(await inp.isVisible().catch(() => false))) continue;
        await inp.fill(email);
        this.log('ADD_CLOUD', `Admin email filled: ${email}`);
        break;
      }
    }

    // Submit / Connect
    for (const sel of [
      'button[type="submit"]', 'button:has-text("Connect")', 'button:has-text("Add")',
      'button:has-text("Authorize")', 'button:has-text("Save")',
      'button:has-text("Next")', 'button:has-text("Submit")',
    ]) {
      const btn = await this.page.$(sel).catch(() => null);
      if (!btn || !(await btn.isVisible().catch(() => false))) continue;
      await btn.click();
      await this.page.waitForTimeout(WAIT_L);
      this.log('ADD_CLOUD', `Submit clicked: ${sel}`);
      break;
    }

    // Wait for OAuth popup or confirmation
    await this.page.waitForTimeout(3000);

    // If a new page/popup opened for OAuth, wait for it to complete (up to 60s)
    const pages = this.page.context().pages();
    if (pages.length > 1) {
      this.log('ADD_CLOUD', `OAuth popup detected (${pages.length} pages) — waiting up to 60s for completion`);
      await this.page.waitForTimeout(60_000);
    }

    // Verify the cloud was added
    try {
      const { getCloudAccounts } = require('../clients/migrationClient');
      const accounts = await getCloudAccounts();
      const cfNames  = Object.values({ slack: 'SLACK', microsoft: 'MICROSOFT_TEAMS', teams: 'MICROSOFT_TEAMS', google: 'GOOGLE_CHAT', googlechat: 'GOOGLE_CHAT' });
      const cfName   = { slack: 'SLACK', microsoft: 'MICROSOFT_TEAMS', teams: 'MICROSOFT_TEAMS', google: 'GOOGLE_CHAT', googlechat: 'GOOGLE_CHAT' }[platform?.toLowerCase()] || platform?.toUpperCase();
      const added    = accounts.some(a =>
        a.cloudName === cfName &&
        (a.emailId || '').toLowerCase() === (email || '').toLowerCase()
      );
      if (added) this.log('ADD_CLOUD', `✓ ${platform}(${email}) confirmed in CF accounts`);
      else        this.log('ADD_CLOUD', `⚠ ${platform}(${email}) not yet visible — OAuth may still be pending`);
    } catch { /* ignore */ }
  }

  /* ── 3: Navigate to Message Migration page ───────────────────────────────── */

  async _goToMessageMigration() {
    this.log('NAV', 'Navigating to Message Migration');

    // Strategy A — sidebar/nav links (fastest, most reliable)
    const navSels = [
      'a:has-text("Message Migration")', 'a:has-text("Chat Migration")',
      'a:has-text("Message Migrate")', 'a:has-text("Messages")',
      'a:has-text("Message")', 'a:has-text("Chat")',
      'a[href*="message" i]', 'a[href*="chat" i]',
    ];

    for (const sel of navSels) {
      const el = await this.page.$(sel).catch(() => null);
      if (!el || !(await el.isVisible().catch(() => false))) continue;
      const href = await el.getAttribute('href').catch(() => '');
      if (href && /cloud|account|report|user|logout/i.test(href)) continue;

      await el.click();
      await this.page.waitForTimeout(WAIT_L);
      if (!(await this._is404Page()) && !(await this._isLoginPage())) {
        this.log('NAV', `Message Migration loaded via nav: ${this.page.url()}`);
        return;
      }
      await this.page.goBack().catch(() => {});
      await this.page.waitForTimeout(WAIT_S);
    }

    // Strategy B — URL candidates with 404/login detection
    const candidates = [
      `${CF_BASE}/pages/message-migration.html`,
      `${CF_BASE}/pages/messages.html`,
      `${CF_BASE}/pages/messagemigration.html`,
      `${CF_BASE}/pages/chat-migration.html`,
      `${CF_BASE}/pages/message.html`,
      `${CF_BASE}/pages/chat.html`,
      `${CF_BASE}/pages/migration.html`,
    ];

    for (const url of candidates) {
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        if (await this._is404Page()) { this.log('NAV', `404: ${url}`); continue; }
        if (await this._isLoginPage()) {
          this.log('NAV', `Session lost at ${url} — re-logging in`);
          const u = this.opts.cfUsername || env.MIGRATION_API_USERNAME;
          const p = this.opts.cfPassword || env.MIGRATION_API_PASSWORD;
          await this._login(u, p);
          continue;
        }
        this.log('NAV', `Message Migration loaded: ${this.page.url()}`);
        await this.page.waitForTimeout(WAIT_M);
        return;
      } catch { this.log('NAV', `Failed: ${url}`); }
    }

    this.log('NAV', 'Could not navigate automatically — waiting 10s for manual navigation.');
    await this.page.waitForTimeout(10_000);
  }

  /* ── 4 & 5: Select source / destination clouds ───────────────────────────── */

  async _selectSourceCloud(platform, email, cfCloudId) {
    this.log('SOURCE_CLOUD', `${platform} / ${email} (cfId: ${cfCloudId || 'n/a'})`);
    await this.page.waitForTimeout(3000);
    const ok = await this._pickCloud('source', platform, email, cfCloudId);
    if (ok) this.log('SOURCE_CLOUD', 'Selected ✓');
    else     this.err('SOURCE_CLOUD', 'Could not select — check CLOUD_PICK debug lines above');
    await this.page.waitForTimeout(WAIT_M);
  }

  async _selectDestinationCloud(platform, email, cfCloudId) {
    this.log('DEST_CLOUD', `${platform} / ${email} (cfId: ${cfCloudId || 'n/a'})`);
    await this.page.waitForTimeout(3000);
    const ok = await this._pickCloud('destination', platform, email, cfCloudId);
    if (ok) this.log('DEST_CLOUD', 'Selected ✓');
    else     this.err('DEST_CLOUD', 'Could not select — check CLOUD_PICK debug lines above');
    await this.page.waitForTimeout(WAIT_M);
  }

  /**
   * Selects the cloud for the given side.
   * Primary: radio buttons with cloudname/mail/id attributes.
   *   CF element: <input type="radio" name="sourceCloud" cloudname="GOOGLE_CHAT" mail="x@y.com" id="hexId">
   * Fallback: <select> evaluate, Bootstrap Select, Select2, generic dropdown.
   */
  async _pickCloud(side, platform, email, cfCloudId) {
    const labels  = CF_CLOUD_LABELS[platform?.toLowerCase()] || [platform];
    const cfIdStr = cfCloudId ? String(cfCloudId) : '';
    const bsIdx   = side === 'source' ? 0 : 1;

    this.log('CLOUD_PICK', `${side}: looking for (${platform} / ${email || 'any'})…`);

    // Wait for radio buttons or select options to appear (up to 8 s)
    await this.page.waitForFunction(() => {
      const radios  = document.querySelectorAll('input[type="radio"]');
      const selects = Array.from(document.querySelectorAll('select')).filter(s => s.options.length > 1);
      return radios.length > 0 || selects.length > 0;
    }, { timeout: 8_000 }).catch(() => {});

    // ── Strategy 1: Radio buttons with cloudname / mail / id attributes ───────
    // CF element: <input type="radio" name="sourceCloud" cloudname="SLACK" mail="x@y" id="hexId">
    // The CF page shows "Select Source" (left panel) and "Select Destination" (right panel) side-by-side.
    // We find the correct panel first, then match by cloudname attribute.
    const radioResult = await this.page.evaluate(({ side, labels, email, cfId }) => {
      const norm       = s => (s || '').replace(/[\s_]/g, '').toLowerCase();
      const labelNorms = labels.map(norm);
      const allRadios  = Array.from(document.querySelectorAll('input[type="radio"]'));

      // ── A: Find panel by visible heading text ("Select Source" / "Select Destination") ─
      // This is the most reliable method — it uses what's visually on the page.
      function findPanelByHeading(side) {
        const targets = side === 'source'
          ? ['select source', 'source']
          : ['select destination', 'destination'];

        // Walk every element; find leaf/near-leaf nodes whose text matches
        const all = Array.from(document.querySelectorAll('*'));
        for (const el of all) {
          if (el.children.length > 3) continue;  // skip large containers
          const t = (el.textContent || '').trim().toLowerCase();
          if (!targets.includes(t)) continue;

          // Found the heading — walk up to the panel container that holds radio buttons
          // but does NOT contain ALL radio buttons (so we get only this panel)
          let container = el.parentElement;
          for (let depth = 0; depth < 12 && container; depth++) {
            const radios = Array.from(container.querySelectorAll('input[type="radio"]'));
            if (radios.length > 0 && radios.length < allRadios.length) {
              return radios;
            }
            container = container.parentElement;
          }
        }
        return [];
      }

      // ── B: Find panel by radio name attribute ─────────────────────────────
      function findPanelByName(side) {
        return allRadios.filter(r => {
          const n = (r.getAttribute('name') || '').toLowerCase();
          if (side === 'source') {
            return (n.includes('source') || n === 'src' || n.startsWith('src')) && !n.includes('dest');
          }
          return (n.includes('destination') || n.includes('dest') || n.includes('dst') || n.includes('target'))
            && !n.includes('source') && !n.includes('src');
        });
      }

      // Determine the pool: heading detection is most reliable
      let pool = findPanelByHeading(side);
      if (pool.length === 0) pool = findPanelByName(side);
      if (pool.length === 0) pool = allRadios; // last resort

      // ── Match within pool ──────────────────────────────────────────────────
      // Pass 1: exact CF cloud ID (highest precision — user explicitly chose this account)
      if (cfId) {
        for (const r of pool) {
          const rid = r.id || r.getAttribute('value') || '';
          if (rid === cfId || rid === String(Number(cfId))) {
            return { ok: true, how: 'cfId', globalIdx: allRadios.indexOf(r) };
          }
        }
      }

      // Pass 2: platform (cloudname) + email — cloudname is mandatory, email preferred
      for (const r of pool) {
        const cn   = norm(r.getAttribute('cloudname') || r.getAttribute('data-cloudname') || '');
        const mail = (r.getAttribute('mail') || r.getAttribute('data-mail') || r.getAttribute('email') || '').toLowerCase();
        if (!cn) continue;
        const platformOk = labelNorms.some(l => cn.includes(l) || l.includes(cn));
        if (platformOk && (!email || !mail || mail.includes(email.toLowerCase()))) {
          return { ok: true, how: 'platform+email', globalIdx: allRadios.indexOf(r) };
        }
      }

      // Pass 3: platform only — cloudname matches, ignore email
      for (const r of pool) {
        const cn = norm(r.getAttribute('cloudname') || r.getAttribute('data-cloudname') || '');
        if (!cn) continue;
        if (labelNorms.some(l => cn.includes(l) || l.includes(cn))) {
          return { ok: true, how: 'platform-only', globalIdx: allRadios.indexOf(r) };
        }
      }

      return {
        ok: false,
        debug: {
          poolSize: pool.length,
          allRadioCount: allRadios.length,
          radios: pool.slice(0, 10).map(r => ({
            name:      r.getAttribute('name'),
            cloudname: r.getAttribute('cloudname'),
            mail:      r.getAttribute('mail'),
            id:        r.id,
          })),
        },
      };
    }, { side, labels, email: email || '', cfId: cfIdStr }).catch(() => null);

    if (radioResult?.ok) {
      const allRadios = await this.page.$$('input[type="radio"]');
      const radio = allRadios[radioResult.globalIdx];
      if (radio) {
        await radio.click().catch(() => {});
        await this.page.waitForTimeout(500);
        this.log('CLOUD_PICK', `${side} ✓ via radio (${radioResult.how})`);
        return true;
      }
    }
    if (radioResult?.debug) {
      this.log('CLOUD_PICK', `${side} radio debug (pool=${radioResult.debug.poolSize}/${radioResult.debug.allRadioCount}): ${JSON.stringify(radioResult.debug.radios).slice(0, 600)}`);
    }

    // ── Strategy 2: <select> with evaluate + partial text matching ────────────
    const evalResult = await this.page.evaluate(({ cfId, labels, email }) => {
      const selects = Array.from(document.querySelectorAll('select')).filter(s => s.options.length > 1);
      function setSelect(s, opt) {
        s.value = opt.value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        s.dispatchEvent(new Event('input',  { bubbles: true }));
        return `"${opt.text.trim()}" (value=${opt.value})`;
      }
      for (const s of selects) {
        const opts = Array.from(s.options);
        if (cfId) {
          const m = opts.find(o => o.value === cfId || o.value === String(Number(cfId)));
          if (m) return { ok: true, how: 'cfId', desc: setSelect(s, m) };
        }
        const byLabel = opts.find(o => labels.some(l => o.text.toLowerCase().includes(l.toLowerCase())));
        if (byLabel) return { ok: true, how: 'label', desc: setSelect(s, byLabel) };
        if (email) {
          const byEmail = opts.find(o =>
            o.text.toLowerCase().includes(email.toLowerCase()) ||
            o.value.toLowerCase().includes(email.toLowerCase())
          );
          if (byEmail) return { ok: true, how: 'email', desc: setSelect(s, byEmail) };
        }
      }
      return { ok: false, debug: selects.map(s => ({ id: s.id, name: s.name, opts: Array.from(s.options).slice(0, 6).map(o => `${o.value}|${o.text.trim()}`) })) };
    }, { cfId: cfIdStr, labels, email: email || '' }).catch(() => null);

    if (evalResult?.ok) {
      this.log('CLOUD_PICK', `${side} ✓ via select (${evalResult.how}): ${evalResult.desc}`);
      return true;
    }
    if (evalResult?.debug?.length) {
      this.log('CLOUD_PICK', `${side} select options: ${JSON.stringify(evalResult.debug).slice(0, 600)}`);
    }

    // ── Strategy 3: Bootstrap Select ─────────────────────────────────────────
    if (await this._pickBootstrapSelect(bsIdx, labels, email)) {
      this.log('CLOUD_PICK', `${side} ✓ via Bootstrap Select`);
      return true;
    }

    // ── Strategy 4: Select2 ──────────────────────────────────────────────────
    if (await this._pickSelect2(bsIdx, labels, email)) {
      this.log('CLOUD_PICK', `${side} ✓ via Select2`);
      return true;
    }

    // ── Strategy 5: Generic custom dropdown ──────────────────────────────────
    if (await this._pickGenericDropdown(bsIdx, labels, email)) {
      this.log('CLOUD_PICK', `${side} ✓ via generic dropdown`);
      return true;
    }

    this.log('CLOUD_PICK', `${side}: all strategies exhausted — may need manual selection`);
    return false;
  }

  /* ── 5.5: Select migration combination (Slack→Teams etc.) if required ─────── */

  async _selectMigrationCombination() {
    const combo = this.opts.combination || '';
    if (!combo) return;
    this.log('COMBO', `Selecting migration combination: ${combo}`);

    const lower = combo.toLowerCase();
    const comboLabels = [];
    if      (lower.includes('slack') && (lower.includes('team') || lower.includes('microsoft')))
      comboLabels.push('Slack to Teams', 'S2T', 'Slack to Microsoft Teams', 'Slack → Teams');
    else if (lower.includes('slack') && lower.includes('google'))
      comboLabels.push('Slack to Google Chat', 'S2GC', 'Slack → Google Chat');
    else if ((lower.includes('team') || lower.includes('microsoft')) && lower.includes('slack'))
      comboLabels.push('Teams to Slack', 'T2S', 'Microsoft Teams to Slack');
    else if ((lower.includes('team') || lower.includes('microsoft')) && lower.includes('google'))
      comboLabels.push('Teams to Google Chat', 'T2GC');
    else if (lower.includes('google') && lower.includes('slack'))
      comboLabels.push('Google Chat to Slack', 'GC2S');
    else if (lower.includes('google') && (lower.includes('team') || lower.includes('microsoft')))
      comboLabels.push('Google Chat to Teams', 'GC2T');

    if (comboLabels.length === 0) {
      this.log('COMBO', 'No labels derived — skipping');
      return;
    }

    for (const lbl of comboLabels) {
      for (const sel of [
        `input[type="radio"][value="${lbl}"]`,
        `label:has-text("${lbl}")`,
        `button:has-text("${lbl}")`,
        `a:has-text("${lbl}")`,
      ]) {
        const el = await this.page.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) {
          await el.click().catch(() => {});
          await this.page.waitForTimeout(WAIT_M);
          this.log('COMBO', `Selected: ${lbl}`);
          return;
        }
      }
    }

    const found = await this.page.evaluate(({ labels }) => {
      const els = Array.from(document.querySelectorAll('input[type="radio"], button, a, label'));
      for (const el of els) {
        const t = (el.textContent || el.value || '').trim();
        if (labels.some(l => t.toLowerCase().includes(l.toLowerCase()))) {
          el.click();
          return t;
        }
      }
      return null;
    }, { labels: comboLabels }).catch(() => null);

    if (found) {
      await this.page.waitForTimeout(WAIT_M);
      this.log('COMBO', `Selected via evaluate: ${found}`);
    } else {
      this.log('COMBO', 'Combination may already be selected or not required on this page');
    }
  }

  async _pickBootstrapSelect(idx, labels, email) {
    const containers = await this.page.$$('.bootstrap-select').catch(() => []);
    const c = containers[idx];
    if (!c) return false;
    const toggle = await c.$('button.dropdown-toggle').catch(() => null);
    if (!toggle) return false;
    await toggle.click();
    await this.page.waitForTimeout(400);
    const items = await c.$$('li a, li span.text').catch(() => []);
    for (const item of items) {
      const t = await item.innerText().catch(() => '');
      if (labels.some(l => t.toLowerCase().includes(l.toLowerCase())) ||
          (email && t.toLowerCase().includes(email.toLowerCase()))) {
        await item.click();
        await this.page.waitForTimeout(300);
        return true;
      }
    }
    await toggle.click().catch(() => {});
    return false;
  }

  async _pickSelect2(idx, labels, email) {
    const containers = await this.page.$$('.select2-container').catch(() => []);
    const c = containers[idx];
    if (!c) return false;
    const sel = await c.$('.select2-selection').catch(() => null);
    if (!sel) return false;
    await sel.click();
    await this.page.waitForTimeout(400);
    // Type search term into Select2 search box if present
    const search = await this.page.$('.select2-search__field').catch(() => null);
    if (search) {
      await search.type(labels[0] || email || '', { delay: 50 });
      await this.page.waitForTimeout(400);
    }
    const opts = await this.page.$$('.select2-results__option').catch(() => []);
    for (const opt of opts) {
      const t = await opt.innerText().catch(() => '');
      if (labels.some(l => t.toLowerCase().includes(l.toLowerCase())) ||
          (email && t.toLowerCase().includes(email.toLowerCase()))) {
        await opt.click();
        return true;
      }
    }
    await this.page.keyboard.press('Escape').catch(() => {});
    return false;
  }

  async _pickGenericDropdown(idx, labels, email) {
    // Find the Nth visible dropdown-like container (first = source, second = dest)
    const candidates = await this.page.$$(
      '[class*="select"]:not(select):not(option), [class*="dropdown"][class*="cloud"], [class*="cloud"][class*="select"]'
    ).catch(() => []);
    const visible = [];
    for (const el of candidates) {
      if (await el.isVisible().catch(() => false)) visible.push(el);
    }
    const c = visible[idx];
    if (!c) return false;
    await c.click().catch(() => {});
    await this.page.waitForTimeout(400);
    // Look for options that appeared
    const opts = await this.page.$$(
      '[class*="option"]:not([style*="display: none"]), li[role="option"], li[class*="item"]'
    ).catch(() => []);
    for (const opt of opts) {
      const t = await opt.innerText().catch(() => '');
      if (labels.some(l => t.toLowerCase().includes(l.toLowerCase())) ||
          (email && t.toLowerCase().includes(email.toLowerCase()))) {
        await opt.click();
        await this.page.waitForTimeout(300);
        return true;
      }
    }
    return false;
  }

  /* ── Wizard "Next >" helper — advances one step in the CF wizard ─────────── */

  async _clickWizardNext(ctx = 'WIZARD') {
    await this.page.waitForTimeout(WAIT_M);
    for (const sel of [
      'button:has-text("Next >")', 'button:has-text("Next")',
      'a:has-text("Next >")', 'a:has-text("Next")',
      'input[type="button"][value*="Next" i]',
    ]) {
      const btn = await this.page.$(sel).catch(() => null);
      if (!btn || !(await btn.isVisible().catch(() => false))) continue;
      await btn.click();
      await this.page.waitForTimeout(WAIT_L);
      this.log(ctx, `"Next >" clicked → advancing wizard step`);
      return true;
    }
    this.log(ctx, 'No "Next >" button found on this step');
    return false;
  }

  /* ── 6: Skip pre-migration page (Step 2 → Step 3 User Mapping) ───────────── */

  async _skipPreMigration() {
    this.log('PREMIG', 'Checking for pre-migration step');
    await this.page.waitForTimeout(WAIT_M);

    // Look for an explicit Skip Pre-Migration button first
    for (const sel of [
      'button:has-text("Skip Pre-Migration")', 'button:has-text("Skip Pre Migration")',
      'a:has-text("Skip Pre-Migration")', 'button:has-text("Skip")', 'a:has-text("Skip")',
      '[class*="skip"]', '[id*="skip"]',
    ]) {
      const btn = await this.page.$(sel).catch(() => null);
      if (!btn || !(await btn.isVisible().catch(() => false))) continue;
      await btn.click();
      await this.page.waitForTimeout(WAIT_L);
      this.log('PREMIG', `Skipped pre-migration via: ${sel}`);
      return;
    }

    // No skip button — advance with Next (some CF builds go straight to User Mapping)
    const advanced = await this._clickWizardNext('PREMIG');
    if (!advanced) this.log('PREMIG', 'Pre-migration step not found or already skipped');
  }

  /* ── 7: User mapping — auto-map OR upload manual CSV ─────────────────────── */

  async _handleUserMapping(mappingType = 'auto', userMappings = [], csvPath = null) {
    const csvPathExists = csvPath && fs.existsSync(csvPath);
    this.log('MAPPING', `Starting user mapping: ${csvPathExists ? `CSV path: ${csvPath}` : `${userMappings.length} pair(s) from dashboard`}`);
    await this.page.waitForTimeout(WAIT_L);

    // Ensure we are on the Users tab (the Map & Migrate wizard has tabs)
    for (const sel of [
      'a:has-text("Users")', 'button:has-text("Users")',
      '[role="tab"]:has-text("Users")', 'li:has-text("Users") a',
      'span:has-text("Users")',
    ]) {
      const tab = await this.page.$(sel).catch(() => null);
      if (tab && await tab.isVisible().catch(() => false)) {
        await tab.click().catch(() => {});
        await this.page.waitForTimeout(WAIT_M);
        this.log('MAPPING', 'Clicked Users tab');
        break;
      }
    }

    // Check if mappings already exist — skip auto-map if the table already shows "Mapped"
    const alreadyMapped = await this.page.evaluate(() => {
      const body = document.body.textContent || '';
      return body.includes('Mapped') &&
             (body.includes('Source User') || body.includes('Mapping Status'));
    }).catch(() => false);

    if (alreadyMapped) {
      this.log('MAPPING', 'Mapping already exists in table — skipping');
    } else if (csvPathExists || userMappings.length > 0) {
      // Upload CSV via the "CSV ↑" button on the Users tab
      const uploaded = await this._uploadMappingCSV(userMappings, csvPathExists ? csvPath : null);
      if (!uploaded) {
        this.log('MAPPING', 'CSV upload unavailable — falling back to Auto Map');
        await this._triggerAutoMap();
      }
    } else {
      // No specific pairs provided — use Auto Map
      await this._triggerAutoMap();
    }

    // After mapping, try to save/confirm the mapping table if a Save/Apply button is present
    await this.page.waitForTimeout(WAIT_M);
    for (const sel of [
      'button:has-text("Save Mapping")', 'button:has-text("Save User Mapping")',
      'button:has-text("Save")', 'button:has-text("Apply Mapping")',
      'button:has-text("Submit")',
    ]) {
      const btn = await this.page.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.click();
        await this.page.waitForTimeout(WAIT_L);
        this.log('MAPPING', `Mapping saved via: ${sel}`);
        break;
      }
    }

    // Dismiss confirmation dialogs (up to 5 rounds — CF sometimes chains multiple dialogs)
    for (let round = 0; round < 5; round++) {
      await this.page.waitForTimeout(500);
      let dismissed = false;
      for (const sel of [
        'button:has-text("Confirm")', 'button:has-text("OK")', 'button:has-text("Yes")',
        'button:has-text("Apply")', 'button:has-text("Proceed")',
        '[role="dialog"] button:has-text("OK")', '[role="dialog"] button:has-text("Yes")',
        '.modal button:has-text("OK")', '.modal button:has-text("Yes")',
        '.modal-footer button:has-text("OK")', '.modal-footer button:has-text("Confirm")',
      ]) {
        const btn = await this.page.$(sel).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) {
          await btn.click();
          await this.page.waitForTimeout(WAIT_M);
          this.log('MAPPING', `Dialog dismissed (${round + 1}): ${sel}`);
          dismissed = true;
          break;
        }
      }
      if (!dismissed) break;
    }

    // Wait for the mapping table to show mapped status
    try {
      await this.page.waitForFunction(
        () => {
          const body = document.body.textContent || '';
          return body.includes('Mapped') || body.toLowerCase().includes('mapping complete');
        },
        { timeout: 10000 }
      );
      this.log('MAPPING', 'Mapping confirmed in UI ✓');
    } catch {
      this.log('MAPPING', 'Mapping status not visible — proceeding to channels');
    }

    // Do NOT click Next here — _selectChannels handles Public/Private tabs
    // within Step 3 before advancing to Step 4
    this.log('MAPPING', 'User mapping done ✓');
  }

  /* ── Auto Map helper (extracted so it can be called as fallback) ─────────── */

  async _triggerAutoMap() {
    let clicked = false;
    for (const sel of [
      'button:has-text("Auto Map")', 'button:has-text("Auto-Map")',
      'button:has-text("Auto Mapping")', 'button:has-text("Automap")',
      'button:has-text("Map Automatically")', 'a:has-text("Auto Map")',
      '[class*="auto-map"]', '[id*="automap"]', '[id*="auto-map"]',
    ]) {
      const btn = await this.page.$(sel).catch(() => null);
      if (!btn || !(await btn.isVisible().catch(() => false))) continue;
      await btn.click();
      await this.page.waitForTimeout(WAIT_L);
      this.log('MAPPING', `Auto Map clicked: ${sel}`);
      clicked = true;
      break;
    }
    if (!clicked) {
      this.log('MAPPING', 'Auto Map button not found — mapping may already be set');
    } else {
      // Wait for mapping rows to populate
      try {
        await this.page.waitForFunction(
          () => {
            const body = document.body.textContent || '';
            return body.includes('Mapped') || body.toLowerCase().includes('mapping complete');
          },
          { timeout: 15000 }
        );
        this.log('MAPPING', 'Auto-mapping rows populated ✓');
      } catch {
        this.log('MAPPING', 'Mapping table not confirmed within 15s — continuing');
      }
    }
  }

  /* ── 8: Initiate channel + DM migration via CloudFuze API ────────────────── */

  async _initiateMigrationViaAPI() {
    const {
      channelIds     = [],
      dmIds          = [],
      channelObjects = [],
      dmObjects      = [],
      sourcePlatform,
      destinationPlatform,
      sourceEmail,
      destinationEmail,
      migrationType  = 'ONE_TIME',
    } = this.opts;

    const totalTargets = channelIds.length + dmIds.length;
    if (totalTargets === 0) {
      this.log('MIGRATE', 'No channels/DMs specified — skipping CF API initiation');
      return;
    }

    this.log('MIGRATE', `Initiating Channel Migration via CloudFuze API — ${channelIds.length} channel(s) + ${dmIds.length} DM(s)`);

    try {
      const { triggerChatMigration } = require('../clients/migrationClient');

      const result = await triggerChatMigration({
        sourcePlatform,
        destinationPlatform,
        sourceEmail,
        destinationEmail,
        channelIds,
        dmIds,
        channelObjects,
        dmObjects,
        migrationType,
        executionId: null,
      });

      this.log('MIGRATE', `Initiate Channel Migration: ${result.initiated}/${result.totalTargets} started — status: ${result.status}`);

      if (Array.isArray(result.results)) {
        result.results.forEach(r => {
          if (r.status === 'INITIATED') {
            this.log('MIGRATE', `✓ ${r.kind} [${r.target}] → jobId: ${r.jobId}`);
          } else {
            this.err('MIGRATE', `✗ ${r.kind} [${r.target}]: ${r.error || 'FAILED'}`);
          }
        });
      }

      if (result.status === 'FAILED') {
        this.err('MIGRATE', 'All channel migrations failed — check CF API credentials and channel IDs');
      }
    } catch (e) {
      this.err('MIGRATE', `CF API migration error: ${e.message}`);
      // Don't re-throw — still navigate to reports so user can inspect
    }
  }

  /* ── CSV generation + upload for manual mapping ──────────────────────────── */

  /**
   * Upload the user-mapping CSV on the Users tab of Map & Migrate.
   *
   * Resolves the file in this order:
   *   1. csvPath argument (if it exists on disk) — file is NOT deleted afterward.
   *   2. Generated temp CSV from the userMappings pairs — deleted in finally.
   *
   * Returns true on success, false if no upload trigger / file input could be found.
   */
  async _uploadMappingCSV(userMappings = [], csvPath = null) {
    let filePath;
    let cleanupTemp = false;

    if (csvPath && fs.existsSync(csvPath)) {
      filePath = csvPath;
      this.log('MAPPING', `Uploading user-provided CSV: ${csvPath}`);
    } else {
      const rows = ['Source User,Destination User'];
      for (const m of userMappings) {
        if (m.sourceEmail && m.destinationEmail) {
          rows.push(`${m.sourceEmail},${m.destinationEmail}`);
        }
      }
      if (rows.length < 2) {
        this.log('MAPPING', 'No CSV pairs available to upload');
        return false;
      }
      filePath = path.join(os.tmpdir(), `cf_user_mapping_${Date.now()}.csv`);
      fs.writeFileSync(filePath, rows.join('\n'), 'utf8');
      cleanupTemp = true;
      this.log('MAPPING', `Generated CSV from ${rows.length - 1} pair(s): ${rows.slice(1).join(' | ')}`);
    }

    let uploaded = false;
    try {
      // Strategy A — find an existing file input directly (Playwright handles hidden inputs)
      let fileInput = await this.page.$('input[type="file"]').catch(() => null);
      if (fileInput) {
        await fileInput.setInputFiles(filePath);
        await this.page.waitForTimeout(WAIT_L);
        this.log('MAPPING', 'CSV uploaded via direct input[type="file"] ✓');
        uploaded = true;
      } else {
        // Strategy B — click the "CSV ↑" upload trigger and use Playwright's filechooser event.
        // The CF UI has TWO buttons labelled "CSV": first is download (↓), second is upload (↑).
        // We use multiple identification strategies (icon class, aria-label, "second CSV" heuristic).
        const fileChooserPromise = this.page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);

        const clickedTrigger = await this._clickCSVUploadTrigger();
        if (clickedTrigger) {
          const fileChooser = await fileChooserPromise;
          if (fileChooser) {
            await fileChooser.setFiles(filePath);
            await this.page.waitForTimeout(WAIT_L);
            this.log('MAPPING', 'CSV uploaded via filechooser ✓');
            uploaded = true;
          } else {
            // Trigger may have just unhid a file input — try once more
            await this.page.waitForTimeout(WAIT_M);
            fileInput = await this.page.$('input[type="file"]').catch(() => null);
            if (fileInput) {
              await fileInput.setInputFiles(filePath);
              await this.page.waitForTimeout(WAIT_L);
              this.log('MAPPING', 'CSV uploaded via revealed input[type="file"] ✓');
              uploaded = true;
            }
          }
        }
      }

      if (!uploaded) {
        this.log('MAPPING', 'CSV upload trigger / file input not found');
        return false;
      }

      // Click any confirmation button that appears in the upload modal
      for (const sel of [
        'button:has-text("Upload")', 'button:has-text("Import")',
        'button:has-text("Apply")', 'button:has-text("Save")',
        'button:has-text("Submit")', 'button:has-text("Confirm")',
        'button:has-text("OK")',
      ]) {
        const btn = await this.page.$(sel).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) {
          await btn.click();
          await this.page.waitForTimeout(WAIT_M);
          this.log('MAPPING', `Upload modal confirm clicked: ${sel}`);
          break;
        }
      }

      // Wait for mapping rows to reflect the upload (Mapped status or success toast)
      try {
        await this.page.waitForFunction(
          () => {
            const body = document.body.textContent || '';
            return body.includes('Mapped') ||
                   body.toLowerCase().includes('successfully') ||
                   body.toLowerCase().includes('imported');
          },
          { timeout: 10000 }
        );
        this.log('MAPPING', 'CSV mapping reflected in UI ✓');
      } catch {
        this.log('MAPPING', 'Mapping table not updated yet — proceeding');
      }
    } finally {
      if (cleanupTemp) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return uploaded;
  }

  /**
   * Find and click the "CSV ↑" (upload) button on the Users tab.
   * Tries explicit upload selectors first; falls back to selecting the LAST
   * element whose visible text equals "CSV" (download is first, upload is second).
   */
  async _clickCSVUploadTrigger() {
    // Strategy 1: explicit upload affordances (title / aria-label / icon classes)
    const explicitSelectors = [
      'button[title*="upload" i]', 'button[aria-label*="upload" i]',
      'button[title*="import" i]', 'button[aria-label*="import" i]',
      'button:has(i.fa-upload)', 'button:has(i.fa-file-upload)',
      'button:has(i.fa-arrow-up)', 'button:has([class*="arrow-up"])',
      'button:has([class*="upload"])', 'a:has([class*="upload"])',
      'button:has-text("Upload CSV")', 'button:has-text("Import CSV")',
    ];
    for (const sel of explicitSelectors) {
      const btn = await this.page.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        this.log('MAPPING', `Upload CSV trigger clicked: ${sel}`);
        return true;
      }
    }

    // Strategy 2: Playwright element-handle heuristic.
    // CF renders two CSV buttons side by side: "↓ CSV" (download) and "↑ CSV" (upload).
    // We collect ALL leaf buttons/anchors/spans whose visible text contains "csv",
    // prefer the one whose outerHTML hints "upload", else fall back to the LAST candidate
    // (CF layout: download = first, upload = second).
    // IMPORTANT: we use Playwright's trusted element.click() — NOT evaluate()+click() —
    // so the browser treats it as a real user gesture and opens the native file picker.
    const allEls = await this.page.$$('button, a, span, [role="button"]').catch(() => []);
    const csvCandidates = [];
    for (const el of allEls) {
      try {
        if (!await el.isVisible()) continue;
        const text = (await el.innerText().catch(() => '')).trim();
        if (!text || !/csv/i.test(text)) continue;
        // Skip containers that wrap other interactive children
        const hasInteractiveChildren = await el.evaluate(
          n => n.querySelectorAll('button, a, [role="button"]').length > 0
        ).catch(() => false);
        if (hasInteractiveChildren) continue;
        csvCandidates.push(el);
      } catch { continue; }
    }

    if (csvCandidates.length === 0) {
      this.log('MAPPING', 'Upload CSV trigger not found — no CSV-labelled buttons visible');
      return false;
    }

    // Log candidates for debugging
    const candidateTexts = [];
    for (const el of csvCandidates) {
      candidateTexts.push((await el.innerText().catch(() => '')).trim().slice(0, 30));
    }
    this.log('MAPPING', `CSV button candidates (${csvCandidates.length}): ${candidateTexts.join(' | ')}`);

    // Prefer the element whose HTML hints at upload
    let target = null;
    for (const el of csvCandidates) {
      const html = await el.evaluate(n => n.outerHTML.toLowerCase()).catch(() => '');
      const text = await el.innerText().catch(() => '');
      if (
        html.includes('upload') || html.includes('import') ||
        html.includes('arrow-up') || html.includes('arrow_up') ||
        html.includes('fa-upload') || html.includes('fa-file-upload') ||
        text.includes('↑')
      ) {
        target = el;
        break;
      }
    }
    // Fall back to last candidate (download is first, upload is second in CF layout)
    if (!target) target = csvCandidates[csvCandidates.length - 1];

    const targetText = (await target.innerText().catch(() => 'unknown')).trim().slice(0, 30);
    // Trusted Playwright click — generates real user gesture, opens native file picker
    await target.click().catch(() => {});
    this.log('MAPPING', `Upload CSV trigger clicked via Playwright: "${targetText}"`);
    await this.page.waitForTimeout(500);
    return true;
  }

  /* ── 8: Select EXACTLY the right channels / DMs ──────────────────────────── */

  async _selectChannels(channelIds, channelObjects, dmIds, dmObjects) {
    const totalChannels = channelIds.length;
    const totalDMs      = dmIds.length;

    if (totalChannels === 0 && totalDMs === 0) {
      this.log('CHANNELS', 'No channels/DMs specified — skipping');
      return;
    }

    this.log('CHANNELS', `Selecting ${totalChannels} channel(s) + ${totalDMs} DM(s)`);
    await this.page.waitForTimeout(WAIT_L);

    // Split by the channelType set during channel fetch (normCh assigns 'public' or 'private')
    const publicChannels  = channelObjects.filter(c => (c.channelType || '').toLowerCase() === 'public');
    const privateChannels = channelObjects.filter(c => (c.channelType || '').toLowerCase() === 'private');

    this.log('CHANNELS', `public=${publicChannels.length} private=${privateChannels.length} dms=${dmObjects.length}`);

    // ── Public Channels tab ──────────────────────────────────────────────────
    if (publicChannels.length > 0) {
      this.log('CHANNELS', `Public Channels tab — selecting ${publicChannels.length}`);
      const tabClicked = await this._clickCFTab(['Public Channels', 'Public Channel', 'Channels']);
      await this.page.waitForTimeout(WAIT_L);
      if (tabClicked) await this._selectChannelRows(publicChannels);
    } else {
      this.log('CHANNELS', 'No public channels selected — skipping Public Channels tab');
    }

    // ── Private Channels tab ─────────────────────────────────────────────────
    if (privateChannels.length > 0) {
      this.log('CHANNELS', `Private Channels tab — selecting ${privateChannels.length}`);
      const tabClicked = await this._clickCFTab(['Private Channels', 'Private Channel']);
      await this.page.waitForTimeout(WAIT_L);
      if (tabClicked) await this._selectChannelRows(privateChannels);
    } else {
      this.log('CHANNELS', 'No private channels selected — skipping Private Channels tab');
    }

    // ── Advance from Map & Migrate (Step 3) → Direct Messages (Step 4) ──────
    await this.page.waitForTimeout(WAIT_M);
    await this._clickWizardNext('CHANNELS');

    // ── Step 5: Direct Messages ───────────────────────────────────────────────
    if (dmObjects.length > 0) {
      this.log('CHANNELS', `Selecting ${dmObjects.length} DM(s) on Direct Messages step`);
      await this._selectChannelRows(dmObjects);
    } else {
      this.log('CHANNELS', 'No DMs to select — ready for migration initiation');
    }

    this.log('CHANNELS', 'Channel/DM selection complete ✓');
    await this.page.waitForTimeout(WAIT_M);
  }

  /* ── Tab click helper for the CF Map & Migrate wizard ────────────────────── */

  async _clickCFTab(tabLabels) {
    for (const label of tabLabels) {
      for (const sel of [
        `a:has-text("${label}")`,
        `button:has-text("${label}")`,
        `[role="tab"]:has-text("${label}")`,
        `li:has-text("${label}")`,
        `span:has-text("${label}")`,
      ]) {
        const el = await this.page.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) {
          await el.click();
          await this.page.waitForTimeout(WAIT_M);
          this.log('CHANNELS', `Tab selected: ${label}`);
          return true;
        }
      }
    }
    this.log('CHANNELS', `Tab not found: ${tabLabels.join(' / ')}`);
    return false;
  }

  /* ── Select table rows by channel/DM name or ID ─────────────────────────── */

  async _selectChannelRows(channelList) {
    if (!channelList || channelList.length === 0) return;

    // Build both display-name targets and raw-ID targets for matching
    const nameTargets = channelList
      .map(c => (c.name || c.channelName || c.displayName || '')
        .toLowerCase().replace(/^#/, '').trim())
      .filter(n => n.length > 0 && !/^[a-z0-9]{8,}$/.test(n)); // skip pure IDs as names

    const idTargets = channelList
      .map(c => (c.id || c.channelId || c.fromRootId || '').toLowerCase().trim())
      .filter(Boolean);

    const allTargets = [...new Set([...nameTargets, ...idTargets])];

    if (allTargets.length === 0) {
      this.log('CHANNELS', 'No targets to match — nothing to select');
      return;
    }
    this.log('CHANNELS', `Matching targets: ${allTargets.slice(0, 8).join(', ')}`);

    const searchSels = [
      'input[type="search"]',
      'input[placeholder*="search" i]',
      'input[placeholder*="channel" i]',
      'input[placeholder*="filter" i]',
      'input[placeholder*="name" i]',
    ];

    let matched = 0;

    // Pass 1: try to match each target by text content and data attributes
    for (const target of allTargets) {
      let searchInput = null;
      for (const sel of searchSels) {
        const inp = await this.page.$(sel).catch(() => null);
        if (inp && await inp.isVisible().catch(() => false)) { searchInput = inp; break; }
      }
      if (searchInput) {
        await searchInput.fill(target);
        await this.page.waitForTimeout(700);
      }

      const found = await this.page.evaluate(({ target }) => {
        const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/^#/, '').trim();
        const rows = Array.from(document.querySelectorAll('tr'));
        for (const row of rows) {
          if (!row.querySelector('input[type="checkbox"]')) continue;

          // Match 1: row text content includes target
          const txt = norm(row.textContent || '');
          if (txt.includes(target)) {
            const cb = row.querySelector('input[type="checkbox"]');
            if (!cb) continue;
            if (!cb.checked) { cb.click(); cb.dispatchEvent(new Event('change', { bubbles: true })); }
            const cells = Array.from(row.querySelectorAll('td'));
            const label = cells.length > 1 ? cells[1] : cells[0];
            return { how: 'text', label: norm((label || row).textContent || '').slice(0, 60) };
          }

          // Match 2: any attribute on the row or its cells contains the target ID
          const rowHtml = row.innerHTML.toLowerCase();
          if (rowHtml.includes(target)) {
            const cb = row.querySelector('input[type="checkbox"]');
            if (!cb) continue;
            if (!cb.checked) { cb.click(); cb.dispatchEvent(new Event('change', { bubbles: true })); }
            return { how: 'html-attr', label: txt.slice(0, 60) };
          }
        }
        return null;
      }, { target }).catch(() => null);

      if (found) {
        this.log('CHANNELS', `✓ Checked (${found.how}): "${found.label}"`);
        matched++;
      } else {
        this.log('CHANNELS', `⚠ No row for: "${target}"`);
      }

      if (searchInput) {
        await searchInput.fill('').catch(() => {});
        await this.page.waitForTimeout(300);
      }
    }

    // Pass 2: if nothing matched, select ALL visible rows on this tab as fallback
    // (The CF table already shows channels from the correct source cloud)
    if (matched === 0 && channelList.length > 0) {
      this.log('CHANNELS', 'No rows matched by name/ID — selecting ALL visible rows on this tab');
      const selectCount = await this.page.evaluate(() => {
        let n = 0;
        document.querySelectorAll('tr').forEach(row => {
          const cb = row.querySelector('input[type="checkbox"]');
          if (cb && !cb.checked) {
            cb.click();
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            n++;
          }
        });
        return n;
      }).catch(() => 0);
      this.log('CHANNELS', `Select-all fallback: ${selectCount} rows selected`);
    } else {
      this.log('CHANNELS', `${matched}/${allTargets.length} targets matched on this tab`);
    }
  }

  /* ── 9: Start Migration + dismiss dialogs ────────────────────────────────── */

  async _startMigration() {
    this.log('MIGRATE', 'Step 5 (Direct Messages) — looking for Initiate Migration button');
    await this.page.waitForTimeout(WAIT_M);

    const btnSels = [
      'button:has-text("Initiate Migration")', 'button:has-text("Start Migration")',
      'button:has-text("Initiate Channel Migration")', 'button:has-text("Start Migrate")',
      'button:has-text("Migrate")',
      'a:has-text("Initiate Migration")', 'a:has-text("Start Migration")',
      'input[value*="Initiate" i]', 'input[value*="Start" i]', 'input[value*="Migrate" i]',
      '[class*="start-migration"]', '[class*="startMigration"]',
      '[id*="start-migration"]', '[id*="startMigration"]',
      '[class*="initiate"]', '[id*="initiate"]',
    ];

    let clicked = false;
    for (const sel of btnSels) {
      const btn = await this.page.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.click();
        this.log('MIGRATE', `Initiate Channel Migration clicked: ${sel}`);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      this.log('MIGRATE', 'Initiate Migration button not found — waiting 15s for manual click');
      await this.page.waitForTimeout(15_000);
      return;
    }

    await this.page.waitForTimeout(WAIT_L);

    // Dismiss up to 5 dialog rounds
    for (let round = 1; round <= 5; round++) {
      let dismissed = false;
      for (const sel of [
        'button:has-text("Confirm")', 'button:has-text("Yes")', 'button:has-text("OK")',
        'button:has-text("Proceed")', 'button:has-text("Override")',
        'button:has-text("Overwrite")', 'button:has-text("Replace All")',
        'button:has-text("Continue")', 'button:has-text("Ignore")',
        '[role="dialog"] button:has-text("OK")', '[role="dialog"] button:has-text("Yes")',
        '[role="alertdialog"] button',
        '[class*="modal"] button:has-text("OK")', '[class*="confirm"] button',
      ]) {
        const btn = await this.page.$(sel).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) {
          await btn.click().catch(() => {});
          this.log('MIGRATE', `Dialog dismissed (round ${round}): ${sel}`);
          dismissed = true;
          await this.page.waitForTimeout(WAIT_M);
          break;
        }
      }
      if (!dismissed) break;
    }

    await this.page.waitForTimeout(WAIT_L);
    this.log('MIGRATE', 'Migration submitted ✓');
  }

  /* ── 10: Reports page ────────────────────────────────────────────────────── */

  async _openReports() {
    this.log('REPORTS', `→ ${CF_REPORTS_URL}`);
    await this.page.goto(CF_REPORTS_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await this.page.waitForTimeout(WAIT_L);
    this.log('REPORTS', 'Reports page loaded — migration running, channels/DMs visible in reports.');
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   Singleton session manager
   ══════════════════════════════════════════════════════════════════════════════ */

let _activeSession = null;
let _sessionEvents = [];

async function startSession(opts) {
  if (_activeSession && !_activeSession.aborted) {
    logger.info('[CFBrowser] Aborting previous session');
    await _activeSession.abort().catch(() => {});
    _activeSession = null;
  }
  _sessionEvents = [];

  // Create an execution entry so CF browser events appear in the Execution Logs page
  const { v4: uuidv4 } = require('uuid');
  const executionService = require('./executionService');
  const logsDir = path.join(__dirname, '../../logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const executionId = uuidv4();
  const fakeCtx = {
    executionId,
    toJSON: () => ({
      executionId,
      kind: 'cf-browser',
      sourceEmail:    opts.sourceEmail    || '',
      destinationEmail: opts.destinationEmail || '',
      sourcePlatform: opts.sourcePlatform || '',
      destinationPlatform: opts.destinationPlatform || '',
      combination:    opts.combination    || '',
      migrationType:  'CF_BROWSER',
    }),
  };
  executionService.create(fakeCtx);
  executionService.update(executionId, { status: 'RUNNING', currentAgent: 'CFBrowserAutomation', progress: 'Browser launched' });

  const logFile = path.join(logsDir, `${executionId}.log`);
  const appendLog = (level, msg) => {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message: msg }) + '\n';
    fs.appendFileSync(logFile, line, 'utf8');
  };

  const session = new CFBrowserAutomation(opts);
  _activeSession = session;
  const push = e => _sessionEvents.push(e);

  session.on('progress', e => {
    push({ type: 'progress', ...e });
    appendLog('INFO', `${e.step}: ${e.detail || ''}`);
    executionService.update(executionId, { currentAgent: e.step, progress: e.detail || '' });
  });
  session.on('error-step', e => {
    push({ type: 'error-step', ...e });
    appendLog('ERROR', `${e.step}: ${e.detail || ''}`);
  });
  session.on('done', e => {
    push({ type: 'done', ...e });
    appendLog('INFO', 'Migration started — Reports page open');
    executionService.update(executionId, { status: 'COMPLETED', currentAgent: 'Done', progress: 'Migration started in CloudFuze', completedAt: new Date().toISOString() });
    _activeSession = null;
  });
  session.on('failed', e => {
    push({ type: 'failed', ...e });
    appendLog('ERROR', `FAILED: ${e.error || 'Unknown error'}`);
    executionService.update(executionId, { status: 'FAILED', currentAgent: 'Failed', progress: e.error || 'Browser automation failed', completedAt: new Date().toISOString() });
    _activeSession = null;
  });

  session.run().catch(err => {
    logger.error(`[CFBrowser] Unhandled: ${err.message}`);
    push({ type: 'failed', error: err.message, ts: Date.now() });
    appendLog('ERROR', `Unhandled: ${err.message}`);
    executionService.update(executionId, { status: 'FAILED', progress: err.message, completedAt: new Date().toISOString() });
    _activeSession = null;
  });

  return { started: true, sessionRef: session, executionId };
}

async function abortSession() {
  if (_activeSession) {
    await _activeSession.abort();
    _activeSession = null;
    return { aborted: true };
  }
  return { aborted: false, reason: 'No active session' };
}

function getSessionEvents() {
  return { running: !!_activeSession && !_activeSession.aborted, events: _sessionEvents };
}

module.exports = { startSession, abortSession, getSessionEvents, CF_REPORTS_URL };
