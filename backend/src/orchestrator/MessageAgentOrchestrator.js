const MessageTestDataAgent = require('../agents/message/MessageTestDataAgent');
const MessageMigrationAgent = require('../agents/message/MessageMigrationAgent');
const MessageValidationAgent = require('../agents/message/MessageValidationAgent');
const MessageMigrationContext = require('../models/MessageMigrationContext');
const logger = require('../utils/logger');
const { createExecutionLogger } = require('../utils/logger');
const executionService = require('../services/executionService');

/**
 * Mirrors AgentOrchestrator but for message/chat migration. Uses the same
 * executionService so Execution Logs and polling stay identical.
 *
 * Flow:
 *   1) MessageTestDataAgent  — load matching cases from Agent Repo, post to
 *      source platform when supported (live Slack) or dry-run otherwise.
 *   2) MessageMigrationAgent — acknowledge CloudFuze chat-migration job (stub).
 *   3) MessageValidationAgent — compare counts, produce validationSummary.
 */
class MessageAgentOrchestrator {
  async runFullFlow(contextData) {
    const context = contextData instanceof MessageMigrationContext
      ? contextData
      : new MessageMigrationContext(contextData);

    context.validate();

    const removeExecLogger = createExecutionLogger(context.executionId);
    const log = logger.child({ executionId: context.executionId });

    if (!executionService.get(context.executionId)) {
      executionService.create(context);
    }

    const startTime = Date.now();
    log.info('Starting Message Agent full flow');

    const dataAgent = new MessageTestDataAgent();
    const migrationAgent = new MessageMigrationAgent();
    const validationAgent = new MessageValidationAgent();

    // Used by validation to reference earlier agents' outputs.
    context.sharedResults = {};

    try {
      executionService.update(context.executionId, {
        status: 'RUNNING',
        currentAgent: dataAgent.getName(),
        progress: 'MessageTestDataAgent: loading Agent Repo cases and seeding source workspace…',
      });
      log.info('Step 1: MessageTestDataAgent');
      const sourceData = await dataAgent.run(context);
      context.sharedResults.sourceData = sourceData;

      executionService.update(context.executionId, {
        currentAgent: migrationAgent.getName(),
        progress: 'MessageMigrationAgent: submitting CloudFuze chat-migration job…',
      });
      log.info('Step 2: MessageMigrationAgent');
      const migrationResult = await migrationAgent.run(context);
      context.sharedResults.migrationResult = migrationResult;

      executionService.update(context.executionId, {
        currentAgent: validationAgent.getName(),
        progress: 'MessageValidationAgent: comparing seeded vs migrated conversations…',
      });
      log.info('Step 3: MessageValidationAgent');
      const validationResult = await validationAgent.run(context);

      const duration = Date.now() - startTime;
      const result = {
        kind: 'message',
        executionId: context.executionId,
        status: 'COMPLETED',
        duration,
        agentResults: [
          dataAgent.toJSON(),
          migrationAgent.toJSON(),
          validationAgent.toJSON(),
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

      log.info(`Message Agent full flow completed in ${duration}ms`);
      removeExecLogger();
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      log.error(`Message Agent full flow failed after ${duration}ms: ${err.message}`);

      const result = {
        kind: 'message',
        executionId: context.executionId,
        status: 'FAILED',
        duration,
        error: err.message,
        agentResults: [
          dataAgent.toJSON(),
          migrationAgent.toJSON(),
          validationAgent.toJSON(),
        ],
      };

      executionService.update(context.executionId, {
        status: 'FAILED',
        result,
        error: err.message,
        progress: `Failed: ${err.message}`,
        completedAt: new Date().toISOString(),
      });

      removeExecLogger();
      return result;
    }
  }

  /**
   * Stage 1 of the split Message-Agent flow — posts Agent Repo test cases into
   * source channels / DMs and returns a seed summary. Keeps runFullFlow above
   * untouched so anything (bulk runs, older callers) that depends on the
   * combined flow keeps working.
   */
  async runSeedOnly(contextData) {
    const context = contextData instanceof MessageMigrationContext
      ? contextData
      : new MessageMigrationContext(contextData);

    context.validate();

    const removeExecLogger = createExecutionLogger(context.executionId);
    const log = logger.child({ executionId: context.executionId });

    if (!executionService.get(context.executionId)) {
      executionService.create(context);
    }

    const startTime = Date.now();
    log.info('Starting Message Agent SEED-ONLY flow');

    const dataAgent = new MessageTestDataAgent();
    context.sharedResults = context.sharedResults || {};

    try {
      executionService.update(context.executionId, {
        status: 'RUNNING',
        currentAgent: dataAgent.getName(),
        progress: 'MessageTestDataAgent: posting Agent Repo cases to source channels / DMs…',
      });
      log.info('Step 1 (seed-only): MessageTestDataAgent');
      const sourceData = await dataAgent.run(context);
      context.sharedResults.sourceData = sourceData;

      const duration = Date.now() - startTime;
      const result = {
        kind: 'message',
        phase: 'seed',
        executionId: context.executionId,
        status: 'COMPLETED',
        duration,
        agentResults: [dataAgent.toJSON()],
        sourceData,
      };

      executionService.update(context.executionId, {
        status: 'COMPLETED',
        result,
        progress: 'Seeding complete — ready to initiate migration',
        completedAt: new Date().toISOString(),
      });

      log.info(`Message Agent SEED-ONLY complete in ${duration}ms`);
      removeExecLogger();
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      log.error(`Message Agent SEED-ONLY failed after ${duration}ms: ${err.message}`);

      const result = {
        kind: 'message',
        phase: 'seed',
        executionId: context.executionId,
        status: 'FAILED',
        duration,
        error: err.message,
        agentResults: [dataAgent.toJSON()],
      };

      executionService.update(context.executionId, {
        status: 'FAILED',
        result,
        error: err.message,
        progress: `Seeding failed: ${err.message}`,
        completedAt: new Date().toISOString(),
      });

      removeExecLogger();
      return result;
    }
  }

  /**
   * Stage 2 of the split Message-Agent flow — runs Migration + Validation on
   * an already-seeded context (typically the channel / DM IDs selected by the
   * user after Stage 1). Expects `contextData.channelIds` / `dmIds` to be the
   * user's selected subset.
   */
  async runMigrateOnly(contextData) {
    const context = contextData instanceof MessageMigrationContext
      ? contextData
      : new MessageMigrationContext(contextData);

    context.validate();

    const removeExecLogger = createExecutionLogger(context.executionId);
    const log = logger.child({ executionId: context.executionId });

    if (!executionService.get(context.executionId)) {
      executionService.create(context);
    }

    const startTime = Date.now();
    log.info('Starting Message Agent MIGRATE-ONLY flow');

    const migrationAgent = new MessageMigrationAgent();
    const validationAgent = new MessageValidationAgent();
    context.sharedResults = context.sharedResults || {};

    try {
      executionService.update(context.executionId, {
        status: 'RUNNING',
        currentAgent: migrationAgent.getName(),
        progress: 'MessageMigrationAgent: submitting CloudFuze chat-migration job…',
      });
      log.info('Step 1 (migrate-only): MessageMigrationAgent');
      const migrationResult = await migrationAgent.run(context);
      context.sharedResults.migrationResult = migrationResult;

      executionService.update(context.executionId, {
        currentAgent: validationAgent.getName(),
        progress: 'MessageValidationAgent: validating migrated conversations…',
      });
      log.info('Step 2 (migrate-only): MessageValidationAgent');
      const validationResult = await validationAgent.run(context);

      const duration = Date.now() - startTime;
      const result = {
        kind: 'message',
        phase: 'migrate',
        executionId: context.executionId,
        status: 'COMPLETED',
        duration,
        agentResults: [migrationAgent.toJSON(), validationAgent.toJSON()],
        migrationResult,
        validationSummary: validationResult,
      };

      executionService.update(context.executionId, {
        status: 'COMPLETED',
        result,
        progress: 'Migration complete',
        completedAt: new Date().toISOString(),
      });

      log.info(`Message Agent MIGRATE-ONLY complete in ${duration}ms`);
      removeExecLogger();
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      log.error(`Message Agent MIGRATE-ONLY failed after ${duration}ms: ${err.message}`);

      const result = {
        kind: 'message',
        phase: 'migrate',
        executionId: context.executionId,
        status: 'FAILED',
        duration,
        error: err.message,
        agentResults: [migrationAgent.toJSON(), validationAgent.toJSON()],
      };

      executionService.update(context.executionId, {
        status: 'FAILED',
        result,
        error: err.message,
        progress: `Migration failed: ${err.message}`,
        completedAt: new Date().toISOString(),
      });

      removeExecLogger();
      return result;
    }
  }
}

module.exports = new MessageAgentOrchestrator();
