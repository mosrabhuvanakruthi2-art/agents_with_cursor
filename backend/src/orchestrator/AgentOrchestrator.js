const MigrationAgent = require('../agents/migration/MigrationAgent');
const CleanupAgent = require('../agents/cleanup/CleanupAgent');
const MigrationContext = require('../models/MigrationContext');
const env = require('../config/env');
const logger = require('../utils/logger');
const { createExecutionLogger } = require('../utils/logger');
const executionService = require('../services/executionService');
const neutaraClient = require('../clients/neutaraClient');
const { resolve: resolveAgents, list: listCombinations } = require('./agentRegistry');
const devemailClient = require('../clients/devemailClient');
const { normalizeDriveName } = require('../utils/driveNames');
const sharepointClient = require('../clients/sharepointClient');
const deepContentCore = require('../validation/shared/deepContentCore');

/**
 * Resolve the test-data + validation agent classes for a context's combination.
 * Throws if the (domain, source, destination) combination is not registered.
 */
function agentsFor(context) {
  const domain = context.domain || 'mail';
  const src = context.sourceProvider || 'google';
  const dst = context.destinationProvider || 'microsoft';
  const set = resolveAgents(domain, src, dst);
  if (!set) {
    // Say what IS registered. The registry loads combination files once, when the module is first
    // required, so a file added while the server is running stays invisible until a restart — listing
    // the loaded set turns "combination missing" into "server needs restarting" at a glance.
    const available = listCombinations()
      .filter((c) => c.domain === domain)
      .map((c) => `${c.sourceProvider} → ${c.destinationProvider}`)
      .sort();
    const known = available.length > 0
      ? `Registered for ${domain}: ${available.join(', ')}.`
      : `Nothing is registered for domain "${domain}".`;
    throw new Error(
      `No agents registered for ${domain}: ${src} → ${dst}. ${known} `
      + 'If the combination file exists on disk but is not listed, this process loaded the registry '
      + 'before it was added — restart the server.'
    );
  }
  return set;
}

// `googleshareddrive` was missing. Every live combination survived that by accident —
// googleshareddrive→sharepoint matches on its DESTINATION, dropbox→googleshareddrive on its
// SOURCE — so a Shared-Drive-to-Shared-Drive or Shared-Drive-to-Drive pair would be the first to
// fall out, and `hasDeepValidation` was the only thing keeping the omission invisible.
const CONTENT_PROVIDERS = [
  'box', 'dropbox', 'sharepoint', 'onedrive', 'googledrive', 'googleshareddrive',
];

/** True when this run is a content (files/folders) migration rather than mail. */
function isContentModeFor(context) {
  return (
    context.domain === 'content' ||
    context.mode === 'content' ||
    (!context.includeMail && (context.includeCalendar || context.includeContacts))
  );
}

/** True when either side is a content cloud — content migrations skip email validation. */
function isContentProvidersFor(context) {
  return (
    CONTENT_PROVIDERS.includes(context.sourceProvider) ||
    CONTENT_PROVIDERS.includes(context.destinationProvider)
  );
}

class AgentOrchestrator {
  /**
   * Phased bulk flow for multiple pairs:
   *   Phase 1 (parallel)    — create test data in all source accounts simultaneously
   *   Phase 2 (sequential)  — trigger + monitor migration one pair at a time (avoids CloudFuze API conflicts)
   *   Phase 3 (parallel)    — validate all destination mailboxes simultaneously
   */
  async runBulkFlow(pairsData) {
    const log = logger.child({ bulk: true });
    log.info(`Bulk flow started for ${pairsData.length} pair(s) — phased: create → migrate → validate`);

    // Build a state object per pair so phases can share context without re-constructing
    const pairs = pairsData.map((pairData) => {
      const context = pairData instanceof MigrationContext ? pairData : new MigrationContext(pairData);
      context.validate();
      const removeExecLogger = createExecutionLogger(context.executionId);
      if (!executionService.get(context.executionId)) {
        executionService.create(context);
      }
      const { TestDataAgent, ValidationAgent } = agentsFor(context);
      const isContentMode = isContentModeFor(context);

      return {
        context,
        isContentMode,
        // Content migrations seed source data via a separate flow, so a combination may
        // register no TestDataAgent — keep it null and skip the seeding phase.
        dataAgent: TestDataAgent ? new TestDataAgent() : null,
        migrationAgent: new MigrationAgent(),
        outlookAgent: new ValidationAgent(),
        removeExecLogger,
        startTime: Date.now(),
        sourceData: null,
        migrationResult: null,
        validationResult: null,
        error: null,
      };
    });

    // ── Phase 0: Cleanup QA data from source + destination ───────────────────
    log.info('Bulk Phase 0/3: cleaning previous QA test data from all pairs in parallel');
    await Promise.all(pairs.map(async (pair) => {
      const { context } = pair;
      // Content used to be excluded here. CleanupAgent now has a content branch that clears the
      // seeded source folder and the seeded items at the SharePoint destination, so content runs
      // need it too — without it each run seeded and migrated on top of the previous one and the
      // duplicates were reported as migration failures.
      if (context.skipCleanup === true) return;
      executionService.update(context.executionId, {
        currentAgent: 'CleanupAgent',
        progress: '[0/3] CleanupAgent: removing previous QA test data…',
      });
      try {
        const cleanupAgent = new CleanupAgent();
        await cleanupAgent.run(context);
      } catch (err) {
        log.warn(`Pair ${context.sourceEmail}: cleanup warning (non-blocking): ${err.message}`);
      }
    }));

    // ── Phase 1: Create test data for all pairs sequentially (one by one) ───
    // Sequential order ensures each source mailbox is fully seeded before the
    // next starts — avoids Gmail API rate-limit collisions and guarantees all
    // data is present before migration is triggered.
    log.info('Bulk Phase 1/3: creating test data for all pairs one by one (sequential)');
    for (const pair of pairs) {
      const { context, dataAgent } = pair;
      // Content migrations have no test-data agent — source data already exists in the cloud.
      if (pair.isContentMode || !dataAgent) {
        executionService.update(context.executionId, {
          status: 'RUNNING',
          progress: '[1/3] Skipping test-data creation (content migration)…',
        });
        continue;
      }
      executionService.update(context.executionId, {
        status: 'RUNNING',
        currentAgent: dataAgent.getName(),
        progress: `[1/3] ${dataAgent.getName()}: creating test data…`,
      });
      try {
        pair.sourceData = await dataAgent.run(context);
        log.info(`Pair ${context.sourceEmail}: Phase 1 complete`);
      } catch (err) {
        pair.error = err.message;
        const wasCancelled = executionService.isCancelled(context.executionId);
        const status = wasCancelled ? 'CANCELLED' : 'FAILED';
        executionService.update(context.executionId, {
          status,
          error: err.message,
          progress: wasCancelled ? 'Cancelled by user' : `Phase 1 failed: ${err.message}`,
          completedAt: new Date().toISOString(),
        });
        log.error(`Pair ${context.sourceEmail}: Phase 1 error: ${err.message}`);
      }
    }

    // ── Phase 2: Migrate all pairs sequentially ───────────────────────────────
    // For devemail bulk runs: all pairs go into ONE job (payload array with N workspaces).
    // Only the first non-errored pair (lead) triggers migration; the rest share its jobId.
    log.info('Bulk Phase 2/3: running migrations sequentially');
    const leadPair    = pairs.find((p) => !p.error) || null;
    const isDevemailBulk = pairs.length > 1 &&
      (leadPair?.context?.migrationServerUrl || '').toLowerCase().includes('devemail');

    // For devemail bulk: mark non-lead pairs immediately so the UI shows a meaningful
    // status rather than stale "cleanup" progress while the lead pair polls (up to 30 min).
    if (isDevemailBulk) {
      for (const pair of pairs) {
        if (pair === leadPair || pair.error) continue;
        executionService.update(pair.context.executionId, {
          currentAgent: 'MigrationAgent',
          status: 'RUNNING',
          progress: '[2/3] MigrationAgent: waiting — migration triggered by lead pair…',
        });
        log.info(`Pair ${pair.context.sourceEmail}: devemail bulk — pre-marked as waiting for shared job`);
      }
    }

    for (const pair of pairs) {
      if (pair.error) continue;
      const { context, migrationAgent } = pair;
      if (executionService.isCancelled(context.executionId)) continue;

      // Non-lead pairs: skip trigger entirely — lead already fired one job with all workspaces.
      if (isDevemailBulk && pair !== leadPair) {
        pair.migrationResult = { jobId: 'pending', status: 'INITIATED', sharedJob: true };
        log.info(`Pair ${context.sourceEmail}: Phase 2 skipped — will share job ID from lead pair`);
        continue;
      }

      executionService.update(context.executionId, {
        currentAgent: migrationAgent.getName(),
        progress: '[2/3] MigrationAgent: triggering and monitoring migration…',
      });
      try {
        pair.migrationResult = await migrationAgent.run(context);
        log.info(`Pair ${context.sourceEmail}: Phase 2 complete`);

        // After lead finishes, propagate its jobId + per-pair workspace IDs to all non-lead pairs.
        if (isDevemailBulk) {
          const leadMigJob = pair.migrationResult?.migrationJobDetails || {};
          const leadJobId  = leadMigJob.jobId || pair.migrationResult?.jobId || 'shared';
          const leadServerUrl = leadMigJob.serverUrl || '';
          const leadJobName   = leadMigJob.jobName   || '';

          // Fetch job report once to get per-pair workspace IDs for all non-lead pairs.
          let breakdown = [];
          try {
            breakdown = await devemailClient.getJobReport(leadJobId);
          } catch (_) { /* best-effort */ }
          const norm = (s) => String(s || '').toLowerCase().trim();

          for (const other of pairs) {
            if (other === pair || other.error) continue;
            const pairEntry = breakdown.find(
              (p) => norm(p.fromMailId || p.fromEmail) === norm(other.context.sourceEmail)
            );
            const wsId = pairEntry?.id || pairEntry?.jobDetailId || pairEntry?.workSpaceId || pairEntry?.workspaceId || null;
            other.migrationResult = {
              jobId: leadJobId,
              status: 'INITIATED',
              sharedJob: true,
              migrationJobDetails: {
                serverUrl:      leadServerUrl,
                jobId:          leadJobId,
                jobName:        leadJobName,
                workspaceId:    wsId,
                totalCount:     pairEntry?.totalCount     != null ? Number(pairEntry.totalCount)     : null,
                processedCount: pairEntry?.processedCount != null ? Number(pairEntry.processedCount) : null,
                cfStatus:       String(pairEntry?.processStatus || pairEntry?.syncStatus || '').toUpperCase() || null,
              },
            };
            executionService.update(other.context.executionId, {
              progress: `[2/3] MigrationAgent: shared job ${leadJobId} complete`,
            });
            log.info(`Pair ${other.context.sourceEmail}: shared job ${leadJobId} propagated, workspaceId=${wsId}`);
          }
        }
      } catch (err) {
        pair.error = err.message;
        const wasCancelled = executionService.isCancelled(context.executionId);
        const status = wasCancelled ? 'CANCELLED' : 'FAILED';
        executionService.update(context.executionId, {
          status,
          error: err.message,
          progress: wasCancelled ? 'Cancelled by user' : `Phase 2 failed: ${err.message}`,
          completedAt: new Date().toISOString(),
        });
        log.error(`Pair ${context.sourceEmail}: Phase 2 error: ${err.message}`);
      }
    }

    // ── Phase 3: Validate all pairs in parallel ───────────────────────────────
    log.info('Bulk Phase 3/3: validating all pairs in parallel');
    await Promise.all(pairs.map(async (pair) => {
      const { context, outlookAgent } = pair;
      if (pair.error) {
        pair.removeExecLogger();
        return;
      }
      if (executionService.isCancelled(context.executionId)) {
        executionService.update(context.executionId, {
          status: 'CANCELLED',
          progress: 'Cancelled by user',
          completedAt: new Date().toISOString(),
        });
        pair.removeExecLogger();
        return;
      }
      // Content migrations skip email validation — surface the migration report instead.
      const skipValidation = pair.migrationResult?.skipValidation || (pair.isContentMode && isContentProvidersFor(context));
      if (skipValidation) {
        executionService.update(context.executionId, {
          currentAgent: 'Skipped',
          progress: '[3/3] Validation skipped (content migration)',
        });
      } else {
        executionService.update(context.executionId, {
          currentAgent: outlookAgent.getName(),
          progress: `[3/3] ${outlookAgent.getName()}: comparing source vs destination…`,
        });
      }
      const buildAgentResults = () => [
        ...(pair.isContentMode || !pair.dataAgent ? [] : [pair.dataAgent.toJSON()]),
        pair.migrationAgent.toJSON(),
        ...(skipValidation ? [] : [pair.outlookAgent.toJSON()]),
      ];
      try {
        pair.validationResult = skipValidation ? null : await outlookAgent.run(context);
        const duration = Date.now() - pair.startTime;
        const result = {
          executionId: context.executionId,
          status: 'COMPLETED',
          duration,
          agentResults: buildAgentResults(),
          sourceData: pair.sourceData,
          migrationResult: pair.migrationResult,
          validationSummary: pair.validationResult,
          contentMigrationReport: pair.migrationResult?.contentMigrationReport || null,
        };
        executionService.update(context.executionId, {
          status: 'COMPLETED',
          result,
          progress: 'Completed',
          completedAt: new Date().toISOString(),
        });
        log.info(`Pair ${context.sourceEmail}: Phase 3 complete`);

        // Auto-raise Neutara bug on validation failure (fire-and-forget)
        if (pair.validationResult?.overallStatus === 'FAIL') {
          const execRecord = executionService.get(context.executionId);
          neutaraClient.createBug(execRecord).then((issue) => {
            if (issue?.knownLimitationsOnly) {
              const note = `All ${issue.count} mismatch(es) are known limitations — no bug raised`;
              log.info(note);
              executionService.update(context.executionId, { knownLimitationsNote: note });
            } else if (issue) {
              log.info(`Neutara bug raised: ${issue.key}  ${issue.url}`);
              executionService.update(context.executionId, { jiraIssue: issue });
            }
          }).catch((err) => {
            log.warn(`Neutara bug creation failed: ${err.message}`);
          });
        }
      } catch (err) {
        pair.error = err.message;
        const wasCancelled = executionService.isCancelled(context.executionId);
        const finalStatus = wasCancelled ? 'CANCELLED' : 'FAILED';
        const duration = Date.now() - pair.startTime;
        executionService.update(context.executionId, {
          status: finalStatus,
          result: {
            executionId: context.executionId,
            status: finalStatus,
            duration,
            error: err.message,
            agentResults: buildAgentResults(),
          },
          error: err.message,
          progress: wasCancelled ? 'Cancelled by user' : `Phase 3 failed: ${err.message}`,
          completedAt: new Date().toISOString(),
        });
        log.error(`Pair ${context.sourceEmail}: Phase 3 error: ${err.message}`);
      } finally {
        pair.removeExecLogger();
      }
    }));

    const results = pairs.map((pair) => ({
      executionId: pair.context.executionId,
      sourceEmail: pair.context.sourceEmail,
      destinationEmail: pair.context.destinationEmail,
      status: pair.error ? (executionService.isCancelled(pair.context.executionId) ? 'CANCELLED' : 'FAILED') : 'COMPLETED',
      error: pair.error || undefined,
      duration: Date.now() - pair.startTime,
      sourceData: pair.sourceData,
      migrationResult: pair.migrationResult,
      validationSummary: pair.validationResult,
    }));

    log.info(`Bulk flow complete: ${results.filter((r) => r.status === 'COMPLETED').length}/${pairs.length} completed`);
    return results;
  }

  async runFullFlow(contextData) {
    const context = contextData instanceof MigrationContext
      ? contextData
      : new MigrationContext(contextData);

    context.validate();

    const removeExecLogger = createExecutionLogger(context.executionId);
    const log = logger.child({ executionId: context.executionId });

    if (!executionService.get(context.executionId)) {
      executionService.create(context);
    }

    const startTime = Date.now();

    log.info('Starting full migration QA flow');

    const isOutlookSource = context.sourceProvider === 'microsoft';
    const { TestDataAgent, ValidationAgent } = agentsFor(context);
    // Some content combinations (e.g. Box→SharePoint) do register a TestDataAgent for seeding.
    const dataAgent = TestDataAgent ? new TestDataAgent() : null;
    const migrationAgent = new MigrationAgent();
    const outlookAgent = new ValidationAgent();

    // Detect content migration mode: domain/mode content, OR no mail with calendar/contacts flags
    const isContentMode = isContentModeFor(context);

    try {
      // Step 0: Cleanup previous QA test data (non-blocking — warning only on failure).
      // Skipped only on resume (skipCleanup). Content was excluded here on the grounds that there
      // was "no test data to clean", which was untrue: seeded folders accumulate on the source and
      // migrated copies accumulate at the destination. CleanupAgent now handles both.
      if (context.skipCleanup !== true) {
        executionService.update(context.executionId, {
          status: 'RUNNING',
          currentAgent: 'CleanupAgent',
          progress: 'CleanupAgent: removing previous QA test data…',
        });
        log.info('Step 0: Running CleanupAgent');
        try {
          const cleanupAgent = new CleanupAgent();
          await cleanupAgent.run(context);
        } catch (err) {
          log.warn(`CleanupAgent warning (non-blocking): ${err.message}`);
        }
      }

      // Multi-user content: per-user folder entries come from the UI table
      // (context.contentUserFolders); fall back to one entry per Map-Users pair. Align the
      // base seed name to the first entry so Step 1's single seed IS entry[0]'s dataset.
      const cufEntries = (Array.isArray(context.contentUserFolders) && context.contentUserFolders.length > 0)
        ? context.contentUserFolders
        : (Array.isArray(context.userEmailMappings)
            ? context.userEmailMappings.map((m) => ({ sourceEmail: m.sourceEmail, destinationEmail: m.destinationEmail }))
            : []);
      if (isContentMode) log.info(`Content: useExistingSource=${context.useExistingSource} (true = skip seeding, migrate existing folder)`);
      if (isContentMode && cufEntries.length > 0) {
        // Resolve each entry's SOURCE email → Box user id so we seed As-User into that user's
        // OWN account (not the connected admin). Requires the OAuth app's as-user header + the
        // admin (erik) + "Manage users" scope. If a user can't be resolved, that entry falls
        // back to the connected account (still a distinct dataset).
        if (context.sourceProvider === 'box') {
          try {
            const boxClient = require('../clients/boxClient');
            const adminEmail = String(context.sourceAdminEmail || context.sourceEmail || '').toLowerCase();
            const users = await boxClient.getUsers(adminEmail);
            const byEmail = {};
            for (const u of users) byEmail[String(u.login || '').toLowerCase()] = u.id;
            for (const e of cufEntries) {
              // Don't As-User into the CONNECTED admin account itself — Box 403s on self-
              // impersonation for uploads. That user seeds directly with the OAuth token.
              const email = String(e.sourceEmail || '').toLowerCase();
              e._boxUserId = (email === adminEmail) ? null : (byEmail[email] || null);
            }
            const resolved = cufEntries.filter((e) => e._boxUserId).length;
            log.info(`Content multi-user: resolved ${resolved}/${cufEntries.length} source user(s) to their Box account (As-User seeding)`);
          } catch (err) {
            log.warn(`Content multi-user: could not list Box users (${err.message}) — seeding falls back to the connected account`);
          }
        }
        // Align Step 1's single seed to entry[0]: its folder name AND its As-User target.
        if ((cufEntries[0].sourceFolderName || '').trim()) context.sourceFolderName = cufEntries[0].sourceFolderName.trim();
        if (cufEntries[0]._boxUserId) context.boxTargetUserId = cufEntries[0]._boxUserId;
        // …and its Shared Drive. Step 1 seeds entry[0]'s dataset, so it has to target entry[0]'s
        // drive; without this every row seeded into GOOGLE_SHARED_DRIVE_NAME, which is why a run
        // could only ever exercise one drive.
        const entry0Drive = normalizeDriveName(cufEntries[0].sourceDriveName);
        if (entry0Drive) context.sourceSharedDriveName = entry0Drive;
        // …and its drive-level access mode (feature 4.10): "open" grants the everyone-group at the
        // drive root, "restricted" grants only the named few. Absent = no drive-level seeding, which
        // is the pre-existing behaviour.
        if (cufEntries[0].driveAccessMode) context.driveAccessMode = cufEntries[0].driveAccessMode;
      }

      // ── Use-existing-folder mode: skip seeding, resolve each user's EXISTING folder ──────
      // When context.useExistingSource is set, the source folder(s) already exist — resolve each
      // named folder to its real id and migrate directly. No data creation.
      //
      // This resolution used to be gated to `sourceProvider === 'box'`. For a Drive or Shared Drive
      // source the block was skipped entirely, so userFolderMappings stayed empty and the flow fell
      // back to migrating `/` — the whole drive root — instead of the folder the user named. It did
      // that silently: the run looked normal and the wrong source only showed up in the path CSV.
      const useExistingProvider = String(context.sourceProvider || '').toLowerCase();
      const useExistingIsDrive = ['googledrive', 'googleshareddrive', 'google', 'drive'].includes(useExistingProvider);
      if (isContentMode && context.useExistingSource && useExistingProvider === 'box' && cufEntries.length > 0) {
        log.info(`Content: useExistingSource — skipping data creation, resolving ${cufEntries.length} existing folder(s)`);
        const boxClient = require('../clients/boxClient');
        const adminEmail = context.sourceAdminEmail || context.sourceEmail;
        const token = await boxClient.getValidToken(adminEmail);
        context.userFolderMappings = [];
        for (const e of cufEntries) {
          const folderPath = (e.sourceFolderName || '').trim().replace(/^\/?/, '/');
          try {
            const found = await boxClient.resolveFolderByPath(folderPath, token, e._boxUserId || null);
            if (!found) { log.warn(`Content useExistingSource: folder "${folderPath}" not found for ${e.sourceEmail} — skipping`); continue; }
            context.userFolderMappings.push({
              sourceEmail: e.sourceEmail,
              destinationEmail: e.destinationEmail,
              sourcePath: found.path,
              sourceRootId: String(found.id),
              destinationPath: e.destinationPath || context.destinationPath || '',
            });
            log.info(`Content useExistingSource: ${e.sourceEmail} → existing "${found.path}" (id=${found.id})`);
          } catch (resErr) {
            log.warn(`Content useExistingSource: resolve "${folderPath}" for ${e.sourceEmail} failed (${resErr.message}) — skipping`);
          }
        }
        if (context.userFolderMappings[0]) {
          context.sourceTestDataPath = context.userFolderMappings[0].sourcePath;
          context.sourceRootId = context.userFolderMappings[0].sourceRootId;
        }
        log.info(`Content useExistingSource: ${context.userFolderMappings.length} existing folder(s) ready to migrate`);
      } else if (isContentMode && context.useExistingSource && useExistingProvider === 'dropbox' && cufEntries.length > 0) {
        // Dropbox equivalent of the Box branch above.
        //
        // Without this branch a Dropbox source fell through every case and left userFolderMappings
        // empty, which the note above records as migrating "/" — the WHOLE Dropbox account, not the
        // QA folder. Silently, with a normal-looking run.
        //
        // Dropbox needs a member context: a Business admin token with no member selected reads the
        // admin's own Dropbox, so the folder would resolve in the wrong account.
        log.info(`Content: useExistingSource — skipping data creation, resolving ${cufEntries.length} existing Dropbox folder(s)`);
        const dropboxClient = require('../clients/dropboxClient');
        context.userFolderMappings = [];
        for (const e of cufEntries) {
          const folderPath = dropboxClient.dbxPath(
            e.sourceFolderName || context.sourceFolderName || env.DROPBOX_TEST_ROOT
          );
          if (!folderPath) {
            log.warn(`Content useExistingSource: refusing the Dropbox account root for ${e.sourceEmail} — skipping`);
            continue;
          }
          try {
            const asMemberId = await dropboxClient.resolveTeamMemberId(e.sourceEmail).catch(() => null);
            const found = await dropboxClient.getMetadata(folderPath, { asMemberId });
            if (!found || !found.id) {
              log.warn(`Content useExistingSource: Dropbox folder "${folderPath}" not found for ${e.sourceEmail} — skipping`);
              continue;
            }
            context.userFolderMappings.push({
              sourceEmail: e.sourceEmail,
              destinationEmail: e.destinationEmail,
              // path_lower, not path_display — CloudFuze matches the canonical lower-case form and
              // rejects a mixed-case Dropbox path as "wrong CSV paths". See the note in
              // DropboxTestDataAgent where the same choice is made for a freshly seeded root.
              sourcePath: found.pathLower || (found.path || folderPath).toLowerCase(),
              sourceRootId: String(found.id),
              destinationPath: e.destinationPath || context.destinationPath || '',
            });
            log.info(`Content useExistingSource: ${e.sourceEmail} → existing "${found.path || folderPath}" (id=${found.id})`);
          } catch (resErr) {
            log.warn(`Content useExistingSource: resolve "${folderPath}" for ${e.sourceEmail} failed (${resErr.message}) — skipping`);
          }
        }
        if (context.userFolderMappings[0]) {
          context.sourceTestDataPath = context.userFolderMappings[0].sourcePath;
          context.sourceRootId = context.userFolderMappings[0].sourceRootId;
        }
        log.info(`Content useExistingSource: ${context.userFolderMappings.length} existing Dropbox folder(s) ready to migrate`);
      } else if (isContentMode && context.useExistingSource && useExistingIsDrive && cufEntries.length > 0) {
        // Drive / Shared Drive equivalent of the Box branch above. A Shared Drive folder is resolved
        // within its drive, so the drive id is carried too — CloudFuze needs it as the scan root.
        log.info(`Content: useExistingSource — skipping data creation, resolving ${cufEntries.length} existing Drive folder(s)`);
        const driveClient = require('../clients/driveClient');
        const isSharedDrive = useExistingProvider === 'googleshareddrive';
        context.userFolderMappings = [];
        for (const e of cufEntries) {
          // Trailing slashes matter as much as leading ones: a CSV column reads "/QA_Team1/" just
          // as often as "/QA_Team1", and the old leading-only strip left "QA_Team1/" behind, which
          // matched nothing.
          const folderName = normalizeDriveName(e.sourceFolderName || context.sourceFolderName);
          if (!folderName) {
            log.warn(`Content useExistingSource: no source folder named for ${e.sourceEmail} — skipping`);
            continue;
          }
          try {
            let driveId = null;
            let driveName = '';
            if (isSharedDrive) {
              // Each row may name its own drive; GOOGLE_SHARED_DRIVE_NAME is only the fallback.
              // Reading the env value alone meant a two-drive run resolved both rows against one
              // drive here, so the second row's folder was looked for in the wrong place.
              driveName = normalizeDriveName(e.sourceDriveName) || normalizeDriveName(env.GOOGLE_SHARED_DRIVE_NAME);
              const drive = await driveClient.resolveSharedDriveByName(driveName, e.sourceEmail);
              if (!drive) {
                log.warn(`Content useExistingSource: Shared Drive "${driveName}" not visible to ${e.sourceEmail} — skipping`);
                continue;
              }
              driveId = drive.id;
              driveName = drive.name;
            }
            const hits = (await driveClient.findFoldersByName(folderName, e.sourceEmail))
              .filter((h) => (driveId ? h.driveId === driveId : true));
            if (hits.length === 0) {
              log.warn(`Content useExistingSource: folder "${folderName}" not found for ${e.sourceEmail} — skipping`);
              continue;
            }
            if (hits.length > 1) {
              log.warn(`Content useExistingSource: ${hits.length} folders named "${folderName}" for ${e.sourceEmail} — using the first (${hits[0].id})`);
            }
            context.userFolderMappings.push({
              sourceEmail: e.sourceEmail,
              destinationEmail: e.destinationEmail,
              sourcePath: `/${folderName}`,
              sourceRootId: String(hits[0].id),
              sourceDriveName: driveName || null,
              sourceDriveId: driveId || null,
              destinationPath: e.destinationPath || context.destinationPath || '',
            });
            log.info(`Content useExistingSource: ${e.sourceEmail} → existing "/${folderName}" `
              + `(id=${hits[0].id}${driveId ? `, drive="${driveName}" ${driveId}` : ''})`);
            // Kept for single-drive compatibility; the per-row fields above are authoritative.
            if (driveId) context.sourceDriveId = driveId;
          } catch (resErr) {
            log.warn(`Content useExistingSource: resolve "${folderName}" for ${e.sourceEmail} failed (${resErr.message}) — skipping`);
          }
        }
        if (context.userFolderMappings[0]) {
          context.sourceTestDataPath = context.userFolderMappings[0].sourcePath;
          context.sourceRootId = context.userFolderMappings[0].sourceRootId;
        }
        if (context.userFolderMappings.length === 0) {
          throw new Error(
            'Content useExistingSource: no existing source folder could be resolved — refusing to run. '
            + 'Migrating with no resolved folder falls back to the drive root, which is never what was asked for.'
          );
        }
        log.info(`Content useExistingSource: ${context.userFolderMappings.length} existing folder(s) ready to migrate`);
      }

      // Step 1: Generate test data.
      // Skipped when: explicitly skipped on resume (skipTestData), OR no TestDataAgent registered
      // for this combination, OR useExistingSource (migrate an existing folder, no seeding).
      let sourceData = null;
      if (!context.skipTestData && dataAgent !== null && !context.useExistingSource) {
        executionService.update(context.executionId, {
          status: 'RUNNING',
          currentAgent: dataAgent.getName(),
          progress: isOutlookSource
            ? 'OutlookTestDataAgent: listing folders, provisioning test mail data…'
            : isContentMode
              ? `${dataAgent.getName()}: seeding test data in source cloud…`
              : 'GmailTestDataAgent: creating labels, mail, drafts, calendar (if E2E)…',
        });
        log.info(`Step 1: Running ${dataAgent.getName()} (sourceProvider=${context.sourceProvider})`);
        sourceData = await dataAgent.run(context);
        // For content migrations: capture source folder path AND its cloud folder ID so the
        // MigrationAgent can pass a real fromRootId (CloudFuze needs the folder ID, not a path string).
        if (sourceData?.rootFolderName) {
          context.sourceTestDataPath = `/${sourceData.rootFolderName}`;
          if (sourceData.rootFolderId) context.sourceRootId = String(sourceData.rootFolderId);
          if (sourceData.sharedDriveId) context.sourceDriveId = String(sourceData.sharedDriveId);
          log.info(`Content source captured from ${dataAgent.getName()}: path=${context.sourceTestDataPath} folderId=${context.sourceRootId || '(none)'}`);

          // Multi-user: one transfer unit per per-user entry. unit 0 reuses the folder Step 1
          // just seeded (its name was aligned to entry[0]); each additional entry gets its own
          // seeded dataset, using the entry's folder name (or "<base> <user>" when blank).
          // (Box As-User needs an enterprise admin token — absent here — so all folders live in
          // the connected source account; the structure is identical to true per-user and
          // upgrades automatically once As-User is available.)
          if (cufEntries.length > 0) {
            const baseName = (context.sourceFolderName || '').trim() || 'Agent Box Data';
            context.userFolderMappings = [{
              sourceEmail: cufEntries[0].sourceEmail,
              destinationEmail: cufEntries[0].destinationEmail,
              sourcePath: context.sourceTestDataPath,
              sourceRootId: context.sourceRootId,
              // Step 1 seeded into entry[0]'s drive (aligned above), so record what it actually
              // used rather than the run-wide name — they differ as soon as rows name drives.
              sourceDriveName: normalizeDriveName(cufEntries[0].sourceDriveName) || normalizeDriveName(sourceData.sharedDriveName) || null,
              sourceDriveId: sourceData.sharedDriveId || context.sourceDriveId || null,
              // What was actually granted at the drive root, for the feature 4.10 comparison.
              driveAccess: sourceData.driveAccess || null,
              destinationPath: cufEntries[0].destinationPath || context.destinationPath || '',
            }];
            for (let i = 1; i < cufEntries.length; i++) {
              const entry = cufEntries[i];
              const localPart = String(entry.sourceEmail || `user${i + 1}`).split('@')[0];
              // Each row may name its OWN Shared Drive. Rows that name none stay on the run-wide
              // drive, so single-drive runs are unaffected. Two rows naming different drives get
              // one seeding pass each, which is what makes "N drives in one run" real.
              const rowDrive = normalizeDriveName(entry.sourceDriveName) || normalizeDriveName(context.sourceSharedDriveName) || '';
              const step1Drive = normalizeDriveName(context.sourceSharedDriveName);
              // The "<base> <user>" suffix exists because multi-USER rows all seed into ONE account,
              // where identically named folders would collide. Rows separated by DRIVE have no such
              // collision — and the whole point of a multi-drive run is that each drive holds the
              // SAME tree, so suffixing would make the two sides non-comparable. Keep the base name
              // whenever this row targets a different drive than Step 1 did.
              const separatedByDrive = Boolean(rowDrive) && rowDrive !== step1Drive;
              const folderName = (entry.sourceFolderName || '').trim()
                || (separatedByDrive ? baseName : `${baseName} ${localPart}`);
              try {
                const extraAgent = new TestDataAgent();
                // Seed As-User into THIS user's own Box account (null → connected account fallback).
                const data = await extraAgent.run({
                  ...context,
                  sourceFolderName: folderName,
                  boxTargetUserId: entry._boxUserId || null,
                  sourceSharedDriveName: rowDrive || undefined,
                  // Each drive declares its own access mode — that difference IS the test.
                  driveAccessMode: entry.driveAccessMode || undefined,
                });
                context.userFolderMappings.push({
                  sourceEmail: entry.sourceEmail,
                  destinationEmail: entry.destinationEmail,
                  sourcePath: `/${data.rootFolderName}`,
                  sourceRootId: String(data.rootFolderId),
                  sourceDriveName: normalizeDriveName(data.sharedDriveName) || rowDrive || null,
                  sourceDriveId: data.sharedDriveId || null,
                  driveAccess: data.driveAccess || null,
                  destinationPath: entry.destinationPath || context.destinationPath || '',
                });
                log.info(`Content multi-user: seeded for ${entry.sourceEmail} → /${data.rootFolderName} (id=${data.rootFolderId})`
                  + `${data.sharedDriveName ? ` in Shared Drive "${data.sharedDriveName}"` : ''}`);
              } catch (seedErr) {
                log.warn(`Content multi-user: seeding for ${entry.sourceEmail} failed (${seedErr.message}) — skipping this user`);
              }
            }
            log.info(`Content multi-user: ${context.userFolderMappings.length} transfer unit(s) prepared from ${cufEntries.length} entry(ies)`);
          }
        }
      } else if (dataAgent === null) {
        log.info('Step 1: Skipped (no TestDataAgent registered for this combination)');
        executionService.update(context.executionId, {
          status: 'RUNNING',
          currentAgent: migrationAgent.getName(),
          progress: 'No test data agent for this combination — proceeding to migration…',
        });
      } else {
        log.info(`Step 1: Skipping ${dataAgent.getName()} (already completed)`);
      }

      if (executionService.isCancelled(context.executionId)) {
        throw new Error('Execution cancelled by user');
      }

      // ── Guard: a Shared Drive migrates WHOLE, so its root must hold only QA data ─────────────
      // CloudFuze scans a Shared Drive as the drive, never as a folder inside it: the source path
      // and fromRootId must describe the same object, and a subfolder id scans nothing (see
      // docs/content-migration-path-mapping-findings.md). So everything in the drive root migrates,
      // not just the folder this run seeded.
      //
      // That was an operational rule someone had to remember, and it has already been broken once —
      // a leftover "ZZ Seeding Fix Check" folder was migrated because of it. Checking it here turns
      // the rule into a visible warning on the run instead of a surprise in the report.
      //
      // A warning rather than a failure: extra data in the drive makes the report noisier, but the
      // run is still valid for the folder under test, and stopping someone's run over a stray folder
      // would be worse than telling them about it.
      if (isContentMode && /shared_?drive/i.test(String(context.sourceProvider || ''))) {
        try {
          const driveClient = require('../clients/driveClient');
          const seeded = new Set(
            (context.userFolderMappings || [])
              .map((u) => normalizeDriveName(u.sourcePath))
              .filter(Boolean)
              .map((n) => n.toLowerCase())
          );
          const checkedDrives = new Map();
          for (const u of context.userFolderMappings || []) {
            if (!u.sourceDriveId || checkedDrives.has(u.sourceDriveId)) continue;
            checkedDrives.set(u.sourceDriveId, true);
            const rootKids = await driveClient.listChildren(u.sourceDriveId, u.sourceEmail || context.sourceEmail);
            const strays = rootKids.filter((k) => !seeded.has(String(k.name || '').trim().toLowerCase()));
            const label = u.sourceDriveName || u.sourceDriveId;
            if (strays.length === 0) {
              log.info(`Source drive "${label}": root holds only the seeded folder — nothing extra will migrate`);
            } else {
              log.warn(`Source drive "${label}": ${strays.length} item(s) in the drive root are NOT part of this `
                + `run and WILL be migrated because a Shared Drive migrates whole — `
                + `${strays.map((k) => `"${k.name}"`).join(', ')}. `
                + 'Remove them from the drive to keep the report clean.');
              context.sourceDriveStrays = [
                ...(context.sourceDriveStrays || []),
                { drive: label, items: strays.map((k) => k.name) },
              ];
            }
          }
        } catch (guardErr) {
          log.warn(`Source drive contents check failed (non-blocking): ${guardErr.message}`);
        }
      }

      // ── Pre-create each row's destination folder ────────────────────────────────────────────
      // A multi-drive run gives each source drive its own destination sub-folder so the two trees
      // do not merge. Nothing creates those folders: CloudFuze is handed a destination path, and
      // whether it creates a missing segment has never been established on this server. So create
      // them here, before the migration is triggered — a folder that turns out to be unnecessary
      // is harmless, whereas a missing one risks the job resolving to the library root and the two
      // drives writing over each other (an earlier run reported 70 extra / 260 misplaced from
      // exactly that kind of merge).
      //
      // Non-blocking on purpose: if Graph cannot reach the destination the migration itself will
      // fail with a clearer message than anything this step could raise.
      if (isContentMode && /sharepoint/i.test(String(context.destinationProvider || ''))) {
        const wanted = [...new Set(
          (context.userFolderMappings || [])
            .map((u) => deepContentCore.inDrivePath(u.destinationPath))
            .filter((p) => p && p !== '/')
        )];
        if (wanted.length > 0) {
          try {
            const site = await sharepointClient.getSite(
              context.sharepointHostname || env.SHAREPOINT_HOSTNAME,
              context.sharepointSitePath || env.SHAREPOINT_SITE_PATH,
              context.destinationEmail
            );
            for (const p of wanted) {
              const made = await sharepointClient.ensureFolderPath(site.id, p, context.destinationEmail);
              log.info(`Content destination: "${p}" ready${made.length ? ` (created ${made.join(', ')})` : ' (already existed)'}`);
            }
          } catch (destErr) {
            log.warn(`Content destination pre-create failed (non-blocking): ${destErr.message}`);
          }
        }
      }

      // Step 2: Trigger and monitor migration
      let migrationResult = null;
      if (!context.skipMigration) {
        executionService.update(context.executionId, {
          currentAgent: migrationAgent.getName(),
          progress: 'MigrationAgent: CloudFuze login, validate user, trigger move, poll destination…',
        });
        log.info('Step 2: Running MigrationAgent');
        migrationResult = await migrationAgent.run(context);
      } else {
        log.info('Step 2: Skipping MigrationAgent (already completed)');
        migrationResult = executionService.get(context.executionId)?.result?.migrationResult || null;
      }

      if (executionService.isCancelled(context.executionId)) {
        throw new Error('Execution cancelled by user');
      }

      // Step 3: Validate.
      // A content combination with a real destination validator (static supportsDeepValidation =
      // true, e.g. BoxToSharepointValidationAgent) ALWAYS runs once the flow completes — even when
      // CloudFuze reported NOT_PROCESSED / conflict — because the validator checks the actual
      // destination state. This gives content the same UX as mail: a downloadable report is always
      // produced after the run. Skip only when no deep validator is registered for the combination.
      // Use the shared constant rather than re-listing the providers. Two literals lived here and
      // both had already drifted from it (neither carried `googleshareddrive`), which is exactly
      // how the omission stayed invisible.
      const isContentProviders =
        CONTENT_PROVIDERS.includes(context.sourceProvider) ||
        CONTENT_PROVIDERS.includes(context.destinationProvider);
      const ValidationAgentClass = agentsFor(context)?.ValidationAgent;
      const hasDeepValidation = Boolean(ValidationAgentClass?.supportsDeepValidation);
      const skipValidation = hasDeepValidation
        ? false
        : (migrationResult?.skipValidation || (isContentMode && isContentProviders));

      let validationResult = null;
      if (skipValidation) {
        const reason = migrationResult?.skipValidation
          ? `content migration stop status "${migrationResult.finalStatus}"`
          : `content migration (${context.sourceProvider} → ${context.destinationProvider}) — no deep validation registered`;
        log.info(`Step 3: Skipped — ${reason}`);
        executionService.update(context.executionId, {
          currentAgent: 'Skipped',
          progress: `Validation skipped — ${reason}`,
        });
      } else {
        executionService.update(context.executionId, {
          currentAgent: outlookAgent.getName(),
          progress: `${outlookAgent.getName()}: comparing source vs destination…`,
        });
        log.info(`Step 3: Running ${outlookAgent.getName()}`);
        validationResult = await outlookAgent.run(context);
      }

      const duration = Date.now() - startTime;

      const result = {
        executionId: context.executionId,
        status: 'COMPLETED',
        duration,
        agentResults: [
          ...(isContentMode ? [] : [dataAgent.toJSON()]),
          migrationAgent.toJSON(),
          ...(skipValidation ? [] : [outlookAgent.toJSON()]),
        ],
        sourceData,
        migrationResult,
        validationSummary: validationResult,
        contentMigrationReport: migrationResult?.contentMigrationReport || null,
        // A migration that attached no work moved nothing. Validation still runs (its findings are
        // the report), but the run must not read as a pass anywhere downstream.
        migrationFailed: Boolean(migrationResult?.migrationFailed),
        migrationFailureReason: migrationResult?.failureReason || null,
      };

      executionService.update(context.executionId, {
        status: 'COMPLETED',
        result,
        progress: 'Completed',
        completedAt: new Date().toISOString(),
      });

      // Auto-raise Neutara bug on validation failure (fire-and-forget — never blocks the flow).
      //
      // Suppressed when the migration attached no work: every validation finding is then just a
      // restatement of "nothing was copied", and filing them as content defects is actively
      // misleading. Execution ac77ad80 (22 Aug) filed 5 such tickets against a destination nothing
      // had ever been written to. The migration failure is the bug; report it once, in the run.
      if (migrationResult?.migrationFailed) {
        const note = `Migration moved nothing (${migrationResult.finalStatus}) — no bug raised; `
          + 'validation findings only restate that the destination is empty. '
          + `Cause: ${migrationResult.failureReason || 'unknown'}`;
        log.warn(note);
        executionService.update(context.executionId, { knownLimitationsNote: note });
      } else if (validationResult?.overallStatus === 'FAIL') {
        const execRecord = executionService.get(context.executionId);
        neutaraClient.createBug(execRecord).then((issue) => {
          if (issue?.knownLimitationsOnly) {
            const note = `All ${issue.count} mismatch(es) are known limitations — no bug raised`;
            log.info(note);
            executionService.update(context.executionId, { knownLimitationsNote: note });
          } else if (issue) {
            log.info(`Neutara bug raised: ${issue.key}  ${issue.url}`);
            executionService.update(context.executionId, { jiraIssue: issue });
          }
        }).catch((err) => {
          log.warn(`Neutara bug creation failed: ${err.message}`);
        });
      }

      log.info(`Full flow completed in ${duration}ms`);
      removeExecLogger();
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      const wasCancelled = executionService.isCancelled(context.executionId);
      const finalStatus = wasCancelled ? 'CANCELLED' : 'FAILED';
      log.error(`Full flow ${finalStatus.toLowerCase()} after ${duration}ms: ${err.message}`);

      const result = {
        executionId: context.executionId,
        status: finalStatus,
        duration,
        error: err.message,
        agentResults: [
          ...(isContentMode ? [] : [dataAgent.toJSON()]),
          migrationAgent.toJSON(),
          ...(isContentMode ? [] : [outlookAgent.toJSON()]),
        ],
      };

      executionService.update(context.executionId, {
        status: finalStatus,
        result,
        error: err.message,
        progress: wasCancelled ? 'Cancelled by user' : `Failed: ${err.message}`,
        completedAt: new Date().toISOString(),
      });

      removeExecLogger();
      return result;
    }
  }
  /**
   * Resume an INTERRUPTED execution from the last completed agent.
   * Skips already-completed steps and reruns from the first incomplete one.
   */
  async resumeFlow(executionId) {
    const exec = executionService.get(executionId);
    if (!exec) throw new Error(`Execution ${executionId} not found`);
    if (exec.status !== 'INTERRUPTED') throw new Error(`Execution ${executionId} is not in INTERRUPTED state (status: ${exec.status})`);

    const context = new MigrationContext(exec.context);
    const completedAgents = new Set((exec.result?.agentResults || []).map(a => a.name));

    const log = logger.child({ executionId });
    const removeExecLogger = createExecutionLogger(executionId);

    log.info(`Resuming execution ${executionId} — completed agents: ${[...completedAgents].join(', ') || 'none'}`);

    // Determine which step to resume from
    const hasCleanup       = completedAgents.has('CleanupAgent');
    const hasTestData      = completedAgents.has('OutlookTestDataAgent') || completedAgents.has('GmailTestDataAgent');
    const hasMigration     = completedAgents.has('MigrationAgent');

    // Inject skip flags into context so runFullFlow respects them
    context.skipCleanup   = hasCleanup || hasTestData || hasMigration;
    context.skipTestData  = hasTestData || hasMigration;
    context.skipMigration = hasMigration;

    executionService.update(executionId, {
      status: 'RUNNING',
      progress: 'Resuming from last completed step…',
      completedAt: null,
      error: null,
    });

    try {
      const result = await this.runFullFlow(context);
      removeExecLogger();
      return result;
    } catch (err) {
      removeExecLogger();
      throw err;
    }
  }
}

module.exports = new AgentOrchestrator();
// Exported so a test can assert every registered content provider is listed. The list gates
// content-mode detection, and a missing provider is invisible for any pair whose OTHER side is
// listed — which is why `googleshareddrive` went unnoticed.
module.exports.CONTENT_PROVIDERS = CONTENT_PROVIDERS;
module.exports.isContentProvidersFor = isContentProvidersFor;
