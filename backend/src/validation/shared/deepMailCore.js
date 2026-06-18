/**
 * Deep source↔destination mail validation (Tier A/B/C).
 * Supports: Gmail→Outlook, Outlook→Outlook, Outlook→Gmail.
 */

const gmailClient = require('../../clients/gmailClient');
const outlookClient = require('../../clients/outlookClient');
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
} = require('../../utils/mailMigrationComparator');

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

async function tierBHashesOutlookToOutlook(srcUser, srcMessageId, graphAttSrc, destUser, destMessageId, graphAttDst, log) {
  const hashMax = intEnv('MAIL_DEEP_HASH_MAX_BYTES', 10485760);
  const srcHashes = [];
  const dstHashes = [];
  const axios = require('axios');

  const srcToken = await outlookClient.getAccessToken(srcUser);
  for (const att of graphAttachmentsToCompareList(graphAttSrc)) {
    const meta = graphAttSrc.find((x) => (x.name || x.filename) === att.filename);
    if (!meta?.id) continue;
    let buf;
    try {
      const uid = encodeURIComponent(String(srcUser).trim());
      const mid = encodeURIComponent(srcMessageId);
      const aid = encodeURIComponent(meta.id);
      const url = `https://graph.microsoft.com/v1.0/users/${uid}/messages/${mid}/attachments/${aid}/$value`;
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${srcToken}` },
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: hashMax + 1,
      });
      buf = Buffer.from(res.data);
    } catch (e) {
      log.warn(`Tier B (O→O): source attachment read failed ${att.filename}: ${e.message}`);
      continue;
    }
    if (buf.length > hashMax) continue;
    srcHashes.push({ name: att.filename, sha256: sha256Hex(buf) });
  }

  const dstToken = await outlookClient.getAccessToken(destUser);
  for (const att of graphAttachmentsToCompareList(graphAttDst)) {
    const meta = graphAttDst.find((x) => (x.name || x.filename) === att.filename);
    if (!meta?.id) continue;
    let buf;
    try {
      const uid = encodeURIComponent(String(destUser).trim());
      const mid = encodeURIComponent(destMessageId);
      const aid = encodeURIComponent(meta.id);
      const url = `https://graph.microsoft.com/v1.0/users/${uid}/messages/${mid}/attachments/${aid}/$value`;
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${dstToken}` },
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: hashMax + 1,
      });
      buf = Buffer.from(res.data);
    } catch (e) {
      log.warn(`Tier B (O→O): dest attachment read failed ${att.filename}: ${e.message}`);
      continue;
    }
    if (buf.length > hashMax) continue;
    dstHashes.push({ name: att.filename, sha256: sha256Hex(buf) });
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

  const THREAD_BATCH = 10;
  const candidateEntries = [...candidates];

  for (let bi = 0; bi < candidateEntries.length; bi += THREAD_BATCH) {
    const batchResults = await Promise.all(
      candidateEntries.slice(bi, bi + THREAD_BATCH).map(async ([convId, { gmailThreadIds, pairedEntries }]) => {
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

    return {
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
    };
  }));
    for (const chainResult of batchResults) {
      result.deepMailValidation.threadChainResults.push(chainResult);
      if (!chainResult.pass) {
        const structuralErrors = chainResult.mismatches.filter((m) => m.severity === 'error').length;
        const pairErrors = chainResult.messageComparisons.filter((mc) => !mc.pass).length;
        log.warn(
          `Thread chain FAIL: "${chainResult.rootSubject}" — Outlook=${chainResult.outlookMessageCount} Gmail=${chainResult.gmailMessageCount} ` +
          `split=${chainResult.threadSplit} structuralErrors=${structuralErrors} pairErrors=${pairErrors}`
        );
      }
    }
  }

  const failed = result.deepMailValidation.threadChainResults.filter((t) => !t.pass).length;
  const total = result.deepMailValidation.threadChainResults.length;
  if (total > 0) {
    log.info(`Thread chain validation complete: ${total} conversation(s) checked, ${failed} failed`);
  }
}

/**
 * Validate Outlook→Outlook thread chains using POSITIONAL PAIRING.
 *
 * For each Outlook source conversation that has ≥2 messages with a paired destination entry:
 *   1. Fetch the FULL source conversation from Outlook (sorted by sentDateTime ASC)
 *   2. Collect destination message IDs: use already-resolved destMessageId from messageResults
 *      where available; for messages the main scan missed (RE: replies), resolve by internetMessageId.
 *   3. Sort destination messages by sentDateTime ASC (fetch summary if needed)
 *   4. Verify: same count; same order (internetMessageIds at matching positions)
 *   5. Verify: inReplyTo chain — each message[i].inReplyTo (from internetMessageHeaders)
 *      should match message[i-1].internetMessageId in destination
 *   6. Run Tier A/B/C per-position comparisons for each pair
 *   7. UPDATE existing messageResults entries; ADD new entries for reply messages skipped by main scan
 *   8. Record results in result.deepMailValidation.threadChainResults
 *
 * opts: { tierC, tierB, tierAOpts }
 */
async function validateOutlookToOutlookThreadChains(result, srcUser, destUser, log, opts = {}) {
  const {
    tierC = false,
    tierB = false,
    tierAOpts = {},
  } = opts;

  // Build conversationId → { pairedEntries: [], knownDestIds: Map<srcMsgId, destMsgId> }
  const convMap = new Map();
  for (const entry of result.deepMailValidation.messageResults) {
    if (!entry._conversationId) continue;
    if (!convMap.has(entry._conversationId)) {
      convMap.set(entry._conversationId, { pairedEntries: [], knownDestIds: new Map() });
    }
    const slot = convMap.get(entry._conversationId);
    slot.pairedEntries.push(entry);
    if (entry.destMessageId) {
      slot.knownDestIds.set(entry.sourceMessageId, entry.destMessageId);
    }
  }

  // Only process conversations with ≥2 messages in the source conversation
  // (single-message conversations have no thread chain to validate)
  const candidates = [...convMap.entries()].filter(([, v]) => v.pairedEntries.length > 0);
  if (candidates.length === 0) return;

  result.deepMailValidation.threadChainResults = result.deepMailValidation.threadChainResults || [];
  log.info(`Thread chain validation (O→O): ${candidates.length} Outlook conversation(s) to check`);

  /** Select that includes internetMessageHeaders so we can extract In-Reply-To */
  const SELECT_WITH_HEADERS =
    'internetMessageId,subject,bodyPreview,body,hasAttachments,receivedDateTime,sentDateTime,' +
    'toRecipients,ccRecipients,bccRecipients,replyTo,from,parentFolderId,flag,importance,' +
    'isRead,categories,conversationId,internetMessageHeaders';

  for (const [convId, { pairedEntries, knownDestIds }] of candidates) {
    // 1. Fetch full source conversation (sorted ASC by sentDateTime)
    let srcMsgs = [];
    let srcAvailable = false;
    try {
      const oc = await outlookClient.getConversationMessages(srcUser, convId);
      srcMsgs = oc.messages || [];
      srcAvailable = oc.available;
      if (!srcAvailable) log.warn(`Thread chain (O→O): source conversation ${convId}: ${oc.note}`);
    } catch (e) {
      log.warn(`Thread chain (O→O): source conversation ${convId} fetch failed: ${e.message}`);
    }
    srcMsgs.sort((a, b) => new Date(a.sentDateTime || 0) - new Date(b.sentDateTime || 0));

    // Skip single-message conversations — nothing positional to validate
    if (srcMsgs.length < 2 && pairedEntries.length < 2) continue;

    // 2. Build the destination message list.
    //    For source messages already resolved in the main loop: use knownDestIds.
    //    For others (RE: replies the main scan skipped): resolve fresh by internetMessageId.
    const scanMaxOO = intEnv('DEEP_VALIDATION_SCAN_MAX', 3000);
    const dstMsgSummaries = []; // { srcId, dstId, sentDateTime, internetMessageId }

    for (const sm of srcMsgs) {
      const srcId = sm.id;
      const srcMid = sm.internetMessageId || '';

      // Check if already resolved by main loop
      let dstId = knownDestIds.get(srcId) || null;

      // If not, try to resolve by internetMessageId
      if (!dstId && srcMid) {
        try {
          const resolved = await outlookClient.resolveDestinationByInternetMessageId(destUser, srcMid, {
            maxScan: scanMaxOO,
          });
          if (resolved.matches.length > 0) {
            dstId = resolved.matches[0].id;
          }
        } catch (e) {
          log.warn(`Thread chain (O→O): resolve dest for ${srcId}: ${e.message}`);
        }
      }

      dstMsgSummaries.push({
        srcId,
        dstId,
        srcInternetMessageId: srcMid,
        srcSentDateTime: sm.sentDateTime,
      });
    }

    // 3. Sort destination summaries by sentDateTime (fetch sentDateTime for newly resolved msgs)
    //    For entries where dstId is known but sentDateTime isn't, do a lightweight fetch.
    for (const entry of dstMsgSummaries) {
      if (!entry.dstId || entry.dstSentDateTime) continue;
      try {
        const dstSummary = await outlookClient.getMessageById(
          destUser, entry.dstId,
          'id,sentDateTime,internetMessageId'
        );
        entry.dstSentDateTime = dstSummary.sentDateTime || null;
        entry.dstInternetMessageId = dstSummary.internetMessageId || '';
      } catch (e) {
        log.warn(`Thread chain (O→O): fetch dest summary ${entry.dstId}: ${e.message}`);
      }
    }

    // Sort by destination sentDateTime ASC (nulls last)
    const dstSorted = [...dstMsgSummaries]
      .filter((e) => e.dstId)
      .sort((a, b) => {
        const ta = a.dstSentDateTime ? new Date(a.dstSentDateTime).getTime() : Infinity;
        const tb = b.dstSentDateTime ? new Date(b.dstSentDateTime).getTime() : Infinity;
        return ta - tb;
      });

    const srcCount = srcMsgs.length;
    const dstCount = dstSorted.length;
    const mismatches = [];

    // 3a. Message count mismatch
    if (srcAvailable && srcCount !== dstCount) {
      const missing = srcCount - dstCount;
      mismatches.push({
        field: 'threadCount',
        ok: false,
        expected: `${srcCount} message(s) in destination (matching source conversation)`,
        actual: `${dstCount} message(s) found in destination`,
        displaySource: `Source: ${srcCount} message(s)`,
        displayDestination: `Destination: ${dstCount} message(s)${missing > 0 ? ` — ${missing} missing` : ` — ${-missing} extra`}`,
        severity: 'error',
      });
    }

    // 4. POSITIONAL PAIRING: src[i] ↔ dst[i], fetch full bodies and validate each pair
    const messageComparisons = [];
    if (srcAvailable && srcMsgs.length > 0 && dstSorted.length > 0) {
      const pairLen = Math.min(srcMsgs.length, dstSorted.length);

      // Pre-fetch full messages (with internetMessageHeaders) for inReplyTo chain check
      // We fetch as we go per-pair to keep memory bounded

      for (let i = 0; i < pairLen; i++) {
        const smSummary = srcMsgs[i];
        const dmEntry = dstSorted[i];

        let smFull = null;
        try {
          smFull = await outlookClient.getMessageById(srcUser, smSummary.id, SELECT_WITH_HEADERS);
        } catch (e) {
          log.warn(`Thread chain (O→O) pos ${i}: src getMessageById ${smSummary.id} failed: ${e.message}`);
        }

        let dmFull = null;
        try {
          dmFull = await outlookClient.getMessageById(destUser, dmEntry.dstId, SELECT_WITH_HEADERS);
        } catch (e) {
          log.warn(`Thread chain (O→O) pos ${i}: dst getMessageById ${dmEntry.dstId} failed: ${e.message}`);
        }

        if (!smFull || !dmFull) {
          messageComparisons.push({
            position: i,
            srcOutlookId: smSummary.id,
            dstOutlookId: dmEntry.dstId,
            pass: false,
            diffs: [],
            note: 'Failed to fetch full message content',
          });
          continue;
        }

        let graphAttSrc = [];
        try {
          graphAttSrc = await outlookClient.getAttachments(srcUser, smSummary.id);
        } catch (e) {
          log.warn(`Thread chain (O→O) pos ${i}: src attachments for ${smSummary.id}: ${e.message}`);
        }

        let graphAttDst = [];
        try {
          graphAttDst = await outlookClient.getAttachments(destUser, dmEntry.dstId);
        } catch (e) {
          log.warn(`Thread chain (O→O) pos ${i}: dst attachments for ${dmEntry.dstId}: ${e.message}`);
        }

        const sourceForTierA = {
          subject: smFull.subject,
          from: smFull.from,
          toEmails: graphRecipientsToEmails(smFull.toRecipients),
          ccEmails: graphRecipientsToEmails(smFull.ccRecipients),
          bccEmails: graphRecipientsToEmails(smFull.bccRecipients),
          replyTo: smFull.replyTo,
          attachments: graphAttachmentsToCompareList(graphAttSrc).map((a) => ({ filename: a.filename, size: a.size })),
        };
        const destForTierA = {
          subject: dmFull.subject,
          from: dmFull.from,
          toRecipients: dmFull.toRecipients,
          ccRecipients: dmFull.ccRecipients,
          bccRecipients: dmFull.bccRecipients,
          replyTo: dmFull.replyTo,
          attachments: graphAttachmentsToCompareList(graphAttDst),
        };

        let diffs = compareTierA(sourceForTierA, destForTierA, tierAOpts);
        diffs = diffs.concat(
          compareAttachmentSizesWithTolerance(sourceForTierA.attachments, destForTierA.attachments, 'outlook_to_outlook')
        );

        // Folder placement
        let srcFolderStr = '';
        if (smFull.parentFolderId) {
          try {
            srcFolderStr = await outlookClient.getMailFolderPathString(srcUser, smFull.parentFolderId);
          } catch (e) {
            log.warn(`Thread chain (O→O) pos ${i}: src folder path: ${e.message}`);
          }
        }
        let dstFolderStr = '';
        if (dmFull.parentFolderId) {
          try {
            dstFolderStr = await outlookClient.getMailFolderPathString(destUser, dmFull.parentFolderId);
          } catch (e) {
            log.warn(`Thread chain (O→O) pos ${i}: dst folder path: ${e.message}`);
          }
        }
        const folderOptsOO =
          boolEnv('MAIL_DEEP_FOLDER_WARNING_ONLY', false) === true ? { folderMismatchSeverity: 'warning' } : {};
        diffs = diffs.concat(compareFolderPlacement(srcFolderStr, dstFolderStr, folderOptsOO));

        // Read / flag / importance
        diffs = diffs.concat(compareReadState(smFull.isRead, dmFull.isRead));
        diffs = diffs.concat(compareFlagState(smFull.flag, dmFull.flag));
        diffs = diffs.concat(compareImportanceOutlookToOutlook(smFull.importance, dmFull.importance));

        // sentDateTime
        {
          const toleranceMs = intEnv('DEEP_VALIDATION_SENT_TIME_TOLERANCE_MINUTES', 5) * 60000;
          diffs = diffs.concat(compareSentDateTime(smFull.sentDateTime, dmFull.sentDateTime, toleranceMs));
        }

        // inReplyTo chain check (only for reply messages, i > 0)
        if (i > 0) {
          // Extract In-Reply-To header from destination message's internetMessageHeaders
          const dstHeaders = Array.isArray(dmFull.internetMessageHeaders) ? dmFull.internetMessageHeaders : [];
          const dstInReplyToHeader = dstHeaders.find(
            (h) => String(h.name || '').toLowerCase() === 'in-reply-to'
          );
          const dstInReplyTo = (dstInReplyToHeader?.value || '').trim();

          // The expected inReplyTo value is the internetMessageId of the previous destination message.
          // dstSorted[i-1].dstInternetMessageId was populated during the lightweight fetch above;
          // if not, fall back to the value captured in the previous iteration's messageComparisons entry.
          const prevDmEntry = dstSorted[i - 1];
          let prevDstInternetMessageId = prevDmEntry?.dstInternetMessageId || '';
          if (!prevDstInternetMessageId && messageComparisons[i - 1]?.dstInternetMessageId) {
            prevDstInternetMessageId = messageComparisons[i - 1].dstInternetMessageId;
          }

          if (prevDstInternetMessageId && dstInReplyTo) {
            // Normalize angle brackets for comparison
            const normalise = (id) => String(id || '').replace(/^<|>$/g, '').trim();
            const expectedInReplyTo = normalise(prevDstInternetMessageId);
            const actualInReplyTo = normalise(dstInReplyTo);
            if (expectedInReplyTo && actualInReplyTo && expectedInReplyTo !== actualInReplyTo) {
              diffs.push({
                field: 'inReplyTo',
                ok: false,
                expected: `<${expectedInReplyTo}> (internetMessageId of position ${i - 1})`,
                actual: `<${actualInReplyTo}>`,
                displaySource: `<${expectedInReplyTo}>`,
                displayDestination: `<${actualInReplyTo}>`,
                severity: 'warning',
                note: `In-Reply-To header at position ${i} does not reference the immediately preceding message in the destination thread.`,
              });
            }
          } else if (prevDstInternetMessageId && !dstInReplyTo) {
            // Reply message is missing its In-Reply-To header entirely
            diffs.push({
              field: 'inReplyTo',
              ok: false,
              expected: `<${prevDstInternetMessageId}> (internetMessageId of position ${i - 1})`,
              actual: '(missing)',
              displaySource: `<${prevDstInternetMessageId}>`,
              displayDestination: '(missing)',
              severity: 'warning',
              note: `In-Reply-To header missing on destination reply message at position ${i}. Thread chain linkage may be broken.`,
            });
          }
        }

        // Tier C body: strip quoted lines for replies (i > 0) to avoid false positives
        if (tierC) {
          const srcBodyRaw = smFull.body?.content || smFull.bodyPreview || '';
          const dstBodyRaw = dmFull.body?.content || dmFull.bodyPreview || '';
          const srcBodyNorm = normalizeMailBodyPlain(htmlToPlainLoose(srcBodyRaw) || srcBodyRaw);
          const dstBodyNorm = normalizeMailBodyPlain(htmlToPlainLoose(dstBodyRaw) || dstBodyRaw);
          const isReply = i > 0;
          const srcBodyCmp = isReply ? stripQuotedLines(srcBodyNorm) : srcBodyNorm;
          const dstBodyCmp = isReply ? stripQuotedLines(dstBodyNorm) : dstBodyNorm;
          const bodyMax = intEnv('MAIL_DEEP_BODY_MAX_CHARS', 500000);
          diffs = diffs.concat(compareTierC(srcBodyCmp, dstBodyCmp, {
            bodyMismatchSeverity: 'error', maxChars: bodyMax,
            hasAttachments: graphAttSrc.length > 0,
            destHasAttachments: graphAttDst.length > 0,
          }));
        }

        // Zoom / OneDrive link checks
        {
          const srcBodyRaw = smFull.body?.content || smFull.bodyPreview || '';
          const dstBodyRaw = dmFull.body?.content || dmFull.bodyPreview || '';
          diffs = diffs.concat(compareZoomLinks(srcBodyRaw, dstBodyRaw));
          diffs = diffs.concat(compareOneDriveLinks(srcBodyRaw, dstBodyRaw));
        }

        // Tier B attachment hash
        if (tierB && graphAttSrc.length > 0) {
          try {
            const { srcHashes, dstHashes } = await tierBHashesOutlookToOutlook(
              srcUser, smSummary.id, graphAttSrc,
              destUser, dmEntry.dstId, graphAttDst,
              log
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
            log.warn(`Thread chain (O→O) pos ${i}: Tier B hash: ${e.message}`);
          }
        }

        const hasError = diffs.some((d) => d.severity === 'error');
        messageComparisons.push({
          position: i,
          srcOutlookId: smSummary.id,
          dstOutlookId: dmEntry.dstId,
          srcInternetMessageId: smFull.internetMessageId || smSummary.internetMessageId || '',
          dstInternetMessageId: dmFull.internetMessageId || dmEntry.dstInternetMessageId || '',
          subject: smFull.subject || '',
          pass: !hasError,
          diffs,
        });

        // UPDATE existing entry (root/scanned message) with re-computed diffs,
        // or ADD a new entry for reply messages the main scan never visited (RE: subjects)
        const existingEntry = pairedEntries.find((e) => e.sourceMessageId === smSummary.id);
        if (existingEntry) {
          const oldDestId = existingEntry.destMessageId;
          existingEntry.destMessageId = dmEntry.dstId;
          existingEntry.diffs = diffs;
          existingEntry.pass = !hasError;
          if (oldDestId && oldDestId !== dmEntry.dstId) {
            log.info(
              `Thread chain (O→O): corrected pairing pos ${i} "${smFull.subject}": ` +
              `dest ${oldDestId} → ${dmEntry.dstId}`
            );
          }
        } else {
          result.addDeepMailMessageResult({
            sourceMessageId: smSummary.id,
            internetMessageId: smFull.internetMessageId || smSummary.internetMessageId || '',
            destMessageId: dmEntry.dstId,
            subject: smFull.subject || smSummary.subject || '',
            pass: !hasError,
            diffs,
            _conversationId: convId,
            _threadPosition: i,
          });
        }
      }
    }

    const rootSubject = srcMsgs[0]?.subject || pairedEntries[0]?.subject || '(unknown)';
    const structuralErrors = mismatches.filter((m) => m.severity === 'error').length;
    const pairErrors = messageComparisons.filter((mc) => !mc.pass).length;
    const pass = structuralErrors === 0 && pairErrors === 0;

    result.deepMailValidation.threadChainResults.push({
      conversationId: convId,
      rootSubject,
      srcMessageCount: srcCount,
      dstMessageCount: dstCount,
      // Use the same field names as O→G results so PDF/UI rendering is compatible
      outlookMessageCount: srcCount,
      gmailMessageCount: dstCount,
      countMatch: srcCount === dstCount,
      threadSplit: false,
      pass,
      mismatches,
      messageComparisons,
      srcSubjects: srcMsgs.map((m) => m.subject),
      dstSubjects: dstSorted.map((e) => {
        const mc = messageComparisons.find((c) => c.dstOutlookId === e.dstId);
        return mc?.subject || '';
      }),
    });

    if (!pass) {
      log.warn(
        `Thread chain (O→O) FAIL: "${rootSubject}" — src=${srcCount} dst=${dstCount} ` +
        `structuralErrors=${structuralErrors} pairErrors=${pairErrors}`
      );
    }
  }

  const failed = result.deepMailValidation.threadChainResults.filter((t) => !t.pass).length;
  const total = result.deepMailValidation.threadChainResults.length;
  if (total > 0) {
    log.info(`Thread chain validation (O→O) complete: ${total} conversation(s) checked, ${failed} failed`);
  }
}


/**
 * Tier B attachment hash helper for Gmail→Gmail.
 * Downloads attachment binary from BOTH source and destination Gmail and computes SHA-256.
 */
async function tierBHashesGmailToGmail(srcUser, srcFull, destUser, destFull, log) {
  const hashMax = intEnv('MAIL_DEEP_HASH_MAX_BYTES', 10485760);
  const srcHashes = [];
  const dstHashes = [];

  for (const att of srcFull.attachments || []) {
    if (!att.filename || !att.attachmentId) continue;
    let buf;
    try {
      buf = await gmailClient.getAttachmentData(srcUser, srcFull.id, att.attachmentId);
    } catch (e) {
      log.warn(`Tier B (G→G): source attachment read failed ${att.filename}: ${e.message}`);
      continue;
    }
    if (buf.length > hashMax) continue;
    srcHashes.push({ name: att.filename, sha256: sha256Hex(buf) });
  }

  for (const att of destFull.attachments || []) {
    if (!att.filename || !att.attachmentId) continue;
    let buf;
    try {
      buf = await gmailClient.getAttachmentData(destUser, destFull.id, att.attachmentId);
    } catch (e) {
      log.warn(`Tier B (G→G): dest attachment read failed ${att.filename}: ${e.message}`);
      continue;
    }
    if (buf.length > hashMax) continue;
    dstHashes.push({ name: att.filename, sha256: sha256Hex(buf) });
  }

  return { srcHashes, dstHashes };
}

// ── Shared exports (auto-generated by scripts/_split-deep-validator.js) ──
module.exports = {
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
};
