const { BaseAgent } = require('../core/BaseAgent');
const outlookClient = require('../../clients/outlookClient');
const gmailClient   = require('../../clients/gmailClient');
const logger        = require('../../utils/logger');

/**
 * CleanupAgent — wipes ALL data from source and destination test accounts
 * before each run so every migration starts from a clean slate.
 *
 * Source (Outlook):  all messages, custom folders, calendar events, recoverable items
 * Destination (Gmail): all messages, drafts, custom labels, calendar events
 *
 * Set context.skipCleanup = true to opt out for a single run.
 */
class CleanupAgent extends BaseAgent {
  constructor() {
    super('CleanupAgent');
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });

    if (context.skipCleanup === true) {
      log.info('CleanupAgent: skipped (context.skipCleanup=true)');
      return { skipped: true };
    }

    const summary = {
      sourceOutlook: { messagesDeleted: 0, foldersDeleted: 0, eventsDeleted: 0, errors: [] },
      destGmail:     { messagesDeleted: 0, foldersDeleted: 0, eventsDeleted: 0, errors: [] },
    };

    const isOutlookSrc = context.sourceProvider === 'microsoft';
    const isGmailDst   = context.destinationProvider === 'google';

    // ── Source cleanup ────────────────────────────────────────────────────────
    if (isOutlookSrc && context.sourceEmail) {
      log.info(`CleanupAgent: full wipe of Outlook source: ${context.sourceEmail}`);
      try {
        const result = await outlookClient.cleanMailbox(context.sourceEmail);
        summary.sourceOutlook.messagesDeleted = result.messagesDeleted || 0;
        summary.sourceOutlook.foldersDeleted  = result.foldersDeleted  || 0;
        summary.sourceOutlook.eventsDeleted   = result.eventsDeleted   || 0;
        summary.sourceOutlook.errors.push(...(result.errors || []));
      } catch (err) {
        summary.sourceOutlook.errors.push(err.message);
        log.warn(`CleanupAgent: Outlook source wipe error (non-blocking): ${err.message}`);
      }
      outlookClient.clearFolderCache(context.sourceEmail);

    } else if (!isOutlookSrc && context.sourceEmail) {
      // Gmail source (Gmail→Outlook or Gmail→Gmail)
      log.info(`CleanupAgent: full wipe of Gmail source: ${context.sourceEmail}`);
      try {
        const result = await gmailClient.cleanGmailMailbox(context.sourceEmail);
        summary.sourceOutlook.messagesDeleted = result.messagesDeleted || 0;
        summary.sourceOutlook.foldersDeleted  = result.foldersDeleted  || 0;
        summary.sourceOutlook.eventsDeleted   = result.eventsDeleted   || 0;
        summary.sourceOutlook.errors.push(...(result.errors || []));
      } catch (err) {
        summary.sourceOutlook.errors.push(err.message);
        log.warn(`CleanupAgent: Gmail source wipe error (non-blocking): ${err.message}`);
      }
    }

    // ── Destination cleanup ───────────────────────────────────────────────────
    if (isGmailDst && context.destinationEmail) {
      log.info(`CleanupAgent: full wipe of Gmail destination: ${context.destinationEmail}`);
      try {
        const result = await gmailClient.cleanGmailMailbox(context.destinationEmail);
        summary.destGmail.messagesDeleted = result.messagesDeleted || 0;
        summary.destGmail.foldersDeleted  = result.foldersDeleted  || 0;
        summary.destGmail.eventsDeleted   = result.eventsDeleted   || 0;
        summary.destGmail.errors.push(...(result.errors || []));
      } catch (err) {
        summary.destGmail.errors.push(err.message);
        log.warn(`CleanupAgent: Gmail destination wipe error (non-blocking): ${err.message}`);
      }

    } else if (!isGmailDst && context.destinationEmail) {
      // Outlook destination (Gmail→Outlook or Outlook→Outlook)
      log.info(`CleanupAgent: full wipe of Outlook destination: ${context.destinationEmail}`);
      try {
        const result = await outlookClient.cleanMailbox(context.destinationEmail);
        summary.destGmail.messagesDeleted = result.messagesDeleted || 0;
        summary.destGmail.foldersDeleted  = result.foldersDeleted  || 0;
        summary.destGmail.eventsDeleted   = result.eventsDeleted   || 0;
        summary.destGmail.errors.push(...(result.errors || []));
      } catch (err) {
        summary.destGmail.errors.push(err.message);
        log.warn(`CleanupAgent: Outlook destination wipe error (non-blocking): ${err.message}`);
      }
      outlookClient.clearFolderCache(context.destinationEmail);
    }

    log.info(
      `CleanupAgent done — ` +
      `source: ${summary.sourceOutlook.messagesDeleted} msgs, ${summary.sourceOutlook.foldersDeleted} folders, ${summary.sourceOutlook.eventsDeleted} events | ` +
      `dest: ${summary.destGmail.messagesDeleted} msgs, ${summary.destGmail.foldersDeleted} folders, ${summary.destGmail.eventsDeleted} events`
    );
    return summary;
  }
}

module.exports = CleanupAgent;
