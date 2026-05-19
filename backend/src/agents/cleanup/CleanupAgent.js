const { BaseAgent } = require('../core/BaseAgent');
const outlookClient = require('../../clients/outlookClient');
const gmailClient   = require('../../clients/gmailClient');
const logger        = require('../../utils/logger');

/**
 * Full-wipe helpers for Outlook accounts.
 * These delete EVERY rule/setting — not just QA-prefixed ones — so the mailbox
 * starts from an absolute zero state before each migration run.
 *
 * Outlook full wipe covers:
 *   • All inbox rules (Settings → Mail → Rules)
 *   • All OWA conditional formatting rules (Settings → Mail → Conditional formatting)
 *   • All search folders (Settings → Mail → Search folders)
 *   • All messages, custom folders, calendar events, recoverable items  ← via cleanMailbox()
 *
 * Gmail full wipe covers:
 *   • All messages (including Spam & Trash)
 *   • All drafts
 *   • All custom labels
 *   • All calendar events / owned calendars
 *   • All Gmail filters (Settings → Filters and Blocked Addresses)  ← step 5 in cleanGmailMailbox()
 */
async function wipeOutlookSettings(email, log) {
  log.info(`CleanupAgent [${email}]: wiping ALL Outlook settings (inbox rules, conditional formatting, search folders)...`);

  try {
    const n = await outlookClient.deleteAllInboxRules(email);
    log.info(`CleanupAgent [${email}]: deleted ${n} inbox rule(s)`);
  } catch (err) {
    log.warn(`CleanupAgent [${email}]: inbox rules wipe failed (non-blocking): ${err.message}`);
  }

  try {
    await outlookClient.deleteAllConditionalFormattingRules(email);
    log.info(`CleanupAgent [${email}]: conditional formatting rules cleared`);
  } catch (err) {
    log.warn(`CleanupAgent [${email}]: conditional formatting wipe failed (non-blocking): ${err.message}`);
  }

  try {
    const n = await outlookClient.deleteAllSearchFolders(email);
    log.info(`CleanupAgent [${email}]: deleted ${n} search folder(s)`);
  } catch (err) {
    log.warn(`CleanupAgent [${email}]: search folders wipe failed (non-blocking): ${err.message}`);
  }
}

/**
 * CleanupAgent — wipes EVERYTHING from source and destination test accounts
 * before each run so every migration starts from a complete zero state.
 *
 * Outlook source/destination: inbox rules + CF rules + search folders THEN
 *   all messages, custom folders, calendar events, recoverable items.
 *
 * Gmail source/destination: all messages, drafts, custom labels,
 *   calendar events, and Gmail filters (complete nil account).
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
      log.info(`CleanupAgent: FULL WIPE — Outlook source: ${context.sourceEmail} (all mail, rules, CF rules, search folders)`);
      // Wipe settings BEFORE messages so rules cannot fire during cleanup
      await wipeOutlookSettings(context.sourceEmail, log);
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
      // cleanGmailMailbox performs a full wipe incl. filters (step 5)
      log.info(`CleanupAgent: FULL WIPE — Gmail source: ${context.sourceEmail} (all mail, labels, calendar, filters)`);
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
      // cleanGmailMailbox performs a full wipe incl. filters (step 5)
      log.info(`CleanupAgent: FULL WIPE — Gmail destination: ${context.destinationEmail} (all mail, labels, calendar, filters)`);
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
      log.info(`CleanupAgent: FULL WIPE — Outlook destination: ${context.destinationEmail} (all mail, rules, CF rules, search folders)`);
      await wipeOutlookSettings(context.destinationEmail, log);
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
      `CleanupAgent done (COMPLETE NIL STATE) — ` +
      `source: ${summary.sourceOutlook.messagesDeleted} msgs, ${summary.sourceOutlook.foldersDeleted} folders, ${summary.sourceOutlook.eventsDeleted} events | ` +
      `dest: ${summary.destGmail.messagesDeleted} msgs, ${summary.destGmail.foldersDeleted} folders, ${summary.destGmail.eventsDeleted} events`
    );
    return summary;
  }
}

module.exports = CleanupAgent;