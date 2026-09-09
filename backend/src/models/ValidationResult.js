/** @typedef {'comparison'|'attachment'|'headers'|'subject'|'folder'|'infrastructure'|'mailbox'|'calendar'|'settings'|'other'} MismatchKind */

/**
 * Rewrite older, verbose body-mismatch wording stored on past executions to the
 * current short canonical phrasing, so PDFs regenerated from old data also read well.
 * Keeps three buckets: text body only, whole body, body+attachments missing.
 */
function shortenBodyDestinationText(text) {
  if (!text) return text;
  const s = String(text);
  if (/only the text body is missing|text body missing; attachments present/i.test(s)) {
    return 'Text body missing (attachments migrated OK). Re-migrate this message or raise a support ticket.';
  }
  if (/body is empty and attachments are not present|attachments are missing/i.test(s)) {
    return 'Body and attachments missing on destination. Re-migrate this message or raise a support ticket.';
  }
  if (/destination body is empty.*body not migrated|body not migrated.*raise a support ticket/i.test(s)) {
    return 'Body not migrated. Re-migrate this message or raise a support ticket.';
  }
  return text;
}

function buildStructuredDiffRowsFromDiffs(diffs, fallbackNote) {
  const LABELS = {
    from: 'From',
    to: 'To',
    cc: 'Cc',
    bcc: 'Bcc',
    replyTo: 'Reply-To',
    subject: 'Subject',
    body: 'Body',
    folder: 'Folder / labels',
    attachments: 'Attachments',
    starred: 'Starred → red flag',
    important: 'Important → high',
    readState: 'Read / Unread',
    flag: 'Flag status',
    importance: 'Importance',
    sentDateTime: 'Sent Date/Time',
    category: 'Category → label',
    sensitivity: 'Sensitivity label',
    oneDriveLink: 'OneDrive link',
    zoomLink: 'Zoom link',
    threadGrouping: 'Thread grouping',
    notFoundReason: 'Not Found Reason',
  };
  const RECIPIENT_FIELDS = new Set(['from', 'to', 'cc', 'bcc']);
  const rows = [];
  for (const d of diffs || []) {
    if (d.ok !== false) continue;
    const fk = String(d.field || '');
    if (fk === 'pairing') continue;
    const lab = fk.startsWith('attachmentHash') ? fk : LABELS[fk] || fk;

    let sourceExpected = String(d.displaySource ?? d.expected ?? '');
    let destinationActual = String(d.displayDestination ?? d.actual ?? '');

    /**
     * Body mismatches stored on older executions carry the original verbose wording. Rewrite
     * them to the current short phrasing at render time so regenerated PDFs read consistently.
     */
    if (fk === 'body') {
      destinationActual = shortenBodyDestinationText(destinationActual);
    }

    /**
     * Recipient fields (From/To/Cc/Bcc) are compared *after* applying the permission mapping
     * (e.g. alex@cloudfuze.us → alex@gajha.com). The comparator stores the raw source in
     * displaySource and the destination's actual value in displayDestination; the mapped
     * "expected" value lives on `expected`. When the raw source still matches the
     * destination (because CloudFuze preserves original addresses), both display columns
     * look identical to the reader — hiding the real reason the row failed. Surface the
     * expected-after-mapping value so the mismatch is actually visible.
     */
    if (
      RECIPIENT_FIELDS.has(fk) &&
      sourceExpected === destinationActual &&
      d.expected != null &&
      String(d.expected) !== destinationActual
    ) {
      destinationActual = `${destinationActual} — expected "${d.expected}" after applying permission mapping`;
    }

    rows.push({
      fieldKey: fk,
      fieldLabel: lab,
      sourceExpected,
      destinationActual,
      severity: d.severity || 'error',
    });
  }
  if (rows.length === 0 && fallbackNote) {
    rows.push({
      fieldKey: 'note',
      fieldLabel: 'Error',
      sourceExpected: '—',
      destinationActual: String(fallbackNote),
      severity: 'error',
    });
  }
  return rows;
}

function classifyDeepMailMismatch(errDiffs, detail, note) {
  const blob = `${detail || ''} ${note || ''}`;
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|getaddrinfo|EAI_|full read failed|token failed|network/i.test(blob)) {
    return {
      kind: 'infrastructure',
      kindLabel: 'Network / API connectivity',
      summaryLine: note || blob.substring(0, 200),
    };
  }
  const fields = new Set((errDiffs || []).map((d) => String(d.field || '')));
  if (fields.has('attachments') || /\battachments:/i.test(blob)) {
    return {
      kind: 'attachment',
      kindLabel: 'Attachments (Tier A manifest)',
      summaryLine: detail ? detail.split(';')[0]?.trim().substring(0, 240) || detail : blob,
    };
  }
  if (
    [...fields].some((f) =>
      ['from', 'to', 'cc', 'bcc'].includes(f)
    )
  ) {
    return {
      kind: 'headers',
      kindLabel: 'Recipients / From (permission mapping)',
      summaryLine: detail ? detail.substring(0, 240) : blob,
    };
  }
  if (fields.has('subject')) {
    return { kind: 'subject', kindLabel: 'Subject line', summaryLine: detail?.substring(0, 240) || blob };
  }
  if (fields.has('folder') || fields.has('starred') || fields.has('important')) {
    return {
      kind: 'folder',
      kindLabel: 'Folder / label placement (Gmail → Outlook mapping)',
      summaryLine: detail ? detail.substring(0, 240) : blob,
    };
  }
  return {
    kind: 'other',
    kindLabel: 'Deep mail check',
    summaryLine: detail || note || 'validation failed',
  };
}

class ValidationResult {
  constructor() {
    this.mailValidation = {
      sourceCount: 0,
      destinationCount: 0,
      countMatch: false,
      folderMapping: [],
      attachmentChecks: [],
      subjectChecks: [],
    };
    this.calendarValidation = {
      sourceEventCount: 0,
      destinationEventCount: 0,
      /** Distinct calendar count (source Google vs destination Outlook). */
      sourceCalendarCount: 0,
      destinationCalendarCount: 0,
      countMatch: false,
      recurringEvents: [],
      primaryCalendar: null,
      secondaryCalendars: [],
      eventDetails: [],
      attachmentMismatches: [],
      eventDetailMismatches: [],
    };
    this.draftComparison = null;
    /**
     * Contacts totals (Google People API vs Graph /me/contacts). Defaults to 0 when the run
     * didn't request contacts validation; the summary still renders the row with "0" so the
     * 4-metric layout stays consistent.
     */
    this.contactsValidation = {
      sourceCount: 0,
      destinationCount: 0,
      countMatch: false,
      available: false,
      fieldMismatches: [],
      photoMismatches: [],
    };
    this.rulesAdvisory = null;
    this.mailboxSizeValidation = null;
    /**
     * Settings-level + mailbox-level validation for Outlook→Outlook runs.
     * Only populated when sourceProvider === 'microsoft'.
     */
    this.settingsValidation = {
      available: false,
      inboxRules: {
        sourceCount: 0,
        destCount: 0,
        missing: [],
      },
      conditionalFormatting: {
        sourceCount: 0,
        destCount: 0,
        missing: [],
      },
      searchFolders: {
        sourceCount: 0,
        destCount: 0,
        missing: [],
      },
      mailboxChecks: {
        section40: { label: 'Conditional Formatting emails (§40)', found: 0, total: 8 },
        section41: { label: 'Email Forwarding emails (§41)',       found: 0, total: 3 },
        section42: { label: 'Search Folder emails (§42)',          found: 0, total: 13 },
      },
    };
    this.sourceData = {
      defaultLabels: [],
      customLabels: [],
    };
    this.destinationData = {
      defaultFolders: [],
      customFolders: [],
    };
    this.comparison = {
      defaultLabelsMatch: false,
      customLabelsMatch: false,
      issues: [],
    };
    this.mismatches = [];
    this.overallStatus = 'PENDING';
    /** AI-generated failure analysis (populated by AgentBrain after validation, only on FAIL) */
    this.aiAnalysis = null;
    /** Deep source↔destination mail comparison (optional) */
    this.deepMailValidation = {
      enabled: false,
      scannedSourceMessages: 0,
      pairedCount: 0,
      skippedCount: 0,
      unmatchedSourceIds: [],
      ambiguousInternetMessageIds: [],
      messageResults: [],
      /** Per-conversation thread chain results (Outlook→Gmail only) */
      threadChainResults: [],
      summary: '',
    };
    /**
     * Deep source↔destination CONTENT comparison (files/folders). Defaults to disabled so every
     * existing consumer and persisted document stays valid.
     * Populated by validation/combinations/content/<combo>.js; feature reference:
     * backend/data/feature-scope/*-inscope.md
     */
    this.deepContentValidation = {
      enabled: false,
      scannedSourceItems: 0,
      pairedCount: 0,
      skippedCount: 0,
      missing: [],
      extra: [],
      misplaced: [],
      /** Items over the SharePoint path limit — a placeholder link is the documented outcome. */
      placeholderLinks: [],
      /** Google-only types (Forms, Sites, Maps, shortcuts) that have no SharePoint equivalent. */
      notMigratable: [],
      /** Source roles with no comparable destination permission (e.g. ownership). Reported, not failed. */
      notComparable: [],
      hashedCount: 0,
      /** Files deliberately NOT byte-compared (converted/native/capped), each with its reason. */
      notHashedCount: 0,
      hashMismatches: [],
      permissionMismatches: [],
      sharedLinkMismatches: [],
      conversionMismatches: [],
      timestampDrift: [],
      /** Version differences are informational — the Google API merges revisions. Never a failure. */
      versionInfo: [],
      notificationLeaks: [],
      /** Per-feature pass/fail/na rollup against the combination's documented feature list. */
      featureChecklist: [],
      featureSummary: null,
      itemResults: [],
      summary: '',
    };
  }

  /**
   * @param {object} row - { path, name, type, found, destName?, permissions?, sharedLinks?,
   *                         versions?, timestamps?, contentHash? }
   */
  addDeepContentItemResult(row) {
    this.deepContentValidation.itemResults.push(row);
  }

  addMismatch(category, field, expected, actual) {
    const kind =
      category === 'mail'     ? 'mailbox'  :
      category === 'calendar' ? 'calendar' :
      category === 'settings' ? 'settings' :
      'other';
    const kindLabel =
      category === 'mail'     ? 'Mailbox check'  :
      category === 'calendar' ? 'Calendar check' :
      category === 'settings' ? 'Settings / Rules' :
      'Validation';
    this.mismatches.push({
      category,
      kind,
      kindLabel,
      field,
      expected,
      actual,
      summaryLine: `${field}: ${actual}`,
    });
  }

  /**
   * @param {object} row - { internetMessageId, sourceMessageId, destMessageId?, pass, diffs?, note? }
   */
  addDeepMailMessageResult(row) {
    this.deepMailValidation.messageResults.push(row);
  }

  addComparisonIssue(type, label, sourceCount, destCount) {
    this.comparison.issues.push({ type, label, sourceCount, destCount });
  }

  computeOverallStatus() {
    if (this.comparison.issues.length > 0) {
      this.mismatches.push(
        ...this.comparison.issues.map((i) => ({
          category: 'comparison',
          kind: 'comparison',
          kindLabel: 'Folder/label counts',
          field: i.label,
          expected: `${i.sourceCount} (source messages)`,
          actual: `${i.destCount} (destination messages)`,
          summaryLine: `${i.label}: expected ${i.sourceCount} vs actual ${i.destCount}`,
        }))
      );
    }

    if (this.deepMailValidation.enabled && Array.isArray(this.deepMailValidation.threadChainResults)) {
      for (const t of this.deepMailValidation.threadChainResults) {
        if (t.pass) continue;
        if (t.bugStatus === 'known_limitation') continue;
        const errMismatches = (t.mismatches || []).filter((m) => m.severity === 'error');
        this.mismatches.push({
          category: 'deepMail',
          kind: 'other',
          kindLabel: 'Thread chain integrity',
          field: t.conversationId || 'unknown',
          expected: `${t.outlookMessageCount} message(s) in thread`,
          actual: `${t.gmailMessageCount} message(s) in Gmail thread${t.threadSplit ? ' (thread split)' : ''}`,
          summaryLine: `Thread "${(t.rootSubject || '').substring(0, 80)}": Outlook=${t.outlookMessageCount} Gmail=${t.gmailMessageCount}${t.threadSplit ? ' SPLIT' : ''}`,
          structuredDiffs: errMismatches.map((m) => ({
            fieldKey: m.field,
            fieldLabel: m.field === 'threadCount' ? 'Thread message count'
              : m.field === 'threadSplit' ? 'Thread split'
              : m.field === 'threadSubject' ? 'Thread subject'
              : m.field,
            sourceExpected: String(m.displaySource ?? m.expected ?? ''),
            destinationActual: String(m.displayDestination ?? m.actual ?? ''),
            severity: m.severity || 'error',
          })),
          messageSubject: t.rootSubject || '',
        });
      }
    }

    if (this.deepMailValidation.enabled && Array.isArray(this.deepMailValidation.messageResults)) {
      for (const r of this.deepMailValidation.messageResults) {
        if (r.pass) continue;
        if (r.bugStatus === 'known_limitation') continue;
        const errDiffs = (r.diffs || []).filter((d) => d.severity === 'error');
        const detail = errDiffs.length
          ? errDiffs.map((d) => `${d.field}: expected ${d.expected ?? ''} / actual ${d.actual ?? ''}`).join('; ')
          : '';
        const ref = r.internetMessageId || r.sourceMessageId || 'unknown';
        const classified = classifyDeepMailMismatch(errDiffs, detail, r.note);
        const structuredDiffs = buildStructuredDiffRowsFromDiffs(r.diffs, r.note);
        this.mismatches.push({
          category: 'deepMail',
          ...classified,
          field: ref,
          expected: classified.kindLabel,
          actual: detail || r.note || 'validation failed',
          summaryLine:
            classified.summaryLine?.length > 200
              ? `${classified.summaryLine.substring(0, 197)}…`
              : classified.summaryLine,
          structuredDiffs,
          messageSubject: r.subject || '',
        });
      }
    }

    this.overallStatus = this.mismatches.length === 0 ? 'PASS' : 'FAIL';
    return this.overallStatus;
  }

  toJSON() {
    return {
      mailValidation: this.mailValidation,
      calendarValidation: this.calendarValidation,
      contactsValidation: this.contactsValidation,
      rulesAdvisory: this.rulesAdvisory,
      mailboxSizeValidation: this.mailboxSizeValidation,
      settingsValidation: this.settingsValidation,
      draftComparison: this.draftComparison,
      sourceData: this.sourceData,
      destinationData: this.destinationData,
      comparison: this.comparison,
      deepMailValidation: this.deepMailValidation,
      deepContentValidation: this.deepContentValidation,
      mismatches: this.mismatches,
      overallStatus: this.overallStatus,
      aiAnalysis: this.aiAnalysis,
      // Inscope feature validations (added for docs API coverage)
      ...(this.starredValidation         !== undefined && { starredValidation: this.starredValidation }),
      ...(this.groupCalendarValidation   !== undefined && { groupCalendarValidation: this.groupCalendarValidation }),
      ...(this.archiveMigration          !== undefined && { archiveMigration: this.archiveMigration }),
      ...(this.archiveAllMailValidation  !== undefined && { archiveAllMailValidation: this.archiveAllMailValidation }),
      ...(this.archiveMailboxRequested   !== undefined && { archiveMailboxRequested: this.archiveMailboxRequested }),
    };
  }
}

ValidationResult.buildStructuredDiffRowsFromDiffs = buildStructuredDiffRowsFromDiffs;

module.exports = ValidationResult;
