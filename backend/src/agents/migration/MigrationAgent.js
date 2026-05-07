const { BaseAgent } = require('../core/BaseAgent');
const migrationClient = require('../../clients/migrationClient');
const outlookClient = require('../../clients/outlookClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const executionService = require('../../services/executionService');

const MAX_POLL_MINUTES = parseInt(process.env.MIGRATION_MAX_WAIT_MINUTES, 10) || 30;
const POLL_INTERVAL_MS = 60000;
const STABLE_CHECKS_NEEDED = 3;

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
      migrationClient.setRuntimeConfig({
        baseUrl: context.migrationServerUrl,
        email: context.migrationServerEmail || '',
        password: context.migrationServerPassword || '',
      });
      log.info(`CloudFuze: using runtime server ${context.migrationServerUrl}`);
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

    if (env.CLOUDFUZE_SOURCE_CLOUD_ID && env.CLOUDFUZE_DEST_CLOUD_ID) {
      sourceCloud = { id: env.CLOUDFUZE_SOURCE_CLOUD_ID, cloudName: 'GMAIL' };
      destCloud   = { id: env.CLOUDFUZE_DEST_CLOUD_ID,   cloudName: 'OUTLOOK' };
      log.info(`CloudFuze: using env cloud IDs — source: ${sourceCloud.id}, dest: ${destCloud.id}`);
      bump('MigrationAgent: cloud IDs loaded from env…');
    } else {
      bump('MigrationAgent: fetching connected cloud accounts…');
      log.info('CloudFuze: GET /mail/clouds');
      let clouds;
      try {
        clouds = await migrationClient.getClouds();
      } catch (err) {
        throw new Error(`[Step 1 GET /mail/clouds] ${err.response?.status ? `HTTP ${err.response.status}: ` : ''}${err.message}`);
      }
      log.info(`CloudFuze: ${clouds.length} cloud(s) returned`);

      // Priority: .env override → context admin email → individual user email (domain-matched)
      const sourceLookup = env.CLOUDFUZE_SOURCE_ADMIN_EMAIL || context.sourceAdminEmail || context.sourceEmail;
      const destLookup   = env.CLOUDFUZE_DEST_ADMIN_EMAIL   || context.destAdminEmail   || context.destinationEmail;

      sourceCloud = migrationClient.findCloudId(clouds, sourceLookup);
      if (!sourceCloud) {
        throw new Error(
          `CloudFuze: source "${sourceLookup}" not found in /mail/clouds. ` +
          `Available: ${clouds.map((c) => c.adminEmailId || c.email).join(', ')}`
        );
      }
      destCloud = migrationClient.findCloudId(clouds, destLookup);
      if (!destCloud) {
        throw new Error(
          `CloudFuze: destination "${destLookup}" not found in /mail/clouds. ` +
          `Available: ${clouds.map((c) => c.adminEmailId || c.email).join(', ')}`
        );
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
    // Use ALL pairs from userEmailMappings so the server knows every
    // source→dest pair (not just the current single-user pair).
    const csvPairs = (Array.isArray(context.userEmailMappings) && context.userEmailMappings.length > 0)
      ? context.userEmailMappings
      : [{ sourceEmail: context.sourceEmail, destinationEmail: context.destinationEmail }];
    bump(`MigrationAgent: uploading user mapping CSV (${csvPairs.length} pair(s))…`);
    log.info(`CloudFuze: POST /email/user/csv/${sourceCloud.id}/${destCloud.id} (${csvPairs.length} pair(s))`);
    try {
      const csvResult = await migrationClient.uploadUserCSV(sourceCloud.id, destCloud.id, csvPairs);
      log.info(`CloudFuze: CSV upload response — ${JSON.stringify(csvResult)}`);
    } catch (err) {
      const errBody = err.response?.data ? JSON.stringify(err.response.data) : '(no body)';
      log.warn(`CloudFuze uploadUserCSV failed (${err.message}) — error body: ${errBody} — continuing to cache step`);
    }

    // ── Step 3b — Confirm user mapping (Select all → Next) ───────
    bump('MigrationAgent: confirming user mapping selection…');
    log.info(`CloudFuze: cache mapping ${sourceCloud.id}/${destCloud.id}`);
    try {
      const cacheResult = await migrationClient.cacheUserMapping(sourceCloud.id, destCloud.id);
      log.info(`CloudFuze: cache mapping response — ${JSON.stringify(cacheResult)}`);
    } catch (err) {
      log.warn(`CloudFuze cacheUserMapping failed (${err.message}) — continuing to permission step`);
    }

    // ── Step 4 — Read back Permission Mapping (Step 3 in UI) ─────
    // Fetched AFTER CSV upload so the server has populated source→dest
    // address pairs. Stored in context for deep From/To/CC/BCC validation.
    bump('MigrationAgent: reading permission mapping for deep validation…');
    log.info(`CloudFuze: GET /email/user/cache/${sourceCloud.id}/${destCloud.id}`);
    try {
      const serverMapping = await migrationClient.getPermissionMapping(sourceCloud.id, destCloud.id);
      if (serverMapping.length > 0) {
        context.userEmailMappings = serverMapping;
        log.info(`CloudFuze: ${serverMapping.length} permission mapping(s) stored for From/To/CC/BCC validation`);
      } else {
        log.info('CloudFuze: permission mapping empty — falling back to context userEmailMappings');
      }
    } catch (err) {
      log.warn(`CloudFuze getPermissionMapping error (${err.message}) — continuing with existing mappings`);
    }

    // ── Step 4b — Pre-scan (new server only) ─────────────────────
    // Triggers server-side folder indexing for the source mailbox.
    // Populates EmailFolderInfo records required by /email/move/initiate.
    try {
      bump(`MigrationAgent: triggering pre-scan for ${context.sourceEmail}…`);
      const preScanResult = await migrationClient.triggerPreScan(context.sourceEmail, context.sourceCloudName);
      log.info(`CloudFuze: pre-scan initiated — ${JSON.stringify(preScanResult)}`);
      bump('MigrationAgent: waiting 15s for pre-scan folder indexing…');
      await new Promise((r) => setTimeout(r, 15000));
    } catch (err) {
      log.warn(`CloudFuze pre-scan failed (${err.message}) — continuing without pre-scan`);
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

    let finalStatus;
    if (cfStatus === 'CANCELLED') {
      finalStatus = 'CANCELLED';
    } else if (cfStatus && cfStatus !== 'TIMEOUT') {
      // CloudFuze /mail/reports returned a terminal PROCESS status
      log.info(`CloudFuze /mail/reports terminal status: ${cfStatus}`);
      finalStatus = cfStatus;
    } else {
      // Fallback: poll Outlook Graph API for message count stabilization
      if (!cfStatus) {
        log.info('CloudFuze /mail/reports: no Bearer token or token unavailable — falling back to Outlook Graph polling');
      } else {
        log.warn(`CloudFuze /mail/reports: timed out — falling back to Outlook Graph polling`);
      }
      bump(
        `MigrationAgent: falling back to Outlook Graph polling (${context.destinationEmail})…`
      );
      finalStatus = await this._pollDestinationUntilStable(
        context.destinationEmail,
        log,
        context.executionId
      );
    }

    bump(`MigrationAgent: finished (${finalStatus})`);
    return {
      jobId: this.jobId,
      finalStatus,
      retriesUsed: this.retries,
      rawResponse: triggerResult.rawResponse,
      ownerValidation,
      cloudIds: {
        sourceCloudId: sourceCloud.id,
        destCloudId: destCloud.id,
        sourceCloudName: sourceCloud.cloudName,
        destCloudName: destCloud.cloudName,
      },
    };
    } finally {
      // Always clear the runtime config so subsequent runs use env defaults
      migrationClient.clearRuntimeConfig();
    }
  }

  /**
   * Fallback: poll Outlook Graph API until message count stabilizes
   * (same count > 0 for STABLE_CHECKS_NEEDED consecutive checks at 60s intervals).
   */
  async _pollDestinationUntilStable(destEmail, log, executionId) {
    const maxPolls = Math.ceil((MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS);
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
        const currentCount = await outlookClient.getTotalMessageCount(destEmail);
        log.info(`Outlook poll ${attempt}/${maxPolls}: ${currentCount} messages (prev: ${lastCount})`);

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
            progress: `MigrationAgent: Outlook messages ${currentCount} (poll ${attempt}/${maxPolls}, stable streak ${stableChecks}/${STABLE_CHECKS_NEEDED})`,
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
