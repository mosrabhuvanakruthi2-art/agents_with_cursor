const GmailTestDataAgent = require('../agents/gmail/GmailTestDataAgent');
const OutlookTestDataAgent = require('../agents/outlook/OutlookTestDataAgent');
const MigrationAgent = require('../agents/migration/MigrationAgent');
const OutlookValidationAgent = require('../agents/outlook/OutlookValidationAgent');
const MigrationContext = require('../models/MigrationContext');
const logger = require('../utils/logger');
const { createExecutionLogger } = require('../utils/logger');
const executionService = require('../services/executionService');

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
      const isOutlookSource = context.sourceProvider === 'microsoft';
      return {
        context,
        dataAgent: isOutlookSource ? new OutlookTestDataAgent() : new GmailTestDataAgent(),
        migrationAgent: new MigrationAgent(),
        outlookAgent: new OutlookValidationAgent(),
        removeExecLogger,
        startTime: Date.now(),
        sourceData: null,
        migrationResult: null,
        validationResult: null,
        error: null,
      };
    });

    // ── Phase 1: Create test data for all pairs in parallel ──────────────────
    log.info('Bulk Phase 1/3: creating test data for all pairs in parallel');
    await Promise.all(pairs.map(async (pair) => {
      const { context, dataAgent } = pair;
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
      executionService.update(context.executionId, {
        currentAgent: outlookAgent.getName(),
        progress: '[3/3] OutlookValidationAgent: comparing Gmail vs Outlook…',
      });
      try {
        pair.validationResult = await outlookAgent.run(context);
        const duration = Date.now() - pair.startTime;
        const result = {
          executionId: context.executionId,
          status: 'COMPLETED',
          duration,
          agentResults: [pair.dataAgent.toJSON(), pair.migrationAgent.toJSON(), pair.outlookAgent.toJSON()],
          sourceData: pair.sourceData,
          migrationResult: pair.migrationResult,
          validationSummary: pair.validationResult,
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
            agentResults: [pair.dataAgent.toJSON(), pair.migrationAgent.toJSON(), pair.outlookAgent.toJSON()],
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
    const dataAgent = isOutlookSource ? new OutlookTestDataAgent() : new GmailTestDataAgent();
    const migrationAgent = new MigrationAgent();
    const outlookAgent = new OutlookValidationAgent();

    try {
      // Step 1: Generate test data (Gmail or Outlook depending on source provider)
      executionService.update(context.executionId, {
        status: 'RUNNING',
        currentAgent: dataAgent.getName(),
        progress: isOutlookSource
          ? 'OutlookTestDataAgent: listing folders, provisioning test mail data…'
          : 'GmailTestDataAgent: creating labels, mail, drafts, calendar (if E2E)…',
      });
      log.info(`Step 1: Running ${dataAgent.getName()} (sourceProvider=${context.sourceProvider})`);
      const sourceData = await dataAgent.run(context);

      if (executionService.isCancelled(context.executionId)) {
        throw new Error('Execution cancelled by user');
      }

      // Step 2: Trigger and monitor migration
      executionService.update(context.executionId, {
        currentAgent: migrationAgent.getName(),
        progress: 'MigrationAgent: CloudFuze login, validate user, trigger move, poll destination…',
      });
      log.info('Step 2: Running MigrationAgent');
      const migrationResult = await migrationAgent.run(context);

      if (executionService.isCancelled(context.executionId)) {
        throw new Error('Execution cancelled by user');
      }

      // Step 3: Validate in Outlook
      executionService.update(context.executionId, {
        currentAgent: outlookAgent.getName(),
        progress: 'OutlookValidationAgent: comparing Gmail vs Outlook and running checks…',
      });
      log.info('Step 3: Running OutlookValidationAgent');
      const validationResult = await outlookAgent.run(context);

      const duration = Date.now() - startTime;

      const result = {
        executionId: context.executionId,
        status: 'COMPLETED',
        duration,
        agentResults: [
          dataAgent.toJSON(),
          migrationAgent.toJSON(),
          outlookAgent.toJSON(),
        ],
        sourceData,
        migrationResult,
        validationSummary: validationResult,
      };

      executionService.update(context.executionId, {
        status: 'COMPLETED',
        result,
        progress: 'Completed',
        completedAt: new Date().toISOString(),
      });

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
          dataAgent.toJSON(),
          migrationAgent.toJSON(),
          outlookAgent.toJSON(),
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
}

module.exports = new AgentOrchestrator();
