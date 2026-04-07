const GmailTestDataAgent = require('../agents/gmail/GmailTestDataAgent');
const MigrationAgent = require('../agents/migration/MigrationAgent');
const OutlookValidationAgent = require('../agents/outlook/OutlookValidationAgent');
const MigrationContext = require('../models/MigrationContext');
const logger = require('../utils/logger');
const { createExecutionLogger } = require('../utils/logger');
const executionService = require('../services/executionService');

class AgentOrchestrator {
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

    const gmailAgent = new GmailTestDataAgent();
    const migrationAgent = new MigrationAgent();
    const outlookAgent = new OutlookValidationAgent();

    try {
      // Step 1: Generate Gmail test data
      executionService.update(context.executionId, {
        status: 'RUNNING',
        currentAgent: gmailAgent.getName(),
        progress: 'GmailTestDataAgent: creating labels, mail, drafts, calendar (if E2E)…',
      });
      log.info('Step 1: Running GmailTestDataAgent');
      const sourceData = await gmailAgent.run(context);

      // Step 2: Trigger and monitor migration
      executionService.update(context.executionId, {
        currentAgent: migrationAgent.getName(),
        progress: 'MigrationAgent: CloudFuze login, validate user, trigger move, poll destination…',
      });
      log.info('Step 2: Running MigrationAgent');
      const migrationResult = await migrationAgent.run(context);

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
          gmailAgent.toJSON(),
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
      log.error(`Full flow failed after ${duration}ms: ${err.message}`);

      const result = {
        executionId: context.executionId,
        status: 'FAILED',
        duration,
        error: err.message,
        agentResults: [
          gmailAgent.toJSON(),
          migrationAgent.toJSON(),
          outlookAgent.toJSON(),
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
}

module.exports = new AgentOrchestrator();
