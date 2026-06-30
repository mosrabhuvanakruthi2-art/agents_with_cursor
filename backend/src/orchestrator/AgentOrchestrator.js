const MigrationAgent = require('../agents/migration/MigrationAgent');
const CleanupAgent = require('../agents/cleanup/CleanupAgent');
const MigrationContext = require('../models/MigrationContext');
const logger = require('../utils/logger');
const { createExecutionLogger } = require('../utils/logger');
const executionService = require('../services/executionService');
const neutaraClient = require('../clients/neutaraClient');
const { resolve: resolveAgents } = require('./agentRegistry');

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
    throw new Error(`No agents registered for ${domain}: ${src} → ${dst}`);
  }
  return set;
}

const CONTENT_PROVIDERS = ['box', 'dropbox', 'sharepoint', 'onedrive', 'googledrive'];

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
      if (context.skipCleanup === true || pair.isContentMode) return;
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

    // ── Phase 1: Create test data for all pairs in parallel ──────────────────
    log.info('Bulk Phase 1/3: creating test data for all pairs in parallel');
    await Promise.all(pairs.map(async (pair) => {
      const { context, dataAgent } = pair;
      // Content migrations have no test-data agent — source data already exists in the cloud.
      if (pair.isContentMode || !dataAgent) {
        executionService.update(context.executionId, {
          status: 'RUNNING',
          progress: '[1/3] Skipping test-data creation (content migration)…',
        });
        return;
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
    }));

    // ── Phase 2: Migrate all pairs sequentially ───────────────────────────────
    log.info('Bulk Phase 2/3: running migrations sequentially');
    for (const pair of pairs) {
      if (pair.error) continue;
      const { context, migrationAgent } = pair;
      if (executionService.isCancelled(context.executionId)) continue;
      executionService.update(context.executionId, {
        currentAgent: migrationAgent.getName(),
        progress: '[2/3] MigrationAgent: triggering and monitoring migration…',
      });
      try {
        pair.migrationResult = await migrationAgent.run(context);
        log.info(`Pair ${context.sourceEmail}: Phase 2 complete`);
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
      // Skipped on resume (skipCleanup) and for content migration (no test data to clean).
      if (context.skipCleanup !== true && !isContentMode) {
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
      }

      // ── Use-existing-folder mode: skip seeding, resolve each user's EXISTING folder ──────
      // When context.useExistingSource is set, the source folder(s) already exist — we resolve
      // each path to its Box folder id (As-User per user) and migrate directly. No data creation.
      if (isContentMode && context.useExistingSource && context.sourceProvider === 'box' && cufEntries.length > 0) {
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
              destinationPath: cufEntries[0].destinationPath || context.destinationPath || '',
            }];
            for (let i = 1; i < cufEntries.length; i++) {
              const entry = cufEntries[i];
              const localPart = String(entry.sourceEmail || `user${i + 1}`).split('@')[0];
              const folderName = (entry.sourceFolderName || '').trim() || `${baseName} ${localPart}`;
              try {
                const extraAgent = new TestDataAgent();
                // Seed As-User into THIS user's own Box account (null → connected account fallback).
                const data = await extraAgent.run({ ...context, sourceFolderName: folderName, boxTargetUserId: entry._boxUserId || null });
                context.userFolderMappings.push({
                  sourceEmail: entry.sourceEmail,
                  destinationEmail: entry.destinationEmail,
                  sourcePath: `/${data.rootFolderName}`,
                  sourceRootId: String(data.rootFolderId),
                  destinationPath: entry.destinationPath || context.destinationPath || '',
                });
                log.info(`Content multi-user: seeded for ${entry.sourceEmail} → /${data.rootFolderName} (id=${data.rootFolderId})`);
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
      const isContentProviders =
        ['box', 'dropbox', 'sharepoint', 'onedrive', 'googledrive'].includes(context.sourceProvider) ||
        ['box', 'sharepoint', 'onedrive', 'googledrive', 'dropbox'].includes(context.destinationProvider);
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
      };

      executionService.update(context.executionId, {
        status: 'COMPLETED',
        result,
        progress: 'Completed',
        completedAt: new Date().toISOString(),
      });

      // Auto-raise Neutara bug on validation failure (fire-and-forget — never blocks the flow)
      if (validationResult?.overallStatus === 'FAIL') {
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
