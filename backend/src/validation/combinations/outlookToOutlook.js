// outlookToOutlook — deep mail validation for this combination.
// Owned per-combination; edit only this file for outlookToOutlook deep-validation logic.
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
  compareSensitivityOutlookToOutlook,
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
  validateMailOrderByTimestamp,
} = require('../shared/deepMailCore');

async function validateOutlookSource({
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

  const candidates = await collectOutlookQaCandidates(
    srcUser, maxMessages, subjectPrefix,
    'id,internetMessageId,subject,hasAttachments,receivedDateTime,sentDateTime',
    log
  );

  result.deepMailValidation.scannedSourceMessages = candidates.length;

  for (const summary of candidates) {
    const mid = summary.internetMessageId || '';
    if (!mid) {
      result.addDeepMailMessageResult({
        sourceMessageId: summary.id,
        internetMessageId: '',
        destMessageId: null,
        subject: summary.subject || '',
        pass: false,
        note: 'Missing internetMessageId on source',
        diffs: [],
      });
      continue;
    }

    let srcFull;
    try {
      srcFull = await outlookClient.getMessageById(srcUser, summary.id);
    } catch (e) {
      result.addDeepMailMessageResult({
        sourceMessageId: summary.id,
        internetMessageId: mid,
        destMessageId: null,
        subject: summary.subject || '',
        pass: false,
        note: `Source message load failed: ${e.message}`,
        diffs: [],
      });
      continue;
    }

    let graphAttSrc = [];
    try {
      graphAttSrc = await outlookClient.getAttachments(srcUser, summary.id);
    } catch (e) {
      log.warn(`Deep validation: source attachments: ${e.message}`);
    }

    const scanMaxOO = intEnv('DEEP_VALIDATION_SCAN_MAX', 3000);
    const windowMinOO = intEnv('DEEP_VALIDATION_SUBJECT_TIME_WINDOW_MINUTES', 120);
    const resolvedOO = await outlookClient.resolveDestinationByInternetMessageId(destUser, mid, {
      maxScan: scanMaxOO,
    });
    let matches = resolvedOO.matches;
    let pairingStrategyOO = 'internetMessageId';
    /** @type {{ windowMin: number, fb: { match: object, candidatesCount: number, bestDeltaMs: number | null, detail: string } } | null} */
    let pairingMetaOO = null;

    if (matches.length === 0 && boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true)) {
      const normSub = normalizeSubject(srcFull.subject);
      const anchorMsOO = new Date(srcFull.receivedDateTime || srcFull.sentDateTime || 0).getTime();
      if (Number.isFinite(anchorMsOO)) {
        const fb = await outlookClient.findBestMessageBySubjectAndTime(
          destUser,
          normSub,
          anchorMsOO,
          windowMinOO,
          scanMaxOO
        );
        if (fb.match) {
          matches = [fb.match];
          pairingStrategyOO = 'subject-time';
          pairingMetaOO = { windowMin: windowMinOO, fb };
        }
      }
    }

    if (matches.length === 0) {
      let noteOO = buildDestinationUnmatchedNote(resolvedOO, scanMaxOO);
      const anchorMsOO = new Date(srcFull.receivedDateTime || srcFull.sentDateTime || 0).getTime();
      if (boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true)) {
        if (!Number.isFinite(anchorMsOO)) {
          noteOO += ' Subject+time fallback skipped (no source received/sent time).';
        } else {
          noteOO += ` Subject+time fallback (±${windowMinOO}m) also found no candidate.`;
        }
      }
      result.deepMailValidation.unmatchedSourceIds.push(summary.id);
      let srcFolderPathOO = '';
      if (srcFull.parentFolderId) {
        try { srcFolderPathOO = await outlookClient.getMailFolderPathString(srcUser, srcFull.parentFolderId); } catch (_) { /* skip */ }
      }
      const srcFromOO = srcFull.from?.emailAddress?.address || srcFull.from?.emailAddress?.name || '';
      const srcDateOO = srcFull.sentDateTime || srcFull.receivedDateTime || '';
      const notFoundDiffsOO = [
        { field: 'notFoundReason', ok: false, displaySource: '—', displayDestination: noteOO, severity: 'error' },
        ...(srcFull.subject ? [{ field: 'subject', ok: false, displaySource: srcFull.subject, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(srcFolderPathOO ? [{ field: 'folder', ok: false, displaySource: srcFolderPathOO, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(srcFromOO ? [{ field: 'from', ok: false, displaySource: srcFromOO, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(srcDateOO ? [{ field: 'sentDateTime', ok: false, displaySource: srcDateOO, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
      ];
      result.addDeepMailMessageResult({
        sourceMessageId: summary.id,
        internetMessageId: mid,
        destMessageId: null,
        subject: srcFull.subject || summary.subject || '',
        pass: false,
        note: noteOO,
        diffs: notFoundDiffsOO,
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
        sourceMessageId: summary.id,
        internetMessageId: mid,
        destMessageId: destSummary.id,
        subject: srcFull.subject || summary.subject || '',
        pass: false,
        note: `Destination message load failed: ${e.message}`,
        diffs: [],
      });
      continue;
    }

    let graphAttDst = [];
    try {
      graphAttDst = await outlookClient.getAttachments(destUser, destSummary.id);
    } catch (e) {
      log.warn(`Deep validation: dest attachments: ${e.message}`);
    }

    const sourceForTierA = {
      subject: srcFull.subject,
      from: srcFull.from,
      toEmails: graphRecipientsToEmails(srcFull.toRecipients),
      ccEmails: graphRecipientsToEmails(srcFull.ccRecipients),
      bccEmails: graphRecipientsToEmails(srcFull.bccRecipients),
      replyTo: srcFull.replyTo,
      attachments: graphAttachmentsToCompareList(graphAttSrc).map((a) => ({
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
      attachments: graphAttachmentsToCompareList(graphAttDst),
    };

    let diffsOO = [];
    if (pairingStrategyOO === 'subject-time' && pairingMetaOO?.fb) {
      const fb = pairingMetaOO.fb;
      diffsOO.push({
        field: 'pairing',
        ok: true,
        expected: 'internetMessageId',
        actual: `subject+time fallback (±${pairingMetaOO.windowMin} min, ${fb.candidatesCount} candidate(s), best Δ ${Math.round((fb.bestDeltaMs || 0) / 1000)}s)`,
        severity: 'warning',
      });
    }
    let diffs = diffsOO.concat(compareTierA(sourceForTierA, destForTierA, tierAOpts));

    // Attachment size comparison — both sides are Graph base64+MIME; sizes should be near-identical
    diffs = diffs.concat(
      compareAttachmentSizesWithTolerance(sourceForTierA.attachments, destForTierA.attachments, 'outlook_to_outlook')
    );

    let srcFolderStrOO = '';
    if (srcFull.parentFolderId) {
      try {
        srcFolderStrOO = await outlookClient.getMailFolderPathString(srcUser, srcFull.parentFolderId);
      } catch (e) {
        log.warn(`Deep validation: source folder path: ${e.message}`);
      }
    }
    let destFolderStrOO = '';
    if (destFull.parentFolderId) {
      try {
        destFolderStrOO = await outlookClient.getMailFolderPathString(destUser, destFull.parentFolderId);
      } catch (e) {
        log.warn(`Deep validation: dest folder path: ${e.message}`);
      }
    }
    const folderOptsOO =
      boolEnv('MAIL_DEEP_FOLDER_WARNING_ONLY', false) === true ? { folderMismatchSeverity: 'warning' } : {};
    diffs = diffs.concat(compareFolderPlacement(srcFolderStrOO, destFolderStrOO, folderOptsOO));

    // Read state (warning)
    diffs = diffs.concat(compareReadState(srcFull.isRead, destFull.isRead));

    // Flag state (warning)
    diffs = diffs.concat(compareFlagState(srcFull.flag, destFull.flag));

    // Importance (warning)
    diffs = diffs.concat(compareImportanceOutlookToOutlook(srcFull.importance, destFull.importance));

    // Sensitivity — Normal/Personal/Private/Confidential must be preserved (error)
    diffs = diffs.concat(compareSensitivityOutlookToOutlook(srcFull.sensitivity, destFull.sensitivity));

    // sentDateTime: source vs destination Outlook (warning)
    {
      const toleranceMs = intEnv('DEEP_VALIDATION_SENT_TIME_TOLERANCE_MINUTES', 5) * 60000;
      diffs = diffs.concat(compareSentDateTime(srcFull.sentDateTime, destFull.sentDateTime, toleranceMs));
    }

    // Categories (warning)
    {
      const srcCats = (srcFull.categories || []).map(c => c.toLowerCase().trim()).sort();
      const dstCats = (destFull.categories || []).map(c => c.toLowerCase().trim()).sort();
      if (JSON.stringify(srcCats) !== JSON.stringify(dstCats)) {
        diffs.push({ field: 'categories', ok: false, expected: srcCats.join(', ') || '(none)', actual: dstCats.join(', ') || '(none)', displaySource: srcCats.join(', ') || '(none)', displayDestination: dstCats.join(', ') || '(none)', severity: 'warning' });
      }
    }

    // Sensitivity (warning)
    {
      const srcSens = String(srcFull.sensitivity || 'normal').toLowerCase();
      const dstSens = String(destFull.sensitivity || 'normal').toLowerCase();
      if (srcSens !== dstSens) {
        diffs.push({ field: 'sensitivity', ok: false, expected: srcSens, actual: dstSens, displaySource: srcSens, displayDestination: dstSens, severity: 'warning' });
      }
    }

    if (tierC) {
      const bodyMaxOO = intEnv('MAIL_DEEP_BODY_MAX_CHARS', 500000);
      const plainSrcOO = normalizeMailBodyPlain(
        htmlToPlainLoose(srcFull.body?.content || '') || srcFull.bodyPreview || ''
      );
      diffs = diffs.concat(
        compareTierC(plainSrcOO, destFull.body?.content || destFull.bodyPreview || '', {
          bodyMismatchSeverity: 'error',
          maxChars: bodyMaxOO,
          hasAttachments: (graphAttSrc || []).length > 0,
          destHasAttachments: (graphAttDst || []).length > 0,
        })
      );
    }

    // Zoom link check — runs regardless of tierC flag
    {
      const srcBodyRawOO = srcFull.body?.content || srcFull.bodyPreview || '';
      const dstBodyRawOO = destFull.body?.content || destFull.bodyPreview || '';
      diffs = diffs.concat(compareZoomLinks(srcBodyRawOO, dstBodyRawOO));
      // OneDrive / SharePoint link check
      diffs = diffs.concat(compareOneDriveLinks(srcBodyRawOO, dstBodyRawOO));
    }

    if (tierB && (graphAttSrc || []).length > 0) {
      try {
        const { srcHashes, dstHashes } = await tierBHashesOutlookToOutlook(
          srcUser, summary.id, graphAttSrc,
          destUser, destSummary.id, graphAttDst,
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
        log.warn(`Tier B (O→O) hash: ${e.message}`);
      }
    }

    const hasError = diffs.some((d) => d.severity === 'error');
    const _srcTsRawOO = Date.parse(srcFull.receivedDateTime || srcFull.sentDateTime || '');
    const _dstTsRawOO = Date.parse(destFull.receivedDateTime || destFull.sentDateTime || '');
    result.addDeepMailMessageResult({
      sourceMessageId: summary.id,
      internetMessageId: mid,
      destMessageId: destSummary.id,
      subject: srcFull.subject || summary.subject || '',
      pass: !hasError,
      diffs,
      _conversationId: srcFull.conversationId || null,
      _srcTimestampMs: Number.isFinite(_srcTsRawOO) ? _srcTsRawOO : null,
      _dstTimestampMs: Number.isFinite(_dstTsRawOO) ? _dstTsRawOO : null,
      _srcFolder: srcFolderStrOO || null,
      _srcFolderKind: 'folder',
      _dstFolder: destFolderStrOO || null,
      _dstFolderKind: 'folder',
    });
  }

  // Full thread chain validation: positional pairing of all messages in each O→O conversation
  await validateOutlookToOutlookThreadChains(result, srcUser, destUser, log, {
    tierC,
    tierB,
    tierAOpts,
  });
  try {
    validateMailOrderByTimestamp(result, log);
  } catch (orderErr) {
    log.warn(`Order validation (O→O) failed (non-fatal): ${orderErr.message}`);
  }
}

module.exports = { validateOutlookSource };
