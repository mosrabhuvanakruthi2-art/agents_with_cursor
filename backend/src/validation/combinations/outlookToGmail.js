// outlookToGmail — deep mail validation for this combination.
// Owned per-combination; edit only this file for outlookToGmail deep-validation logic.
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
  compareClickableLinks,
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

// When several destination messages share the same normalized subject — the classic thread-chain
// case where CloudFuze did not preserve internetMessageId — matching by subject (+RE: prefix) alone
// can pair the WRONG copy (e.g. an Inbox thread-opener with its Archive copy). Disambiguate by
// scoring each candidate against the SOURCE message's From / To / Cc AND body preview, and pick the
// copy that actually corresponds to this source email.
const _normAddr = (a) => String(a || '').trim().toLowerCase();
const _normBody = (t) => String(t || '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const _overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

async function pickBestGmailCandidate(candidates, srcFull, destUser, log, usedDestIds) {
  let list = (candidates || []).filter(Boolean);
  if (list.length === 0) return null;
  // Prefer destination messages not already paired to an earlier source message. This is essential
  // for duplicate-subject pairs (e.g. two Sent copies) so the two source mails don't both collapse
  // onto the SAME destination message, leaving the other orphaned/"not found".
  if (usedDestIds && usedDestIds.size) {
    const unused = list.filter((c) => !usedDestIds.has(c.id));
    if (unused.length) list = unused;
  }
  if (list.length === 1) return list[0];

  const srcFrom = _normAddr(srcFull.from?.emailAddress?.address);
  const srcTo   = new Set(graphRecipientsToEmails(srcFull.toRecipients).map(_normAddr));
  const srcCc   = new Set(graphRecipientsToEmails(srcFull.ccRecipients).map(_normAddr));
  const srcBody = _normBody(srcFull.bodyPreview || srcFull.body?.content || '').slice(0, 300);
  const srcIsReply = /^re:/i.test((srcFull.subject || '').trim());

  let best = null, bestScore = -Infinity;
  for (const cand of list) {
    let meta;
    try { meta = await gmailClient.getMessageMetadata(destUser, cand.id, 'metadata'); }
    catch { continue; }
    const cFrom = _normAddr(parseRecipientEmails(meta.from)[0]);
    const cTo   = new Set(parseRecipientEmails(meta.to).map(_normAddr));
    const cCc   = new Set(parseRecipientEmails(meta.cc).map(_normAddr));
    const cBody = _normBody(meta.snippet || '').slice(0, 300);
    const cIsReply = /^re:/i.test((meta.subject || '').trim());

    let score = 0;
    if (srcFrom && cFrom && srcFrom === cFrom) score += 4;   // same sender
    score += _overlap(srcTo, cTo) * 2;                       // shared To recipients
    score += _overlap(srcCc, cCc) * 2;                       // shared Cc recipients
    if (srcBody && cBody) {                                  // body preview (strongest signal here)
      if (srcBody === cBody) score += 10;
      else {
        const st = new Set(srcBody.split(' ')), ct = new Set(cBody.split(' '));
        score += Math.round((_overlap(st, ct) / Math.max(1, st.size)) * 8);
      }
    }
    if (cIsReply === srcIsReply) score += 1;                 // reply-prefix tiebreaker
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  if (log && best && list.length > 1) {
    log.info(`Deep validation (O→G): ${list.length} same-subject candidates — disambiguated by From/To/Cc/body → picked ${best.id} (score ${bestScore})`);
  }
  return best || list[0];
}

async function validateOutlookToGmailDestination({
  context, result, destUser, srcUser, maxMessages, subjectPrefix, tierB, tierC, log,
}) {
  // CloudFuze preserves original From/To/Cc/Bcc addresses — it does NOT rewrite them
  // to destination-domain equivalents during migration. The permission mapping is only
  // used for routing which mailbox migrates where; comparing message header addresses
  // against that mapping produces false positives for every intra-domain email.
  const tierAOpts = {
    compareBcc: false,
    bccAsError: false,
    recipientMapping: null,
    combination: 'outlook_to_gmail',
  };

  const candidates = await collectOutlookQaCandidates(
    srcUser, maxMessages, subjectPrefix,
    'id,internetMessageId,subject,hasAttachments,receivedDateTime,sentDateTime',
    log
  );

  result.deepMailValidation.scannedSourceMessages = candidates.length;

  // Build Gmail label id→name map once for the whole run
  let labelIdToName = new Map();
  try {
    const lbls = await gmailClient.listLabels(destUser, 'me');
    labelIdToName = new Map((lbls || []).map((l) => [l.id, l.name]));
  } catch (e) {
    log.warn(`Deep validation (O→G): could not list Gmail labels: ${e.message}`);
  }

  // Use a wider default window for Outlook→Gmail: Outlook stores sentDateTime in UTC while Gmail's
  // Date header may reflect the sender's local timezone, causing apparent drift of several hours.
  const windowMin = intEnv('DEEP_VALIDATION_SUBJECT_TIME_WINDOW_MINUTES', 240);
  const folderSeverity = boolEnv('MAIL_DEEP_FOLDER_WARNING_ONLY', false) ? 'warning' : 'error';

  // Destination messages already paired this run — so duplicate-subject pairs don't collapse onto one.
  const usedDestIds = new Set();

  for (const summary of candidates) {
    const mid = summary.internetMessageId || '';
    if (!mid) {
      result.addDeepMailMessageResult({
        sourceMessageId: summary.id, internetMessageId: '',
        destMessageId: null, subject: summary.subject || '',
        pass: false, note: 'Missing internetMessageId on source', diffs: [],
      });
      continue;
    }

    let srcFull;
    try {
      srcFull = await outlookClient.getMessageById(srcUser, summary.id);
    } catch (e) {
      result.addDeepMailMessageResult({
        sourceMessageId: summary.id, internetMessageId: mid,
        destMessageId: null, subject: summary.subject || '',
        pass: false, note: `Source message load failed: ${e.message}`, diffs: [],
      });
      continue;
    }

    let graphAttSrc = [];
    try { graphAttSrc = await outlookClient.getAttachments(srcUser, summary.id); } catch (e) {
      log.warn(`Deep validation (O→G): source attachments: ${e.message}`);
    }

    // Find in Gmail by internetMessageId
    let gmailMatches = [];
    let pairingStrategy = 'internetMessageId';
    try {
      gmailMatches = await gmailClient.findMessagesByInternetMessageId(destUser, mid);
    } catch (e) {
      log.warn(`Deep validation (O→G): Gmail MID lookup failed: ${e.message}`);
    }

    if (gmailMatches.length === 0 && boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true)) {
      const anchorMs = new Date(srcFull.receivedDateTime || srcFull.sentDateTime || 0).getTime();
      if (Number.isFinite(anchorMs)) {
        try {
          const fb = await gmailClient.findMessagesBySubjectAndTime(
            destUser, normalizeSubject(srcFull.subject), anchorMs, windowMin
          );
          if (fb.length > 0) {
            // Multiple candidates can share the same normalized subject (thread chains, or an
            // Inbox message + its Archive copy). Disambiguate by From/To/Cc/body so we pair the
            // correct copy — not just the first/most-recent or a RE:-prefix guess.
            const best = await pickBestGmailCandidate(fb, srcFull, destUser, log, usedDestIds);
            gmailMatches = [best];
            pairingStrategy = 'subject-time';
          }
        } catch (e) {
          log.warn(`Deep validation (O→G): Gmail subject+time fallback failed: ${e.message}`);
        }
      }
    }

    // Last-resort: subject-only search (no time constraint) for emails like Archive folder
    // messages where CloudFuze does not preserve internetMessageId and the Gmail internalDate
    // may differ significantly from the Outlook receivedDateTime.
    if (gmailMatches.length === 0 && boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true)) {
      try {
        const subjectOnly = await gmailClient.findMessagesBySubject(destUser, normalizeSubject(srcFull.subject));
        if (subjectOnly.length >= 1) {
          // Disambiguate multiple same-subject copies by From/To/Cc/body (thread chains, Archive copy).
          const best = await pickBestGmailCandidate(subjectOnly, srcFull, destUser, log, usedDestIds);
          if (best) {
            gmailMatches = [best];
            pairingStrategy = 'subject-only';
          }
        }
      } catch (e) {
        log.warn(`Deep validation (O→G): Gmail subject-only fallback failed: ${e.message}`);
      }
    }

    // Final, most robust tier: scan by single-word subject terms + in-memory normalized-subject
    // compare. This finds the message whenever it exists in Gmail, even when its subject contains
    // special characters ( <>&"' : / — etc.) that break Gmail's quoted-phrase search used above.
    if (gmailMatches.length === 0) {
      try {
        const anchorScan = new Date(srcFull.receivedDateTime || srcFull.sentDateTime || 0).getTime();
        let scan = await gmailClient.findMessagesBySubjectScan(
          destUser, srcFull.subject, Number.isFinite(anchorScan) ? anchorScan : null,
          Number.isFinite(anchorScan) ? windowMin : 0
        );
        // If the time-boxed scan found nothing (e.g. Archive folder — internalDate far from source),
        // retry without any time constraint.
        if (scan.length === 0) {
          scan = await gmailClient.findMessagesBySubjectScan(destUser, srcFull.subject);
        }
        if (scan.length > 0) {
          const best = await pickBestGmailCandidate(scan, srcFull, destUser, log, usedDestIds);
          gmailMatches = [{ id: best.id, threadId: best.threadId }];
          pairingStrategy = 'subject-scan';
        }
      } catch (e) {
        log.warn(`Deep validation (O→G): Gmail subject-scan fallback failed: ${e.message}`);
      }
    }

    if (gmailMatches.length === 0) {
      result.deepMailValidation.unmatchedSourceIds.push(summary.id);
      const noteOG = `No Gmail message with matching Message-ID${boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true) ? `; subject+time fallback (±${windowMin}m) also found no candidate; subject-only + subject-scan fallbacks also found no match.` : ''}`;
      let srcFolderPathOG = '';
      if (srcFull.parentFolderId) {
        try { srcFolderPathOG = await outlookClient.getMailFolderPathString(srcUser, srcFull.parentFolderId); } catch (_) { /* skip */ }
      }
      const srcFromOG = srcFull.from?.emailAddress?.address || srcFull.from?.emailAddress?.name || '';
      const srcDateOG = srcFull.sentDateTime || srcFull.receivedDateTime || '';
      const notFoundDiffsOG = [
        { field: 'notFoundReason', ok: false, displaySource: '—', displayDestination: noteOG, severity: 'error' },
        ...(srcFull.subject ? [{ field: 'subject', ok: false, displaySource: srcFull.subject, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(srcFolderPathOG ? [{ field: 'folder', ok: false, displaySource: srcFolderPathOG, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(srcFromOG ? [{ field: 'from', ok: false, displaySource: srcFromOG, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(srcDateOG ? [{ field: 'sentDateTime', ok: false, displaySource: srcDateOG, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
      ];
      result.addDeepMailMessageResult({
        sourceMessageId: summary.id, internetMessageId: mid,
        destMessageId: null, subject: srcFull.subject || summary.subject || '',
        pass: false,
        note: noteOG,
        diffs: notFoundDiffsOG,
      });
      continue;
    }

    const gmailRef = gmailMatches[0];
    if (gmailRef?.id) usedDestIds.add(gmailRef.id); // reserve so no other source pairs to it
    let gmailFull;
    try {
      gmailFull = await gmailClient.getMessageFullForValidation(destUser, gmailRef.id);
    } catch (e) {
      result.addDeepMailMessageResult({
        sourceMessageId: summary.id, internetMessageId: mid,
        destMessageId: gmailRef.id, subject: srcFull.subject || '',
        pass: false, note: `Gmail destination message load failed: ${e.message}`, diffs: [],
      });
      continue;
    }

    // Tier A
    const sourceForTierA = {
      subject: srcFull.subject,
      from: srcFull.from,
      toEmails: graphRecipientsToEmails(srcFull.toRecipients),
      ccEmails: graphRecipientsToEmails(srcFull.ccRecipients),
      bccEmails: graphRecipientsToEmails(srcFull.bccRecipients),
      replyTo: srcFull.replyTo,
      attachments: graphAttachmentsToCompareList(graphAttSrc).map((a) => ({ filename: a.filename, size: a.size })),
    };
    const destForTierA = {
      subject: gmailFull.subject,
      fromEmails: parseRecipientEmails(gmailFull.from),
      toEmails: parseRecipientEmails(gmailFull.to),
      ccEmails: parseRecipientEmails(gmailFull.cc),
      bccEmails: parseRecipientEmails(gmailFull.bcc),
      replyTo: gmailFull.replyTo || '',
      attachments: (gmailFull.attachments || []).map((a) => ({ filename: a.filename, size: a.size })),
    };

    let diffs = [];
    if (pairingStrategy === 'subject-time') {
      diffs.push({ field: 'pairing', ok: true, expected: 'internetMessageId', actual: `subject+time fallback (±${windowMin}m)`, severity: 'warning' });
    } else if (pairingStrategy === 'subject-only') {
      diffs.push({ field: 'pairing', ok: true, expected: 'internetMessageId', actual: 'subject-only fallback (no time constraint — internetMessageId not preserved, e.g. Archive folder)', severity: 'warning' });
    } else if (pairingStrategy === 'subject-scan') {
      diffs.push({ field: 'pairing', ok: true, expected: 'internetMessageId', actual: 'subject-scan fallback (matched by normalized subject — subject contains special characters that break Gmail phrase search)', severity: 'warning' });
    }
    diffs = diffs.concat(compareTierA(sourceForTierA, destForTierA, tierAOpts));

    // Attachment size comparison — Graph API reports base64+MIME size; Gmail API reports decoded bytes
    diffs = diffs.concat(
      compareAttachmentSizesWithTolerance(sourceForTierA.attachments, destForTierA.attachments, 'outlook_to_gmail')
    );

    // Folder placement
    let srcFolderStr = '';
    if (srcFull.parentFolderId) {
      try { srcFolderStr = await outlookClient.getMailFolderPathString(srcUser, srcFull.parentFolderId); }
      catch (e) { log.warn(`Deep validation (O→G): source folder path: ${e.message}`); }
    }
    const gmailLabelsStr = gmailClient.formatGmailLabelsForCompare(gmailFull.labelIds, labelIdToName);
    diffs = diffs.concat(validateOutlookToGmailPlacement(srcFolderStr, gmailLabelsStr, folderSeverity));

    // Read state: Outlook isRead → Gmail UNREAD label (warning — some platforms skip read-state)
    diffs = diffs.concat(compareOutlookReadToGmailUnread(srcFull.isRead, gmailFull.labelIds));

    // Flag: Outlook flagged → Gmail STARRED (warning)
    diffs = diffs.concat(compareOutlookFlagToGmailStarred(srcFull.flag?.flagStatus, gmailFull.labelIds));

    // Importance: Outlook high → Gmail IMPORTANT (warning — Gmail also auto-applies IMPORTANT via ML)
    diffs = diffs.concat(compareOutlookImportanceToGmailImportant(srcFull.importance, gmailFull.labelIds));

    // Categories: Outlook categories should appear as Gmail custom labels after migration
    const srcCategories = Array.isArray(srcFull.categories) ? srcFull.categories : [];
    for (const cat of srcCategories) {
      const catLower = (cat || '').toLowerCase().trim();
      if (!catLower) continue;
      const gmailLabelNames = (gmailFull.labelIds || []).map((id) =>
        (labelIdToName.get(id) || id).toLowerCase().trim()
      );
      const matched = gmailLabelNames.some(
        (l) => l === catLower || l.includes(catLower) || catLower.includes(l)
      );
      if (!matched) {
        diffs.push({
          field: 'category',
          ok: false,
          expected: `Gmail label for Outlook category "${cat}"`,
          actual: gmailLabelsStr || '(no labels)',
          displaySource: cat,
          displayDestination: gmailLabelsStr || '(no labels)',
          severity: 'warning',
        });
      }
    }

    // Sensitivity: Outlook sensitivity (personal/private/confidential) → Gmail label
    {
      const srcSensitivity = String(srcFull.sensitivity || '').toLowerCase().trim();
      if (srcSensitivity && srcSensitivity !== 'normal') {
        const gmailLabelNames = (gmailFull.labelIds || []).map(
          (id) => (labelIdToName.get(id) || id).toLowerCase().trim()
        );
        const matched = gmailLabelNames.some(
          (l) => l === srcSensitivity || l.includes(srcSensitivity) || srcSensitivity.includes(l)
        );
        if (!matched) {
          diffs.push({
            field: 'sensitivity',
            ok: false,
            expected: `Gmail label matching Outlook sensitivity "${srcFull.sensitivity}"`,
            actual: gmailLabelsStr || '(no labels)',
            displaySource: srcFull.sensitivity,
            displayDestination: gmailLabelsStr || '(no labels)',
            severity: 'warning',
            note: `Outlook messages with sensitivity="${srcFull.sensitivity}" should have a corresponding Gmail label after migration.`,
          });
        }
      }
    }

    // sentDateTime: Outlook sentDateTime vs Gmail Date header (original sent time, warning)
    {
      const toleranceMs = intEnv('DEEP_VALIDATION_SENT_TIME_TOLERANCE_MINUTES', 5) * 60000;
      diffs = diffs.concat(compareSentDateTime(srcFull.sentDateTime, gmailFull.date, toleranceMs));
    }

    // Tier C body
    if (tierC) {
      const srcBodyPlain = normalizeMailBodyPlain(htmlToPlainLoose(srcFull.body?.content || '') || srcFull.bodyPreview || '');
      const dstHtml = gmailClient.extractHtmlBodyFromPayload(gmailFull.payload);
      const dstBodyPlain = dstHtml
        ? htmlToPlainLoose(dstHtml)
        : gmailClient.extractPlainBodyFromPayload(gmailFull.payload) || gmailFull.snippet || '';
      const bodyMax = intEnv('MAIL_DEEP_BODY_MAX_CHARS', 500000);
      diffs = diffs.concat(compareTierC(srcBodyPlain, dstBodyPlain, {
        bodyMismatchSeverity: 'error', maxChars: bodyMax,
        hasAttachments: graphAttSrc.length > 0,
        destHasAttachments: (gmailFull.attachments || []).length > 0,
      }));
    }

    // Zoom link check — runs regardless of tierC flag
    {
      const srcBodyRaw = srcFull.body?.content || srcFull.bodyPreview || '';
      const dstHtmlRaw = gmailClient.extractHtmlBodyFromPayload(gmailFull.payload);
      const dstBodyRaw = dstHtmlRaw
        ? htmlToPlainLoose(dstHtmlRaw)
        : gmailClient.extractPlainBodyFromPayload(gmailFull.payload) || gmailFull.snippet || '';
      diffs = diffs.concat(compareZoomLinks(srcBodyRaw, dstBodyRaw));
      // OneDrive / SharePoint link check
      diffs = diffs.concat(compareOneDriveLinks(srcBodyRaw, dstBodyRaw));
      // Clickable-link preservation — compare RAW HTML (anchors), not the plain-text bodies above
      diffs = diffs.concat(compareClickableLinks(srcBodyRaw, dstHtmlRaw || ''));
    }

    // Tier B attachment hash for Outlook→Gmail
    if (tierB && graphAttSrc.length > 0) {
      try {
        const { srcHashes, dstHashes } = await tierBHashesOutlookToGmail(
          srcUser, summary.id, graphAttSrc, destUser, gmailFull, log
        );
        const tierBDiffs = compareTierBHashes(srcHashes, dstHashes);
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
        log.warn(`Tier B (O→G) hash: ${e.message}`);
      }
    }

    const hasError = diffs.some((d) => d.severity === 'error');
    const _srcTsRawOG = Date.parse(srcFull.receivedDateTime || srcFull.sentDateTime || '');
    const _dstTsOG = gmailFull.internalDateMs != null ? Number(gmailFull.internalDateMs) : null;
    result.addDeepMailMessageResult({
      sourceMessageId: summary.id, internetMessageId: mid,
      destMessageId: gmailRef.id, subject: srcFull.subject || summary.subject || '',
      pass: !hasError, diffs,
      _conversationId: srcFull.conversationId || null,
      _gmailThreadId: gmailFull.threadId || null,
      _srcTimestampMs: Number.isFinite(_srcTsRawOG) ? _srcTsRawOG : null,
      _dstTimestampMs: _dstTsOG,
      _srcFolder: srcFolderStr || null,
      _srcFolderKind: 'folder',
      _dstFolder: gmailLabelsStr || null,
      _dstFolderKind: 'label',
    });
  }

  // Full thread chain validation: positional pairing of all messages in each conversation
  await validateOutlookToGmailThreadChains(result, srcUser, destUser, log, {
    tierC,
    tierB,
    labelIdToName,
    folderSeverity,
    tierAOpts,
  });
  try {
    validateMailOrderByTimestamp(result, log);
  } catch (orderErr) {
    log.warn(`Order validation (O→G) failed (non-fatal): ${orderErr.message}`);
  }
}

module.exports = { validateOutlookToGmailDestination };
