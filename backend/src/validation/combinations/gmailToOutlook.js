// gmailToOutlook — deep mail validation for this combination.
// Owned per-combination; edit only this file for gmailToOutlook deep-validation logic.
const {
  compareTierA,
  compareTierC,
  compareTierBHashes,
  sha256Hex,
  normalizeSubject,
  graphRecipientsToEmails,
  parseRecipientEmails,
  buildRecipientEmailMapping,
  compareFolderPlacement,
  validateGmailToOutlookPlacement,
  parseGmailLabels,
  normalizeMailBodyPlain,
  htmlToPlainLoose,
  compareOutlookReadToGmailUnread,
  compareGmailUnreadToOutlookIsRead,
  compareReadState,
  compareOutlookFlagToGmailStarred,
  compareFlagState,
  compareOutlookImportanceToGmailImportant,
  compareImportanceOutlookToOutlook,
  compareSentDateTime,
  compareAttachmentSizesWithTolerance,
  gmailClient,
  outlookClient,
  OUTLOOK_SKIP_SCAN_FOLDERS,
  OUTLOOK_FOLDER_TO_GMAIL_LABEL,
  OUTLOOK_PLACEMENT_SKIP,
  extractZoomLinks,
  compareZoomLinks,
  extractOneDriveLinks,
  compareOneDriveLinks,
  boolEnv,
  intEnv,
  buildDestinationUnmatchedNote,
  gmailSystemLabelsForDeepValidation,
  graphAttachmentsToCompareList,
  tierBHashesGmail,
  tierBHashesOutlookToOutlook,
  tierBHashesOutlookToGmail,
  collectOutlookQaCandidates,
  validateOutlookToGmailPlacement,
  stripQuotedLines,
  validateOutlookToGmailThreadChains,
  validateOutlookToOutlookThreadChains,
  tierBHashesGmailToGmail,
} = require('../shared/deepMailCore');

async function validateGmailSource({
  context,
  result,
  destUser,
  srcUser,
  maxMessages,
  subjectPrefix,
  tierB,
  tierC,
  log,
}) {
  const recipientMap = buildRecipientEmailMapping(context.userEmailMappings, {
    sourceEmail: context.sourceEmail,
    destinationEmail: context.destinationEmail,
  });
  const tierAOpts = {
    compareBcc: true,
    bccAsError: true,
    recipientMapping: recipientMap.size > 0 ? recipientMap : null,
  };

  let labelIdToName = new Map();
  try {
    const lbls = await gmailClient.listLabels(srcUser, 'me');
    labelIdToName = new Map((lbls || []).map((l) => [l.id, l.name]));
  } catch (e) {
    log.warn(`Deep validation: could not list Gmail labels for folder compare: ${e.message}`);
  }

  let labelIds = gmailSystemLabelsForDeepValidation();
  // ALL_CUSTOM: expand to every user-created label so nested/custom folder messages are scanned
  if (labelIds.includes('ALL_CUSTOM')) {
    labelIds = labelIds.filter((id) => id !== 'ALL_CUSTOM');
    try {
      const allLabels = await gmailClient.listLabels(srcUser, 'me');
      for (const lbl of allLabels || []) {
        if (lbl.type !== 'system') labelIds.push(lbl.id);
      }
    } catch (e) {
      log.warn(`Deep validation: could not list Gmail custom labels for ALL_CUSTOM expansion: ${e.message}`);
    }
  }
  const idCap = Math.min(maxMessages * 15, 7500);
  const perLabelCap = Math.max(Math.ceil(idCap / Math.max(labelIds.length, 1)), 100);
  const idSet = new Set();
  for (const labelId of labelIds) {
    try {
      const chunk = await gmailClient.listMessageIdsForLabelUpTo(srcUser, labelId, perLabelCap);
      for (const id of chunk) idSet.add(id);
    } catch (e) {
      log.warn(`Deep validation: could not list messages for Gmail label "${labelId}": ${e.message}`);
    }
  }
  const allIds = [...idSet];

  const qaIds = [];
  for (const id of allIds) {
    let meta;
    try {
      meta = await gmailClient.getMessageMetadata(srcUser, id, 'metadata');
    } catch (e) {
      log.warn(`Deep validation: metadata ${id}: ${e.message}`);
      continue;
    }
    const sub = normalizeSubject(meta.subject);
    if (!sub.startsWith(subjectPrefix) && !/^QA\b/i.test(sub)) continue;
    qaIds.push(id);
    if (qaIds.length >= maxMessages) break;
  }

  result.deepMailValidation.scannedSourceMessages = qaIds.length;

  for (const id of qaIds) {
    let full;
    try {
      full = await gmailClient.getMessageFullForValidation(srcUser, id);
    } catch (e) {
      result.addDeepMailMessageResult({
        sourceMessageId: id,
        internetMessageId: '',
        destMessageId: null,
        subject: '',
        pass: false,
        note: `Gmail full read failed: ${e.message}`,
        diffs: [],
      });
      continue;
    }

    const mid = full.internetMessageId;
    if (!mid) {
      result.addDeepMailMessageResult({
        sourceMessageId: id,
        internetMessageId: '',
        destMessageId: null,
        subject: full.subject || '',
        pass: false,
        note: 'Missing Message-ID header on source',
        diffs: [],
      });
      continue;
    }

    const scanMax = intEnv('DEEP_VALIDATION_SCAN_MAX', 3000);
    const windowMin = intEnv('DEEP_VALIDATION_SUBJECT_TIME_WINDOW_MINUTES', 120);
    const resolved = await outlookClient.resolveDestinationByInternetMessageId(destUser, mid, {
      maxScan: scanMax,
    });
    let matches = resolved.matches;
    let pairingStrategy = 'internetMessageId';
    /** @type {{ windowMin: number, fb: { match: object, candidatesCount: number, bestDeltaMs: number | null, detail: string } } | null} */
    let pairingMeta = null;

    if (matches.length === 0 && boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true)) {
      const normSub = normalizeSubject(full.subject);
      let anchorMs =
        full.internalDateMs != null && Number.isFinite(Number(full.internalDateMs))
          ? Number(full.internalDateMs)
          : null;
      if (anchorMs == null) {
        const parsed = Date.parse(full.date || full.headers?.date || '');
        anchorMs = Number.isFinite(parsed) ? parsed : null;
      }
      if (anchorMs != null && Number.isFinite(anchorMs)) {
        const fb = await outlookClient.findBestMessageBySubjectAndTime(
          destUser,
          normSub,
          anchorMs,
          windowMin,
          scanMax
        );
        if (fb.match) {
          matches = [fb.match];
          pairingStrategy = 'subject-time';
          pairingMeta = { windowMin, fb };
        }
      }
    }

    if (matches.length === 0) {
      result.deepMailValidation.unmatchedSourceIds.push(id);
      let unmatchedNote = buildDestinationUnmatchedNote(resolved, scanMax);
      let anchorMs =
        full.internalDateMs != null && Number.isFinite(Number(full.internalDateMs))
          ? Number(full.internalDateMs)
          : null;
      if (anchorMs == null) {
        const parsed = Date.parse(full.date || full.headers?.date || '');
        anchorMs = Number.isFinite(parsed) ? parsed : null;
      }
      if (boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true)) {
        if (anchorMs == null) {
          unmatchedNote += ' Subject+time fallback skipped (no Gmail internalDate / Date header).';
        } else {
          unmatchedNote += ` Subject+time fallback (±${windowMin}m) also found no candidate.`;
        }
      }
      const srcFolderLabelG2O = gmailClient.formatGmailLabelsForCompare(full.labelIds, labelIdToName);
      const srcDateG2O = full.date || (full.internalDateMs ? new Date(Number(full.internalDateMs)).toUTCString() : '') || '';
      const notFoundDiffsG2O = [
        { field: 'notFoundReason', ok: false, displaySource: '—', displayDestination: unmatchedNote, severity: 'error' },
        ...(full.subject ? [{ field: 'subject', ok: false, displaySource: full.subject, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(srcFolderLabelG2O ? [{ field: 'folder', ok: false, displaySource: srcFolderLabelG2O, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(full.from ? [{ field: 'from', ok: false, displaySource: full.from, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(srcDateG2O ? [{ field: 'sentDateTime', ok: false, displaySource: srcDateG2O, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
      ];
      result.addDeepMailMessageResult({
        sourceMessageId: id,
        internetMessageId: mid,
        destMessageId: null,
        subject: full.subject || '',
        pass: false,
        note: unmatchedNote,
        diffs: notFoundDiffsG2O,
      });
      continue;
    }

    if (matches.length > 1) {
      result.deepMailValidation.ambiguousInternetMessageIds.push(mid);
    }

    const destSummary = matches[0];
    let destFull;
    try {
      destFull = await outlookClient.getMessageById(destUser, destSummary.id);
    } catch (e) {
      result.addDeepMailMessageResult({
        sourceMessageId: id,
        internetMessageId: mid,
        destMessageId: destSummary.id,
        subject: full.subject || '',
        pass: false,
        note: `Destination message load failed: ${e.message}`,
        diffs: [],
      });
      continue;
    }

    let graphAtt = [];
    try {
      graphAtt = await outlookClient.getAttachments(destUser, destSummary.id);
    } catch (e) {
      log.warn(`Deep validation: dest attachments: ${e.message}`);
    }

    const sourceForTierA = {
      subject: full.subject,
      from: full.from,
      to: full.to,
      cc: full.cc,
      bcc: full.bcc,
      replyTo: full.replyTo || '',
      attachments: (full.attachments || []).map((a) => ({
        filename: a.filename,
        size: a.size,
      })),
    };

    const destForTierA = {
      subject: destFull.subject,
      from: destFull.from,
      toRecipients: destFull.toRecipients,
      ccRecipients: destFull.ccRecipients,
      bccRecipients: destFull.bccRecipients,
      replyTo: destFull.replyTo,
      attachments: graphAttachmentsToCompareList(graphAtt),
    };

    let diffs = [];
    if (pairingStrategy === 'subject-time' && pairingMeta?.fb) {
      const fb = pairingMeta.fb;
      diffs.push({
        field: 'pairing',
        ok: true,
        expected: 'internetMessageId',
        actual: `subject+time fallback (±${pairingMeta.windowMin} min, ${fb.candidatesCount} candidate(s), best Δ ${Math.round((fb.bestDeltaMs || 0) / 1000)}s)`,
        severity: 'warning',
      });
    }
    diffs = diffs.concat(compareTierA(sourceForTierA, destForTierA, tierAOpts));

    // Attachment size comparison — accounts for Gmail decoded vs Graph base64+MIME encoding overhead
    diffs = diffs.concat(
      compareAttachmentSizesWithTolerance(sourceForTierA.attachments, destForTierA.attachments, 'gmail_to_outlook')
    );

    const srcFolderStr = gmailClient.formatGmailLabelsForCompare(full.labelIds, labelIdToName);
    let destFolderStr = '';
    if (destFull.parentFolderId) {
      try {
        destFolderStr = await outlookClient.getMailFolderPathString(destUser, destFull.parentFolderId);
      } catch (e) {
        log.warn(`Deep validation: Outlook folder path: ${e.message}`);
      }
    }

    /**
     * CloudFuze Gmail → Outlook folder / flag / importance mapping (documented mapping):
     *   INBOX → Inbox, SENT → Sent Items, DRAFT → Drafts, TRASH → Deleted Items, SPAM → Junk Email
     *   CATEGORY_* → CATEGORY_* folders; custom Gmail labels → same-name Outlook folders.
     *   STARRED → Outlook red flag (flag.flagStatus = flagged); kept in original folder when the
     *             message has another primary label, or in a YELLOW_STAR folder when STARRED-only.
     *   IMPORTANT → Outlook importance = high (exclamation mark); stays in original folder.
     *   SNOOZED / SCHEDULED → not migrated; surfaced as an error if they appear in Outlook.
     *
     * Migrate Orphaned Labels: drives whether "All-Mail-only" Gmail messages (no labels) are
     * expected in an "Archive" folder on Outlook or should be absent. Caller passes the flag via
     * context.migrateOrphanedLabels — defaults to false (match CloudFuze job default).
     */
    const labelNames = parseGmailLabels(srcFolderStr);
    const severity = boolEnv('MAIL_DEEP_FOLDER_WARNING_ONLY', false) === true ? 'warning' : 'error';
    diffs = diffs.concat(
      validateGmailToOutlookPlacement({
        gmailLabels: labelNames,
        destFolderPath: destFolderStr,
        destFlag: destFull.flag || null,
        destImportance: destFull.importance || null,
        options: {
          migrateOrphaned: Boolean(context.migrateOrphanedLabels),
          severity,
        },
      })
    );

    // Read state: Gmail UNREAD label → Outlook isRead (warning)
    diffs = diffs.concat(compareGmailUnreadToOutlookIsRead(full.labelIds, destFull.isRead));

    // sentDateTime: Gmail Date header (original sent time) vs Outlook sentDateTime (warning)
    {
      const toleranceMs = intEnv('DEEP_VALIDATION_SENT_TIME_TOLERANCE_MINUTES', 5) * 60000;
      diffs = diffs.concat(compareSentDateTime(full.date, destFull.sentDateTime, toleranceMs));
    }

    if (tierC) {
      /**
       * Gmail multipart/alternative seeds a distinct plain-text fallback. Outlook body.content
       * carries the HTML part. Compare HTML→plain on both sides when the source has HTML; only
       * fall back to the plain part when the source has no HTML body at all.
       */
      const srcHtml = gmailClient.extractHtmlBodyFromPayload(full.payload);
      const bodyPlain = srcHtml
        ? htmlToPlainLoose(srcHtml)
        : gmailClient.extractPlainBodyFromPayload(full.payload) || full.snippet || '';
      const bodyMax = intEnv('MAIL_DEEP_BODY_MAX_CHARS', 500000);
      diffs = diffs.concat(
        compareTierC(bodyPlain, destFull.body?.content || destFull.bodyPreview || '', {
          bodyMismatchSeverity: 'error',
          maxChars: bodyMax,
          hasAttachments: (full.attachments || []).length > 0,
          destHasAttachments: (graphAtt || []).length > 0,
        })
      );
    }

    if (tierB && (full.attachments || []).length > 0) {
      try {
        const { srcHashes, dstHashes } = await tierBHashesGmail(
          srcUser,
          full,
          destUser,
          destSummary.id,
          graphAtt,
          log
        );
        const tierBDiffs = compareTierBHashes(srcHashes, dstHashes);
        // When all hashes match, content is verified — downgrade size-discrepancy warnings to info
        if (tierBDiffs.every((d) => d.ok !== false)) {
          for (const d of diffs) {
            if (d.field?.startsWith('attachmentSize:') && d.severity === 'warning') {
              d.severity = 'info';
              d.ok = true;
              d.note = '[Tier B hash verified — content is identical] ' + (d.note || '');
            }
          }
        }
        diffs = diffs.concat(tierBDiffs);
      } catch (e) {
        log.warn(`Tier B hash: ${e.message}`);
      }
    }

    const hasError = diffs.some((d) => d.severity === 'error');
    result.addDeepMailMessageResult({
      sourceMessageId: id,
      internetMessageId: mid,
      destMessageId: destSummary.id,
      subject: full.subject || '',
      pass: !hasError,
      diffs,
    });
  }
}

module.exports = { validateGmailSource };
