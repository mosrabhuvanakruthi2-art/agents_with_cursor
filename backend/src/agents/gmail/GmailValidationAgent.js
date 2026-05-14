/**
 * GmailValidationAgent
 *
 * Validates destination Gmail mailbox (migrationn.com) after an Outlook→Gmail
 * migration.  Source is always an Outlook / Microsoft 365 mailbox.
 *
 * Validation scope:
 *   - Mail: Outlook folder counts → Gmail label counts (folder mapping below)
 *   - Calendar: Outlook event count → Gmail Calendar event count (E2E + DELTA)
 *   - Contacts: Outlook contacts count → Gmail People API count (E2E + DELTA)
 *   - Groups: Outlook M365 groups count → Google Workspace groups count (E2E + DELTA)
 *
 * Outlook→Gmail folder mapping:
 *   Inbox         → INBOX
 *   Sent Items    → SENT
 *   Drafts        → DRAFT
 *   Deleted Items → TRASH
 *   Junk Email    → SPAM
 *   Archive       → Archive[Gmail]  (custom Gmail label)
 *   Custom folder → custom Gmail label with same name
 */

const { BaseAgent }      = require('../core/BaseAgent');
const outlookClient      = require('../../clients/outlookClient');
const gmailClient        = require('../../clients/gmailClient');
const calendarClient     = require('../../clients/calendarClient');
const ValidationResult   = require('../../models/ValidationResult');
const logger             = require('../../utils/logger');
const { findDestCustomFolder } = require('../../utils/gmailOutlookLabelMatch');

// Outlook well-known display name → Gmail label ID
const OUTLOOK_TO_GMAIL_LABEL = {
  'Inbox':         'INBOX',
  'Sent Items':    'SENT',
  'Drafts':        'DRAFT',
  'Deleted Items': 'TRASH',
  'Junk Email':    'SPAM',
};

// Gmail label IDs that map back to Outlook default folders (for comparison)
const GMAIL_SYSTEM_LABELS = new Set(['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM']);

// Outlook Archive → Gmail "Archive[Gmail]" label (special built-in Gmail label)
const OUTLOOK_ARCHIVE_GMAIL_LABEL = 'Archive[Gmail]';

// Outlook default folder display names (skip from custom folder comparison)
const OUTLOOK_DEFAULT_DISPLAY = new Set([
  'Inbox', 'Sent Items', 'Drafts', 'Deleted Items', 'Junk Email',
  'Archive', 'Outbox', 'Conversation History', 'Search Folders', 'Clutter',
  'RSS Feeds', 'Sync Issues', 'Recoverable Items',
]);

class GmailValidationAgent extends BaseAgent {
  constructor() {
    super('GmailValidationAgent');
  }

  async execute(context) {
    const log        = logger.child({ agent: this.name, executionId: context.executionId });
    const result     = new ValidationResult();
    const sourceUser = context.sourceEmail;      // Outlook
    const destUser   = context.destinationEmail; // Gmail (migrationn.com)
    const testType   = (context.testType || 'E2E').toUpperCase();

    log.info(`Validating Outlook→Gmail [${testType}]: ${sourceUser} → ${destUser}`);

    // ── 1. Source Outlook data ─────────────────────────────────────────────
    await this._fetchSourceOutlookData(sourceUser, result, log);

    // ── 2. Destination Gmail data ──────────────────────────────────────────
    await this._fetchDestinationGmailData(destUser, result, log);

    // ── 3. Mail validation ─────────────────────────────────────────────────
    if (context.includeMail !== false) {
      this._compareMailCounts(result, log);
    }

    // ── 4. Calendar (E2E and DELTA) ───────────────────────────────────────
    if (context.includeCalendar && (testType === 'E2E' || testType === 'DELTA')) {
      await this._validateCalendar(sourceUser, destUser, result, log);
    }

    // ── 5. Contacts (DELTA only — not migrated in One Time) ───────────────
    if (context.includeContacts) {
      try {
        const srcResult = await outlookClient.getContactsWithDetails(sourceUser);
        const dstResult = await gmailClient.getGmailContactsWithDetails(destUser);

        const srcContacts = srcResult.contacts || [];
        const dstContacts = dstResult.contacts || [];

        result.contactsValidation.sourceCount      = srcContacts.length;
        result.contactsValidation.destinationCount = dstContacts.length;
        result.contactsValidation.available        = srcResult.available || dstResult.available;
        result.contactsValidation.countMatch       = srcContacts.length === dstContacts.length;

        // Field-level comparison — match QA contacts by normalised displayName
        const fieldMismatches = [];
        const photoMismatches = [];
        const dstMap = new Map(
          dstContacts
            .filter(c => c.displayName)
            .map(c => [c.displayName.toLowerCase().trim(), c])
        );

        for (const src of srcContacts) {
          if (!src.displayName) continue;
          const key = src.displayName.toLowerCase().trim();
          const dst = dstMap.get(key);
          if (!dst) continue; // unmatched contacts reported by count mismatch

          // Email address check (first email)
          const srcEmail = (src.emailAddresses?.[0]?.address || '').toLowerCase();
          const dstEmail = (dst.emailAddresses?.[0] || '').toLowerCase();
          if (srcEmail && dstEmail && srcEmail !== dstEmail) {
            fieldMismatches.push({ contact: src.displayName, field: 'emailAddress', source: srcEmail, destination: dstEmail });
          }

          // Phone number check (first business phone)
          const srcPhone = (src.businessPhones?.[0] || '').replace(/\s/g, '');
          const dstPhone = (dst.phoneNumbers?.[0] || '').replace(/\s/g, '');
          if (srcPhone && dstPhone && srcPhone !== dstPhone) {
            fieldMismatches.push({ contact: src.displayName, field: 'phone', source: srcPhone, destination: dstPhone });
          }

          // Photo check
          const srcHasPhoto = Boolean(src._hasPhoto);
          const dstHasPhoto = Boolean(dst.hasPhoto);
          if (srcHasPhoto && !dstHasPhoto) {
            photoMismatches.push({ contact: src.displayName, note: 'Photo present in Outlook but not found in Google Contacts' });
          }
        }

        result.contactsValidation.fieldMismatches = fieldMismatches;
        result.contactsValidation.photoMismatches = photoMismatches;

        log.info(
          `Contacts: src=${srcContacts.length} dst=${dstContacts.length} ` +
          `fieldMismatches=${fieldMismatches.length} photoMismatches=${photoMismatches.length}` +
          (srcResult.note ? ` [src: ${srcResult.note}]` : '') +
          (dstResult.note ? ` [dst: ${dstResult.note}]` : '')
        );
      } catch (err) {
        log.warn(`Contacts validation failed: ${err.message}`);
      }
    }

    // ── 5b. Inbox Rules Advisory ──────────────────────────────────────────────
    // Outlook inbox rules are NOT migrated as Gmail filters by CloudFuze.
    // This block detects rules and adds an advisory note to the result.
    try {
      const rulesResult = await outlookClient.getInboxRules(sourceUser);
      const rules = rulesResult.rules || [];
      result.rulesAdvisory = {
        available: rulesResult.available,
        count: rules.length,
        names: rules.map(r => r.displayName || r.name || '(unnamed)').slice(0, 20),
        note: rules.length > 0
          ? `${rules.length} Outlook inbox rule(s) detected. CloudFuze does not migrate Outlook inbox rules as Gmail filters — manual recreation in Gmail Filters is required.`
          : 'No Outlook inbox rules detected.',
      };
      if (rules.length > 0) {
        log.warn(`Inbox rules: ${rules.length} rule(s) found — not migrated as Gmail filters`);
      }
    } catch (err) {
      log.warn(`Inbox rules advisory failed: ${err.message}`);
      result.rulesAdvisory = { available: false, count: 0, note: `Rules check failed: ${err.message}` };
    }

    // ── 6. Groups (DELTA + E2E only — not migrated in One Time) ───────────
    if (context.includeContacts && testType === 'E2E') {
      await this._validateGroups(sourceUser, destUser, result, log);
    }

    // ── 7. Mailbox size comparison ────────────────────────────────────────
    try {
      const { buildMailboxSizeValidation } = require('../../utils/mailMigrationComparator');
      const [srcSize, dstSize] = await Promise.all([
        outlookClient.getMailboxSizeBytes(sourceUser),
        gmailClient.getGmailMailboxSizeBytes(destUser),
      ]);
      result.mailboxSizeValidation = buildMailboxSizeValidation(srcSize, dstSize, 'outlook_to_gmail');
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

  // ── Source: Outlook folders ────────────────────────────────────────────────

  async _fetchSourceOutlookData(sourceUser, result, log) {
    log.info(`Fetching source Outlook data for: ${sourceUser}`);
    try {
      const folders  = await outlookClient.getMailFolders(sourceUser);
      result.sourceData.defaultLabels = [];
      result.sourceData.customLabels  = [];
      this._walkOutlookSourceFolders(folders, '', result.sourceData.defaultLabels, result.sourceData.customLabels, log);

      const total = result.sourceData.defaultLabels.reduce((s, l) => s + l.messageCount, 0)
                  + result.sourceData.customLabels.reduce((s, l) => s + l.messageCount, 0);
      result.mailValidation.sourceCount = total;
      log.info(
        `Source Outlook: ${result.sourceData.defaultLabels.length} default, ` +
        `${result.sourceData.customLabels.length} custom, total ${total} messages`
      );
    } catch (err) {
      log.error(`Failed to fetch source Outlook data: ${err.message}`);
      // Mark source as unavailable so _compareMailCounts can distinguish a real 0-item
      // source from a Graph API failure (which would otherwise make everything look like surplus)
      result.sourceData.unavailable = true;
      result.sourceData.unavailableReason = err.message;
    }
  }

  _walkOutlookSourceFolders(folders, parentPath, defaultLabels, customLabels, log) {
    if (!folders?.length) return;
    for (const folder of folders) {
      const segment  = (folder.displayName || '').trim();
      const fullPath = parentPath ? `${parentPath}/${segment}` : segment;
      const count    = folder.totalItemCount || 0;

      if (OUTLOOK_TO_GMAIL_LABEL[segment]) {
        // Map to Gmail label ID for comparison
        const gmailId = OUTLOOK_TO_GMAIL_LABEL[segment];
        defaultLabels.push({ id: gmailId, name: segment, messageCount: count });
      } else if (segment === 'Archive') {
        // Archive maps to Archive[Gmail] custom label
        defaultLabels.push({ id: OUTLOOK_ARCHIVE_GMAIL_LABEL, name: 'Archive', messageCount: count });
      } else if (!OUTLOOK_DEFAULT_DISPLAY.has(segment) && segment) {
        customLabels.push({ id: fullPath, name: fullPath, messageCount: count });
      }

      if (folder.childFolders?.length) {
        this._walkOutlookSourceFolders(folder.childFolders, fullPath, defaultLabels, customLabels, log);
      }
    }
  }

  // ── Destination: Gmail labels ──────────────────────────────────────────────

  async _fetchDestinationGmailData(destUser, result, log) {
    log.info(`Fetching destination Gmail data for: ${destUser}`);
    try {
      const labels = await gmailClient.listLabels(destUser, 'me');
      result.destinationData.defaultFolders = [];
      result.destinationData.customFolders  = [];

      for (const label of labels) {
        let count = 0;
        try {
          count = await gmailClient.getMessageCount(destUser, 'me', label.id);
        } catch { /* best-effort */ }

        const labelNameLower = (label.name || '').toLowerCase();
        if (GMAIL_SYSTEM_LABELS.has(label.id)) {
          result.destinationData.defaultFolders.push({ name: label.id, messageCount: count });
        } else if (
          label.id?.toLowerCase() === 'archive[gmail]' ||
          labelNameLower === 'archive[gmail]' ||
          labelNameLower === 'archive'
        ) {
          // CloudFuze creates "Archive[GMAIL]" (uppercase) — match case-insensitively
          result.destinationData.defaultFolders.push({ name: OUTLOOK_ARCHIVE_GMAIL_LABEL, messageCount: count });
        } else if (label.type !== 'system') {
          result.destinationData.customFolders.push({ name: label.name, messageCount: count });
        }
      }

      // Total mailbox message count (deduplicated via getProfile)
      try {
        const stats = await gmailClient.getGmailMailboxStats(destUser);
        result.mailValidation.destinationCount = Number(stats?.mailCount ?? stats?.totalMessages) || 0;
        if (stats && typeof stats.calendarCount === 'number') {
          result.calendarValidation.destinationCalendarCount = stats.calendarCount;
        }
      } catch (e) {
        log.warn(`Gmail getProfile failed; summing default labels: ${e.message}`);
        result.mailValidation.destinationCount = result.destinationData.defaultFolders
          .reduce((s, f) => s + f.messageCount, 0);
      }

      // If no explicit Archive label was found (CloudFuze migrates Outlook Archive to All Mail
      // without a specific label), derive the count as total minus system-folder sum so the
      // Archive → Archive[Gmail] comparison row shows Match instead of NOT_FOUND.
      if (!result.destinationData.defaultFolders.some(f => f.name === OUTLOOK_ARCHIVE_GMAIL_LABEL)) {
        // First check custom labels for any archive-named label (case-insensitive)
        const archiveCustomIdx = result.destinationData.customFolders.findIndex(
          f => /^archive$/i.test(f.name)
        );
        if (archiveCustomIdx >= 0) {
          const archiveLabel = result.destinationData.customFolders.splice(archiveCustomIdx, 1)[0];
          result.destinationData.defaultFolders.push({ name: OUTLOOK_ARCHIVE_GMAIL_LABEL, messageCount: archiveLabel.messageCount });
        } else {
          // Fall back: messages in All Mail but not in any system folder = archived
          const systemFolderSum = result.destinationData.defaultFolders.reduce((sum, f) => sum + (f.messageCount || 0), 0);
          const archiveCount = Math.max(0, result.mailValidation.destinationCount - systemFolderSum);
          log.warn(
            `Archive[Gmail] label not found in destination — using derived count ` +
            `(total ${result.mailValidation.destinationCount} - system sum ${systemFolderSum} = ${archiveCount}); ` +
            `archive comparison may be inaccurate if non-archive messages are in All Mail`
          );
          result.destinationData.defaultFolders.push({ name: OUTLOOK_ARCHIVE_GMAIL_LABEL, messageCount: archiveCount });
        }
      }

      log.info(
        `Dest Gmail: ${result.destinationData.defaultFolders.length} default, ` +
        `${result.destinationData.customFolders.length} custom, total ${result.mailValidation.destinationCount} messages`
      );
    } catch (err) {
      log.error(`Failed to fetch destination Gmail data: ${err.message}`);
    }
  }

  // ── Mail count comparison ──────────────────────────────────────────────────

  _compareMailCounts(result, log) {
    log.info('Comparing Outlook folder counts → Gmail label counts…');

    if (result.sourceData.unavailable) {
      log.error(
        `Source Outlook data unavailable (${result.sourceData.unavailableReason}) — ` +
        `skipping count comparison to avoid false mismatches`
      );
      result.addComparisonIssue('default', 'SOURCE_DATA_UNAVAILABLE', 0, result.sourceData.unavailableReason);
      return;
    }

    // Default folders (INBOX, SENT, DRAFT, TRASH, SPAM, Archive[Gmail])
    for (const srcLabel of result.sourceData.defaultLabels) {
      const destFolder = result.destinationData.defaultFolders.find(
        (f) => f.name === srcLabel.id
      );
      const srcCount  = srcLabel.messageCount || 0;
      const destCount = destFolder?.messageCount || 0;

      if (!destFolder) {
        result.addComparisonIssue('default', `${srcLabel.name} → ${srcLabel.id}`, srcCount, 'NOT_FOUND');
      } else if (srcCount !== destCount) {
        // TRASH: Gmail Trash accumulates deleted messages from ALL previous test runs.
        // If destination has MORE than source, this is expected cross-run accumulation — skip.
        if (srcLabel.id === 'TRASH' && destCount > srcCount) {
          log.info(
            `TRASH count: source=${srcCount}, dest=${destCount}, excess=${destCount - srcCount} — ` +
            `destination has accumulated extra deleted messages from previous runs (expected); skipping count check`
          );
        } else {
          result.addComparisonIssue('default', `${srcLabel.name} → ${srcLabel.id}`, srcCount, destCount);
        }
      }
    }

    // Custom folders → custom Gmail labels
    for (const srcLabel of result.sourceData.customLabels) {
      const destFolder = findDestCustomFolder(result.destinationData.customFolders, srcLabel.name);
      const srcCount  = srcLabel.messageCount || 0;
      const destCount = destFolder?.messageCount || 0;

      if (!destFolder) {
        result.addComparisonIssue('custom', srcLabel.name, srcCount, 'NOT_FOUND');
      } else if (srcCount !== destCount) {
        result.addComparisonIssue('custom', srcLabel.name, srcCount, destCount);
      }
    }

    // Overall totals
    result.mailValidation.countMatch =
      result.mailValidation.sourceCount === result.mailValidation.destinationCount;

    result.comparison.defaultLabelsMatch = !result.comparison.issues.some((i) => i.type === 'default');
    result.comparison.customLabelsMatch  = !result.comparison.issues.some((i) => i.type === 'custom');

    log.info(
      `Mail comparison: ${result.comparison.issues.length} issue(s) ` +
      `(default match: ${result.comparison.defaultLabelsMatch}, custom match: ${result.comparison.customLabelsMatch})`
    );
  }

  // ── Calendar validation ────────────────────────────────────────────────────

  async _validateCalendar(sourceUser, destUser, result, log) {
    log.info('E2E: Validating calendar (Outlook→Gmail)…');
    try {
      // Source: Outlook calendars + events
      let sourceTotal = 0;
      try {
        const srcCals = await outlookClient.getCalendars(sourceUser);
        result.calendarValidation.sourceCalendarCount = srcCals.length;
        for (const cal of srcCals) {
          const events = await outlookClient.getEvents(sourceUser, cal.id);
          sourceTotal += events.length;
          log.info(`  Source calendar "${cal.name}": ${events.length} events`);
        }
        result.calendarValidation.sourceEventCount = sourceTotal;
        log.info(`  Source Outlook total: ${sourceTotal} events`);
      } catch (srcErr) {
        log.warn(`Could not count source Outlook calendar events: ${srcErr.message}`);
      }

      // Destination: Google Calendar
      let destTotal = 0;
      try {
        const destCals = await calendarClient.listCalendars(destUser);
        result.calendarValidation.destinationCalendarCount = destCals.length;
        for (const cal of destCals) {
          if (!cal.id) continue;
          const items = await calendarClient.listEvents(destUser, cal.id, 250);
          destTotal += items.length;
          if (items.length > 0) {
            for (const ev of items) {
              result.calendarValidation.eventDetails.push({
                subject:         ev.summary || ev.title || '(no title)',
                calendarName:    cal.summary || cal.id,
                isRecurring:     !!(ev.recurrence || ev.recurringEventId),
                isAllDay:        !!(ev.start && !ev.start.dateTime),
                start:           ev.start,
                end:             ev.end,
                attachmentCount: (ev.attachments || []).length,
                attendeeCount:   (ev.attendees   || []).length,
              });
              if (ev.recurrence) {
                result.calendarValidation.recurringEvents.push({
                  subject:            ev.summary || '(no title)',
                  recurrencePattern:  (ev.recurrence || []).join('; '),
                });
              }
            }
            log.info(`  Dest calendar "${cal.summary || cal.id}": ${items.length} events`);
          }
        }
        result.calendarValidation.destinationEventCount = destTotal;
        log.info(`  Dest Gmail total: ${destTotal} events`);
      } catch (dstErr) {
        log.warn(`Could not count destination Gmail calendar events: ${dstErr.message}`);
      }

      result.calendarValidation.countMatch =
        result.calendarValidation.sourceEventCount === result.calendarValidation.destinationEventCount;

      // Attachment validation — check that events with attachments in source also have attachments in dest
      try {
        const srcCals = await outlookClient.getCalendars(sourceUser);
        for (const cal of srcCals) {
          const srcEvs = await outlookClient.getEvents(sourceUser, cal.id);
          for (const srcEv of srcEvs) {
            if (!srcEv.hasAttachments) continue;
            // find matching dest event by subject
            const destEv = result.calendarValidation.eventDetails.find(
              d => (d.subject || '').toLowerCase() === (srcEv.subject || '').toLowerCase()
            );
            if (!destEv) continue;
            if (destEv.attachmentCount === 0) {
              result.calendarValidation.attachmentMismatches = result.calendarValidation.attachmentMismatches || [];
              result.calendarValidation.attachmentMismatches.push({
                subject: srcEv.subject,
                note: 'Outlook event has attachments but no attachments found on Google Calendar event',
              });
            }
          }
        }
      } catch (attErr) {
        log.warn(`Calendar attachment check failed: ${attErr.message}`);
      }

      if (!result.calendarValidation.countMatch) {
        result.addMismatch(
          'calendar', 'eventCount',
          result.calendarValidation.sourceEventCount,
          result.calendarValidation.destinationEventCount
        );
      }
    } catch (err) {
      log.error(`Calendar validation failed: ${err.message}`);
      result.addMismatch('calendar', 'overall', 'accessible', err.message);
    }
  }

  // ── Groups validation ──────────────────────────────────────────────────────

  async _validateGroups(sourceUser, destUser, result, log) {
    log.info('E2E: Validating groups (Outlook M365 → Gmail Workspace)…');
    try {
      const srcGroups = await outlookClient.getGroupsCount(sourceUser);
      const dstGroups = await gmailClient.getGoogleGroupsCount(destUser);

      const srcCount = Number(srcGroups?.count) || 0;
      const dstCount = Number(dstGroups?.count) || 0;

      log.info(
        `Groups: source (Outlook M365)=${srcCount} dest (Gmail Workspace)=${dstCount}` +
        (srcGroups?.note ? ` [src: ${srcGroups.note}]` : '') +
        (dstGroups?.note ? ` [dst: ${dstGroups.note}]` : '')
      );

      if (srcCount !== dstCount) {
        result.addMismatch('other', 'groupsCount', srcCount, dstCount);
      }
    } catch (err) {
      log.warn(`Groups validation failed: ${err.message}`);
    }
  }
}

module.exports = GmailValidationAgent;
