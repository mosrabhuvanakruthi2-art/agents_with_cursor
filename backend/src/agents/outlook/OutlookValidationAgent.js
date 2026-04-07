const { BaseAgent } = require('../core/BaseAgent');
const outlookClient = require('../../clients/outlookClient');
const gmailClient = require('../../clients/gmailClient');
const calendarClient = require('../../clients/calendarClient');
const ValidationResult = require('../../models/ValidationResult');
const logger = require('../../utils/logger');
const { findDestCustomFolder } = require('../../utils/gmailOutlookLabelMatch');

const GMAIL_SYSTEM_LABELS = new Set([
  'INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM',
  'STARRED', 'IMPORTANT', 'CHAT', 'UNREAD',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
]);

const GMAIL_TO_OUTLOOK_MAP = {
  INBOX: 'Inbox',
  SENT: 'Sent Items',
  DRAFT: 'Drafts',
  TRASH: 'Deleted Items',
  SPAM: 'Junk Email',
};

class OutlookValidationAgent extends BaseAgent {
  constructor() {
    super('OutlookValidationAgent');
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    const result = new ValidationResult();
    const destUser = context.destinationEmail;
    const sourceUser = context.sourceEmail;
    const testType = context.testType || 'E2E';

    log.info(`Validating [${testType}]: ${sourceUser} → ${destUser}`);

    // Fetch source Gmail data
    await this._fetchSourceData(sourceUser, result, log);

    // Fetch destination Outlook data
    await this._fetchDestinationData(destUser, result, log);

    if (context.includeMail) {
      if (testType === 'SMOKE') {
        await this._smokeValidateMail(destUser, result, log);
      } else if (testType === 'SANITY') {
        await this._sanityValidateMail(destUser, result, log);
      } else {
        await this._e2eValidateMail(destUser, result, log);
      }
    }

    if (context.includeCalendar && testType === 'E2E') {
      await this._validateCalendar(sourceUser, destUser, result, log);
    }

    // Compare source vs destination
    this._compareSourceAndDestination(result, log);

    result.computeOverallStatus();
    log.info(`Validation complete [${testType}]: ${result.overallStatus} (${result.mismatches.length} mismatches)`);
    return result.toJSON();
  }

  async _fetchSourceData(sourceUser, result, log) {
    log.info(`Fetching source Gmail data for: ${sourceUser}`);
    try {
      const labels = await gmailClient.listLabels(sourceUser, 'me');

      for (const label of labels) {
        let count = 0;
        try {
          count = await gmailClient.getMessageCount(sourceUser, 'me', label.id);
        } catch { /* some labels may not return counts */ }

        const entry = { name: label.name, id: label.id, messageCount: count };

        if (label.type === 'system' || GMAIL_SYSTEM_LABELS.has(label.id)) {
          result.sourceData.defaultLabels.push(entry);
        } else {
          result.sourceData.customLabels.push(entry);
        }
      }

      const totalSource = result.sourceData.defaultLabels.reduce((s, l) => s + l.messageCount, 0);
      result.mailValidation.sourceCount = totalSource;
      log.info(`Source: ${result.sourceData.defaultLabels.length} default labels, ${result.sourceData.customLabels.length} custom labels`);
    } catch (err) {
      log.error(`Failed to fetch source Gmail data: ${err.message}`);
    }
  }

  async _fetchDestinationData(destUser, result, log) {
    log.info(`Fetching destination Outlook data for: ${destUser}`);
    try {
      const folders = await outlookClient.getMailFolders(destUser);
      const defaults = outlookClient.DEFAULT_FOLDER_NAMES;

      result.destinationData.defaultFolders = [];
      result.destinationData.customFolders = [];
      this._walkOutlookFolders(folders, defaults, '', result.destinationData.defaultFolders, result.destinationData.customFolders);

      log.info(`Destination: ${result.destinationData.defaultFolders.length} default folders, ${result.destinationData.customFolders.length} custom folders`);
    } catch (err) {
      log.error(`Failed to fetch destination Outlook data: ${err.message}`);
    }
  }

  /**
   * Gmail nested labels use a single name with slashes (e.g. QA-TestLabel/Nested-Child).
   * Outlook uses parent/child folders with separate displayNames.
   * Build slash-separated paths for custom folders so comparison matches Gmail.
   */
  _walkOutlookFolders(folders, defaults, parentPath, defaultFolders, customFolders) {
    if (!folders?.length) return;
    for (const folder of folders) {
      const segment = (folder.displayName || '').trim();
      const fullPath = parentPath ? `${parentPath}/${segment}` : segment;

      if (defaults.has(segment)) {
        defaultFolders.push({ name: segment, messageCount: folder.totalItemCount || 0 });
      } else {
        customFolders.push({ name: fullPath, messageCount: folder.totalItemCount || 0 });
      }

      if (folder.childFolders?.length) {
        this._walkOutlookFolders(folder.childFolders, defaults, fullPath, defaultFolders, customFolders);
      }
    }
  }

  _compareSourceAndDestination(result, log) {
    log.info('Comparing source vs destination...');

    // Compare default labels/folders by mapped name
    for (const [gmailId, outlookName] of Object.entries(GMAIL_TO_OUTLOOK_MAP)) {
      const srcLabel = result.sourceData.defaultLabels.find((l) => l.id === gmailId || l.name === gmailId);
      const destFolder = result.destinationData.defaultFolders.find((f) => f.name === outlookName);

      const srcCount = srcLabel?.messageCount || 0;
      const destCount = destFolder?.messageCount || 0;

      if (srcCount !== destCount) {
        result.addComparisonIssue('default', `${gmailId} → ${outlookName}`, srcCount, destCount);
      }
    }

    // Custom labels: full path from Graph walk, or flat leaf name (Nested-Child) under parent folder
    for (const srcLabel of result.sourceData.customLabels) {
      const destFolder = findDestCustomFolder(result.destinationData.customFolders, srcLabel.name);

      const srcCount = srcLabel.messageCount || 0;
      const destCount = destFolder?.messageCount || 0;

      if (!destFolder) {
        result.addComparisonIssue('custom', srcLabel.name, srcCount, 'NOT_FOUND');
      } else if (srcCount !== destCount) {
        result.addComparisonIssue('custom', srcLabel.name, srcCount, destCount);
      }
    }

    result.comparison.defaultLabelsMatch = !result.comparison.issues.some((i) => i.type === 'default');
    result.comparison.customLabelsMatch = !result.comparison.issues.some((i) => i.type === 'custom');

    log.info(`Comparison: ${result.comparison.issues.length} issues found (defaults match: ${result.comparison.defaultLabelsMatch}, custom match: ${result.comparison.customLabelsMatch})`);
  }

  async _smokeValidateMail(destUser, result, log) {
    log.info('SMOKE: Checking mailbox accessibility...');
    try {
      const folders = await outlookClient.getMailFolders(destUser);
      const inboxFolder = folders.find((f) => f.displayName === 'Inbox' || f.displayName === 'INBOX');

      if (!inboxFolder) {
        result.addMismatch('mail', 'inbox', 'exists', 'NOT_FOUND');
        return;
      }

      const inboxCount = inboxFolder.totalItemCount || 0;
      result.mailValidation.destinationCount = inboxCount;
      result.mailValidation.folderMapping.push({
        folderName: 'Inbox',
        messageCount: inboxCount,
        unreadCount: inboxFolder.unreadItemCount || 0,
      });

      log.info(`SMOKE: Inbox accessible with ${inboxCount} messages`);
    } catch (err) {
      log.error(`SMOKE: Mail validation failed: ${err.message}`);
      result.addMismatch('mail', 'accessibility', 'accessible', err.message);
    }
  }

  async _sanityValidateMail(destUser, result, log) {
    log.info('SANITY: Validating mail folders and QA emails...');
    try {
      const allFolders = await outlookClient.getAllFoldersFlat(destUser);
      let totalMessages = 0;
      for (const folder of allFolders) {
        const count = folder.totalItemCount || 0;
        totalMessages += count;
        result.mailValidation.folderMapping.push({ folderName: folder.displayName, messageCount: count, unreadCount: folder.unreadItemCount || 0 });
      }
      result.mailValidation.destinationCount = totalMessages;

      const inboxFolder = allFolders.find((f) => f.displayName === 'Inbox' || f.displayName === 'INBOX');
      if (inboxFolder) {
        const messages = await outlookClient.getMessages(destUser, inboxFolder.id, 50);
        const qaMessages = messages.filter((m) => m.subject?.startsWith('QA '));
        for (const msg of qaMessages) {
          result.mailValidation.subjectChecks.push({ subject: msg.subject, found: true, hasAttachments: msg.hasAttachments, receivedDateTime: msg.receivedDateTime });
        }
        for (const msg of qaMessages.filter((m) => m.hasAttachments)) {
          try {
            const attachments = await outlookClient.getAttachments(destUser, msg.id);
            result.mailValidation.attachmentChecks.push({ messageSubject: msg.subject, attachmentCount: attachments.length, attachments: attachments.map((a) => ({ name: a.name, size: a.size, contentType: a.contentType })) });
          } catch (err) { log.warn(`SANITY: Could not fetch attachments: ${err.message}`); }
        }
      }
    } catch (err) {
      log.error(`SANITY: Mail validation failed: ${err.message}`);
      result.addMismatch('mail', 'overall', 'accessible', err.message);
    }
  }

  async _e2eValidateMail(destUser, result, log) {
    log.info('E2E: Full mail validation...');
    try {
      const allFolders = await outlookClient.getAllFoldersFlat(destUser);
      let totalMessages = 0;
      for (const folder of allFolders) {
        const count = folder.totalItemCount || 0;
        totalMessages += count;
        result.mailValidation.folderMapping.push({ folderName: folder.displayName, messageCount: count, unreadCount: folder.unreadItemCount || 0 });
        log.info(`  Folder: ${folder.displayName} — ${count} messages`);
      }
      result.mailValidation.destinationCount = totalMessages;

      const inboxFolder = allFolders.find((f) => f.displayName === 'Inbox' || f.displayName === 'INBOX');
      if (inboxFolder) {
        const messages = await outlookClient.getMessages(destUser, inboxFolder.id, 100);
        for (const msg of messages) {
          result.mailValidation.subjectChecks.push({ subject: msg.subject, found: true, hasAttachments: msg.hasAttachments, receivedDateTime: msg.receivedDateTime });
          if (msg.hasAttachments) {
            try {
              const attachments = await outlookClient.getAttachments(destUser, msg.id);
              result.mailValidation.attachmentChecks.push({ messageSubject: msg.subject, attachmentCount: attachments.length, attachments: attachments.map((a) => ({ name: a.name, size: a.size, contentType: a.contentType })) });
            } catch (err) { log.warn(`E2E: Could not fetch attachments: ${err.message}`); }
          }
        }
        log.info(`E2E: Checked ${messages.length} inbox messages`);
      }
    } catch (err) {
      log.error(`E2E: Mail validation failed: ${err.message}`);
      result.addMismatch('mail', 'overall', 'accessible', err.message);
    }
  }

  async _validateCalendar(sourceUser, destUser, result, log) {
    log.info('E2E: Validating calendar...');
    try {
      let sourceTotal = 0;
      try {
        const srcCals = await calendarClient.listCalendars(sourceUser);
        for (const cal of srcCals) {
          const calId = cal.id;
          if (!calId) continue;
          const items = await calendarClient.listEvents(sourceUser, calId, 250);
          sourceTotal += items.length;
        }
        result.calendarValidation.sourceEventCount = sourceTotal;
        log.info(`  Source Gmail: ${sourceTotal} events (sampled, up to 250 per calendar)`);
      } catch (srcErr) {
        log.warn(`E2E: Could not count source calendar events: ${srcErr.message}`);
      }

      const calendars = await outlookClient.getCalendars(destUser);
      result.calendarValidation.primaryCalendar = calendars.find((c) => c.isDefaultCalendar) || null;
      result.calendarValidation.secondaryCalendars = calendars.filter((c) => !c.isDefaultCalendar);

      let totalEvents = 0;
      for (const cal of calendars) {
        const events = await outlookClient.getEvents(destUser, cal.id);
        totalEvents += events.length;
        for (const event of events) {
          result.calendarValidation.eventDetails.push({ subject: event.subject, calendarName: cal.name, isRecurring: !!event.recurrence, isAllDay: event.isAllDay, start: event.start, end: event.end });
          if (event.recurrence) {
            result.calendarValidation.recurringEvents.push({ subject: event.subject, recurrencePattern: event.recurrence.pattern?.type });
          }
        }
        log.info(`  Calendar: ${cal.name} — ${events.length} events`);
      }
      result.calendarValidation.destinationEventCount = totalEvents;
    } catch (err) {
      log.error(`E2E: Calendar validation failed: ${err.message}`);
      result.addMismatch('calendar', 'overall', 'accessible', err.message);
    }
  }
}

module.exports = OutlookValidationAgent;
