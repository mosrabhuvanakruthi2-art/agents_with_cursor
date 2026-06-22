const { BaseAgent } = require('../core/BaseAgent');
const migrationClient = require('../../clients/migrationClient');
// devemail uses separate auth flow:
// POST /auth/user → App JWT → POST /mail/register → Mail JWT → POST /mail/move/initiate
const devemailClient = require('../../clients/devemailClient');
const outlookClient = require('../../clients/outlookClient');
const gmailClient = require('../../clients/gmailClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const executionService = require('../../services/executionService');

const MAX_POLL_MINUTES = parseInt(process.env.MIGRATION_MAX_WAIT_MINUTES, 10) || 30;
const POLL_INTERVAL_MS = 30000;
const STABLE_CHECKS_NEEDED = 3;

// Content migration statuses that mean "stop here, get report, skip validation"
const CONTENT_STOP_STATUSES = new Set([
  'VERSION_NOT_PROCESSED',
  'IN_PROGRESS',
  'INPROGRESS',
  'NOT_PROCESSED',
  'CONFLICTS',
  'CONFLICT',
  'PROCESSED_WITH_CONFLICTS',
  'PROCESS_WITH_CONFLICTS',
  'PROCESSED_WITH_CONFLICT_AND_PAUSE',
  'PAUSE',
  'FAILED',
  'ERROR',
]);

// Content migration statuses that mean "success — proceed to validation"
const CONTENT_SUCCESS_STATUSES = new Set([
  'PROCESSED',
  'PROCESS',
  'VERSION_PROCESSED',
]);

class MigrationAgent extends BaseAgent {
  constructor() {
    super('MigrationAgent');
    this.jobId = null;
    this.retries = 0;
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });

    const bump = (msg) => {
      executionService.update(context.executionId, { progress: msg });
    };

    // ── Runtime server override ───────────────────────────────────
    // If the form provided a server URL, use it instead of the env default.
    if (context.migrationServerUrl) {
      const hasEmail = Boolean(context.migrationServerEmail);
      const hasPassword = Boolean(context.migrationServerPassword);

      // For content migrations: if no password in form, fall back to env-stored credentials
      const isContentModeLocal = context.mode === 'content';
      const effectiveEmail = context.migrationServerEmail ||
        (isContentModeLocal ? env.CONTENT_MIGRATION_SERVER_EMAIL : '');
      const effectivePassword = context.migrationServerPassword ||
        (isContentModeLocal ? env.CONTENT_MIGRATION_SERVER_PASSWORD : '');

      migrationClient.setRuntimeConfig({
        baseUrl: context.migrationServerUrl,
        email: effectiveEmail || '',
        password: effectiveEmail ? (effectivePassword || '') : '',
        // When no email is given but a password-like token is provided, treat it as a Basic auth override
        basicAuth: (!effectiveEmail && hasPassword) ? context.migrationServerPassword : null,
      });
      log.info(`CloudFuze: using runtime server ${context.migrationServerUrl}${!effectiveEmail && hasPassword ? ' (Basic auth override from UI)' : ''}${isContentModeLocal && !context.migrationServerPassword && effectivePassword ? ' (content mode: password from env)' : ''}`);
      bump(`MigrationAgent: connecting to ${context.migrationServerUrl}…`);
    } else {
      migrationClient.clearRuntimeConfig();
    }

    // Detect devemail server: isNewServer() returns false for devemail URLs.
    // When useDevemail=true, auth + triggerMigration + pollReports go through
    // devemailClient (correct /auth/user → /mail/register flow).
    // When useDevemail=false (newtestemail5), migrationClient handles everything as before.
    const activeUrl = (context.migrationServerUrl || env.MIGRATION_API_URL || '').toLowerCase();
    const useDevemail = !migrationClient.isNewServer() && activeUrl.includes('devemail');

    try {
    // ── Step 0 — Register / Login ─────────────────────────────────
    log.info('CloudFuze: obtaining fresh Bearer JWT…');
    bump('MigrationAgent: authenticating with migration server…');
    if (useDevemail) {
      // devemail: POST /auth/user → App JWT, then POST /mail/register → Mail JWT
      const devEmail = context.migrationServerEmail || env.CLOUDFUZE_OWNER_EMAIL || '';
      const devPassword = context.migrationServerPassword || env.MIGRATION_APP_LOGIN_PASSWORD || '';
      // Set runtime config so resolveEmail() / ownerEmailId use the UI credentials for all
      // subsequent devemailClient calls (triggerMigration, cacheUserMapping, uploadUserCSV, etc.)
      devemailClient.setRuntimeConfig({ email: devEmail, password: devPassword });
      await devemailClient.authenticate(devEmail, devPassword, {
        baseUrl: context.migrationServerUrl || env.MIGRATION_API_URL,
      });
      log.info('CloudFuze devemail: authenticated via /auth/user → /mail/register (correct API flow)');
    } else {
      try {
        await migrationClient.register();
        log.info('CloudFuze: Bearer JWT refreshed');
      } catch (err) {
        log.warn(`CloudFuze register failed (${err.message}) — falling back to login()`);
        bump('MigrationAgent: register failed, falling back to login…');
        await migrationClient.login();
      }
    }

    // ── Validate subscriber (optional) ───────────────────────────
    let ownerValidation = null;
    if (process.env.CLOUDFUZE_SKIP_VALIDATE_USER !== 'true') {
      const ownerEmail = context.migrationServerEmail || env.CLOUDFUZE_OWNER_EMAIL || context.sourceEmail;
      bump(`MigrationAgent: validating subscriber ${ownerEmail}…`);
      log.info(`Validating CloudFuze subscriber: ${ownerEmail}`);
      try {
        const profile = await migrationClient.validateUser(ownerEmail);
        if (profile && profile.enabled === false) {
          throw new Error(`CloudFuze user is disabled: ${ownerEmail}`);
        }
        if (profile && profile.isActive === false) {
          throw new Error(`CloudFuze user is not active: ${ownerEmail}`);
        }
        ownerValidation = {
          userName: profile?.userName || ownerEmail,
          id: profile?.id,
          role: profile?.role,
        };
        log.info(
          `CloudFuze user OK: ${ownerValidation.userName} (id=${ownerValidation.id}, role=${ownerValidation.role || 'n/a'})`
        );
      } catch (err) {
        const status = err?.response?.status;
        if (status >= 500 && status < 600) {
          ownerValidation = {
            skipped: true,
            reason: `validateUser returned HTTP ${status} (CloudFuze server error)`,
          };
          log.warn(`${ownerValidation.reason} — continuing. Set CLOUDFUZE_SKIP_VALIDATE_USER=true to skip entirely.`);
          bump('MigrationAgent: validateUser unavailable (server error) — continuing…');
        } else {
          throw err;
        }
      }
    }

    // ── Step 1 — Resolve cloud IDs ────────────────────────────────
    // If CLOUDFUZE_SOURCE_CLOUD_ID / CLOUDFUZE_DEST_CLOUD_ID are set in .env,
    // skip GET /mail/clouds entirely (it requires a user-session Bearer token).
    // Otherwise fetch the cloud list and match by admin email or domain.
    let sourceCloud, destCloud;

    const isOutlookSrc = context.sourceProvider === 'microsoft';
    const isGmailDst   = context.destinationProvider === 'google';

    // Gmail/Outlook shortcut IDs only apply to Gmail↔Outlook email migrations.
    // Box, SharePoint, OneDrive, Dropbox content migrations must fetch cloud IDs from the API.
    const isEmailOnlyMigration =
      (context.sourceProvider === 'google' || context.sourceProvider === 'microsoft') &&
      (context.destinationProvider === 'google' || context.destinationProvider === 'microsoft');

    if (useDevemail && isEmailOnlyMigration) {
      // devemail Step 1: resolve cloud IDs
      // Priority 1 — use env-configured cloud IDs (set once, no API call needed).
      // Prefer the devemail-specific vars; fall back to the generic OUTLOOK/GMAIL
      // cloud IDs (these point at the same devemail server when MIGRATION_API_URL is
      // the devemail host). GET /users/{userId}/get/all/cloud requires App JWT (🔵)
      // but we only have Mail JWT (🟣) from /mail/login, so the live lookup often 401s.
      const devOutlookCloudId = env.CLOUDFUZE_DEVEMAIL_OUTLOOK_CLOUD_ID || env.CLOUDFUZE_OUTLOOK_CLOUD_ID;
      const devGmailCloudId   = env.CLOUDFUZE_DEVEMAIL_GMAIL_CLOUD_ID   || env.CLOUDFUZE_GMAIL_CLOUD_ID;
      if (devOutlookCloudId && devGmailCloudId) {
        sourceCloud = isOutlookSrc
          ? { id: devOutlookCloudId, cloudName: 'OUTLOOK' }
          : { id: devGmailCloudId,   cloudName: 'GMAIL'   };
        destCloud = isGmailDst
          ? { id: devGmailCloudId,   cloudName: 'GMAIL'   }
          : { id: devOutlookCloudId, cloudName: 'OUTLOOK' };
        log.info(`CloudFuze devemail: cloud IDs from env — source: ${sourceCloud.id} (${sourceCloud.cloudName}), dest: ${destCloud.id} (${destCloud.cloudName})`);
        bump('MigrationAgent: cloud IDs loaded from devemail env vars...');
      } else {
        // Priority 2 — try live getClouds() (requires App JWT; may return 401)
        bump('MigrationAgent: fetching cloud accounts from devemail user account...');
        log.info('CloudFuze devemail: GET /users/{userId}/get/all/cloud');
        try {
          const clouds = await devemailClient.getClouds();
          // Use whatever admin is selected in Run Agent first — that drives the cloud selection.
          // Fall back to env vars only if the context doesn't have admin emails.
          const sourceLookup = context.sourceAdminEmail || env.CLOUDFUZE_SOURCE_ADMIN_EMAIL || context.sourceEmail;
          const destLookup   = context.destAdminEmail   || env.CLOUDFUZE_DEST_ADMIN_EMAIL   || context.destinationEmail;
          log.info(`CloudFuze devemail: looking up source="${sourceLookup}" dest="${destLookup}" in ${clouds.length} clouds`);
          const srcResult  = devemailClient.findCloudId(clouds, sourceLookup);
          const dstResult  = devemailClient.findCloudId(clouds, destLookup);
          if (!srcResult) throw new Error(`devemail: source cloud not found for ${sourceLookup}`);
          if (!dstResult) throw new Error(`devemail: destination cloud not found for ${destLookup}`);
          sourceCloud = srcResult;
          destCloud   = dstResult;
          log.info(`CloudFuze devemail: cloud IDs — source: ${sourceCloud.id} (${sourceCloud.cloudName}), dest: ${destCloud.id} (${destCloud.cloudName})`);
        } catch (err) {
          throw new Error(`[Step 1 devemail getClouds] ${err.message} — set CLOUDFUZE_DEVEMAIL_OUTLOOK_CLOUD_ID and CLOUDFUZE_DEVEMAIL_GMAIL_CLOUD_ID in .env to bypass this`);
        }
      }
    } else if (isEmailOnlyMigration && env.CLOUDFUZE_GMAIL_CLOUD_ID && env.CLOUDFUZE_OUTLOOK_CLOUD_ID) {
      // Direction-aware IDs — correct for all 4 combinations.
      // G→G cross-tenant uses CLOUDFUZE_GMAIL_SOURCE_CLOUD_ID / CLOUDFUZE_GMAIL_DEST_CLOUD_ID
      // when set; otherwise both sides fall back to CLOUDFUZE_GMAIL_CLOUD_ID.
      const isGmailToGmail = !isOutlookSrc && isGmailDst;
      const gmailSrcId = (isGmailToGmail && env.CLOUDFUZE_GMAIL_SOURCE_CLOUD_ID)
        ? env.CLOUDFUZE_GMAIL_SOURCE_CLOUD_ID
        : env.CLOUDFUZE_GMAIL_CLOUD_ID;
      const gmailDstId = (isGmailToGmail && env.CLOUDFUZE_GMAIL_DEST_CLOUD_ID)
        ? env.CLOUDFUZE_GMAIL_DEST_CLOUD_ID
        : env.CLOUDFUZE_GMAIL_CLOUD_ID;
      const outlookId = env.CLOUDFUZE_OUTLOOK_CLOUD_ID;
      sourceCloud = isOutlookSrc
        ? { id: outlookId,  cloudName: 'OUTLOOK' }
        : { id: gmailSrcId, cloudName: 'GMAIL'   };
      destCloud = isGmailDst
        ? { id: gmailDstId, cloudName: 'GMAIL'   }
        : { id: outlookId,  cloudName: 'OUTLOOK' };
      log.info(`CloudFuze: direction-aware cloud IDs — source: ${sourceCloud.id} (${sourceCloud.cloudName}), dest: ${destCloud.id} (${destCloud.cloudName})`);
      bump('MigrationAgent: cloud IDs loaded from env…');
    } else if (isEmailOnlyMigration && env.CLOUDFUZE_SOURCE_CLOUD_ID && env.CLOUDFUZE_DEST_CLOUD_ID) {
      // Legacy SOURCE/DEST IDs — assumed configured for Gmail→Outlook direction.
      // For Outlook→Gmail, swap them automatically.
      const [rawSrcId, rawDstId] = isOutlookSrc
        ? [env.CLOUDFUZE_DEST_CLOUD_ID, env.CLOUDFUZE_SOURCE_CLOUD_ID]  // swap
        : [env.CLOUDFUZE_SOURCE_CLOUD_ID, env.CLOUDFUZE_DEST_CLOUD_ID]; // as-is
      const srcName = isOutlookSrc ? 'OUTLOOK' : 'GMAIL';
      const dstName = isGmailDst   ? 'GMAIL'   : 'OUTLOOK';
      sourceCloud = { id: rawSrcId, cloudName: srcName };
      destCloud   = { id: rawDstId, cloudName: dstName };
      log.info(`CloudFuze: legacy cloud IDs (${isOutlookSrc ? 'swapped for Outlook→Gmail' : 'as-is for Gmail→Outlook'}) — source: ${sourceCloud.id} (${srcName}), dest: ${destCloud.id} (${dstName})`);
      bump('MigrationAgent: cloud IDs loaded from env…');
    } else {
      bump('MigrationAgent: fetching connected cloud accounts…');
      log.info('CloudFuze: GET /mail/clouds');
      const isContentModeForClouds = context.mode === 'content' || (!context.includeMail && (context.includeCalendar || context.includeContacts));
      let clouds;
      try {
        clouds = await migrationClient.getClouds();
      } catch (err) {
        if (isContentModeForClouds) {
          log.warn(`CloudFuze GET /mail/clouds failed (${err.message}) — continuing in content mode with null cloud IDs`);
          clouds = [];
        } else {
          throw new Error(`[Step 1 GET /mail/clouds] ${err?.response?.status ? `HTTP ${err?.response.status}: ` : ''}${err?.message}`);
        }
      }
      log.info(`CloudFuze: ${clouds.length} cloud(s) returned`);

      // For email migrations: prefer .env admin email override (set up for devemail/newtestemail5).
      // For content migrations (Box, SharePoint, etc.): skip env override — use context admin email
      // from the form (e.g. erik@filefuze.co for Box/SharePoint on qarelease).
      const sourceLookup = (isEmailOnlyMigration ? env.CLOUDFUZE_SOURCE_ADMIN_EMAIL : '') || context.sourceAdminEmail || context.sourceEmail;
      const destLookup   = (isEmailOnlyMigration ? env.CLOUDFUZE_DEST_ADMIN_EMAIL   : '') || context.destAdminEmail   || context.destinationEmail;

      const isContentMode = context.mode === 'content' || (!context.includeMail && (context.includeCalendar || context.includeContacts));
      sourceCloud = migrationClient.findCloudId(clouds, sourceLookup);
      if (!sourceCloud) {
        if (isContentMode) {
          log.warn(`CloudFuze: source "${sourceLookup}" not found in /mail/clouds — continuing in content mode with null IDs`);
          sourceCloud = { id: null, cloudName: context.sourceProvider?.toUpperCase() || 'BOX' };
        } else {
          throw new Error(
            `CloudFuze: source "${sourceLookup}" not found in /mail/clouds. ` +
            `Available: ${clouds.map((c) => c.adminEmailId || c.email).join(', ')}`
          );
        }
      }
      destCloud = migrationClient.findCloudId(clouds, destLookup);
      if (!destCloud) {
        if (isContentMode) {
          log.warn(`CloudFuze: destination "${destLookup}" not found in /mail/clouds — continuing in content mode with null IDs`);
          destCloud = { id: null, cloudName: context.destinationProvider?.toUpperCase() || 'SHAREPOINT' };
        } else {
          throw new Error(
            `CloudFuze: destination "${destLookup}" not found in /mail/clouds. ` +
            `Available: ${clouds.map((c) => c.adminEmailId || c.email).join(', ')}`
          );
        }
      }
      log.info(
        `CloudFuze cloud IDs — source: ${sourceCloud.id} (${sourceCloud.cloudName}), ` +
        `dest: ${destCloud.id} (${destCloud.cloudName})`
      );
    }

    context.sourceCloudId   = sourceCloud.id;
    context.destCloudId     = destCloud.id;
    context.sourceCloudName = sourceCloud.cloudName;
    context.destCloudName   = destCloud.cloudName;

    // ── Step 2 — Load destination domains (Selection → Next) ─────
    bump('MigrationAgent: loading destination domains…');
    log.info(`CloudFuze: GET /email/move/domains/${destCloud.id}`);
    try {
      const domains = useDevemail
        ? await devemailClient.getDomains(destCloud.id)
        : await migrationClient.getDomains(destCloud.id);
      const domainList = Array.isArray(domains) ? domains : (domains?.content || []);
      log.info(`CloudFuze: ${domainList.length} domain(s) for destination cloud`);
    } catch (err) {
      log.warn(`CloudFuze getDomains failed (${err.message}) — continuing`);
    }

    // ── Step 3 — Upload user mapping CSV (Mapping page) ──────────
    // The CSV must contain ONLY the pairs explicitly mapped in the Run Agent
    // "Mapped Pairs" section — exactly what the user selected, mirroring what
    // the CloudFuze UI Mapping page shows before clicking Next.
    //
    // context.userEmailMappings comes directly from the Run Agent form:
    //   e.g. [{ sourceEmail: "Alex@qatestagent.com", destinationEmail: "alex@migrationn.com" }]
    //
    // We do NOT add env-level USER_EMAIL_MAPPINGS or auto-derived OUTLOOK_ACCOUNTS
    // pairs — those are for Permission Mapping (Step 4), not the user-to-user CSV.
    const contextMappings = Array.isArray(context.userEmailMappings) ? context.userEmailMappings : [];

    // Build CSV from only the mapped pairs. Always ensure the primary pair is present.
    const seenSources = new Set();
    const csvPairs = [];
    for (const m of contextMappings) {
      const normSrc = String(m.sourceEmail || '').toLowerCase();
      if (normSrc && !seenSources.has(normSrc)) {
        seenSources.add(normSrc);
        csvPairs.push({ sourceEmail: normSrc, destinationEmail: String(m.destinationEmail || '').toLowerCase() });
      }
    }
    // Fallback: ensure primary migration pair is always in the CSV
    const primarySrc = context.sourceEmail.toLowerCase();
    if (!seenSources.has(primarySrc)) {
      csvPairs.push({ sourceEmail: primarySrc, destinationEmail: context.destinationEmail.toLowerCase() });
    }

    log.info(`MigrationAgent: CSV contains ${csvPairs.length} mapped pair(s) from Run Agent`);
    context.csvPairsUploaded = csvPairs.length;
    bump(`MigrationAgent: uploading user mapping CSV (${csvPairs.length} pair(s))…`);
    log.info(`CloudFuze: POST /email/user/csv/${sourceCloud.id}/${destCloud.id} (${csvPairs.length} pair(s))`);
    let mappingSrcId = sourceCloud.id;
    let mappingDstId = destCloud.id;
    try {
      const csvResult = useDevemail
        ? await devemailClient.uploadUserCSV(mappingSrcId, mappingDstId, csvPairs)
        : await migrationClient.uploadUserCSV(mappingSrcId, mappingDstId, csvPairs);
      log.info(`CloudFuze: CSV upload response — ${JSON.stringify(csvResult)}`);
    } catch (err) {
      const errBody = err?.response?.data ? JSON.stringify(err?.response?.data) : '(no body)';
      const isCloudIdError = err?.response?.status === 400 &&
        (String(errBody).toLowerCase().includes('cloud id') || String(errBody).toLowerCase().includes('cloudid'));
      if (isCloudIdError) {
        // Env var IDs may be stale/wrong type for the CSV endpoint — re-fetch live cloud list and retry
        log.warn(`CloudFuze uploadUserCSV: cloud ID rejected (HTTP 400) — fetching live cloud list and retrying`);
        try {
          const liveClouds = await migrationClient.getClouds();
          const liveSrc = migrationClient.findCloudId(
            liveClouds,
            env.CLOUDFUZE_SOURCE_ADMIN_EMAIL || context.sourceAdminEmail || context.sourceEmail
          );
          const liveDst = migrationClient.findCloudId(
            liveClouds,
            env.CLOUDFUZE_DEST_ADMIN_EMAIL || context.destAdminEmail || context.destinationEmail
          );
          if (liveSrc && liveDst) {
            mappingSrcId = liveSrc.id;
            mappingDstId = liveDst.id;
            log.info(`CloudFuze: CSV retry with live IDs — src: ${mappingSrcId}, dst: ${mappingDstId}`);
            const csvRetry = await migrationClient.uploadUserCSV(mappingSrcId, mappingDstId, csvPairs);
            log.info(`CloudFuze: CSV upload retry response — ${JSON.stringify(csvRetry)}`);
          } else {
            log.warn(`CloudFuze: live getClouds() could not resolve src/dst for CSV — skipping mapping upload`);
          }
        } catch (retryErr) {
          log.warn(`CloudFuze uploadUserCSV retry failed (${retryErr.message}) — continuing without mapping upload`);
        }
      } else {
        log.warn(`CloudFuze uploadUserCSV failed (${err.message}) — error body: ${errBody} — continuing to cache step`);
      }
    }

    // ── Step 3b — Confirm user mapping (Select all → Next) ───────
    bump('MigrationAgent: confirming user mapping selection…');
    log.info(`CloudFuze: cache mapping ${mappingSrcId}/${mappingDstId}`);
    try {
      const cacheResult = useDevemail
        ? await devemailClient.cacheUserMapping(mappingSrcId, mappingDstId)
        : await migrationClient.cacheUserMapping(mappingSrcId, mappingDstId);
      log.info(`CloudFuze: cache mapping response — ${JSON.stringify(cacheResult)}`);
    } catch (err) {
      log.warn(`CloudFuze cacheUserMapping failed (${err.message}) — continuing to permission step`);
    }

    // ── Step 4 — Read back Permission Mapping (Step 3 in UI) ─────
    // Fetched AFTER CSV upload so the server has populated source→dest
    // address pairs. Stored in context for deep From/To/CC/BCC validation.
    // Uses mappingSrcId/mappingDstId (may be live IDs after CSV retry).
    bump('MigrationAgent: reading permission mapping for deep validation…');
    log.info(`CloudFuze: GET /email/user/cache/${mappingSrcId}/${mappingDstId}`);
    try {
      const serverMapping = useDevemail
        ? await devemailClient.getPermissionMapping(mappingSrcId, mappingDstId)
        : await migrationClient.getPermissionMapping(mappingSrcId, mappingDstId);
      if (serverMapping.length > 0) {
        context.userEmailMappings = serverMapping;
        log.info(`CloudFuze: ${serverMapping.length} permission mapping(s) stored for From/To/CC/BCC validation`);
      } else {
        log.info('CloudFuze: permission mapping empty — falling back to context userEmailMappings');
      }
    } catch (err) {
      log.warn(`CloudFuze getPermissionMapping error (${err.message}) — continuing with existing mappings`);
    }

    // ── Pre-migration snapshot (read-only) ───────────────────────
    // Captures source folder counts immediately before migration starts.
    // Stored in context so validation + PDF can reference what was in source at T=0.
    if (context.sourceProvider === 'microsoft') {
      bump('MigrationAgent: taking pre-migration source snapshot…');
      try {
        const folders = await outlookClient.getMailFolders(context.sourceEmail);
        const snapshotFolders = folders.map((f) => ({
          name: f.displayName,
          messageCount: f.totalItemCount || 0,
          childFolderCount: f.childFolderCount || 0,
        }));
        context.preMigrationSnapshot = {
          timestamp: new Date().toISOString(),
          totalFolders: snapshotFolders.length,
          totalMessages: snapshotFolders.reduce((s, f) => s + f.messageCount, 0),
          folders: snapshotFolders,
        };
        log.info(
          `Pre-migration snapshot: ${snapshotFolders.length} folders, ` +
          `${context.preMigrationSnapshot.totalMessages} total messages`
        );
      } catch (err) {
        log.warn(`Pre-migration snapshot failed (${err.message}) — continuing`);
      }
    } else if (context.sourceProvider === 'google') {
      bump('MigrationAgent: taking pre-migration Gmail source snapshot…');
      try {
        const srcStats = await gmailClient.getGmailMailboxStats(context.sourceEmail);
        context.preMigrationSnapshot = {
          timestamp: new Date().toISOString(),
          totalMessages: Number(srcStats?.mailCount ?? srcStats?.totalMessages) || 0,
        };
        log.info(`Pre-migration Gmail source snapshot: ${context.preMigrationSnapshot.totalMessages} messages`);
      } catch (err) {
        log.warn(`Pre-migration Gmail source snapshot failed (${err.message}) — continuing`);
      }
    }

    // Capture Gmail destination baseline for Outlook→Gmail so validation can distinguish
    // pre-existing messages from newly migrated ones.
    if (isGmailDst && context.destinationEmail) {
      bump('MigrationAgent: taking pre-migration Gmail destination snapshot…');
      try {
        const dstStats = await gmailClient.getGmailMailboxStats(context.destinationEmail);
        context.preMigrationDestSnapshot = {
          timestamp: new Date().toISOString(),
          totalMessages: Number(dstStats?.mailCount ?? dstStats?.totalMessages) || 0,
        };
        log.info(`Pre-migration Gmail destination snapshot: ${context.preMigrationDestSnapshot.totalMessages} messages`);
      } catch (err) {
        log.warn(`Pre-migration Gmail destination snapshot failed (${err.message}) — continuing`);
      }
    }

    // ── Step 4b — Pre-scan (new server only) ─────────────────────
    // Indexes source mailbox folder structure so /email/move/initiate can
    // resolve sub-folder IDs. Without this, only root-level folders migrate
    // and all sub-folder messages end up in PROCESSED_WITH_CONFLICTS.
    if (migrationClient.isNewServer()) {
      bump('MigrationAgent: triggering pre-scan for folder indexing…');
      log.info('CloudFuze: POST /email/mail/move/initiate/preScan');
      try {
        await migrationClient.triggerPreScan(context.sourceEmail, context.sourceCloudName);
        log.info('CloudFuze: pre-scan triggered — waiting 8s for folder indexing');
        await new Promise((r) => setTimeout(r, 8000));
      } catch (err) {
        log.warn(`CloudFuze pre-scan failed (${err.message}) — continuing without pre-scan`);
      }
    }

    // ── Step 5 — Options & Preview → Start Migration ─────────────
    // One Time: deltaMigration=false, folder=true (labels as folders), calendar=false, contacts=false
    // Delta:    deltaMigration=true,  folder=true, calendar=true, contacts=true
    // Supports all combinations: Gmail→Outlook, Gmail→Gmail, Outlook→Outlook, Outlook→Gmail
    // (fromCloud/toCloud come from the clouds list cloudName for each combination)
    bump(`MigrationAgent: triggering migration ${context.sourceEmail} → ${context.destinationEmail} [${context.migrationType}]…`);
    log.info(`CloudFuze: triggering migration for ${context.sourceEmail} → ${context.destinationEmail}`);
    let triggerResult;
    try {
      // devemail: use Mail JWT via devemailClient (correct auth scope for /mail/move/initiate)
      // newtestemail5: use migrationClient as before
      triggerResult = useDevemail
        ? await devemailClient.triggerMigration(context)
        : await migrationClient.triggerMigration(context);
    } catch (err) {
      throw new Error(`[Step 5 POST initiate] ${err?.response?.status ? `HTTP ${err?.response.status}: ` : ''}${err?.message}`);
    }
    this.jobId = triggerResult.jobId;

    const rawStr = typeof triggerResult.rawResponse === 'string'
      ? triggerResult.rawResponse
      : JSON.stringify(triggerResult.rawResponse);
    log.info(`CloudFuze initiate response: ${rawStr}`);

    // ── Step 6 — Poll for completion ─────────────────────────────
    const deltaMigration = context.migrationType === 'DELTA';
    bump(
      `MigrationAgent: polling for completion every ${POLL_INTERVAL_MS / 1000}s (max ${MAX_POLL_MINUTES} min)…`
    );
    log.info(`CloudFuze: polling reports (deltaMigration=${deltaMigration})`);

    // devemail: poll via devemailClient using Mail JWT (/mail/reports)
    // newtestemail5: poll via migrationClient as before (/email/user/jobs)
    const cfStatus = useDevemail
      ? await devemailClient.pollReports(
          context.sourceEmail,
          MAX_POLL_MINUTES,
          POLL_INTERVAL_MS,
          (attempt, maxPolls, status) => {
            bump(
              `MigrationAgent: /mail/reports poll ${attempt}/${maxPolls}` +
              (status ? ` — ${status}` : ' — job not yet visible')
            );
          },
          context.executionId
        )
      : await migrationClient.pollReports(deltaMigration, context.sourceEmail, {
          maxMinutes: MAX_POLL_MINUTES,
          intervalMs: POLL_INTERVAL_MS,
          executionId: context.executionId,
          onProgress: (attempt, maxPolls, status) => {
            bump(
              `MigrationAgent: /mail/reports poll ${attempt}/${maxPolls}` +
              (status ? ` — ${status}` : ' — job not yet visible')
            );
          },
        });

    // Capture workspace ID + counts from the last matched job (available after pollReports)
    const polledJobDetails = useDevemail
      ? devemailClient.getLastJobDetails()
      : migrationClient.getLastJobDetails();
    // Full job report (newtestemail5 only) — used to build the content migration report.
    const polledJobReport = useDevemail ? null : migrationClient.getLastJobReport();

    let finalStatus;
    if (cfStatus === 'CANCELLED') {
      finalStatus = 'CANCELLED';
    } else if (cfStatus && cfStatus !== 'TIMEOUT') {
      // CloudFuze /mail/reports returned a terminal PROCESS status
      log.info(`CloudFuze /mail/reports terminal status: ${cfStatus}`);
      finalStatus = cfStatus;
    } else {
      // Fallback: poll destination mailbox for message count stabilization.
      // Use Gmail API for Google destination, Graph API for Microsoft destination.
      const isGmailDest = context.destinationProvider === 'google';
      if (!cfStatus) {
        log.info(`CloudFuze /mail/reports: no Bearer token — falling back to ${isGmailDest ? 'Gmail API' : 'Outlook Graph'} polling`);
      } else {
        log.warn(`CloudFuze /mail/reports: timed out — falling back to ${isGmailDest ? 'Gmail API' : 'Outlook Graph'} polling`);
      }
      bump(
        `MigrationAgent: falling back to ${isGmailDest ? 'Gmail API' : 'Outlook Graph'} polling (${context.destinationEmail})…`
      );
      finalStatus = await this._pollDestinationUntilStable(
        context.destinationEmail,
        isGmailDest,
        log,
        context.executionId
      );
    }

    // Store migration job details in context so PDF generator can show them
    context.migrationJobDetails = {
      serverUrl: useDevemail ? devemailClient.BASE_URL : migrationClient.getActiveBaseUrl(),
      workspaceId: polledJobDetails.workspaceId || null,
      totalCount: polledJobDetails.totalCount,
      processedCount: polledJobDetails.processedCount,
      cfStatus: finalStatus,
    };
    log.info(`CloudFuze job details: workspaceId=${context.migrationJobDetails.workspaceId}, total=${context.migrationJobDetails.totalCount}, processed=${context.migrationJobDetails.processedCount}, status=${finalStatus}`);

    // ── Content migration: check if this is a stop status ─────────
    // When mode === 'content' and status is a stop status, skip validation and return a content report.
    const isContentMode = context.mode === 'content' || (!context.includeMail && (context.includeCalendar || context.includeContacts));
    const isContentStopStatus = CONTENT_STOP_STATUSES.has(finalStatus);

    if (isContentMode && isContentStopStatus) {
      log.info(`Content migration stop status "${finalStatus}" — skipping validation, returning report`);
      bump(`MigrationAgent: content migration stopped with status "${finalStatus}" — fetching report…`);

      const contentReport = {
        workspaceId: context.migrationJobDetails.workspaceId,
        status: finalStatus,
        totalCount: context.migrationJobDetails.totalCount,
        processedCount: context.migrationJobDetails.processedCount,
        rawJobData: polledJobReport || null,
        stoppedAt: new Date().toISOString(),
      };
      context.contentMigrationReport = contentReport;

      bump(`MigrationAgent: finished — content migration stopped (${finalStatus})`);
      return {
        jobId: this.jobId,
        finalStatus,
        retriesUsed: this.retries,
        rawResponse: triggerResult.rawResponse,
        ownerValidation,
        migrationJobDetails: context.migrationJobDetails,
        contentMigrationReport: contentReport,
        skipValidation: true,
        cloudIds: {
          sourceCloudId: sourceCloud?.id,
          destCloudId: destCloud?.id,
          sourceCloudName: sourceCloud?.cloudName,
          destCloudName: destCloud?.cloudName,
        },
      };
    }

    // ── Auto-retry delta on partial migration — DISABLED ────────────
    // TODO: re-enable when conflict recovery strategy is finalised.
    // if (finalStatus === 'PROCESSED_WITH_CONFLICTS' && jGap >= 5 && jProcessed < jTotal * 0.9) { ... }

    bump(`MigrationAgent: finished (${finalStatus})`);
    return {
      jobId: this.jobId,
      finalStatus,
      retriesUsed: this.retries,
      rawResponse: triggerResult.rawResponse,
      ownerValidation,
      migrationJobDetails: context.migrationJobDetails,
      contentMigrationReport: (isContentMode && polledJobReport) ? {
        workspaceId: context.migrationJobDetails.workspaceId,
        status: finalStatus,
        totalCount: context.migrationJobDetails.totalCount,
        processedCount: context.migrationJobDetails.processedCount,
        rawJobData: polledJobReport,
      } : undefined,
      cloudIds: {
        sourceCloudId: sourceCloud?.id,
        destCloudId: destCloud?.id,
        sourceCloudName: sourceCloud?.cloudName,
        destCloudName: destCloud?.cloudName,
      },
    };
    } finally {
      // Always clear the runtime config so subsequent runs use env defaults
      migrationClient.clearRuntimeConfig();
      devemailClient.clearState();
    }
  }

  /**
   * Fallback: poll destination mailbox until message count stabilizes
   * (same count > 0 for STABLE_CHECKS_NEEDED consecutive checks at 60s intervals).
   * Uses Gmail API for Google destinations, Outlook Graph API for Microsoft destinations.
   */
  async _pollDestinationUntilStable(destEmail, isGmailDest, log, executionId) {
    const maxPolls = Math.ceil((MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS);
    const apiLabel = isGmailDest ? 'Gmail API' : 'Outlook Graph';
    let lastCount = -1;
    let stableChecks = 0;
    let everSawData = false;

    for (let attempt = 1; attempt <= maxPolls; attempt++) {
      this.retries = attempt;

      const sliceMs = 5000;
      const slices = Math.ceil(POLL_INTERVAL_MS / sliceMs);
      for (let s = 0; s < slices; s++) {
        await new Promise((resolve) => setTimeout(resolve, sliceMs));
        if (executionId && executionService.isCancelled(executionId)) {
          log.info('Migration polling stopped — execution was cancelled by user');
          return 'CANCELLED';
        }
      }

      if (executionId && executionService.isCancelled(executionId)) {
        log.info('Migration polling stopped — execution was cancelled by user');
        return 'CANCELLED';
      }

      try {
        let currentCount;
        if (isGmailDest) {
          const stats = await gmailClient.getGmailMailboxStats(destEmail);
          currentCount = Number(stats?.mailCount ?? stats?.totalMessages) || 0;
        } else {
          currentCount = await outlookClient.getTotalMessageCount(destEmail);
        }
        log.info(`${apiLabel} poll ${attempt}/${maxPolls}: ${currentCount} messages (prev: ${lastCount})`);

        if (currentCount > 0) everSawData = true;

        if (currentCount > 0 && currentCount === lastCount) {
          stableChecks++;
          if (stableChecks >= STABLE_CHECKS_NEEDED) {
            log.info(`Migration complete — count stable at ${currentCount} for ${stableChecks} consecutive checks`);
            return 'COMPLETED';
          }
          log.info(`Count stable (${stableChecks}/${STABLE_CHECKS_NEEDED})…`);
        } else {
          stableChecks = 0;
        }

        lastCount = currentCount;

        if (executionId) {
          executionService.update(executionId, {
            progress: `MigrationAgent: dest messages ${currentCount} (${apiLabel} poll ${attempt}/${maxPolls}, stable streak ${stableChecks}/${STABLE_CHECKS_NEEDED})`,
          });
        }
      } catch (err) {
        log.warn(`Outlook poll ${attempt} error: ${err.message}`);
      }
    }

    log.warn(`Max poll time (${MAX_POLL_MINUTES} min) reached`);
    if (everSawData) {
      log.info('Data observed in destination — treating as completed');
      return 'COMPLETED';
    }
    log.warn('No data appeared in destination — migration may have failed');
    return 'TIMEOUT';
  }

  toJSON() {
    return {
      ...super.toJSON(),
      jobId: this.jobId,
      retries: this.retries,
    };
  }
}

module.exports = MigrationAgent;
