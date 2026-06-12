/**
 * GmailToGmailValidationAgent
 *
 * Validates a destination Gmail mailbox after a Gmail→Gmail migration.
 * Both source and destination are Google Workspace / Gmail accounts.
 *
 * Validation scope:
 *   - Mail:      Source Gmail label counts → Destination Gmail label counts
 *   - Calendar:  Source Google Calendar event count → Destination Google Calendar event count
 *   - Contacts:  Source Google Contacts count → Destination Google Contacts count
 *   - Groups:    Source Google Workspace groups count → Destination Google Workspace groups count
 *
 * Gmail→Gmail label mapping (system labels preserved 1-to-1):
 *   INBOX  → INBOX
 *   SENT   → SENT
 *   DRAFT  → DRAFT
 *   TRASH  → TRASH
 *   SPAM   → SPAM
 *   Custom labels → same-name Gmail labels on destination
 */

const { BaseAgent }    = require('../core/BaseAgent');
const agentBrain       = require('../../ai/agentBrain');
const gmailClient      = require('../../clients/gmailClient');
const { classifyMismatches, getCombination } = require('../../clients/cloudfuzeDocsClient');
const calendarClient   = require('../../clients/calendarClient');
const migrationClient  = require('../../clients/migrationClient');
const ValidationResult = require('../../models/ValidationResult');
const logger           = require('../../utils/logger');
const { findDestCustomFolder } = require('../../utils/gmailOutlookLabelMatch');
const { parseRecipientEmails, buildMailboxSizeValidation } = require('../../utils/mailMigrationComparator');

// Gmail system label IDs that map 1-to-1 between source and destination
const GMAIL_SYSTEM_LABELS = new Set([
  'INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM',
]);

// Labels that overlap / don't represent unique message counts — skip in totals
const GMAIL_SKIP_LABEL_IDS = new Set([
  'STARRED', 'IMPORTANT', 'UNREAD', 'CHAT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
]);

class GmailToGmailValidationAgent extends BaseAgent {
  constructor() {
    super('GmailToGmailValidationAgent');
  }

  async execute(context) {
    const log        = logger.child({ agent: this.name, executionId: context.executionId });
    const result     = new ValidationResult();
    const sourceUser = context.sourceEmail;      // Source Gmail
    const destUser   = context.destinationEmail; // Destination Gmail
    const testType   = (context.testType || 'E2E').toUpperCase();

    log.info(`Validating Gmail→Gmail [${testType}]: ${sourceUser} → ${destUser}`);
    const _startTime = new Date();

    // Fetch CloudFuze migration job status for PDF report
    if (!context.migrationJobDetails) {
      try {
        const jobStatus = await migrationClient.fetchCurrentJobStatus(sourceUser);
        if (jobStatus) {
          context.migrationJobDetails = jobStatus;
          log.info(`CloudFuze job status fetched: workspaceId=${jobStatus.workspaceId} status=${jobStatus.cfStatus} ${jobStatus.processedCount}/${jobStatus.totalCount}`);
        }
      } catch (e) {
        log.warn(`CloudFuze job status fetch failed (non-fatal): ${e.message}`);
      }
    }

    // ── 1. Source Gmail data ───────────────────────────────────────────────────
    await this._fetchSourceData(sourceUser, result, log);

    // ── 2. Destination Gmail data ──────────────────────────────────────────────
    await this._fetchDestinationGmailData(destUser, result, log);

    // ── 3. Mail validation ─────────────────────────────────────────────────────
    if (context.includeMail !== false) {
      this._compareMailCounts(result, log);
    }

    // ── 3b. STARRED label comparison (G→G inscope) ────────────────────────────
    // Explicitly compare the STARRED label count between source and destination.
    // STARRED is intentionally excluded from _compareMailCounts to avoid double-counting
    // (it overlaps with INBOX/SENT), but it IS inscoped and should transfer 1-to-1.
    if (context.includeMail !== false) {
      try {
        const [srcStarredCount, dstStarredCount] = await Promise.all([
          gmailClient.getMessageCount(sourceUser, 'me', 'STARRED').catch(() => null),
          gmailClient.getMessageCount(destUser, 'me', 'STARRED').catch(() => null),
        ]);
        if (srcStarredCount !== null && dstStarredCount !== null) {
          result.starredValidation = {
            available: true,
            sourceCount: srcStarredCount,
            destinationCount: dstStarredCount,
            countMatch: srcStarredCount === dstStarredCount,
          };
          if (srcStarredCount !== dstStarredCount) {
            log.warn(`STARRED count mismatch: source=${srcStarredCount} dest=${dstStarredCount}`);
            result.addMismatch('mail', 'starredCount', srcStarredCount, dstStarredCount, { severity: 'warning' });
          } else {
            log.info(`STARRED count: source=${srcStarredCount} dest=${dstStarredCount} (match)`);
          }
        } else {
          result.starredValidation = { available: false, note: 'Could not retrieve STARRED label count' };
          log.info('STARRED validation: skipped (STARRED label count unavailable)');
        }
      } catch (starErr) {
        log.warn(`STARRED validation failed (non-fatal): ${starErr.message}`);
        result.starredValidation = { available: false, note: starErr.message };
      }
    }

    // ── 4. Calendar (E2E and DELTA) ─────────────────────────────────────────────
    if (context.includeCalendar && (testType === 'E2E' || testType === 'DELTA')) {
      await this._validateCalendar(sourceUser, destUser, result, log);
    }

    // ── 4b. Group calendars (G→G inscope) ────────────────────────────────────────
    // Compare the count of shared/group calendars between source and destination.
    // Best-effort: list calendars from both sides and count non-primary calendars.
    if (context.includeCalendar && (testType === 'E2E' || testType === 'DELTA')) {
      try {
        const [srcCals, dstCals] = await Promise.all([
          calendarClient.listCalendars(sourceUser).catch(() => null),
          calendarClient.listCalendars(destUser).catch(() => null),
        ]);
        if (srcCals !== null && dstCals !== null) {
          // Non-primary calendars are considered shared/group calendars
          const srcGroupCals = srcCals.filter(c => c.accessRole !== 'owner' || (c.id && c.id !== sourceUser));
          const dstGroupCals = dstCals.filter(c => c.accessRole !== 'owner' || (c.id && c.id !== destUser));
          result.groupCalendarValidation = {
            available: true,
            sourceGroupCalendarCount: srcGroupCals.length,
            destinationGroupCalendarCount: dstGroupCals.length,
            countMatch: srcGroupCals.length === dstGroupCals.length,
            sourceCalendarNames: srcGroupCals.map(c => c.summary || c.id),
            destinationCalendarNames: dstGroupCals.map(c => c.summary || c.id),
          };
          if (srcGroupCals.length !== dstGroupCals.length) {
            log.warn(`Group calendars: source=${srcGroupCals.length} dest=${dstGroupCals.length}`);
            result.addMismatch('calendar', 'groupCalendarCount', srcGroupCals.length, dstGroupCals.length, { severity: 'warning' });
          } else {
            log.info(`Group calendars: source=${srcGroupCals.length} dest=${dstGroupCals.length} (match)`);
          }
        } else {
          result.groupCalendarValidation = { available: false, note: 'Could not list calendars for group calendar comparison' };
          log.info('Group calendar validation: skipped (calendar listing unavailable)');
        }
      } catch (gcErr) {
        log.warn(`Group calendar validation failed (non-fatal): ${gcErr.message}`);
        result.groupCalendarValidation = { available: false, note: gcErr.message };
      }
    }

    // ── 5. Contacts ─────────────────────────────────────────────────────────────
    if (context.includeContacts) {
      await this._validateContacts(sourceUser, destUser, result, log);
    }

    // ── 5b. Gmail filter advisory (source filters → destination filters) ────────
    if (context.includeMail !== false) {
      await this._validateGmailFiltersAdvisory(sourceUser, destUser, result, log);
    }

    // ── 5c. Draft comparison ─────────────────────────────────────────────────────
    if (context.includeMail !== false) {
      await this._validateDrafts(sourceUser, destUser, result, log);
    }

    // ── 6. Groups (E2E or FULL) ──────────────────────────────────────────────────
    if (context.includeContacts && (testType === 'E2E' || testType === 'FULL')) {
      await this._validateGroups(sourceUser, destUser, result, log);
    }

    // ── 7. Mailbox size comparison ───────────────────────────────────────────────
    try {
      const [srcSize, dstSize] = await Promise.all([
        gmailClient.getGmailMailboxSizeBytes(sourceUser),
        gmailClient.getGmailMailboxSizeBytes(destUser),
      ]);
      result.mailboxSizeValidation = buildMailboxSizeValidation(srcSize, dstSize, 'gmail_to_gmail');
      log.info(
        `Mailbox size: src=${result.mailboxSizeValidation.sourceSizeHuman} ` +
        `dst=${result.mailboxSizeValidation.destSizeHuman} ` +
        `ratio=${result.mailboxSizeValidation.sizeRatio?.toFixed(2)} [${result.mailboxSizeValidation.severity}]`
      );
    } catch (err) {
      log.warn(`Mailbox size validation failed: ${err.message}`);
      result.mailboxSizeValidation = { available: false, error: err.message };
    }

    // ── 8. Deep mail validation ──────────────────────────────────────────────────
    if (context.includeMail) {
      const { runDeepMailValidation } = require('../../validation/deepMailValidator');
      await runDeepMailValidation(context, result, log);
    }

    result.computeOverallStatus();

    // Classify each mismatch via CloudFuze docs API
    try {
      const combination = getCombination('google', 'google');
      result.mismatches = await classifyMismatches(result.mismatches, combination);
      const bugCount   = result.mismatches.filter((m) => m.bugStatus === 'bug' || m.bugStatus === 'unknown').length;
      const limitCount = result.mismatches.filter((m) => m.bugStatus === 'known_limitation').length;
      log.info(`Mismatch classification [${combination}]: ${bugCount} bug(s), ${limitCount} known limitation(s)`);
    } catch (err) {
      log.warn(`Mismatch classification failed (non-fatal): ${err.message}`);
    }

    log.info(`Validation complete [${testType}]: ${result.overallStatus} (${result.mismatches.length} mismatches)`);

    if (result.mismatches.length > 0) {
      try {
        const slim = {
          overallStatus: result.overallStatus,
          mismatches: result.mismatches,
          mailValidation: {
            sourceCount: result.mailValidation.sourceCount,
            destinationCount: result.mailValidation.destinationCount,
          },
          comparison: result.comparison,
          migrationJobDetails: context.migrationJobDetails || null,
        };
        const aiContext = {
          testType,
          direction: 'gmail_to_gmail',
          sourceProvider: 'google',
          destinationProvider: 'google',
          sourceEmail: context.sourceEmail,
          destinationEmail: context.destinationEmail,
          migrationJobDetails: context.migrationJobDetails || null,
        };
        const topMismatches = result.mismatches.slice(0, 5);
        const [analysis, ...fixes] = await Promise.all([
          agentBrain.analyzeMigrationLogs(slim, aiContext, context.executionId, _startTime, new Date()),
          ...topMismatches.map(m => agentBrain.suggestFix(m)),
        ]);
        result.aiAnalysis = analysis;
        topMismatches.forEach((m, i) => { m.fixSuggestion = fixes[i]; });
        log.info(`AI analysis: ${analysis.rootCause} | faultSource=${analysis.faultSource} [confidence=${analysis.confidence}]`);
      } catch (err) {
        log.warn(`AI analysis failed (non-fatal): ${err.message}`);
      }
    }

    return result.toJSON();
  }

  // ── Source: Gmail labels and counts ───────────────────────────────────────────

  async _fetchSourceData(sourceUser, result, log) {
    log.info(`Fetching source Gmail data for: ${sourceUser}`);
    try {
      const labels = await gmailClient.listLabels(sourceUser, 'me');

      result.sourceData.defaultLabels = [];
      result.sourceData.customLabels  = [];

      for (const label of labels) {
        if (GMAIL_SKIP_LABEL_IDS.has(label.id)) continue;

        let count = 0;
        try {
          count = await gmailClient.getMessageCount(sourceUser, 'me', label.id);
        } catch { /* best-effort */ }

        const entry = { name: label.name, id: label.id, messageCount: count };

        if (GMAIL_SYSTEM_LABELS.has(label.id)) {
          result.sourceData.defaultLabels.push(entry);
        } else if (label.type === 'system') {
          // Other system labels (not mapped 1-to-1): skip from comparison
        } else {
          result.sourceData.customLabels.push(entry);
        }
      }

      // Use getProfile for accurate total (avoids double-counting with overlapping labels)
      try {
        const stats = await gmailClient.getGmailMailboxStats(sourceUser);
        result.mailValidation.sourceCount = Number(stats?.mailCount ?? stats?.totalMessages) || 0;
        if (stats && typeof stats.calendarCount === 'number') {
          result.calendarValidation.sourceCalendarCount = stats.calendarCount;
        }
      } catch (statsErr) {
        log.warn(`Source Gmail getProfile failed; summing system labels: ${statsErr.message}`);
        result.mailValidation.sourceCount = result.sourceData.defaultLabels
          .filter(l => GMAIL_SYSTEM_LABELS.has(l.id))
          .reduce((s, l) => s + l.messageCount, 0);
      }

      log.info(
        `Source Gmail: ${result.sourceData.defaultLabels.length} default, ` +
        `${result.sourceData.customLabels.length} custom, total ${result.mailValidation.sourceCount} messages`
      );
    } catch (err) {
      log.error(`Failed to fetch source Gmail data: ${err.message}`);
      result.sourceData.unavailable = true;
      result.sourceData.unavailableReason = err.message;
    }
  }

  // ── Destination: Gmail labels and counts ──────────────────────────────────────

  async _fetchDestinationGmailData(destUser, result, log) {
    log.info(`Fetching destination Gmail data for: ${destUser}`);
    try {
      const labels = await gmailClient.listLabels(destUser, 'me');
      result.destinationData.defaultFolders = [];
      result.destinationData.customFolders  = [];

      for (const label of labels) {
        if (GMAIL_SKIP_LABEL_IDS.has(label.id)) continue;

        let count = 0;
        try {
          count = await gmailClient.getMessageCount(destUser, 'me', label.id);
        } catch { /* best-effort */ }

        if (GMAIL_SYSTEM_LABELS.has(label.id)) {
          result.destinationData.defaultFolders.push({ name: label.id, messageCount: count });
        } else if (label.type === 'system') {
          // Skip other system labels not in the 1-to-1 mapping
        } else {
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
        log.warn(`Dest Gmail getProfile failed; summing system labels: ${e.message}`);
        result.mailValidation.destinationCount = result.destinationData.defaultFolders
          .reduce((s, f) => s + f.messageCount, 0);
      }

      log.info(
        `Dest Gmail: ${result.destinationData.defaultFolders.length} default, ` +
        `${result.destinationData.customFolders.length} custom, total ${result.mailValidation.destinationCount} messages`
      );
    } catch (err) {
      log.error(`Failed to fetch destination Gmail data: ${err.message}`);
    }
  }

  // ── Mail count comparison: source Gmail labels vs destination Gmail labels ─────

  _compareMailCounts(result, log) {
    log.info('Comparing source Gmail label counts → destination Gmail label counts…');

    if (result.sourceData.unavailable) {
      log.error(
        `Source Gmail data unavailable (${result.sourceData.unavailableReason}) — ` +
        `skipping count comparison to avoid false mismatches`
      );
      result.addComparisonIssue('default', 'SOURCE_DATA_UNAVAILABLE', 0, result.sourceData.unavailableReason);
      return;
    }

    // System labels: compare INBOX, SENT, DRAFT, TRASH, SPAM 1-to-1
    for (const srcLabel of result.sourceData.defaultLabels) {
      const destFolder = result.destinationData.defaultFolders.find(
        (f) => f.name === srcLabel.id
      );
      const srcCount  = srcLabel.messageCount || 0;
      const destCount = destFolder?.messageCount || 0;

      if (!destFolder) {
        result.addComparisonIssue('default', `${srcLabel.name} → ${srcLabel.id}`, srcCount, 'NOT_FOUND');
      } else if (srcCount !== destCount) {
        // TRASH: destination accumulates deleted messages from previous runs — skip if dest > src
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

    // Custom labels: compare by name (case-insensitive fuzzy match via findDestCustomFolder)
    for (const srcLabel of result.sourceData.customLabels) {
      const destFolder = findDestCustomFolder(result.destinationData.customFolders, srcLabel.name);
      const srcCount   = srcLabel.messageCount || 0;
      const destCount  = destFolder?.messageCount || 0;

      if (!destFolder) {
        result.addComparisonIssue('custom', srcLabel.name, srcCount, 'NOT_FOUND');
      } else if (srcCount !== destCount) {
        result.addComparisonIssue('custom', srcLabel.name, srcCount, destCount);
      }
    }

    result.mailValidation.countMatch =
      result.mailValidation.sourceCount === result.mailValidation.destinationCount;

    result.comparison.defaultLabelsMatch = !result.comparison.issues.some((i) => i.type === 'default');
    result.comparison.customLabelsMatch  = !result.comparison.issues.some((i) => i.type === 'custom');

    log.info(
      `Mail comparison: ${result.comparison.issues.length} issue(s) ` +
      `(default match: ${result.comparison.defaultLabelsMatch}, custom match: ${result.comparison.customLabelsMatch})`
    );
  }

  // ── Calendar validation: both source and destination are Google Calendar ────────

  async _validateCalendar(sourceUser, destUser, result, log) {
    log.info('E2E: Validating calendar (Gmail→Gmail)…');
    try {
      // Source: Google Calendar
      let sourceTotal = 0;
      try {
        const srcCals = await calendarClient.listCalendars(sourceUser);
        result.calendarValidation.sourceCalendarCount = srcCals.length;
        for (const cal of srcCals) {
          if (!cal.id) continue;
          const items = await calendarClient.listEvents(sourceUser, cal.id, 250);
          sourceTotal += items.length;
          log.info(`  Source calendar "${cal.summary || cal.id}": ${items.length} events`);
        }
        result.calendarValidation.sourceEventCount = sourceTotal;
        log.info(`  Source Gmail total: ${sourceTotal} events`);
      } catch (srcErr) {
        log.warn(`Could not count source Gmail calendar events: ${srcErr.message}`);
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
                  subject:           ev.summary || '(no title)',
                  recurrencePattern: (ev.recurrence || []).join('; '),
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

      // Per-event detail comparison: match source ↔ dest events by subject
      try {
        result.calendarValidation.eventDetailMismatches = [];
        const srcCals = await calendarClient.listCalendars(sourceUser);
        for (const cal of srcCals) {
          if (!cal.id) continue;
          const srcEvs = await calendarClient.listEvents(sourceUser, cal.id, 250);
          for (const srcEv of srcEvs) {
            const evSubjectLower = (srcEv.summary || '').toLowerCase().trim();
            const destEv = result.calendarValidation.eventDetails.find(
              (d) => (d.subject || '').toLowerCase().trim() === evSubjectLower
            );
            if (!destEv) {
              result.calendarValidation.eventDetailMismatches.push({
                subject: srcEv.summary || '(no subject)',
                issue: 'Event not found in destination Google Calendar by subject',
                severity: 'error',
              });
              continue;
            }
            // Attachment check
            if ((srcEv.attachments || []).length > 0 && destEv.attachmentCount === 0) {
              result.calendarValidation.attachmentMismatches.push({
                subject: srcEv.summary,
                note: 'Source event has attachments but none found on destination Google Calendar event',
              });
            }
            // Attendee count check
            const srcAttendeeCount = (srcEv.attendees || []).length;
            if (srcAttendeeCount > 0 && srcAttendeeCount !== destEv.attendeeCount) {
              result.calendarValidation.eventDetailMismatches.push({
                subject: srcEv.summary || '(no subject)',
                issue: `Attendee count differs: source=${srcAttendeeCount} dest=${destEv.attendeeCount}`,
                severity: 'warning',
              });
            }
            // All-day check
            const srcIsAllDay = !!(srcEv.start && !srcEv.start.dateTime);
            if (srcIsAllDay !== destEv.isAllDay) {
              result.calendarValidation.eventDetailMismatches.push({
                subject: srcEv.summary || '(no subject)',
                issue: `All-day status differs: source=${srcIsAllDay} dest=${destEv.isAllDay}`,
                severity: 'warning',
              });
            }
          }
        }
        if (result.calendarValidation.eventDetailMismatches.length > 0) {
          log.warn(`Calendar event detail mismatches: ${result.calendarValidation.eventDetailMismatches.length}`);
        }
      } catch (attErr) {
        log.warn(`Calendar detail check failed: ${attErr.message}`);
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

  // ── Contacts validation: source Gmail → destination Gmail ────────────────────

  async _validateContacts(sourceUser, destUser, result, log) {
    log.info('Validating contacts (Gmail→Gmail)…');
    try {
      const srcResult = await gmailClient.getGmailContactsWithDetails(sourceUser);
      const dstResult = await gmailClient.getGmailContactsWithDetails(destUser);

      const srcContacts = srcResult.contacts || [];
      const dstContacts = dstResult.contacts || [];

      result.contactsValidation.sourceCount      = srcContacts.length;
      result.contactsValidation.destinationCount = dstContacts.length;
      result.contactsValidation.available        = srcResult.available || dstResult.available;
      result.contactsValidation.countMatch       = srcContacts.length === dstContacts.length;

      // Field-level comparison — match contacts by normalized displayName
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
        if (!dst) continue; // unmatched — reported by count mismatch

        // Email addresses
        const srcEmails = (src.emailAddresses || []).map(e => String(e || '').toLowerCase()).filter(Boolean).sort();
        const dstEmails = (dst.emailAddresses || []).map(e => String(e || '').toLowerCase()).filter(Boolean).sort();
        if (srcEmails.length > 0 && dstEmails.length > 0 && srcEmails.join(',') !== dstEmails.join(',')) {
          fieldMismatches.push({ contact: src.displayName, field: 'emailAddresses', source: srcEmails.join(', '), destination: dstEmails.join(', ') });
        } else if (srcEmails.length > 0 && dstEmails.length === 0) {
          fieldMismatches.push({ contact: src.displayName, field: 'emailAddresses', source: srcEmails.join(', '), destination: '(none)' });
        }

        // Phone numbers
        const srcPhones = (src.phoneNumbers || []).map(p => p.replace(/\s/g, '')).sort();
        const dstPhones = (dst.phoneNumbers || []).map(p => p.replace(/\s/g, '')).sort();
        if (srcPhones.length > 0 && dstPhones.length > 0 && srcPhones.join(',') !== dstPhones.join(',')) {
          fieldMismatches.push({ contact: src.displayName, field: 'phoneNumbers', source: srcPhones.join(', '), destination: dstPhones.join(', ') });
        }

        // Organization
        const srcOrg = (src.organization || '').trim().toLowerCase();
        const dstOrg = (dst.organization || '').trim().toLowerCase();
        if (srcOrg && dstOrg && srcOrg !== dstOrg) {
          fieldMismatches.push({ contact: src.displayName, field: 'organization', source: src.organization, destination: dst.organization });
        }

        // Job title
        const srcTitle = (src.jobTitle || '').trim().toLowerCase();
        const dstTitle = (dst.jobTitle || '').trim().toLowerCase();
        if (srcTitle && dstTitle && srcTitle !== dstTitle) {
          fieldMismatches.push({ contact: src.displayName, field: 'jobTitle', source: src.jobTitle, destination: dst.jobTitle });
        }

        // Photo check
        const srcHasPhoto = Boolean(src.hasPhoto);
        const dstHasPhoto = Boolean(dst.hasPhoto);
        if (srcHasPhoto && !dstHasPhoto) {
          photoMismatches.push({ contact: src.displayName, note: 'Photo present in source Gmail but not found in destination Gmail Contacts' });
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

  // ── Gmail filter advisory: source filters vs destination filters ──────────────

  async _validateGmailFiltersAdvisory(sourceUser, destUser, result, log) {
    try {
      const [srcFiltersResult, dstFiltersResult] = await Promise.all([
        gmailClient.getGmailFilters(sourceUser).catch(() => ({ filters: [], available: false })),
        gmailClient.getGmailFilters(destUser).catch(() => ({ filters: [], available: false })),
      ]);
      const srcFilters = srcFiltersResult.filters || [];
      const dstFilters = dstFiltersResult.filters || [];

      result.rulesAdvisory = {
        available: srcFiltersResult.available,
        count: srcFilters.length,
        names: srcFilters.map(f => f.id || '(unnamed)').slice(0, 20),
        gmailFiltersCount: dstFilters.length,
        gmailFiltersAvailable: dstFiltersResult.available,
        note: srcFilters.length > 0
          ? `${srcFilters.length} Gmail filter(s) detected at source. CloudFuze may not migrate Gmail filters — verify manual recreation if needed. Destination currently has ${dstFilters.length} filter(s).`
          : `No Gmail filters detected at source. Destination has ${dstFilters.length} filter(s).`,
      };

      if (srcFilters.length > 0) {
        log.info(`Gmail filters advisory: source=${srcFilters.length}, dest=${dstFilters.length}`);
        if (srcFilters.length !== dstFilters.length) {
          result.addMismatch(
            'settings', 'gmailFiltersCount',
            srcFilters.length, dstFilters.length,
            { severity: 'warning', message: `Source has ${srcFilters.length} Gmail filter(s) but destination has ${dstFilters.length} — CloudFuze may not migrate Gmail filters.` }
          );
        }
      }
    } catch (err) {
      log.warn(`Gmail filters advisory failed: ${err.message}`);
      result.rulesAdvisory = { available: false, count: 0, note: `Filters check failed: ${err.message}` };
    }
  }

  // ── Draft comparison: source Gmail drafts vs destination Gmail drafts ─────────

  async _validateDrafts(sourceUser, destUser, result, log) {
    try {
      const [srcDraftsResult, dstDraftsResult] = await Promise.all([
        gmailClient.getGmailDraftDetails(sourceUser, 200),
        gmailClient.getGmailDraftDetails(destUser, 200),
      ]);
      const srcDrafts = srcDraftsResult.drafts || [];
      const dstDrafts = dstDraftsResult.drafts || [];

      result.draftComparison = {
        available: true,
        sourceCount: srcDrafts.length,
        destinationCount: dstDrafts.length,
        countMatch: srcDrafts.length === dstDrafts.length,
        subjectMismatches: [],
      };

      // Match drafts by normalized subject
      const normalizeS = (s) => String(s || '').toLowerCase().replace(/^re:|^fwd?:/i, '').replace(/\s+/g, ' ').trim();
      const dstDraftMap = new Map(dstDrafts.map(d => [normalizeS(d.subject), d]));

      for (const sd of srcDrafts) {
        const nk = normalizeS(sd.subject);
        const dd = dstDraftMap.get(nk);
        if (!dd) {
          result.draftComparison.subjectMismatches.push({
            subject: sd.subject || '(no subject)',
            issue: 'Draft not found in destination Gmail by subject',
          });
          continue;
        }
        // Compare recipients
        const srcTo = parseRecipientEmails(sd.to).join(',');
        const dstTo = parseRecipientEmails(dd.to).join(',');
        if (srcTo && dstTo && srcTo !== dstTo) {
          result.draftComparison.subjectMismatches.push({
            subject: sd.subject || '(no subject)',
            issue: `To recipients differ: source=[${srcTo}] dest=[${dstTo}]`,
          });
        }
        const srcCc = parseRecipientEmails(sd.cc).join(',');
        const dstCc = parseRecipientEmails(dd.cc).join(',');
        if (srcCc && dstCc && srcCc !== dstCc) {
          result.draftComparison.subjectMismatches.push({
            subject: sd.subject || '(no subject)',
            issue: `CC recipients differ: source=[${srcCc}] dest=[${dstCc}]`,
          });
        }
      }

      log.info(
        `Draft comparison: src=${srcDrafts.length} dst=${dstDrafts.length} ` +
        `mismatches=${result.draftComparison.subjectMismatches.length}`
      );

      if (!result.draftComparison.countMatch) {
        result.addMismatch('mail', 'draftCount', srcDrafts.length, dstDrafts.length);
      }
    } catch (err) {
      log.warn(`Draft comparison failed: ${err.message}`);
    }
  }

  // ── Groups validation: source Google Workspace groups → destination ────────────

  async _validateGroups(sourceUser, destUser, result, log) {
    log.info('E2E: Validating Google Workspace groups (Gmail→Gmail)…');
    try {
      const [srcGroups, dstGroups] = await Promise.all([
        gmailClient.getGoogleGroupsCount(sourceUser),
        gmailClient.getGoogleGroupsCount(destUser),
      ]);

      const srcCount = Number(srcGroups?.count) || 0;
      const dstCount = Number(dstGroups?.count) || 0;

      log.info(
        `Groups: source (Workspace)=${srcCount} dest (Workspace)=${dstCount}` +
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

module.exports = GmailToGmailValidationAgent;
