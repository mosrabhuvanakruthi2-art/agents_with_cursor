/**
 * Deep source↔destination mail validation (Tier A/B/C).
 * Supports: Gmail→Outlook, Outlook→Outlook, Outlook→Gmail.
 */

const gmailClient = require('../clients/gmailClient');
const outlookClient = require('../clients/outlookClient');
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
} = require('../utils/mailMigrationComparator');

// ── Zoom link validation helpers ─────────────────────────────────────────────

/** Extract all Zoom meeting URLs from a plain-text or HTML body */
function extractZoomLinks(text) {
  if (!text) return [];
  const rx = /https?:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/j\/[0-9]+(?:\?[^\s<>"']*)*/gi;
  return [...new Set((text.match(rx) || []).map(u => u.replace(/[.,;:!?)>]+$/, '')))];
}

/**
 * Check that every Zoom link found in the source body is also present in the destination body.
 * Returns an array of diff objects (empty = all links preserved).
 */
function compareZoomLinks(srcBody, dstBody) {
  const srcLinks = extractZoomLinks(srcBody);
  if (srcLinks.length === 0) return [];
  const diffs = [];
  for (const link of srcLinks) {
    const meetingId = (link.match(/\/j\/([0-9]+)/) || [])[1] || 'unknown';
    const presentInDest = dstBody && dstBody.includes(link);
    if (!presentInDest) {
      // Try matching by meeting ID only (migration may rewrite the query string)
      const idInDest = dstBody && dstBody.includes(`/j/${meetingId}`);
      diffs.push({
        field: 'zoomLink',
        ok: idInDest,
        expected: link,
        actual: idInDest ? `Zoom meeting ID ${meetingId} found but URL format changed` : `Zoom link missing in destination`,
        severity: idInDest ? 'warning' : 'error',
        note: `Zoom meeting ID: ${meetingId}. Destination users must have access to this meeting in Zoom. Verify the meeting host mapping matches the destination user domain.`,
      });
    }
  }
  return diffs;
}

/** Extract SharePoint / OneDrive share links from body text */
function extractOneDriveLinks(text) {
  if (!text) return [];
  const rx = /https?:\/\/(?:[a-z0-9-]+\.)?sharepoint\.com\/[^\s<>"')]+/gi;
  return [...new Set((text.match(rx) || []).map((u) => u.replace(/[.,;:!?)>]+$/, '')))];
}

/**
 * Check that every OneDrive/SharePoint link found in the source body is also present
 * (at least the URL path portion) in the destination body.
 */
function compareOneDriveLinks(srcBody, dstBody) {
  const srcLinks = extractOneDriveLinks(srcBody);
  if (srcLinks.length === 0) return [];
  const diffs = [];
  for (const link of srcLinks) {
    const urlPath = link.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
    const exactPresent = dstBody && dstBody.includes(link);
    const pathPresent = !exactPresent && dstBody && urlPath && dstBody.includes(urlPath);
    if (!exactPresent && !pathPresent) {
      diffs.push({
        field: 'oneDriveLink',
        ok: false,
        expected: link,
        actual: 'OneDrive link missing in destination',
        displaySource: link,
        displayDestination: 'Missing',
        severity: 'warning',
        note: 'Verify that the OneDrive/SharePoint document is accessible from the destination tenant.',
      });
    }
  }
  return diffs;
}

function boolEnv(name, defaultVal = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultVal;
  return String(v).toLowerCase() === 'true' || v === '1';
}

function intEnv(name, defaultVal) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : defaultVal;
}

/** Human-readable reason when resolveDestinationByInternetMessageId finds nothing */
function buildDestinationUnmatchedNote(resolved, scanMax) {
  const d = resolved?.detail;
  if (d === 'empty-id') return 'Empty Message-ID on source';
  if (d === 'no-match-after-scan') {
    const n = resolved.scannedMessages ?? scanMax;
    return `No destination with matching Message-ID after OData variants, Graph search, and mailbox scan (${n} messages, cap ${scanMax}). If migration rewrites Message-ID at import, pairing by internetMessageId cannot succeed without a subject/date fallback.`;
  }
  if (d === 'no-odata-or-search-match') {
    return 'No destination with matching Message-ID via OData or Graph search; mailbox scan skipped (DEEP_VALIDATION_SKIP_MAILBOX_SCAN=true).';
  }
  if (typeof d === 'string' && d.startsWith('mailbox-scan-error')) {
    return `Destination lookup failed during mailbox scan: ${d}`;
  }
  return 'No destination message with matching Message-ID';
}

/**
 * Gmail labels to scan for deep validation candidates (Message-IDs are then filtered by QA subject).
 * Default INBOX + SENT so seeded mail in Sent Items (see GmailTestDataAgent) is included — INBOX-only misses it.
 * Override: DEEP_VALIDATION_GMAIL_LABELS=INBOX,SENT,DRAFT
 */
function gmailSystemLabelsForDeepValidation() {
  const raw = (process.env.DEEP_VALIDATION_GMAIL_LABELS || 'INBOX,SENT,TRASH,SPAM,ALL_CUSTOM').trim();
  const parts = raw
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : ['INBOX', 'SENT', 'TRASH', 'SPAM', 'ALL_CUSTOM'];
}

function graphAttachmentsToCompareList(items) {
  if (!items || !Array.isArray(items)) return [];
  return items
    .filter((a) => a['@odata.type']?.includes('fileAttachment') || a.name)
    .map((a) => ({
      filename: a.name || a.filename || 'attachment',
      size: Number(a.size || 0),
    }));
}

async function tierBHashesGmail(sourceEmail, gmailFull, destUser, destMessageId, graphAttachmentList, log) {
  const hashMax = intEnv('MAIL_DEEP_HASH_MAX_BYTES', 10485760);
  const srcHashes = [];
  const dstHashes = [];

  for (const att of gmailFull.attachments || []) {
    if (!att.filename || !att.attachmentId) continue;
    let buf;
    try {
      buf = await gmailClient.getAttachmentData(sourceEmail, gmailFull.id, att.attachmentId);
    } catch (e) {
      log.warn(`Deep validation: Gmail attachment read failed ${att.filename}: ${e.message}`);
      continue;
    }
    if (buf.length > hashMax) continue;
    srcHashes.push({ name: att.filename, sha256: sha256Hex(buf) });
  }

  const list = graphAttachmentList || [];
  for (const g of graphAttachmentsToCompareList(list)) {
    if (!g.filename) continue;
    let buf;
    try {
      const meta = list.find((x) => (x.name || x.filename) === g.filename);
      if (!meta || !meta.id) continue;
      const token = await outlookClient.getAccessToken(destUser);
      const axios = require('axios');
      const uid = encodeURIComponent(String(destUser || '').trim());
      const mid = encodeURIComponent(destMessageId);
      const aid = encodeURIComponent(meta.id);
      const url = `https://graph.microsoft.com/v1.0/users/${uid}/messages/${mid}/attachments/${aid}/$value`;
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: hashMax + 1,
      });
      buf = Buffer.from(res.data);
    } catch (e) {
      log.warn(`Deep validation: Graph attachment read failed ${g.filename}: ${e.message}`);
      continue;
    }
    if (buf.length > hashMax) continue;
    dstHashes.push({ name: g.filename, sha256: sha256Hex(buf) });
  }

  return { srcHashes, dstHashes };
}

async function tierBHashesOutlookToGmail(srcUser, srcMessageId, graphAttachmentList, destUser, gmailFull, log) {
  const hashMax = intEnv('MAIL_DEEP_HASH_MAX_BYTES', 10485760);
  const srcHashes = [];
  const dstHashes = [];
  const axios = require('axios');

  const token = await outlookClient.getAccessToken(srcUser);
  for (const att of graphAttachmentsToCompareList(graphAttachmentList)) {
    const meta = graphAttachmentList.find((x) => (x.name || x.filename) === att.filename);
    if (!meta?.id) continue;
    let buf;
    try {
      const uid = encodeURIComponent(String(srcUser).trim());
      const mid = encodeURIComponent(srcMessageId);
      const aid = encodeURIComponent(meta.id);
      const url = `https://graph.microsoft.com/v1.0/users/${uid}/messages/${mid}/attachments/${aid}/$value`;
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: hashMax + 1,
      });
      buf = Buffer.from(res.data);
    } catch (e) {
      log.warn(`Tier B (O→G): Outlook attachment read failed ${att.filename}: ${e.message}`);
      continue;
    }
    if (buf.length > hashMax) continue;
    srcHashes.push({ name: att.filename, sha256: sha256Hex(buf) });
  }

  for (const att of gmailFull.attachments || []) {
    if (!att.filename || !att.attachmentId) continue;
    let buf;
    try {
      buf = await gmailClient.getAttachmentData(destUser, gmailFull.id, att.attachmentId);
    } catch (e) {
      log.warn(`Tier B (O→G): Gmail attachment read failed ${att.filename}: ${e.message}`);
      continue;
    }
    if (buf.length > hashMax) continue;
    dstHashes.push({ name: att.filename, sha256: sha256Hex(buf) });
  }

  return { srcHashes, dstHashes };
}

/**
 * @param {import('../models/MigrationContext')} context
 * @param {import('../models/ValidationResult')} result
 */
async function runDeepMailValidation(context, result, log) {
  const maxMessages = intEnv('DEEP_VALIDATION_MAX_MESSAGES', 500);
  const subjectPrefix = (process.env.DEEP_VALIDATION_SUBJECT_PREFIX || 'QA ').trim();
  /** Full body comparison (normalized plain text) — default on; set MAIL_DEEP_VALIDATE_BODY=false to skip. */
  const tierC = boolEnv('MAIL_DEEP_VALIDATE_BODY', true);
  const tierB = boolEnv('MAIL_DEEP_VALIDATE_ATTACHMENT_HASH', false);

  result.deepMailValidation.enabled = true;
  result.deepMailValidation.summary = '';

  const destUser = context.destinationEmail;
  const srcUser = context.sourceEmail;
  const srcProvider = context.sourceProvider || 'google';
  const dstProvider = context.destinationProvider || 'microsoft';

  if (srcProvider === 'google' && dstProvider === 'microsoft') {
    await validateGmailSource({ context, result, destUser, srcUser, maxMessages, subjectPrefix, tierB, tierC, log });
  } else if (srcProvider === 'microsoft' && dstProvider === 'microsoft') {
    await validateOutlookSource({ context, result, destUser, srcUser, maxMessages, subjectPrefix, tierB, tierC, log });
  } else if (srcProvider === 'microsoft' && dstProvider === 'google') {
    // Enable Tier B attachment hash for O→G by default (env MAIL_DEEP_VALIDATE_ATTACHMENT_HASH_OG=false to disable)
    const tierBOG = tierB || boolEnv('MAIL_DEEP_VALIDATE_ATTACHMENT_HASH_OG', true);
    await validateOutlookToGmailDestination({ context, result, destUser, srcUser, maxMessages, subjectPrefix, tierB: tierBOG, tierC, log });
  } else {
    throw new Error(`Deep validation: unsupported combination sourceProvider=${srcProvider} → destinationProvider=${dstProvider}`);
  }

  const paired = result.deepMailValidation.messageResults.filter((r) => r.destMessageId).length;
  const failed = result.deepMailValidation.messageResults.filter((r) => !r.pass).length;
  result.deepMailValidation.pairedCount = paired;
  const threadChains = result.deepMailValidation.threadChainResults?.length || 0;
  const threadChainsFailed = result.deepMailValidation.threadChainResults?.filter((t) => !t.pass).length || 0;
  const threadSuffix = threadChains > 0
    ? `, threads ${threadChains - threadChainsFailed}/${threadChains} OK`
    : '';
  result.deepMailValidation.summary = `Deep mail: scanned ${result.deepMailValidation.scannedSourceMessages}, paired ${paired}, failed ${failed}${threadSuffix}`;
}

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
      result.addDeepMailMessageResult({
        sourceMessageId: id,
        internetMessageId: mid,
        destMessageId: null,
        subject: full.subject || '',
        pass: false,
        note: unmatchedNote,
        diffs: [],
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
      result.addDeepMailMessageResult({
        sourceMessageId: summary.id,
        internetMessageId: mid,
        destMessageId: null,
        subject: srcFull.subject || summary.subject || '',
        pass: false,
        note: noteOO,
        diffs: [],
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

    // sentDateTime: source vs destination Outlook (warning)
    {
      const toleranceMs = intEnv('DEEP_VALIDATION_SENT_TIME_TOLERANCE_MINUTES', 5) * 60000;
      diffs = diffs.concat(compareSentDateTime(srcFull.sentDateTime, destFull.sentDateTime, toleranceMs));
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

    if (tierB) {
      log.warn('Tier B attachment hash for Outlook→Outlook is not implemented in v1; skipping.');
    }

    const hasError = diffs.some((d) => d.severity === 'error');
    result.addDeepMailMessageResult({
      sourceMessageId: summary.id,
      internetMessageId: mid,
      destMessageId: destSummary.id,
      subject: srcFull.subject || summary.subject || '',
      pass: !hasError,
      diffs,
    });
  }
}

/**
 * Folders to skip when scanning Outlook source for QA messages.
 * These are system/meta folders that never hold user mail.
 */
const OUTLOOK_SKIP_SCAN_FOLDERS = new Set([
  'drafts',
  'outbox',
  'conversation history',
  'sync issues',
  'conflicts',
  'local failures',
  'server failures',
  'recoverable items',
  'purges',
  'deletions',
  'versions',
  'audits',
  'discoveryholds',
  'rss feeds',
  'rss subscriptions',
  'clutter',
  'search folders',
  'quick step settings',
  'calendar',
  'contacts',
  'tasks',
  'journal',
  'notes',
]);

/**
 * Collect QA-tagged messages from all scannable Outlook folders for the source mailbox.
 * Scans every non-system folder (Inbox, Sent Items, Junk, Deleted Items, Archive, custom…)
 * so deep validation covers the full seeded set, not just Inbox.
 */
async function collectOutlookQaCandidates(srcUser, maxMessages, subjectPrefix, selectFields, log) {
  const folders = await outlookClient.getAllFoldersFlat(srcUser);
  if (!folders?.length) return [];

  const scanFolders = folders.filter(
    (f) => f.id && !OUTLOOK_SKIP_SCAN_FOLDERS.has((f.displayName || '').toLowerCase())
  );

  const perFolderCap = Math.min(
    Math.ceil((maxMessages * 20) / Math.max(scanFolders.length, 1)),
    500
  );
  const seenIds = new Set();
  const candidates = [];

  for (const folder of scanFolders) {
    if (candidates.length >= maxMessages) break;
    try {
      const listed = await outlookClient.listMessagesInFolderPaged(
        srcUser, folder.id, perFolderCap, selectFields
      );
      for (const m of listed) {
        if (seenIds.has(m.id)) continue;
        seenIds.add(m.id);
        const sub = normalizeSubject(m.subject);
        if (sub.startsWith(subjectPrefix) || /^QA\b/i.test(sub)) {
          candidates.push(m);
          if (candidates.length >= maxMessages) break;
        }
      }
    } catch (e) {
      log.warn(`Deep validation: could not list messages in Outlook folder "${folder.displayName}": ${e.message}`);
    }
  }

  return candidates;
}

// Outlook well-known folder → expected Gmail system label
const OUTLOOK_FOLDER_TO_GMAIL_LABEL = new Map([
  ['inbox',         'INBOX'],
  ['sent items',    'SENT'],
  ['sent',          'SENT'],
  ['drafts',        'DRAFT'],
  ['draft',         'DRAFT'],
  ['deleted items', 'TRASH'],
  ['trash',         'TRASH'],
  ['junk email',    'SPAM'],
  ['junk',          'SPAM'],
  ['spam',          'SPAM'],
  ['archive',       'Archive[Gmail]'],
]);

// Outlook well-known folder names that are handled by other rules or have no Gmail label equivalent
const OUTLOOK_PLACEMENT_SKIP = new Set([
  'inbox', 'sent items', 'sent', 'drafts', 'draft',
  'deleted items', 'junk email', 'junk', 'spam', 'outbox',
  'conversation history', 'recoverable items', 'clutter',
  'rss feeds', 'rss subscriptions', 'search folders', 'sync issues',
  'quick step settings', 'calendar', 'contacts', 'tasks',
]);

function validateOutlookToGmailPlacement(outlookFolderPath, gmailLabelsStr, severity = 'error') {
  const folder = String(outlookFolderPath || '').toLowerCase().trim();
  const labels = parseGmailLabels(gmailLabelsStr).map((l) => l.toUpperCase());
  const expectedLabel = OUTLOOK_FOLDER_TO_GMAIL_LABEL.get(folder);

  // System folder check (case-insensitive for Archive[Gmail] which CloudFuze may create as Archive[GMAIL])
  if (expectedLabel) {
    const expectedUpper = expectedLabel.toUpperCase();
    if (labels.some((l) => l.toUpperCase() === expectedUpper)) return [];
    return [{
      field: 'folder',
      ok: false,
      expected: `Gmail label ${expectedLabel} (from Outlook: ${outlookFolderPath})`,
      actual: gmailLabelsStr || '(no labels)',
      displaySource: outlookFolderPath,
      displayDestination: gmailLabelsStr || '(no labels)',
      severity,
    }];
  }

  // Skip well-known non-mail or archive folders
  if (OUTLOOK_PLACEMENT_SKIP.has(folder) || !outlookFolderPath) return [];

  // Custom folder: check the leaf folder name appears in any Gmail label (case-insensitive)
  const rawPath = String(outlookFolderPath).trim();
  const leafName = rawPath.split('/').pop().trim().toLowerCase();
  if (!leafName) return [];
  const gmailLabelsLower = parseGmailLabels(gmailLabelsStr).map((l) => l.toLowerCase().trim());
  const matched = gmailLabelsLower.some(
    (l) => l === leafName || l === rawPath.toLowerCase() || l.endsWith('/' + leafName)
  );
  if (matched) return [];
  return [{
    field: 'folder',
    ok: false,
    expected: `Gmail label containing "${rawPath}"`,
    actual: gmailLabelsStr || '(no labels)',
    displaySource: rawPath,
    displayDestination: gmailLabelsStr || '(no labels)',
    severity: 'warning',
  }];
}

/**
 * Strip quoted-reply text from a normalised plain-text email body.
 * Stops at the first ">" line, "On … wrote:" header, or "-----Original Message-----" marker
 * so that per-position body comparisons only consider the new top-posted content.
 */
function stripQuotedLines(text) {
  if (!text) return text;
  const lines = String(text).split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith('>')) break;
    if (/^On .{10,200}wrote:/i.test(t)) break;
    if (t.startsWith('-----Original Message-----')) break;
    out.push(line);
  }
  while (out.length > 0 && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

/**
 * Validate Outlook→Gmail thread chains using POSITIONAL PAIRING.
 *
 * For each Outlook conversation that has ≥1 paired entry in messageResults:
 *   1. Fetch the FULL conversation from Outlook (sorted by sentDateTime ASC)
 *   2. Fetch the FULL Gmail thread (sorted by internalDate ASC)
 *   3. Pair Outlook[i] ↔ Gmail[i] by position (0 = root, 1 = first reply, …)
 *   4. Fetch full bodies and run Tier A/B/C comparisons for each positional pair
 *   5. UPDATE existing messageResults entries (root/scanned messages) with the
 *      corrected Gmail destMessageId and re-computed diffs
 *   6. ADD new messageResults entries for reply messages the main scan never visited
 *      (their subjects start with "RE:" so collectOutlookQaCandidates skips them)
 *
 * opts: { tierC, tierB, labelIdToName, folderSeverity, tierAOpts }
 */
async function validateOutlookToGmailThreadChains(result, srcUser, destUser, log, opts = {}) {
  const {
    tierC = false,
    tierB = false,
    labelIdToName = new Map(),
    folderSeverity = 'error',
    tierAOpts = {},
  } = opts;

  // Build conversationId → { gmailThreadIds: Set, pairedEntries: [] }
  const convMap = new Map();
  for (const entry of result.deepMailValidation.messageResults) {
    if (!entry._conversationId) continue;
    if (!convMap.has(entry._conversationId)) {
      convMap.set(entry._conversationId, { gmailThreadIds: new Set(), pairedEntries: [] });
    }
    const slot = convMap.get(entry._conversationId);
    slot.pairedEntries.push(entry);
    if (entry._gmailThreadId) slot.gmailThreadIds.add(entry._gmailThreadId);
  }

  const candidates = [...convMap.entries()].filter(([, v]) => v.pairedEntries.length > 0);
  if (candidates.length === 0) return;

  result.deepMailValidation.threadChainResults = [];
  log.info(`Thread chain validation: ${candidates.length} Outlook conversation(s) to check`);

  for (const [convId, { gmailThreadIds, pairedEntries }] of candidates) {
    // Pick the most-common Gmail threadId (handles occasional split messages)
    const threadIdCounts = new Map();
    for (const tid of gmailThreadIds) threadIdCounts.set(tid, (threadIdCounts.get(tid) || 0) + 1);
    const primaryGmailThreadId = [...threadIdCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // 1. Fetch full Outlook conversation (sorted ASC by sentDateTime)
    let outlookMsgs = [];
    let outlookAvailable = false;
    try {
      const oc = await outlookClient.getConversationMessages(srcUser, convId);
      outlookMsgs = oc.messages || [];
      outlookAvailable = oc.available;
      if (!outlookAvailable) log.warn(`Thread chain: Outlook conversation ${convId}: ${oc.note}`);
    } catch (e) {
      log.warn(`Thread chain: Outlook conversation ${convId} fetch failed: ${e.message}`);
    }
    outlookMsgs.sort((a, b) => new Date(a.sentDateTime || 0) - new Date(b.sentDateTime || 0));

    // 2. Fetch full Gmail thread (sorted ASC by internalDate)
    let gmailMsgs = [];
    let gmailAvailable = false;
    if (primaryGmailThreadId) {
      try {
        const gc = await gmailClient.getGmailThread(destUser, primaryGmailThreadId);
        gmailMsgs = gc.messages || [];
        gmailAvailable = gc.available;
        if (!gmailAvailable) log.warn(`Thread chain: Gmail thread ${primaryGmailThreadId}: ${gc.note}`);
      } catch (e) {
        log.warn(`Thread chain: Gmail thread ${primaryGmailThreadId} fetch failed: ${e.message}`);
      }
    }
    gmailMsgs.sort((a, b) => (a.internalDate || 0) - (b.internalDate || 0));

    const outlookCount = outlookMsgs.length || pairedEntries.length;
    const gmailCount = gmailMsgs.length;
    const mismatches = [];

    // 3a. Split thread: Outlook conversation maps to multiple Gmail threadIds
    if (gmailThreadIds.size > 1) {
      mismatches.push({
        field: 'threadSplit',
        ok: false,
        expected: '1 Gmail threadId for the entire Outlook conversation',
        actual: `${gmailThreadIds.size} Gmail threadId(s): ${[...gmailThreadIds].join(', ')}`,
        displaySource: `Outlook conversationId: ${convId}`,
        displayDestination: `Split into: ${[...gmailThreadIds].join(', ')}`,
        severity: 'error',
      });
    }

    // 3b. Message count mismatch
    if (outlookAvailable && gmailAvailable && outlookCount !== gmailCount) {
      const missing = outlookCount - gmailCount;
      mismatches.push({
        field: 'threadCount',
        ok: false,
        expected: `${outlookCount} message(s) in Gmail thread (matching Outlook conversation)`,
        actual: `${gmailCount} message(s) in Gmail thread`,
        displaySource: `Outlook: ${outlookCount} message(s)`,
        displayDestination: `Gmail: ${gmailCount} message(s)${missing > 0 ? ` — ${missing} missing` : ` — ${-missing} extra`}`,
        severity: 'error',
      });
    }

    // 4. POSITIONAL PAIRING: Outlook[i] ↔ Gmail[i], fetch full bodies and re-validate each pair
    const messageComparisons = [];
    if (outlookAvailable && gmailAvailable && outlookMsgs.length > 0 && gmailMsgs.length > 0) {
      const pairLen = Math.min(outlookMsgs.length, gmailMsgs.length);

      for (let i = 0; i < pairLen; i++) {
        const omSummary = outlookMsgs[i];
        const gmSummary = gmailMsgs[i];

        let omFull = null;
        try {
          omFull = await outlookClient.getMessageById(srcUser, omSummary.id);
        } catch (e) {
          log.warn(`Thread chain pos ${i}: Outlook getMessageById ${omSummary.id} failed: ${e.message}`);
        }

        let gmFull = null;
        try {
          gmFull = await gmailClient.getMessageFullForValidation(destUser, gmSummary.id);
        } catch (e) {
          log.warn(`Thread chain pos ${i}: Gmail getMessageFullForValidation ${gmSummary.id} failed: ${e.message}`);
        }

        if (!omFull || !gmFull) {
          messageComparisons.push({
            position: i, outlookId: omSummary.id, gmailId: gmSummary.id,
            pass: false, diffs: [], note: 'Failed to fetch full message content',
          });
          continue;
        }

        let graphAttSrc = [];
        try {
          graphAttSrc = await outlookClient.getAttachments(srcUser, omSummary.id);
        } catch (e) {
          log.warn(`Thread chain pos ${i}: attachments for ${omSummary.id}: ${e.message}`);
        }

        const sourceForTierA = {
          subject: omFull.subject,
          from: omFull.from,
          toEmails: graphRecipientsToEmails(omFull.toRecipients),
          ccEmails: graphRecipientsToEmails(omFull.ccRecipients),
          bccEmails: graphRecipientsToEmails(omFull.bccRecipients),
          replyTo: omFull.replyTo,
          attachments: graphAttachmentsToCompareList(graphAttSrc).map((a) => ({ filename: a.filename, size: a.size })),
        };
        const destForTierA = {
          subject: gmFull.subject,
          fromEmails: parseRecipientEmails(gmFull.from),
          toEmails: parseRecipientEmails(gmFull.to),
          ccEmails: parseRecipientEmails(gmFull.cc),
          bccEmails: parseRecipientEmails(gmFull.bcc),
          replyTo: gmFull.replyTo || '',
          attachments: (gmFull.attachments || []).map((a) => ({ filename: a.filename, size: a.size })),
        };

        let diffs = compareTierA(sourceForTierA, destForTierA, tierAOpts);
        diffs = diffs.concat(
          compareAttachmentSizesWithTolerance(sourceForTierA.attachments, destForTierA.attachments, 'outlook_to_gmail')
        );

        let srcFolderStr = '';
        if (omFull.parentFolderId) {
          try {
            srcFolderStr = await outlookClient.getMailFolderPathString(srcUser, omFull.parentFolderId);
          } catch (e) {
            log.warn(`Thread chain pos ${i}: folder path: ${e.message}`);
          }
        }
        const gmailLabelsStr = gmailClient.formatGmailLabelsForCompare(gmFull.labelIds, labelIdToName);
        diffs = diffs.concat(validateOutlookToGmailPlacement(srcFolderStr, gmailLabelsStr, folderSeverity));
        diffs = diffs.concat(compareOutlookReadToGmailUnread(omFull.isRead, gmFull.labelIds));
        diffs = diffs.concat(compareOutlookFlagToGmailStarred(omFull.flag?.flagStatus, gmFull.labelIds));
        diffs = diffs.concat(compareOutlookImportanceToGmailImportant(omFull.importance, gmFull.labelIds));

        // Tier C body: for replies (i > 0) strip quoted lines before comparing so that
        // "RE:" messages aren't penalised for carrying the parent chain in their body
        if (tierC) {
          const srcBodyRaw = omFull.body?.content || omFull.bodyPreview || '';
          const dstHtml = gmailClient.extractHtmlBodyFromPayload(gmFull.payload);
          const dstBodyRaw = dstHtml
            ? htmlToPlainLoose(dstHtml)
            : gmailClient.extractPlainBodyFromPayload(gmFull.payload) || gmFull.snippet || '';

          const srcBodyNorm = normalizeMailBodyPlain(htmlToPlainLoose(srcBodyRaw) || srcBodyRaw);
          const dstBodyNorm = normalizeMailBodyPlain(dstBodyRaw);
          const isReply = i > 0;
          const srcBodyCmp = isReply ? stripQuotedLines(srcBodyNorm) : srcBodyNorm;
          const dstBodyCmp = isReply ? stripQuotedLines(dstBodyNorm) : dstBodyNorm;

          const bodyMax = intEnv('MAIL_DEEP_BODY_MAX_CHARS', 500000);
          diffs = diffs.concat(compareTierC(srcBodyCmp, dstBodyCmp, {
            bodyMismatchSeverity: 'error', maxChars: bodyMax,
            hasAttachments: graphAttSrc.length > 0,
            destHasAttachments: (gmFull.attachments || []).length > 0,
          }));
        }

        // Tier B attachment hash for O→G
        if (tierB && graphAttSrc.length > 0) {
          try {
            const { srcHashes, dstHashes } = await tierBHashesOutlookToGmail(
              srcUser, omSummary.id, graphAttSrc, destUser, gmFull, log
            );
            const tierBDiffs = compareTierBHashes(srcHashes, dstHashes);
            if (tierBDiffs.every((d) => d.ok !== false)) {
              for (const d of diffs) {
                if (d.field?.startsWith('attachmentSize:') && d.severity === 'warning') {
                  d.severity = 'info'; d.ok = true;
                  d.note = '[Tier B hash verified — content is identical] ' + (d.note || '');
                }
              }
            }
            diffs = diffs.concat(tierBDiffs);
          } catch (e) {
            log.warn(`Thread chain pos ${i}: Tier B hash: ${e.message}`);
          }
        }

        const hasError = diffs.some((d) => d.severity === 'error');
        messageComparisons.push({
          position: i, outlookId: omSummary.id, gmailId: gmSummary.id,
          subject: omFull.subject || '', pass: !hasError, diffs,
        });

        // UPDATE existing entry (root/scanned message) with the correct Gmail pairing
        // and re-computed diffs, or ADD a new entry for reply messages the main scan skipped
        const existingEntry = pairedEntries.find((e) => e.sourceMessageId === omSummary.id);
        if (existingEntry) {
          const oldDestId = existingEntry.destMessageId;
          existingEntry.destMessageId = gmSummary.id;
          existingEntry._gmailThreadId = gmFull.threadId || primaryGmailThreadId;
          existingEntry.diffs = diffs;
          existingEntry.pass = !hasError;
          if (oldDestId && oldDestId !== gmSummary.id) {
            log.info(
              `Thread chain: corrected pairing pos ${i} "${omFull.subject}": ` +
              `Gmail ${oldDestId} → ${gmSummary.id}`
            );
          }
        } else {
          result.addDeepMailMessageResult({
            sourceMessageId: omSummary.id,
            internetMessageId: omSummary.internetMessageId || '',
            destMessageId: gmSummary.id,
            subject: omFull.subject || omSummary.subject || '',
            pass: !hasError, diffs,
            _conversationId: convId,
            _gmailThreadId: gmFull.threadId || primaryGmailThreadId,
            _threadPosition: i,
          });
        }
      }
    }

    const rootSubject = outlookMsgs[0]?.subject || pairedEntries[0]?.subject || '(unknown)';
    const structuralErrors = mismatches.filter((m) => m.severity === 'error').length;
    const pairErrors = messageComparisons.filter((mc) => !mc.pass).length;
    const pass = structuralErrors === 0 && pairErrors === 0;

    result.deepMailValidation.threadChainResults.push({
      conversationId: convId,
      primaryGmailThreadId,
      allGmailThreadIds: [...gmailThreadIds],
      rootSubject,
      outlookMessageCount: outlookCount,
      gmailMessageCount: gmailCount,
      countMatch: outlookCount === gmailCount,
      threadSplit: gmailThreadIds.size > 1,
      pass,
      mismatches,
      messageComparisons,
      outlookSubjects: outlookMsgs.map((m) => m.subject),
      gmailSubjects: gmailMsgs.map((m) => m.subject),
    });

    if (!pass) {
      log.warn(
        `Thread chain FAIL: "${rootSubject}" — Outlook=${outlookCount} Gmail=${gmailCount} ` +
        `split=${gmailThreadIds.size > 1} structuralErrors=${structuralErrors} pairErrors=${pairErrors}`
      );
    }
  }

  const failed = result.deepMailValidation.threadChainResults.filter((t) => !t.pass).length;
  const total = result.deepMailValidation.threadChainResults.length;
  if (total > 0) {
    log.info(`Thread chain validation complete: ${total} conversation(s) checked, ${failed} failed`);
  }
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
            let best = fb[0];
            // Multiple candidates can share the same normalized subject (e.g. a thread original and
            // its RE: replies). Pick the candidate whose reply-prefix status matches the source so
            // that "QA E2E 4 - Thread Chain Test" (original) isn't paired with "RE: QA E2E 4"
            // (reply) just because the reply is more recent and appears first in Gmail results.
            if (fb.length > 1) {
              const srcIsReply = /^re:/i.test((srcFull.subject || '').trim());
              for (const cand of fb) {
                try {
                  const meta = await gmailClient.getMessageMetadata(destUser, cand.id);
                  const candIsReply = /^re:/i.test((meta.subject || '').trim());
                  if (candIsReply === srcIsReply) { best = cand; break; }
                } catch { /* skip, fall back to first */ }
              }
            }
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
        if (subjectOnly.length === 1) {
          gmailMatches = subjectOnly;
          pairingStrategy = 'subject-only';
        } else if (subjectOnly.length > 1) {
          // Multiple matches — try to pick the one whose RE: prefix matches the source
          const srcIsReply = /^re:/i.test((srcFull.subject || '').trim());
          let best = null;
          for (const cand of subjectOnly) {
            try {
              const meta = await gmailClient.getMessageMetadata(destUser, cand.id);
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
        log.warn(`Deep validation (O→G): Gmail subject-only fallback failed: ${e.message}`);
      }
    }

    if (gmailMatches.length === 0) {
      result.deepMailValidation.unmatchedSourceIds.push(summary.id);
      result.addDeepMailMessageResult({
        sourceMessageId: summary.id, internetMessageId: mid,
        destMessageId: null, subject: srcFull.subject || summary.subject || '',
        pass: false,
        note: `No Gmail message with matching Message-ID${boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true) ? `; subject+time fallback (±${windowMin}m) also found no candidate; subject-only fallback also found no match.` : ''}`,
        diffs: [],
      });
      continue;
    }

    const gmailRef = gmailMatches[0];
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
    result.addDeepMailMessageResult({
      sourceMessageId: summary.id, internetMessageId: mid,
      destMessageId: gmailRef.id, subject: srcFull.subject || summary.subject || '',
      pass: !hasError, diffs,
      _conversationId: srcFull.conversationId || null,
      _gmailThreadId: gmailFull.threadId || null,
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
}

module.exports = { runDeepMailValidation };
