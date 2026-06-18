const { BaseAgent } = require('../core/BaseAgent');
const logger = require('../../utils/logger');

/**
 * Mail QA validates Gmail vs Outlook. Message migrations verify manually or with a future
 * destination-specific checker. This agent completes the pipeline without comparing mailboxes.
 */
class MessageValidationAgent extends BaseAgent {
  constructor() {
    super('MessageValidationAgent');
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    log.info('Skipping Gmail↔Outlook mailbox validation for Message product type.');

    return {
      overallStatus: 'SKIPPED',
      mismatches: [],
      note:
        'Message migration QA: validate channels, DMs, threads, and attachments in the destination app. Automated mailbox diff applies to Mail only.',
      productType: context.productType || 'Message',
      messageCombination: context.messageCombination || '',
    };
  }
}

module.exports = MessageValidationAgent;
