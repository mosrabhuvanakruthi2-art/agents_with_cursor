const MigrationAgent = require('../agents/migration/MigrationAgent');
const CleanupAgent = require('../agents/cleanup/CleanupAgent');
const MigrationContext = require('../models/MigrationContext');
const logger = require('../utils/logger');
const { createExecutionLogger } = require('../utils/logger');
const executionService = require('../services/executionService');
const neutaraClient = require('../clients/neutaraClient');
const { resolve: resolveAgents } = require('./agentRegistry');
const devemailClient = require('../clients/devemailClient');

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

      // Step 1: Generate test data.
      // Skipped when: explicitly skipped on resume (skipTestData), OR no TestDataAgent registered
      // for this combination (content combinations without a seeding agent).
      let sourceData = null;
      if (!context.skipTestData && dataAgent !== null) {
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
        // For content migrations: capture source folder path so MigrationAgent can build the CSV
        if (sourceData?.rootFolderName) {
          context.sourceTestDataPath = `/${sourceData.rootFolderName}`;
          log.info(`Content source path captured from ${dataAgent.getName()}: ${context.sourceTestDataPath}`);
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

      // Step 3: Validate — skip for content migrations (box/sharepoint/onedrive/dropbox)
      // UNLESS the ValidationAgent class declares `static supportsDeepValidation = true`,
      // which means it has a real file/folder comparison (e.g. BoxToSharepointValidationAgent).
      // Always skip when MigrationAgent returned skipValidation (e.g. content stop status).
      const isContentProviders =
        ['box', 'dropbox', 'sharepoint', 'onedrive', 'googledrive'].includes(context.sourceProvider) ||
        ['box', 'sharepoint', 'onedrive', 'googledrive', 'dropbox'].includes(context.destinationProvider);
      const ValidationAgentClass = agentsFor(context)?.ValidationAgent;
      const hasDeepValidation = Boolean(ValidationAgentClass?.supportsDeepValidation);
      const skipValidation = migrationResult?.skipValidation ||
        (isContentMode && isContentProviders && !hasDeepValidation);

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
