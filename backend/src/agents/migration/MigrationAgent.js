const { BaseAgent } = require('../core/BaseAgent');
const migrationClient = require('../../clients/migrationClient');
const outlookClient = require('../../clients/outlookClient');
const gmailClient = require('../../clients/gmailClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const executionService = require('../../services/executionService');

const MAX_POLL_MINUTES = parseInt(process.env.MIGRATION_MAX_WAIT_MINUTES, 10) || 30;
const POLL_INTERVAL_MS = 60000;
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
      migrationClient.setRuntimeConfig({
        baseUrl: context.migrationServerUrl,
        email: context.migrationServerEmail || '',
        password: hasEmail ? (context.migrationServerPassword || '') : '',
        // When no email is given but a password-like token is provided, treat it as a Basic auth override
        basicAuth: (!hasEmail && hasPassword) ? context.migrationServerPassword : null,
      });
      log.info(`CloudFuze: using runtime server ${context.migrationServerUrl}${!hasEmail && hasPassword ? ' (Basic auth override from UI)' : ''}`);
      bump(`MigrationAgent: connecting to ${context.migrationServerUrl}…`);
    } else {
      migrationClient.clearRuntimeConfig();
    }

    try {
    // ── Step 0 — Register / Login ─────────────────────────────────
    log.info('CloudFuze: obtaining fresh Bearer JWT…');
    bump('MigrationAgent: authenticating with migration server…');
    try {
      await migrationClient.register();
      log.info('CloudFuze: Bearer JWT refreshed');
    } catch (err) {
      log.warn(`CloudFuze register failed (${err.message}) — falling back to login()`);
      bump('MigrationAgent: register failed, falling back to login…');
      await migrationClient.login();
    }

    // ── Validate subscriber (optional) ───────────────────────────
    let ownerValidation = null;
    if (process.env.CLOUDFUZE_SKIP_VALIDATE_USER !== 'true') {
      const ownerEmail = env.CLOUDFUZE_OWNER_EMAIL || context.sourceEmail;
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
        const status = err.response?.status;
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

    if (env.CLOUDFUZE_GMAIL_CLOUD_ID && env.CLOUDFUZE_OUTLOOK_CLOUD_ID) {
      // Direction-aware IDs — correct for BOTH Gmail→Outlook and Outlook→Gmail.
      const gmailId   = env.CLOUDFUZE_GMAIL_CLOUD_ID;
      const outlookId = env.CLOUDFUZE_OUTLOOK_CLOUD_ID;
      sourceCloud = isOutlookSrc
        ? { id: outlookId, cloudName: 'OUTLOOK' }
        : { id: gmailId,   cloudName: 'GMAIL'   };
      destCloud = isGmailDst
        ? { id: gmailId,   cloudName: 'GMAIL'   }
        : { id: outlookId, cloudName: 'OUTLOOK' };
      log.info(`CloudFuze: direction-aware cloud IDs — source: ${sourceCloud.id} (${sourceCloud.cloudName}), dest: ${destCloud.id} (${destCloud.cloudName})`);
      bump('MigrationAgent: cloud IDs loaded from env…');
    } else if (env.CLOUDFUZE_SOURCE_CLOUD_ID && env.CLOUDFUZE_DEST_CLOUD_ID) {
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
          throw new Error(`[Step 1 GET /mail/clouds] ${err.response?.status ? `HTTP ${err.response.status}: ` : ''}${err.message}`);
        }
      }
      log.info(`CloudFuze: ${clouds.length} cloud(s) returned`);

      // Priority: .env override → context admin email → individual user email (domain-matched)
      const sourceLookup = env.CLOUDFUZE_SOURCE_ADMIN_EMAIL || context.sourceAdminEmail || context.sourceEmail;
      const destLookup   = env.CLOUDFUZE_DEST_ADMIN_EMAIL   || context.destAdminEmail   || context.destinationEmail;

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
      const domains = await migrationClient.getDomains(destCloud.id);
      const domainList = Array.isArray(domains) ? domains : (domains?.content || []);
      log.info(`CloudFuze: ${domainList.length} domain(s) for destination cloud`);
    } catch (err) {
      log.warn(`CloudFuze getDomains failed (${err.message}) — continuing`);
    }

    // ── Step 3 — Upload user mapping CSV (Mapping page) ──────────
    // Merge env-level USER_EMAIL_MAPPINGS (all cross-domain pairs) with any
    // per-run context.userEmailMappings. This ensures the server rewrites
    // From/To/Cc/Bcc for every user — not just the primary migration pair.
    const envMappings = Array.isArray(env.userEmailMappings) ? env.userEmailMappings : [];
    const contextMappings = Array.isArray(context.userEmailMappings) ? context.userEmailMappings : [];
    // Merge: start with env mappings, add any context pairs not already covered (dedup by sourceEmail)
    const mergedMappings = [...envMappings];
    for (const m of contextMappings) {
      const normSrc = String(m.sourceEmail || '').toLowerCase();
      if (!mergedMappings.find((e) => e.sourceEmail === normSrc)) {
        mergedMappings.push({ sourceEmail: normSrc, destinationEmail: String(m.destinationEmail || '').toLowerCase() });
      }
    }
    // Always ensure the primary migration pair is present
    const primarySrc = context.sourceEmail.toLowerCase();
    if (!mergedMappings.find((e) => e.sourceEmail === primarySrc)) {
      mergedMappings.push({ sourceEmail: primarySrc, destinationEmail: context.destinationEmail.toLowerCase() });
    }

    // Auto-derive mappings for all same-domain OUTLOOK_ACCOUNTS users by replacing the source
    // domain with the destination domain. This ensures that inbound senders like Dan@qatestagent.com
    // and Ben@qatestagent.com — which are internal tenant users, not external — are included in the
    // CSV so CloudFuze remaps their FROM/TO/CC/BCC addresses correctly.
    if (isOutlookSrc && Array.isArray(env.outlookAccounts) && env.outlookAccounts.length > 0) {
      const srcDomain = context.sourceEmail.toLowerCase().split('@')[1];
      const dstDomain = context.destinationEmail.toLowerCase().split('@')[1];
      if (srcDomain && dstDomain && srcDomain !== dstDomain) {
        let autoAdded = 0;
        for (const account of env.outlookAccounts) {
          const acct = account.toLowerCase().trim();
          if (!acct.endsWith('@' + srcDomain)) continue;
          if (mergedMappings.find((e) => e.sourceEmail === acct)) continue;
          mergedMappings.push({
            sourceEmail: acct,
            destinationEmail: acct.replace('@' + srcDomain, '@' + dstDomain),
          });
          autoAdded++;
        }
        if (autoAdded > 0) {
          log.info(
            `MigrationAgent: auto-derived ${autoAdded} additional user mapping(s) from OUTLOOK_ACCOUNTS ` +
            `(${srcDomain} → ${dstDomain})`
          );
        }
      }
    }

    const csvPairs = mergedMappings.length > 0
      ? mergedMappings
      : [{ sourceEmail: context.sourceEmail, destinationEmail: context.destinationEmail }];
    context.csvPairsUploaded = csvPairs.length;
    bump(`MigrationAgent: uploading user mapping CSV (${csvPairs.length} pair(s))…`);
    log.info(`CloudFuze: POST /email/user/csv/${sourceCloud.id}/${destCloud.id} (${csvPairs.length} pair(s))`);
    let mappingSrcId = sourceCloud.id;
    let mappingDstId = destCloud.id;
    try {
      const csvResult = await migrationClient.uploadUserCSV(mappingSrcId, mappingDstId, csvPairs);
      log.info(`CloudFuze: CSV upload response — ${JSON.stringify(csvResult)}`);
    } catch (err) {
      const errBody = err.response?.data ? JSON.stringify(err.response.data) : '(no body)';
      const isCloudIdError = err.response?.status === 400 &&
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
      const cacheResult = await migrationClient.cacheUserMapping(mappingSrcId, mappingDstId);
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
      const serverMapping = await migrationClient.getPermissionMapping(mappingSrcId, mappingDstId);
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

    // ── Step 5 — Options & Preview → Start Migration ─────────────
    // One Time: deltaMigration=false, folder=true (labels as folders), calendar=false, contacts=false
    // Delta:    deltaMigration=true,  folder=true, calendar=true, contacts=true
    // Supports all combinations: Gmail→Outlook, Gmail→Gmail, Outlook→Outlook, Outlook→Gmail
    // (fromCloud/toCloud come from the clouds list cloudName for each combination)
    bump(`MigrationAgent: triggering migration ${context.sourceEmail} → ${context.destinationEmail} [${context.migrationType}]…`);
    log.info(`CloudFuze: triggering migration for ${context.sourceEmail} → ${context.destinationEmail}`);
    let triggerResult;
    try {
      triggerResult = await migrationClient.triggerMigration(context);
    } catch (err) {
      throw new Error(`[Step 5 POST initiate] ${err.response?.status ? `HTTP ${err.response.status}: ` : ''}${err.message}`);
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

    const cfStatus = await migrationClient.pollReports(deltaMigration, context.sourceEmail, {
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
    const polledJobDetails = migrationClient.getLastJobDetails();
    const polledJobReport = migrationClient.getLastJobReport();

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
      workspaceId: polledJobDetails.workspaceId || this.jobId || null,
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
