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
const agentBrain         = require('../../ai/agentBrain');
const outlookClient      = require('../../clients/outlookClient');
const gmailClient        = require('../../clients/gmailClient');
const { classifyMismatches, getCombination } = require('../../clients/cloudfuzeDocsClient');
const calendarClient     = require('../../clients/calendarClient');
const migrationClient    = require('../../clients/migrationClient');
const ValidationResult   = require('../../models/ValidationResult');
const logger             = require('../../utils/logger');
const { findDestCustomFolder } = require('../../utils/gmailOutlookLabelMatch');
const { parseRecipientEmails } = require('../../utils/mailMigrationComparator');

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
    const _startTime = new Date();

    // Fetch CloudFuze migration job status so the PDF report shows Workspace ID, total/processed
    // counts, and status. Only fetch if not already populated by MigrationAgent in this execution.
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

          // Email addresses — compare all, sorted and normalised
          const srcEmails = (src.emailAddresses || []).map(e => (e.address || '').toLowerCase()).filter(Boolean).sort();
          const dstEmails = (dst.emailAddresses || []).map(e => String(e || '').toLowerCase()).filter(Boolean).sort();
          if (srcEmails.length > 0 && dstEmails.length > 0 && srcEmails.join(',') !== dstEmails.join(',')) {
            fieldMismatches.push({ contact: src.displayName, field: 'emailAddresses', source: srcEmails.join(', '), destination: dstEmails.join(', ') });
          } else if (srcEmails.length > 0 && dstEmails.length === 0) {
            fieldMismatches.push({ contact: src.displayName, field: 'emailAddresses', source: srcEmails.join(', '), destination: '(none)' });
          }

          // Phone numbers — merge businessPhones + mobilePhone vs phoneNumbers
          const srcPhones = [...(src.businessPhones || []), src.mobilePhone].filter(Boolean).map(p => p.replace(/\s/g, '')).sort();
          const dstPhones = (dst.phoneNumbers || []).map(p => p.replace(/\s/g, '')).sort();
          if (srcPhones.length > 0 && dstPhones.length > 0 && srcPhones.join(',') !== dstPhones.join(',')) {
            fieldMismatches.push({ contact: src.displayName, field: 'phoneNumbers', source: srcPhones.join(', '), destination: dstPhones.join(', ') });
          }

          // Organization / company name
          const srcOrg = (src.companyName || '').trim().toLowerCase();
          const dstOrg = (dst.organization || '').trim().toLowerCase();
          if (srcOrg && dstOrg && srcOrg !== dstOrg) {
            fieldMismatches.push({ contact: src.displayName, field: 'organization', source: src.companyName, destination: dst.organization });
          }

          // Job title
          const srcTitle = (src.jobTitle || '').trim().toLowerCase();
          const dstTitle = (dst.jobTitle || '').trim().toLowerCase();
          if (srcTitle && dstTitle && srcTitle !== dstTitle) {
            fieldMismatches.push({ contact: src.displayName, field: 'jobTitle', source: src.jobTitle, destination: dst.jobTitle });
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

        // ── Contacts with empty fields (inscope) ──────────────────────────────
        // For contacts where source Outlook has some fields empty/null, verify the
        // contact still appears at destination with whatever non-empty fields it has.
        const partialContactNotes = [];
        try {
          for (const src of srcContacts) {
            if (!src.displayName) continue;
            const key = src.displayName.toLowerCase().trim();
            const dst = dstMap.get(key);
            if (!dst) continue; // absence already captured by count mismatch
            const srcEmails = (src.emailAddresses || []).map(e => (e.address || '').toLowerCase()).filter(Boolean);
            const srcPhones = [...(src.businessPhones || []), src.mobilePhone].filter(Boolean);
            const srcOrg    = (src.companyName || '').trim();
            const srcTitle  = (src.jobTitle || '').trim();
            const emptyFields = [];
            if (!srcEmails.length) emptyFields.push('emailAddresses');
            if (!srcPhones.length) emptyFields.push('phoneNumbers');
            if (!srcOrg)           emptyFields.push('organization');
            if (!srcTitle)         emptyFields.push('jobTitle');
            if (emptyFields.length > 0) {
              partialContactNotes.push({
                contact: src.displayName,
                note: `Contact present at destination. Source had empty field(s): ${emptyFields.join(', ')}`,
                emptyFields,
              });
            }
          }
          result.contactsValidation.partialContactNotes = partialContactNotes;
        } catch (partialErr) {
          log.warn(`Contacts partial-field check failed (non-fatal): ${partialErr.message}`);
        }

        log.info(
          `Contacts: src=${srcContacts.length} dst=${dstContacts.length} ` +
          `fieldMismatches=${fieldMismatches.length} photoMismatches=${photoMismatches.length} ` +
          `partialFieldContacts=${partialContactNotes.length}` +
          (srcResult.note ? ` [src: ${srcResult.note}]` : '') +
          (dstResult.note ? ` [dst: ${dstResult.note}]` : '')
        );
      } catch (err) {
        log.warn(`Contacts validation failed: ${err.message}`);
      }
    }

    // ── 5b. Inbox Rules Advisory + Gmail Filters comparison ──────────────────
    // Outlook inbox rules are NOT migrated as Gmail filters by CloudFuze.
    // This block detects rules on source and any existing filters on destination.
    try {
      const [rulesResult, filtersResult] = await Promise.all([
        outlookClient.getInboxRules(sourceUser),
        gmailClient.getGmailFilters(destUser).catch(() => ({ filters: [], available: false })),
      ]);
      const rules = rulesResult.rules || [];
      const filters = filtersResult.filters || [];
      result.rulesAdvisory = {
        available: rulesResult.available,
        count: rules.length,
        names: rules.map(r => r.displayName || r.name || '(unnamed)').slice(0, 20),
        gmailFiltersCount: filters.length,
        gmailFiltersAvailable: filtersResult.available,
        note: rules.length > 0
          ? `${rules.length} Outlook inbox rule(s) detected. CloudFuze does not migrate Outlook inbox rules as Gmail filters — manual recreation required. Gmail currently has ${filters.length} filter(s).`
          : `No Outlook inbox rules detected. Gmail has ${filters.length} filter(s).`,
      };
      if (rules.length > 0) {
        log.warn(`Inbox rules: ${rules.length} Outlook rule(s), ${filters.length} Gmail filter(s)`);
        const rulesMsg = `${rules.length} Outlook inbox rule(s) found at source — rules are NOT migrated to Gmail. Recreate manually.`;
        if (Array.isArray(result.rulesAdvisory)) {
          result.rulesAdvisory.push({ message: rulesMsg });
        } else {
          result.addMismatch('settings', 'inboxRules', rules.length, 0, { severity: 'warning', message: rulesMsg });
        }
      }
    } catch (err) {
      log.warn(`Inbox rules advisory failed: ${err.message}`);
      result.rulesAdvisory = { available: false, count: 0, note: `Rules check failed: ${err.message}` };
    }

    // ── 5c. Draft body comparison ─────────────────────────────────────────────
    if (context.includeMail !== false) {
      try {
        const [outlookDraftsRaw, gmailDraftsResult] = await Promise.all([
          outlookClient.listMessagesInFolderPaged(
            sourceUser, 'drafts', 200,
            'id,subject,toRecipients,ccRecipients,from,isDraft'
          ),
          gmailClient.getGmailDraftDetails(destUser, 200),
        ]);
        const outlookDrafts = (outlookDraftsRaw || []).filter(m => m.isDraft !== false);
        const gmailDrafts = gmailDraftsResult.drafts || [];
        result.draftComparison = {
          available: true,
          sourceCount: outlookDrafts.length,
          destinationCount: gmailDrafts.length,
          countMatch: outlookDrafts.length === gmailDrafts.length,
          subjectMismatches: [],
        };
        // Match drafts by normalized subject
        const normalizeS = (s) => String(s || '').toLowerCase().replace(/^re:|^fwd?:/i, '').replace(/\s+/g, ' ').trim();
        const gmailDraftMap = new Map(gmailDrafts.map(d => [normalizeS(d.subject), d]));
        for (const od of outlookDrafts) {
          const nk = normalizeS(od.subject);
          const gd = gmailDraftMap.get(nk);
          if (!gd) {
            result.draftComparison.subjectMismatches.push({
              subject: od.subject || '(no subject)',
              issue: 'Draft not found in Gmail by subject',
            });
            continue;
          }
          // Compare recipients
          const srcTo = (od.toRecipients || []).map(r => (r.emailAddress?.address || '').toLowerCase()).sort().join(',');
          const dstTo = parseRecipientEmails(gd.to).join(',');
          if (srcTo && dstTo && srcTo !== dstTo) {
            result.draftComparison.subjectMismatches.push({
              subject: od.subject || '(no subject)',
              issue: `To recipients differ: Outlook=[${srcTo}] Gmail=[${dstTo}]`,
            });
          }
          const srcCc = (od.ccRecipients || []).map(r => (r.emailAddress?.address || '').toLowerCase()).sort().join(',');
          const dstCc = parseRecipientEmails(gd.cc).join(',');
          if (srcCc && dstCc && srcCc !== dstCc) {
            result.draftComparison.subjectMismatches.push({
              subject: od.subject || '(no subject)',
              issue: `CC recipients differ: Outlook=[${srcCc}] Gmail=[${dstCc}]`,
            });
          }
          const srcBcc = (od.bccRecipients || []).map(r => (r.emailAddress?.address || '').toLowerCase()).sort().join(',');
          const dstBcc = parseRecipientEmails(gd.bcc).join(',');
          if (srcBcc && dstBcc && srcBcc !== dstBcc) {
            result.draftComparison.subjectMismatches.push({
              subject: od.subject || '(no subject)',
              issue: `BCC recipients differ: Outlook=[${srcBcc}] Gmail=[${dstBcc}]`,
            });
          }
        }
        log.info(
          `Draft comparison: src=${outlookDrafts.length} dst=${gmailDrafts.length} ` +
          `mismatches=${result.draftComparison.subjectMismatches.length}`
        );
        if (!result.draftComparison.countMatch) {
          result.addMismatch('mail', 'draftCount', outlookDrafts.length, gmailDrafts.length);
        }
      } catch (err) {
        log.warn(`Draft comparison failed: ${err.message}`);
      }
    }

    // ── 6. Groups (DELTA + E2E only — not migrated in One Time) ───────────
    if (context.includeContacts && (testType === 'E2E' || testType === 'FULL')) {
      await this._validateGroups(sourceUser, destUser, result, log);
    }

    // ── 6b. Mailbox settings advisory (Outlook→Gmail only) ────────────────
    if (context.sourceProvider === 'microsoft') {
      await this._validateMailboxSettings(sourceUser, destUser, result, log);
    }

    // ── 6c. Outscope feature advisories (O→G) ────────────────────────────
    if (context.sourceProvider === 'microsoft' && context.includeMail !== false) {
      await this._validateOutscopeAdvisories(sourceUser, result, log);
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

      // ── Suppress per-email folder mismatches already covered by folder-level findings ──
      // When Archive or Search Folder emails fail ONLY because of folder/label placement,
      // mark them as known_limitation so they don't appear as individual bugs in the report.
      // The folder-level finding added in _compareMailCounts already captures these.
      const hasArchiveFolderFinding = result.mismatches.some(
        m => m.field === 'Archive folder'
      );
      if (hasArchiveFolderFinding || result.deepMailValidation.enabled) {
        for (const r of result.deepMailValidation.messageResults || []) {
          if (r.pass) continue;
          const errDiffs = (r.diffs || []).filter(d => d.severity === 'error');
          const onlyFolderErrors = errDiffs.length > 0 &&
            errDiffs.every(d => ['folder', 'starred', 'important'].includes(d.field));
          if (onlyFolderErrors) {
            r.bugStatus = 'known_limitation';
          }
        }
        for (const t of result.deepMailValidation.threadChainResults || []) {
          if (t.pass) continue;
          const errMismatches = (t.mismatches || []).filter(m => m.severity === 'error');
          const onlyFolderErrors = errMismatches.length > 0 &&
            errMismatches.every(m => ['folder', 'starred', 'important'].includes(m.field));
          if (onlyFolderErrors) {
            t.bugStatus = 'known_limitation';
          }
        }
      }
    }

    result.computeOverallStatus();

    // Classify each mismatch as bug | known_limitation | unknown via CloudFuze docs API
    try {
      const combination = getCombination(context.sourceProvider || 'microsoft', context.destinationProvider || 'google');
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
          mailValidation: { sourceCount: result.mailValidation.sourceCount, destinationCount: result.mailValidation.destinationCount },
          comparison: result.comparison,
          migrationJobDetails: context.migrationJobDetails || null,
        };
        const aiContext = {
          testType,
          direction: context.sourceProvider === 'microsoft' ? 'outlook_to_gmail' : 'gmail_to_gmail',
          sourceProvider: context.sourceProvider || 'microsoft',
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

  // ── Source: Outlook folders ────────────────────────────────────────────────

  async _fetchSourceOutlookData(sourceUser, result, log) {
    log.info(`Fetching source Outlook data for: ${sourceUser}`);
    try {
      const folders  = await outlookClient.getMailFolders(sourceUser);
      result.sourceData.defaultLabels = [];
      result.sourceData.customLabels  = [];
      await this._walkOutlookSourceFolders(folders, '', result.sourceData.defaultLabels, result.sourceData.customLabels, sourceUser, log);

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

  async _walkOutlookSourceFolders(folders, parentPath, defaultLabels, customLabels, userId, log) {
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

      // getMailFolders uses $expand=childFolders which only expands ONE level deep, so
      // deeply nested chains (e.g. QA-Nested-Level-01 … Level-15) would stop after 2 levels.
      // When a folder reports more children than were expanded, fetch the next level via
      // getChildFolders (which itself expands one more level) and keep recursing — otherwise
      // the report silently truncates the nested-folder tree.
      let children = folder.childFolders || [];
      if ((folder.childFolderCount || 0) > children.length && userId && folder.id) {
        try {
          children = await outlookClient.getChildFolders(userId, folder.id);
        } catch (e) {
          if (log) log.warn(`Source folder enumeration: could not fetch children of "${fullPath}" (childFolderCount=${folder.childFolderCount}) — nested subtree omitted: ${e.message}`);
        }
      }
      if (children.length) {
        await this._walkOutlookSourceFolders(children, fullPath, defaultLabels, customLabels, userId, log);
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
        const profileCount = Number(stats?.mailCount ?? stats?.totalMessages) || 0;
        if (stats && typeof stats.calendarCount === 'number') {
          result.calendarValidation.destinationCalendarCount = stats.calendarCount;
        }
        // Gmail indexes messages asynchronously — getProfile.messagesTotal may return 0
        // right after migration even though messages are already searchable. Fall back to
        // summing default folder label counts which are more up-to-date.
        if (profileCount === 0) {
          const labelSum = result.destinationData.defaultFolders
            .reduce((s, f) => s + (f.messageCount || 0), 0);
          result.mailValidation.destinationCount = labelSum || 0;
          if (labelSum > 0) {
            log.info(`Gmail getProfile returned 0 — using label sum (${labelSum}) as destination count`);
          }
        } else {
          result.mailValidation.destinationCount = profileCount;
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
          if (archiveCount > 0) {
            log.warn(
              `Archive[Gmail] label not found in destination — using derived count ` +
              `(total ${result.mailValidation.destinationCount} - system sum ${systemFolderSum} = ${archiveCount}); ` +
              `archive comparison may be inaccurate if non-archive messages are in All Mail`
            );
          } else {
            log.info(`Archive[Gmail] label not found — derived count is 0, no archive messages expected`);
          }
          result.destinationData.defaultFolders.push({ name: OUTLOOK_ARCHIVE_GMAIL_LABEL, messageCount: archiveCount });
        }
      }

      log.info(
        `Dest Gmail: ${result.destinationData.defaultFolders.length} default, ` +
        `${result.destinationData.customFolders.length} custom, total ${result.mailValidation.destinationCount} messages`
      );
    } catch (err) {
      log.error(`Failed to fetch destination Gmail data: ${err.message}`);
      result.destinationData.fetchError = err.message;
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

    // ── Archive folder migration status ───────────────────────────────────────
    // Archive is INSCOPE for O→G. If it did not migrate, report as a single
    // folder-level bug — do NOT list every email from Archive individually.
    const srcArchive = result.sourceData.defaultLabels.find(f => f.name === 'Archive');
    const dstArchive = result.destinationData.defaultFolders.find(f => f.name === OUTLOOK_ARCHIVE_GMAIL_LABEL);
    const srcArchiveCount = srcArchive?.messageCount || 0;
    const dstArchiveCount = dstArchive?.messageCount || 0;
    if (srcArchiveCount > 0 && dstArchiveCount === 0) {
      result.mismatches.push({
        category: 'folder',
        kind: 'folder',
        kindLabel: 'Folder migration',
        field: 'Archive folder',
        expected: `${srcArchiveCount} message(s) in Archive[Gmail]`,
        actual: 'Archive folder NOT migrated to Gmail destination',
        summaryLine: `Archive folder: ${srcArchiveCount} email(s) not migrated — INSCOPE feature (bug)`,
        bugStatus: 'bug',
      });
      log.warn(`Archive folder NOT migrated: source has ${srcArchiveCount} email(s), destination has 0`);
    }

    // ── Search Folders migration status ───────────────────────────────────────
    // Search Folders are Outlook-only virtual folders. Gmail has no equivalent.
    // Not listed in O→G inscope or outscope docs — report as a single advisory.
    const srcSearchFolders = result.sourceData.customLabels.filter(
      f => /^(QA Search|Search Folder)/i.test(f.name)
    );
    const outlookSearchFolderCount = (result.sourceData.defaultLabels.find(
      f => /search.?folder/i.test(f.name)
    )?.messageCount || 0) + srcSearchFolders.reduce((s, f) => s + (f.messageCount || 0), 0);

    if (srcSearchFolders.length > 0 || outlookSearchFolderCount > 0) {
      result.mismatches.push({
        category: 'folder',
        kind: 'folder',
        kindLabel: 'Folder migration',
        field: 'Search Folders',
        expected: 'Search Folders (Outlook virtual folders)',
        actual: 'Search Folders NOT migrated — no Gmail equivalent',
        summaryLine: `Search Folders: not migrated — not in O→G inscope/outscope docs (Outlook-only feature, no Gmail equivalent)`,
        bugStatus: 'known_limitation',
      });
      log.info(`Search Folders: ${srcSearchFolders.length} search folder(s) not migrated (expected — no Gmail equivalent)`);
    }
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

      // Per-event detail comparison: match source↔destination events by subject+start time
      try {
        result.calendarValidation.eventDetailMismatches = [];
        const srcCals = await outlookClient.getCalendars(sourceUser);
        for (const cal of srcCals) {
          const srcEvs = await outlookClient.getEvents(sourceUser, cal.id);
          for (const srcEv of srcEvs) {
            const evSubjectLower = (srcEv.subject || '').toLowerCase().trim();
            // Find matching dest event by subject (case-insensitive)
            const destEv = result.calendarValidation.eventDetails.find(
              (d) => (d.subject || '').toLowerCase().trim() === evSubjectLower
            );
            if (!destEv) {
              result.calendarValidation.eventDetailMismatches.push({
                subject: srcEv.subject || '(no subject)',
                issue: 'Event not found in Google Calendar by subject',
                severity: 'error',
              });
              continue;
            }
            // Attachment check
            if (srcEv.hasAttachments && destEv.attachmentCount === 0) {
              result.calendarValidation.attachmentMismatches.push({
                subject: srcEv.subject,
                note: 'Outlook event has attachments but no attachments found on Google Calendar event',
              });
            }
            // Attendee count check
            const srcAttendeeCount = (srcEv.attendees || []).length;
            if (srcAttendeeCount > 0 && srcAttendeeCount !== destEv.attendeeCount) {
              result.calendarValidation.eventDetailMismatches.push({
                subject: srcEv.subject || '(no subject)',
                issue: `Attendee count differs: source=${srcAttendeeCount} dest=${destEv.attendeeCount}`,
                severity: 'warning',
              });
            }
            // All-day check
            const srcIsAllDay = !srcEv.start?.dateTime;
            if (srcIsAllDay !== destEv.isAllDay) {
              result.calendarValidation.eventDetailMismatches.push({
                subject: srcEv.subject || '(no subject)',
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

  // ── Mailbox settings advisory (Outlook→Gmail) ─────────────────────────────

  /**
   * P2-3: Compare source Outlook mailbox settings against destination Gmail settings.
   *
   * Checks:
   *   1. Auto-reply / vacation responder — Outlook automaticRepliesSetting vs Gmail vacation.
   *   2. Email signature — advisory note when Outlook has a signature; Gmail sendAs check is
   *      stubbed until gmail.settings.basic DWD scope is added.
   *
   * All checks are best-effort (wrapped in try/catch). Findings are added as advisory
   * warnings to result.settingsValidation (or result.rulesAdvisory when settingsValidation
   * is not available), never as hard failures, because settings are not migrated by
   * CloudFuze and differences are expected.
   *
   * @param {string} srcUser   - Source Outlook email
   * @param {string} destUser  - Destination Gmail email
   * @param {ValidationResult} result
   * @param {object} log       - pino logger child
   */
  async _validateMailboxSettings(srcUser, destUser, result, log) {
    log.info('Settings advisory: comparing Outlook mailbox settings → Gmail destination…');

    // Ensure result.settingsValidation exists (ValidationResult always initialises it, but be safe)
    if (!result.settingsValidation) {
      result.settingsValidation = { available: false, advisories: [] };
    }
    result.settingsValidation.available = true;
    if (!Array.isArray(result.settingsValidation.advisories)) {
      result.settingsValidation.advisories = [];
    }

    const addAdvisory = (message) => {
      result.settingsValidation.advisories.push({ severity: 'warning', message });
      // Also surface in rulesAdvisory.notes array so the PDF table picks it up
      if (result.rulesAdvisory && typeof result.rulesAdvisory === 'object' && !Array.isArray(result.rulesAdvisory)) {
        if (!Array.isArray(result.rulesAdvisory.settingsNotes)) result.rulesAdvisory.settingsNotes = [];
        result.rulesAdvisory.settingsNotes.push(message);
      }
    };

    // ── 1. Auto-reply / out-of-office ─────────────────────────────────────
    try {
      const [srcSettings, dstVacation] = await Promise.all([
        outlookClient.getMailboxSettings(srcUser),
        gmailClient.getVacationSettings(destUser),
      ]);

      const srcAutoReply = srcSettings?.settings?.automaticRepliesSetting;
      if (srcSettings.available && srcAutoReply) {
        // Outlook status is 'alwaysEnabled' | 'scheduled' | 'disabled'
        const srcEnabled = srcAutoReply.status === 'alwaysEnabled' || srcAutoReply.status === 'scheduled';

        if (dstVacation.available) {
          // Real comparison (once Gmail scope is added this branch will execute)
          const dstEnabled = Boolean(dstVacation.enabled);
          if (srcEnabled !== dstEnabled) {
            const msg =
              `Auto-reply/out-of-office state differs: ` +
              `Outlook source is ${srcEnabled ? 'ENABLED' : 'DISABLED'} ` +
              `but Gmail destination is ${dstEnabled ? 'ENABLED' : 'DISABLED'}. ` +
              `CloudFuze does not migrate auto-reply settings — verify manually.`;
            addAdvisory(msg);
            log.warn(`Settings: auto-reply mismatch — src=${srcEnabled} dst=${dstEnabled}`);
          } else {
            log.info(`Settings: auto-reply — both ${srcEnabled ? 'enabled' : 'disabled'} (match)`);
          }
        } else {
          // Gmail vacation scope not available — emit advisory if Outlook auto-reply is active
          if (srcEnabled) {
            const msg =
              `Outlook source has auto-reply ENABLED (status: ${srcAutoReply.status}). ` +
              `Unable to verify destination Gmail vacation responder — ` +
              `${dstVacation.note || 'gmail.settings.basic scope not configured'}. ` +
              `Verify manually that the vacation responder is set correctly in Gmail.`;
            addAdvisory(msg);
            log.warn(`Settings: Outlook auto-reply is enabled but Gmail vacation check unavailable`);
          } else {
            log.info(`Settings: Outlook auto-reply is disabled; Gmail vacation check skipped (scope unavailable)`);
          }
        }
      } else if (!srcSettings.available) {
        log.info(`Settings: Outlook mailbox settings unavailable — ${srcSettings.note || 'unknown reason'}`);
      } else {
        log.info('Settings: Outlook automaticRepliesSetting not present in response');
      }
    } catch (err) {
      log.warn(`Settings: auto-reply check failed (non-fatal): ${err.message}`);
    }

    // ── 2. Email signature advisory ────────────────────────────────────────
    try {
      const dstSendAs = await gmailClient.getSendAsSettings(destUser);

      if (dstSendAs.available && Array.isArray(dstSendAs.sendAs)) {
        // Real check: flag if no sendAs address has a non-empty signature
        const hasSignature = dstSendAs.sendAs.some((sa) => sa.signature && sa.signature.trim().length > 0);
        if (!hasSignature) {
          addAdvisory(
            'Gmail destination has no email signature configured. ' +
            'CloudFuze does not migrate Outlook email signatures — set the signature manually in Gmail settings.'
          );
          log.warn('Settings: no signature found in Gmail sendAs settings');
        } else {
          log.info('Settings: Gmail destination has at least one sendAs signature configured');
        }
      } else {
        // Stub returns available:false — add a soft advisory so the report notes the gap
        addAdvisory(
          'Email signature migration could not be verified: ' +
          (dstSendAs.note || 'gmail.settings.basic scope not configured in DWD') +
          '. CloudFuze does not migrate Outlook email signatures — verify manually in Gmail settings.'
        );
        log.info(`Settings: sendAs/signature check skipped — ${dstSendAs.note || 'scope unavailable'}`);
      }
    } catch (err) {
      log.warn(`Settings: signature check failed (non-fatal): ${err.message}`);
    }

    log.info(
      `Settings advisory complete: ${result.settingsValidation.advisories.length} advisory item(s)`
    );
  }

  // ── Outscope advisories (O→G) ─────────────────────────────────────────────

  /**
   * Inspect the source Outlook mailbox for folders / features that are documented
   * as outscope for Outlook→Gmail migration and add informational advisory notes.
   *
   * These are severity:'info' notices — they do NOT count as mismatches or failures.
   * They are appended to result.settingsValidation.advisories so the PDF report
   * can surface them in a dedicated advisory section.
   *
   * Checks:
   *   1. Notes folder with messages — Notes are not migrated to Gmail.
   *   2. Conversation History folder — Skype/Lync/Teams chat history is excluded.
   *   3. Outlook categories on messages in Inbox — categories are not preserved in Gmail.
   */
  async _validateOutscopeAdvisories(srcUser, result, log) {
    log.info('Outscope advisories (O→G): inspecting source Outlook mailbox…');

    if (!result.settingsValidation) {
      result.settingsValidation = { available: true, advisories: [] };
    }
    if (!Array.isArray(result.settingsValidation.advisories)) {
      result.settingsValidation.advisories = [];
    }

    const addAdvisory = (message, severity = 'info') => {
      result.settingsValidation.advisories.push({ severity, message });
      if (result.rulesAdvisory && typeof result.rulesAdvisory === 'object' && !Array.isArray(result.rulesAdvisory)) {
        if (!Array.isArray(result.rulesAdvisory.outscopeNotes)) result.rulesAdvisory.outscopeNotes = [];
        result.rulesAdvisory.outscopeNotes.push(message);
      }
    };

    // ── 1. Notes folder ──────────────────────────────────────────────────────
    try {
      const folders = await outlookClient.getAllFoldersFlat(srcUser);
      const notesFolder = (folders || []).find(
        (f) => /^notes$/i.test((f.displayName || '').trim())
      );
      if (notesFolder) {
        const count = notesFolder.totalItemCount || 0;
        if (count > 0) {
          const msg =
            `Notes folder found at source with ${count} item(s) — ` +
            `Notes are NOT migrated to Gmail (outscope). ` +
            `Consider exporting notes manually before decommissioning the Outlook mailbox.`;
          addAdvisory(msg, 'warning');
          log.warn(`Outscope advisory: Notes folder — ${count} item(s)`);
        } else {
          log.info('Outscope advisory: Notes folder exists but is empty — skipping advisory');
        }
      }

      // ── 2. Conversation History folder ────────────────────────────────────
      const convHistFolder = (folders || []).find(
        (f) => /conversation.?history/i.test((f.displayName || '').trim())
      );
      if (convHistFolder) {
        const count = convHistFolder.totalItemCount || 0;
        if (count > 0) {
          const msg =
            `Conversation History folder found at source with ${count} item(s) — ` +
            `Skype / Lync / Teams chat history stored in this folder is NOT migrated to Gmail (outscope). ` +
            `These messages will remain in Outlook only.`;
          addAdvisory(msg, 'warning');
          log.warn(`Outscope advisory: Conversation History folder — ${count} item(s)`);
        }
      }
    } catch (err) {
      log.warn(`Outscope advisory: folder inspection failed (non-fatal): ${err.message}`);
    }

    // ── 3. Outlook categories on source messages ──────────────────────────────
    // Sample the Inbox for messages with categories to give an advisory count.
    try {
      const inboxMessages = await outlookClient.listMessagesInFolderPaged(
        srcUser, 'inbox', 100, 'id,subject,categories'
      );
      const messagesWithCategories = (inboxMessages || []).filter(
        (m) => Array.isArray(m.categories) && m.categories.length > 0
      );
      if (messagesWithCategories.length > 0) {
        // Collect unique category names across the sample
        const categorySet = new Set();
        for (const m of messagesWithCategories) {
          for (const cat of m.categories) {
            if (cat) categorySet.add(cat);
          }
        }
        const catList = [...categorySet].slice(0, 10).join(', ');
        const msg =
          `${messagesWithCategories.length} message(s) in source Inbox (sample) have Outlook categories ` +
          `(e.g. ${catList}) — Outlook categories are NOT preserved in Gmail (outscope). ` +
          `Consider using Gmail labels as an equivalent after migration.`;
        addAdvisory(msg, 'warning');
        log.warn(
          `Outscope advisory: ${messagesWithCategories.length} message(s) with categories in source Inbox sample ` +
          `— categories not migrated to Gmail`
        );
      } else {
        log.info('Outscope advisory: no Outlook categories found in source Inbox sample');
      }
    } catch (err) {
      log.warn(`Outscope advisory: categories check failed (non-fatal): ${err.message}`);
    }

    log.info(
      `Outscope advisories complete: ${result.settingsValidation.advisories.length} total advisory item(s)`
    );
  }
}

module.exports = GmailValidationAgent;
