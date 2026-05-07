/**
 * Deep source↔destination mail validation (Tier A/B/C).
 * Destination must be Microsoft Graph (Outlook). Source: Gmail or Outlook.
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
  buildRecipientEmailMapping,
  compareFolderPlacement,
  validateGmailToOutlookPlacement,
  parseGmailLabels,
  normalizeMailBodyPlain,
  htmlToPlainLoose,
} = require('../utils/mailMigrationComparator');

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
  const raw = (process.env.DEEP_VALIDATION_GMAIL_LABELS || 'INBOX,SENT').trim();
  const parts = raw
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : ['INBOX', 'SENT'];
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
  const hashMax = intEnv('MAIL_DEEP_HASH_MAX_BYTES', 262144);
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

  if ((context.destinationProvider || 'microsoft') !== 'microsoft') {
    result.deepMailValidation.summary = 'Deep validation skipped: destination is not Microsoft (Graph).';
    return;
  }

  const destUser = context.destinationEmail;
  const srcUser = context.sourceEmail;

  if (context.sourceProvider === 'google') {
    await validateGmailSource({ context, result, destUser, srcUser, maxMessages, subjectPrefix, tierB, tierC, log });
  } else if (context.sourceProvider === 'microsoft') {
    await validateOutlookSource({ context, result, destUser, srcUser, maxMessages, subjectPrefix, tierB, tierC, log });
  } else {
    result.deepMailValidation.summary = `Deep validation skipped: unsupported sourceProvider=${context.sourceProvider}`;
  }

  const paired = result.deepMailValidation.messageResults.filter((r) => r.destMessageId).length;
  const failed = result.deepMailValidation.messageResults.filter((r) => !r.pass).length;
  result.deepMailValidation.pairedCount = paired;
  result.deepMailValidation.summary = `Deep mail: scanned ${result.deepMailValidation.scannedSourceMessages}, paired ${paired}, failed ${failed}`;
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

  const labelIds = gmailSystemLabelsForDeepValidation();
  const idCap = Math.min(maxMessages * 15, 7500);
  const perLabelCap = Math.max(Math.ceil(idCap / labelIds.length), 100);
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
        diffs = diffs.concat(compareTierBHashes(srcHashes, dstHashes));
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

  const folders = await outlookClient.getAllFoldersFlat(srcUser);
  const inbox = folders.find((f) => (f.displayName || '').toLowerCase() === 'inbox');
  if (!inbox?.id) {
    result.deepMailValidation.summary = 'Outlook source: Inbox folder not found.';
    return;
  }

  const listed = await outlookClient.listMessagesInFolderPaged(
    srcUser,
    inbox.id,
    Math.min(maxMessages * 20, 2000),
    'id,internetMessageId,subject,hasAttachments,receivedDateTime'
  );

  const candidates = listed.filter((m) => {
    const sub = normalizeSubject(m.subject);
    return sub.startsWith(subjectPrefix) || /^QA\b/i.test(sub);
  }).slice(0, maxMessages);

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

module.exports = { runDeepMailValidation };
