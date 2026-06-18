const GmailTestDataAgent = require('../agents/gmail/GmailTestDataAgent');
const MessageTestDataAgent = require('../agents/message/MessageTestDataAgent');
const MessageValidationAgent = require('../agents/message/MessageValidationAgent');
const MigrationAgent = require('../agents/migration/MigrationAgent');
const OutlookValidationAgent = require('../agents/outlook/OutlookValidationAgent');
const MigrationContext = require('../models/MigrationContext');
const logger = require('../utils/logger');
const { createExecutionLogger } = require('../utils/logger');
const executionService = require('../services/executionService');
const env = require('../config/env');

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
    const messageAgent = new MessageTestDataAgent();
    const messageValidationAgent = new MessageValidationAgent();
    const migrationAgent = new MigrationAgent();
    const outlookAgent = new OutlookValidationAgent();

    const isMessage = context.productType === 'Message';
    const runCloudFuze = !isMessage || env.MESSAGE_RUN_CLOUDFUZE === true;

    try {
      let sourceData;

      // Step 1: Seed source test data (Gmail vs Slack / Google Chat / Teams)
      if (isMessage) {
        executionService.update(context.executionId, {
          status: 'RUNNING',
          currentAgent: messageAgent.getName(),
          progress:
            'MessageTestDataAgent: posting seed messages to source platform (custom cases from Test Case Generator when saved)…',
        });
        log.info('Step 1: Running MessageTestDataAgent');
        sourceData = { skipped: true, reason: 'Include Mail/Message seeding disabled' };
        if (context.includeMail !== false) {
          sourceData = await messageAgent.run(context);
        }
      } else {
        executionService.update(context.executionId, {
          status: 'RUNNING',
          currentAgent: gmailAgent.getName(),
          progress: 'GmailTestDataAgent: creating labels, mail, drafts, calendar (if E2E)…',
        });
        log.info('Step 1: Running GmailTestDataAgent');
        sourceData = await gmailAgent.run(context);
      }

      // Step 2: CloudFuze migration (mail pipeline; optional for Message if MESSAGE_RUN_CLOUDFUZE=true)
      let migrationResult;
      if (!runCloudFuze) {
        migrationResult = {
          skipped: true,
          reason:
            'Message product: CloudFuze trigger skipped (set MESSAGE_RUN_CLOUDFUZE=true when your tenant uses message migration).',
        };
        executionService.update(context.executionId, {
          currentAgent: migrationAgent.getName(),
          progress: 'MigrationAgent: skipped for Message (see MESSAGE_RUN_CLOUDFUZE)',
        });
        log.info('Step 2: MigrationAgent skipped (Message + MESSAGE_RUN_CLOUDFUZE not set)');
      } else {
        executionService.update(context.executionId, {
          currentAgent: migrationAgent.getName(),
          progress: 'MigrationAgent: CloudFuze login, validate user, trigger move, poll destination…',
        });
        log.info('Step 2: Running MigrationAgent');
        migrationResult = await migrationAgent.run(context);
      }

      // Step 3: Validation (Outlook mail vs Message placeholder)
      let validationResult;
      if (isMessage) {
        executionService.update(context.executionId, {
          currentAgent: messageValidationAgent.getName(),
          progress: 'MessageValidationAgent: mailbox diff not applicable — mark manual checks in destination…',
        });
        log.info('Step 3: Running MessageValidationAgent');
        validationResult = await messageValidationAgent.run(context);
      } else {
        executionService.update(context.executionId, {
          currentAgent: outlookAgent.getName(),
          progress: 'OutlookValidationAgent: comparing Gmail vs Outlook and running checks…',
        });
        log.info('Step 3: Running OutlookValidationAgent');
        validationResult = await outlookAgent.run(context);
      }

      const duration = Date.now() - startTime;

      const agentResults = isMessage
        ? [messageAgent.toJSON(), migrationAgent.toJSON(), messageValidationAgent.toJSON()]
        : [gmailAgent.toJSON(), migrationAgent.toJSON(), outlookAgent.toJSON()];

      const result = {
        executionId: context.executionId,
        status: 'COMPLETED',
        duration,
        agentResults,
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

      const agentResults = isMessage
        ? [messageAgent.toJSON(), migrationAgent.toJSON(), messageValidationAgent.toJSON()]
        : [gmailAgent.toJSON(), migrationAgent.toJSON(), outlookAgent.toJSON()];

      const result = {
        executionId: context.executionId,
        status: 'FAILED',
        duration,
        error: err.message,
        agentResults,
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
