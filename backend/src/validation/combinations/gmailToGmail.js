// gmailToGmail — deep mail validation for this combination.
// Owned per-combination; edit only this file for gmailToGmail deep-validation logic.
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

/**
 * Deep validation for Gmail→Gmail migrations.
 *
 * Strategy:
 *   1. Scan source Gmail for QA-tagged messages (same label scanning as validateGmailSource)
 *   2. For each source message: fetch full content via getMessageFullForValidation
 *   3. Look up in destination Gmail by internetMessageId (rfc822msgid search)
 *   4. Fallback: subject+time search, then subject-only search
 *   5. If found: run Tier A comparison (subject, from, to, cc, bcc, attachments)
 *                run Tier C body comparison
 *                compare label placement (source labels vs destination labels)
 *   6. If not found: record unmatched with not-found diffs (same pattern as validateGmailSource)
 */
async function validateGmailToGmailSource({
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
  // CloudFuze preserves original addresses; recipient mapping not applicable for G→G label-placement.
  // But we still build it so any user-supplied userEmailMappings are honoured for header comparison.
  const recipientMap = buildRecipientEmailMapping(context.userEmailMappings, {
    sourceEmail: context.sourceEmail,
    destinationEmail: context.destinationEmail,
  });
  const tierAOpts = {
    compareBcc: true,
    bccAsError: true,
    recipientMapping: recipientMap.size > 0 ? recipientMap : null,
    combination: 'gmail_to_gmail',
  };

  // Build source label id→name map for folder placement reporting
  let srcLabelIdToName = new Map();
  try {
    const lbls = await gmailClient.listLabels(srcUser, 'me');
    srcLabelIdToName = new Map((lbls || []).map((l) => [l.id, l.name]));
  } catch (e) {
    log.warn(`Deep validation (G→G): could not list source Gmail labels: ${e.message}`);
  }

  // Build destination label id→name map
  let dstLabelIdToName = new Map();
  try {
    const lbls = await gmailClient.listLabels(destUser, 'me');
    dstLabelIdToName = new Map((lbls || []).map((l) => [l.id, l.name]));
  } catch (e) {
    log.warn(`Deep validation (G→G): could not list dest Gmail labels: ${e.message}`);
  }

  // ── Collect source QA message IDs (same label scanning strategy as validateGmailSource) ──
  let labelIds = gmailSystemLabelsForDeepValidation();
  // ALL_CUSTOM: expand to every user-created label so nested/custom label messages are scanned
  if (labelIds.includes('ALL_CUSTOM')) {
    labelIds = labelIds.filter((id) => id !== 'ALL_CUSTOM');
    try {
      const allLabels = await gmailClient.listLabels(srcUser, 'me');
      for (const lbl of allLabels || []) {
        if (lbl.type !== 'system') labelIds.push(lbl.id);
      }
    } catch (e) {
      log.warn(`Deep validation (G→G): could not expand ALL_CUSTOM labels: ${e.message}`);
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
      log.warn(`Deep validation (G→G): could not list messages for Gmail label "${labelId}": ${e.message}`);
    }
  }
  const allIds = [...idSet];

  // Filter to QA-tagged messages
  const qaIds = [];
  for (const id of allIds) {
    let meta;
    try {
      meta = await gmailClient.getMessageMetadata(srcUser, id, 'metadata');
    } catch (e) {
      log.warn(`Deep validation (G→G): metadata ${id}: ${e.message}`);
      continue;
    }
    const sub = normalizeSubject(meta.subject);
    if (!sub.startsWith(subjectPrefix) && !/^QA\b/i.test(sub)) continue;
    qaIds.push(id);
    if (qaIds.length >= maxMessages) break;
  }

  result.deepMailValidation.scannedSourceMessages = qaIds.length;
  const windowMin = intEnv('DEEP_VALIDATION_SUBJECT_TIME_WINDOW_MINUTES', 120);

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
        note: `Source Gmail full read failed: ${e.message}`,
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

    // ── Step 1: Look up in destination Gmail by internetMessageId ──
    let gmailMatches = [];
    let pairingStrategy = 'internetMessageId';
    try {
      gmailMatches = await gmailClient.findMessagesByInternetMessageId(destUser, mid);
    } catch (e) {
      log.warn(`Deep validation (G→G): Gmail MID lookup failed for ${id}: ${e.message}`);
    }

    // ── Step 2: Subject+time fallback ──
    if (gmailMatches.length === 0 && boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true)) {
      let anchorMs =
        full.internalDateMs != null && Number.isFinite(Number(full.internalDateMs))
          ? Number(full.internalDateMs)
          : null;
      if (anchorMs == null) {
        const parsed = Date.parse(full.date || full.headers?.date || '');
        anchorMs = Number.isFinite(parsed) ? parsed : null;
      }
      if (anchorMs != null) {
        try {
          const fb = await gmailClient.findMessagesBySubjectAndTime(
            destUser, normalizeSubject(full.subject), anchorMs, windowMin
          );
          if (fb.length > 0) {
            let best = fb[0];
            if (fb.length > 1) {
              const srcIsReply = /^re:/i.test((full.subject || '').trim());
              for (const cand of fb) {
                try {
                  const meta = await gmailClient.getMessageMetadata(destUser, cand.id, 'metadata');
                  const candIsReply = /^re:/i.test((meta.subject || '').trim());
                  if (candIsReply === srcIsReply) { best = cand; break; }
                } catch { /* skip */ }
              }
            }
            gmailMatches = [best];
            pairingStrategy = 'subject-time';
          }
        } catch (e) {
          log.warn(`Deep validation (G→G): subject+time fallback failed: ${e.message}`);
        }
      }
    }

    // ── Step 3: Subject-only fallback (last resort) ──
    if (gmailMatches.length === 0 && boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true)) {
      try {
        const subjectOnly = await gmailClient.findMessagesBySubject(destUser, normalizeSubject(full.subject));
        if (subjectOnly.length === 1) {
          gmailMatches = subjectOnly;
          pairingStrategy = 'subject-only';
        } else if (subjectOnly.length > 1) {
          const srcIsReply = /^re:/i.test((full.subject || '').trim());
          let best = null;
          for (const cand of subjectOnly) {
            try {
              const meta = await gmailClient.getMessageMetadata(destUser, cand.id, 'metadata');
              const candIsReply = /^re:/i.test((meta.subject || '').trim());
              if (candIsReply === srcIsReply) { best = cand; break; }
            } catch { /* skip */ }
          }
          if (best) {
            gmailMatches = [best];
            pairingStrategy = 'subject-only';
          }
        }
      } catch (e) {
        log.warn(`Deep validation (G→G): subject-only fallback failed: ${e.message}`);
      }
    }

    // ── Not found ──
    if (gmailMatches.length === 0) {
      result.deepMailValidation.unmatchedSourceIds.push(id);
      let unmatchedNote = `No destination Gmail message with matching Message-ID`;
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
          unmatchedNote += ` Subject+time fallback (±${windowMin}m) also found no candidate; subject-only fallback also found no match.`;
        }
      }
      const srcFolderLabelG2G = gmailClient.formatGmailLabelsForCompare(full.labelIds, srcLabelIdToName);
      const srcDateG2G = full.date || (full.internalDateMs ? new Date(Number(full.internalDateMs)).toUTCString() : '') || '';
      const notFoundDiffsG2G = [
        { field: 'notFoundReason', ok: false, displaySource: '—', displayDestination: unmatchedNote, severity: 'error' },
        ...(full.subject ? [{ field: 'subject', ok: false, displaySource: full.subject, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(srcFolderLabelG2G ? [{ field: 'folder', ok: false, displaySource: srcFolderLabelG2G, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(full.from ? [{ field: 'from', ok: false, displaySource: full.from, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
        ...(srcDateG2G ? [{ field: 'sentDateTime', ok: false, displaySource: srcDateG2G, displayDestination: '— (not found in destination)', severity: 'info' }] : []),
      ];
      result.addDeepMailMessageResult({
        sourceMessageId: id,
        internetMessageId: mid,
        destMessageId: null,
        subject: full.subject || '',
        pass: false,
        note: unmatchedNote,
        diffs: notFoundDiffsG2G,
      });
      continue;
    }

    if (gmailMatches.length > 1) {
      result.deepMailValidation.ambiguousInternetMessageIds.push(mid);
    }

    // ── Fetch destination message full content ──
    const destRef = gmailMatches[0];
    let destFull;
    try {
      destFull = await gmailClient.getMessageFullForValidation(destUser, destRef.id);
    } catch (e) {
      result.addDeepMailMessageResult({
        sourceMessageId: id,
        internetMessageId: mid,
        destMessageId: destRef.id,
        subject: full.subject || '',
        pass: false,
        note: `Destination Gmail message load failed: ${e.message}`,
        diffs: [],
      });
      continue;
    }

    // ── Tier A: header / envelope comparison ──
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
      to: destFull.to,
      cc: destFull.cc,
      bcc: destFull.bcc,
      replyTo: destFull.replyTo || '',
      attachments: (destFull.attachments || []).map((a) => ({
        filename: a.filename,
        size: a.size,
      })),
    };

    let diffs = [];
    if (pairingStrategy === 'subject-time') {
      diffs.push({
        field: 'pairing', ok: true, expected: 'internetMessageId',
        actual: `subject+time fallback (±${windowMin}m)`, severity: 'warning',
      });
    } else if (pairingStrategy === 'subject-only') {
      diffs.push({
        field: 'pairing', ok: true, expected: 'internetMessageId',
        actual: 'subject-only fallback (no time constraint — internetMessageId not preserved)', severity: 'warning',
      });
    }
    diffs = diffs.concat(compareTierA(sourceForTierA, destForTierA, tierAOpts));

    // Attachment size comparison — both Gmail, so sizes should be near-identical (raw bytes)
    diffs = diffs.concat(
      compareAttachmentSizesWithTolerance(sourceForTierA.attachments, destForTierA.attachments, 'gmail_to_gmail')
    );

    // ── Label placement comparison ──
    // For G→G, system labels should transfer 1-to-1 and custom labels by name.
    // We compare the human-readable label string from source vs destination.
    const srcLabelsStr = gmailClient.formatGmailLabelsForCompare(full.labelIds, srcLabelIdToName);
    const dstLabelsStr = gmailClient.formatGmailLabelsForCompare(destFull.labelIds, dstLabelIdToName);

    // Only flag label differences that are meaningful: exclude UNREAD/IMPORTANT/STARRED
    // (those are client-state labels that may differ legitimately post-migration).
    const SKIP_PLACEMENT_LABELS = new Set(['UNREAD', 'IMPORTANT', 'STARRED', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'CHAT']);
    const srcPlacementLabels = (full.labelIds || []).filter(l => !SKIP_PLACEMENT_LABELS.has(l));
    const dstPlacementLabels = (destFull.labelIds || []).filter(l => !SKIP_PLACEMENT_LABELS.has(l));

    const srcPlacementNames = srcPlacementLabels.map(id => (srcLabelIdToName.get(id) || id).toLowerCase()).sort();
    const dstPlacementNames = dstPlacementLabels.map(id => (dstLabelIdToName.get(id) || id).toLowerCase()).sort();

    if (srcPlacementNames.length > 0 && srcPlacementNames.join('|') !== dstPlacementNames.join('|')) {
      const folderSeverity = boolEnv('MAIL_DEEP_FOLDER_WARNING_ONLY', false) ? 'warning' : 'error';
      diffs.push({
        field: 'folder',
        ok: false,
        expected: srcLabelsStr || '(no labels)',
        actual: dstLabelsStr || '(no labels)',
        displaySource: srcLabelsStr || '(no labels)',
        displayDestination: dstLabelsStr || '(no labels)',
        severity: folderSeverity,
        note: 'Gmail label placement differs between source and destination',
      });
    }

    // Read state: UNREAD label present in source but not destination (or vice versa) — warning
    diffs = diffs.concat(compareGmailUnreadToOutlookIsRead(full.labelIds, !destFull.labelIds?.includes('UNREAD')));

    // STARRED (G→G inscope): source STARRED label should be preserved in destination — warning
    {
      const srcStarred = (full.labelIds || []).includes('STARRED');
      const dstStarred = (destFull.labelIds || []).includes('STARRED');
      if (srcStarred !== dstStarred) {
        diffs.push({
          field: 'starred',
          ok: false,
          expected: srcStarred ? 'STARRED' : 'not STARRED',
          actual: dstStarred ? 'STARRED' : 'not STARRED',
          displaySource: srcStarred ? 'Starred' : 'Not starred',
          displayDestination: dstStarred ? 'Starred' : 'Not starred',
          severity: 'warning',
          note: 'Gmail STARRED label should be preserved during G→G migration.',
        });
      }
    }

    // sentDateTime: Gmail Date header comparison between source and destination (warning)
    {
      const toleranceMs = intEnv('DEEP_VALIDATION_SENT_TIME_TOLERANCE_MINUTES', 5) * 60000;
      diffs = diffs.concat(compareSentDateTime(full.date, destFull.date, toleranceMs));
    }

    // ── Tier C: body comparison ──
    if (tierC) {
      const srcHtml = gmailClient.extractHtmlBodyFromPayload(full.payload);
      const srcBodyPlain = srcHtml
        ? htmlToPlainLoose(srcHtml)
        : gmailClient.extractPlainBodyFromPayload(full.payload) || full.snippet || '';

      const dstHtml = gmailClient.extractHtmlBodyFromPayload(destFull.payload);
      const dstBodyPlain = dstHtml
        ? htmlToPlainLoose(dstHtml)
        : gmailClient.extractPlainBodyFromPayload(destFull.payload) || destFull.snippet || '';

      const bodyMax = intEnv('MAIL_DEEP_BODY_MAX_CHARS', 500000);
      diffs = diffs.concat(
        compareTierC(srcBodyPlain, dstBodyPlain, {
          bodyMismatchSeverity: 'error',
          maxChars: bodyMax,
          hasAttachments: (full.attachments || []).length > 0,
          destHasAttachments: (destFull.attachments || []).length > 0,
        })
      );
    }

    // ── Zoom link check (runs regardless of tierC) ──
    {
      const srcHtmlRaw = gmailClient.extractHtmlBodyFromPayload(full.payload);
      const srcBodyRaw = srcHtmlRaw
        ? htmlToPlainLoose(srcHtmlRaw)
        : gmailClient.extractPlainBodyFromPayload(full.payload) || full.snippet || '';
      const dstHtmlRaw = gmailClient.extractHtmlBodyFromPayload(destFull.payload);
      const dstBodyRaw = dstHtmlRaw
        ? htmlToPlainLoose(dstHtmlRaw)
        : gmailClient.extractPlainBodyFromPayload(destFull.payload) || destFull.snippet || '';
      diffs = diffs.concat(compareZoomLinks(srcBodyRaw, dstBodyRaw));
    }

    // ── Tier B: attachment hash comparison ──
    if (tierB && (full.attachments || []).length > 0) {
      try {
        const { srcHashes, dstHashes } = await tierBHashesGmailToGmail(srcUser, full, destUser, destFull, log);
        const tierBDiffs = compareTierBHashes(srcHashes, dstHashes);
        // When all hashes match, downgrade size-discrepancy warnings to info
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
        log.warn(`Tier B (G→G) hash: ${e.message}`);
      }
    }

    const hasError = diffs.some((d) => d.severity === 'error');
    result.addDeepMailMessageResult({
      sourceMessageId: id,
      internetMessageId: mid,
      destMessageId: destRef.id,
      subject: full.subject || '',
      pass: !hasError,
      diffs,
      _gmailThreadId: full.threadId || null,
      _destGmailThreadId: destFull.threadId || null,
    });
  }

  // ── Thread chain integrity validation (G→G, threads are inscope) ──────────
  // For each source threadId that has ≥2 paired messages, verify that ALL messages
  // in the source thread are found in the destination thread (same threadId or linked
  // by In-Reply-To/References headers). Records results in threadChainResults.
  try {
    // Group paired messageResults by their source _gmailThreadId
    const threadMap = new Map(); // srcThreadId → { srcMsgIds: [], destThreadIds: Set }
    for (const entry of result.deepMailValidation.messageResults) {
      const srcThreadId = entry._gmailThreadId;
      if (!srcThreadId) continue;
      if (!threadMap.has(srcThreadId)) {
        threadMap.set(srcThreadId, { srcMsgIds: [], destThreadIds: new Set(), entries: [] });
      }
      const slot = threadMap.get(srcThreadId);
      slot.srcMsgIds.push(entry.sourceMessageId);
      slot.entries.push(entry);
      if (entry._destGmailThreadId) {
        slot.destThreadIds.add(entry._destGmailThreadId);
      }
    }

    const threadCandidates = [...threadMap.entries()].filter(([, v]) => v.srcMsgIds.length >= 2);

    if (threadCandidates.length > 0) {
      result.deepMailValidation.threadChainResults = result.deepMailValidation.threadChainResults || [];
      log.info(`Thread chain validation (G→G): ${threadCandidates.length} thread(s) with ≥2 messages`);

      for (const [srcThreadId, { srcMsgIds, destThreadIds, entries }] of threadCandidates) {
        // Fetch full source thread to get exact message count
        let srcThread = null;
        let srcMsgCount = srcMsgIds.length;
        try {
          srcThread = await gmailClient.getGmailThread(srcUser, srcThreadId);
          srcMsgCount = (srcThread.messages || []).length;
        } catch (e) {
          log.warn(`Thread chain (G→G): source thread ${srcThreadId} fetch failed: ${e.message}`);
        }

        // Each destination message should land in its own dest threadId.
        // For G→G the thread IDs will be different (new mailbox), so we count
        // how many source messages were successfully paired (have a destMessageId).
        const pairedCount = entries.filter(e => !!e.destMessageId).length;
        const mismatches = [];
        const threadMismatches = [];

        // Check: if multiple dest threadIds — the source thread was split in destination
        if (destThreadIds.size > 1) {
          mismatches.push({
            field: 'threadSplit',
            ok: false,
            expected: '1 destination thread for the entire source thread',
            actual: `${destThreadIds.size} destination threadId(s) — thread may have been split during migration`,
            displaySource: `Source threadId: ${srcThreadId}`,
            displayDestination: `Dest threadIds: ${[...destThreadIds].join(', ')}`,
            severity: 'error',
          });
        }

        // Check: missing messages (source thread has more msgs than what was paired)
        if (pairedCount < srcMsgCount) {
          const missing = srcMsgCount - pairedCount;
          mismatches.push({
            field: 'threadCount',
            ok: false,
            expected: `${srcMsgCount} message(s) from source thread in destination`,
            actual: `${pairedCount} message(s) paired`,
            displaySource: `Source thread: ${srcMsgCount} message(s)`,
            displayDestination: `Destination: ${pairedCount} message(s) found — ${missing} missing`,
            severity: 'error',
          });
        }

        // Check: per-message thread linkage — all paired dest messages should share a single threadId
        const primaryDestThreadId = destThreadIds.size === 1 ? [...destThreadIds][0] : null;

        const rootSubject = entries[0]?.subject || '(unknown)';
        const structuralErrors = mismatches.filter(m => m.severity === 'error').length;
        const pass = structuralErrors === 0;

        result.deepMailValidation.threadChainResults.push({
          srcThreadId,
          primaryDestThreadId,
          allDestThreadIds: [...destThreadIds],
          rootSubject,
          srcMessageCount: srcMsgCount,
          pairedMessageCount: pairedCount,
          threadSplit: destThreadIds.size > 1,
          countMatch: pairedCount === srcMsgCount,
          pass,
          mismatches,
          messageComparisons: [],
          srcSubjects: entries.map(e => e.subject),
        });

        if (!pass) {
          log.warn(
            `Thread chain (G→G) FAIL: "${rootSubject}" — src=${srcMsgCount} paired=${pairedCount} ` +
            `destThreadIds=${destThreadIds.size} structuralErrors=${structuralErrors}`
          );
        }
      }

      const failedChains = result.deepMailValidation.threadChainResults.filter(t => !t.pass).length;
      const totalChains = result.deepMailValidation.threadChainResults.length;
      log.info(`Thread chain validation (G→G) complete: ${totalChains} thread(s) checked, ${failedChains} failed`);
    }
  } catch (threadErr) {
    log.warn(`Thread chain validation (G→G) failed (non-fatal): ${threadErr.message}`);
  }

  // ── Thread summary ──
  const paired = result.deepMailValidation.messageResults.filter((r) => r.destMessageId).length;
  const failed = result.deepMailValidation.messageResults.filter((r) => !r.pass).length;
  log.info(
    `Deep mail (G→G): scanned ${qaIds.length}, paired ${paired}, failed ${failed}, ` +
    `unmatched ${result.deepMailValidation.unmatchedSourceIds.length}`
  );
}

module.exports = { validateGmailToGmailSource };
