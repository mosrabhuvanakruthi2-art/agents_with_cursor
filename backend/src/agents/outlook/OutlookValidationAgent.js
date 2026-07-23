const { BaseAgent } = require('../core/BaseAgent');
const agentBrain = require('../../ai/agentBrain');
const outlookClient = require('../../clients/outlookClient');
const gmailClient = require('../../clients/gmailClient');
const calendarClient = require('../../clients/calendarClient');
const migrationClient = require('../../clients/migrationClient');
const { classifyMismatches, getCombination } = require('../../clients/cloudfuzeDocsClient');
const ValidationResult = require('../../models/ValidationResult');
const logger = require('../../utils/logger');
const { findDestCustomFolder } = require('../../utils/gmailOutlookLabelMatch');
const { parseRecipientEmails } = require('../../utils/mailMigrationComparator');

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
  'Archive': 'Archive',
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
    const _startTime = new Date();;

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

    // Fetch source data — Outlook or Gmail depending on source provider
    if (context.sourceProvider === 'microsoft') {
      await this._fetchOutlookSourceData(sourceUser, result, log);
    } else {
      await this._fetchSourceData(sourceUser, result, log);
    }

    // Fetch destination Outlook data
    await this._fetchDestinationData(destUser, result, log);

    if (context.includeMail) {
      // Smoke (merged Smoke+Sanity) runs the comprehensive validation; E2E runs the full suite.
      if (testType === 'E2E') {
        await this._e2eValidateMail(destUser, result, log);
      } else {
        await this._sanityValidateMail(destUser, result, log);
      }
    }

    if (context.includeCalendar && testType === 'E2E') {
      await this._validateCalendar(sourceUser, destUser, result, log, context.sourceProvider);
    }

    // ── P2-6: Draft comparison for G→O ──────────────────────────────────────
    if (context.sourceProvider !== 'microsoft' && context.includeMail !== false) {
      await this._validateDrafts(sourceUser, destUser, result, log);
    }

    // ── P3-10: Gmail filters → Outlook rules comparison for G→O ──────────────
    if (context.sourceProvider !== 'microsoft') {
      await this._validateGmailFiltersAdvisory(sourceUser, destUser, result, log);
    }

    // ── Outscope feature advisories (G→O) ─────────────────────────────────────
    if (context.sourceProvider !== 'microsoft' && context.includeMail !== false) {
      await this._validateOutscopeAdvisories(sourceUser, result, log);
    }

    if (context.sourceProvider === 'microsoft') {
      await this._validateMailboxSettings(sourceUser, destUser, result, log);
    }

    /**
     * Contacts validation:
     * - For G→O (sourceProvider !== 'microsoft'): full field-level comparison matching by
     *   displayName (case-insensitive), comparing emailAddresses, phoneNumbers, organization,
     *   and jobTitle.  Mirrors the pattern used in GmailValidationAgent for O→G.
     * - For O→O (sourceProvider === 'microsoft'): count-only comparison.
     * Always best-effort — errors/warnings are logged but do not fail validation.
     */
    try {
      if (context.sourceProvider !== 'microsoft') {
        // ── G→O: full field-level contacts comparison ──────────────────────────
        const [srcResult, dstResult] = await Promise.all([
          gmailClient.getGmailContactsWithDetails(sourceUser),
          outlookClient.getContactsWithDetails(destUser),
        ]);

        const srcContacts = srcResult.contacts || [];
        const dstContacts = dstResult.contacts || [];

        result.contactsValidation.sourceCount      = srcContacts.length;
        result.contactsValidation.destinationCount = dstContacts.length;
        result.contactsValidation.available        = srcResult.available || dstResult.available;
        result.contactsValidation.countMatch       = srcContacts.length === dstContacts.length;

        // Field-level comparison — match by normalised displayName (case-insensitive)
        const fieldMismatches = [];

        // Build a map of dest contacts keyed by lowercase displayName
        const dstMap = new Map(
          dstContacts
            .filter((c) => c.displayName)
            .map((c) => [c.displayName.toLowerCase().trim(), c])
        );

        for (const src of srcContacts) {
          if (!src.displayName) continue;
          const key = src.displayName.toLowerCase().trim();
          const dst = dstMap.get(key);
          if (!dst) continue; // unmatched contacts reported by count mismatch

          // Email addresses
          // Gmail source: emailAddresses is already a flat string[]
          // Outlook dest:  emailAddresses is [{ address, name }] objects
          const srcEmails = (src.emailAddresses || [])
            .map((e) => String(e || '').toLowerCase())
            .filter(Boolean)
            .sort();
          const dstEmails = (dst.emailAddresses || [])
            .map((e) => ((e && e.address) ? e.address : String(e || '')).toLowerCase())
            .filter(Boolean)
            .sort();
          if (srcEmails.length > 0 && dstEmails.length > 0 && srcEmails.join(',') !== dstEmails.join(',')) {
            fieldMismatches.push({ contact: src.displayName, field: 'emailAddresses', source: srcEmails.join(', '), destination: dstEmails.join(', ') });
          } else if (srcEmails.length > 0 && dstEmails.length === 0) {
            fieldMismatches.push({ contact: src.displayName, field: 'emailAddresses', source: srcEmails.join(', '), destination: '(none)' });
          }

          // Phone numbers
          // Gmail source: phoneNumbers is a flat string[]
          // Outlook dest: businessPhones[] + mobilePhone
          const srcPhones = (src.phoneNumbers || [])
            .map((p) => String(p || '').replace(/\s/g, ''))
            .filter(Boolean)
            .sort();
          const dstPhones = [
            ...(dst.businessPhones || []),
            dst.mobilePhone,
          ]
            .filter(Boolean)
            .map((p) => String(p).replace(/\s/g, ''))
            .sort();
          if (srcPhones.length > 0 && dstPhones.length > 0 && srcPhones.join(',') !== dstPhones.join(',')) {
            fieldMismatches.push({ contact: src.displayName, field: 'phoneNumbers', source: srcPhones.join(', '), destination: dstPhones.join(', ') });
          }

          // Organization / company name
          // Gmail source: organization (string)
          // Outlook dest: companyName (string)
          const srcOrg = (src.organization || '').trim().toLowerCase();
          const dstOrg = (dst.companyName || '').trim().toLowerCase();
          if (srcOrg && dstOrg && srcOrg !== dstOrg) {
            fieldMismatches.push({ contact: src.displayName, field: 'organization', source: src.organization, destination: dst.companyName });
          }

          // Job title
          const srcTitle = (src.jobTitle || '').trim().toLowerCase();
          const dstTitle = (dst.jobTitle || '').trim().toLowerCase();
          if (srcTitle && dstTitle && srcTitle !== dstTitle) {
            fieldMismatches.push({ contact: src.displayName, field: 'jobTitle', source: src.jobTitle, destination: dst.jobTitle });
          }
        }

        result.contactsValidation.fieldMismatches = fieldMismatches;

        // ── Contact labels → Outlook categories (G→O inscope) ────────────────
        // Gmail contact labels/groups should appear as Outlook contact categories.
        // Best-effort: list source Gmail contact groups and check that each group
        // name has a corresponding category in at least one destination Outlook contact.
        try {
          const groupsResult = await gmailClient.getGmailContactGroups(sourceUser);
          const srcGroups = (groupsResult.groups || []).map(g => g.toLowerCase().trim());

          if (!groupsResult.available) {
            result.contactsValidation.contactLabelsMigration = { available: false, note: groupsResult.note || 'Could not list Gmail contact groups' };
            log.info(`Contact labels→categories: skipped — ${groupsResult.note || 'People API unavailable'}`);
          } else if (srcGroups.length === 0) {
            result.contactsValidation.contactLabelsMigration = { available: true, sourceGroupCount: 0, note: 'No user-created Gmail contact groups found at source' };
            log.info('Contact labels→categories: no user-created Gmail contact groups found at source');
          } else {
            // Collect all Outlook contact categories from destination contacts
            const dstCategories = new Set();
            for (const c of dstContacts) {
              for (const cat of (c.categories || [])) {
                dstCategories.add((cat || '').toLowerCase().trim());
              }
            }
            const missingGroups = srcGroups.filter(g => !dstCategories.has(g));
            result.contactsValidation.contactLabelsMigration = {
              available: true,
              sourceGroupCount: srcGroups.length,
              sourceGroups: srcGroups,
              destinationCategoryCount: dstCategories.size,
              missingInDestination: missingGroups,
            };
            if (missingGroups.length > 0) {
              log.warn(`Contact labels→categories: ${missingGroups.length} Gmail group(s) not found as Outlook categories: ${missingGroups.join(', ')}`);
            } else {
              log.info(`Contact labels→categories: all ${srcGroups.length} Gmail contact group(s) found as Outlook categories`);
            }
          }
        } catch (labelsErr) {
          log.warn(`Contact labels→categories check failed (non-fatal): ${labelsErr.message}`);
          result.contactsValidation.contactLabelsMigration = { available: false, note: labelsErr.message };
        }

        log.info(
          `Contacts (G→O): src=${srcContacts.length} dst=${dstContacts.length} ` +
          `fieldMismatches=${fieldMismatches.length}` +
          (srcResult.note ? ` [src: ${srcResult.note}]` : '') +
          (dstResult.note ? ` [dst: ${dstResult.note}]` : '')
        );
      } else {
        // ── O→O: count-only comparison ─────────────────────────────────────────
        const [srcContacts, dstContacts] = await Promise.all([
          outlookClient.getContactsCount(sourceUser),
          outlookClient.getContactsCount(destUser),
        ]);
        result.contactsValidation.sourceCount      = Number(srcContacts?.count) || 0;
        result.contactsValidation.destinationCount = Number(dstContacts?.count) || 0;
        result.contactsValidation.available        = Boolean(srcContacts?.available || dstContacts?.available);
        result.contactsValidation.countMatch       =
          result.contactsValidation.sourceCount === result.contactsValidation.destinationCount;
        log.info(
          `Contacts (O→O): source=${result.contactsValidation.sourceCount} dest=${result.contactsValidation.destinationCount}` +
          (srcContacts?.note ? ` [src: ${srcContacts.note}]` : '') +
          (dstContacts?.note ? ` [dst: ${dstContacts.note}]` : '')
        );
      }
    } catch (contactsErr) {
      log.warn(`Contacts validation failed: ${contactsErr.message}`);
    }

    // ── Migrate Archives check (G→O inscope) ─────────────────────────────────
    // Archived Gmail messages (messages in All Mail that have no INBOX label, i.e. no primary
    // label other than system labels) should appear in the destination Outlook Archive folder.
    // Best-effort: compare total archived message count (source) vs Outlook Archive folder count.
    if (context.sourceProvider !== 'microsoft' && context.includeMail !== false) {
      try {
        // Count Gmail messages that are archived (in All Mail but not in INBOX, SENT, DRAFT, TRASH, SPAM)
        // Use label INBOX count and total to derive archive count.
        const allMailCount  = result.mailValidation.sourceCount || 0;
        const inboxLabel    = result.sourceData.defaultLabels.find(l => l.id === 'INBOX');
        const sentLabel     = result.sourceData.defaultLabels.find(l => l.id === 'SENT');
        const draftLabel    = result.sourceData.defaultLabels.find(l => l.id === 'DRAFT');
        const trashLabel    = result.sourceData.defaultLabels.find(l => l.id === 'TRASH');
        const spamLabel     = result.sourceData.defaultLabels.find(l => l.id === 'SPAM');
        const systemSum     = (inboxLabel?.messageCount || 0) + (sentLabel?.messageCount || 0)
                            + (draftLabel?.messageCount || 0) + (trashLabel?.messageCount || 0)
                            + (spamLabel?.messageCount || 0);
        const srcArchiveEst = Math.max(0, allMailCount - systemSum);

        // Find destination Outlook Archive folder
        const dstArchiveFolder = result.destinationData.defaultFolders.find(
          f => String(f.name || '').toLowerCase() === 'archive'
        ) || result.destinationData.customFolders.find(
          f => String(f.name || '').toLowerCase() === 'archive'
        );
        const dstArchiveCount = dstArchiveFolder?.messageCount || 0;

        result.archiveMigration = {
          available: true,
          sourceArchivedEstimate: srcArchiveEst,
          destinationArchiveCount: dstArchiveCount,
          note: dstArchiveFolder
            ? `Source estimated archived messages: ${srcArchiveEst} (All Mail minus system folders). Destination Outlook Archive folder: ${dstArchiveCount} messages.`
            : `Source estimated archived messages: ${srcArchiveEst}. No Outlook Archive folder found in destination.`,
        };

        if (!dstArchiveFolder && srcArchiveEst > 0) {
          log.warn(`Archive migration: ~${srcArchiveEst} archived Gmail messages but no Outlook Archive folder found at destination`);
          result.addMismatch(
            'mail', 'archiveFolderMissing',
            `${srcArchiveEst} archived messages`, 'Outlook Archive folder not found',
            { severity: 'warning', message: `Gmail archived messages (~${srcArchiveEst}) may not have been migrated to an Outlook Archive folder. Verify archive migration in the CloudFuze job settings.` }
          );
        } else {
          log.info(`Archive migration: source estimated ~${srcArchiveEst} archived, dest Archive folder has ${dstArchiveCount} messages`);
        }
      } catch (archErr) {
        log.warn(`Archive migration check failed (non-fatal): ${archErr.message}`);
      }
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

    // Classify each mismatch as bug | known_limitation | unknown via CloudFuze docs API
    try {
      const srcProvider = context.sourceProvider || 'google';
      const combination = getCombination(srcProvider, 'microsoft');
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
        const srcProvider = context.sourceProvider || 'google';
        const aiContext = {
          testType,
          direction: srcProvider === 'microsoft' ? 'outlook_to_outlook' : 'gmail_to_outlook',
          sourceProvider: srcProvider,
          destinationProvider: 'microsoft',
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

      await this._walkOutlookSourceFolders(folders, defaults, '', result.sourceData.defaultLabels, result.sourceData.customLabels, sourceUser, log);

      const totalSource = result.sourceData.defaultLabels.reduce((s, l) => s + l.messageCount, 0)
        + result.sourceData.customLabels.reduce((s, l) => s + l.messageCount, 0);
      result.mailValidation.sourceCount = totalSource;
      log.info(`Source Outlook: ${result.sourceData.defaultLabels.length} default, ${result.sourceData.customLabels.length} custom`);
    } catch (err) {
      log.error(`Failed to fetch source Outlook data: ${err.message}`);
    }
  }

  async _walkOutlookSourceFolders(folders, defaults, parentPath, defaultLabels, customLabels, userId, log) {
    if (!folders?.length) return;
    for (const folder of folders) {
      const segment = (folder.displayName || '').trim();
      const fullPath = parentPath ? `${parentPath}/${segment}` : segment;

      if (defaults.has(segment)) {
        const gmailId = OUTLOOK_TO_GMAIL_ID[segment];
        if (gmailId) {
          // Use messages/$count (mail-only) instead of totalItemCount which includes
          // meeting requests and other non-mail item types causing false count mismatches.
          let count = folder.totalItemCount || 0;
          if (userId && folder.id) {
            try {
              count = await outlookClient.getMessageCount(userId, folder.id);
            } catch (_) { /* fall back to totalItemCount */ }
          }
          defaultLabels.push({ id: gmailId, name: segment, messageCount: count });
        } else {
          if (log) log.warn(`OutlookValidationAgent: skipping default folder with no Gmail ID mapping: "${segment}"`);
        }
      } else {
        customLabels.push({ id: fullPath, name: fullPath, messageCount: folder.totalItemCount || 0 });
      }

      let children = folder.childFolders || [];
      if ((folder.childFolderCount || 0) > children.length && userId && folder.id) {
        try {
          children = await outlookClient.getChildFolders(userId, folder.id);
        } catch (e) {
          // Do NOT swallow silently — a failed fetch here drops the ENTIRE nested subtree
          // below this folder, so the report would be quietly incomplete (e.g. deep nested
          // folders missing). Surface it so it's diagnosable and obviously not a clean pass.
          if (log) log.warn(`Source folder enumeration: could not fetch children of "${fullPath}" (childFolderCount=${folder.childFolderCount}) — nested subtree omitted: ${e.message}`);
        }
      }
      if (children.length) {
        await this._walkOutlookSourceFolders(children, defaults, fullPath, defaultLabels, customLabels, userId, log);
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
      await this._walkOutlookFolders(folders, defaults, '', result.destinationData.defaultFolders, result.destinationData.customFolders, destUser, log);

      log.info(`Destination: ${result.destinationData.defaultFolders.length} default folders, ${result.destinationData.customFolders.length} custom folders`);
    } catch (err) {
      log.error(`Failed to fetch destination Outlook data: ${err.message}`);
      result.destinationData.fetchError = err.message;
    }
  }

  /**
   * Gmail nested labels use a single name with slashes (e.g. QA-TestLabel/Nested-Child).
   * Outlook uses parent/child folders with separate displayNames.
   * Build slash-separated paths for custom folders so comparison matches Gmail.
   */
  async _walkOutlookFolders(folders, defaults, parentPath, defaultFolders, customFolders, userId, log) {
    if (!folders?.length) return;
    for (const folder of folders) {
      const segment = (folder.displayName || '').trim();
      const fullPath = parentPath ? `${parentPath}/${segment}` : segment;

      if (defaults.has(segment)) {
        // Use messages/$count (mail-only) instead of totalItemCount which includes
        // meeting requests and other non-mail item types causing false count mismatches.
        let count = folder.totalItemCount || 0;
        if (userId && folder.id) {
          try {
            count = await outlookClient.getMessageCount(userId, folder.id);
          } catch (_) { /* fall back to totalItemCount */ }
        }
        defaultFolders.push({ name: segment, messageCount: count });
      } else {
        customFolders.push({ name: fullPath, messageCount: folder.totalItemCount || 0 });
      }

      let children = folder.childFolders || [];
      if ((folder.childFolderCount || 0) > children.length && userId && folder.id) {
        try {
          children = await outlookClient.getChildFolders(userId, folder.id);
        } catch (e) {
          if (log) log.warn(`Destination folder enumeration: could not fetch children of "${fullPath}" (childFolderCount=${folder.childFolderCount}) — nested subtree omitted: ${e.message}`);
        }
      }
      if (children.length) {
        await this._walkOutlookFolders(children, defaults, fullPath, defaultFolders, customFolders, userId, log);
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
      // For G→O: keep source events for per-event detail comparison (P2-5)
      const sourceEventsForDetail = [];

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
            // Capture event metadata for per-event detail comparison
            for (const ev of items) {
              sourceEventsForDetail.push({
                subject: ev.summary || ev.title || '(no title)',
                startDateTime: ev.start?.dateTime || null,
                startDate: ev.start?.date || null,
                isAllDay: !!(ev.start && !ev.start.dateTime),
                attendeeCount: (ev.attendees || []).length,
              });
            }
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
          result.calendarValidation.eventDetails.push({
            subject: event.subject,
            calendarName: cal.name,
            isRecurring: !!event.recurrence,
            isAllDay: event.isAllDay,
            start: event.start,
            end: event.end,
            attendeeCount: (event.attendees || []).length,
          });
          if (event.recurrence) {
            result.calendarValidation.recurringEvents.push({ subject: event.subject, recurrencePattern: event.recurrence.pattern?.type });
          }
        }
        log.info(`  Calendar: ${cal.name} — ${events.length} events`);
      }
      result.calendarValidation.destinationEventCount = totalEvents;

      // ── P2-5: Per-event detail comparison for G→O ─────────────────────────
      if (sourceProvider !== 'microsoft' && sourceEventsForDetail.length > 0) {
        try {
          result.calendarValidation.eventDetailMismatches = [];

          // Approximate start-time matching: compare date portion only (YYYY-MM-DD)
          const getDateKey = (ev) => {
            if (ev.startDate) return ev.startDate;
            if (ev.startDateTime) return ev.startDateTime.substring(0, 10);
            return null;
          };

          for (const srcEv of sourceEventsForDetail) {
            const evSubjectLower = (srcEv.subject || '').toLowerCase().trim();
            const srcDateKey = getDateKey(srcEv);

            // Match by subject (case-insensitive) + approximate start date when available
            const destEv = result.calendarValidation.eventDetails.find((d) => {
              if ((d.subject || '').toLowerCase().trim() !== evSubjectLower) return false;
              if (!srcDateKey) return true; // no date info — match by subject only
              const destStart = d.start?.dateTime || d.start?.date || null;
              if (!destStart) return true;
              return destStart.substring(0, 10) === srcDateKey;
            });

            if (!destEv) {
              result.calendarValidation.eventDetailMismatches.push({
                subject: srcEv.subject,
                issue: 'Event not found in destination Outlook calendar by subject',
                severity: 'error',
              });
              continue;
            }

            // Attendee count check
            if (srcEv.attendeeCount > 0 && srcEv.attendeeCount !== (destEv.attendeeCount || 0)) {
              result.calendarValidation.eventDetailMismatches.push({
                subject: srcEv.subject,
                issue: `Attendee count differs: source=${srcEv.attendeeCount} dest=${destEv.attendeeCount || 0}`,
                severity: 'warning',
              });
            }

            // All-day flag check
            if (srcEv.isAllDay !== destEv.isAllDay) {
              result.calendarValidation.eventDetailMismatches.push({
                subject: srcEv.subject,
                issue: `All-day status differs: source=${srcEv.isAllDay} dest=${destEv.isAllDay}`,
                severity: 'warning',
              });
            }
          }

          if (result.calendarValidation.eventDetailMismatches.length > 0) {
            log.warn(`Calendar event detail mismatches: ${result.calendarValidation.eventDetailMismatches.length}`);
          } else {
            log.info('Calendar event detail comparison: no mismatches found');
          }
        } catch (detailErr) {
          log.warn(`Calendar per-event detail check failed (non-fatal): ${detailErr.message}`);
        }
      }
    } catch (err) {
      log.error(`E2E: Calendar validation failed: ${err.message}`);
      result.addMismatch('calendar', 'overall', 'accessible', err.message);
    }
  }
  /**
   * P2-6: Draft comparison for G→O.
   * Fetches source Gmail drafts and destination Outlook Drafts folder messages,
   * matches by subject (case-insensitive), and compares To-recipients.
   */
  async _validateDrafts(sourceUser, destUser, result, log) {
    log.info('Draft comparison (G→O): comparing source Gmail drafts vs destination Outlook Drafts...');
    try {
      const [gmailDraftsResult, outlookDraftsRaw] = await Promise.all([
        gmailClient.getGmailDraftDetails(sourceUser, 200),
        outlookClient.listMessagesInFolderPaged(
          destUser, 'drafts', 200,
          'id,subject,toRecipients,ccRecipients,isDraft'
        ).catch(() => []),
      ]);

      const gmailDrafts = gmailDraftsResult.drafts || [];
      const outlookDrafts = (outlookDraftsRaw || []).filter((m) => m.isDraft !== false);

      result.draftComparison = {
        available: true,
        sourceCount: gmailDrafts.length,
        destinationCount: outlookDrafts.length,
        countMatch: gmailDrafts.length === outlookDrafts.length,
        subjectMismatches: [],
      };

      // Match by normalized subject (case-insensitive, strip Re:/Fwd: prefix)
      const normalizeS = (s) =>
        String(s || '').toLowerCase().replace(/^re:|^fwd?:/i, '').replace(/\s+/g, ' ').trim();

      const outlookDraftMap = new Map(
        outlookDrafts.map((d) => [normalizeS(d.subject), d])
      );

      for (const gd of gmailDrafts) {
        const nk = normalizeS(gd.subject);
        const od = outlookDraftMap.get(nk);
        if (!od) {
          result.draftComparison.subjectMismatches.push({
            subject: gd.subject || '(no subject)',
            issue: 'Draft not found in Outlook Drafts folder by subject',
          });
          continue;
        }

        // Compare To-recipients
        const srcTo = parseRecipientEmails(gd.to).join(',');
        const dstTo = (od.toRecipients || [])
          .map((r) => (r.emailAddress?.address || '').toLowerCase())
          .sort()
          .join(',');
        if (srcTo && dstTo && srcTo !== dstTo) {
          result.draftComparison.subjectMismatches.push({
            subject: gd.subject || '(no subject)',
            issue: `To recipients differ: Gmail=[${srcTo}] Outlook=[${dstTo}]`,
          });
        }
      }

      log.info(
        `Draft comparison: src(Gmail)=${gmailDrafts.length} dst(Outlook)=${outlookDrafts.length} ` +
        `mismatches=${result.draftComparison.subjectMismatches.length}`
      );

      if (!result.draftComparison.countMatch) {
        result.addMismatch('mail', 'draftCount', gmailDrafts.length, outlookDrafts.length);
      }
    } catch (err) {
      log.warn(`Draft comparison failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * P3-10 (updated): Gmail filters → Outlook inbox rules comparison for G→O.
   * Gmail filters ARE inscoped for G→O migration by CloudFuze — they should be
   * migrated as Outlook inbox rules.  Compare source filter count vs destination
   * Outlook inbox rule count and flag discrepancies as a warning advisory.
   *
   * @param {string} sourceUser   - Source Gmail address
   * @param {string} destUser     - Destination Outlook address
   * @param {ValidationResult} result
   * @param {object} log
   */
  async _validateGmailFiltersAdvisory(sourceUser, destUser, result, log) {
    log.info('Gmail filters → Outlook rules (G→O): comparing source filters vs destination inbox rules...');
    try {
      const [filtersResult, dstRulesResult] = await Promise.all([
        gmailClient.getGmailFilters(sourceUser),
        outlookClient.getInboxRules(destUser).catch(() => ({ rules: [], available: false })),
      ]);
      const filters  = filtersResult.filters || [];
      const dstRules = dstRulesResult.rules   || [];

      result.rulesAdvisory = {
        available: filtersResult.available,
        count: filters.length,
        gmailFiltersCount: filters.length,
        gmailFiltersAvailable: filtersResult.available,
        outlookRulesCount: dstRules.length,
        outlookRulesAvailable: dstRulesResult.available,
        note: filters.length > 0
          ? `${filters.length} Gmail filter(s) at source — CloudFuze migrates Gmail filters as Outlook inbox rules (inscope). Destination has ${dstRules.length} inbox rule(s).`
          : `No Gmail filters detected at source. Destination has ${dstRules.length} inbox rule(s).`,
      };

      log.info(`Gmail filters → Outlook rules: source=${filters.length} filters, dest=${dstRules.length} inbox rules`);

      if (filters.length > 0 && dstRulesResult.available && filters.length !== dstRules.length) {
        result.addMismatch(
          'settings', 'gmailFiltersToOutlookRules',
          filters.length, dstRules.length,
          {
            severity: 'warning',
            message: `Source has ${filters.length} Gmail filter(s) but destination has ${dstRules.length} Outlook inbox rule(s). CloudFuze should migrate Gmail filters as Outlook rules — verify the migration included filter migration.`,
          }
        );
      }
    } catch (err) {
      log.warn(`Gmail filters advisory failed (non-fatal): ${err.message}`);
      result.rulesAdvisory = { available: false, count: 0, note: `Filter advisory check failed: ${err.message}` };
    }
  }

  // ── Outscope advisories (G→O) ─────────────────────────────────────────────

  /**
   * Inspect the source Gmail mailbox for features that are documented as outscope
   * for Gmail→Outlook migration and add informational advisory notes.
   *
   * These are severity:'info'/'warning' notices — they do NOT count as mismatches or failures.
   * They are appended to result.settingsValidation.advisories so the PDF report
   * can surface them in a dedicated advisory section.
   *
   * Checks:
   *   1. Gmail CATEGORY_* labels on messages — purchase/promotional category labels have no
   *      Outlook equivalent and are not migrated.
   *   2. Gmail filters — already covered by _validateGmailFiltersAdvisory, but we add a
   *      structured advisory entry here too if filters exist.
   */
  async _validateOutscopeAdvisories(srcUser, result, log) {
    log.info('Outscope advisories (G→O): inspecting source Gmail mailbox…');

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

    // ── 1. Gmail CATEGORY_* labels ────────────────────────────────────────────
    // CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_FORUMS
    // are Gmail-only inbox-categorisation tabs — they have no Outlook equivalent.
    try {
      const labels = await gmailClient.listLabels(srcUser, 'me');
      const categoryLabels = (labels || []).filter(
        (l) => /^CATEGORY_/i.test(l.id || '')
      );

      if (categoryLabels.length > 0) {
        // Count messages across all CATEGORY_* labels (best-effort, may overlap)
        let totalCategoryMessages = 0;
        const categoryNames = [];
        for (const lbl of categoryLabels) {
          categoryNames.push(lbl.name || lbl.id);
          try {
            const count = await gmailClient.getMessageCount(srcUser, 'me', lbl.id);
            totalCategoryMessages += count || 0;
          } catch { /* best-effort */ }
        }

        if (totalCategoryMessages > 0) {
          const catList = categoryNames.join(', ');
          const msg =
            `Source Gmail has ${totalCategoryMessages} message(s) across Gmail category labels ` +
            `(${catList}). ` +
            `Gmail category/inbox-tab labels (CATEGORY_PERSONAL, CATEGORY_SOCIAL, etc.) are NOT migrated ` +
            `to Outlook as categories or folders (outscope). ` +
            `Messages will appear in the appropriate Outlook default folders (Inbox, Junk, etc.) ` +
            `without these category tags.`;
          addAdvisory(msg, 'info');
          log.info(
            `Outscope advisory: ${totalCategoryMessages} message(s) in Gmail CATEGORY_* labels — not migrated as Outlook categories`
          );
        }
      }
    } catch (err) {
      log.warn(`Outscope advisory: CATEGORY_* labels check failed (non-fatal): ${err.message}`);
    }

    // ── 2. Gmail filters advisory (structured entry) ──────────────────────────
    // _validateGmailFiltersAdvisory already runs before this, but we add a structured
    // advisory entry here in case settingsValidation.advisories is the primary display surface.
    try {
      const filterCount = result.rulesAdvisory?.gmailFiltersCount ?? result.rulesAdvisory?.count ?? 0;
      if (filterCount > 0) {
        const msg =
          `${filterCount} Gmail filter(s) found at source. ` +
          `Gmail filters are NOT migrated to Outlook inbox rules (outscope). ` +
          `Recreate equivalent Outlook inbox rules manually after migration.`;
        // Only add if not already present to avoid duplication
        const alreadyPresent = result.settingsValidation.advisories.some(
          (a) => a.message && a.message.includes('Gmail filter') && a.message.includes('inbox rule')
        );
        if (!alreadyPresent) {
          addAdvisory(msg, 'warning');
        }
      }
    } catch (err) {
      log.warn(`Outscope advisory: filters structured advisory failed (non-fatal): ${err.message}`);
    }

    log.info(
      `Outscope advisories (G→O) complete: ${result.settingsValidation.advisories.length} total advisory item(s)`
    );
  }

  /**
   * Outlook→Outlook only: compare QA inbox rules, conditional formatting rules, and search
   * folders between source and destination, and verify that section-40/41/42 test emails
   * are present in the destination mailbox.
   */
  async _validateMailboxSettings(sourceUser, destUser, result, log) {
    log.info('Settings validation: comparing Outlook settings between source and destination...');
    result.settingsValidation.available = true;
    const sv = result.settingsValidation;

    // ── Inbox rules ──────────────────────────────────────────────────────────
    try {
      const [srcRulesResult, dstRulesResult] = await Promise.all([
        outlookClient.getInboxRules(sourceUser),
        outlookClient.getInboxRules(destUser),
      ]);
      const srcQaRules = (srcRulesResult.rules || []).filter((r) =>
        String(r.displayName || '').startsWith('QA')
      );
      const dstQaRules = (dstRulesResult.rules || []).filter((r) =>
        String(r.displayName || '').startsWith('QA')
      );
      sv.inboxRules.sourceCount = srcQaRules.length;
      sv.inboxRules.destCount   = dstQaRules.length;

      const dstRuleNames = new Set(dstQaRules.map((r) => r.displayName));
      for (const r of srcQaRules) {
        if (!dstRuleNames.has(r.displayName)) {
          sv.inboxRules.missing.push(r.displayName);
          result.addMismatch(
            'settings',
            `Inbox rule: ${r.displayName}`,
            'present in destination',
            'NOT FOUND'
          );
        }
      }
      log.info(
        `Settings: inbox rules — source QA: ${srcQaRules.length}, dest QA: ${dstQaRules.length}, missing: ${sv.inboxRules.missing.length}`
      );

      // ── O→O Filters/Rules: all-rules mismatch (inscope for O→O) ─────────────
      // Filters/rules is INSCOPE for O→O migration — Outlook inbox rules should
      // be migrated to the destination. If source has rules but destination has none,
      // flag it as a warning advisory.
      const srcAllRules = srcRulesResult.rules || [];
      const dstAllRules = dstRulesResult.rules || [];
      if (
        srcRulesResult.available !== false &&
        dstRulesResult.available !== false &&
        srcAllRules.length > 0 &&
        dstAllRules.length === 0
      ) {
        result.addMismatch(
          'settings',
          'outlookInboxRules',
          srcAllRules.length,
          0,
          {
            severity: 'warning',
            message: `${srcAllRules.length} Outlook inbox rule(s) at source — NOT found at destination. Filters/rules migration may have failed. Verify that the CloudFuze job version supports Outlook inbox rule migration.`,
          }
        );
        log.warn(
          `Settings: O→O inbox rules mismatch — source has ${srcAllRules.length} rule(s) but destination has 0`
        );
      }
    } catch (err) {
      log.warn(`Settings: inbox rules check failed: ${err.message}`);
    }

    // ── Conditional formatting rules ─────────────────────────────────────────
    try {
      const [srcCf, dstCf] = await Promise.all([
        outlookClient.ewsGetConditionalFormattingRules(sourceUser),
        outlookClient.ewsGetConditionalFormattingRules(destUser),
      ]);
      const srcQaCf = ((srcCf && srcCf.Rules) || []).filter((r) =>
        String(r.Name || '').startsWith('QA')
      );
      const dstQaCf = ((dstCf && dstCf.Rules) || []).filter((r) =>
        String(r.Name || '').startsWith('QA')
      );
      sv.conditionalFormatting.sourceCount = srcQaCf.length;
      sv.conditionalFormatting.destCount   = dstQaCf.length;

      const dstCfNames = new Set(dstQaCf.map((r) => r.Name));
      for (const r of srcQaCf) {
        if (!dstCfNames.has(r.Name)) {
          sv.conditionalFormatting.missing.push(r.Name);
          result.addMismatch(
            'settings',
            `Conditional formatting: ${r.Name}`,
            'present in destination',
            'NOT FOUND'
          );
        }
      }
      log.info(
        `Settings: CF rules — source QA: ${srcQaCf.length}, dest QA: ${dstQaCf.length}, missing: ${sv.conditionalFormatting.missing.length}`
      );
    } catch (err) {
      log.warn(`Settings: conditional formatting check failed: ${err.message}`);
    }

    // ── Search folders ────────────────────────────────────────────────────────
    try {
      const [srcFolders, dstFolders] = await Promise.all([
        outlookClient.listSearchFolders(sourceUser),
        outlookClient.listSearchFolders(destUser),
      ]);
      const srcQaSf = (srcFolders || []).filter((f) =>
        String(f.displayName || '').startsWith('QA')
      );
      const dstQaSf = (dstFolders || []).filter((f) =>
        String(f.displayName || '').startsWith('QA')
      );
      sv.searchFolders.sourceCount = srcQaSf.length;
      sv.searchFolders.destCount   = dstQaSf.length;

      const dstSfNames = new Set(dstQaSf.map((f) => f.displayName));
      for (const f of srcQaSf) {
        if (!dstSfNames.has(f.displayName)) {
          sv.searchFolders.missing.push(f.displayName);
          result.addMismatch(
            'settings',
            `Search folder: ${f.displayName}`,
            'present in destination',
            'NOT FOUND'
          );
        }
      }
      log.info(
        `Settings: search folders — source QA: ${srcQaSf.length}, dest QA: ${dstQaSf.length}, missing: ${sv.searchFolders.missing.length}`
      );
    } catch (err) {
      log.warn(`Settings: search folders check failed: ${err.message}`);
    }

    // ── Mailbox-level: verify section 40/41/42 emails in destination ──────────
    const mailboxChecks = [
      { key: 'section40', prefix: 'QA E2E 40 - ' },
      { key: 'section41', prefix: 'QA E2E 41 - ' },
      { key: 'section42', prefix: 'QA E2E 42 - ' },
    ];
    await Promise.all(
      mailboxChecks.map(async ({ key, prefix }) => {
        try {
          const { count, available } = await outlookClient.countMessagesBySubjectPrefix(destUser, prefix);
          if (!available) return;
          sv.mailboxChecks[key].found = count;
          const { total } = sv.mailboxChecks[key];
          if (count < total) {
            result.addMismatch(
              'settings',
              `${sv.mailboxChecks[key].label}`,
              `${total} emails in destination`,
              `${count} found`
            );
          }
          log.info(`Settings mailbox check: ${key} — ${count}/${total} emails found in destination`);
        } catch (err) {
          log.warn(`Settings mailbox check ${key} failed: ${err.message}`);
        }
      })
    );
  }
}

module.exports = OutlookValidationAgent;
