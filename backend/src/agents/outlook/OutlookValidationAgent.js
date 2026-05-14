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

// Maps Outlook default folder display names → Gmail label IDs used in comparison
const OUTLOOK_TO_GMAIL_ID = {
  'Inbox': 'INBOX',
  'Sent Items': 'SENT',
  'Drafts': 'DRAFT',
  'Deleted Items': 'TRASH',
  'Junk Email': 'SPAM',
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

    log.info(`Validating [${testType}]: ${sourceUser} → ${destUser} (sourceProvider=${context.sourceProvider || 'google'})`);

    // Fetch source data — Outlook or Gmail depending on source provider
    if (context.sourceProvider === 'microsoft') {
      await this._fetchOutlookSourceData(sourceUser, result, log);
    } else {
      await this._fetchSourceData(sourceUser, result, log);
    }

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
      await this._validateCalendar(sourceUser, destUser, result, log, context.sourceProvider);
    }

    /**
     * Best-effort contacts totals for the summary table. Always populated so the PDF shows 0
     * rather than '—' when the scope isn't granted — keeps the 4-metric layout consistent.
     * Errors/warnings are logged but do not fail validation.
     */
    try {
      let srcContacts = { count: 0, available: false };
      if (context.sourceProvider === 'microsoft') {
        srcContacts = await outlookClient.getContactsCount(sourceUser);
      } else {
        srcContacts = await gmailClient.getGmailContactsCount(sourceUser);
      }
      const dstContacts = await outlookClient.getContactsCount(destUser);
      result.contactsValidation.sourceCount = Number(srcContacts?.count) || 0;
      result.contactsValidation.destinationCount = Number(dstContacts?.count) || 0;
      result.contactsValidation.available = Boolean(srcContacts?.available || dstContacts?.available);
      result.contactsValidation.countMatch =
        result.contactsValidation.sourceCount === result.contactsValidation.destinationCount;
      log.info(
        `Contacts: source=${result.contactsValidation.sourceCount} dest=${result.contactsValidation.destinationCount}${srcContacts?.note ? ` [src: ${srcContacts.note}]` : ''}${dstContacts?.note ? ` [dst: ${dstContacts.note}]` : ''}`
      );
    } catch (contactsErr) {
      log.warn(`Contacts count failed: ${contactsErr.message}`);
    }

    // Compare source vs destination
    this._compareSourceAndDestination(result, log);

    // ── Mailbox size comparison ────────────────────────────────────────────
    try {
      const { buildMailboxSizeValidation } = require('../../utils/mailMigrationComparator');
      const isMicrosoftSrc = context.sourceProvider === 'microsoft';
      const combination = isMicrosoftSrc ? 'outlook_to_outlook' : 'gmail_to_outlook';
      const [srcSize, dstSize] = await Promise.all([
        isMicrosoftSrc
          ? outlookClient.getMailboxSizeBytes(sourceUser)
          : gmailClient.getGmailMailboxSizeBytes(sourceUser),
        outlookClient.getMailboxSizeBytes(destUser),
      ]);
      result.mailboxSizeValidation = buildMailboxSizeValidation(srcSize, dstSize, combination);
      log.info(
        `Mailbox size: src=${result.mailboxSizeValidation.sourceSizeHuman} ` +
        `dst=${result.mailboxSizeValidation.destSizeHuman} ` +
        `ratio=${result.mailboxSizeValidation.sizeRatio?.toFixed(2)} [${result.mailboxSizeValidation.severity}]`
      );
    } catch (err) {
      log.warn(`Mailbox size validation failed: ${err.message}`);
      result.mailboxSizeValidation = { available: false, error: err.message };
    }

    if (context.includeMail) {
      const { runDeepMailValidation } = require('../../validation/deepMailValidator');
      await runDeepMailValidation(context, result, log);
    }

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

      /**
       * True source mailbox total comes from users.getProfile().messagesTotal — NOT the sum of
       * per-label counts. Gmail labels (STARRED, IMPORTANT, CATEGORY_*, UNREAD, INBOX) overlap,
       * so summing them double-counts every message that has more than one label. The 69 vs 81
       * mismatch seen in earlier reports was caused by that overlap. Use getMailboxStats for
       * an apples-to-apples comparison with Outlook's "sum of totalItemCount across folders".
       */
      try {
        const stats = await gmailClient.getGmailMailboxStats(sourceUser);
        // getGmailMailboxStats returns { mailCount, folderCount, calendarCount, eventCount }
        result.mailValidation.sourceCount = Number(stats?.mailCount ?? stats?.totalMessages) || 0;
        if (stats && typeof stats.calendarCount === 'number') {
          result.calendarValidation.sourceCalendarCount = stats.calendarCount;
        }
      } catch (statsErr) {
        log.warn(`Gmail getProfile failed; falling back to labels-sum: ${statsErr.message}`);
        const fallbackSrc = result.sourceData.defaultLabels
          .filter((l) => ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(l.id))
          .reduce((s, l) => s + l.messageCount, 0);
        result.mailValidation.sourceCount = fallbackSrc;
      }
      log.info(`Source: ${result.sourceData.defaultLabels.length} default labels, ${result.sourceData.customLabels.length} custom labels, total ${result.mailValidation.sourceCount} messages`);
    } catch (err) {
      log.error(`Failed to fetch source Gmail data: ${err.message}`);
    }
  }

  /**
   * For Outlook→Outlook: fetch source mailbox folders via Graph API.
   * Default folders are stored with Gmail-compatible IDs (INBOX, SENT, etc.)
   * so that _compareSourceAndDestination and PDF buildComparisonRows work unchanged.
   */
  async _fetchOutlookSourceData(sourceUser, result, log) {
    log.info(`Fetching source Outlook data for: ${sourceUser}`);
    try {
      const folders = await outlookClient.getMailFolders(sourceUser);
      const defaults = outlookClient.DEFAULT_FOLDER_NAMES;
      result.sourceData.defaultLabels = [];
      result.sourceData.customLabels = [];

      this._walkOutlookSourceFolders(folders, defaults, '', result.sourceData.defaultLabels, result.sourceData.customLabels);

      const totalSource = result.sourceData.defaultLabels.reduce((s, l) => s + l.messageCount, 0)
        + result.sourceData.customLabels.reduce((s, l) => s + l.messageCount, 0);
      result.mailValidation.sourceCount = totalSource;
      log.info(`Source Outlook: ${result.sourceData.defaultLabels.length} default, ${result.sourceData.customLabels.length} custom`);
    } catch (err) {
      log.error(`Failed to fetch source Outlook data: ${err.message}`);
    }
  }

  _walkOutlookSourceFolders(folders, defaults, parentPath, defaultLabels, customLabels) {
    if (!folders?.length) return;
    for (const folder of folders) {
      const segment = (folder.displayName || '').trim();
      const fullPath = parentPath ? `${parentPath}/${segment}` : segment;
      const count = folder.totalItemCount || 0;

      if (defaults.has(segment)) {
        const gmailId = OUTLOOK_TO_GMAIL_ID[segment];
        if (gmailId) {
          defaultLabels.push({ id: gmailId, name: segment, messageCount: count });
        } else {
          // Default folder has no Gmail ID equivalent (e.g. Calendar, Contacts) — skip to avoid
          // injecting invalid IDs like "SENT ITEMS" into the comparison
          log.warn(`OutlookValidationAgent: skipping default folder with no Gmail ID mapping: "${segment}"`);
        }
      } else {
        customLabels.push({ id: fullPath, name: fullPath, messageCount: count });
      }

      if (folder.childFolders?.length) {
        this._walkOutlookSourceFolders(folder.childFolders, defaults, fullPath, defaultLabels, customLabels);
      }
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

  async _validateCalendar(sourceUser, destUser, result, log, sourceProvider = 'google') {
    log.info('E2E: Validating calendar...');
    try {
      let sourceTotal = 0;
      try {
        if (sourceProvider === 'microsoft') {
          const srcCals = await outlookClient.getCalendars(sourceUser);
          for (const cal of srcCals) {
            const events = await outlookClient.getEvents(sourceUser, cal.id);
            sourceTotal += events.length;
          }
          result.calendarValidation.sourceEventCount = sourceTotal;
          log.info(`  Source Outlook: ${sourceTotal} events (sampled, up to 250 per calendar)`);
        } else {
          const srcCals = await calendarClient.listCalendars(sourceUser);
          for (const cal of srcCals) {
            const calId = cal.id;
            if (!calId) continue;
            const items = await calendarClient.listEvents(sourceUser, calId, 250);
            sourceTotal += items.length;
          }
          result.calendarValidation.sourceEventCount = sourceTotal;
          log.info(`  Source Gmail: ${sourceTotal} events (sampled, up to 250 per calendar)`);
        }
      } catch (srcErr) {
        log.warn(`E2E: Could not count source calendar events: ${srcErr.message}`);
      }

      const calendars = await outlookClient.getCalendars(destUser);
      result.calendarValidation.primaryCalendar = calendars.find((c) => c.isDefaultCalendar) || null;
      result.calendarValidation.secondaryCalendars = calendars.filter((c) => !c.isDefaultCalendar);
      result.calendarValidation.destinationCalendarCount = calendars.length;

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
