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
    log.info(
      'Message migration QA is not auto-validated — CloudFuze runs the chat job asynchronously. '
      + 'Verify channels, DMs, threads, and attachments in the destination app, or on CloudFuze Reports.'
    );

    return {
      overallStatus: 'SKIPPED',
      mismatches: [],
      note:
        'Message migration QA: CloudFuze migrates chat asynchronously — verify channels, DMs, threads, '
        + 'and attachments in the destination app (or via CloudFuze Reports using the job ID above). '
        + 'Automated source-vs-destination diff applies to Mail only.',
      productType: context.productType || 'Message',
      messageCombination: context.messageCombination || '',
    };
  }
}

module.exports = MessageValidationAgent;
